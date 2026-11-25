// Dashboard inbox: header badge, bottom sheet, filters and sender replies.
// Everything user-visible is built with textContent; message bodies are never
// treated as HTML.
import { openSession } from "./navigation.js";
import { closeSheet, sheetHeader } from "./sheetShell.js";
import { toast } from "./toast.js";
import {
	archivedCount,
	badgeLabel,
	capLevel,
	emptyInbox,
	filterMessages,
	INBOX_PURPOSES,
	mergeWarnings,
	newCapWarnings,
	normalizeInbox,
	purposeLabel,
	replyPrefix,
	replySession,
	senderStatusFor,
	shortId,
} from "./inboxModel.js";
import { relativeTime } from "./render.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

const WARN_KEY = "pixip.inbox.warned";

const sheetState = {
	filter: "all",
	purpose: null,
	archived: false,
	expanded: null,
	messages: [],
	unread: 0,
	total: 0,
	limit: 200,
	loading: false,
};

function readWarned() {
	try {
		const parsed = JSON.parse(localStorage.getItem(WARN_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function writeWarned(warned) {
	try {
		localStorage.setItem(WARN_KEY, JSON.stringify(warned));
	} catch {
		// storage disabled: warn once per page load
	}
}

export function renderInboxBadge() {
	const badge = ui.inboxBadge;
	if (!badge) return;
	const label = badgeLabel(state.inbox.unread);
	const level = capLevel(state.inbox.total, state.inbox.limit);
	badge.textContent = label;
	badge.hidden = label === "";
	badge.classList.toggle("warn", level === "warn");
	badge.classList.toggle("full", level === "full");
	if (ui.inbox) {
		ui.inbox.title =
			state.inbox.unread > 0 ? `Inbox · ${state.inbox.unread} unread` : `Inbox · ${state.inbox.total} message(s)`;
		ui.inbox.setAttribute("aria-label", state.inbox.unread > 0 ? `Inbox, ${state.inbox.unread} unread` : "Inbox");
	}
}

function warnCap(inbox) {
	const thresholds = newCapWarnings(capLevel(inbox.total, inbox.limit), readWarned());
	if (thresholds.length === 0) return;
	writeWarned(mergeWarnings(readWarned(), thresholds));
	const full = thresholds.includes("full");
	toast(
		full
			? `inbox nearly full (${inbox.total}/${inbox.limit}) — archive or delete messages`
			: `inbox half full (${inbox.total}/${inbox.limit})`,
	);
}

/** A live `inbox` frame: badge, cap warning, and no reload. */
export function applyInboxFrame(summary) {
	state.inbox = normalizeInbox(summary);
	renderInboxBadge();
	warnCap(state.inbox);
}

async function inboxJson(path, init = {}) {
	const response = await fetch(path, {
		...init,
		headers: { ...(init.headers ?? {}), "content-type": "application/json" },
	});
	const text = await response.text();
	let body = {};
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = {};
	}
	if (!response.ok) {
		const message = body && typeof body.error === "string" ? body.error : `request failed (${response.status})`;
		throw new Error(message);
	}
	return body;
}

async function loadInbox() {
	const data = await inboxJson("/api/inbox?all=1&filter=all");
	const normalized = normalizeInbox(data);
	sheetState.messages = Array.isArray(data.messages) ? data.messages : [];
	sheetState.unread = normalized.unread;
	sheetState.total = normalized.total;
	sheetState.limit = normalized.limit;
	// The list response is the authoritative snapshot; update the badge too, so
	// opening the sheet does not leave a stale count until the next frame.
	state.inbox = normalized;
	renderInboxBadge();
}

export async function openInboxSheet() {
	sheetState.archived = false;
	sheetState.expanded = null;
	ui.sheet.hidden = false;
	ui.sheet.textContent = "";
	const wrapper = document.createElement("div");
	wrapper.className = "inbox-sheet";
	wrapper.append(sheetHeader("inbox"));
	const loading = document.createElement("div");
	loading.className = "sheet-text";
	loading.textContent = "loading…";
	wrapper.append(loading);
	ui.sheet.append(wrapper);
	try {
		await loadInbox();
		renderInboxSheet();
	} catch (error) {
		toast(`inbox failed: ${error.message}`);
		closeSheet();
	}
}

function chip(label, active, action) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = active ? "inbox-chip active" : "inbox-chip";
	button.textContent = label;
	button.setAttribute("aria-pressed", String(active));
	button.addEventListener("click", action);
	return button;
}

function renderInboxSheet() {
	const target = ui.sheet;
	target.hidden = false;
	target.textContent = "";
	const wrapper = document.createElement("div");
	wrapper.className = "inbox-sheet";
	const heading = sheetHeader(sheetState.unread > 0 ? `inbox · ${sheetState.unread} unread` : "inbox");
	wrapper.append(heading);

	const toolbar = document.createElement("div");
	toolbar.className = "inbox-toolbar";
	const filters = document.createElement("div");
	filters.className = "inbox-filters";
	filters.append(
		chip("all", sheetState.filter === "all", () => {
			sheetState.filter = "all";
			renderInboxSheet();
		}),
		chip("unread", sheetState.filter === "unread", () => {
			sheetState.filter = "unread";
			renderInboxSheet();
		}),
	);
	for (const purpose of INBOX_PURPOSES) {
		filters.append(
			chip(purposeLabel(purpose), sheetState.purpose === purpose, () => {
				sheetState.purpose = sheetState.purpose === purpose ? null : purpose;
				renderInboxSheet();
			}),
		);
	}
	const archived = archivedCount(sheetState.messages);
	filters.append(
		chip(`archived (${archived})`, sheetState.archived, () => {
			sheetState.archived = !sheetState.archived;
			sheetState.expanded = null;
			renderInboxSheet();
		}),
	);
	toolbar.append(filters);
	if (!sheetState.archived && sheetState.unread > 0) {
		const markAll = document.createElement("button");
		markAll.type = "button";
		markAll.className = "inbox-mark-all";
		markAll.textContent = "mark all read";
		markAll.addEventListener("click", () => void markAllRead());
		toolbar.append(markAll);
	}
	wrapper.append(toolbar);

	const list = document.createElement("div");
	list.className = "inbox-list";
	const visible = filterMessages(sheetState.messages, sheetState);
	if (visible.length === 0) {
		const empty = document.createElement("div");
		empty.className = "sheet-text";
		empty.textContent = sheetState.archived ? "no archived messages" : "no messages";
		list.append(empty);
	}
	for (const message of visible) list.append(renderCard(message));
	wrapper.append(list);

	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const close = document.createElement("button");
	close.textContent = "close";
	close.addEventListener("click", closeSheet);
	actions.append(close);
	wrapper.append(actions);
	target.append(wrapper);
}

function statusLabel(message) {
	const live = senderStatusFor(message.sender, state.sessions);
	if (live !== "deleted") return live;
	return typeof message.senderStatus === "string" ? message.senderStatus : "deleted";
}

function renderCard(message) {
	const card = document.createElement("div");
	card.className = `inbox-card${message.readAt ? "" : " unread"}`;
	card.dataset.id = message.id;

	const head = document.createElement("div");
	head.className = "inbox-card-head";
	const status = statusLabel(message);
	const session = replySession(message.sender, state.sessions);
	if (session && status !== "deleted" && status !== "archived") {
		const sender = document.createElement("button");
		sender.type = "button";
		sender.className = "inbox-sender";
		sender.title = "Open session and reply";
		sender.textContent = `${message.sender.name} · ${shortId(message.sender.logicalId)}`;
		sender.addEventListener("click", (event) => {
			event.stopPropagation();
			openReply(message, session);
		});
		head.append(sender);
	} else {
		const sender = document.createElement("span");
		sender.className = "inbox-sender static";
		sender.textContent = `${message.sender.name} · ${shortId(message.sender.logicalId)}`;
		head.append(sender);
	}
	const purpose = document.createElement("span");
	purpose.className = `inbox-purpose ${message.purpose}`;
	purpose.textContent = purposeLabel(message.purpose);
	const stateNode = document.createElement("span");
	stateNode.className = `inbox-sender-status ${status}`;
	stateNode.textContent = status;
	head.append(purpose, stateNode);
	card.append(head);

	const subject = document.createElement("div");
	subject.className = "inbox-subject";
	subject.textContent = message.subject;
	card.append(subject);

	const meta = document.createElement("div");
	meta.className = "inbox-meta";
	meta.textContent = `${relativeTime(Date.parse(message.createdAt))} · ${message.readAt ? "read" : "unread"}${
		message.archivedAt ? " · archived" : ""
	}`;
	card.append(meta);

	const expanded = sheetState.expanded === message.id;
	const body = document.createElement("div");
	body.className = expanded ? "inbox-body" : "inbox-body preview";
	body.textContent = expanded ? message.body : message.body.split("\n")[0].slice(0, 180);
	card.append(body);

	const actions = document.createElement("div");
	actions.className = "inbox-actions";
	const archive = document.createElement("button");
	archive.type = "button";
	archive.textContent = message.archivedAt ? "restore" : "archive";
	archive.addEventListener("click", (event) => {
		event.stopPropagation();
		void toggleArchive(message);
	});
	const remove = document.createElement("button");
	remove.type = "button";
	remove.className = "danger";
	remove.textContent = "delete";
	remove.addEventListener("click", (event) => {
		event.stopPropagation();
		confirmDelete(message);
	});
	actions.append(archive, remove);
	card.append(actions);

	card.addEventListener("click", () => {
		sheetState.expanded = expanded ? null : message.id;
		if (!expanded && !message.readAt) void markRead(message);
		else renderInboxSheet();
	});
	return card;
}

async function markRead(message) {
	try {
		await inboxJson(`/api/inbox/${encodeURIComponent(message.id)}/read`, { method: "POST" });
		message.readAt = new Date().toISOString();
		sheetState.unread = Math.max(0, sheetState.unread - 1);
		renderInboxSheet();
	} catch (error) {
		toast(`mark read failed: ${error.message}`);
	}
}

async function markAllRead() {
	try {
		await inboxJson("/api/inbox/read-all", { method: "POST" });
		for (const message of sheetState.messages) if (!message.readAt) message.readAt = new Date().toISOString();
		sheetState.unread = 0;
		renderInboxSheet();
	} catch (error) {
		toast(`mark all failed: ${error.message}`);
	}
}

async function toggleArchive(message) {
	try {
		const restoring = Boolean(message.archivedAt);
		await inboxJson(`/api/inbox/${encodeURIComponent(message.id)}/${restoring ? "restore" : "archive"}`, {
			method: "POST",
		});
		message.archivedAt = restoring ? null : new Date().toISOString();
		sheetState.expanded = null;
		await loadInbox();
		renderInboxSheet();
		toast(restoring ? "restored" : "archived");
	} catch (error) {
		toast(`archive failed: ${error.message}`);
	}
}

function confirmDelete(message) {
	ui.sheet.hidden = false;
	ui.sheet.textContent = "";
	ui.sheet.append(sheetHeader("delete message"));
	const note = document.createElement("div");
	note.className = "sheet-text";
	note.textContent = `Delete “${message.subject}”? This cannot be undone.`;
	const actions = document.createElement("div");
	actions.className = "sheet-actions";
	const confirm = document.createElement("button");
	confirm.type = "button";
	confirm.className = "danger";
	confirm.textContent = "delete";
	confirm.addEventListener("click", () => void removeMessage(message));
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "cancel";
	cancel.addEventListener("click", () => renderInboxSheet());
	actions.append(confirm, cancel);
	ui.sheet.append(note, actions);
}

async function removeMessage(message) {
	try {
		await inboxJson(`/api/inbox/${encodeURIComponent(message.id)}`, { method: "DELETE" });
		sheetState.expanded = null;
		await loadInbox();
		renderInboxSheet();
		toast("deleted");
	} catch (error) {
		toast(`delete failed: ${error.message}`);
	}
}

function openReply(message, session) {
	closeSheet();
	openSession(session.id);
	ui.input.value = replyPrefix(message.id);
	ui.input.dispatchEvent(new Event("input"));
	ui.input.focus();
}

/** The initial value for a fresh page; keeps the badge honest before frames. */
export function initialInbox() {
	state.inbox = emptyInbox();
	renderInboxBadge();
}
