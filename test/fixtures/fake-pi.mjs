#!/usr/bin/env node
// Minimal `pi --mode rpc` peer for tests: same JSONL framing as Pi (split on LF
// only), but canned responses and no model calls. Every behaviour a test needs
// is driven by FAKE_PI_* environment variables; nothing here touches the real
// agent or the real session directory.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const argv = process.argv.slice(2);
const env = process.env;
const option = (name) => {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
};

const sessionDir = option("--session-dir") ?? process.cwd();
const requested = option("--session");
let sessionName = option("--name") ?? env.FAKE_PI_NAME;
let model = {
	id: env.FAKE_PI_MODEL ?? "fake-model",
	provider: "fake",
	contextWindow: 100_000,
	reasoning: false,
};
let thinkingLevel = env.FAKE_PI_THINKING ?? "off";
const entries = JSON.parse(env.FAKE_PI_ENTRIES ?? "[]");
let messageCount = entries.filter((entry) => entry?.type === "message").length;
let leafId = env.FAKE_PI_LEAF ?? entries.at(-1)?.id ?? null;
const during = JSON.parse(env.FAKE_PI_DURING ?? "[]");
const duringEntry = env.FAKE_PI_DURING_ENTRY ? JSON.parse(env.FAKE_PI_DURING_ENTRY) : undefined;
const onFooter = JSON.parse(env.FAKE_PI_ON_FOOTER ?? "[]");

// Pi allocates a fresh session id on every spawn (even when reattached at an
// existing path); a file that already has a header keeps its id.
let sessionId = env.FAKE_PI_SESSION_ID;
if (!sessionId && requested && existsSync(requested)) {
	try {
		sessionId = JSON.parse(readFileSync(requested, "utf8").split("\n")[0] ?? "{}").id;
	} catch {
		// unreadable file: fall through to a new id, like Pi does for an empty path
	}
}
sessionId ??= env.FAKE_PI_NEW_SESSION_ID ?? randomUUID();
let sessionFile = requested ?? `${sessionDir}/2026-11-21T00-00-00-000Z_${sessionId}.jsonl`;

if (env.FAKE_PI_LOG) {
	appendFileSync(
		env.FAKE_PI_LOG,
		`${JSON.stringify({
			type: "spawn",
			pid: process.pid,
			args: argv,
			sessionId,
			pixipSessionId: env.PIXIP_SESSION_ID ?? null,
		})}\n`,
	);
}

/** One line per command the hub sent; tests assert on the recorded payload. */
const logRecord = (record) => {
	if (env.FAKE_PI_LOG) appendFileSync(env.FAKE_PI_LOG, `${JSON.stringify(record)}\n`);
};

const send = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const ok = (id, command, data) => send({ type: "response", id, command, success: true, data });
const fail = (id, command, error) => send({ type: "response", id, command, success: false, error });

let duringSent = false;

function handle(line) {
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}
	switch (command.type) {
		case "get_state":
			return ok(command.id, "get_state", {
				sessionId,
				sessionFile,
				sessionName,
				model,
				thinkingLevel,
				messageCount,
				isStreaming: env.FAKE_PI_IS_STREAMING === "1",
				autoCompactionEnabled: true,
			});
		case "get_entries": {
			if (duringEntry) {
				entries.push(duringEntry);
				leafId = duringEntry.id ?? leafId;
			}
			// The records a test wants to land *inside* the snapshot window: emitted
			// before the response, exactly like Pi appends an entry then emits it.
			if (!duringSent) {
				duringSent = true;
				for (const event of during) send(event);
			}
			if (command.since !== undefined) {
				const at = entries.findIndex((entry) => entry?.id === command.since);
				if (at === -1) return fail(command.id, "get_entries", `Entry not found: ${command.since}`);
				return ok(command.id, "get_entries", { entries: entries.slice(at + 1), leafId });
			}
			return ok(command.id, "get_entries", { entries, leafId });
		}
		case "get_session_stats":
			for (const event of onFooter) send(event);
			return ok(command.id, "get_session_stats", {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
				contextUsage: { percent: 0, contextWindow: 100_000 },
			});
		case "get_available_models":
			if (env.FAKE_PI_RENAME_TO) send({ type: "session_info_changed", name: env.FAKE_PI_RENAME_TO });
			return ok(command.id, "get_available_models", {
				models: JSON.parse(env.FAKE_PI_MODELS ?? "[]"),
			});
		case "get_available_thinking_levels": {
			const levels = (env.FAKE_PI_THINKING_LEVELS ?? "off").split(",").filter(Boolean);
			return ok(command.id, "get_available_thinking_levels", {
				levels,
				current: thinkingLevel,
			});
		}
		case "get_last_assistant_text":
			return ok(command.id, "get_last_assistant_text", { text: env.FAKE_PI_LAST_TEXT ?? null });
		case "set_session_name":
			logRecord({ type: "set_session_name", name: command.name });
			sessionName = command.name;
			send({ type: "session_info_changed", name: command.name });
			return ok(command.id, "set_session_name", {});
		case "set_model": {
			logRecord({ type: "set_model", provider: command.provider, modelId: command.modelId });
			const available = JSON.parse(env.FAKE_PI_MODELS ?? "[]");
			const found = available.find((item) => item?.id === command.modelId && item?.provider === command.provider);
			model = { ...model, id: command.modelId, provider: command.provider, ...(found ?? {}) };
			return ok(command.id, "set_model", { id: command.modelId, provider: command.provider });
		}
		case "set_thinking_level":
			logRecord({ type: "set_thinking_level", level: command.level });
			thinkingLevel = command.level;
			return ok(command.id, "set_thinking_level", {});
		case "new_session": {
			logRecord({ type: "new_session" });
			sessionId = env.FAKE_PI_NEW_SESSION_ID_AFTER ?? randomUUID();
			sessionFile = `${sessionDir}/2026-11-21T00-00-00-000Z_${sessionId}.jsonl`;
			sessionName = undefined;
			messageCount = 0;
			entries.length = 0;
			leafId = null;
			return ok(command.id, "new_session", { cancelled: false });
		}
		case "compact": {
			logRecord({
				type: "compact",
				customInstructions: command.customInstructions ?? null,
			});
			if (env.FAKE_PI_COMPACTION !== "0") {
				send({ type: "compaction_start", reason: "manual" });
				send({
					type: "compaction_end",
					reason: "manual",
					aborted: false,
					result: { summary: "compacted", tokensBefore: 100 },
				});
			}
			return ok(command.id, "compact", {
				summary: "compacted",
				firstKeptEntryId: null,
				tokensBefore: 100,
				estimatedTokensAfter: 10,
			});
		}
		case "prompt": {
			logRecord({
				type: "prompt",
				id: command.id,
				text: command.message,
				streamingBehavior: command.streamingBehavior ?? null,
			});
			// A slow handler stands in for an extension command blocked on a dialog.
			const promptDelay = Number(env.FAKE_PI_PROMPT_DELAY_MS ?? 0);
			const prompt = () => ok(command.id, "prompt", { disposition: "started" });
			if (promptDelay > 0) return void setTimeout(prompt, promptDelay);
			return prompt();
		}
		case "steer":
			logRecord({ type: "steer", id: command.id, text: command.message });
			return ok(command.id, "steer", {});
		case "bash": {
			logRecord({
				type: "bash",
				id: command.id,
				command: command.command,
				excludeFromContext: command.excludeFromContext === true,
			});
			const chunks = env.FAKE_PI_BASH_DELTA ? [env.FAKE_PI_BASH_DELTA] : ["out-1\n", "out-2\n"];
			for (const delta of chunks) send({ type: "bash_execution_update", id: command.id, delta });
			const respond = () =>
				ok(command.id, "bash", {
					output: env.FAKE_PI_BASH_OUTPUT ?? chunks.join(""),
					exitCode: Number(env.FAKE_PI_BASH_EXIT ?? 0),
					cancelled: env.FAKE_PI_BASH_CANCELLED === "1",
					truncated: env.FAKE_PI_BASH_TRUNCATED === "1",
					...(env.FAKE_PI_BASH_FULL_OUTPUT ? { fullOutputPath: env.FAKE_PI_BASH_FULL_OUTPUT } : {}),
				});
			const bashDelay = Number(env.FAKE_PI_BASH_DELAY_MS ?? 0);
			if (bashDelay > 0) return void setTimeout(respond, bashDelay);
			return respond();
		}
		default:
			return ok(command.id, command.type, {});
	}
}

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	let at = buffer.indexOf("\n");
	while (at !== -1) {
		const line = buffer.slice(0, at).replace(/\r$/, "");
		buffer = buffer.slice(at + 1);
		if (line.length > 0) handle(line);
		at = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));
