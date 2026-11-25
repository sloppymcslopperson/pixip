// @ts-nocheck -- these methods are written against the Hub instance as `this`; the public Hub declarations and tests are typed.
// Hub methods split by concern; each function runs with the Hub instance as `this`.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import type { RpcChild } from "./rpc.ts";
import { type PiBackend } from "./backend.ts";
import {
	type NameSource,
	type SessionHeader,
	type SessionIndexRecord,
	type StoredSessionInfo,
	type StoredSessionRecord,
	type SessionTarget,
	normalizeRecord,
	safeName,
	storedInfo,
} from "./sessionIndex.ts";
import { moveFile, nameFromLines, pathExists, readFromEnd, readHead, uniquePath, SYMBOL_PENDING } from "./jsonl.ts";
import { type CommandLayer } from "./commands.ts";
import { clearPendingReasks } from "./pendingReask.ts";
import { detectRepo, realCwd } from "./worktree.ts";
import type { CommandPolicy, SessionInfo } from "./wire.ts";

const run = promisify(execFile);

/**
 * The supervisor. One `pi --mode rpc` child per live session, nothing else.
 *
 * Deliberate limitations for the prototype, all of which the Rust port keeps:
 * - no PTY, no tmux, no terminal mirroring;
 * - no re-encoding of Pi events (see wire.ts);
 * - session truth lives in Pi's own JSONL files, so the hub can be restarted and
 *   simply re-attach with `--session <file>`;
 * - bounded in-memory state: headers are cached by mtime, event forwarding is a
 *   direct string splice with no history kept server-side.
 */

export interface HubOptions {
	piBin: string;
	sessionsDir: string;
	/** `<data-dir>`: where `pixip.json`, the pid/log and the index live. */
	dataDir?: string;
	/** Plain JSON array mapping pixip logical ids to the Pi sessions they ran as. */
	indexPath: string;
	idleMs: number;
	extraPiArgs: string[];
	/** CLI command-policy layer (`--allow-command`/`--deny-command`/`--no-bash`). */
	cliCommands?: CommandLayer;
	/**
	 * Response timeout for `prompt`, in ms; `0` (default) waits forever because an
	 * extension command may block on a user dialog. Tests pass a small value.
	 */
	promptTimeoutMs?: number;
	/**
	 * How long a blocking extension UI request waits after the last client
	 * detaches before it is cancelled. A reconnect inside this window replays the
	 * request instead. `0` disables the safety cancel; default 2 minutes.
	 */
	pendingUiGraceMs?: number;
	/** Extra environment for every child; `process.env` is inherited first. */
	env?: Record<string, string | undefined>;
	/** Spawn seam for the RPC host; defaults to the real `pi --mode rpc` child. */
	backend?: PiBackend;
	/** How long deleted sessions stay restorable in the trash. Default 60 s. */
	trashGraceMs?: number;
	/** Model for automatic session labels (`provider/id`); defaults to the session's model. */
	titleModel?: string;
	/** One-shot title call timeout. Default 15 s. */
	titleTimeoutMs?: number;
	log: (message: string) => void;
}

/** Current extension UI, keyed by the addon's status/widget key. */
interface AddonUiCache {
	statuses: Map<string, string>;
	widgets: Map<string, { placement: "above" | "below"; frame: string }>;
}

interface PendingUiRequest {
	frame: string;
	method: string;
	request: Record<string, unknown>;
	raw: string;
	startedAt: number;
	timer?: NodeJS.Timeout;
}

interface LiveSession {
	proc: RpcChild;
	info: SessionInfo;
	subs: Set<Subscriber>;
	/** Latest setStatus/setWidget records, replayed to a late subscriber. */
	addonUi?: AddonUiCache;
	/** Unanswered select/confirm/input/editor requests, replayed on reattach. */
	pendingUi?: Map<string, PendingUiRequest>;
	idleTimer?: NodeJS.Timeout;
	branch?: string;
	footerTimer?: NodeJS.Timeout;
	/** Effective command policy, resolved once at attach (or on soft refresh). */
	policy?: CommandPolicy;
	/** Id of the bash command currently running, if any (one at a time per session). */
	bashId?: string;
	/** Timestamp of the assistant message currently streaming (or last done). */
	assistantTs?: number;
	/** The automatic title has already been attempted for this session. */
	titleAttempted?: boolean;
	/** First prompt whose title call lost the provider race; retried at settle. */
	titlePending?: string;
	/** A first slash-command prompt: label from the expanded user message. */
	titleAwaitingMessage?: boolean;
	/** Raw slash-command prompt, used only when no expanded message arrives. */
	titlePrompt?: string;
	nameSource?: NameSource;
}

type Subscriber = (frame: string, key?: string) => void;

const SESSION_FILE = /\.jsonl$/;

/** A blocking dialog with no attached client is cancelled after this long. */
export const PENDING_UI_GRACE_MS = 120_000;

/** How far back one "load earlier" request may read before it gives up. */
const EARLIER_BYTES_CAP = 4 * 1024 * 1024;
/** Header scan: first line only, bounded so a 17 MB session costs one small read. */
const HEAD_BYTES = 8 * 1024;
/** Name scan: first ~20 lines, plus a bounded tail for sessions renamed later. */
const NAME_HEAD_LINES = 20;
const NAME_TAIL_BYTES = 16 * 1024;

export async function list(this: any): Promise<SessionInfo[]> {
	const records = await this.readIndex();
	const recordFor = (piId: string) => records.find((record) => record.piId === piId || record.piIds.includes(piId));
	const seen = new Set<string>();
	const infos: SessionInfo[] = [];
	// Live sessions first: a just-created session has no JSONL until its first
	// message, and it must still appear in the list.
	for (const [id, live] of this.live) {
		if (id === SYMBOL_PENDING) continue;
		seen.add(id);
		infos.push(live.info);
	}
	for (const { header, path } of await this.scan()) {
		if (seen.has(header.id)) continue;
		seen.add(header.id);
		// JSONL wins for state, name and activity; the index only adds the
		// logical id that ties a reattached Pi session to the same session and
		// supplies the name when the bounded scan misses a late session_info.
		const record = recordFor(header.id);
		infos.push({
			id: header.id,
			logicalId: record?.logicalId,
			cwd: header.cwd,
			name: header.name ?? record?.name,
			state: "stopped",
			sessionFile: path,
			...(record?.repo ? { repo: record.repo } : {}),
			...(record?.worktree ? { worktree: record.worktree } : {}),
			lastActivity: Date.parse(header.timestamp) || 0,
		});
	}
	for (const record of records) {
		// Any Pi id of this logical session already listed (live or JSONL) wins.
		if (seen.has(record.piId) || record.piIds.some((id) => seen.has(id))) continue;
		infos.push({
			id: record.piId,
			logicalId: record.logicalId,
			cwd: record.cwd,
			name: record.name,
			state: "stopped",
			sessionFile: record.sessionFile,
			...(record.repo ? { repo: record.repo } : {}),
			...(record.worktree ? { worktree: record.worktree } : {}),
			...(record.protected ? { protected: true } : {}),
			lastActivity: Date.parse(record.createdAt) || 0,
		});
	}
	for (const info of infos) {
		if (info.protected) continue;
		const record = records.find(
			(entry) => entry.logicalId === info.logicalId || entry.piId === info.id || entry.piIds.includes(info.id),
		);
		if (record?.protected) info.protected = true;
	}
	infos.sort((a, b) => b.lastActivity - a.lastActivity);
	// One git call per distinct cwd, shared by every session in that repo.
	const branches = new Map<string, string | undefined>();
	const repos = new Map<string, string | undefined>();
	const realCwds = new Map<string, string>();
	const liveByCwd = new Map<string, SessionInfo[]>();
	for (const live of this.live.values()) {
		if (!live.info.id) continue;
		const key = await realCwd(live.info.cwd);
		const sessions = liveByCwd.get(key) ?? [];
		sessions.push(live.info);
		liveByCwd.set(key, sessions);
	}
	for (const info of infos) {
		if (!info.cwd) continue;
		if (!info.repo) {
			if (!repos.has(info.cwd)) repos.set(info.cwd, await detectRepo(info.cwd));
			const repo = repos.get(info.cwd);
			if (repo) info.repo = repo;
		}
		if (!branches.has(info.cwd)) branches.set(info.cwd, await this.gitBranch(info.cwd));
		const branch = branches.get(info.cwd);
		if (branch) info.branch = branch;
		if (!realCwds.has(info.cwd)) realCwds.set(info.cwd, await realCwd(info.cwd));
		const key = realCwds.get(info.cwd) as string;
		info.peers = (liveByCwd.get(key) ?? [])
			.filter((other) => other.id !== info.id && other.logicalId !== info.logicalId)
			.map((other) => ({ id: other.logicalId ?? other.id, name: other.name || "Untitled session" }));
	}
	return infos;
}

export function watch(this: any, subscriber: Subscriber): () => void {
	this.watchers.add(subscriber);
	return () => this.watchers.delete(subscriber);
}

export async function archive(this: any, id: string): Promise<SessionInfo> {
	const { info, record } = await this.storeSession(id, this.archiveRoot);
	const dataDir = this.options.dataDir ?? dirname(this.options.sessionsDir);
	await clearPendingReasks(dataDir, record.logicalId);
	await this.refreshPeers();
	await this.broadcastSessions();
	return info;
}

export async function deleteSession(
	this: any,
	id: string,
): Promise<{ info: SessionInfo; token: string; expiresAt: number }> {
	await this.startupTrash;
	const { info, record, dir } = await this.storeSession(id, this.trashRoot);
	const dataDir = this.options.dataDir ?? dirname(this.options.sessionsDir);
	await clearPendingReasks(dataDir, record.logicalId);
	const expiresAt = Date.now() + this.trashGraceMs;
	setTimeout(() => {
		void rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
			this.options.log(`trash purge failed for ${dir}: ${(error as Error).message}`);
		});
	}, this.trashGraceMs).unref();
	await this.broadcastSessions();
	return { info, token: record.logicalId, expiresAt };
}

export async function archiveInactive(
	this: any,
	ids?: string[],
): Promise<{ archived: SessionInfo[]; failed: Array<{ id: string; error: string }> }> {
	const sessions = await this.list();
	const selected = Array.isArray(ids) ? new Set(ids) : undefined;
	const archived: SessionInfo[] = [];
	const failed: Array<{ id: string; error: string }> = [];
	for (const session of sessions) {
		if (session.state !== "stopped") continue;
		if (session.protected) continue;
		if (selected && !selected.has(session.id) && !selected.has(session.logicalId)) continue;
		try {
			archived.push((await this.storeSession(session.id, this.archiveRoot)).info);
		} catch (error) {
			failed.push({ id: session.id, error: (error as Error).message });
		}
	}
	await this.broadcastSessions();
	return { archived, failed };
}

/**
 * Set or clear the session's bulk-archive protection. The flag lives on the
 * index record, so it survives restarts, archive/restore and reattaches; it is
 * independent of the live child and only affects stopped sessions.
 */
export async function setProtected(this: any, id: string, value: boolean): Promise<SessionInfo> {
	const target = await this.resolveTarget(id);
	const logicalId = target.record.logicalId;
	await this.mutateIndex((records) => {
		const next = records.filter((record) => record.logicalId !== logicalId);
		const { protected: _previous, ...rest } = target.record;
		return [...next, value ? { ...rest, protected: true } : rest];
	});
	const live = this.findLive(id) ?? this.findLive(logicalId);
	if (live) live.info.protected = value || undefined;
	await this.broadcastSessions();
	return { ...target.info, protected: value || undefined };
}

export async function listArchived(this: any): Promise<StoredSessionInfo[]> {
	return await this.listStored(this.archiveRoot, "archive");
}

export async function listTrash(this: any): Promise<StoredSessionInfo[]> {
	await this.startupTrash;
	return await this.listStored(this.trashRoot, "trash");
}

export async function restoreArchived(this: any, id: string): Promise<SessionInfo> {
	return await this.restoreStored(this.archiveRoot, id);
}

export async function restoreTrash(this: any, id: string): Promise<SessionInfo> {
	await this.startupTrash;
	return await this.restoreStored(this.trashRoot, id);
}

export async function purgeArchived(this: any, id: string): Promise<void> {
	const found = await this.findStored(this.archiveRoot, id);
	if (!found) throw new Error(`unknown archived session ${id}`);
	await rm(found.dir, { recursive: true, force: true });
}

export async function purgeTrash(this: any, id: string): Promise<void> {
	await this.startupTrash;
	const found = await this.findStored(this.trashRoot, id);
	if (!found) throw new Error(`unknown deleted session ${id}`);
	await rm(found.dir, { recursive: true, force: true });
}

export function uploadsRoot(this: any): string {
	return join(this.options.dataDir ?? dirname(this.options.sessionsDir), "uploads");
}

export function uploadsDir(this: any, logicalId: string): string {
	return join(this.uploadsRoot(), safeName(logicalId));
}

export async function clearUploads(this: any, logicalId?: string): Promise<void> {
	if (!logicalId) return;
	await rm(this.uploadsDir(logicalId), { recursive: true, force: true }).catch((error: unknown) => {
		this.options.log(`upload cleanup failed for ${logicalId}: ${(error as Error).message}`);
	});
}

export async function gitBranch(this: any, cwd: string): Promise<string | undefined> {
	const cached = this.branchCache.get(cwd);
	if (cached && Date.now() - cached.at < 5000) return cached.branch;
	let branch: string | undefined;
	try {
		const { stdout } = await run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 2000 });
		branch = stdout.trim() || undefined;
		if (branch === "HEAD") {
			// Detached HEAD: show the abbreviated commit instead of a bare "HEAD".
			const sha = await run("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], { timeout: 2000 });
			branch = sha.stdout.trim() || undefined;
		}
	} catch {
		// Not a repo (or git unavailable): no chip, never an error in the list.
		branch = undefined;
	}
	this.branchCache.set(cwd, { branch, at: Date.now() });
	return branch;
}

export async function readIndex(this: any): Promise<SessionIndexRecord[]> {
	if (this.index) return this.index;
	const records: SessionIndexRecord[] = [];
	try {
		const parsed: unknown = JSON.parse(await readFile(this.options.indexPath, "utf8"));
		if (Array.isArray(parsed)) {
			for (const raw of parsed) records.push(...normalizeRecord(raw, this.options.sessionsDir));
		}
	} catch (error) {
		// A missing index is the normal empty case; a corrupt one is logged and
		// ignored, because JSONL sessions must keep listing regardless.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			this.options.log(`session index unreadable (${(error as Error).message}); starting empty`);
		}
	}
	this.index = records;
	return records;
}

export async function findRecord(this: any, id: string): Promise<SessionIndexRecord | undefined> {
	const records = await this.readIndex();
	return records.find((record) => record.logicalId === id || record.piId === id || record.piIds.includes(id));
}

export async function upsertIndex(
	this: any,
	info: SessionInfo,
	logicalId: string,
	createdAt?: string,
	nameSource?: NameSource,
): Promise<void> {
	if (!info.id) return;
	await this.mutateIndex((records) => {
		const existing = records.find((record) => record.logicalId === logicalId);
		const piIds = existing ? [...existing.piIds] : [];
		if (!piIds.includes(info.id)) piIds.push(info.id);
		// A blank or missing info.name must not erase a name already on the
		// record; Pi can emit an empty session_info while shutting down.
		const providedName = typeof info.name === "string" && info.name.trim() ? info.name : undefined;
		const name = providedName ?? existing?.name;
		const source =
			nameSource ?? (providedName !== undefined && existing?.name !== providedName ? "manual" : existing?.nameSource);
		const next: SessionIndexRecord = {
			logicalId,
			piId: info.id,
			piIds,
			cwd: info.cwd,
			name,
			nameSource: source,
			sessionFile: info.sessionFile ?? existing?.sessionFile,
			repo: info.repo ?? existing?.repo,
			worktree: info.worktree ?? existing?.worktree,
			protected: existing?.protected,
			createdAt: existing?.createdAt ?? createdAt ?? new Date().toISOString(),
		};
		const index = records.findIndex((record) => record.logicalId === logicalId);
		return index >= 0 ? records.map((record, at) => (at === index ? next : record)) : [...records, next];
	});
}

export async function storeSession(
	this: any,
	id: string,
	root: string,
): Promise<{ info: SessionInfo; record: SessionIndexRecord; dir: string }> {
	const live = this.findLive(id);
	if (live) {
		const state = live.info.state;
		if (state === "busy" || state === "starting") throw new Error(`session ${id} is ${state}; stop it first`);
		await this.stop(live.info.id);
	}
	const target = await this.resolveTarget(id);
	const dir = join(root, `${safeName(target.record.logicalId)}-${randomUUID().slice(0, 8)}`);
	const files = await this.moveSessionFiles(target.files, dir);
	const record: StoredSessionRecord = {
		...target.record,
		storedAt: new Date().toISOString(),
		files,
	};
	try {
		await writeFile(join(dir, "meta.json"), `${JSON.stringify(record, null, 2)}\n`);
	} catch (error) {
		await this.rollbackFiles(files, dir);
		throw error;
	}
	await this.clearUploads(target.record.logicalId);
	await this.removeRecord(target.record);
	this.files.clear();
	for (const piId of target.record.piIds) this.exported.delete(piId);
	return {
		info: { ...target.info, state: "stopped", sessionFile: target.record.sessionFile },
		record: target.record,
		dir,
	};
}

export function findLive(this: any, id: string): LiveSession | undefined {
	const direct = this.live.get(id);
	if (direct) return direct;
	for (const live of this.live.values()) {
		if (live.info.logicalId === id) return live;
	}
	return undefined;
}

export async function resolveTarget(this: any, id: string): Promise<SessionTarget> {
	const infos = await this.list();
	const info = infos.find((session) => session.id === id || session.logicalId === id);
	const records = await this.readIndex();
	let record = records.find((item) => item.logicalId === id || item.piId === id || item.piIds.includes(id));
	if (!record && info) {
		record = records.find(
			(item) => item.logicalId === info.logicalId || item.piId === info.id || item.piIds.includes(info.id),
		);
	}
	if (!record) {
		if (!info) throw new Error(`unknown session ${id}`);
		record = {
			logicalId: info.logicalId ?? info.id,
			piId: info.id,
			piIds: [info.id],
			cwd: info.cwd,
			name: info.name,
			sessionFile: info.sessionFile,
			repo: info.repo,
			...(info.worktree ? { worktree: info.worktree } : {}),
			...(record.protected ? { protected: true } : {}),
			createdAt: new Date(info.lastActivity || Date.now()).toISOString(),
		};
	}
	const piIds = [...new Set([...record.piIds, record.piId, ...(info ? [info.id] : [])])];
	const scanned = await this.scan();
	const paths = new Set<string>();
	for (const entry of scanned) {
		if (piIds.includes(entry.header.id)) paths.add(entry.path);
	}
	if (record.sessionFile) paths.add(record.sessionFile);
	if (info?.sessionFile) paths.add(info.sessionFile);
	const files: string[] = [];
	for (const path of paths) {
		if (await pathExists(path)) files.push(path);
	}
	const resolved: SessionInfo = info ?? {
		id: record.piId,
		logicalId: record.logicalId,
		cwd: record.cwd,
		name: record.name,
		state: "stopped",
		sessionFile: record.sessionFile,
		...(record.repo ? { repo: record.repo } : {}),
		...(record.worktree ? { worktree: record.worktree } : {}),
		...(record.protected ? { protected: true } : {}),
		lastActivity: Date.parse(record.createdAt) || 0,
	};
	return { info: resolved, record, files };
}

export async function removeRecord(this: any, record: SessionIndexRecord): Promise<void> {
	const ids = new Set([...record.piIds, record.piId]);
	await this.mutateIndex((records) =>
		records.filter(
			(existing) =>
				existing.logicalId !== record.logicalId && !ids.has(existing.piId) && !existing.piIds.some((id) => ids.has(id)),
		),
	);
}

export async function putRecord(this: any, record: SessionIndexRecord): Promise<void> {
	const ids = new Set([...record.piIds, record.piId]);
	await this.mutateIndex((records) => [
		...records.filter(
			(existing) =>
				existing.logicalId !== record.logicalId && !ids.has(existing.piId) && !existing.piIds.some((id) => ids.has(id)),
		),
		record,
	]);
}

export async function moveSessionFiles(
	this: any,
	files: string[],
	dir: string,
): Promise<Array<{ original: string; stored: string }>> {
	await mkdir(dir, { recursive: true });
	const moved: Array<{ original: string; stored: string }> = [];
	try {
		for (const original of files) {
			const base = safeName(basename(original));
			let stored = base;
			for (let suffix = 1; await pathExists(join(dir, stored)); suffix += 1) {
				stored = base.endsWith(".jsonl") ? `${base.slice(0, -".jsonl".length)}-${suffix}.jsonl` : `${base}-${suffix}`;
			}
			await moveFile(original, join(dir, stored));
			moved.push({ original, stored });
		}
		return moved;
	} catch (error) {
		await this.rollbackFiles(moved, dir);
		throw error;
	}
}

export async function rollbackFiles(
	this: any,
	moved: Array<{ original: string; stored: string }>,
	dir: string,
): Promise<void> {
	for (const item of [...moved].reverse()) {
		await moveFile(join(dir, item.stored), item.original).catch(() => {});
	}
	await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export async function restoreStored(this: any, root: string, id: string): Promise<SessionInfo> {
	const found = await this.findStored(root, id);
	if (!found) throw new Error(`unknown stored session ${id}`);
	const { record, dir } = found;
	const restored: SessionIndexRecord = {
		logicalId: record.logicalId,
		piId: record.piId,
		piIds: [...record.piIds],
		cwd: record.cwd,
		name: record.name,
		nameSource: record.nameSource,
		sessionFile: record.sessionFile,
		repo: record.repo,
		worktree: record.worktree,
		...(record.protected ? { protected: true } : {}),
		createdAt: record.createdAt,
	};
	const mapping = new Map<string, string>();
	const moved: Array<{ stored: string; target: string }> = [];
	try {
		for (const file of record.files) {
			const target = await uniquePath(file.original);
			await moveFile(join(dir, file.stored), target);
			mapping.set(file.original, target);
			moved.push({ stored: file.stored, target });
		}
	} catch (error) {
		for (const item of [...moved].reverse()) {
			await moveFile(item.target, join(dir, item.stored)).catch(() => {});
		}
		throw error;
	}
	if (record.sessionFile) restored.sessionFile = mapping.get(record.sessionFile) ?? record.sessionFile;
	if (!restored.sessionFile && record.files[0]) {
		restored.sessionFile = mapping.get(record.files[0].original) ?? record.files[0].original;
	}
	await this.putRecord(restored);
	await rm(dir, { recursive: true, force: true });
	this.files.clear();
	await this.broadcastSessions();
	return {
		id: restored.piId,
		logicalId: restored.logicalId,
		cwd: restored.cwd,
		name: restored.name,
		state: "stopped",
		sessionFile: restored.sessionFile,
		...(restored.repo ? { repo: restored.repo } : {}),
		...(restored.worktree ? { worktree: restored.worktree } : {}),
		...(restored.protected ? { protected: true } : {}),
		lastActivity: Date.now(),
	};
}

export async function listStored(this: any, root: string, kind: "archive" | "trash"): Promise<StoredSessionInfo[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const items: StoredSessionInfo[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const record = await this.readStoredRecord(join(root, entry.name));
		if (record) items.push(storedInfo(record, kind, this.trashGraceMs));
	}
	items.sort((a, b) => b.lastActivity - a.lastActivity);
	return items;
}

export async function findStored(
	this: any,
	root: string,
	id: string,
): Promise<{ dir: string; record: StoredSessionRecord } | undefined> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		const record = await this.readStoredRecord(dir);
		if (!record) continue;
		if (record.logicalId === id || record.piId === id || record.piIds.includes(id) || entry.name === id) {
			return { dir, record };
		}
	}
	return undefined;
}

export async function readStoredRecord(this: any, dir: string): Promise<StoredSessionRecord | undefined> {
	try {
		const parsed = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as Partial<StoredSessionRecord>;
		if (typeof parsed.logicalId !== "string" || typeof parsed.piId !== "string" || typeof parsed.storedAt !== "string")
			return undefined;
		const piIds = Array.isArray(parsed.piIds) ? parsed.piIds.filter((id): id is string => typeof id === "string") : [];
		const files = Array.isArray(parsed.files)
			? parsed.files.filter(
					(file): file is { original: string; stored: string } =>
						typeof file?.original === "string" && typeof file?.stored === "string",
				)
			: [];
		return {
			logicalId: parsed.logicalId,
			piId: parsed.piId,
			piIds: piIds.includes(parsed.piId) ? piIds : [...piIds, parsed.piId],
			cwd: typeof parsed.cwd === "string" ? parsed.cwd : this.options.sessionsDir,
			name: typeof parsed.name === "string" ? parsed.name : undefined,
			nameSource: parsed.nameSource === "auto" || parsed.nameSource === "manual" ? parsed.nameSource : undefined,
			sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : undefined,
			protected: parsed.protected === true ? true : undefined,
			createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : parsed.storedAt,
			storedAt: parsed.storedAt,
			files,
		};
	} catch {
		return undefined;
	}
}

export async function purgeTrashOnStart(this: any): Promise<void> {
	const entries = await readdir(this.trashRoot, { withFileTypes: true }).catch(() => []);
	await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => rm(join(this.trashRoot, entry.name), { recursive: true, force: true }).catch(() => {})),
	);
}

export async function broadcastSessions(this: any): Promise<void> {
	this.broadcastList(await this.list());
}

export function mutateIndex(this: any, mutate: (records: SessionIndexRecord[]) => SessionIndexRecord[]): Promise<void> {
	const run = async () => {
		const next = mutate(await this.readIndex());
		this.index = next;
		const path = this.options.indexPath;
		await mkdir(dirname(path), { recursive: true });
		const temp = `${path}.${process.pid}.tmp`;
		await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
		await rename(temp, path);
	};
	this.indexWrite = this.indexWrite.then(run, run);
	return this.indexWrite;
}

export async function persistName(this: any, live: LiveSession): Promise<void> {
	const { info } = live;
	if (!info.logicalId) return;
	await this.upsertIndex(info, info.logicalId, undefined, live.nameSource).catch((error: unknown) => {
		this.options.log(`session index write failed: ${(error as Error).message}`);
	});
}

export async function scan(this: any): Promise<Array<{ header: SessionHeader; path: string }>> {
	const results: Array<{ header: SessionHeader; path: string }> = [];
	let entries;
	try {
		entries = await readdir(this.options.sessionsDir, { recursive: true, withFileTypes: true });
	} catch {
		return results;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
		const path = join(entry.parentPath, entry.name);
		const header = await this.header(path);
		if (header) results.push({ header, path });
	}
	return results;
}

export async function header(this: any, path: string): Promise<SessionHeader | undefined> {
	let mtimeMs = 0;
	try {
		mtimeMs = (await stat(path)).mtimeMs;
	} catch {
		return undefined;
	}
	const cached = this.files.get(path);
	if (cached && cached.mtimeMs === mtimeMs) return cached.header;
	try {
		const head = await readHead(path, HEAD_BYTES);
		const headLines = head.text.split("\n");
		const firstLine = headLines[0] ?? "";
		if (firstLine.length === 0) return undefined;
		const parsed = JSON.parse(firstLine) as { type?: string; id?: string; cwd?: string; timestamp?: string };
		if (parsed.type !== "session" || !parsed.id) return undefined;

		// Names live in `session_info` records: the head pass covers the common
		// case, the bounded tail pass covers a rename later in the session.
		let name = nameFromLines(headLines.slice(0, NAME_HEAD_LINES));
		try {
			const tail = await readFromEnd(path, NAME_TAIL_BYTES);
			const tailLines = tail.text.split("\n");
			// A read that starts mid-file begins with a partial line.
			if (tail.offset > 0) tailLines.shift();
			name = nameFromLines(tailLines) ?? name;
		} catch {
			// Unreadable tail: keep whatever the head found.
		}

		const header: SessionHeader = {
			id: parsed.id,
			cwd: parsed.cwd ?? this.options.sessionsDir,
			timestamp: parsed.timestamp ?? new Date(mtimeMs).toISOString(),
			name,
		};
		this.files.set(path, { mtimeMs, header });
		return header;
	} catch {
		return undefined;
	}
}
