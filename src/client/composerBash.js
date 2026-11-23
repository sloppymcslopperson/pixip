// Bash-card lifecycle: optimistic card on submit, then replace with the hub's
// authoritative result. Card HTML stays in render.js; state is in kernel/state.
import { clearInput } from "./composerInput.js";
import { scheduleScroll, scrollToEnd } from "./scroll.js";
import { bashCardHtml, bashStartCard } from "./render.js";
import { notice, toast } from "./toast.js";
import { send } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

export let bashSeq = 0;

export function submitBash(action) {
	// `!`/`!!` with no command is a no-op (the TUI keeps the text for editing).
	if (!action.command) return;
	if (state.policy && state.policy.bash === false) {
		notice("bash is disabled by the command policy");
		clearInput();
		return;
	}
	if (state.bashRunning) {
		// TUI guard: one bash at a time; keep the text so it can be resubmitted.
		toast("a bash command is already running");
		return;
	}
	const id = `b${++bashSeq}-${Date.now().toString(36)}`;
	state.bashRunning = true;
	state.bash.set(id, appendBashCard(id, action.command, action.excludeFromContext));
	send({ t: "bash", id, command: action.command, excludeFromContext: action.excludeFromContext });
	clearInput();
	scrollToEnd(true);
}

export function appendBashCard(id, command, excluded) {
	const host = document.createElement("div");
	host.innerHTML = bashCardHtml(bashStartCard(command, excluded));
	const card = host.firstElementChild;
	if (!card) return ui.log.appendChild(document.createElement("div"));
	card.dataset.bash = id;
	ui.log.append(card);
	scheduleScroll();
	return card;
}

export function finishBash(frame) {
	state.bashRunning = false;
	const card = state.bash.get(frame.id);
	state.bash.delete(frame.id);
	if (!card) {
		if (frame.error) toast(frame.error);
		return;
	}
	if (frame.error) {
		card.classList.remove("running");
		card.classList.add("error");
		const meta = card.querySelector(".bash-meta");
		if (meta) meta.textContent = `failed: ${frame.error}`;
		scrollToEnd();
		return;
	}
	card.insertAdjacentHTML("beforebegin", bashCardHtml(frame));
	card.remove();
	scrollToEnd();
}
