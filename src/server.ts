import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import { WebSocketServer, type WebSocket } from "ws";

import { Hub } from "./hub.ts";
import { frameError, frameHello, frameSnapshot, WIRE_VERSION } from "./wire.ts";

export interface ServerOptions {
	host: string;
	port: number;
	hub: Hub;
	clientDir: string;
	log: (message: string) => void;
}

export interface RunningServer {
	url: string;
	close: () => Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

export async function startServer(options: ServerOptions): Promise<RunningServer> {
	const assets = await loadAssets(options.clientDir);
	const { hub, log } = options;
	const wss = new WebSocketServer({ noServer: true });

	const server = createServer((req, res) => {
		void handleHttp(req, res, hub, assets, log);
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
	assets: Map<string, Buffer>,
	log: (message: string) => void,
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	const send = (status: number, body: string | Buffer, type = "application/json; charset=utf-8") => {
		res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
		res.end(body);
	};

	try {
		if (req.method === "GET" && url.pathname === "/health") {
			send(200, JSON.stringify({ ok: true, wire: WIRE_VERSION }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/info") {
			send(200, JSON.stringify({ ok: true, wire: WIRE_VERSION, defaultCwd: process.cwd() }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/sessions") {
			send(200, JSON.stringify(await hub.list()));
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
		const stopMatch = /^\/api\/sessions\/([^/]+)\/stop$/.exec(url.pathname);
		if (req.method === "POST" && stopMatch?.[1]) {
			send(200, JSON.stringify(await hub.stop(decodeURIComponent(stopMatch[1]))));
			return;
		}

		const assetPath = url.pathname === "/" ? "/index.html" : url.pathname;
		const normalized = normalize(assetPath).replace(/^(\.\.[/\\])+/, "");
		const asset = assets.get(normalized);
		if (!asset) {
			send(404, JSON.stringify({ error: "not found" }));
			return;
		}
		send(200, asset, CONTENT_TYPES[extname(normalized)] ?? "application/octet-stream");
	} catch (error) {
		log(`http error: ${(error as Error).message}`);
		send(500, JSON.stringify({ error: (error as Error).message }));
	}
}

async function handleSocket(ws: WebSocket, url: URL, hub: Hub, log: (message: string) => void): Promise<void> {
	const sessionId = url.searchParams.get("session");
	const send = (frame: string) => {
		if (ws.readyState === ws.OPEN) ws.send(frame);
	};

	if (!sessionId) {
		send(frameHello(await hub.list(), process.cwd()));
		const unwatch = hub.watch((frame) => send(frame));
		ws.on("close", unwatch);
		ws.on("message", (data) => {
			void handleCommand(String(data), null, hub, send, log);
		});
		return;
	}

	let subscriptions: Array<() => void> = [];
	ws.on("close", () => {
		for (const unsubscribe of subscriptions) unsubscribe();
		subscriptions = [];
	});

	try {
		const info = await hub.attach(sessionId);
		const snapshot = await hub.snapshot(sessionId);
		send(frameSnapshot(snapshot.info, snapshot.entries, snapshot.leafId));
		subscriptions.push(hub.subscribe(sessionId, send));
		subscriptions.push(hub.watch((frame) => send(frame)));
	} catch (error) {
		send(frameError((error as Error).message));
	}

	ws.on("message", (data) => {
		void handleCommand(String(data), sessionId, hub, send, log);
	});
}

async function handleCommand(
	raw: string,
	sessionId: string | null,
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
	try {
		switch (type) {
			case "create": {
				const cwd = typeof message["cwd"] === "string" ? message["cwd"] : process.cwd();
				const name = typeof message["name"] === "string" ? message["name"] : undefined;
				const info = await hub.create(cwd, name);
				send(JSON.stringify({ t: "opened", session: info }));
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
			case "prompt":
				await hub.prompt(sessionId, String(message["text"] ?? ""));
				break;
			case "steer":
				await hub.steer(sessionId, String(message["text"] ?? ""));
				break;
			case "abort":
				await hub.abort(sessionId);
				break;
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
