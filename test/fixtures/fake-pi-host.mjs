#!/usr/bin/env node
// Minimal `pixip-pi-host` peer for tests. It speaks the host's protocol deltas
// (`hello`, blocking `panel`) and the subset of Pi RPC the hub uses. Behaviour is
// driven by FAKE_HOST_* env vars; it never touches the real agent or sessions.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const argv = process.argv.slice(2);
const env = process.env;
const option = (name) => {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
};
const log = (record) => {
	if (env.FAKE_HOST_LOG) appendFileSync(env.FAKE_HOST_LOG, `${JSON.stringify(record)}\n`);
};
const send = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const ok = (id, command, data) =>
	send({
		id,
		type: "response",
		command,
		success: true,
		...(data === undefined ? {} : { data }),
	});

// One-shot print path, used for automatic titles.
if (argv[0] === "--print" || argv[0] === "-p") {
	const modelAt = argv.indexOf("--model");
	const model = modelAt >= 0 ? argv[modelAt + 1] : undefined;
	log({ type: "title", args: argv, model });
	process.stdout.write(`${env.FAKE_HOST_TITLE ?? "Host session label"}\n`);
	process.exit(0);
}

log({ type: "spawn", args: argv });

const sessionDir = option("--session-dir") ?? process.cwd();
let sessionName = option("--name");
const requested = option("--session");
let sessionId = env.FAKE_HOST_SESSION_ID;
if (!sessionId && requested && existsSync(requested)) {
	try {
		sessionId = JSON.parse(readFileSync(requested, "utf8").split("\n")[0] ?? "{}").id;
	} catch {
		// unreadable file: fall through to a fresh id
	}
}
sessionId ??= randomUUID();
const models = [{ id: "fake-model", provider: "fake", contextWindow: 100_000, reasoning: false }];
const entries = JSON.parse(env.FAKE_HOST_ENTRIES ?? "[]");
const onPrompt = JSON.parse(env.FAKE_HOST_ON_PROMPT ?? "[]");

send({
	type: "hello",
	protocol: 1,
	piVersion: "fake-host",
	capabilities: ["panel", "reload"],
});

function handle(line) {
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		send({ type: "response", command: "parse", success: false, error: "bad json" });
		return;
	}
	switch (command.type) {
		case "reload":
			log({ type: "reload", pid: process.pid });
			return env.FAKE_HOST_RELOAD_FAIL === "1"
				? send({ id: command.id, type: "response", command: "reload", success: false, error: "reload failed" })
				: ok(command.id, "reload");
		case "get_state":
			return ok(command.id, "get_state", {
				sessionId,
				sessionFile: requested ?? `${sessionDir}/${sessionId}.jsonl`,
				sessionName,
				model: { id: "fake-model", provider: "fake" },
				thinkingLevel: "off",
				isStreaming: false,
				messageCount: entries.filter((entry) => entry?.type === "message").length,
			});
		case "get_entries":
			return ok(command.id, "get_entries", {
				entries,
				leafId: entries.at(-1)?.id ?? null,
			});
		case "get_available_models":
			return ok(command.id, "get_available_models", { models });
		case "get_session_stats":
			return ok(command.id, "get_session_stats", {
				tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
				contextUsage: { percent: 0, contextWindow: 100_000 },
			});
		case "get_commands":
			return ok(command.id, "get_commands", { commands: [] });
		case "get_last_assistant_text":
			return ok(command.id, "get_last_assistant_text", { text: null });
		case "set_session_name":
			sessionName = command.name;
			return ok(command.id, "set_session_name");
		case "prompt":
			log({ type: "prompt", text: command.message });
			for (const event of onPrompt) {
				send(event.type === "extension_ui_request" && !event.id ? { ...event, id: randomUUID() } : event);
			}
			return ok(command.id, "prompt", { disposition: "started" });
		case "extension_ui_response":
			log({
				type: "extension_ui_response",
				id: command.id,
				...(command.value === undefined ? {} : { value: command.value }),
				...(command.cancelled === undefined ? {} : { cancelled: command.cancelled }),
				...(command.confirmed === undefined ? {} : { confirmed: command.confirmed }),
			});
			return;
		case "shutdown":
			ok(command.id, "shutdown");
			return process.exit(0);
		default:
			return ok(command.id, command.type, {});
	}
}

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
		const line = buffer.slice(0, at).replace(/\r$/, "");
		buffer = buffer.slice(at + 1);
		if (line.length > 0) handle(line);
	}
});
process.stdin.on("end", () => process.exit(0));
