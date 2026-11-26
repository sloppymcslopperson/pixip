// Reftag actions for transcript blocks and inbox cards. Neutral module: it
// imports the clipboard, toast and kernel state, never a feature cluster.
import { copyText } from "./clipboard.js";
import { resolveRefTags } from "./reftagResolve.js";
import { formatRefTag, refForEntry } from "./reftags.js";
import { send } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

/** Excerpt cap for the tag-plus-text action; moves to config.toml later. */
export const EXCERPT_CHARS = 50;

/** First line of rendered text, whitespace collapsed, capped with an ellipsis. */
export function excerptText(text, limit = EXCERPT_CHARS) {
	const collapsed = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (collapsed.length <= limit) return collapsed;
	return `${collapsed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function logicalSessionId() {
	const id = state.info?.logicalId ?? state.info?.id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

/** A tag for one snapshot block; null when the session or entry id is unusable. */
export function tagForEntry(entryId) {
	const session = logicalSessionId();
	if (!session || typeof entryId !== "string" || !entryId) return null;
	return formatRefTag({ kind: "history", session, entry: entryId });
}

/** A tag for a live message record, using the same coverage key as the hub. */
export function tagForLiveMessage(message, fallbackTimestamp) {
	const session = logicalSessionId();
	if (!session) return null;
	const record = message && typeof message === "object" ? message : { role: "assistant", timestamp: fallbackTimestamp };
	return formatRefTag(refForEntry(session, { message: record }) ?? {});
}

let openMenu = null;

function closeMenu() {
	if (!openMenu) return;
	openMenu.remove();
	openMenu = null;
	document.removeEventListener("click", onDocumentClick, true);
}

function onDocumentClick(event) {
	if (openMenu && !openMenu.contains(event.target)) closeMenu();
}

function menuButton(label, action, dataset) {
	const button = document.createElement("button");
	button.type = "button";
	button.setAttribute("role", "menuitem");
	button.textContent = label;
	if (dataset) Object.assign(button.dataset, dataset);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		action();
		closeMenu();
	});
	return button;
}

/** A body-level menu avoids nesting interactive content inside a <summary>. */
function showMenu(anchor, block, forkEntry) {
	closeMenu();
	const menu = document.createElement("div");
	menu.className = "reftag-menu";
	menu.setAttribute("role", "menu");
	if (forkEntry) menu.append(menuButton("fork", () => send({ t: "fork", entryId: forkEntry })));
	menu.append(menuButton("copy with text", () => copyBlockRef(block, { withText: true })));
	document.body.append(menu);
	const box = anchor.getBoundingClientRect();
	const width = menu.offsetWidth;
	const height = menu.offsetHeight;
	const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
	const top = box.bottom + 4 + height > window.innerHeight - 8 ? Math.max(8, box.top - height - 4) : box.bottom + 4;
	menu.style.left = `${Math.round(left)}px`;
	menu.style.top = `${Math.round(top)}px`;
	openMenu = menu;
	// Defer so the click that opened the menu is not also the outside click.
	setTimeout(() => document.addEventListener("click", onDocumentClick, true), 0);
}

function actionsElement(block, tag) {
	const actions = document.createElement("div");
	actions.className = "reftag-actions";

	const copy = document.createElement("button");
	copy.type = "button";
	copy.className = "reftag-copy";
	copy.dataset.reftagCopy = "";
	copy.title = "Copy reftag";
	copy.setAttribute("aria-label", "Copy reftag");
	copy.textContent = "#";

	const more = document.createElement("button");
	more.type = "button";
	more.className = "reftag-more";
	more.dataset.reftagMore = "";
	more.title = "More actions";
	more.setAttribute("aria-label", "More actions");
	more.textContent = "…";

	actions.append(copy, more);
	block.dataset.reftag = tag;
	return actions;
}

function actionsHost(block) {
	return block?.tagName === "DETAILS" ? block.querySelector(":scope > summary") : block;
}

/** Attach (or refresh) the corner actions on one block. */
export function stampRef(block, tag) {
	if (!block || !tag) return;
	const host = actionsHost(block);
	if (host?.querySelector(":scope > .reftag-actions")) {
		block.dataset.reftag = tag;
		return;
	}
	const actions = actionsElement(block, tag);
	// A closed <details> hides appended content, so tool/compaction actions live
	// in their always-visible summary instead.
	(host ?? block).append(actions);
}

/** Decorate every painted snapshot block under `root` that has an entry id. */
export function decorateRefBlocks(root = ui.log) {
	void decorateUserRefs(root);
	if (!root || typeof root.querySelectorAll !== "function") return;
	for (const block of root.querySelectorAll("section[data-entry], details[data-entry]")) {
		const entryId = block.dataset.entry;
		if (!entryId) continue;
		if (block.dataset.reftag) {
			// A replaced block keeps its data-entry but loses its action bar.
			if (!actionsHost(block)?.querySelector(":scope > .reftag-actions")) {
				const tag = tagForEntry(entryId);
				if (tag) stampRef(block, tag);
			}
			continue;
		}
		const tag = tagForEntry(entryId);
		if (tag) stampRef(block, tag);
	}
}

/**
 * Turn inert user-message ref placeholders into chips in place. Unresolved tags
 * become their literal `[pixip-ref=…]` text. Injectable elements are ignored,
 * so overlapping paint passes are harmless.
 */
export async function decorateUserRefs(root = ui.log) {
	if (!root || typeof root.querySelectorAll !== "function") return;
	const tokens = [...root.querySelectorAll(".reftag-token[data-reftag]")];
	if (tokens.length === 0) return;
	const chips = await resolveRefTags(tokens.map((token) => token.dataset.reftag ?? "").join(" "));
	const byTag = new Map(chips.map((chip) => [chip.tag, chip]));
	for (const token of tokens) {
		const tag = token.dataset.reftag ?? "";
		const chip = byTag.get(tag);
		if (!chip || chip.unresolved) {
			token.replaceWith(document.createTextNode(tag));
			continue;
		}
		const chipNode = document.createElement("span");
		chipNode.className = `reftag-inline ${chip.kind}`;
		chipNode.dataset.reftag = tag;
		chipNode.title = tag;
		const label = document.createElement("span");
		label.className = "reftag-inline-label";
		label.textContent = chip.label;
		chipNode.append(label);
		token.replaceWith(chipNode);
	}
}

/** The block's rendered text without the action bar or the speaker label. */
export function blockText(block) {
	if (!block) return "";
	const clone = block.cloneNode(true);
	clone.querySelectorAll(".reftag-actions, .who, .load-full").forEach((node) => node.remove());
	// A chipped ref is display-only; the excerpt is about what was sent, so put
	// the raw tag back before reading the text.
	for (const chip of clone.querySelectorAll(".reftag-inline[data-reftag]")) {
		chip.replaceWith(clone.ownerDocument.createTextNode(chip.dataset.reftag ?? ""));
	}
	return excerptText(clone.textContent ?? "");
}

/** Copy one block's tag, or the tag plus its first-line excerpt. */
export function copyBlockRef(block, { withText = false } = {}) {
	const tag = block?.dataset?.reftag;
	if (!tag) return;
	if (!withText) {
		void copyText(tag);
		return;
	}
	const excerpt = blockText(block);
	void copyText(excerpt ? `${tag}\n\n> ${excerpt}` : tag);
}

/**
 * Delegated transcript click handling. Returns true when the event belonged to
 * a reftag action, so the caller can stop.
 */
export function handleRefTagAction(event) {
	const more = event.target.closest?.("[data-reftag-more]");
	if (more) {
		event.preventDefault();
		event.stopPropagation();
		const block = more.closest("[data-reftag]");
		const forkEntry = block?.classList.contains("user") ? block?.dataset?.entry : null;
		if (openMenu) closeMenu();
		else showMenu(more, block, forkEntry);
		return true;
	}
	const button = event.target.closest?.("[data-reftag-copy], [data-reftag-copy-text]");
	if (!button) return false;
	event.preventDefault();
	event.stopPropagation();
	if (button.dataset.reftagCopyText !== undefined) copyBlockRef(button.closest("[data-reftag]"), { withText: true });
	else copyBlockRef(button.closest("[data-reftag]"));
	return true;
}

/** Inbox card helper: the same one-tap `#` action, without a block menu. */
export function inboxRefButton(messageId) {
	const tag = formatRefTag({ kind: "inbox", id: messageId });
	const button = document.createElement("button");
	button.type = "button";
	button.dataset.reftagCopy = "";
	button.title = "Copy reftag";
	button.setAttribute("aria-label", "Copy reftag");
	button.textContent = "#";
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		if (tag) void copyText(tag);
	});
	return button;
}
