import {
	ansiToHtml,
	bashCardHtml,
	escapeHtml,
	relativeTime,
	renderAssistant,
	renderAssistantBody,
	renderEntry,
	renderUserBody,
	pendingErrorHtml,
	pendingSessionHtml,
	summarizeArgs,
	textOf,
	toolBlock,
	toolCallsOf,
} from "./render.js";
import { classifyInput, commandQuery, filterCommands, isAllowed, menuCatalog, menuInsertText } from "./commands.js";
import {
	MAX_IMAGE_BYTES,
	MAX_IMAGE_EDGE,
	MAX_IMAGE_SOURCE_BYTES,
	MAX_UPLOAD_BYTES,
	attachmentPrompt,
	looksLikeImage,
	sizeLabel,
} from "./attachments.js";
import { crumbTrail, filterDirEntries, initialDirectory, parentDirectory } from "./directoryPicker.js";
import { queueCount, queueFromEvent, queueTexts, restoreText } from "./queue.js";
import { flattenTree } from "./tree.js";
import { addonStatusText, addonWidgets, applyAddonUi, createAddonUi } from "./addonUi.js";
import { createSessionCache } from "./sessionCache.js";
import { formatSession } from "./sessionInfo.js";
import { contextLevel, footerPwdLine, footerStatsLeft, footerStatsRight } from "./footer.js";
import {
	COLLAPSED_STORAGE_KEY,
	KEEP_ACTIVE_STORAGE_KEY,
	countLabel,
	groupBranch,
	groupLabel,
	groupSessions,
	groupView,
	parseCollapsed,
	parseKeepActive,
	serializeCollapsed,
	serializeKeepActive,
} from "./sessionGroups.js";
import {
	DEFAULT_PERCENT,
	STORAGE_KEY,
	STEPS,
	clampPercent,
	decreaseLabel,
	increaseLabel,
	nextPercent,
	parseStored,
	previousPercent,
	scaleFactor,
} from "./transcriptScale.js";

import {
	apiJson,
	archiveInactive,
	archiveSession,
	confirmSessionAction,
	confirmSheet,
	createPickerFolder,
	deleteSession,
	dirButton,
	dirMessage,
	listSessions,
	loadDirectory,
	openDirectorySheet,
	openSessionActions,
	openSettingsSheet,
	picker,
	pickerUi,
	purgeStored,
	readCollapsedGroups,
	readKeepActive,
	refreshDashboard,
	renderDirectorySheet,
	renderGroup,
	renderList,
	renderStoredSheet,
	restoreStored,
	saveCollapsedGroups,
	saveKeepActive,
	sessionRow,
	setNewCwd,
	showList,
	showNewFolderForm,
	showStoredSheet,
	updateDirectoryList,
} from "./dashboard.js";
import {
	applyInfo,
	beginNewSession,
	cacheCurrentSession,
	failPendingSession,
	forgetCachedSession,
	handleFrame,
	openSession,
	restoreCachedSession,
	showPendingSession,
} from "./session.js";
import {
	FILL_CHUNK_BYTES,
	FIRST_PAINT_BYTES,
	appendRestartNotice,
	earlierButton,
	entryWeight,
	fillTimer,
	fillToken,
	handleDelta,
	handleEvent,
	htmlOf,
	lastEntryId,
	mergeTail,
	oldestEntryId,
	prependHistory,
	renderAddonWidgets,
	renderFooter,
	renderResume,
	renderSnapshot,
	renderTranscript,
	scheduleFlush,
} from "./transcript.js";
import {
	TREE_ROLE,
	closeSheet,
	dismissSheet,
	handleUiRequest,
	openExportSheet,
	openModelSheet,
	openSessionSheet,
	openThinkingSheet,
	openTreeSheet,
	sheet,
	sheetCloseButton,
	sheetCloseRow,
	sheetHeader,
} from "./sheets.js";
import {
	allowed,
	appendBashCard,
	applyPolicy,
	attachmentBlocksCommand,
	bashSeq,
	blobToBase64,
	builtinHandlers,
	canSend,
	canvasToBlob,
	chooseAttachment,
	clearInput,
	clearPendingAttachment,
	copySheet,
	copyText,
	finishBash,
	loadImageFile,
	prepareImage,
	quitSession,
	refreshSendState,
	removeAttachment,
	renderAttachment,
	renderReplace,
	setAttachMenu,
	submit,
	submitBash,
	submitSlash,
	submitText,
	uploadAttachment,
} from "./composer.js";
import { chooseMenu, closeMenu, moveMenu, renderMenu, renderQueue, resize, restoreClearedQueue } from "./menu.js";
import {
	appendBlock,
	bindScaleButton,
	hideThinkingIndicator,
	readScale,
	saveScale,
	scheduleScroll,
	scrollQueued,
	scrollToEnd,
	setBarMenu,
	setBusy,
	setScale,
	showThinkingIndicator,
	softRefresh,
	updateJump,
	updateScaleButtons,
} from "./controls.js";
import { NOTICE_SHEET_CHARS, actionToast, notice, openImageSheet, textSheet, toast, toastTimer } from "./toast.js";
import { closeSocket, connect, route, send, socketUrl } from "./transport.js";

const $ = (selector) => document.querySelector(selector);
const ui = {
	bar: $("#bar"),
	back: $("#back"),
	title: $("#title"),
	sub: $("#sub"),
	dot: $("#dot"),
	settings: $("#settings"),
	reload: $("#reload"),
	more: $("#more"),
	barMenu: $("#bar-menu"),
	stop: $("#stop"),
	scaleDown: $("#scale-down"),
	scaleUp: $("#scale-up"),
	scaleValue: $("#scale-value"),
	list: $("#list"),
	session: $("#session"),
	log: $("#log"),
	jump: $("#jump"),
	dock: $("#dock"),
	menu: $("#menu"),
	queue: $("#queue"),
	composer: $("#composer"),
	attachment: $("#attachment"),
	attach: $("#attach"),
	attachMenu: $("#attach-menu"),
	imageInput: $("#image-input"),
	fileInput: $("#file-input"),
	input: $("#input"),
	send: $("#send"),
	footer: $("#footer"),
	footerAbove: $("#footer .addon-widgets.above"),
	footerStatuses: $("#footer .addon-statuses"),
	footerBelow: $("#footer .addon-widgets.below"),
	sheet: $("#sheet"),
	toast: $("#toast"),
};

const state = {
	sessionId: null,
	sessionCache: createSessionCache(8), // recently viewed transcripts, in-memory only
	info: null,
	ws: null,
	retries: 0,
	stick: true,
	streaming: null, // { section, text }
	pendingUser: null,
	pendingAttachment: null, // one image or file, never both: { kind, name, size, ... }
	attachmentSeq: 0, // invalidates an in-flight image prepare/upload after replace/clear
	restarting: false, // old daemon announced a restart; socket is about to close
	restartWasBusy: false, // a turn was in flight when the restart was announced
	restartNoticePending: false, // paint the interruption notice after the reconnect snapshot
	pendingCreate: null, // dashboard `new` action waiting for the first session id
	uiDialog: null, // extension_ui_request currently shown as a modal, if any
	tools: new Map(), // toolCallId -> <details>
	coarse: window.matchMedia("(pointer: coarse)").matches,
	renderQueued: false,
	footer: null,
	addon: createAddonUi(), // Pi extension setStatus/setWidget state
	models: [],
	levels: [],
	dynamicCommands: [], // live get_commands entries for the `/` menu
	menu: { items: [], index: 0 },
	queue: { steering: [], followUp: [] }, // Pi's pending steer/follow-up texts
	policy: null, // effective per-session command policy (hub-resolved)
	bashRunning: false,
	quitting: false,
	bash: new Map(), // bash id -> optimistic card, matched by event id
	entries: [], // what the client currently knows, oldest first
	more: false, // older entries exist before entries[0]
	loadingEarlier: false,
	scale: DEFAULT_PERCENT, // transcript text size, percent (device-local)
	home: "", // $HOME for dashboard path shortening (device-local cache)
	defaultCwd: "", // last discovery value, so list refreshes do not clear the form
	sessions: [], // last dashboard list, for local re-renders
	collapsed: readCollapsedGroups(), // cwd key -> true when collapsed
	keepActive: readKeepActive(), // pin hot/warm/newest when collapsed
};

// ------------------------------------------------------------------ transport

// -------------------------------------------------------------------- routing

// -------------------------------------------------- directory picker (00)

/** Snapshot the current route before leaving it; the next open paints this. */

/** Repaint a cached route synchronously, before its socket snapshot arrives. */

/** Archive/delete must not leave a stale transcript behind the same id. */

// --------------------------------------------------------------------- frames

// ---------------------------------------------------------------- snapshot

/** Bytes of DOM a 200-entry window costs; the first paint only pays for a slice. */

/**
 * Merge an incoming window (provisional tail or authoritative snapshot) into the
 * client's entries. Windows the user already loaded stay; duplicates are dropped
 * in favour of the newer copy.
 */

/** Rough DOM cost of an entry, used to keep the first paint small. */

/**
 * Paint `state.entries`: the newest slice synchronously (the first-paint
 * budget), then the rest in chunks above it. `distance` is the target
 * `scrollHeight - scrollTop` (clientHeight for a pinned view), applied after
 * every chunk so prepended content never moves what the reader is looking at.
 * One innerHTML assignment per chunk instead of per entry.
 */

/** Replace the transcript with a new window, keeping the reading position. */

/**
 * Resume delta from the durable cursor: append entries this client did not have
 * yet, keep the loaded window's `more`, and repaint from `state.entries`. Live
 * DOM is replaced by its entries, so a message painted live is neither lost nor
 * painted twice, and `state.entries` stays the resume anchor.
 */

/** Local, non-transcript notice for the restart: never sent to Pi or persisted. */

/** Prepend one older window, keeping the reading position. */

// ------------------------------------------------------------------- events

// -------------------------------------------------------------------- footer

ui.footer.addEventListener("click", () => {
	if (!state.sessionId) return;
	openSessionSheet();
});

/** Bottom sheet with a title and one button per action. */

/** Shared x affordance for every modal/sheet. */

/** Title row with the x on the right; the baseline header for every sheet. */

/** Header row for field-first dialogs, where the title is a hint below the field. */

/** x/Escape: cancel a pending Pi dialog exactly once, otherwise close the sheet. */

// ------------------------------------------------------- tree sheet (08)

/**
 * Read-only session tree from RPC `get_tree`. Indentation follows the nesting,
 * the current branch is marked, and user entries get the two actions the TUI
 * offers: fork from here, copy the prompt. Leaf navigation is deliberately
 * absent (RPC exposes no navigate command).
 */

/** `/export`: the HTML and (when the session file exists) the JSONL as downloads. */

// --------------------------------------------------------------- ui dialogs

// ------------------------------------------------------------------ composer

/** pixip built-in handlers; the classifier in commands.js decides who gets here. */

// --------------------------------------------------------------- attachments

ui.attach.addEventListener("click", (event) => {
	event.stopPropagation();
	setAttachMenu(ui.attachMenu.hidden);
});
ui.attachMenu.addEventListener("click", (event) => {
	const button = event.target.closest("[data-attach]");
	if (!button) return;
	setAttachMenu(false);
	if (button.dataset.attach === "image") ui.imageInput.click();
	else if (button.dataset.attach === "file") ui.fileInput.click();
});
ui.imageInput.addEventListener("change", () => {
	const file = ui.imageInput.files?.[0];
	ui.imageInput.value = "";
	if (file) void chooseAttachment(file, true);
});
ui.fileInput.addEventListener("change", () => {
	const file = ui.fileInput.files?.[0];
	ui.fileInput.value = "";
	if (file) void chooseAttachment(file, false);
});
ui.composer.addEventListener("paste", (event) => {
	const file = event.clipboardData?.files?.[0];
	if (!file) return;
	event.preventDefault();
	void chooseAttachment(file, looksLikeImage(file));
});

/** Replacement snapshot: a compaction or a `/new` invalidates loaded windows. */

/** Denied commands never reach the model; they get a local notice instead. */

/** Soft quit: stop/detach the child, then return to the list. */

/** `/copy`: the hub supplies Pi's last assistant text; clipboard may be absent. */

/** Optimistic card on submit: the TUI shows only the bash card, never a user echo. */

/** Final `bash` frame: replace the streamed card with the authoritative result. */

ui.composer.addEventListener("submit", (event) => {
	event.preventDefault();
	submit();
});

ui.input.addEventListener("keydown", (event) => {
	if (!ui.menu.hidden) {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			moveMenu(event.key === "ArrowDown" ? 1 : -1);
			return;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault();
			chooseMenu(state.menu.index);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			closeMenu();
			return;
		}
	}
	if (event.key === "Enter" && !event.shiftKey && !state.coarse) {
		event.preventDefault();
		submit();
	}
});
ui.input.addEventListener("input", () => {
	resize();
	renderMenu();
	refreshSendState();
});
ui.input.addEventListener("focus", renderMenu);
ui.input.addEventListener("blur", () => closeMenu());

// ------------------------------------------------------------- command menu

/**
 * The `/` menu (06): open only while the line is a bare command, filtered
 * prefix-first, capped and scrollable in CSS. `↑`/`↓` move, `Enter`/`Tab`
 * insert, `Esc` closes, a tap inserts (pointerdown keeps the input focused).
 */

/** Insert the selection; a TUI-only command runs its notice immediately. */

ui.menu.addEventListener("pointerdown", (event) => {
	const row = event.target.closest(".menu-row");
	if (!row) return;
	// Keep the textarea focused; the tap is the selection, not a blur.
	event.preventDefault();
	chooseMenu(Number(row.dataset.index));
});

// --------------------------------------------------------------- queue chips

/**
 * Pending steering/follow-up chips above the composer (07). Pi's `queue_update`
 * carries the whole queue, so this replaces the chips; the only action is the
 * X, which clears both lists and restores the texts into the composer.
 */

/** `clear_queue` answer: chips go away, texts return to the composer unsent. */

// ------------------------------------------------------------- transcript size

/**
 * Apply a transcript size, keeping the reading position: a pinned view stays
 * pinned, otherwise the distance from the bottom is held. Only `#log`'s font
 * size changes, so the composer does not move.
 */

/** Tap steps; a long-press resets to 100 % without also firing the click. */

bindScaleButton(ui.scaleDown, "down");
bindScaleButton(ui.scaleUp, "up");
setScale(readScale(), { persist: false });

// Escape is the keyboard half of the modal x: cancel Pi's dialog once, or
// close a local sheet. Backdrop clicks deliberately do nothing. The header
// menu is the innermost popover, so it closes first.
window.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	if (!ui.barMenu.hidden) {
		event.preventDefault();
		setBarMenu(false);
		ui.more.focus();
		return;
	}
	if (ui.sheet.hidden) return;
	event.preventDefault();
	dismissSheet();
});

// Desktop shortcuts. `Ctrl/Cmd` is intentional rather than plain `-`/`+` so
// typing in the composer is never affected; browser zoom still compounds.
window.addEventListener("keydown", (event) => {
	if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
	if (event.key === "-" || event.key === "_") {
		event.preventDefault();
		setScale(previousPercent(state.scale));
	} else if (event.key === "+" || event.key === "=") {
		event.preventDefault();
		setScale(nextPercent(state.scale));
	} else if (event.key === "0") {
		event.preventDefault();
		setScale(DEFAULT_PERCENT);
	}
});

ui.back.addEventListener("click", () => {
	location.hash = "";
});
ui.stop.addEventListener("click", () => {
	send({ t: "stop" });
});

/**
 * Soft refresh, then a full page reload. The hub re-reads assets, policy and the
 * session index without touching live children; the page reload reconnects with
 * the durable cursor. A hard restart is a CLI action (`pixip restart`), not a
 * button: it ends the in-flight turn.
 */

ui.reload.addEventListener("click", () => void softRefresh());
ui.settings.addEventListener("click", openSettingsSheet);

/** Far-right `…` popover: text size and reload live here so the session name
 *  keeps the header width. Closed by an outside click or Escape. */

ui.more.addEventListener("click", (event) => {
	event.stopPropagation();
	setBarMenu(ui.barMenu.hidden);
});
ui.barMenu.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => {
	if (!ui.barMenu.hidden) setBarMenu(false);
	if (!ui.attachMenu.hidden) setAttachMenu(false);
});
window.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && !ui.attachMenu.hidden) {
		event.preventDefault();
		setAttachMenu(false);
	}
});

window.addEventListener("hashchange", route);

// ----------------------------------------------------------------- plumbing

/** Transient "agent is thinking…" marker at the end of the transcript. It is
 *  never persisted: it lives only until the assistant output (thinking box or
 *  text) or the end of the turn replaces it. */

/** Floating jump control: visible only while the reader is scrolled away from
 *  the newest entry and the transcript is on screen. */

ui.log.addEventListener("scroll", () => {
	const distance = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight;
	state.stick = distance < 80;
	updateJump();
});

ui.jump.addEventListener("click", () => {
	// Resume following live entries, then glide to the newest one. The button
	// hides immediately even if the smooth scroll is still in flight.
	state.stick = true;
	updateJump();
	ui.log.scrollTo({ top: ui.log.scrollHeight, behavior: "smooth" });
});

/** The small "fork" affordance on user blocks (08) is delegated: the transcript
 *  is repainted in chunks, so per-button listeners would be lost. */
ui.log.addEventListener("click", (event) => {
	const image = event.target.closest(".msg-image img");
	if (image) {
		openImageSheet(image.src);
		return;
	}
	const button = event.target.closest("[data-fork]");
	if (!button) return;
	const entryId = button.dataset.fork;
	if (entryId) send({ t: "fork", entryId });
});

/** Toast with one action (delete undo); stays up long enough to be reachable. */

/** A 3.2 s toast is useless for `/fit help`'s 2 KB notify: long or multi-line
 *  notices get a dismissible sheet instead. */

route();

export {
	$,
	COLLAPSED_STORAGE_KEY,
	DEFAULT_PERCENT,
	FILL_CHUNK_BYTES,
	FIRST_PAINT_BYTES,
	KEEP_ACTIVE_STORAGE_KEY,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_EDGE,
	MAX_IMAGE_SOURCE_BYTES,
	MAX_UPLOAD_BYTES,
	NOTICE_SHEET_CHARS,
	STEPS,
	STORAGE_KEY,
	TREE_ROLE,
	actionToast,
	addonStatusText,
	addonWidgets,
	allowed,
	ansiToHtml,
	apiJson,
	appendBashCard,
	appendBlock,
	appendRestartNotice,
	applyAddonUi,
	applyInfo,
	applyPolicy,
	archiveInactive,
	archiveSession,
	attachmentBlocksCommand,
	attachmentPrompt,
	bashCardHtml,
	bashSeq,
	beginNewSession,
	bindScaleButton,
	blobToBase64,
	builtinHandlers,
	cacheCurrentSession,
	canSend,
	canvasToBlob,
	chooseAttachment,
	chooseMenu,
	clampPercent,
	classifyInput,
	clearInput,
	clearPendingAttachment,
	closeMenu,
	closeSheet,
	closeSocket,
	commandQuery,
	confirmSessionAction,
	confirmSheet,
	connect,
	contextLevel,
	copySheet,
	copyText,
	countLabel,
	createAddonUi,
	createPickerFolder,
	createSessionCache,
	crumbTrail,
	decreaseLabel,
	deleteSession,
	dirButton,
	dirMessage,
	dismissSheet,
	earlierButton,
	entryWeight,
	escapeHtml,
	failPendingSession,
	fillTimer,
	fillToken,
	filterCommands,
	filterDirEntries,
	finishBash,
	flattenTree,
	footerPwdLine,
	footerStatsLeft,
	footerStatsRight,
	forgetCachedSession,
	formatSession,
	groupBranch,
	groupLabel,
	groupSessions,
	groupView,
	handleDelta,
	handleEvent,
	handleFrame,
	handleUiRequest,
	hideThinkingIndicator,
	htmlOf,
	increaseLabel,
	initialDirectory,
	isAllowed,
	lastEntryId,
	listSessions,
	loadDirectory,
	loadImageFile,
	looksLikeImage,
	menuCatalog,
	menuInsertText,
	mergeTail,
	moveMenu,
	nextPercent,
	notice,
	oldestEntryId,
	openDirectorySheet,
	openExportSheet,
	openImageSheet,
	openModelSheet,
	openSession,
	openSessionActions,
	openSessionSheet,
	openSettingsSheet,
	openThinkingSheet,
	openTreeSheet,
	parentDirectory,
	parseCollapsed,
	parseKeepActive,
	parseStored,
	pendingErrorHtml,
	pendingSessionHtml,
	picker,
	pickerUi,
	prepareImage,
	prependHistory,
	previousPercent,
	purgeStored,
	queueCount,
	queueFromEvent,
	queueTexts,
	quitSession,
	readCollapsedGroups,
	readKeepActive,
	readScale,
	refreshDashboard,
	refreshSendState,
	relativeTime,
	removeAttachment,
	renderAddonWidgets,
	renderAssistant,
	renderAssistantBody,
	renderAttachment,
	renderDirectorySheet,
	renderEntry,
	renderFooter,
	renderGroup,
	renderList,
	renderMenu,
	renderQueue,
	renderReplace,
	renderResume,
	renderSnapshot,
	renderStoredSheet,
	renderTranscript,
	renderUserBody,
	resize,
	restoreCachedSession,
	restoreClearedQueue,
	restoreStored,
	restoreText,
	route,
	saveCollapsedGroups,
	saveKeepActive,
	saveScale,
	scaleFactor,
	scheduleFlush,
	scheduleScroll,
	scrollQueued,
	scrollToEnd,
	send,
	serializeCollapsed,
	serializeKeepActive,
	sessionRow,
	setAttachMenu,
	setBarMenu,
	setBusy,
	setNewCwd,
	setScale,
	sheet,
	sheetCloseButton,
	sheetCloseRow,
	sheetHeader,
	showList,
	showNewFolderForm,
	showPendingSession,
	showStoredSheet,
	showThinkingIndicator,
	sizeLabel,
	socketUrl,
	softRefresh,
	state,
	submit,
	submitBash,
	submitSlash,
	submitText,
	summarizeArgs,
	textOf,
	textSheet,
	toast,
	toastTimer,
	toolBlock,
	toolCallsOf,
	ui,
	updateDirectoryList,
	updateJump,
	updateScaleButtons,
	uploadAttachment,
};
