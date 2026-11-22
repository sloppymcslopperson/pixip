import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { parseHostArgs } from "../src/args.ts";
import { PiHost, toJsonEvent, type HostRuntime, type UiResponse } from "../src/protocol.ts";

type Record = { [key: string]: any };

class FakeSession {
	model = { provider: "test", id: "test-model" };
	thinkingLevel = "medium";
	isStreaming = false;
	isCompacting = false;
	steeringMode: "all" | "one-at-a-time" = "all";
	followUpMode: "all" | "one-at-a-time" = "all";
	sessionFile: string | undefined = "/tmp/session.jsonl";
	sessionId = "session-1";
	sessionName: string | undefined = "test";
	autoCompactionEnabled = true;
	messages: unknown[] = [{ id: "m1" }];
	pendingMessageCount = 0;
	promptTemplates: any[] = [];
	isIdle = true;
	disposed = false;
	bindings: Record | undefined;
	listener: ((event: any) => void) | undefined;
	promptCalls: any[] = [];
	bashCalls: string[] = [];

	modelRuntime = {
		getAvailableSnapshot: () => [this.model],
	};
	sessionManager = {
		getCwd: () => "/tmp",
		getEntries: () => [{ id: "e1" }, { id: "e2" }, { id: "e3" }],
		getLeafId: () => "e3",
		getTree: () => [{ id: "e1" }],
	};
	extensionRunner = {
		emitUserBash: async () => undefined,
		getRegisteredCommands: () => [],
	};
	resourceLoader = {
		getSkills: () => ({ skills: [] }),
	};

	async bindExtensions(bindings: Record): Promise<void> {
		this.bindings = bindings;
	}

	subscribe(listener: (event: any) => void): () => void {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	}

	async prompt(message: string, options: Record): Promise<void> {
		this.promptCalls.push({ message, options });
		options.preflightResult?.("started");
	}

	async steer(message: string): Promise<string> {
		return `steered:${message}`;
	}

	async followUp(message: string): Promise<string> {
		return `followed:${message}`;
	}

	async abort(): Promise<void> {}

	clearQueue(): { steering: string[]; followUp: string[] } {
		return { steering: [], followUp: [] };
	}

	async setModel(model: unknown): Promise<void> {
		this.model = model as typeof this.model;
	}

	async cycleModel(): Promise<undefined> {
		return undefined;
	}

	setThinkingLevel(level: string): void {
		this.thinkingLevel = level;
	}

	cycleThinkingLevel(): string {
		return "high";
	}

	getAvailableThinkingLevels(): string[] {
		return ["low", "medium", "high"];
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.steeringMode = mode;
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.followUpMode = mode;
	}

	async compact(): Promise<Record> {
		return { tokensBefore: 10, tokensAfter: 5 };
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this.autoCompactionEnabled = enabled;
	}

	setAutoRetryEnabled(): void {}

	abortRetry(): void {}

	async executeBash(command: string): Promise<Record> {
		this.bashCalls.push(command);
		return { output: "ok", exitCode: 0 };
	}

	recordBashResult(): void {}

	abortBash(): void {}

	getSessionStats(): Record {
		return { sessionId: this.sessionId };
	}

	async exportToHtml(): Promise<string> {
		return "/tmp/export.html";
	}

	getUserMessagesForForking(): any[] {
		return [];
	}

	getLastAssistantText(): string | null {
		return "hello";
	}

	setSessionName(name: string): void {
		this.sessionName = name;
	}

	async navigateTree(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}

	async waitForIdle(): Promise<void> {}

	async reload(): Promise<void> {}

	dispose(): void {
		this.disposed = true;
	}
}

class FakeRuntime {
	session = new FakeSession();
	rebind: (() => Promise<void>) | undefined;
	disposed = false;
	disposedCount = 0;
	forkCalls: any[] = [];
	switchCalls: string[] = [];

	setRebindSession(rebind: () => Promise<void>): void {
		this.rebind = rebind;
	}

	async newSession(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}

	async switchSession(path: string): Promise<{ cancelled: boolean }> {
		this.switchCalls.push(path);
		return { cancelled: false };
	}

	async fork(entryId: string, options?: any): Promise<Record> {
		this.forkCalls.push({ entryId, options });
		return { cancelled: false, selectedText: "fork me" };
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.disposedCount++;
	}
}

function makeHost() {
	const output: Record[] = [];
	const exits: number[] = [];
	const runtime = new FakeRuntime();
	const host = new PiHost({
		runtime: runtime as unknown as HostRuntime,
		output: (record) => output.push(record as Record),
		piVersion: "1.5.2-test",
		exit: (code) => exits.push(code),
	});
	return { host, output, exits, runtime };
}

function lastResponse(output: Record[]): Record {
	const response = [...output].reverse().find((record) => record.type === "response");
	assert.ok(response, "expected a response record");
	return response;
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

test("start emits hello first and binds RPC extensions", async () => {
	const { host, output, runtime } = makeHost();
	await host.start();
	assert.deepEqual(output[0], {
		type: "hello",
		protocol: 1,
		piVersion: "1.5.2-test",
		capabilities: ["panel"],
	});
	assert.equal(runtime.session.bindings?.mode, "rpc");
	assert.equal(typeof runtime.session.listener, "function");
});

test("malformed JSON becomes a parse error response", async () => {
	const { host, output } = makeHost();
	await host.start();
	await host.handleLine("{nope");
	const response = lastResponse(output);
	assert.equal(response.command, "parse");
	assert.equal(response.success, false);
	assert.match(response.error, /Failed to parse command/);
});

test("unknown commands fail without writing logs to stdout", async () => {
	const { host, output } = makeHost();
	await host.start();
	await host.handleLine(JSON.stringify({ type: "wat", id: "1" }));
	const response = lastResponse(output);
	assert.deepEqual(response, {
		id: "1",
		type: "response",
		command: "wat",
		success: false,
		error: "Unknown command: wat",
	});
});

test("get_state and get_entries keep Pi's response shapes", async () => {
	const { host, output } = makeHost();
	await host.start();
	await host.handleLine(JSON.stringify({ type: "get_state", id: "s1" }));
	const state = lastResponse(output);
	assert.equal(state.command, "get_state");
	assert.equal(state.data.sessionId, "session-1");
	assert.equal(state.data.thinkingLevel, "medium");

	await host.handleLine(JSON.stringify({ type: "get_entries", id: "e1", since: "e1" }));
	const entries = lastResponse(output);
	assert.deepEqual(entries.data, { entries: [{ id: "e2" }, { id: "e3" }], leafId: "e3" });
});

test("prompt answers through preflight without waiting for the turn", async () => {
	const { host, output, runtime } = makeHost();
	await host.start();
	await host.handleLine(JSON.stringify({ type: "prompt", id: "p1", message: "hi" }));
	const response = lastResponse(output);
	assert.deepEqual(response, {
		id: "p1",
		type: "response",
		command: "prompt",
		success: true,
		data: { disposition: "started" },
	});
	assert.equal(runtime.session.promptCalls[0].message, "hi");
});

test("bash, clone and fork route through the session and runtime", async () => {
	const { host, output, runtime } = makeHost();
	await host.start();

	await host.handleLine(JSON.stringify({ type: "bash", id: "b1", command: "echo ok" }));
	assert.equal(lastResponse(output).data.output, "ok");
	assert.deepEqual(runtime.session.bashCalls, ["echo ok"]);

	await host.handleLine(JSON.stringify({ type: "clone", id: "c1" }));
	assert.deepEqual(lastResponse(output).data, { cancelled: false });
	assert.deepEqual(runtime.forkCalls[0], { entryId: "e3", options: { position: "at" } });

	await host.handleLine(JSON.stringify({ type: "fork", id: "f1", entryId: "e2" }));
	assert.deepEqual(lastResponse(output).data, { text: "fork me", cancelled: false });
});

test("select resolves from extension_ui_response", async () => {
	const { host, output, runtime } = makeHost();
	await host.start();
	const ui = runtime.session.bindings?.uiContext;
	assert.ok(ui);
	const pending = ui.select("Pick", ["a", "b"]);
	await tick();
	const request = output.find((record) => record.type === "extension_ui_request");
	assert.ok(request);
	assert.equal(request.method, "select");
	assert.deepEqual(request.options, ["a", "b"]);

	const response: UiResponse = {
		type: "extension_ui_response",
		id: request.id,
		value: "b",
	};
	await host.handleLine(JSON.stringify(response));
	assert.equal(await pending, "b");
});

test("panel forwards an opaque payload and raw value", async () => {
	const { host, output, runtime } = makeHost();
	await host.start();
	const ui = runtime.session.bindings?.uiContext;
	assert.ok(ui);
	const payload = {
		messages: [{ version: "v1.0", createSurface: { surfaceId: "main" } }],
		surfaceId: "main",
		title: "Form",
		mode: "sheet",
	};
	const pending = ui.panel(payload, { timeout: 1000 });
	await tick();
	const request = output.find((record) => record.method === "panel");
	assert.ok(request);
	assert.deepEqual(request.payload, payload);
	assert.equal(request.timeout, 1000);

	const value = { name: "submit", context: { answer: 42 } };
	await host.handleLine(JSON.stringify({ type: "extension_ui_response", id: request.id, value }));
	assert.deepEqual(await pending, value);
});

test("cancelled panel resolves undefined and unknown ids are ignored", async () => {
	const { host, output, runtime } = makeHost();
	await host.start();
	const ui = runtime.session.bindings?.uiContext;
	assert.ok(ui);

	const pending = ui.panel({ messages: [] });
	await tick();
	const request = output.find((record) => record.method === "panel");
	assert.ok(request);
	await host.handleLine(
		JSON.stringify({ type: "extension_ui_response", id: "missing", value: 1 }),
	);
	await host.handleLine(
		JSON.stringify({ type: "extension_ui_response", id: request.id, cancelled: true }),
	);
	assert.equal(await pending, undefined);
});

test("panel aborts and times out to undefined", async () => {
	const { host, runtime } = makeHost();
	await host.start();
	const ui = runtime.session.bindings?.uiContext;
	assert.ok(ui);

	const controller = new AbortController();
	const aborted = ui.panel({}, { signal: controller.signal });
	controller.abort();
	assert.equal(await aborted, undefined);

	const timedOut = ui.panel({}, { timeout: 5 });
	assert.equal(await timedOut, undefined);
});

test("shutdown responds, disposes once and exits", async () => {
	const { host, output, runtime, exits } = makeHost();
	await host.start();
	await host.handleLine(JSON.stringify({ type: "shutdown", id: "bye" }));
	assert.deepEqual(lastResponse(output), {
		id: "bye",
		type: "response",
		command: "shutdown",
		success: true,
	});
	await tick();
	assert.deepEqual(exits, [0]);
	assert.equal(runtime.disposed, true);
	await host.shutdown(0);
	assert.equal(runtime.disposedCount, 1);
});

test("session events go through Pi's toJsonEvent transform", async () => {
	const { host, output, runtime } = makeHost();
	await host.start();
	runtime.session.listener?.({
		type: "message_update",
		message: { role: "assistant", usage: { input: 1 } },
		assistantMessageEvent: { type: "text_delta", delta: "x", partial: { big: true } },
	});
	const event = output.at(-1);
	assert.deepEqual(event, {
		type: "message_update",
		usage: { input: 1 },
		assistantMessageEvent: { type: "text_delta", delta: "x" },
	});
});

test("toJsonEvent adds tool identity and leaves other events alone", () => {
	const toolStart = toJsonEvent({
		type: "message_update",
		message: { role: "assistant", usage: {} },
		assistantMessageEvent: {
			type: "toolcall_start",
			contentIndex: 0,
			partial: { content: [{ type: "toolCall", id: "call-1", name: "bash" }] },
		},
	});
	assert.deepEqual(toolStart.assistantMessageEvent, {
		type: "toolcall_start",
		contentIndex: 0,
		id: "call-1",
		toolName: "bash",
	});

	const plain = { type: "agent_start" };
	assert.equal(toJsonEvent(plain), plain);
	assert.throws(() => toJsonEvent({ type: "message_update", message: { role: "user" } }));
});

test("parseHostArgs accepts spawn args and resolves paths", () => {
	const parsed = parseHostArgs(
		["--mode", "rpc", "--session-dir", "tmp/s", "--session", "tmp/s/a.jsonl", "--name", "n"],
		"/work",
	);
	assert.deepEqual(parsed, {
		mode: "rpc",
		sessionDir: "/work/tmp/s",
		session: "/work/tmp/s/a.jsonl",
		name: "n",
	});
	assert.deepEqual(parseHostArgs([]), { mode: "rpc" });
	assert.throws(() => parseHostArgs(["--mode", "print"]), /Unsupported --mode/);
	assert.throws(() => parseHostArgs(["--name", " "]), /non-empty/);
	assert.throws(() => parseHostArgs(["--wat"]), /Unknown argument/);
});

test("fake session satisfies the real AgentSession type at the boundary", () => {
	const session = new FakeSession() as unknown as AgentSession;
	assert.equal(session.sessionId, "session-1");
});
