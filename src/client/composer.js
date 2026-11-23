// Client composer module; shared state lives in kernel/state.js.
import { optimisticContent, slashPayload, textPayload } from "./attachments.js";
import { clearPendingAttachment } from "./composerAttachments.js";
import { submitBash } from "./composerBash.js";
import { classifyInput, isAllowed } from "./commands.js";
import { installDeps } from "./configure.js";
import { clearInput } from "./composerInput.js";
import { scrollToEnd } from "./scroll.js";
import { appendBlock } from "./transcriptView.js";
import { renderUserBody } from "./render.js";
import { formatSession } from "./sessionInfo.js";
import { notice, textSheet, toast } from "./toast.js";
import { send } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

let deps;

export function configureComposer(next) {
	deps = installDeps("composer", "configureComposer", next, ["surfaceOpen"]);
}

export const builtinHandlers = {
	compact(args) {
		send({ t: "compact", ...(args ? { instructions: args } : {}) });
	},
	name(args) {
		if (!args) {
			toast(`name: ${state.info?.name || "(unnamed)"}`);
			return;
		}
		send({ t: "set_session_name", name: args });
	},
	session() {
		textSheet("session", formatSession(state.info, state.footer));
	},
	copy() {
		send({ t: "copy" });
	},
	model(args) {
		if (!args) {
			send({ t: "models" });
			return;
		}
		send({ t: "set_model_query", query: args });
	},
	thinking(args) {
		if (!args) {
			send({ t: "thinking" });
			return;
		}
		send({ t: "set_thinking_query", query: args });
	},
	new() {
		send({ t: "new_session" });
	},
	resume() {
		location.hash = "";
	},
	quit() {
		quitSession();
	},
	tree() {
		send({ t: "tree" });
	},
	fork(args) {
		// With an id the fork runs directly; bare `/fork` opens the tree sheet to
		// pick a user message (the TUI picker).
		if (args) {
			send({ t: "fork", entryId: args });
			return;
		}
		send({ t: "tree" });
	},
	clone() {
		send({ t: "clone" });
	},
	import(args) {
		if (!args) {
			toast("usage: /import <path>");
			return;
		}
		send({ t: "import", path: args });
	},
	export() {
		send({ t: "export" });
	},
};

export function attachmentBlocksCommand(label) {
	if (!state.pendingAttachment) return false;
	notice(`remove or send the attachment before ${label}`);
	return true;
}

export function submit() {
	if (deps.surfaceOpen()) {
		toast("answer or cancel the request first");
		return;
	}
	const text = ui.input.value.trim();
	const attachment = state.pendingAttachment;
	if (attachment?.kind === "busy" || (attachment?.kind === "file" && attachment.uploading)) {
		toast("attachment is still uploading");
		return;
	}
	if (attachment?.kind === "error") {
		toast("remove the failed attachment first");
		return;
	}
	if (!text && !attachment) return;
	if (!text) {
		submitText("", attachment);
		return;
	}
	const action = classifyInput(text);
	switch (action.kind) {
		case "empty":
			return;
		case "menu":
			// `/` opens the suggestion menu in 06-command-menu; keep the text until then.
			return;
		case "bash":
			if (attachmentBlocksCommand("running a bash command")) return;
			submitBash(action);
			return;
		case "tui":
			if (attachmentBlocksCommand("using a TUI command")) return;
			if (!allowed(action)) return;
			notice(
				`/${action.name} is a Pi TUI-only command${action.command?.ticket ? ` (planned in ${action.command.ticket})` : ""} — use a terminal`,
			);
			clearInput();
			return;
		case "builtin": {
			if (attachmentBlocksCommand("using a builtin command")) return;
			if (!allowed(action)) return;
			const handler = builtinHandlers[action.name];
			if (!handler) {
				notice(`/${action.name} is not wired yet`);
				clearInput();
				return;
			}
			handler(action.args);
			clearInput();
			return;
		}
		case "passthrough":
			// Unknown `/thing` and every extension command/template/skill go to Pi
			// verbatim. While busy that must be `prompt` + steer: RPC `steer` would
			// queue the text instead of executing the extension command.
			if (!allowed(action)) return;
			submitSlash(action.text, attachment);
			return;
		default:
			submitText(action.text, attachment);
	}
}

export function applyPolicy(policy) {
	state.policy =
		policy && typeof policy === "object"
			? {
					allow: Array.isArray(policy.allow) ? policy.allow.filter((name) => typeof name === "string") : [],
					deny: Array.isArray(policy.deny) ? policy.deny.filter((name) => typeof name === "string") : [],
					bash: policy.bash !== false,
				}
			: null;
}

export function allowed(action) {
	if (isAllowed(action.name, state.policy)) return true;
	notice(`/${action.name} is blocked by the command policy`);
	clearInput();
	return false;
}

export function quitSession() {
	send({ t: "stop" });
	state.quitting = true;
	// The status frame normally navigates; this is the fallback if the socket
	// drops before it arrives.
	setTimeout(() => {
		if (!state.quitting) return;
		state.quitting = false;
		location.hash = "";
	}, 500);
}

export function submitSlash(text, attachment) {
	const busy = state.info?.state === "busy";
	send(slashPayload(text, attachment, busy));
	// No optimistic user echo: an extension command may consume the prompt, and
	// Pi's own message_start paints templates/skills when they produce a message.
	clearInput();
	clearPendingAttachment();
}

export function submitText(text, attachment) {
	const busy = state.info?.state === "busy";
	send(textPayload(text, attachment, busy));
	state.pendingUser = appendBlock(
		"user",
		`<div class="who">you</div>${renderUserBody({ content: optimisticContent(text, attachment) })}`,
		true,
	);
	clearInput();
	clearPendingAttachment();
	scrollToEnd(true);
}
