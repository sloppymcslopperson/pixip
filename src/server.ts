import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, normalize } from "node:path";

import { WebSocketServer, type WebSocket } from "ws";

import { createDirectory, DirError, listDirectories } from "./dirs.ts";
import { Hub } from "./hub.ts";
import {
	frameBash,
	frameBashError,
	frameClone,
	frameCommands,
	frameCopy,
	frameError,
	frameExport,
	frameFork,
	frameHello,
	frameHistory,
	frameImport,
	frameModels,
	frameOpened,
	framePolicy,
	frameQueue,
	frameSnapshot,
	frameThinking,
	frameTree,
	WIRE_VERSION,
} from "./wire.ts";
import type { SessionInfo } from "./wire.ts";

export interface ServerOptions {
	host: string;
	port: number;
	hub: Hub;
	clientDir: string;
	log: (message: string) => void;
	/** Re-read client assets per request, so CSS/JS edits need no restart. */
	dev?: boolean;
}

export interface RunningServer {
	url: string;
	/** Soft refresh: re-read assets and the hub's caches; never touches children. */
	refresh: () => Promise<RefreshReport>;
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
	refresh: () => Promise<RefreshReport>;
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/** The refresh endpoint changes server state, so only local peers may call it. */
export function isLoopback(req: IncomingMessage): boolean {
	return LOOPBACK.test(req.socket.remoteAddress ?? "");
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
 * Ask for the window after `since`, falling back to a full snapshot when Pi no
 * longer knows the cursor (forked, compacted away, or simply bogus).
 */
async function requestSnapshot(
	hub: Hub,
	id: string,
	since: string | undefined,
	log: (message: string) => void,
): Promise<SnapshotReply> {
	if (since) {
		try {
			return { ...(await hub.snapshot(id, undefined, since)), resume: true };
		} catch (error) {
			log(`resume cursor ${since} rejected (${(error as Error).message}); sending a full snapshot`);
		}
	}
	return { ...(await hub.snapshot(id, undefined, undefined)), resume: false };
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
	const state: ServerState = {
		assets: await loadAssets(options.clientDir),
		startedAt: Date.now(),
		reloads: 0,
		refresh: async () => {
			// Hub caches first (policy is re-resolved for live sessions); only then
			// swap assets, so a bad config leaves the running daemon as it was.
			const result = await options.hub.reload();
			state.assets = await loadAssets(options.clientDir);
			state.reloads += 1;
			options.log(
				`soft refresh: assets, config (${result.policy} session(s)), index (${result.sessions} session(s)), commands`,
			);
			return { reloaded: ["assets", "config", "index", "commands"], reloads: state.reloads };
		},
	};
	const { hub, log } = options;
	const wss = new WebSocketServer({ noServer: true });

	const server = createServer((req, res) => {
		void handleHttp(req, res, hub, state, log, options);
	});

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== "/ws") {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			void handleSocket(ws, url, hub, log);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => resolve());
	});

	const address = server.address();
	const port = typeof address === "object" && address ? address.port : options.port;
	return {
		url: `http://${options.host}:${port}/`,
		refresh: state.refresh,
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
		if (req.method === "GET" && url.pathname === "/health") {
			send(
				200,
				JSON.stringify({
					ok: true,
					wire: WIRE_VERSION,
					pid: process.pid,
					startedAt: state.startedAt,
					reloads: state.reloads,
				}),
			);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/refresh") {
			if (!isLoopback(req)) {
				log(`refresh refused from non-loopback peer ${req.socket.remoteAddress ?? "?"}`);
				send(403, JSON.stringify({ error: "refresh is loopback-only" }));
				return;
			}
			const report = await state.refresh();
			send(200, JSON.stringify({ ok: true, ...report }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/info") {
			send(200, JSON.stringify({ ok: true, wire: WIRE_VERSION, defaultCwd: process.cwd(), home: process.env["HOME"] ?? "" }));
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
			const parsed = JSON.parse(body || "{}") as { cwd?: string; name?: string };
			const cwd = parsed.cwd ?? process.cwd();
			const info = await hub.create(cwd, parsed.name);
			send(200, JSON.stringify(info));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/sessions/archive-inactive") {
			const result = await hub.archiveInactive();
			send(200, JSON.stringify({ ok: true, archived: result.archived.length, failed: result.failed, sessions: result.archived }));
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
		send(200, asset, CONTENT_TYPES[extname(normalized)] ?? "application/octet-stream");
	} catch (error) {
		const status = error instanceof DirError ? error.status : 500;
		log(`http error: ${(error as Error).message}`);
		send(status, JSON.stringify({ error: (error as Error).message }));
	}
}

function osHome(): string {
	return process.env["HOME"] ?? process.cwd();
}

async function handleSocket(ws: WebSocket, url: URL, hub: Hub, log: (message: string) => void): Promise<void> {
	const sessionId = url.searchParams.get("session");
	const send = (frame: string) => {
		if (ws.readyState === ws.OPEN) ws.send(frame);
	};

	if (!sessionId) {
		send(frameHello(await hub.list(), process.cwd(), process.env["HOME"] ?? ""));
		const unwatch = hub.watch((frame) => send(frame));
		ws.on("close", unwatch);
		ws.on("message", (data) => {
			void handleCommand(String(data), { id: null }, hub, send, log);
		});
		return;
	}

	let subscriptions: Array<() => void> = [];
	// The socket starts on the URL's id; an index-only session reattaches under a
	// fresh Pi id, and every later command must follow that id instead.
	const active: { id: string | null } = { id: sessionId };
	// A `/new` in any tab re-keys the session; this socket follows instantly and
	// tells the client, which then asks for a replacement snapshot.
	subscriptions.push(
		hub.onRekey((from, info) => {
			if (active.id !== from) return;
			active.id = info.id;
			send(frameOpened(info, true));
		}),
	);
	ws.on("close", () => {
		for (const unsubscribe of subscriptions) unsubscribe();
		subscriptions = [];
	});
	// Bind before the attach await: "load earlier" may arrive while the child
	// is still booting, and a listener added later would drop that frame.
	ws.on("message", (data) => {
		void handleCommand(String(data), active, hub, send, log);
	});

	try {
		// A reconnect that carries a cursor already has a transcript: skip the
		// provisional repaint and resume from the durable entry cursor instead.
		const cursor = url.searchParams.get("since") ?? undefined;
		const provisional = cursor ? null : await hub.provisional(sessionId);
		if (provisional) {
			send(frameSnapshot(provisional.info, provisional.entries, provisional.leafId, provisional.more));
		}
		const info = await hub.attach(sessionId);
		active.id = info.id;
		// The index-only path lands on a new Pi id: tell the client before the
		// snapshot so its URL and session key keep pointing at this transcript.
		if (info.id !== sessionId) send(frameOpened(info));
		// Policy is per session (cwd + data dir + CLI), so it goes on the session
		// socket, not on the list; the composer needs it before the first submit.
		send(framePolicy(hub.policy(info.id)));

		// Subscribe *before* `get_entries` and buffer what the child emits in
		// between, so a client connecting mid-turn cannot miss the start of a
		// message. Records without an entry identity (status, UI dialogs) are
		// order-independent and go out immediately.
		const buffer: Array<{ frame: string; key: string }> = [];
		let bytes = 0;
		let overflowed = false;
		let buffering = true;
		subscriptions.push(
			hub.subscribe(info.id, (frame, key) => {
				if (!key || !buffering) {
					send(frame);
					return;
				}
				buffer.push({ frame, key });
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
		subscriptions.push(hub.watch((frame) => send(frame)));

		let resumeFrom = cursor;
		for (let attempt = 0; ; attempt += 1) {
			const snapshot = await requestSnapshot(hub, info.id, resumeFrom, log);
			send(frameSnapshot(snapshot.info, snapshot.entries, snapshot.leafId, snapshot.more, snapshot.resume));
			const covered = new Set(snapshot.covered);
			for (const item of buffer) {
				if (!covered.has(item.key)) send(item.frame);
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

		void hub
			.footer(info.id)
			.then((footer) => {
				send(JSON.stringify({ t: "footer", footer }));
			})
			.catch(() => {
				// Detached between attach and footer: the status frame already says so.
			});

		// Discoverable commands for the `/` menu: fetched once per attach (the
		// client caches them) and off the snapshot path.
		void hub
			.commands(info.id)
			.then((commands) => send(frameCommands(commands)))
			.catch(() => {
				// A child that just went away simply leaves the menu on the static catalog.
			});
	} catch (error) {
		send(frameError((error as Error).message));
	}
}

async function handleCommand(
	raw: string,
	active: { id: string | null },
	hub: Hub,
	send: (frame: string) => void,
	log: (message: string) => void,
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
				const info = await hub.create(cwd, name);
				send(frameOpened(info));
				return;
			}
			case "stop": {
				if (!sessionId) return;
				send(JSON.stringify({ t: "status", session: await hub.stop(sessionId) }));
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
				const behavior = message["streamingBehavior"] === "steer" ? "steer" : message["streamingBehavior"] === "followUp" ? "followUp" : undefined;
				await hub.prompt(sessionId, String(message["text"] ?? ""), behavior);
				break;
			}
			case "steer":
				await hub.steer(sessionId, String(message["text"] ?? ""));
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
			default:
				send(frameError(`unknown frame "${String(type)}"`));
		}
	} catch (error) {
		log(`ws command failed: ${(error as Error).message}`);
		send(frameError((error as Error).message));
	}
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
		const relative = `/${path.slice(clientDir.length + 1).split("\\").join("/")}`;
		assets.set(relative, await readFile(path));
	}
	return assets;
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}
