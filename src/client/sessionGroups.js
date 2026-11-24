/**
 * Dashboard session grouping. Pure so the collapse/pinning rules are testable
 * without a DOM; `app.js` owns the localStorage plumbing and the elements.
 */

import { formatCwd } from "./footer.js";

export const COLLAPSED_STORAGE_KEY = "pixip.sessionGroups.collapsed";
export const KEEP_ACTIVE_STORAGE_KEY = "pixip.sessionGroups.keepActive";

const HOT = new Set(["busy", "starting"]);
const WARM = new Set(["idle"]);

/** Hot = actively booting/running; warm = an attached child that is idle. */
export function isHot(session) {
	return HOT.has(session?.state);
}

export function isWarm(session) {
	return WARM.has(session?.state);
}

export function isActiveSession(session) {
	return isHot(session) || isWarm(session);
}

/** Bucket key: exact cwd with trailing slashes trimmed; blank is one fallback. */
export function normalizeCwd(cwd) {
	const text = typeof cwd === "string" ? cwd.trim() : "";
	if (!text) return "";
	const trimmed = text.replace(/\/+$/, "");
	return trimmed || "/";
}

function activity(session) {
	const value = Number(session?.lastActivity);
	return Number.isFinite(value) ? value : 0;
}

function byActivity(a, b) {
	return activity(b) - activity(a) || String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

/**
 * Group sessions by cwd. Groups are ordered by their newest activity, rows are
 * newest first; a tie breaks on id (rows) or the cwd key (groups) so a refresh
 * never reshuffles equal timestamps.
 */
export function groupSessions(sessions) {
	const groups = new Map();
	for (const session of Array.isArray(sessions) ? sessions : []) {
		if (!session || typeof session !== "object") continue;
		const key = normalizeCwd(session.cwd);
		let group = groups.get(key);
		if (!group) {
			group = { key, cwd: key, sessions: [] };
			groups.set(key, group);
		}
		group.sessions.push(session);
	}
	const result = [...groups.values()];
	for (const group of result) group.sessions.sort(byActivity);
	result.sort((a, b) => activity(b.sessions[0]) - activity(a.sessions[0]) || a.key.localeCompare(b.key));
	return result;
}

/**
 * Rows that survive a collapse: every hot/warm session plus the group's newest
 * session even when it is cold. `keepActive` false removes the exemption.
 */
export function pinnedSessions(group, keepActive = true) {
	const sessions = group?.sessions ?? [];
	if (!keepActive || sessions.length === 0) return [];
	const newest = sessions[0];
	return sessions.filter((session) => session === newest || isActiveSession(session));
}

/** Rows a group shows in its current state, plus how many the collapse hides. */
export function groupView(group, collapsed, keepActive = true) {
	const sessions = group?.sessions ?? [];
	if (!collapsed) return { rows: sessions, hidden: 0 };
	const rows = pinnedSessions(group, keepActive);
	return { rows, hidden: sessions.length - rows.length };
}

/** Header count, e.g. "12 sessions · 5 hidden". */
export function countLabel(count, hidden = 0) {
	const sessions = `${count} session${count === 1 ? "" : "s"}`;
	return hidden > 0 ? `${sessions} · ${hidden} hidden` : sessions;
}

/** Home-shortened group title; a missing cwd gets the single fallback label. */
export function groupLabel(group, home) {
	const path = typeof group?.cwd === "string" && group.cwd ? group.cwd : group?.key;
	return path ? formatCwd(path, home) : "unknown cwd";
}

/** The group's git branch, if the hub reported one for any session in it. */
export function groupBranch(group) {
	for (const session of group?.sessions ?? []) {
		if (typeof session?.branch === "string" && session.branch.trim()) return session.branch.trim();
	}
	return "";
}

/** Stored collapse map: only boolean values survive, malformed input is empty. */
export function parseCollapsed(raw) {
	if (typeof raw !== "string" || raw === "") return {};
	try {
		const value = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		const result = {};
		for (const [key, collapsed] of Object.entries(value)) {
			if (typeof collapsed === "boolean") result[key] = collapsed;
		}
		return result;
	} catch {
		return {};
	}
}

export function serializeCollapsed(map) {
	const clean = {};
	for (const [key, collapsed] of Object.entries(map ?? {})) {
		if (typeof collapsed === "boolean") clean[key] = collapsed;
	}
	return JSON.stringify(clean);
}

/** Pinning is on unless the stored value explicitly says off. */
export function parseKeepActive(raw) {
	if (raw === "0" || raw === "false") return false;
	return true;
}

export function serializeKeepActive(value) {
	return value ? "1" : "0";
}

// ------------------------------------------------------- repo / worktree tree

const WORKTREE_BRANCH_PREFIX = "pixip/";

/** The branch name without pixip's namespace, for the worktree group label. */
export function worktreeBranchLabel(branch) {
	const text = typeof branch === "string" ? branch.trim() : "";
	return text.startsWith(WORKTREE_BRANCH_PREFIX) ? text.slice(WORKTREE_BRANCH_PREFIX.length) : text;
}

function newestActivity(sessions) {
	let newest = 0;
	for (const session of sessions) newest = Math.max(newest, activity(session));
	return newest;
}

function sortRows(sessions) {
	return [...sessions].sort(byActivity);
}

/**
 * Hierarchical dashboard grouping: one parent per repository, direct main-repo
 * sessions under it, and one child group per linked worktree. Plain directories
 * stay flat. A worktree row synthesizes its parent even when no main-repo
 * session exists yet.
 */
export function groupSessionTree(sessions) {
	const parents = new Map();
	const parentFor = (repo) => {
		const key = `repo:${repo}`;
		let group = parents.get(key);
		if (!group) {
			group = {
				key,
				kind: "repo",
				cwd: repo,
				repo,
				sessions: [],
				worktrees: new Map(),
				allSessions: [],
			};
			parents.set(key, group);
		}
		return group;
	};
	const plainFor = (key) => {
		let group = parents.get(key);
		if (!group) {
			group = { key, kind: "plain", cwd: key, sessions: [], worktrees: new Map(), allSessions: [] };
			parents.set(key, group);
		}
		return group;
	};

	for (const session of Array.isArray(sessions) ? sessions : []) {
		if (!session || typeof session !== "object") continue;
		const worktree = session.worktree;
		const sessionRepo =
			typeof session.repo === "string" && session.repo.trim()
				? session.repo.trim()
				: typeof worktree?.repo === "string" && worktree.repo.trim()
					? worktree.repo.trim()
					: "";
		if (!sessionRepo) {
			plainFor(normalizeCwd(session.cwd)).sessions.push(session);
			continue;
		}
		const parent = parentFor(sessionRepo);
		if (worktree && typeof worktree.path === "string" && worktree.path.trim()) {
			const path = worktree.path.trim();
			let child = parent.worktrees.get(path);
			if (!child) {
				child = {
					key: `worktree:${path}`,
					kind: "worktree",
					cwd: path,
					repo: sessionRepo,
					branch: typeof worktree.branch === "string" ? worktree.branch : "",
					pixipActive: worktree.pixipActive === true,
					worktree,
					sessions: [],
				};
				parent.worktrees.set(path, child);
			}
			child.sessions.push(session);
			continue;
		}
		parent.sessions.push(session);
	}

	const result = [...parents.values()];
	for (const group of result) {
		group.sessions = sortRows(group.sessions);
		const worktrees = [...group.worktrees.values()];
		for (const child of worktrees) child.sessions = sortRows(child.sessions);
		worktrees.sort((a, b) => newestActivity(b.sessions) - newestActivity(a.sessions) || a.cwd.localeCompare(b.cwd));
		group.worktrees = worktrees;
		group.allSessions = sortRows([...group.sessions, ...worktrees.flatMap((child) => child.sessions)]);
	}
	result.sort(
		(a, b) =>
			newestActivity(b.allSessions) - newestActivity(a.allSessions) || String(a.key).localeCompare(String(b.key)),
	);
	return result;
}

/** Total sessions in a parent group, including every worktree child. */
export function groupSessionCount(group) {
	return group?.allSessions?.length ?? group?.sessions?.length ?? 0;
}

/** Actions the group menu offers; parent repos can branch, worktrees can delete. */
export function groupActions(group) {
	if (group?.kind === "worktree") return ["new", "delete"];
	if (group?.kind === "repo") return ["new", "newWorktree"];
	return ["new"];
}

/** The cwd a plain `new` from this group should reuse. */
export function groupNewCwd(group) {
	return group?.cwd ?? "";
}

/** Last path component, used to prefill a worktree slug from a repo path. */
export function pathBasename(path) {
	const text = typeof path === "string" ? path.replace(/\/+$/, "") : "";
	const at = text.lastIndexOf("/");
	return at >= 0 ? text.slice(at + 1) : text;
}

/**
 * A git-safe worktree slug: lowercase, invalid runs collapsed to `-`, leading
 * non-alphanumerics removed and at most 80 characters.
 */
export function slugifyWorktree(value) {
	const slug = String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.replace(/[._-]+$/, "")
		.slice(0, 80)
		.replace(/[._-]+$/, "");
	return slug;
}

/** Existing branches as bare slugs, accepting both `pixip/x` and `x`. */
function branchSlugs(branches) {
	const slugs = new Set();
	for (const branch of Array.isArray(branches) ? branches : []) {
		const text = typeof branch === "string" ? branch.trim() : "";
		if (!text) continue;
		slugs.add(text.startsWith(WORKTREE_BRANCH_PREFIX) ? text.slice(WORKTREE_BRANCH_PREFIX.length) : text);
	}
	return slugs;
}

/** `base`, else `base-2`, `base-3`, … against existing branch names. */
export function nextWorktreeSlug(base, branches) {
	const taken = branchSlugs(branches);
	const root = slugifyWorktree(base) || "worktree";
	if (!taken.has(root)) return root;
	for (let index = 2; index < 1000; index += 1) {
		const suffix = `-${index}`;
		const candidate = `${root.slice(0, 80 - suffix.length)}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${root.slice(0, 72)}-${Date.now()}`;
}

/** The full git branch name for a worktree slug. */
export function worktreeBranchFor(slug) {
	return `${WORKTREE_BRANCH_PREFIX}${slug}`;
}

/** `<repo-parent>/pixip_worktrees/<repo-name>/<slug>` without Node's path module. */
export function worktreePathFor(repo, slug) {
	const root = String(repo ?? "").replace(/\/+$/, "");
	const at = root.lastIndexOf("/");
	const parent = at < 0 ? "" : at === 0 ? "" : root.slice(0, at);
	const name = at >= 0 ? root.slice(at + 1) : root;
	return `${parent}/pixip_worktrees/${name}/${slug}`;
}
