import { dirname, join } from "node:path";

import * as hubControl from "./hubControl.ts";
import * as hubLive from "./hubLive.ts";
import * as hubSession from "./hubSession.ts";
import * as hubStore from "./hubStore.ts";
import type { PiBackend } from "./backend.ts";
import { WINDOW_BYTES, WINDOW_ENTRIES } from "./jsonl.ts";
import type { CommandLayer } from "./commands.ts";
import type { RpcChild } from "./rpc.ts";
import type {
	NameSource,
	SessionHeader,
	SessionIndexRecord,
	StoredSessionInfo,
	StoredSessionRecord,
	SessionTarget,
} from "./sessionIndex.ts";
import type { BashResult, CommandPolicy, DynamicCommand, FooterData, ModelSummary, SessionInfo } from "./wire.ts";

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
	/** `pixip-pi-host` bin; when set, new and reattached sessions spawn it instead of `pi`. */
	piHostBin?: string;
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
	timer?: NodeJS.Timeout;
}

interface LiveSession {
	proc: RpcChild;
	info: SessionInfo;
	subs: Set<Subscriber>;
	/** Latest setStatus/setWidget records, replayed to a late subscriber. */
	addonUi?: AddonUiCache;
	/** Unanswered select/confirm/input/editor/panel requests, replayed on reattach. */
	pendingUi?: Map<string, PendingUiRequest>;
	/** Consumed `hello` from `pixip-pi-host`; never forwarded as a transcript event. */
	host?: { protocol?: number; piVersion?: string; capabilities?: string[] };
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

/** A blocking dialog with no attached client is cancelled after this long. */
export const PENDING_UI_GRACE_MS = 120_000;

export class Hub {
	private readonly options: HubOptions;
	private readonly live = new Map<string, LiveSession>();
	private readonly files = new Map<string, { mtimeMs: number; header: SessionHeader }>();
	private readonly watchers = new Set<Subscriber>();
	private index?: SessionIndexRecord[];
	/** Sockets that must follow a session to a new Pi id (`new_session`). */
	private readonly rekeyListeners = new Set<(from: string, info: SessionInfo) => void>();
	/** Serializes index writes; every mutation is read-modify-write inside it. */
	private indexWrite: Promise<void> = Promise.resolve();
	/** Last HTML export per Pi session id, so a download need not export twice. */
	private readonly exported = new Map<string, string>();
	private readonly archiveRoot: string;
	private readonly trashRoot: string;
	private readonly trashGraceMs: number;
	private readonly pendingUiGraceMs: number;
	/** Startup cleanup runs once; trash operations wait for it. */
	private readonly startupTrash: Promise<void>;
	/** Branch per cwd, so list refreshes do not run git every time. */
	private readonly branchCache = new Map<string, { branch?: string; at: number }>();

	constructor(options: HubOptions) {
		this.options = options;
		const dataDir = options.dataDir ?? dirname(options.sessionsDir);
		this.archiveRoot = join(dataDir, "archive");
		this.trashRoot = join(dataDir, "trash");
		this.trashGraceMs = options.trashGraceMs ?? 60_000;
		this.pendingUiGraceMs = options.pendingUiGraceMs ?? PENDING_UI_GRACE_MS;
		this.startupTrash = this.purgeTrashOnStart();
	}

	// ---------------------------------------------------------------- listing

	async list(): Promise<SessionInfo[]> {
		return await hubStore.list.apply(this, arguments as any);
	}

	watch(subscriber: Subscriber): () => void {
		return hubStore.watch.apply(this, arguments as any);
	}

	// ------------------------------------------------------------- lifecycle

	async create(cwd: string, name?: string): Promise<SessionInfo> {
		return await hubLive.create.apply(this, arguments as any);
	}

	async attach(id: string): Promise<SessionInfo> {
		return await hubLive.attach.apply(this, arguments as any);
	}

	async stop(id: string): Promise<SessionInfo> {
		return await hubLive.stop.apply(this, arguments as any);
	}

	/**
	 * Archive one session: detach an idle child, move every JSONL of the logical
	 * session under `<data-dir>/archive`, drop the index record. Recoverable from
	 * the settings archive sheet; busy/starting sessions are refused.
	 */
	async archive(id: string): Promise<SessionInfo> {
		return await hubStore.archive.apply(this, arguments as any);
	}

	/**
	 * Delete one session into `<data-dir>/trash`, with a short undo window before
	 * the files are purged. The same safety rules as archive apply.
	 */
	async deleteSession(id: string): Promise<{ info: SessionInfo; token: string; expiresAt: number }> {
		return await hubStore.deleteSession.apply(this, arguments as any);
	}

	/** Archive every stopped session, skipping failures so one bad file cannot block the batch. */
	async archiveInactive(): Promise<{ archived: SessionInfo[]; failed: Array<{ id: string; error: string }> }> {
		return await hubStore.archiveInactive.apply(this, arguments as any);
	}

	async listArchived(): Promise<StoredSessionInfo[]> {
		return await hubStore.listArchived.apply(this, arguments as any);
	}

	async listTrash(): Promise<StoredSessionInfo[]> {
		return await hubStore.listTrash.apply(this, arguments as any);
	}

	async restoreArchived(id: string): Promise<SessionInfo> {
		return await hubStore.restoreArchived.apply(this, arguments as any);
	}

	async restoreTrash(id: string): Promise<SessionInfo> {
		return await hubStore.restoreTrash.apply(this, arguments as any);
	}

	async purgeArchived(id: string): Promise<void> {
		return await hubStore.purgeArchived.apply(this, arguments as any);
	}

	async purgeTrash(id: string): Promise<void> {
		return await hubStore.purgeTrash.apply(this, arguments as any);
	}

	/**
	 * Tell every live session socket that the daemon is being replaced. Called on
	 * the restart signal before shutdown, so the client can show `restarting`
	 * instead of having to infer it from a bare socket close.
	 */
	announceRestart(): void {
		hubLive.announceRestart.apply(this, arguments as any);
	}

	async shutdown(): Promise<void> {
		return await hubLive.shutdown.apply(this, arguments as any);
	}

	// ---------------------------------------------------------------- control

	async snapshot(
		id: string,
		limit = WINDOW_ENTRIES,
		since?: string,
	): Promise<{ info: SessionInfo; entries: unknown[]; leafId: string | null; more: boolean; covered: string[] }> {
		return await hubControl.snapshot.apply(this, arguments as any);
	}

	/**
	 * Provisional transcript straight off the JSONL tail, before the child has
	 * booted. Returns `null` for an already-live session (nothing to wait for).
	 * Never throws on a broken file: an unreadable tail yields empty entries.
	 */
	async provisional(
		id: string,
		limit = WINDOW_ENTRIES,
		maxBytes = WINDOW_BYTES,
	): Promise<{ info: SessionInfo; entries: unknown[]; leafId: string | null; more: boolean } | null> {
		return await hubControl.provisional.apply(this, arguments as any);
	}

	/**
	 * One window of entries immediately before `before`, read from the JSONL while
	 * the live session keeps running. `more` says whether older entries remain.
	 */
	async earlier(id: string, before: string, limit = WINDOW_ENTRIES): Promise<{ entries: unknown[]; more: boolean }> {
		return await hubControl.earlier.apply(this, arguments as any);
	}

	private async sessionPath(id: string): Promise<string | undefined> {
		return await hubControl.sessionPath.apply(this, arguments as any);
	}

	/**
	 * `streamingBehavior` is additive, not a mode switch: when Pi is idle it still
	 * starts a normal turn, when busy it steers/follows the run. Always using
	 * `prompt` (never RPC `steer`) also keeps extension commands executeable and
	 * means a message sent in the settle race starts a turn instead of sitting in
	 * Pi's steering queue until some later prompt happens to drain it.
	 */
	async prompt(id: string, text: string, streamingBehavior?: "steer" | "followUp", images?: unknown): Promise<void> {
		return await hubControl.prompt.apply(this, arguments as any);
	}

	/**
	 * Plain-text steer. It is `prompt` + `streamingBehavior: "steer"`, not RPC
	 * `steer`: that command only queues, so a steer that arrives while Pi is idle
	 * would never run, and the hub would stay "busy" forever because no
	 * `agent_start`/`agent_settled` ever follows.
	 */
	async steer(id: string, text: string, images?: unknown): Promise<void> {
		return await hubControl.steer.apply(this, arguments as any);
	}

	/**
	 * Write one non-image attachment under the logical session's upload dir and
	 * return the absolute path the prompt should mention. Kept across stop/attach;
	 * cleared on `/new`, archive and delete.
	 */
	async uploadFile(id: string, name: string, bytes: Buffer): Promise<{ path: string; name: string; size: number }> {
		return await hubControl.uploadFile.apply(this, arguments as any);
	}

	/**
	 * `clear_queue`: drop every queued steering/follow-up message and return the
	 * texts. One call clears both lists (RPC semantics); the client restores them
	 * into the composer and never sends them automatically.
	 */
	async clearQueue(id: string): Promise<{ steering: string[]; followUp: string[] }> {
		return await hubControl.clearQueue.apply(this, arguments as any);
	}

	/**
	 * Run one `!`/`!!` command through Pi's RPC `bash`. The caller-supplied id is
	 * repeated on every `bash_execution_update`, so the client can stream into the
	 * card it already painted without the hub parsing events.
	 *
	 * One bash at a time per session (the TUI guard); output is left to the event
	 * stream and the final result, never buffered here.
	 */
	async bash(id: string, bashId: string, command: string, excludeFromContext: boolean): Promise<BashResult> {
		return await hubControl.bash.apply(this, arguments as any);
	}

	/** Effective per-session command policy (resolved at attach). */
	policy(id: string): CommandPolicy {
		return hubControl.policy.apply(this, arguments as any);
	}

	/**
	 * Soft refresh (`pixip refresh`, SIGHUP, `POST /api/refresh`): re-read the
	 * session index, re-resolve the command policy for every live session and
	 * re-send it, then refresh the list sockets. Children, sockets and in-flight
	 * turns are untouched.
	 *
	 * Two-phase on purpose: if any session's config is malformed, the refresh fails
	 * before a single policy is swapped, so a bad edit cannot half-apply.
	 */
	async reload(): Promise<{ sessions: number; policy: number }> {
		return await hubControl.reload.apply(this, arguments as any);
	}

	async abort(id: string): Promise<void> {
		return await hubControl.abort.apply(this, arguments as any);
	}

	async models(id: string): Promise<{ models: ModelSummary[]; current: string | null }> {
		return await hubSession.models.apply(this, arguments as any);
	}

	async setModel(id: string, provider: string, modelId: string): Promise<void> {
		return await hubSession.setModel.apply(this, arguments as any);
	}

	/** `get_commands`: extension commands, prompt templates and skills for this child. */
	async commands(id: string): Promise<DynamicCommand[]> {
		return await hubSession.commands.apply(this, arguments as any);
	}

	async thinkingLevels(id: string): Promise<{ levels: string[]; current: string }> {
		return await hubSession.thinkingLevels.apply(this, arguments as any);
	}

	async setThinking(id: string, level: string): Promise<void> {
		return await hubSession.setThinking.apply(this, arguments as any);
	}

	/** `/thinking <level>`: resolve against the levels Pi reports, then set. */
	async setThinkingQuery(id: string, query: string): Promise<void> {
		return await hubSession.setThinkingQuery.apply(this, arguments as any);
	}

	/** `/model <query>`: exact provider/id, exact id, then a unique suffix. */
	async setModelQuery(id: string, query: string): Promise<void> {
		return await hubSession.setModelQuery.apply(this, arguments as any);
	}

	/** `/name <name>`: Pi appends the rename and emits `session_info_changed`. */
	async setName(id: string, name: string, source: NameSource = "manual"): Promise<void> {
		return await hubSession.setName.apply(this, arguments as any);
	}

	/**
	 * First-prompt label: ask a one-shot child with no session/tools/extensions,
	 * then set the name only if the session is still unnamed. The real prompt has
	 * already been dispatched; nothing here is on its critical path.
	 */
	private async autoLabel(live: LiveSession, prompt: string, retry = false): Promise<void> {
		return await hubSession.autoLabel.apply(this, arguments as any);
	}

	/** Configured override, then the live session's own model. */
	private async resolveTitleModel(live: LiveSession): Promise<string | undefined> {
		return await hubSession.resolveTitleModel.apply(this, arguments as any);
	}

	private async runTitlePi(live: LiveSession, prompt: string, model?: string): Promise<string> {
		return await hubSession.runTitlePi.apply(this, arguments as any);
	}

	/** `/compact [instructions]`: manual compaction; the client resnapshots after. */
	async compact(id: string, instructions?: string): Promise<void> {
		return await hubSession.compact.apply(this, arguments as any);
	}

	/** `/copy`: Pi's own last assistant text, not a client-side reconstruction. */
	async lastAssistantText(id: string): Promise<string | null> {
		return await hubSession.lastAssistantText.apply(this, arguments as any);
	}

	/** Read-only session tree for `/tree` (RPC `get_tree`). */
	async tree(id: string): Promise<{ tree: unknown[]; leafId: string | null }> {
		return await hubSession.tree.apply(this, arguments as any);
	}

	/**
	 * `/fork <entryId>`: fork from a user message. Pi allocates the new session id,
	 * so the live entry is re-keyed exactly like `/new`; a cancelled fork is not an
	 * error.
	 */
	async fork(id: string, entryId: string): Promise<{ text: string | null; cancelled: boolean }> {
		return await hubSession.fork.apply(this, arguments as any);
	}

	/** `/clone`: duplicate the active branch; same re-key path as `/fork`. */
	async clone(id: string): Promise<{ cancelled: boolean }> {
		return await hubSession.clone.apply(this, arguments as any);
	}

	/**
	 * `/import <path>`: copy a JSONL into `<data-dir>/sessions/` (header id and cwd
	 * untouched, source never modified), index it as its own logical session and
	 * switch the live child to it.
	 */
	async importSession(id: string, sourcePath: string): Promise<{ info: SessionInfo; cancelled: boolean }> {
		return await hubSession.importSession.apply(this, arguments as any);
	}

	private exportsDir(): string {
		return hubSession.exportsDir.apply(this, arguments as any);
	}

	private uploadsRoot(): string {
		return hubStore.uploadsRoot.apply(this, arguments as any);
	}

	private uploadsDir(logicalId: string): string {
		return hubStore.uploadsDir.apply(this, arguments as any);
	}

	/** Best-effort: a missing upload dir is the normal case, a failure is logged. */
	private async clearUploads(logicalId?: string): Promise<void> {
		return await hubStore.clearUploads.apply(this, arguments as any);
	}

	/** `/export`: HTML under `<data-dir>/exports`, served by the HTTP route. */
	async exportHtml(id: string): Promise<string> {
		return await hubSession.exportHtml.apply(this, arguments as any);
	}

	/** Last exported HTML for this session, exporting on demand (fresh daemon). */
	async exportedHtml(id: string): Promise<string> {
		return await hubSession.exportedHtml.apply(this, arguments as any);
	}

	/** Whatever file Pi currently has this session open on (for JSONL export). */
	async sessionFile(id: string): Promise<string | undefined> {
		return await hubSession.sessionFile.apply(this, arguments as any);
	}

	/**
	 * `/new`: a fresh session in the same child (TUI behaviour). Pi allocates the
	 * new id, so the live entry, the socket's active id and the index `piIds` are
	 * re-keyed; subscribers keep their socket and are told to follow.
	 */
	async newSession(id: string): Promise<SessionInfo> {
		return await hubSession.newSession.apply(this, arguments as any);
	}

	/**
	 * Follow the same live entry to whatever Pi id `get_state` reports now. The
	 * one re-key path for `/new`, `/fork`, `/clone` and `/import`: mutate the
	 * info in place (the child's `onRecord` closure holds the reference), move the
	 * map entry, append the id to the index and tell every socket to follow.
	 */
	private async rekeyFromState(live: LiveSession): Promise<SessionInfo> {
		return await hubSession.rekeyFromState.apply(this, arguments as any);
	}

	/** Follow a session to a new Pi id (registered by the socket layer). */
	onRekey(listener: (from: string, info: SessionInfo) => void): () => void {
		return hubSession.onRekey.apply(this, arguments as any);
	}

	/** Answer an extension dialog (`ctx.ui.confirm` and friends) from the phone. */
	uiResponse(id: string, requestId: string, fields: Record<string, unknown>): void {
		hubSession.uiResponse.apply(this, arguments as any);
	}

	/**
	 * Cached fire-and-forget addon UI, in render order: aboveEditor widgets,
	 * status entries, then belowEditor widgets. Frames stay verbatim; the client
	 * has one rendering path for live and replayed requests.
	 */
	addonUiFrames(id: string): string[] {
		return hubSession.addonUiFrames.apply(this, arguments as any);
	}

	subscribe(id: string, subscriber: Subscriber): () => void {
		return hubSession.subscribe.apply(this, arguments as any);
	}

	// ----------------------------------------------------------------- spawn

	private async spawn(input: {
		cwd: string;
		args: string[];
		logicalId?: string;
		createdAt?: string;
	}): Promise<SessionInfo> {
		return await hubLive.spawn.apply(this, arguments as any);
	}

	// --------------------------------------------------------------- records

	private onRecord(info: SessionInfo, raw: string, record: unknown): void {
		hubLive.onRecord.apply(this, arguments as any);
	}

	/**
	 * Cache select/confirm/input/editor until answered. Unlike status/widget
	 * records, these are questions: the child is blocked until one response
	 * arrives, so they must survive a browser reload or background reconnect.
	 */
	private cacheBlockingUi(live: LiveSession, request: { id?: unknown; method?: string }, raw: string): void {
		hubLive.cacheBlockingUi.apply(this, arguments as any);
	}

	private armPendingUiTimers(live: LiveSession): void {
		hubLive.armPendingUiTimers.apply(this, arguments as any);
	}

	private armPendingUiTimer(live: LiveSession, pending: PendingUiRequest): void {
		hubLive.armPendingUiTimer.apply(this, arguments as any);
	}

	private clearPendingUi(live: LiveSession, id?: string): void {
		hubLive.clearPendingUi.apply(this, arguments as any);
	}

	private clearPendingUiTimer(pending: PendingUiRequest): void {
		hubLive.clearPendingUiTimer.apply(this, arguments as any);
	}

	private cacheAddonUi(
		live: LiveSession,
		request: {
			method?: string;
			statusKey?: string;
			statusText?: unknown;
			widgetKey?: string;
			widgetLines?: unknown;
			widgetPlacement?: string;
		},
		raw: string,
	): void {
		hubLive.cacheAddonUi.apply(this, arguments as any);
	}

	private pendingSession(info: SessionInfo): LiveSession | undefined {
		return hubLive.pendingSession.apply(this, arguments as any);
	}

	// ---------------------------------------------------------------- footer

	/**
	 * The TUI footer, as data: cwd (with branch and session name), usage totals,
	 * context usage, and the model/thinking pair. Formatting lives in the client so
	 * this stays a thin passthrough of `get_session_stats` + `get_state`.
	 */
	async footer(id: string): Promise<FooterData> {
		return await hubLive.footer.apply(this, arguments as any);
	}

	async sendFooter(live: LiveSession): Promise<void> {
		return await hubLive.sendFooter.apply(this, arguments as any);
	}

	private scheduleFooter(live: LiveSession): void {
		hubLive.scheduleFooter.apply(this, arguments as any);
	}

	private async gitBranch(cwd: string): Promise<string | undefined> {
		return await hubStore.gitBranch.apply(this, arguments as any);
	}

	// ------------------------------------------------------------ session index

	private async readIndex(): Promise<SessionIndexRecord[]> {
		return await hubStore.readIndex.apply(this, arguments as any);
	}

	private async findRecord(id: string): Promise<SessionIndexRecord | undefined> {
		return await hubStore.findRecord.apply(this, arguments as any);
	}

	private async upsertIndex(
		info: SessionInfo,
		logicalId: string,
		createdAt?: string,
		nameSource?: NameSource,
	): Promise<void> {
		return await hubStore.upsertIndex.apply(this, arguments as any);
	}

	/** Archive/trash one session; shared by single, bulk and delete paths. */
	private async storeSession(
		id: string,
		root: string,
	): Promise<{ info: SessionInfo; record: SessionIndexRecord; dir: string }> {
		return await hubStore.storeSession.apply(this, arguments as any);
	}

	private findLive(id: string): LiveSession | undefined {
		return hubStore.findLive.apply(this, arguments as any);
	}

	/** Find the logical session by Pi id or logical id, and every JSONL it owns. */
	private async resolveTarget(id: string): Promise<SessionTarget> {
		return await hubStore.resolveTarget.apply(this, arguments as any);
	}

	private async removeRecord(record: SessionIndexRecord): Promise<void> {
		return await hubStore.removeRecord.apply(this, arguments as any);
	}

	private async putRecord(record: SessionIndexRecord): Promise<void> {
		return await hubStore.putRecord.apply(this, arguments as any);
	}

	private async moveSessionFiles(files: string[], dir: string): Promise<Array<{ original: string; stored: string }>> {
		return await hubStore.moveSessionFiles.apply(this, arguments as any);
	}

	private async rollbackFiles(moved: Array<{ original: string; stored: string }>, dir: string): Promise<void> {
		return await hubStore.rollbackFiles.apply(this, arguments as any);
	}

	private async restoreStored(root: string, id: string): Promise<SessionInfo> {
		return await hubStore.restoreStored.apply(this, arguments as any);
	}

	private async listStored(root: string, kind: "archive" | "trash"): Promise<StoredSessionInfo[]> {
		return await hubStore.listStored.apply(this, arguments as any);
	}

	private async findStored(
		root: string,
		id: string,
	): Promise<{ dir: string; record: StoredSessionRecord } | undefined> {
		return await hubStore.findStored.apply(this, arguments as any);
	}

	private async readStoredRecord(dir: string): Promise<StoredSessionRecord | undefined> {
		return await hubStore.readStoredRecord.apply(this, arguments as any);
	}

	private async purgeTrashOnStart(): Promise<void> {
		return await hubStore.purgeTrashOnStart.apply(this, arguments as any);
	}

	private async broadcastSessions(): Promise<void> {
		return await hubStore.broadcastSessions.apply(this, arguments as any);
	}

	/** Read-modify-write serialized behind `indexWrite`; atomic on disk. */
	private mutateIndex(mutate: (records: SessionIndexRecord[]) => SessionIndexRecord[]): Promise<void> {
		return hubStore.mutateIndex.apply(this, arguments as any);
	}

	/**
	 * Names live in the JSONL once it exists, but `nameSource` is index-owned:
	 * write both so a restart knows an auto label from a manual rename.
	 */
	private async persistName(live: LiveSession): Promise<void> {
		return await hubStore.persistName.apply(this, arguments as any);
	}

	// --------------------------------------------------------------- plumbing

	private require(id: string): LiveSession {
		return hubLive.require.apply(this, arguments as any);
	}

	private broadcast(live: LiveSession, frame: string, key?: string): void {
		hubLive.broadcast.apply(this, arguments as any);
	}

	private emitStatus(live: LiveSession): void {
		hubLive.emitStatus.apply(this, arguments as any);
	}

	/** Fresh `sessions` frame to the list sockets after a soft refresh. */
	private broadcastList(infos: SessionInfo[]): void {
		hubLive.broadcastList.apply(this, arguments as any);
	}

	/**
	 * Activity bookkeeping only. The run state belongs to Pi's lifecycle events:
	 * inventing "busy" here latched sessions busy for commands that never start a
	 * run (RPC `steer` while idle, extension commands handled locally), and no
	 * `agent_settled` ever arrived to clear it.
	 */
	private touch(live: LiveSession): void {
		hubLive.touch.apply(this, arguments as any);
	}

	private scheduleIdle(live: LiveSession): void {
		hubLive.scheduleIdle.apply(this, arguments as any);
	}

	private clearIdle(live: LiveSession): void {
		hubLive.clearIdle.apply(this, arguments as any);
	}

	private async scan(): Promise<Array<{ header: SessionHeader; path: string }>> {
		return await hubStore.scan.apply(this, arguments as any);
	}

	private async header(path: string): Promise<SessionHeader | undefined> {
		return await hubStore.header.apply(this, arguments as any);
	}
}

export {
	ENTRY_TEXT_LIMIT,
	WINDOW_BYTES,
	WINDOW_ENTRIES,
	moveFile,
	parseEntries,
	readFromEnd,
	readHead,
	truncateEntries,
	uniquePath,
	coverageKeys,
} from "./jsonl.ts";
export type {
	NameSource,
	SessionHeader,
	SessionIndexRecord,
	StoredSessionInfo,
	StoredSessionRecord,
	SessionTarget,
} from "./sessionIndex.ts";
export type { SessionInfo, SessionState } from "./wire.ts";
