/**
 * Thin client for the pixip discovery endpoint. The extension never guesses the
 * daemon address and never mutates a session: it only reads `GET /api/agents`.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const AGENT_LIST_TOOL = "agent_list";
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

export interface AgentDeps {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	timeoutMs?: number;
	/** Base for resolving relative cwd/repo filters; defaults to process.cwd(). */
	cwd?: string;
}

export class AgentListError extends Error {}

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
