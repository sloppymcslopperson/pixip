import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, normalize } from "node:path";

import { WebSocketServer, type WebSocket } from "ws";

import { createDirectory, DirError, listDirectories } from "./dirs.ts";
import { INBOX_PURPOSES, InboxError, type InboxFilter, type InboxPurpose } from "./inbox.ts";
import { ReportError } from "./inboxReport.ts";
import { detectImageMime, MAX_UPLOAD_BYTES, safeUploadName } from "./attachments.ts";
import { coverageKeys, Hub } from "./hub.ts";
import {
	frameBash,
	frameBashError,
	frameClone,
	frameCommands,
	frameCopy,
	frameEntry,
	frameError,
	frameExport,
	frameFork,
	frameHello,
	frameHistory,
	frameImport,
	frameInbox,
	frameLiveThinking,
	frameModels,
	frameNotice,
	frameOpened,
	framePolicy,
	frameQueue,
	frameReask,
	frameSnapshot,
	frameThinking,
	frameTree,
	WIRE_VERSION,
} from "./wire.ts";
import type { SessionInfo } from "./wire.ts";
import type { ReloadBlocker, ReloadChildResult, ReloadCode, ReloadReport } from "./reload.ts";
import {
	formatPauseReport,
	pauseTargets,
	resumePaused,
	steerPause,
	PAUSE_WAIT_MS,
	type PauseResumeReport,
	type PauseTarget,
} from "./reload/pause.ts";
import { normalizeWorktreeRequest } from "./worktree.ts";

export interface ServerOptions {
	host: string;
	port: number;
	hub: Hub;
	clientDir: string;
	log: (message: string) => void;
	/** Re-read client assets per request, so CSS/JS edits need no restart. */
	dev?: boolean;
	/** Replace the daemon through the detached restart helper; receives the pause plan. */
	restart?: (pause?: PauseTarget[]) => Promise<void>;
	/** In-place daemon-code reload, supplied by the CLI entry. */
	reloadCode?: ReloadCode;
	/** How long a pause request waits for its targets (tests shorten this). */
	pauseWaitMs?: number;
	/** Optional `--watch`: cancel a deferred reload from the browser card. */
	watchCancel?: () => void;
}

/** The swappable half of the server: a new generation replaces this object. */
export interface ServerImpl {
	handleHttp: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
	handleSocket: (ws: WebSocket, url: URL) => Promise<void>;
	refresh: () => Promise<RefreshReport>;
	reload: (pause?: PauseTarget[]) => Promise<ReloadReport>;
}

export interface RunningServer {
	url: string;
	/** Soft refresh: re-read assets and the hub's caches; never touches children. */
	refresh: () => Promise<RefreshReport>;
	/** Daemon-wide `/reload`: gate, assets/policy swap, then every live child. */
	reload: (pause?: PauseTarget[]) => Promise<ReloadReport>;
	/** Publish the pause/resume outcome for the client that reconnects after a restart. */
	setPauseResult: (report: PauseResumeReport) => void;
	/** Send one ephemeral frame to every connected socket (`--watch` notices). */
	broadcast: (frame: string) => void;
	/** Swap a prepared module generation; the old one stays available for rollback. */
	applyGeneration: (next: { hub: any; server: any }) => void;
	/** Put a previous generation back after a failed swap. */
	rollbackGeneration: (previous: { hub: any; server: any }) => void;
	close: () => Promise<void>;
}

export interface RefreshReport {
	reloaded: string[];
	reloads: number;
}

interface ServerState {
	/** Mutable asset map: a soft refresh swaps the whole thing. */
	assets: Map<string, Buffer>;
	startedAt: number;
	reloads: number;
	/** Browser-only capability for the user-initiated `/reload` control frame. */
	nonce: string;
	/** Read at call time so an open listener runs the current generation. */
	impl: ServerImpl;
	/** One reload at a time; reset when the promise settles. */
	reloading?: Promise<ReloadReport>;
	/** Broadcast to every connected socket, used by the reload notice. */
	broadcast: (frame: string) => void;
	/** Browser-only `/pixup-restart`: one replacement at a time. */
	restart?: (pause?: PauseTarget[]) => Promise<void>;
	restarting: boolean;
	/** A paused reload that timed out; a later cancel can still resume its targets. */
	pausePlan?: PauseTarget[];
	/** Survives the browser reconnect so the client can paint one ephemeral row. */
	pauseResult?: PauseResumeReport;
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/** Compare IPv4-mapped IPv6 forms with their plain IPv4 spelling. */
function normalizeAddress(address: string): string {
	const value = address.trim().toLowerCase();
	return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

/** Inbox auth seam: off when no token is configured, exact bearer match otherwise. */
function inboxAuthorized(req: IncomingMessage, token: string | undefined): boolean {
	if (!token) return true;
	const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
	if (!match?.[1]) return false;
	const presented = Buffer.from(match[1]);
	const expected = Buffer.from(token);
	return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const REPORT_CSP =
	"default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; " +
	"script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; connect-src 'none'; media-src 'none'";

/** The refresh endpoint changes server state, so only local peers may call it. */
export function isLoopback(req: IncomingMessage, host: string): boolean {
	const address = req.socket.remoteAddress ?? "";
	if (LOOPBACK.test(address)) return true;
	// A client reaching a concrete bind address presents that address locally;
	// the wildcard is not an address any peer can present.
	const bind = normalizeAddress(host);
	if (!bind || WILDCARD_HOSTS.has(bind)) return false;
	return normalizeAddress(address) === bind;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

/** Subscribe-to-snapshot buffer caps; beyond this the cursor path recovers. */
export const LIVE_BUFFER_BYTES = 2 * 1024 * 1024;
export const LIVE_BUFFER_FRAMES = 2000;

interface SnapshotReply {
	info: SessionInfo;
	entries: unknown[];
	leafId: string | null;
	more: boolean;
	covered: string[];
	resume: boolean;
}

/**
 * Ask for the delta after `since`. A rejected cursor falls back to the bounded
 * JSONL window, never to Pi's full history: that is the reconnect cost this
 * path exists to avoid.
 */
async function requestSnapshot(
	hub: Hub,
	id: string,
	since: string | undefined,
	log: (message: string) => void,
	piWindow = false,
): Promise<SnapshotReply> {
	if (!since && piWindow) {
		// No JSONL window exists yet (a brand-new live session, or a file that
		// has not been flushed). Ask Pi once, still bounded by `snapshot`.
		return { ...(await hub.snapshot(id, undefined, undefined)), resume: false };
	}
	if (since) {
		try {
			return { ...(await hub.snapshot(id, undefined, since)), resume: true };
		} catch (error) {
			log(`resume cursor ${since} rejected (${(error as Error).message}); sending the bounded window`);
		}
	}
	const window = await hub.window(id);
	return { ...window, covered: coverageKeys(window.entries), resume: false };
}

/**
 * Build the swappable server surface. A new `src/server.ts` generation exposes
 * this same factory, and `applyGeneration` installs its result on the live
 * listener without restarting the daemon.
 */
export function createImpl(
	hub: Hub,
	state: ServerState,
	options: ServerOptions,
	broadcast: (frame: string) => void,
): ServerImpl {
	return {
		handleHttp: (req, res) => handleHttp(req, res, hub, state, options.log, options),
		handleSocket: (ws, url) => handleSocket(ws, url, hub, options.log, state, options),
		refresh: async () => {
			// Hub caches first (policy is re-resolved for live sessions); only then
			// swap assets, so a bad config leaves the running daemon as it was.
			const result = await hub.reload();
			state.assets = await loadAssets(options.clientDir);
			state.reloads += 1;
			options.log(
				`soft refresh: assets, config (${result.policy} session(s)), index (${result.sessions} session(s)), commands`,
			);
			return { reloaded: ["assets", "config", "index", "commands"], reloads: state.reloads };
		},
		reload: (pause?: PauseTarget[]) =>
			(state.reloading ??= runReload(hub, state, options, broadcast, pause).finally(() => {
				state.reloading = undefined;
			})),
	};
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
	const { hub } = options;
	const clients = new Set<WebSocket>();
	const broadcast = (frame: string) => {
		for (const client of clients) {
			if (client.readyState === client.OPEN) client.send(frame);
		}
	};
	const state = {
		assets: await loadAssets(options.clientDir),
		startedAt: Date.now(),
		reloads: 0,
		restarting: false,
		...(options.restart ? { restart: options.restart } : {}),
		nonce: randomBytes(16).toString("hex"),
		broadcast,
	} as ServerState;
	state.impl = createImpl(hub, state, options, broadcast);
	const wss = new WebSocketServer({ noServer: true });

	const server = createServer((req, res) => {
		void state.impl.handleHttp(req, res);
	});

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== "/ws") {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			clients.add(ws);
			ws.on("close", () => clients.delete(ws));
			void state.impl.handleSocket(ws, url);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => resolve());
	});

	const address = server.address();
	const port = typeof address === "object" && address ? address.port : options.port;
	const applyGeneration = (next: { hub: any; server: any }) => {
		Object.setPrototypeOf(hub, next.hub.Hub.prototype);
		state.impl = next.server.createImpl(hub, state, options, broadcast);
	};
	return {
		url: `http://${options.host}:${port}/`,
		refresh: () => state.impl.refresh(),
		reload: (pause?: PauseTarget[]) => state.impl.reload(pause),
		setPauseResult: (report: PauseResumeReport) => {
			state.pauseResult = report;
		},
		broadcast,
		applyGeneration,
		rollbackGeneration: applyGeneration,
		close: async () => {
			for (const client of wss.clients) client.close();
			wss.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function handleHttp(
	req: IncomingMessage,
	res: ServerResponse,
	hub: Hub,
	state: ServerState,
	log: (message: string) => void,
	options: ServerOptions,
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	const send = (status: number, body: string | Buffer, type = "application/json; charset=utf-8") => {
		res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
		res.end(body);
	};

	try {
		// Dev-only fixture for the A2UI panel path: the client requests it from
		// `/?panel=fixture`, and the payload then travels the normal
		// extension_ui_request path. Production never exposes this route.
		if (req.method === "GET" && options.dev && url.pathname === "/api/dev/panel-fixture") {
			try {
				const requested = url.searchParams.get("fixture");
				const fixtureName =
					requested === "long"
						? "a2ui-panel-long.json"
						: requested === "tabs"
							? "a2ui-panel-tabs.json"
							: requested === "questionnaire"
								? "a2ui-questionnaire.json"
								: "a2ui-panel.json";
				const fixture = await readFile(join(options.clientDir, "..", "..", "test", "fixtures", fixtureName));
				send(200, fixture, CONTENT_TYPES[".json"]);
			} catch {
				send(404, JSON.stringify({ error: "not found" }));
			}
			return;
		}
		if (req.method === "GET" && url.pathname === "/health") {
			send(
				200,
				JSON.stringify({
					ok: true,
					wire: WIRE_VERSION,
					pid: process.pid,
					startedAt: state.startedAt,
					reloads: state.reloads,
					generation: options.reloadCode?.generation ?? 0,
					...(state.pauseResult ? { pauseResult: state.pauseResult } : {}),
				}),
			);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/refresh") {
			if (!isLoopback(req, options.host)) {
				log(`refresh refused from non-loopback peer ${req.socket.remoteAddress ?? "?"}`);
				send(403, JSON.stringify({ error: "refresh is loopback-only" }));
				return;
			}
			const report = await state.impl.refresh();
			send(200, JSON.stringify({ ok: true, ...report }));
			return;
		}
		const reportMatch = /^\/reports\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
		if (req.method === "GET" && reportMatch?.[1]) {
			const name = decodeURIComponent(reportMatch[1]);
			const rest = reportMatch[2];
			if (rest === undefined) {
				res.writeHead(301, { location: `${url.pathname}/${url.search}`, "cache-control": "no-store" });
				res.end();
				return;
			}
			const asset = rest === "" ? undefined : decodeURIComponent(rest);
			if (asset && asset.includes("/")) {
				send(404, JSON.stringify({ error: "not found" }));
				return;
			}
			const file = await hub.reportStore.file(name, asset);
			const body = await readFile(file.path);
			res.writeHead(200, {
				"content-type": file.contentType,
				"content-length": body.length,
				"cache-control": "no-store",
				"content-security-policy": REPORT_CSP,
				"x-content-type-options": "nosniff",
				"referrer-policy": "no-referrer",
			});
			res.end(body);
			return;
		}
		if (url.pathname === "/api/inbox" || url.pathname.startsWith("/api/inbox/")) {
			if (!inboxAuthorized(req, hub.inboxToken)) {
				send(401, JSON.stringify({ error: "inbox token required" }));
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/inbox") {
				const filter: InboxFilter = {};
				if (url.searchParams.get("archived") === "1") filter.archived = true;
				if (url.searchParams.get("all") === "1") filter.all = true;
				const selected = url.searchParams.get("filter");
				if (selected === "unread" || selected === "read" || selected === "all") filter.filter = selected;
				const purpose = url.searchParams.get("purpose");
				if (purpose && (INBOX_PURPOSES as readonly string[]).includes(purpose)) {
					filter.purpose = purpose as InboxPurpose;
				}
				send(200, JSON.stringify(await hub.inboxList(filter)));
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/inbox") {
				const parsed = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
				if (typeof parsed["subject"] !== "string" || typeof parsed["body"] !== "string") {
					send(400, JSON.stringify({ error: "subject and body are required" }));
					return;
				}
				const purpose = parsed["purpose"];
				const message = await hub.inboxSend({
					subject: parsed["subject"],
					body: parsed["body"],
					purpose: typeof purpose === "string" ? (purpose as InboxPurpose) : "attention-needed",
					sessionId: typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : undefined,
					reportName: typeof parsed["reportName"] === "string" ? parsed["reportName"] : undefined,
				});
				send(200, JSON.stringify({ ok: true, message }));
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/inbox/reports") {
				const parsed = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
				send(200, JSON.stringify({ ok: true, report: await hub.inboxReport(parsed) }));
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/inbox/extension") {
				// The optional `pixip-inbox` extension reports on load so the dashboard can
				// hide an empty inbox that no agent can reach yet.
				send(200, JSON.stringify({ ok: true, announced: await hub.inboxAnnounce() }));
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/inbox/read-all") {
				send(200, JSON.stringify({ ok: true, read: await hub.inboxRead("all") }));
				return;
			}
			const inboxReadMatch = /^\/api\/inbox\/([^/]+)\/read$/.exec(url.pathname);
			if (req.method === "POST" && inboxReadMatch?.[1]) {
				send(200, JSON.stringify({ ok: true, read: await hub.inboxRead(decodeURIComponent(inboxReadMatch[1])) }));
				return;
			}
			const inboxArchiveMatch = /^\/api\/inbox\/([^/]+)\/archive$/.exec(url.pathname);
			if (req.method === "POST" && inboxArchiveMatch?.[1]) {
				await hub.inboxArchive(decodeURIComponent(inboxArchiveMatch[1]));
				send(200, JSON.stringify({ ok: true }));
				return;
			}
			const inboxRestoreMatch = /^\/api\/inbox\/([^/]+)\/restore$/.exec(url.pathname);
			if (req.method === "POST" && inboxRestoreMatch?.[1]) {
				await hub.inboxRestore(decodeURIComponent(inboxRestoreMatch[1]));
				send(200, JSON.stringify({ ok: true }));
				return;
			}
			const inboxDeleteMatch = /^\/api\/inbox\/([^/]+)$/.exec(url.pathname);
			if (req.method === "DELETE" && inboxDeleteMatch?.[1]) {
				await hub.inboxDelete(decodeURIComponent(inboxDeleteMatch[1]));
				send(200, JSON.stringify({ ok: true }));
				return;
			}
			send(404, JSON.stringify({ error: "not found" }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/info") {
			send(
				200,
				JSON.stringify({ ok: true, wire: WIRE_VERSION, defaultCwd: process.cwd(), home: process.env["HOME"] ?? "" }),
			);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/dirs") {
			send(200, JSON.stringify(await listDirectories(url.searchParams.get("path"), osHome())));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/dirs") {
			const body = await readBody(req);
			const parsed = JSON.parse(body || "{}") as { path?: string; name?: unknown };
			send(200, JSON.stringify(await createDirectory(parsed.path, parsed.name, osHome())));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/worktrees") {
			// Worktree management is a normal dashboard feature, not a host-local
			// admin verb: it must work when pixip is bound to a LAN/Tailscale address.
			const cwd = url.searchParams.get("cwd");
			if (!cwd) {
				send(400, JSON.stringify({ error: "cwd is required" }));
				return;
			}
			try {
				send(200, JSON.stringify(await hub.listWorktrees(cwd)));
			} catch (error) {
				send(400, JSON.stringify({ error: (error as Error).message }));
			}
			return;
		}
		if (req.method === "DELETE" && url.pathname === "/api/worktrees") {
			const parsed = JSON.parse((await readBody(req)) || "{}") as {
				cwd?: unknown;
				worktree?: { branch?: unknown };
				force?: unknown;
			};
			const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
			const branch = typeof parsed.worktree?.branch === "string" ? parsed.worktree.branch : "";
			if (!cwd || !branch) {
				send(400, JSON.stringify({ error: "cwd and worktree.branch are required" }));
				return;
			}
			const result = await hub.removeWorktree({ cwd, worktree: { branch }, force: parsed.force === true });
			if (result.removed) {
				send(200, JSON.stringify({ ok: true, worktree: result.worktree }));
				return;
			}
			const message =
				result.reason === "referenced"
					? "worktree still has sessions"
					: result.reason === "dirty"
						? "worktree has uncommitted changes"
						: "external worktree; pixip will not remove it";
			send(
				409,
				JSON.stringify({
					error: message,
					reason: result.reason,
					worktree: result.worktree,
					...(result.reason === "referenced" ? { sessions: result.sessions } : {}),
				}),
			);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/sessions") {
			send(200, JSON.stringify(await hub.list()));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/archived") {
			send(200, JSON.stringify(await hub.listArchived()));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/trash") {
			send(200, JSON.stringify(await hub.listTrash()));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/sessions") {
			const body = await readBody(req);
			const parsed = JSON.parse(body || "{}") as { cwd?: string; name?: string; worktree?: unknown };
			const cwd = parsed.cwd ?? process.cwd();
			const info = await hub.create(cwd, parsed.name, normalizeWorktreeRequest(parsed.worktree));
			send(200, JSON.stringify(info));
			return;
		}
		const uploadMatch = /^\/api\/sessions\/([^/]+)\/uploads$/.exec(url.pathname);
		if (req.method === "POST" && uploadMatch?.[1]) {
			const id = decodeURIComponent(uploadMatch[1]);
			const name = url.searchParams.get("name") ?? "file";
			const bytes = await readBinaryBody(req, MAX_UPLOAD_BYTES);
			const uploaded = await hub.uploadFile(id, name, bytes);
			send(200, JSON.stringify({ ok: true, ...uploaded }));
			return;
		}
		const filesMatch = /^\/api\/sessions\/([^/]+)\/files$/.exec(url.pathname);
		if (req.method === "GET" && filesMatch?.[1]) {
			const id = decodeURIComponent(filesMatch[1]);
			const filePath = url.searchParams.get("path") ?? "";
			if (!isAbsolute(filePath)) {
				send(400, JSON.stringify({ error: "path must be absolute" }));
				return;
			}
			if (!(await hub.sessionFile(id))) {
				send(404, JSON.stringify({ error: "unknown session" }));
				return;
			}
			let info;
			try {
				info = await stat(filePath);
			} catch {
				send(404, JSON.stringify({ error: "file not found" }));
				return;
			}
			if (!info.isFile()) {
				send(400, JSON.stringify({ error: "not a regular file" }));
				return;
			}
			if (info.size > MAX_UPLOAD_BYTES) {
				send(413, JSON.stringify({ error: "file is too large (max 100 MB)" }));
				return;
			}
			const mimeType = detectImageMime(await readFileHead(filePath));
			if (!mimeType) {
				send(415, JSON.stringify({ error: "not a supported image" }));
				return;
			}
			res.writeHead(200, {
				"content-type": mimeType,
				"content-length": info.size,
				"content-disposition": `attachment; filename="${safeUploadName(basename(filePath))}"`,
				"cache-control": "no-store",
			});
			const stream = createReadStream(filePath);
			stream.on("error", () => res.destroy());
			stream.pipe(res);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/sessions/archive-inactive") {
			const body = await readBody(req);
			const parsed = JSON.parse(body || "{}") as { ids?: unknown };
			const ids = Array.isArray(parsed.ids)
				? parsed.ids.filter((id): id is string => typeof id === "string")
				: undefined;
			const result = await hub.archiveInactive(ids);
			send(
				200,
				JSON.stringify({
					ok: true,
					archived: result.archived.length,
					failed: result.failed,
					sessions: result.archived,
				}),
			);
			return;
		}
		const protectMatch = /^\/api\/sessions\/([^/]+)\/protect$/.exec(url.pathname);
		if (req.method === "POST" && protectMatch?.[1]) {
			const body = await readBody(req);
			const parsed = JSON.parse(body || "{}") as { protected?: unknown; value?: unknown };
			const value = parsed.protected ?? parsed.value ?? true;
			const info = await hub.setProtected(decodeURIComponent(protectMatch[1]), value !== false);
			send(200, JSON.stringify({ ok: true, session: info }));
			return;
		}
		const archiveMatch = /^\/api\/sessions\/([^/]+)\/archive$/.exec(url.pathname);
		if (req.method === "POST" && archiveMatch?.[1]) {
			const info = await hub.archive(decodeURIComponent(archiveMatch[1]));
			send(200, JSON.stringify({ ok: true, session: info }));
			return;
		}
		const deleteMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
		if (req.method === "DELETE" && deleteMatch?.[1]) {
			const result = await hub.deleteSession(decodeURIComponent(deleteMatch[1]));
			send(
				200,
				JSON.stringify({
					ok: true,
					session: result.info,
					undo: { token: result.token, expiresAt: result.expiresAt },
				}),
			);
			return;
		}
		const archivedMatch = /^\/api\/archived\/([^/]+)$/.exec(url.pathname);
		if (req.method === "DELETE" && archivedMatch?.[1]) {
			await hub.purgeArchived(decodeURIComponent(archivedMatch[1]));
			send(200, JSON.stringify({ ok: true }));
			return;
		}
		const archivedRestoreMatch = /^\/api\/archived\/([^/]+)\/restore$/.exec(url.pathname);
		if (req.method === "POST" && archivedRestoreMatch?.[1]) {
			const info = await hub.restoreArchived(decodeURIComponent(archivedRestoreMatch[1]));
			send(200, JSON.stringify({ ok: true, session: info }));
			return;
		}
		const trashRestoreMatch = /^\/api\/trash\/([^/]+)\/restore$/.exec(url.pathname);
		if (req.method === "POST" && trashRestoreMatch?.[1]) {
			const info = await hub.restoreTrash(decodeURIComponent(trashRestoreMatch[1]));
			send(200, JSON.stringify({ ok: true, session: info }));
			return;
		}
		const trashMatch = /^\/api\/trash\/([^/]+)$/.exec(url.pathname);
		if (req.method === "DELETE" && trashMatch?.[1]) {
			await hub.purgeTrash(decodeURIComponent(trashMatch[1]));
			send(200, JSON.stringify({ ok: true }));
			return;
		}
		const stopMatch = /^\/api\/sessions\/([^/]+)\/stop$/.exec(url.pathname);
		if (req.method === "POST" && stopMatch?.[1]) {
			send(200, JSON.stringify(await hub.stop(decodeURIComponent(stopMatch[1]))));
			return;
		}

		// `/export` downloads (08): both formats are served as attachments. The
		// HTML is (re)written under `<data-dir>/exports`; the JSONL is the session
		// file itself, unmodified.
		const exportMatch = /^\/api\/sessions\/([^/]+)\/export\.(html|jsonl)$/.exec(url.pathname);
		if (req.method === "GET" && exportMatch?.[1] && exportMatch[2]) {
			const id = decodeURIComponent(exportMatch[1]);
			const format = exportMatch[2];
			const path = format === "html" ? await hub.exportedHtml(id) : await hub.sessionFile(id);
			if (!path) {
				send(404, JSON.stringify({ error: "not found" }));
				return;
			}
			let body: Buffer;
			try {
				body = await readFile(path);
			} catch {
				send(404, JSON.stringify({ error: "not found" }));
				return;
			}
			res.writeHead(200, {
				"content-type": format === "html" ? "text/html; charset=utf-8" : "application/x-ndjson",
				"content-disposition": `attachment; filename="${basename(path)}"`,
				"cache-control": "no-store",
			});
			res.end(body);
			return;
		}

		const assetPath = url.pathname === "/" ? "/index.html" : url.pathname;
		const normalized = normalize(assetPath).replace(/^(\.\.[/\\])+/, "");
		const asset = options.dev ? await readAsset(options.clientDir, normalized) : state.assets.get(normalized);
		if (!asset) {
			send(404, JSON.stringify({ error: "not found" }));
			return;
		}
		const body = normalized === "/index.html" ? injectReloadNonce(asset, state.nonce) : asset;
		send(200, body, CONTENT_TYPES[extname(normalized)] ?? "application/octet-stream");
	} catch (error) {
		const status =
			error instanceof DirError || error instanceof InboxError || error instanceof ReportError
				? error.status
				: error instanceof PayloadTooLargeError
					? 413
					: 500;
		log(`http error: ${(error as Error).message}`);
		send(status, JSON.stringify({ error: (error as Error).message }));
	}
}

function osHome(): string {
	return process.env["HOME"] ?? process.cwd();
}

async function handleSocket(
	ws: WebSocket,
	url: URL,
	hub: Hub,
	log: (message: string) => void,
	state: ServerState,
	options: ServerOptions,
): Promise<void> {
	const sessionId = url.searchParams.get("session");
	const send = (frame: string) => {
		if (ws.readyState === ws.OPEN) ws.send(frame);
	};

	if (!sessionId) {
		send(frameHello(await hub.list(), process.cwd(), process.env["HOME"] ?? ""));
		send(frameInbox(await hub.inboxSummary()));
		const unwatch = hub.watch((frame) => send(frame));
		ws.on("close", unwatch);
		ws.on("message", (data) => {
			void handleCommand(String(data), { id: null }, hub, send, log, state, options);
		});
		return;
	}

	const sessionKey = sessionId;
	// A session socket can be parked: the WebSocket stays open, but its session
	// subscription and list watcher are removed so a busy session sends nothing.
	let sessionSubs: Array<() => void> = [];
	let parked = false;
	let closed = false;
	let generation = 0;
	// The socket starts on the URL's id; an index-only session reattaches under a
	// fresh Pi id, and every later command must follow that id instead.
	const active: { id: string | null } = { id: sessionKey };
	const clearSubs = () => {
		for (const unsubscribe of sessionSubs) unsubscribe();
		sessionSubs = [];
	};
	// A `/new` in any tab re-keys the session; even a parked socket keeps this
	// listener so it can tell the client to invalidate and reconnect.
	const rekeyUnsub = hub.onRekey((from, info) => {
		if (active.id !== from) return;
		active.id = info.id;
		send(frameOpened(info, true));
	});
	ws.on("close", () => {
		closed = true;
		generation += 1;
		rekeyUnsub();
		clearSubs();
	});

	/** Attach (or re-attach) and send the snapshot; `wake` is a park resume. */
	async function attach(since: string | undefined, resuming: boolean, notifyOpened: boolean): Promise<void> {
		const gen = ++generation;
		clearSubs();
		try {
			const cursor = typeof since === "string" && since.length > 0 ? since : undefined;
			// A reconnect that carries a cursor already has a transcript: skip the
			// provisional repaint and resume from the durable entry cursor instead.
			// Otherwise paint the bounded JSONL window before the child boots.
			const base = !resuming && !cursor ? await hub.window(sessionKey) : null;
			if (gen !== generation || closed || parked) return;
			const hasBase = Boolean(base && (base.leafId !== null || base.entries.length > 0));
			if (hasBase && base) {
				// A stopped session is about to be attached; saying `starting` avoids a
				// flash of the wake card. A live green/yellow session keeps its real
				// state so the composer can be used immediately.
				const info = base.info.state === "stopped" ? { ...base.info, state: "starting" as const } : base.info;
				send(frameSnapshot(info, base.entries, base.leafId, base.more));
			}
			const info = await hub.attach(active.id ?? sessionKey);
			if (gen !== generation || closed || parked) return;
			active.id = info.id;
			// The index-only path lands on a new Pi id: tell the client before the
			// snapshot so its URL and session key keep pointing at this transcript.
			// A park/resume wake keeps the same key, so it sends no `opened`.
			if (notifyOpened && info.id !== sessionKey) send(frameOpened(info));
			// Policy is per session (cwd + data dir + CLI), so it goes on the session
			// socket, not on the list; the composer needs it before the first submit.
			send(framePolicy(hub.policy(info.id)));
			// Addon status/widgets are fire-and-forget: replay the current cache so a
			// late tab sees the same footer without waiting for the extension to emit.
			for (const frame of hub.addonUiFrames(info.id)) send(frame);

			// Subscribe *before* `get_entries` and buffer what the child emits in
			// between, so a client connecting mid-turn cannot miss the start of a
			// message. Records without an entry identity (status, UI dialogs) are
			// order-independent and go out immediately.
			const buffer: Array<{ frame: string; key: string; seq?: number }> = [];
			let bytes = 0;
			let overflowed = false;
			let buffering = true;
			sessionSubs.push(
				hub.subscribe(info.id, (frame, key, seq) => {
					if (!key || !buffering) {
						send(frame);
						return;
					}
					buffer.push({ frame, key, ...(seq !== undefined ? { seq } : {}) });
					bytes += frame.length;
					if (bytes > LIVE_BUFFER_BYTES || buffer.length > LIVE_BUFFER_FRAMES) {
						// Bounded recovery below: close the gap with the durable cursor
						// instead of holding an unbounded turn in memory.
						overflowed = true;
						buffer.length = 0;
						bytes = 0;
					}
				}),
			);
			sessionSubs.push(hub.watch((frame) => send(frame)));

			let resumeFrom = cursor ?? (hasBase ? (base?.leafId ?? undefined) : undefined);
			const piWindow = !cursor && !hasBase;
			for (let attempt = 0; ; attempt += 1) {
				const snapshot = await requestSnapshot(hub, info.id, resumeFrom, log, piWindow && attempt === 0);
				if (gen !== generation || closed || parked) return;
				if (hasBase && base) snapshot.covered = [...new Set([...coverageKeys(base.entries), ...snapshot.covered])];
				const more = snapshot.resume ? snapshot.more : Boolean((hasBase && base?.more) || snapshot.more);
				send(frameSnapshot(snapshot.info, snapshot.entries, snapshot.leafId, more, snapshot.resume));
				const covered = new Set(snapshot.covered);
				const deferredThinking: typeof buffer = [];
				// Non-thinking frames go first: a buffered `message_start` resets the
				// client's live thought, and the derived frame below restores it. Thinking
				// deltas are held back so they can be compared with the buffer sequence.
				for (const item of buffer) {
					if (covered.has(item.key)) continue;
					if (item.seq !== undefined) deferredThinking.push(item);
					else send(item.frame);
				}
				// Read after the non-thinking flush so a `message_end` that landed in the
				// buffer cannot be followed by a stale live-thought frame.
				const liveThought = hub.liveThinking(info.id);
				if (gen !== generation || closed || parked) return;
				if (liveThought && (liveThought.text.length > 0 || liveThought.active)) {
					send(frameLiveThinking(liveThought));
				}
				// Deltas at or below the derived sequence are already folded into its text.
				// With no live thought (for example after `message_end`) they are stale.
				if (liveThought) {
					for (const item of deferredThinking) {
						if (item.seq === undefined || item.seq <= liveThought.seq) continue;
						send(item.frame);
					}
				}
				buffer.length = 0;
				bytes = 0;
				const overflow = overflowed;
				overflowed = false;
				if (!overflow || attempt >= 2) break;
				// Overflowed while waiting: ask the cursor for exactly what was dropped.
				// With no leaf yet (empty session) the next pass takes a fresh window.
				resumeFrom = snapshot.leafId ?? undefined;
			}
			buffering = false;

			// Requests that timed out while this browser was away: offer the recorded
			// re-ask card without pretending Pi is still waiting.
			for (const request of await hub.pendingReasks(info.id)) {
				if (gen !== generation || closed || parked) return;
				send(frameReask(request));
			}

			void hub
				.footer(info.id)
				.then((footer) => {
					if (gen === generation && !closed) send(JSON.stringify({ t: "footer", footer }));
				})
				.catch(() => {
					// Detached between attach and footer: the status frame already says so.
				});

			// Discoverable commands for the `/` menu: fetched once per attach (the
			// client caches them) and off the snapshot path.
			void hub
				.commands(info.id)
				.then((commands) => {
					if (gen === generation && !closed) send(frameCommands(commands));
				})
				.catch(() => {
					// A child that just went away simply leaves the menu on the static catalog.
				});
		} catch (error) {
			if (gen === generation && !closed) send(frameError((error as Error).message));
		}
	}

	// Bind before the attach await: "load earlier" may arrive while the child
	// is still booting, and a listener added later would drop that frame.
	ws.on("message", (data) => {
		const raw = String(data);
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			void handleCommand(raw, active, hub, send, log, state, options);
			return;
		}
		if (message["t"] === "park") {
			if (closed || parked) return;
			parked = true;
			generation += 1;
			clearSubs();
			return;
		}
		if (message["t"] === "resume") {
			if (closed) return;
			parked = false;
			void attach(typeof message["since"] === "string" ? message["since"] : undefined, true, false);
			return;
		}
		if (parked) {
			send(frameError("socket is parked"));
			return;
		}
		void handleCommand(raw, active, hub, send, log, state, options);
	});

	const cursor = url.searchParams.get("since") ?? undefined;
	void attach(cursor, Boolean(cursor), true);
}

async function handleCommand(
	raw: string,
	active: { id: string | null },
	hub: Hub,
	send: (frame: string) => void,
	log: (message: string) => void,
	state: ServerState,
	options: ServerOptions,
): Promise<void> {
	let message: Record<string, unknown>;
	try {
		message = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		send(frameError("bad frame"));
		return;
	}

	const type = message["t"];
	const sessionId = active.id;
	try {
		switch (type) {
			case "create": {
				const cwd = typeof message["cwd"] === "string" ? message["cwd"] : process.cwd();
				const name = typeof message["name"] === "string" ? message["name"] : undefined;
				const worktree = normalizeWorktreeRequest(message["worktree"]);
				const info = await hub.create(cwd, name, worktree);
				send(frameOpened(info));
				return;
			}
			case "stop": {
				if (!sessionId) return;
				send(JSON.stringify({ t: "status", session: await hub.stop(sessionId) }));
				return;
			}
			case "reload": {
				const nonce = typeof message["nonce"] === "string" ? message["nonce"] : "";
				if (nonce.length === 0 || nonce !== state.nonce) {
					log("reload refused: missing or stale browser nonce");
					send(frameNotice("reload refused: this page has a stale nonce; reload the page and try again"));
					return;
				}
				const pause = message["pause"] === true;
				let plan: PauseTarget[] = [];
				if (pause) {
					const blockers = hub.reloadBlockers();
					if (blockers.length > 0) {
						plan = pauseTargets(blockers, await hub.list());
						const failed = await steerPause(hub, plan);
						if (failed.length > 0)
							log(`reload pause: could not steer ${failed.map((entry) => entry.name ?? entry.id).join(", ")}`);
						const remaining = await waitForPause(hub, plan, "reload", pauseWait(options));
						if (remaining.length > 0) {
							state.pausePlan = plan;
							const names = remaining.map((blocker) => `${blocker.name ?? blocker.id} (${blocker.reason})`).join(", ");
							const text = `reload paused: still busy after ${Math.round(pauseWait(options) / 1000)}s: ${names}`;
							log(text);
							send(
								frameNotice(text, {
									pause: true,
									status: "pause-timeout",
									pauseKind: "reload",
									blockers: remaining,
									paused: true,
								}),
							);
							return;
						}
					}
				}
				const report = await state.impl.reload(plan.length > 0 ? plan : undefined);
				if (!report.ok) {
					if (report.status === "refused" && report.blockers.length > 0) {
						send(
							frameNotice(report.message, {
								pause: true,
								status: "refused",
								pauseKind: "reload",
								blockers: report.blockers,
							}),
						);
					} else {
						send(frameNotice(report.message));
					}
				}
				return;
			}
			case "watch_cancel": {
				options.watchCancel?.();
				return;
			}
			case "pause_cancel": {
				const nonce = typeof message["nonce"] === "string" ? message["nonce"] : "";
				if (nonce.length === 0 || nonce !== state.nonce) {
					send(frameNotice("pause cancel refused: this page has a stale nonce; reload the page and try again"));
					return;
				}
				const mode = message["mode"] === "resume" ? "resume" : "keep";
				const plan = state.pausePlan ?? [];
				state.pausePlan = undefined;
				if (mode === "resume" && plan.length > 0) {
					const report = await resumePaused(hub, plan);
					log(formatPauseReport(report));
					state.broadcast(frameNotice(formatPauseReport(report), { pauseResult: true, ...report }));
				}
				return;
			}
			case "restart": {
				const nonce = typeof message["nonce"] === "string" ? message["nonce"] : "";
				if (nonce.length === 0 || nonce !== state.nonce) {
					log("restart refused: missing or stale browser nonce");
					send(frameNotice("restart refused: this page has a stale nonce; reload the page and try again"));
					return;
				}
				if (state.restarting) {
					send(frameNotice("restart already in progress", { restart: true, status: "refused" }));
					return;
				}
				const force = message["force"] === true;
				const pause = message["pause"] === true;
				const now = message["now"] === true;
				const blockers = hub.restartBlockers();
				if (blockers.length > 0 && !force) {
					const names = blockers.map((blocker) => `${blocker.name ?? blocker.id} (${blocker.reason})`).join(", ");
					const text = `restart refused: ${names}`;
					log(text);
					send(frameNotice(text, { restart: true, status: "refused", blockers }));
					return;
				}
				if (!state.restart) {
					send(frameNotice("restart is unavailable in this daemon", { restart: true, status: "refused" }));
					return;
				}
				let plan: PauseTarget[] = [];
				if (pause && blockers.length > 0) {
					plan = pauseTargets(blockers, await hub.list());
					const failed = await steerPause(hub, plan);
					if (failed.length > 0)
						log(`restart pause: could not steer ${failed.map((entry) => entry.name ?? entry.id).join(", ")}`);
					if (!now) {
						const remaining = await waitForPause(hub, plan, "restart", pauseWait(options));
						if (remaining.length > 0) {
							const names = remaining.map((blocker) => `${blocker.name ?? blocker.id} (${blocker.reason})`).join(", ");
							const text = `restart paused: still busy after ${Math.round(pauseWait(options) / 1000)}s: ${names}`;
							log(text);
							send(frameNotice(text, { restart: true, status: "pause-timeout", blockers: remaining, pause: true }));
							return;
						}
					}
				}
				state.restarting = true;
				const names = blockers.map((blocker) => blocker.name ?? blocker.id).join(", ");
				const text = force && blockers.length > 0 ? `restarting — interrupting ${names}` : "restarting…";
				log(text);
				send(frameNotice(text, { restart: true, status: "ok" }));
				await state.restart(plan.length > 0 ? plan : undefined);
				return;
			}
			default:
				break;
		}

		if (!sessionId) {
			send(frameError(`"${String(type)}" needs a session`));
			return;
		}
		switch (type) {
			case "prompt": {
				const behavior =
					message["streamingBehavior"] === "steer"
						? "steer"
						: message["streamingBehavior"] === "followUp"
							? "followUp"
							: undefined;
				await hub.prompt(sessionId, String(message["text"] ?? ""), behavior, message["images"]);
				break;
			}
			case "steer":
				await hub.steer(sessionId, String(message["text"] ?? ""), message["images"]);
				break;
			case "clear_queue": {
				const texts = await hub.clearQueue(sessionId);
				send(frameQueue(texts.steering, texts.followUp));
				break;
			}
			case "bash": {
				// The client owns the id: it paints the card optimistically and matches
				// verbatim `bash_execution_update` events by it.
				const bashId = typeof message["id"] === "string" ? message["id"] : "";
				const command = String(message["command"] ?? "");
				if (!bashId) {
					send(frameError('"bash" needs an id'));
					return;
				}
				try {
					const result = await hub.bash(sessionId, bashId, command, message["excludeFromContext"] === true);
					send(frameBash(bashId, command, message["excludeFromContext"] === true, result));
				} catch (error) {
					send(frameBashError(bashId, command, (error as Error).message));
				}
				return;
			}
			case "abort":
				await hub.abort(sessionId);
				break;
			case "entry": {
				const entryId = String(message["id"] ?? "");
				const entry = entryId ? await hub.entry(sessionId, entryId) : undefined;
				if (entry === undefined) send(frameEntry(entryId, null, "entry is not on disk yet"));
				else send(frameEntry(entryId, entry));
				return;
			}
			case "earlier": {
				const before = String(message["before"] ?? "");
				const window = await hub.earlier(sessionId, before);
				send(frameHistory(window.entries, window.more));
				break;
			}
			case "models": {
				const result = await hub.models(sessionId);
				send(frameModels(result.models, result.current));
				break;
			}
			case "set_model": {
				await hub.setModel(sessionId, String(message["provider"] ?? ""), String(message["modelId"] ?? ""));
				break;
			}
			case "thinking": {
				const result = await hub.thinkingLevels(sessionId);
				send(frameThinking(result.levels, result.current));
				break;
			}
			case "set_thinking": {
				await hub.setThinking(sessionId, String(message["level"] ?? "off"));
				break;
			}
			case "set_model_query":
				await hub.setModelQuery(sessionId, String(message["query"] ?? ""));
				break;
			case "set_thinking_query":
				await hub.setThinkingQuery(sessionId, String(message["query"] ?? ""));
				break;
			case "compact": {
				const raw = message["instructions"];
				const instructions = typeof raw === "string" && raw.trim() ? raw : undefined;
				await hub.compact(sessionId, instructions);
				break;
			}
			case "set_session_name":
				await hub.setName(sessionId, String(message["name"] ?? ""));
				break;
			case "new_session":
				// The rekey listener sends `opened`; the client answers with `resnapshot`.
				await hub.newSession(sessionId);
				break;
			case "copy":
				send(frameCopy(await hub.lastAssistantText(sessionId)));
				break;
			case "tree": {
				const result = await hub.tree(sessionId);
				send(frameTree(result.tree, result.leafId));
				break;
			}
			case "fork": {
				const result = await hub.fork(sessionId, String(message["entryId"] ?? ""));
				send(frameFork(result.text, result.cancelled));
				break;
			}
			case "clone": {
				const result = await hub.clone(sessionId);
				send(frameClone(result.cancelled));
				break;
			}
			case "import": {
				const result = await hub.importSession(sessionId, String(message["path"] ?? ""));
				send(frameImport(result.cancelled));
				break;
			}
			case "export": {
				await hub.exportHtml(sessionId);
				const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
				const jsonl = (await hub.sessionFile(sessionId)) ? `${base}/export.jsonl` : null;
				send(frameExport(`${base}/export.html`, jsonl));
				break;
			}
			case "resnapshot": {
				// A normal full snapshot, flagged so the client drops windows it
				// loaded before a compaction or a `/new`.
				const full = await hub.snapshot(sessionId);
				send(frameSnapshot(full.info, full.entries, full.leafId, full.more, false, true));
				break;
			}
			case "ui": {
				const requestId = String(message["id"] ?? "");
				const fields: Record<string, unknown> = {};
				for (const key of ["value", "confirmed", "cancelled"]) {
					if (key in message) fields[key] = message[key];
				}
				hub.uiResponse(sessionId, requestId, fields);
				break;
			}
			case "ui_more_time": {
				const requestId = String(message["id"] ?? "");
				hub.moreTime(sessionId, requestId, message["more"] === true, message["draft"]);
				break;
			}
			case "reask": {
				const requestId = String(message["id"] ?? "");
				await hub.reask(active.id ?? sessionId, requestId, String(message["action"] ?? "ask"));
				break;
			}
			default:
				send(frameError(`unknown frame "${String(type)}"`));
		}
	} catch (error) {
		log(`ws command failed: ${(error as Error).message}`);
		send(frameError((error as Error).message));
	}
}

/** Put the per-daemon reload nonce into the served index without touching disk. */
function injectReloadNonce(asset: Buffer, nonce: string): Buffer {
	const text = asset.toString("utf8");
	const tag = `<meta name="pixip-reload-nonce" content="${nonce}" />`;
	if (text.includes('name="pixip-reload-nonce"')) {
		return Buffer.from(text.replace(/<meta name="pixip-reload-nonce"[^>]*>/, tag));
	}
	if (text.includes("<head>")) return Buffer.from(text.replace("<head>", `<head>\n\t\t${tag}`));
	return Buffer.from(`${tag}\n${text}`);
}

/**
 * Daemon-wide `/reload`: gate first, then pre-read assets and re-apply the hub's
 * policy/index, then commit assets + rotate the nonce, then reload children.
 * A child failure is reported but does not roll assets back; a preflight failure
 * leaves everything untouched.
 */
async function runReload(
	hub: Hub,
	state: ServerState,
	options: ServerOptions,
	broadcast: (frame: string) => void,
	pause?: PauseTarget[],
): Promise<ReloadReport> {
	const blockers = hub.reloadBlockers();
	const requiresRestart = options.reloadCode?.requiresRestart();
	const generation = options.reloadCode?.generation;
	if (blockers.length > 0) {
		const names = blockers.map((blocker) => `${blocker.name ?? blocker.id} (${blocker.reason})`).join(", ");
		const message = `reload refused: ${names}`;
		options.log(message);
		return {
			ok: false,
			status: "refused",
			message,
			blockers,
			children: [],
			reloaded: [],
			reloads: state.reloads,
			...(generation !== undefined ? { generation } : {}),
			...(requiresRestart ? { requiresRestart } : {}),
		};
	}

	// Import the next daemon generation first: the risk is the edited
	// TypeScript, so it must fail before assets, policy or children move.
	let applied = false;
	try {
		if (options.reloadCode) {
			await options.reloadCode.prepare();
			options.reloadCode.applyPending();
			applied = true;
		}
	} catch (error) {
		options.reloadCode?.rollback();
		const message = `reload failed before any change: ${(error as Error).message}`;
		options.log(message);
		return {
			ok: false,
			status: "error",
			message,
			blockers: [],
			children: [],
			reloaded: [],
			reloads: state.reloads,
			...(generation !== undefined ? { generation } : {}),
			...(requiresRestart ? { requiresRestart } : {}),
		};
	}

	let assets: Map<string, Buffer>;
	let policy: { sessions: number; policy: number };
	try {
		assets = await loadAssets(options.clientDir);
		policy = await hub.reload();
	} catch (error) {
		if (applied) options.reloadCode?.rollback();
		const message = `reload failed before any change: ${(error as Error).message}`;
		options.log(message);
		return {
			ok: false,
			status: "error",
			message,
			blockers: [],
			children: [],
			reloaded: [],
			reloads: state.reloads,
			...(generation !== undefined ? { generation } : {}),
			...(requiresRestart ? { requiresRestart } : {}),
		};
	}

	state.assets = assets;
	state.nonce = randomBytes(16).toString("hex");
	state.reloads += 1;
	const committedGeneration = applied ? options.reloadCode?.commit() : generation;
	const children = await hub
		.reloadChildren()
		.catch((error: unknown): ReloadChildResult[] => [{ id: "daemon", ok: false, error: (error as Error).message }]);
	const failed = children.filter((child) => !child.ok);
	const migrated = children.filter((child) => child.migrated).length;
	const parts = [
		"reloaded assets",
		`config (${policy.policy} session(s))`,
		`index (${policy.sessions} session(s))`,
		`commands`,
	];
	if (committedGeneration !== undefined) parts.push(`daemon gen ${committedGeneration}`);
	if (migrated > 0) parts.push(`${migrated} session(s) migrated to the host`);
	if (failed.length > 0)
		parts.push(`${failed.length} session(s) failed: ${failed.map((child) => child.name ?? child.id).join(", ")}`);
	// A red/error dot does not block, but the report names it.
	const errored = (await hub.list()).filter((session) => session.state === "error");
	if (errored.length > 0) {
		parts.push(`error sessions not reloaded: ${errored.map((session) => session.name ?? session.id).join(", ")}`);
	}
	if (requiresRestart) parts.push(`restart required: ${requiresRestart}`);
	const pauseReport = pause && pause.length > 0 ? await resumePaused(hub, pause) : undefined;
	if (pauseReport) parts.push(formatPauseReport(pauseReport));
	const message = parts.join("; ");
	options.log(`reload: ${message}`);
	broadcast(frameNotice(message, { reload: true, status: failed.length > 0 ? "partial" : "ok" }));
	return {
		ok: failed.length === 0,
		status: failed.length === 0 ? "ok" : "partial",
		message,
		blockers: [],
		children,
		reloaded: ["assets", "config", "index", "commands"],
		reloads: state.reloads,
		...(committedGeneration !== undefined ? { generation: committedGeneration } : {}),
		...(requiresRestart ? { requiresRestart } : {}),
		...(pauseReport ? { pause: pauseReport } : {}),
	};
}

/** The pause wait budget; tests shorten it through `ServerOptions.pauseWaitMs`. */
function pauseWait(options: ServerOptions): number {
	return options.pauseWaitMs ?? PAUSE_WAIT_MS;
}

/** Gate blockers that still belong to the pause plan (matched by child or logical id). */
function remainingPauseBlockers(hub: Hub, targets: PauseTarget[], mode: "reload" | "restart"): ReloadBlocker[] {
	const blockers = mode === "restart" ? hub.restartBlockers() : hub.reloadBlockers();
	const ids = new Set(targets.flatMap((target) => [target.id, target.logicalId]));
	return blockers.filter((blocker) => ids.has(blocker.id));
}

/** Poll the same gate the operation will use, bounded, then return what still blocks. */
async function waitForPause(
	hub: Hub,
	targets: PauseTarget[],
	mode: "reload" | "restart",
	timeoutMs: number,
): Promise<ReloadBlocker[]> {
	const deadline = Date.now() + timeoutMs;
	let remaining = remainingPauseBlockers(hub, targets, mode);
	while (remaining.length > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		remaining = remainingPauseBlockers(hub, targets, mode);
	}
	return remaining;
}

async function readAsset(clientDir: string, relative: string): Promise<Buffer | undefined> {
	try {
		return await readFile(join(clientDir, relative));
	} catch {
		return undefined;
	}
}

async function loadAssets(clientDir: string): Promise<Map<string, Buffer>> {
	const assets = new Map<string, Buffer>();
	const entries = await readdir(clientDir, { recursive: true, withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		const relative = `/${path
			.slice(clientDir.length + 1)
			.split("\\")
			.join("/")}`;
		assets.set(relative, await readFile(path));
	}
	return assets;
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

/** First bytes of a file, enough for magic-byte MIME detection. */
async function readFileHead(path: string): Promise<Uint8Array> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(16);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

class PayloadTooLargeError extends Error {}

/** Raw upload body with a hard cap, checked before and during the stream. */
async function readBinaryBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const declared = Number(req.headers["content-length"] ?? 0);
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new PayloadTooLargeError("file is too large (max 100 MB)");
	}
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		total += buffer.length;
		if (total > maxBytes) throw new PayloadTooLargeError("file is too large (max 100 MB)");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, total);
}
