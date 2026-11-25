#!/usr/bin/env node
/**
 * Zero-dependency static dev server for design mockups (default: `ui_work/`).
 *
 *   node tools/dev-ui.mjs                 # http://127.0.0.1:8181/
 *   node tools/dev-ui.mjs --port 9000 --dir ui_work
 *
 * Every response is uncached and HTML pages get a tiny live-reload client that
 * listens on `/__dev/reload` (SSE) and reloads the tab when a file in the served
 * directory changes. No bundler, no build step, no npm dependency.
 */
import { createReadStream, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const port = Number(flag("port", process.env["DEV_UI_PORT"] ?? 8181));
const host = flag("host", "127.0.0.1");
const root = resolve(flag("dir", "ui_work"));

const MIME = new Map([
	[".html", "text/html; charset=utf-8"],
	[".htm", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
	[".avif", "image/avif"],
	[".ico", "image/x-icon"],
	[".woff", "font/woff"],
	[".woff2", "font/woff2"],
	[".ttf", "font/ttf"],
	[".map", "application/json; charset=utf-8"],
	[".md", "text/plain; charset=utf-8"],
]);

const RELOAD_PATH = "/__dev/reload";
const clients = new Set();
let pending = false;

const reloadClient = `<script>
(() => {
	let ready = false;
	const source = new EventSource(${JSON.stringify(RELOAD_PATH)});
	source.addEventListener("open", () => {
		// The first open is this page's own connection; only later ones are reloads.
		if (ready) location.reload();
		ready = true;
	});
	source.addEventListener("reload", () => location.reload());
})();
</script>`;

function notifyClients() {
	if (pending) return;
	pending = true;
	setTimeout(() => {
		pending = false;
		for (const response of clients) response.write("event: reload\ndata: change\n\n");
	}, 60);
}

function send(response, status, headers, body) {
	response.writeHead(status, { "Cache-Control": "no-store", ...headers });
	response.end(body);
}

function resolveFile(urlPath) {
	let pathname;
	try {
		pathname = decodeURIComponent(new URL(urlPath, "http://localhost").pathname);
	} catch {
		return null;
	}
	const target = resolve(join(root, pathname));
	if (target !== root && !target.startsWith(root + sep)) return null;
	try {
		const stat = statSync(target);
		if (stat.isDirectory()) {
			const index = join(target, "index.html");
			return statSync(index).isFile() ? { file: index, size: statSync(index).size } : null;
		}
		return stat.isFile() ? { file: target, size: stat.size } : null;
	} catch {
		return null;
	}
}

function handle(request, response) {
	const urlPath = request.url ?? "/";

	if (urlPath.split("?")[0] === RELOAD_PATH) {
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.write("retry: 500\n\n");
		clients.add(response);
		const heartbeat = setInterval(() => response.write(": ping\n\n"), 25_000);
		request.on("close", () => {
			clearInterval(heartbeat);
			clients.delete(response);
		});
		return;
	}

	if (request.method !== "GET" && request.method !== "HEAD") {
		send(response, 405, { "Content-Type": "text/plain; charset=utf-8" }, "method not allowed\n");
		return;
	}

	const found = resolveFile(urlPath);
	if (!found) {
		const listing = readdirSync(root)
			.filter((name) => !name.startsWith("."))
			.sort()
			.map((name) => {
				let directory = false;
				try {
					directory = statSync(join(root, name)).isDirectory();
				} catch {}
				const href = encodeURIComponent(name) + (directory ? "/" : "");
				return `<li><a href="${href}">${name}${directory ? "/" : ""}</a></li>`;
			})
			.join("\n");
		send(
			response,
			404,
			{ "Content-Type": "text/html; charset=utf-8" },
			`<!DOCTYPE html><meta charset="utf-8"><title>404</title><h1>Not found</h1><p>${root}</p><ul>${listing}</ul>`,
		);
		return;
	}

	const type = MIME.get(extname(found.file).toLowerCase()) ?? "application/octet-stream";
	if (!type.startsWith("text/html")) {
		response.writeHead(200, {
			"Content-Type": type,
			"Content-Length": found.size,
			"Cache-Control": "no-store",
		});
		if (request.method === "HEAD") response.end();
		else createReadStream(found.file).pipe(response);
		return;
	}

	// Inline the reload client so a mockup file needs no edits of its own.
	const html = readUtf8(found.file);
	const injected = html.includes("</body>")
		? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${reloadClient}\n</body>`)
		: html + reloadClient;
	const body = Buffer.from(injected, "utf8");
	response.writeHead(200, {
		"Content-Type": type,
		"Content-Length": body.length,
		"Cache-Control": "no-store",
	});
	if (request.method === "HEAD") response.end();
	else response.end(body);
}

const cache = new Map();
function readUtf8(file) {
	const stat = statSync(file);
	const hit = cache.get(file);
	if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text;
	const text = readFileSync(file, "utf8");
	cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, text });
	return text;
}

const server = createServer((request, response) => {
	try {
		handle(request, response);
	} catch (error) {
		console.error("dev-ui:", error);
		if (!response.headersSent) send(response, 500, { "Content-Type": "text/plain; charset=utf-8" }, "error\n");
		else response.end();
	}
});

try {
	statSync(root);
} catch {
	console.error(`dev-ui: --dir ${root} does not exist`);
	process.exit(2);
}

// Linux supports recursive fs.watch on modern Node; the fallback watches one level.
try {
	watch(root, { recursive: true }, notifyClients);
} catch {
	watch(root, notifyClients);
}

server.listen(port, host, () => {
	const address = server.address();
	const actual = typeof address === "object" && address ? address.port : port;
	console.log(`dev-ui serving ${root}`);
	console.log(`  http://${host}:${actual}/  (live reload on)`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		for (const response of clients) response.end();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 250).unref();
	});
}
