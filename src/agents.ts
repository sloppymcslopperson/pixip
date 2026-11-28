/**
 * Agent discovery and message targeting: the shapes returned by
 * `GET /api/agents` and `POST /api/agents/:id/messages`.
 *
 * The same list feeds the dashboard-independent CLI and the opt-in
 * `pixip-agents` extension, so all filtering, ordering, target resolution and
 * URL construction lives here. Sending itself runs in the hub.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { AgentDeliveryReceipt } from "./agentDeliveries.ts";
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
	/** Latest successful send to this target; only active rows carry it. */
	lastDelivery?: AgentDeliveryReceipt;
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

/** Public target summary used in 404/409 responses and error text. */
export interface AgentCandidate {
	id: string;
	logicalId: string;
	name: string;
	state: SessionState;
	stored?: AgentStored;
}

/** One send request after HTTP/CLI parsing. */
export interface AgentSendRequest {
	target: string;
	message: string;
	sender?: string;
}

/** The acknowledgement returned without waiting for the target's turn. */
export interface AgentSendAck {
	deliveryId: string;
	target: {
		id: string;
		name: string;
		url: string;
		stateBefore: SessionState;
		stateAfter: SessionState;
	};
	delivered: boolean;
	woken: boolean;
	streaming: boolean;
	at: string;
}

/** A request/resolution/delivery failure with the HTTP status the route should use. */
export class AgentSendError extends Error {
	readonly status: number;
	readonly candidates?: AgentCandidate[];

	constructor(message: string, status: number, candidates?: AgentCandidate[]) {
		super(message);
		this.name = "AgentSendError";
		this.status = status;
		if (candidates) this.candidates = candidates;
	}
}

export interface ResolvedAgentTarget {
	info: SessionInfo | StoredSessionInfo;
	stored?: AgentStored;
}

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
	lastDelivery?: AgentDeliveryReceipt,
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
	if (!stored && lastDelivery) agent.lastDelivery = lastDelivery;
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
export async function listAgents(
	source: AgentSource,
	filters: AgentFilters,
	baseUrl: string,
	lastDeliveries?: Map<string, AgentDeliveryReceipt>,
): Promise<AgentList> {
	const agents = (await source.list()).map((info) =>
		toAgent(info, baseUrl, filters.self, undefined, lastDeliveries?.get(info.logicalId ?? info.id)),
	);
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

function candidate(info: SessionInfo | StoredSessionInfo, stored?: AgentStored): AgentCandidate {
	return {
		id: info.id,
		logicalId: info.logicalId ?? info.id,
		name: info.name ?? "",
		state: info.state,
		...(stored ? { stored } : {}),
	};
}

function candidateText(candidate: AgentCandidate): string {
	const label = candidate.name ? `${candidate.name} [${candidate.id}]` : `[${candidate.id}]`;
	return `${label} (${candidate.stored ? `${candidate.state}/${candidate.stored}` : candidate.state})`;
}

function ambiguous(query: string, candidates: AgentCandidate[]): AgentSendError {
	return new AgentSendError(
		`ambiguous agent "${query}"; matches: ${candidates.map(candidateText).join(", ")}`,
		409,
		candidates,
	);
}

/**
 * Resolve one target. Exact ids always win, including an archived/trash row;
 * stored rows are never reachable by name or prefix. Names are case-insensitive
 * and only search the active board.
 */
export function resolveAgentTarget(
	active: SessionInfo[],
	archived: StoredSessionInfo[],
	trash: StoredSessionInfo[],
	query: string,
): ResolvedAgentTarget {
	const activeMatches: ResolvedAgentTarget[] = active
		.filter((info) => info.id === query || info.logicalId === query)
		.map((info) => ({ info }));
	const archivedMatches: ResolvedAgentTarget[] = archived
		.filter((info) => info.id === query || info.logicalId === query)
		.map((info) => ({ info, stored: "archive" }));
	const trashMatches: ResolvedAgentTarget[] = trash
		.filter((info) => info.id === query || info.logicalId === query)
		.map((info) => ({ info, stored: "trash" }));
	const exact = [...activeMatches, ...archivedMatches, ...trashMatches];
	if (exact.length === 1 && exact[0]) return exact[0];
	if (exact.length > 1) {
		throw ambiguous(
			query,
			exact.map((match) => candidate(match.info, match.stored)),
		);
	}

	const lower = query.toLowerCase();
	const named = active.filter((info) => (info.name ?? "").toLowerCase() === lower);
	if (named.length === 1 && named[0]) return { info: named[0] };
	if (named.length > 1)
		throw ambiguous(
			query,
			named.map((info) => candidate(info)),
		);

	const prefixed = active.filter((info) => info.id.startsWith(query) || (info.logicalId?.startsWith(query) ?? false));
	if (prefixed.length === 1 && prefixed[0]) return { info: prefixed[0] };
	if (prefixed.length > 1)
		throw ambiguous(
			query,
			prefixed.map((info) => candidate(info)),
		);

	throw new AgentSendError(`unknown agent "${query}"; no active session matches that id, name or id prefix`, 404);
}

/** Validate once, before any IO, so empty input never reaches a session. */
export function normalizeAgentSend(input: AgentSendRequest): { target: string; message: string; senderId: string } {
	const target = input.target.trim();
	if (!target) throw new AgentSendError("target must not be empty", 400);
	if (!input.message.trim()) throw new AgentSendError("message must not be empty", 400);
	const rawSender = (input.sender ?? "").trim();
	const senderId = rawSender || "local-shell";
	if (senderId.length > 128) throw new AgentSendError("sender must be 128 characters or fewer", 400);
	for (const char of senderId) {
		const code = char.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) {
			throw new AgentSendError("sender must not contain control characters or newlines", 400);
		}
	}
	return { target, message: input.message, senderId };
}
