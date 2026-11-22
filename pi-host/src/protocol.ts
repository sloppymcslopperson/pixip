import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import type {
	AgentSession,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	RpcCommand,
	Theme,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi RPC v1 protocol loop for `pixip-pi-host`.
 *
 * Framing is strict JSONL: one JSON object per LF, one optional trailing CR
 * stripped. The loop never writes logs to stdout; anything that is not a
 * protocol record belongs on stderr.
 *
 * The host owns a small protocol delta over stock Pi RPC:
 * - a `hello` record at startup
 * - a blocking `panel` extension UI method with an opaque JSON payload
 *
 * `toJsonEvent` mirrors Pi's RPC event transform: cumulative `partial`
 * snapshots are stripped from `message_update`, and `toolcall_start` gains
 * `id`/`toolName` so a client can correlate the tool call without the snapshot.
 */

export const RPC_PROTOCOL_VERSION = 1;

export interface HelloRecord {
	type: "hello";
	protocol: number;
	piVersion: string;
	capabilities: string[];
}

export interface UiResponse {
	type: "extension_ui_response";
	id: string;
	value?: unknown;
	confirmed?: boolean;
	cancelled?: boolean;
}

export type PanelUIDialogOptions = ExtensionUIDialogOptions;

export interface PanelUIContext extends ExtensionUIContext {
	/** Blocking opaque panel request. Resolves with the raw `value` or `undefined`. */
	panel(payload: unknown, opts?: PanelUIDialogOptions): Promise<unknown>;
}

/** One JSON record per LF. Values may contain U+2028/U+2029; split on LF only. */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Attach a strict JSONL reader to a stream. Returns a detach function.
 *
 * This intentionally does not use `node:readline`: readline splits on Unicode
 * separator characters that are legal inside JSON strings.
 */
export function attachJsonlLineReader(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	const emit = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	const onData = (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			emit(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
		}
	};
	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emit(buffer);
			buffer = "";
		}
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

function toJsonAssistantMessageEvent(event: any): any {
	if (event.type === "toolcall_start") {
		const toolCall = event.partial.content[event.contentIndex];
		if (toolCall?.type !== "toolCall") {
			throw new Error(
				`toolcall_start content at index ${event.contentIndex} is not a tool call`,
			);
		}
		const { partial: _partial, ...deltaEvent } = event;
		void _partial;
		return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
	}
	if (!("partial" in event)) return event;
	const { partial: _partial, ...deltaEvent } = event;
	void _partial;
	return deltaEvent;
}

/** Pi's RPC event transform, copied because the SDK does not export it. */
export function toJsonEvent(event: any): any {
	if (event.type !== "message_update") return event;
	if (event.message.role !== "assistant") {
		throw new Error("message_update message is not an assistant message");
	}
	return {
		type: "message_update",
		usage: event.message.usage,
		assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
	};
}

/**
 * The subset of `AgentSessionRuntime` the protocol loop needs. The real SDK
 * runtime satisfies this; tests pass a plain fake.
 */
export interface HostRuntime {
	readonly session: AgentSession;
	setRebindSession?(rebind: () => Promise<void>): void;
	newSession(options?: { parentSession?: string }): Promise<{ cancelled: boolean }>;
	switchSession(
		sessionPath: string,
		options?: Record<string, unknown>,
	): Promise<{ cancelled: boolean }>;
	fork(
		entryId: string,
		options?: { position?: "before" | "at" },
	): Promise<{ cancelled: boolean; selectedText?: string }>;
	dispose(): Promise<void>;
}

export interface HostOptions {
	runtime: HostRuntime;
	/** Receives every protocol record. Must write to stdout, never to a log. */
	output: (record: unknown) => void;
	piVersion: string;
	/** Called when the loop wants the process to exit. Defaults to `process.exit`. */
	exit?: (code: number) => void;
}

type HostCommand = RpcCommand | { id?: string; type: "shutdown" };

interface PendingRequest {
	resolve: (response: UiResponse) => void;
	reject: (error: unknown) => void;
}

function noopTheme(): Theme {
	const identity = (text: string) => text;
	return {
		name: "pixip-rpc",
		appearance: "dark",
		colors: {},
		style: identity,
		fg: (_color: unknown, text: string) => text,
		bg: (_color: unknown, text: string) => text,
		bold: identity,
		italic: identity,
		underline: identity,
		inverse: identity,
		strikethrough: identity,
	} as unknown as Theme;
}

export class PiHost {
	private readonly runtime: HostRuntime;
	private readonly output: (record: unknown) => void;
	private readonly exit: (code: number) => void;
	private readonly piVersion: string;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly ui: PanelUIContext;
	private session: AgentSession;
	private unsubscribe?: () => void;
	private inputReady = false;
	private activeCommands = 0;
	private shutdownRequested = false;
	private shuttingDown = false;

	constructor(options: HostOptions) {
		this.runtime = options.runtime;
		this.output = options.output;
		this.piVersion = options.piVersion;
		this.exit = options.exit ?? ((code) => process.exit(code));
		this.session = options.runtime.session;
		this.ui = this.createUiContext();
	}

	hello(): HelloRecord {
		return {
			type: "hello",
			protocol: RPC_PROTOCOL_VERSION,
			piVersion: this.piVersion,
			capabilities: ["panel"],
		};
	}

	/** Emit `hello` and bind the first session. Call once, before reading stdin. */
	async start(): Promise<void> {
		this.output(this.hello());
		this.runtime.setRebindSession?.(async () => this.rebind());
		await this.rebind();
		this.inputReady = true;
		this.checkShutdownRequested();
	}

	/** Feed one raw JSONL line. Malformed JSON becomes a protocol error response. */
	async handleLine(line: string): Promise<void> {
		let parsed: any;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			this.output({
				type: "response",
				command: "parse",
				success: false,
				error: `Failed to parse command: ${error instanceof Error ? error.message : String(error)}`,
			});
			return;
		}

		if (parsed && typeof parsed === "object" && parsed.type === "extension_ui_response") {
			const response = parsed as UiResponse;
			const pending = this.pending.get(response.id);
			if (pending) {
				this.pending.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as HostCommand;
		this.activeCommands++;
		try {
			const response = await this.handleCommand(command);
			if (response) this.output(response);
		} catch (error) {
			this.output({
				type: "response",
				command: command?.type,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.activeCommands--;
		}
		this.checkShutdownRequested();
	}

	async shutdown(exitCode = 0): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.resolve({ type: "extension_ui_response", id, cancelled: true });
		}
		try {
			await this.runtime.dispose();
		} finally {
			this.exit(exitCode);
		}
	}

	private async rebind(): Promise<void> {
		this.session = this.runtime.session;
		await this.session.bindExtensions({
			uiContext: this.ui,
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: (options) => this.runtime.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await this.runtime.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: (sessionPath, options) =>
					this.runtime.switchSession(sessionPath, options),
				reload: () => this.session.reload(),
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				setImmediate(() => this.checkShutdownRequested());
			},
			onError: (error) => {
				this.output({
					type: "extension_error",
					extensionPath: error.extensionPath,
					event: error.event,
					error: error.error,
				});
			},
		});
		this.unsubscribe?.();
		this.unsubscribe = this.session.subscribe((event) => {
			this.output(toJsonEvent(event));
			if (event.type === "agent_settled") this.checkShutdownRequested();
		});
	}

	private createUiContext(): PanelUIContext {
		const theme = noopTheme();
		return {
			select: (title, options, opts) =>
				this.dialog(
					opts,
					undefined,
					{ method: "select", title, options, timeout: opts?.timeout },
					(r) => (r.cancelled ? undefined : (r.value as string | undefined)),
				),
			confirm: (title, message, opts) =>
				this.dialog(
					opts,
					false,
					{ method: "confirm", title, message, timeout: opts?.timeout },
					(r) => (r.cancelled ? false : Boolean(r.confirmed)),
				),
			input: (title, placeholder, opts) =>
				this.dialog(
					opts,
					undefined,
					{ method: "input", title, placeholder, timeout: opts?.timeout },
					(r) => (r.cancelled ? undefined : (r.value as string | undefined)),
				),
			editor: (title, prefill) =>
				this.dialog(undefined, undefined, { method: "editor", title, prefill }, (r) =>
					r.cancelled ? undefined : (r.value as string | undefined),
				),
			panel: (payload, opts) =>
				this.dialog(
					opts,
					undefined,
					{ method: "panel", payload, timeout: opts?.timeout },
					(r) => (r.cancelled ? undefined : r.value),
				),
			notify: (message, type) => {
				this.output({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "notify",
					message,
					notifyType: type,
				});
			},
			onTerminalInput: () => () => {},
			setStatus: (key, text) => {
				this.output({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "setStatus",
					statusKey: key,
					statusText: text,
				});
			},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: (key, content, options) => {
				if (content === undefined || Array.isArray(content)) {
					this.output({
						type: "extension_ui_request",
						id: randomUUID(),
						method: "setWidget",
						widgetKey: key,
						widgetLines: content,
						widgetPlacement: options?.placement,
					});
				}
			},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: (title) => {
				this.output({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "setTitle",
					title,
				});
			},
			custom: () => Promise.resolve(undefined as any),
			pasteToEditor: (text) => {
				this.output({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "set_editor_text",
					text,
				});
			},
			setEditorText: (text) => {
				this.output({
					type: "extension_ui_request",
					id: randomUUID(),
					method: "set_editor_text",
					text,
				});
			},
			getEditorText: () => "",
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			theme,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({
				success: false,
				error: "Theme switching is not supported in RPC mode",
			}),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	/** One blocking request with Pi's abort/timeout semantics. */
	private dialog<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parse: (response: UiResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
		const id = randomUUID();
		return new Promise<T>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
			};
			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout) {
				timer = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}
			this.pending.set(id, {
				resolve: (response) => {
					cleanup();
					resolve(parse(response));
				},
				reject,
			});
			this.output({ type: "extension_ui_request", id, ...request });
		});
	}

	private success(id: string | undefined, command: string, data?: unknown): any {
		return data === undefined
			? { id, type: "response", command, success: true }
			: { id, type: "response", command, success: true, data };
	}

	private failure(id: string | undefined, command: string, error: string): any {
		return { id, type: "response", command, success: false, error };
	}

	private async handleCommand(command: HostCommand): Promise<any> {
		const id = command.id;
		switch (command.type) {
			case "prompt": {
				let preflightSucceeded = false;
				this.activeCommands++;
				void this.session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (disposition) => {
							preflightSucceeded = true;
							this.output(this.success(id, "prompt", { disposition }));
						},
					})
					.catch((error: unknown) => {
						if (!preflightSucceeded) {
							this.output(
								this.failure(
									id,
									"prompt",
									error instanceof Error ? error.message : String(error),
								),
							);
						}
					})
					.finally(() => {
						this.activeCommands--;
						this.checkShutdownRequested();
					});
				return undefined;
			}
			case "steer": {
				const disposition = await this.session.steer(command.message, command.images, {
					source: "rpc",
				});
				return this.success(id, "steer", { disposition });
			}
			case "follow_up": {
				const disposition = await this.session.followUp(command.message, command.images, {
					source: "rpc",
				});
				return this.success(id, "follow_up", { disposition });
			}
			case "abort": {
				await this.session.abort();
				return this.success(id, "abort");
			}
			case "clear_queue":
				return this.success(id, "clear_queue", this.session.clearQueue());
			case "new_session": {
				const options = command.parentSession
					? { parentSession: command.parentSession }
					: undefined;
				const result = await this.runtime.newSession(options);
				return this.success(id, "new_session", result);
			}
			case "get_state":
				return this.success(id, "get_state", {
					model: this.session.model,
					thinkingLevel: this.session.thinkingLevel,
					isStreaming: this.session.isStreaming,
					isCompacting: this.session.isCompacting,
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					sessionFile: this.session.sessionFile,
					sessionId: this.session.sessionId,
					sessionName: this.session.sessionName,
					autoCompactionEnabled: this.session.autoCompactionEnabled,
					messageCount: this.session.messages.length,
					pendingMessageCount: this.session.pendingMessageCount,
				});
			case "set_model": {
				const models = this.session.modelRuntime.getAvailableSnapshot();
				const model = models.find(
					(candidate: any) =>
						candidate.provider === command.provider && candidate.id === command.modelId,
				);
				if (!model) {
					return this.failure(
						id,
						"set_model",
						`Model not found: ${command.provider}/${command.modelId}`,
					);
				}
				await this.session.setModel(model);
				return this.success(id, "set_model", model);
			}
			case "cycle_model":
				return this.success(id, "cycle_model", (await this.session.cycleModel()) ?? null);
			case "get_available_models":
				return this.success(id, "get_available_models", {
					models: this.session.modelRuntime.getAvailableSnapshot(),
				});
			case "set_thinking_level":
				this.session.setThinkingLevel(command.level);
				return this.success(id, "set_thinking_level");
			case "cycle_thinking_level": {
				const level = this.session.cycleThinkingLevel();
				return this.success(id, "cycle_thinking_level", level ? { level } : null);
			}
			case "get_available_thinking_levels":
				return this.success(id, "get_available_thinking_levels", {
					levels: this.session.getAvailableThinkingLevels(),
				});
			case "set_steering_mode":
				this.session.setSteeringMode(command.mode);
				return this.success(id, "set_steering_mode");
			case "set_follow_up_mode":
				this.session.setFollowUpMode(command.mode);
				return this.success(id, "set_follow_up_mode");
			case "compact":
				return this.success(
					id,
					"compact",
					await this.session.compact(command.customInstructions),
				);
			case "set_auto_compaction":
				this.session.setAutoCompactionEnabled(command.enabled);
				return this.success(id, "set_auto_compaction");
			case "set_auto_retry":
				this.session.setAutoRetryEnabled(command.enabled);
				return this.success(id, "set_auto_retry");
			case "abort_retry":
				this.session.abortRetry();
				return this.success(id, "abort_retry");
			case "bash": {
				const eventResult = await this.session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext ?? false,
					cwd: this.session.sessionManager.getCwd(),
				});
				if (eventResult?.result) {
					this.session.recordBashResult(command.command, eventResult.result, {
						excludeFromContext: command.excludeFromContext,
					});
					return this.success(id, "bash", eventResult.result);
				}
				const result = await this.session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
					operations: eventResult?.operations,
				});
				return this.success(id, "bash", result);
			}
			case "abort_bash":
				this.session.abortBash();
				return this.success(id, "abort_bash");
			case "get_session_stats":
				return this.success(id, "get_session_stats", this.session.getSessionStats());
			case "export_html": {
				const path = await this.session.exportToHtml(command.outputPath);
				return this.success(id, "export_html", { path });
			}
			case "switch_session": {
				const result = await this.runtime.switchSession(command.sessionPath);
				return this.success(id, "switch_session", result);
			}
			case "fork": {
				const result = await this.runtime.fork(command.entryId);
				return this.success(id, "fork", {
					text: result.selectedText,
					cancelled: result.cancelled,
				});
			}
			case "clone": {
				const leafId = this.session.sessionManager.getLeafId();
				if (!leafId) {
					return this.failure(
						id,
						"clone",
						"Cannot clone session: no current entry selected",
					);
				}
				const result = await this.runtime.fork(leafId, { position: "at" });
				return this.success(id, "clone", { cancelled: result.cancelled });
			}
			case "get_fork_messages":
				return this.success(id, "get_fork_messages", {
					messages: this.session.getUserMessagesForForking(),
				});
			case "get_entries": {
				const sessionManager = this.session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex(
						(entry: any) => entry.id === command.since,
					);
					if (sinceIndex === -1) {
						return this.failure(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return this.success(id, "get_entries", {
					entries,
					leafId: sessionManager.getLeafId(),
				});
			}
			case "get_tree":
				return this.success(id, "get_tree", {
					tree: this.session.sessionManager.getTree(),
					leafId: this.session.sessionManager.getLeafId(),
				});
			case "get_last_assistant_text":
				return this.success(id, "get_last_assistant_text", {
					text: this.session.getLastAssistantText(),
				});
			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return this.failure(id, "set_session_name", "Session name cannot be empty");
				}
				this.session.setSessionName(name);
				return this.success(id, "set_session_name");
			}
			case "get_messages":
				return this.success(id, "get_messages", { messages: this.session.messages });
			case "get_commands": {
				const commands: any[] = [];
				for (const registered of this.session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: registered.invocationName,
						description: registered.description,
						source: "extension",
						sourceInfo: registered.sourceInfo,
					});
				}
				for (const template of this.session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}
				for (const skill of this.session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}
				return this.success(id, "get_commands", { commands });
			}
			case "shutdown": {
				setImmediate(() => {
					void this.shutdown(0);
				});
				return this.success(id, "shutdown");
			}
			default: {
				const unknown = command as { type: string };
				return this.failure(id, unknown.type, `Unknown command: ${unknown.type}`);
			}
		}
	}

	private checkShutdownRequested(): void {
		if (!this.shutdownRequested || this.shuttingDown) return;
		if (!this.inputReady || this.activeCommands > 0) return;
		if (!this.session.isIdle) return;
		void this.shutdown(0);
	}
}
