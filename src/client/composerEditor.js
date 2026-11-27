// Composer editor: a contenteditable field whose ref tags are rendered as
// inline chips. The text is still the prompt: each chip serializes back to its
// raw `[pixip-ref=…]` tag, so sending, drafts and the CLI keep the same bytes.
import { confirmJump } from "./reftagJump.js";
import { scanRefTags } from "./reftags.js";
import { ui } from "./kernel/ui.js";

let primedChip = null;

function isChip(node) {
	return node?.nodeType === 1 && node.classList?.contains("reftag-chip") && typeof node.dataset?.tag === "string";
}

function tagOf(node) {
	return isChip(node) ? (node.dataset.tag ?? "") : "";
}

/** Serialize one DOM node, turning chips back into their raw tags. */
function readNode(node) {
	if (node?.nodeType === 3) return node.nodeValue ?? "";
	if (node?.nodeType !== 1) return "";
	if (isChip(node)) return tagOf(node);
	if (node.tagName === "BR") return "\n";
	return [...node.childNodes].map(readNode).join("");
}

/** The editor's prompt text, with every inline chip serialized as its tag. */
export function readComposer(input = ui.input) {
	let text = "";
	let index = 0;
	for (const child of input.childNodes) {
		const block = child.nodeType === 1 && (child.tagName === "DIV" || child.tagName === "P");
		if (block && index > 0 && !text.endsWith("\n")) text += "\n";
		text += readNode(child);
		index += 1;
	}
	return text;
}

function makeChip(tag, kind) {
	const node = document.createElement("span");
	node.className = "reftag-chip";
	node.dataset.tag = tag;
	node.contentEditable = "false";
	node.setAttribute("role", "button");
	node.tabIndex = 0;
	node.title = tag;
	const label = document.createElement("span");
	label.className = "reftag-chip-label";
	label.textContent = kind === "inbox" ? "inbox ref" : "history ref";
	const remove = document.createElement("button");
	remove.type = "button";
	remove.className = "reftag-chip-remove";
	remove.setAttribute("aria-label", "Remove reftag");
	remove.textContent = "×";
	node.append(label, remove);
	return node;
}

function syncEmpty(input) {
	input.classList.toggle("is-empty", readComposer(input).length === 0);
}

/** Replace the editor contents, converting every complete tag into a chip. */
export function renderComposer(input, text) {
	input.textContent = "";
	const value = typeof text === "string" ? text : "";
	let cursor = 0;
	const fragment = document.createDocumentFragment();
	for (const match of scanRefTags(value)) {
		if (match.start > cursor) fragment.append(document.createTextNode(value.slice(cursor, match.start)));
		fragment.append(makeChip(match.tag, match.ref.kind));
		cursor = match.end;
	}
	if (cursor < value.length) fragment.append(document.createTextNode(value.slice(cursor)));
	input.append(fragment);
	syncEmpty(input);
}

/** The selection as an offset into the serialized prompt text. */
function selectionOffset(input) {
	const selection = window.getSelection();
	if (!selection?.rangeCount) return null;
	const range = selection.getRangeAt(0);
	if (!input.contains(range.startContainer)) return null;
	let total = 0;
	let found = null;
	const walk = (node) => {
		if (found !== null) return;
		if (node.nodeType === 3) {
			if (node === range.startContainer) found = total + range.startOffset;
			else total += node.nodeValue?.length ?? 0;
			return;
		}
		if (node.nodeType !== 1) return;
		if (isChip(node)) {
			if (node === range.startContainer) found = total + (range.startOffset > 0 ? tagOf(node).length : 0);
			else total += tagOf(node).length;
			return;
		}
		if (node.tagName === "BR") {
			if (node === range.startContainer) found = total;
			total += 1;
			return;
		}
		for (const child of node.childNodes) {
			walk(child);
			if (found !== null) return;
		}
	};
	if (range.startContainer === input) {
		for (let i = 0; i < range.startOffset && i < input.childNodes.length; i += 1) walk(input.childNodes[i]);
		return found ?? total;
	}
	for (const child of input.childNodes) {
		walk(child);
		if (found !== null) break;
	}
	return found ?? total;
}

function locateOffset(input, offset) {
	let total = 0;
	let point = null;
	const walk = (node) => {
		if (point) return;
		if (node.nodeType === 3) {
			const length = node.nodeValue?.length ?? 0;
			if (offset <= total + length) point = { node, offset: Math.max(0, offset - total) };
			else total += length;
			return;
		}
		if (node.nodeType !== 1) return;
		if (isChip(node)) {
			const length = tagOf(node).length;
			if (offset <= total + length) {
				const parent = node.parentNode;
				point = { node: parent, offset: [...parent.childNodes].indexOf(node) + 1 };
			} else total += length;
			return;
		}
		if (node.tagName === "BR") {
			if (offset <= total) point = { node: node.parentNode, offset: [...node.parentNode.childNodes].indexOf(node) };
			else total += 1;
			return;
		}
		for (const child of node.childNodes) {
			walk(child);
			if (point) return;
		}
	};
	for (const child of input.childNodes) {
		walk(child);
		if (point) break;
	}
	return point ?? { node: input, offset: input.childNodes.length };
}

function setCaret(input, start, end = start) {
	const selection = window.getSelection();
	if (!selection) return;
	const from = locateOffset(input, start);
	const to = locateOffset(input, end);
	const range = document.createRange();
	range.setStart(from.node, from.offset);
	range.setEnd(to.node, to.offset);
	selection.removeAllRanges();
	selection.addRange(range);
}

function hasRawTags(input) {
	let text = "";
	const walk = (node) => {
		if (node.nodeType === 3) {
			text += node.nodeValue ?? "";
			return;
		}
		if (node.nodeType !== 1 || isChip(node)) return;
		for (const child of node.childNodes) walk(child);
	};
	for (const child of input.childNodes) walk(child);
	return scanRefTags(text).length > 0;
}

/** Convert newly typed or pasted tags into chips without moving the caret. */
export function normalizeComposerInput(input = ui.input) {
	syncEmpty(input);
	if (!hasRawTags(input)) return;
	const offset = selectionOffset(input);
	const text = readComposer(input);
	renderComposer(input, text);
	if (offset !== null) setCaret(input, offset);
}

/** Insert plain text at the caret; used by paste and by Shift+Enter. */
export function insertComposerText(text, input = ui.input) {
	input.focus();
	const selection = window.getSelection();
	if (!selection?.rangeCount || !input.contains(selection.anchorNode)) {
		input.append(document.createTextNode(text));
		setCaret(input, readComposer(input).length);
	} else {
		const range = selection.getRangeAt(0);
		range.deleteContents();
		const node = document.createTextNode(text);
		range.insertNode(node);
		range.setStartAfter(node);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
	}
	input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

function clearPrime() {
	primedChip?.classList.remove("open");
	primedChip = null;
}

function chipInfo(chip) {
	return {
		tag: chip.dataset.tag ?? "",
		label: chip.querySelector(".reftag-chip-label")?.textContent ?? "",
		unresolved: chip.classList.contains("unresolved"),
	};
}

function activateChip(chip) {
	if (primedChip === chip) {
		const info = chipInfo(chip);
		clearPrime();
		confirmJump(info);
		return;
	}
	clearPrime();
	primedChip = chip;
	chip.classList.add("open");
}

function removeChip(chip, input) {
	chip.remove();
	syncEmpty(input);
	input.focus();
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function onChipClick(event, input) {
	const chip = event.target.closest?.(".reftag-chip");
	if (!chip) return;
	event.preventDefault();
	event.stopPropagation();
	if (event.target.closest?.(".reftag-chip-remove")) {
		removeChip(chip, input);
		return;
	}
	activateChip(chip);
}

function onChipKeydown(event) {
	const chip = event.target.closest?.(".reftag-chip");
	if (!chip || (event.key !== "Enter" && event.key !== " ")) return;
	event.preventDefault();
	event.stopPropagation();
	activateChip(chip);
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
		if (!primedChip.contains(event.target)) clearPrime();
	},
	true,
);

/** Install the textarea-compatible facade and the inline chip interactions. */
export function installComposerEditor() {
	const input = ui.input;
	if (input.dataset.composerEditor === "1") return;
	input.dataset.composerEditor = "1";
	Object.defineProperty(input, "value", {
		configurable: true,
		get: () => readComposer(input),
		set: (text) => {
			renderComposer(input, text);
		},
	});
	Object.defineProperty(input, "disabled", {
		configurable: true,
		get: () => input.getAttribute("contenteditable") === "false",
		set: (disabled) => {
			input.setAttribute("contenteditable", disabled ? "false" : "true");
			input.setAttribute("aria-disabled", disabled ? "true" : "false");
			if (disabled) input.blur();
		},
	});
	input.setSelectionRange = (start, end = start) => setCaret(input, start, end);
	input.addEventListener("click", (event) => onChipClick(event, input));
	input.addEventListener("keydown", onChipKeydown);
	renderComposer(input, "");
	// An empty contenteditable div has no line box; the placeholder uses the
	// is-empty class so tapping the blank field still focuses the editor.
	input.classList.add("is-empty");
}
