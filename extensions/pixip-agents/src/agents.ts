/**
 * Thin client for the pixip agent endpoints. The extension never guesses the
 * daemon address: discovery reads `GET /api/agents` and `agent_send` posts one
 * message exactly like a human prompt.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const AGENT_LIST_TOOL = "agent_list";
export const AGENT_SEND_TOOL = "agent_send";
export const AGENT_STATES = ["starting", "idle", "busy", "stopped", "error"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export interface AgentInfo {
	id: string;
	logicalId: string;
	name: string;
	state: AgentState;
	cwd: string;
	repo?: string;
	branch?: string;
	worktree?: { repo: string; path: string; branch: string; pixipActive: boolean };
	awaitingUser: boolean;
	lastActivity: number;
	isSelf: boolean;
	url: string;
	stored?: "archive" | "trash";
	lastDelivery?: {
		deliveryId: string;
		senderId: string;
		at: string;
		delivered: boolean;
		woken: boolean;
		streaming: boolean;
		stateBefore: AgentState;
		stateAfter: AgentState;
	};
	archivedAt?: string;
	deletedAt?: string;
	expiresAt?: number;
}

export interface AgentListInput {
	all?: boolean;
	cwd?: string;
	repo?: string;
	state?: string;
	query?: string;
}

export interface AgentListResult {
	agents: AgentInfo[];
	count: number;
}

export interface AgentSendInput {
	target: string;
	message: string;
	/** Defaults to PIXIP_SESSION_ID, then local-shell. */
	sender?: string;
}

export interface AgentSendAck {
	deliveryId: string;
	target: {
		id: string;
		name: string;
		url: string;
		stateBefore: AgentState;
		stateAfter: AgentState;
	};
	delivered: boolean;
	woken: boolean;
	streaming: boolean;
	at: string;
}

export interface AgentDeps {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	timeoutMs?: number;
	/** Base for resolving relative cwd/repo filters; defaults to process.cwd(). */
	cwd?: string;
}

export class AgentListError extends Error {}
export class AgentSendError extends Error {}

function daemonBase(env: NodeJS.ProcessEnv): string {
	const base = env["PIXIP_DAEMON_URL"]?.trim();
	if (!base) {
		throw new AgentListError(
			"PIXIP_DAEMON_URL is not set. Run this agent inside a pixip session, or set PIXIP_DAEMON_URL to the daemon URL (for example http://127.0.0.1:8137/).",
		);
	}
	return base.endsWith("/") ? base : `${base}/`;
}

function absoluteFilterPath(value: string, base: string, env: NodeJS.ProcessEnv): string {
	let expanded = value;
	const home = env["HOME"]?.trim() || homedir();
	if (value === "~") expanded = home;
	else if (value.startsWith("~/")) expanded = join(home, value.slice(2));
	return resolve(base, expanded);
}

function filterText(name: string, value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed) throw new AgentListError(`${name} must not be empty`);
	return trimmed;
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	try {
		const parsed: unknown = text ? JSON.parse(text) : {};
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** GET the discovery list from the daemon; the caller turns failures into tool errors. */
export async function listAgents(input: AgentListInput, deps: AgentDeps = {}): Promise<AgentListResult> {
	const env = deps.env ?? process.env;
	const fetchImpl = deps.fetch ?? fetch;
	const base = daemonBase(env);
	const url = new URL("api/agents", base);

	if (input.all) url.searchParams.set("all", "1");
	const cwd = filterText("cwd", input.cwd);
	if (cwd) url.searchParams.set("cwd", absoluteFilterPath(cwd, deps.cwd ?? process.cwd(), env));
	const repo = filterText("repo", input.repo);
	if (repo) url.searchParams.set("repo", absoluteFilterPath(repo, deps.cwd ?? process.cwd(), env));
	const state = filterText("state", input.state);
	if (state) {
		if (!(AGENT_STATES as readonly string[]).includes(state)) {
			throw new AgentListError(`state must be one of ${AGENT_STATES.join(", ")}`);
		}
		url.searchParams.set("state", state);
	}
	const query = filterText("query", input.query);
	if (query) url.searchParams.set("query", query);
	const self = env["PIXIP_SESSION_ID"]?.trim();
	if (self) url.searchParams.set("self", self);

	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
		});
	} catch (error) {
		throw new AgentListError(
			`could not reach the pixip daemon at ${url.origin} (${error instanceof Error ? error.message : String(error)}). Check that pixip is running; PIXIP_DAEMON_URL normally comes from the hub.`,
		);
	}

	const body = await responseBody(response);
	if (!response.ok) {
		const detail = typeof body["error"] === "string" ? body["error"] : `request failed (${response.status})`;
		throw new AgentListError(`agent list failed: ${detail}`);
	}
	const agents = body["agents"];
	if (!Array.isArray(agents)) throw new AgentListError("the pixip daemon returned an unexpected agent list response");
	return {
		agents: agents as AgentInfo[],
		count: typeof body["count"] === "number" ? body["count"] : agents.length,
	};
}

/** Human-readable tool text; the structured details keep the same envelope. */
export function formatAgentListText(result: AgentListResult): string {
	if (result.count === 0) return "No pixip agents found.";
	const lines = [`${result.count} pixip agent(s):`];
	for (const agent of result.agents) {
		const flags = [
			agent.isSelf ? "self" : "",
			agent.awaitingUser ? "waiting for user" : "",
			agent.stored ? agent.stored : "",
		].filter(Boolean);
		const location = agent.worktree?.path ?? agent.repo ?? agent.cwd;
		lines.push(
			`${agent.name || "(untitled)"} [${agent.id.slice(0, 8)}] ${agent.state}${
				flags.length > 0 ? ` (${flags.join(", ")})` : ""
			} — ${location}`,
		);
		lines.push(`  ${agent.url}`);
	}
	return lines.join("\n");
}

/** Pi tool result: success is informational, failure is an actionable tool error. */
export async function runAgentListTool(input: AgentListInput, deps: AgentDeps = {}) {
	try {
		const result = await listAgents(input, deps);
		return {
			content: [{ type: "text" as const, text: formatAgentListText(result) }],
			details: result,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: message }],
			isError: true,
			details: { agents: [], count: 0, error: message },
		};
	}
}

/** POST one message; the daemon returns immediately with the delivery acknowledgement. */
export async function sendAgentMessage(input: AgentSendInput, deps: AgentDeps = {}): Promise<AgentSendAck> {
	const env = deps.env ?? process.env;
	const fetchImpl = deps.fetch ?? fetch;
	const base = daemonBase(env);
	const target = input.target.trim();
	if (!target) throw new AgentSendError("target must not be empty");
	if (!input.message.trim()) throw new AgentSendError("message must not be empty");
	const url = new URL(`api/agents/${encodeURIComponent(target)}/messages`, base);
	const sender = (input.sender ?? env["PIXIP_SESSION_ID"] ?? "").trim() || "local-shell";

	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: input.message, sender }),
			signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
		});
	} catch (error) {
		throw new AgentSendError(
			`could not reach the pixip daemon at ${url.origin} (${error instanceof Error ? error.message : String(error)}). Check that pixip is running; PIXIP_DAEMON_URL normally comes from the hub.`,
		);
	}

	const body = await responseBody(response);
	if (!response.ok) {
		const detail = typeof body["error"] === "string" ? body["error"] : `request failed (${response.status})`;
		throw new AgentSendError(`agent send failed: ${detail}`);
	}
	const ack = body as unknown as AgentSendAck;
	const ackTarget = ack?.target;
	if (typeof ack?.deliveryId !== "string" || !ackTarget || typeof ackTarget.url !== "string") {
		throw new AgentSendError("the pixip daemon returned an unexpected send response");
	}
	return ack;
}

/** Human-readable tool text; the acknowledgement details still carry the URL. */
export function formatAgentSendText(ack: AgentSendAck): string {
	const label = ack.target.name ? `${ack.target.name} [${ack.target.id}]` : `[${ack.target.id}]`;
	const flags = [ack.woken ? "woken" : "", ack.streaming ? "steered" : ""].filter(Boolean);
	return `Delivered ${ack.deliveryId} to ${label} (${ack.target.stateBefore} -> ${ack.target.stateAfter})${
		flags.length > 0 ? ` ${flags.join(", ")}` : ""
	}.\n${ack.target.url}`;
}

/** Pi tool result: success carries the ack (including URL), failure is actionable. */
export async function runAgentSendTool(input: AgentSendInput, deps: AgentDeps = {}) {
	try {
		const ack = await sendAgentMessage(input, deps);
		return {
			content: [{ type: "text" as const, text: formatAgentSendText(ack) }],
			details: ack,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: message }],
			isError: true,
			details: {
				deliveryId: "",
				target: {
					id: input.target,
					name: "",
					url: "",
					stateBefore: "stopped" as const,
					stateAfter: "stopped" as const,
				},
				delivered: false,
				woken: false,
				streaming: false,
				at: "",
				error: message,
			},
		};
	}
}
