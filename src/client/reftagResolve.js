// Composer reftag chips. Cluster-neutral: it reads kernel state and the one
// grammar, never composer or inbox internals. app.js wires the function; the
// inbox list is fetched here only when an inbox tag is present.
import { confirmJump } from "./reftagJump.js";
import { messageKey, scanRefTags } from "./reftags.js";
import { INBOX_SUBJECT_CHARS, clipText, firstWords, purposeLabel, removeRefTag } from "./reftagText.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

const INBOX_URL = "/api/inbox?all=1&filter=all";

let inboxCache = null;
let updateSeq = 0;
let primedChip = null;

/** Expose × and remember this chip as the one awaiting a second tap. */
function primeChip(node) {
	if (primedChip && primedChip !== node) primedChip.classList.remove("open");
	primedChip = node;
	node.classList.add("open");
}

function clearPrime() {
	primedChip?.classList.remove("open");
	primedChip = null;
}

// Any click that is not the primed chip drops the prime; the next tap starts over.
document.addEventListener(
	"click",
	(event) => {
		if (!primedChip) return;
		if (!primedChip.isConnected) {
			primedChip = null;
			return;
		}
		const chip = event.target.closest?.(".reftag-chip");
		if (chip !== primedChip) clearPrime();
	},
	true,
);

function shortId(id) {
	return typeof id === "string" && id.length > 0 ? id.slice(0, 8) : "unknown";
}

function sessionMeta(logicalId) {
	const sessions = Array.isArray(state.sessions) ? state.sessions : [];
	return sessions.find((session) => session?.logicalId === logicalId || session?.id === logicalId) ?? null;
}

function activeSession(logicalId) {
	const info = state.info;
	if (!info) return false;
	return info.logicalId === logicalId || info.id === logicalId;
}

function clockOf(message, entry) {
	const stamp = typeof message?.timestamp === "number" ? message.timestamp : Date.parse(entry?.timestamp ?? "");
	if (!Number.isFinite(stamp)) return "";
	const date = new Date(stamp);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function textOfEntry(entry) {
	const content = entry?.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join(" ");
	}
	const message = entry?.message;
	if (typeof message?.command === "string") return message.command;
	if (typeof entry?.summary === "string") return entry.summary;
	return "";
}

function entryFor(entries, ref) {
	if (!Array.isArray(entries)) return null;
	if (typeof ref.entry === "string") return entries.find((entry) => entry?.id === ref.entry) ?? null;
	if (ref.message) {
		const key = messageKey({ role: ref.message.role, timestamp: ref.message.timestamp });
		return entries.find((entry) => messageKey(entry) === key) ?? null;
	}
	return null;
}

/** A live block painted from an event, before it has an entry in state.entries. */
function liveBlock(tag) {
	if (!ui.log?.querySelectorAll) return null;
	return (
		[...ui.log.querySelectorAll("section[data-reftag], details[data-reftag]")].find(
			(node) => node.dataset.reftag === tag,
		) ?? null
	);
}

/** Visible block text without the speaker label or action bar. */
function liveBlockText(block) {
	const clone = block.cloneNode(true);
	clone.querySelectorAll(".reftag-actions, .who, .load-full").forEach((node) => node.remove());
	for (const chip of clone.querySelectorAll(".reftag-inline[data-reftag]")) {
		chip.replaceWith(clone.ownerDocument.createTextNode(chip.dataset.reftag ?? ""));
	}
	return clone.textContent ?? "";
}

function liveHistoryChip(ref, block, source) {
	const role = ref.message?.role ?? (block.classList.contains("user") ? "user" : "assistant");
	const message = {
		role,
		timestamp: ref.message?.timestamp,
		content: [{ type: "text", text: liveBlockText(block) }],
	};
	return historyChip(ref, { message }, source);
}

function historyChip(ref, entry, source) {
	const message = entry?.message ?? {};
	const role = typeof message.role === "string" ? message.role : "";
	const parts = [source, role, clockOf(message, entry), firstWords(textOfEntry(entry))].filter(Boolean);
	return { tag: ref.tag, kind: "history", label: parts.join(" · "), unresolved: false };
}

function resolveHistory(ref) {
	const meta = sessionMeta(ref.session);
	const active = activeSession(ref.session);
	const source = (active ? state.info?.name : meta?.name) || shortId(ref.session);

	if (active) {
		const entry = entryFor(state.entries, ref);
		if (entry) return historyChip(ref, entry, source);
		const live = liveBlock(ref.tag);
		if (live) return liveHistoryChip(ref, live, source);
	}

	const candidates = [meta?.id, ref.session, active ? state.info?.id : null].filter(Boolean);
	for (const id of new Set(candidates)) {
		const cached = state.sessionCache.get(id);
		if (!cached) continue;
		const entry = entryFor(cached.entries, ref);
		if (entry) return historyChip(ref, entry, cached.info?.name || source);
		return { tag: ref.tag, kind: "history", label: "unresolved", unresolved: true };
	}

	// Never opened here: the active session or the sessions frame still knows
	// the name and location, which is enough for a name-only chip. A valid entry
	// outside the loaded window must stay navigable.
	if (meta || active) return { tag: ref.tag, kind: "history", label: source, unresolved: false };
	return { tag: ref.tag, kind: "history", label: "unresolved", unresolved: true };
}

function inboxSignature() {
	const inbox = state.inbox ?? {};
	return `${inbox.unread ?? 0}:${inbox.total ?? 0}:${inbox.newest?.id ?? ""}`;
}

async function inboxMessages() {
	const signature = inboxSignature();
	if (inboxCache?.messages && inboxCache.signature === signature) return inboxCache.messages;
	if (inboxCache?.pending) return inboxCache.pending;
	const pending = fetch(INBOX_URL, { headers: { accept: "application/json" } })
		.then((response) => (response.ok ? response.json() : null))
		.then((data) => {
			const messages = Array.isArray(data?.messages) ? data.messages : [];
			inboxCache = { messages, signature };
			return messages;
		})
		.catch(() => {
			inboxCache = { messages: [], signature };
			return [];
		})
		.finally(() => {
			if (inboxCache) inboxCache.pending = null;
		});
	inboxCache = { ...(inboxCache ?? {}), pending };
	return pending;
}

async function resolveInbox(ref) {
	const messages = await inboxMessages();
	const message = messages.find((item) => item?.id === ref.id);
	if (!message) return { tag: ref.tag, kind: "inbox", label: "unresolved", unresolved: true };
	const label = [
		message.sender?.name || "inbox",
		purposeLabel(message.purpose),
		clipText(message.subject, INBOX_SUBJECT_CHARS),
	]
		.filter(Boolean)
		.join(" · ");
	return { tag: ref.tag, kind: "inbox", label, unresolved: false };
}

/** Resolve each distinct tag in `text`, in first-seen order. */
export async function resolveRefTags(text) {
	const seen = new Set();
	const chips = [];
	for (const match of scanRefTags(text)) {
		if (seen.has(match.tag)) continue;
		seen.add(match.tag);
		const ref = { ...match.ref, tag: match.tag };
		chips.push(ref.kind === "inbox" ? await resolveInbox(ref) : resolveHistory(ref));
	}
	return chips;
}

function chipElement(chip) {
	const node = document.createElement("div");
	node.className = `reftag-chip${chip.unresolved ? " unresolved" : ""}`;
	node.dataset.tag = chip.tag;
	node.setAttribute("role", "button");
	node.tabIndex = 0;
	node.title = chip.tag;
	const label = document.createElement("span");
	label.className = "reftag-chip-label";
	label.textContent = chip.label;
	const remove = document.createElement("button");
	remove.type = "button";
	remove.className = "reftag-chip-remove";
	remove.setAttribute("aria-label", "Remove reftag");
	remove.textContent = "×";
	remove.addEventListener("click", (event) => {
		event.stopPropagation();
		if (primedChip === node) clearPrime();
		ui.input.value = removeRefTag(ui.input.value, chip.tag);
		ui.input.focus();
		ui.input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	node.append(label, remove);
	const activate = () => {
		if (primedChip === node) {
			confirmJump(chip);
			return;
		}
		primeChip(node);
	};
	node.addEventListener("click", (event) => {
		if (event.target.closest(".reftag-chip-remove")) return;
		activate();
	});
	node.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			if (event.target.closest(".reftag-chip-remove")) return;
			activate();
		}
	});
	return node;
}

function renderChips(chips) {
	const host = ui.reftagChips;
	primedChip = null;
	host.textContent = "";
	host.hidden = chips.length === 0;
	for (const chip of chips) host.append(chipElement(chip));
}

/** Recompute the chip row from the textarea; stale async runs are dropped. */
export async function updateComposerRefTags() {
	const token = ++updateSeq;
	const text = ui.input.value;
	if (scanRefTags(text).length === 0) {
		renderChips([]);
		return;
	}
	const chips = await resolveRefTags(text);
	if (token !== updateSeq) return;
	renderChips(chips);
}
