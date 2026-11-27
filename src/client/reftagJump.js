// Composer reftag chip navigation. A chip body primes on the first tap; the
// next click on the same chip asks for confirmation, then this module finds the
// referenced block (paging earlier when needed), scrolls and flashes it.
import { openSession, showInbox } from "./navigation.js";
import { messageKey, parseRefTag } from "./reftags.js";
import { closeSheet, sheetHeader } from "./sheetShell.js";
import { toast } from "./toast.js";
import { send } from "./transport.js";
import { oldestEntryId } from "./transcriptWindow.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

const SESSION_TIMEOUT_MS = 15_000;
const LOAD_TIMEOUT_MS = 20_000;
const PAINT_TIMEOUT_MS = 5_000;
const POLL_MS = 80;
export const FLASH_MS = 1500;

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameSession(routeId, logicalId) {
	return (
		state.sessionId === routeId ||
		state.info?.id === routeId ||
		state.info?.logicalId === logicalId ||
		state.info?.id === logicalId
	);
}

function routeIdFor(ref) {
	const meta = (Array.isArray(state.sessions) ? state.sessions : []).find(
		(session) => session?.logicalId === ref.session || session?.id === ref.session,
	);
	return meta?.id ?? ref.session;
}

/** The painted block carrying `tag`, snapshot or live. */
export function blockForTag(tag) {
	if (!ui.log?.querySelectorAll || typeof tag !== "string" || !tag) return null;
	for (const node of ui.log.querySelectorAll("section[data-reftag], details[data-reftag]")) {
		if (node.dataset.reftag === tag) return node;
	}
	return null;
}

function hasEntry(ref) {
	const entries = Array.isArray(state.entries) ? state.entries : [];
	if (typeof ref.entry === "string") return entries.some((entry) => entry?.id === ref.entry);
	if (!ref.message) return false;
	const key = messageKey(ref.message);
	return key !== null && entries.some((entry) => messageKey(entry) === key);
}

async function waitForSession(routeId, logicalId) {
	const until = Date.now() + SESSION_TIMEOUT_MS;
	while (Date.now() < until) {
		if (state.sessionId === routeId && state.info && sameSession(routeId, logicalId)) return true;
		await delay(POLL_MS);
	}
	return false;
}

/** Load earlier windows until the entry is known or the start is reached. */
async function ensureLoaded(ref, tag) {
	const started = Date.now();
	const until = started + LOAD_TIMEOUT_MS;
	let warmed = false;
	let requested = null;
	while (Date.now() < until) {
		if (blockForTag(tag) || hasEntry(ref)) return true;
		if (!warmed && Date.now() - started > 1500) warmed = true;
		if (warmed && !state.more) return false;
		if (state.more && !state.loadingEarlier) {
			const before = oldestEntryId(state.entries);
			if (before && before !== requested) {
				requested = before;
				send({ t: "earlier", before });
			}
		}
		await delay(POLL_MS);
	}
	return false;
}

async function waitForBlock(tag) {
	const until = Date.now() + PAINT_TIMEOUT_MS;
	while (Date.now() < until) {
		const block = blockForTag(tag);
		if (block) return block;
		await delay(50);
	}
	return null;
}

/** Scroll a painted block into view and flash it without changing layout. */
export function flashBlock(block) {
	if (!block) return;
	block.classList.remove("reftag-flash");
	// Restart the animation when the same block is targeted twice.
	void block.offsetWidth;
	block.classList.add("reftag-flash");
	block.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
	setTimeout(() => block.classList.remove("reftag-flash"), FLASH_MS + 100);
}

/** Navigate to one tag's block using existing routes and frames only. */
export async function jumpToRef(tag) {
	const ref = parseRefTag(tag);
	if (!ref) {
		toast("message not found");
		return;
	}
	if (ref.kind === "inbox") {
		showInbox();
		return;
	}
	if (ref.kind !== "history") {
		toast("message not found");
		return;
	}

	const routeId = routeIdFor(ref);
	if (!sameSession(routeId, ref.session)) {
		// Keep the URL the source of truth for the route, then let the normal
		// route handler attach the session (openSession alone does not move it).
		location.hash = `s=${encodeURIComponent(routeId)}`;
		openSession(routeId);
		if (!(await waitForSession(routeId, ref.session))) {
			toast("message not found");
			return;
		}
	}
	if (!(await ensureLoaded(ref, tag))) {
		toast("message not found");
		return;
	}
	const block = await waitForBlock(tag);
	if (!block) {
		toast("message not found");
		return;
	}
	flashBlock(block);
}

/** Ask before navigating; the chip body itself never navigates on first tap. */
export function confirmJump(chip) {
	if (!chip?.tag || chip.unresolved) return;
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	target.append(sheetHeader("jump to message?"));
	const body = document.createElement("div");
	body.className = "sheet-text";
	body.textContent = chip.label || chip.tag;
	target.append(body);
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const jump = document.createElement("button");
	jump.type = "button";
	jump.className = "primary";
	jump.textContent = "Jump";
	jump.addEventListener("click", () => {
		closeSheet();
		void jumpToRef(chip.tag);
	});
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "Cancel";
	cancel.addEventListener("click", closeSheet);
	actions.append(jump, cancel);
	target.append(actions);
}
