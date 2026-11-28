/**
 * Read-only agent discovery: the shape returned by `GET /api/agents`.
 *
 * The same list feeds the dashboard-independent CLI and the opt-in
 * `pixip-agents` extension, so all filtering, ordering and URL construction
 * lives here. Nothing in this module mutates a session.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { StoredSessionInfo } from "./sessionIndex.ts";
import type { SessionInfo, SessionState, WorktreeInfo } from "./wire.ts";

export const AGENT_STATES = ["starting", "idle", "busy", "stopped", "error"] as const;

/** Archive and trash are the only off-board states discovery can return. */
export type AgentStored = "archive" | "trash";

export interface AgentInfo {
	/** Current Pi session id; the route id for the dashboard URL. */
	id: string;
	/** Stable pixip logical id; survives Pi allocating a new id. */
	logicalId: string;
	name: string;
	state: SessionState;
	cwd: string;
	repo?: string;
	branch?: string;
	worktree?: WorktreeInfo;
	awaitingUser: boolean;
	lastActivity: number;
	isSelf: boolean;
	/** Absolute dashboard URL, `http://host:port/#s=<routeId>`. */
	url: string;
	/** Present only when the row came from archive or trash. */
	stored?: AgentStored;
	archivedAt?: string;
	deletedAt?: string;
	expiresAt?: number;
}

export interface AgentFilters {
	all: boolean;
	cwd?: string;
	repo?: string;
	state?: SessionState;
	query?: string;
	self?: string;
}

export interface AgentList {
	agents: AgentInfo[];
	count: number;
}

export interface AgentSource {
	list: () => Promise<SessionInfo[]>;
	listArchived: () => Promise<StoredSessionInfo[]>;
	listTrash: () => Promise<StoredSessionInfo[]>;
}

export class AgentFilterError extends Error {}

const FILTER_KEYS = new Set(["all", "cwd", "repo", "state", "query", "self"]);

function filterValue(params: URLSearchParams, key: string): string | undefined {
	const raw = params.get(key);
	if (raw === null) return undefined;
	const value = raw.trim();
	if (!value) throw new AgentFilterError(`filter "${key}" must not be empty`);
	return value;
}

/** Parse and validate the query string once; bad filters fail before any IO. */
export function parseAgentFilters(params: URLSearchParams): AgentFilters {
	for (const key of params.keys()) {
		if (!FILTER_KEYS.has(key)) throw new AgentFilterError(`unknown filter "${key}"`);
	}
	const filters: AgentFilters = { all: false };
	const all = filterValue(params, "all");
	if (all !== undefined) {
		if (all === "1" || all === "true") filters.all = true;
		else if (all === "0" || all === "false") filters.all = false;
		else throw new AgentFilterError(`filter "all" must be 1, true, 0 or false`);
	}
	const cwd = filterValue(params, "cwd");
	if (cwd) filters.cwd = resolveFilterPath(cwd);
	const repo = filterValue(params, "repo");
	if (repo) filters.repo = resolveFilterPath(repo);
	const state = filterValue(params, "state");
	if (state) {
		if (!(AGENT_STATES as readonly string[]).includes(state)) {
			throw new AgentFilterError(`unknown state "${state}"; expected ${AGENT_STATES.join(", ")}`);
		}
		filters.state = state as SessionState;
	}
	const query = filterValue(params, "query");
	if (query) filters.query = query;
	const self = filterValue(params, "self");
	if (self) filters.self = self;
	return filters;
}

/** Resolve `~` and relative path filters to one absolute spelling. */
export function resolveFilterPath(value: string, base = process.cwd()): string {
	let expanded = value;
	if (value === "~") expanded = homedir();
	else if (value.startsWith("~/")) expanded = join(homedir(), value.slice(2));
	return resolve(base, expanded);
}

/**
 * Use the host the caller actually reached, so a wildcard bind still produces a
 * usable link. Fall back to the daemon URL when a test or proxy omits `Host`.
 */
export function agentBaseUrl(hostHeader: string | undefined, fallback: string | undefined): string {
	const host = hostHeader?.trim();
	if (host) {
		try {
			const parsed = new URL(`http://${host}`);
			if (parsed.host) return `http://${parsed.host}/`;
		} catch {
			// Ignore malformed Host and use the daemon URL below.
		}
	}
	const base = fallback?.trim();
	if (base) {
		try {
			const parsed = new URL(base);
			return `${parsed.protocol}//${parsed.host}/`;
		} catch {
			// Ignore malformed fallback and use loopback.
		}
	}
	return "http://127.0.0.1/";
}

/** Build the absolute dashboard link for one agent. */
export function agentUrl(baseUrl: string, routeId: string): string {
	const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return `${base}#s=${encodeURIComponent(routeId)}`;
}

function toAgent(
	info: SessionInfo | StoredSessionInfo,
	baseUrl: string,
	self: string | undefined,
	stored?: AgentStored,
): AgentInfo {
	const id = info.id;
	const logicalId = info.logicalId ?? id;
	const routeId = id || logicalId;
	const agent: AgentInfo = {
		id,
		logicalId,
		name: info.name ?? "",
		state: info.state,
		cwd: info.cwd,
		awaitingUser: info.awaitingUser === true,
		lastActivity: info.lastActivity,
		isSelf: self !== undefined && (id === self || logicalId === self),
		url: agentUrl(baseUrl, routeId),
	};
	if (info.repo) agent.repo = info.repo;
	if (info.branch) agent.branch = info.branch;
	if (info.worktree) agent.worktree = info.worktree;
	if (stored) agent.stored = stored;
	if ("archivedAt" in info && info.archivedAt) agent.archivedAt = info.archivedAt;
	if ("deletedAt" in info && info.deletedAt) agent.deletedAt = info.deletedAt;
	if ("expiresAt" in info && typeof info.expiresAt === "number") agent.expiresAt = info.expiresAt;
	return agent;
}

function matches(agent: AgentInfo, filters: AgentFilters): boolean {
	if (filters.cwd && agent.cwd !== filters.cwd) return false;
	if (filters.repo && agent.repo !== filters.repo) return false;
	if (filters.state && agent.state !== filters.state) return false;
	if (filters.query) {
		const haystack = [
			agent.name,
			agent.id,
			agent.logicalId,
			agent.cwd,
			agent.repo ?? "",
			agent.branch ?? "",
			agent.worktree?.path ?? "",
			agent.worktree?.branch ?? "",
		]
			.join("\n")
			.toLowerCase();
		if (!haystack.includes(filters.query.toLowerCase())) return false;
	}
	return true;
}

function compareAgents(a: AgentInfo, b: AgentInfo): number {
	if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
	const aGroup = a.repo ?? a.cwd;
	const bGroup = b.repo ?? b.cwd;
	if (aGroup !== bGroup) return aGroup.localeCompare(bGroup);
	const aTree = a.worktree?.path ?? "";
	const bTree = b.worktree?.path ?? "";
	if (aTree !== bTree) return aTree.localeCompare(bTree);
	if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
	const aName = a.name || a.id;
	const bName = b.name || b.id;
	if (aName !== bName) return aName.localeCompare(bName);
	return a.id.localeCompare(b.id);
}

/** Read the active board, plus archive/trash when explicitly requested. */
export async function listAgents(source: AgentSource, filters: AgentFilters, baseUrl: string): Promise<AgentList> {
	const agents = (await source.list()).map((info) => toAgent(info, baseUrl, filters.self));
	if (filters.all) {
		for (const info of await source.listArchived()) {
			agents.push(toAgent(info, baseUrl, filters.self, "archive"));
		}
		for (const info of await source.listTrash()) {
			agents.push(toAgent(info, baseUrl, filters.self, "trash"));
		}
	}
	const selected = agents.filter((agent) => matches(agent, filters)).sort(compareAgents);
	return { agents: selected, count: selected.length };
}
