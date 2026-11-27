// Inbox feature: dashboard bottom bar, dedicated inbox page, filters and
// sender replies. Everything user-visible is built with textContent; message
// bodies are never treated as HTML.
import { openSession } from "./navigation.js";
import { closeSheet, sheetHeader } from "./sheetShell.js";
import { toast } from "./toast.js";
import { connect } from "./transport.js";
import {
	archivedCount,
	badgeLabel,
	capLevel,
	emptyInbox,
	filterMessages,
	INBOX_PURPOSES,
	inboxVisible,
	mergeWarnings,
	newCapWarnings,
	newestPreview,
	normalizeInbox,
	mergeInboxSummary,
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

const viewState = {
	filter: "all",
	purpose: null,
	archived: false,
	expanded: null,
	messages: [],
	unread: 0,
	total: 0,
	limit: 200,
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

/** Dashboard bottom bar: newest subject/body preview plus the unread badge. */
export function renderInboxBar() {
	const badge = ui.inboxBadge;
	if (!badge) return;
	const label = badgeLabel(state.inbox.unread);
	const level = capLevel(state.inbox.total, state.inbox.limit);
	badge.textContent = label;
	badge.hidden = label === "";
	badge.classList.toggle("warn", level === "warn");
	badge.classList.toggle("full", level === "full");
	const { subject, preview } = newestPreview(state.inbox.newest);
	if (ui.inboxBarSubject) ui.inboxBarSubject.textContent = subject;
	if (ui.inboxBarPreview) ui.inboxBarPreview.textContent = preview;
	if (ui.inboxBar) {
		// The bar belongs to the dashboard list. The session view and the inbox
		// page hide the list, and a late frame must not re-show it there.
		ui.inboxBar.hidden = ui.list.hidden || !inboxVisible(state.inbox);
		const title =
			state.inbox.unread > 0 ? `Inbox · ${state.inbox.unread} unread` : `Inbox · ${state.inbox.total} message(s)`;
		ui.inboxBar.title = title;
		ui.inboxBar.setAttribute(
			"aria-label",
			state.inbox.unread > 0 ? `Open inbox, ${state.inbox.unread} unread` : "Open inbox",
		);
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

/** A live `inbox` frame: bar preview, badge, cap warning, and no reload. */
export function applyInboxFrame(summary) {
	state.inbox = normalizeInbox(summary);
	renderInboxBar();
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
	viewState.messages = Array.isArray(data.messages) ? data.messages : [];
	viewState.unread = normalized.unread;
	viewState.total = normalized.total;
	viewState.limit = normalized.limit;
	// The list response is the authoritative snapshot for counts; keep the newest
	// message and the addon flag, which only the summary/frame carries.
	state.inbox = mergeInboxSummary(state.inbox, data);
	renderInboxBar();
}

/**
 * The inbox is a real route (`#inbox`), not a sheet: it owns the main area and
 * the header's back button, exactly like a session page.
 */
export async function showInboxPage() {
	viewState.archived = false;
	viewState.expanded = null;
	ui.list.hidden = true;
	ui.session.hidden = true;
	ui.inboxPage.hidden = false;
	ui.inboxBar.hidden = true;
	ui.composer.hidden = true;
	ui.footer.hidden = true;
	ui.dock.hidden = true;
	ui.stop.hidden = true;
	ui.back.hidden = false;
	ui.settings.hidden = true;
	ui.dot.hidden = true;
	ui.title.textContent = "inbox";
	ui.sub.textContent = "durable messages";
	document.title = "inbox · pixip";
	connect(null);
	ui.inboxPage.textContent = "";
	const loading = document.createElement("div");
	loading.className = "inbox-empty";
	loading.textContent = "loading…";
	ui.inboxPage.append(loading);
	try {
		await loadInbox();
		renderInboxPage();
	} catch (error) {
		toast(`inbox failed: ${error.message}`);
		ui.inboxPage.textContent = "";
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

function renderInboxPage() {
	const target = ui.inboxPage;
	target.hidden = false;
	target.textContent = "";

	const toolbar = document.createElement("div");
	toolbar.className = "inbox-toolbar";
	const filters = document.createElement("div");
	filters.className = "inbox-filters";
	filters.append(
		chip("all", viewState.filter === "all", () => {
			viewState.filter = "all";
			renderInboxPage();
		}),
		chip("unread", viewState.filter === "unread", () => {
			viewState.filter = "unread";
			renderInboxPage();
		}),
	);
	for (const purpose of INBOX_PURPOSES) {
		filters.append(
			chip(purposeLabel(purpose), viewState.purpose === purpose, () => {
				viewState.purpose = viewState.purpose === purpose ? null : purpose;
				renderInboxPage();
			}),
		);
	}
	const archived = archivedCount(viewState.messages);
	filters.append(
		chip(`archived (${archived})`, viewState.archived, () => {
			viewState.archived = !viewState.archived;
			viewState.expanded = null;
			renderInboxPage();
		}),
	);
	toolbar.append(filters);
	if (!viewState.archived && viewState.unread > 0) {
		const markAll = document.createElement("button");
		markAll.type = "button";
		markAll.className = "inbox-mark-all";
		markAll.textContent = "mark all read";
		markAll.addEventListener("click", () => void markAllRead());
		toolbar.append(markAll);
	}
	target.append(toolbar);

	const list = document.createElement("div");
	list.className = "inbox-list";
	const visible = filterMessages(viewState.messages, viewState);
	if (visible.length === 0) {
		const empty = document.createElement("div");
		empty.className = "inbox-empty";
		empty.textContent = viewState.archived ? "no archived messages" : "no messages";
		list.append(empty);
	}
	for (const message of visible) list.append(renderCard(message));
	target.append(list);
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

	const expanded = viewState.expanded === message.id;
	const body = document.createElement("div");
	body.className = expanded ? "inbox-body" : "inbox-body preview";
	body.textContent = expanded ? message.body : message.body.split("\n")[0].slice(0, 180);
	card.append(body);

	const actions = document.createElement("div");
	actions.className = "inbox-actions";
	if (typeof message.reportName === "string" && message.reportName) {
		const report = document.createElement("a");
		report.className = "inbox-report";
		report.href = `/reports/${encodeURIComponent(message.reportName)}/`;
		report.target = "_blank";
		report.rel = "noopener noreferrer";
		report.textContent = "view report";
		report.addEventListener("click", (event) => event.stopPropagation());
		actions.append(report);
	}
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
		viewState.expanded = expanded ? null : message.id;
		if (!expanded && !message.readAt) void markRead(message);
		else renderInboxPage();
	});
	return card;
}

async function markRead(message) {
	try {
		await inboxJson(`/api/inbox/${encodeURIComponent(message.id)}/read`, { method: "POST" });
		message.readAt = new Date().toISOString();
		viewState.unread = Math.max(0, viewState.unread - 1);
		renderInboxPage();
	} catch (error) {
		toast(`mark read failed: ${error.message}`);
	}
}

async function markAllRead() {
	try {
		await inboxJson("/api/inbox/read-all", { method: "POST" });
		for (const message of viewState.messages) if (!message.readAt) message.readAt = new Date().toISOString();
		viewState.unread = 0;
		renderInboxPage();
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
		viewState.expanded = null;
		await loadInbox();
		renderInboxPage();
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
	cancel.addEventListener("click", () => renderInboxPage());
	actions.append(confirm, cancel);
	ui.sheet.append(note, actions);
}

async function removeMessage(message) {
	try {
		await inboxJson(`/api/inbox/${encodeURIComponent(message.id)}`, { method: "DELETE" });
		viewState.expanded = null;
		await loadInbox();
		renderInboxPage();
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

/** The initial value for a fresh page; keeps the bar honest before frames. */
export function initialInbox() {
	state.inbox = emptyInbox();
	renderInboxBar();
}
