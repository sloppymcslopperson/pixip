// Shared session chrome: header/status/footer and the busy indicator. These are
// driven by frames, session effects, sheets and transcript, so they live below
// those features.
import { addonStatusText, addonWidgets } from "./addonUi.js";
import { contextLevel, footerPwdLine, footerStatsLeft, footerStatsRight } from "./footer.js";
import { ansiToHtml, escapeHtml } from "./render.js";
import { displayState } from "./sessionInfo.js";
import { openSession } from "./navigation.js";
import { scrollToEnd } from "./scroll.js";
import { refreshComposerState } from "./sendState.js";
import { connect } from "./transport.js";
import { hideThinkingIndicator } from "./transcriptView.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

export function renderAddonWidgets(container, placement) {
	const widgets = addonWidgets(state.addon, placement);
	container.hidden = widgets.length === 0;
	container.textContent = "";
	for (const widget of widgets) {
		const row = document.createElement("div");
		row.className = "addon-widget";
		row.dataset.key = widget.key;
		// Addon text may carry ANSI styling; ansiToHtml escapes all markup.
		row.innerHTML = ansiToHtml(widget.lines.join("\n"));
		container.append(row);
	}
}

export function renderFooter() {
	const footer = state.footer;
	const status = addonStatusText(state.addon);
	ui.footerStatuses.hidden = status.length === 0;
	ui.footerStatuses.innerHTML = ansiToHtml(status);
	renderAddonWidgets(ui.footerAbove, "above");
	renderAddonWidgets(ui.footerBelow, "below");
	if (!footer) return;
	const pwd = ui.footer.querySelector(".pwd");
	const left = ui.footer.querySelector(".left");
	const right = ui.footer.querySelector(".right");
	pwd.textContent = footerPwdLine(footer);
	left.textContent = footerStatsLeft(footer);
	left.dataset.level = contextLevel(footer);
	right.textContent = footerStatsRight(footer);
}

/** Peer notice lives in the transcript, but not in history: reset per open. */
let peerDismissedFor = null;

function peerKey(info) {
	return String(info?.logicalId ?? info?.id ?? "");
}

export function resetPeerNotice() {
	peerDismissedFor = null;
	ui.log.querySelector(":scope > .peer-notice")?.remove();
}

export function renderPeerNotice() {
	const info = state.info;
	const peers = Array.isArray(info?.peers) ? info.peers : [];
	const existing = ui.log.querySelector(":scope > .peer-notice");
	if (!info || peers.length === 0 || peerDismissedFor === peerKey(info)) {
		existing?.remove();
		return;
	}
	const notice = existing ?? document.createElement("div");
	notice.className = "block peer-notice";
	notice.textContent = "";
	const label = document.createElement("span");
	label.className = "peer-label";
	label.textContent = peers.length === 1 ? "another agent here:" : "other agents here:";
	notice.append(label);
	for (const peer of peers) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "peer-open";
		button.textContent = peer.name || String(peer.id ?? "").slice(0, 8);
		button.title = "Open this agent";
		button.addEventListener("click", () => openSession(peer.id));
		notice.append(button);
	}
	const dismiss = document.createElement("button");
	dismiss.type = "button";
	dismiss.className = "peer-dismiss";
	dismiss.setAttribute("aria-label", "Dismiss peer notice");
	dismiss.textContent = "×";
	dismiss.addEventListener("click", () => {
		peerDismissedFor = peerKey(info);
		notice.remove();
	});
	notice.append(dismiss);
	if (ui.log.firstElementChild !== notice) ui.log.prepend(notice);
}

export function applyInfo() {
	const info = state.info;
	if (!info) return;
	const restarting = state.restarting;
	const name = info.name ?? info.id.slice(0, 8);
	const viewState = displayState(info);
	const stateLabel = viewState === "waiting" ? "waiting for you" : info.state;
	ui.title.textContent = name;
	document.title = `${name} · pixip`;
	// Separators live inside the `.wide` wrapper so hiding it on narrow screens
	// does not leave dangling "· ·" separators behind.
	let subtitle = escapeHtml(restarting ? "restarting…" : stateLabel);
	const wide = [info.model, info.thinkingLevel].filter(Boolean).map((part) => escapeHtml(part));
	if (wide.length > 0) subtitle += ` · <span class="wide">${wide.join(" · ")}</span>`;
	if (info.messageCount) subtitle += ` · ${info.messageCount} msg`;
	ui.sub.innerHTML = subtitle;
	ui.sub.title = [restarting ? "restarting" : stateLabel, info.model, info.thinkingLevel].filter(Boolean).join(" · ");
	ui.dot.hidden = false;
	ui.dot.className = `dot ${restarting ? "busy" : viewState}`;
	const stopped = !restarting && (info.state === "stopped" || info.state === "error");
	const starting = !restarting && info.state === "starting";
	if (stopped || starting) hideThinkingIndicator();
	refreshComposerState();
	renderPeerNotice();
	// The provisional transcript is already readable; this only says the child
	// is still booting and live events have not started yet.
	let startingHint = ui.log.querySelector(".starting");
	if (starting && !startingHint) {
		startingHint = document.createElement("div");
		startingHint.className = "block meta starting";
		startingHint.textContent = "starting pi…";
		ui.log.append(startingHint);
		scrollToEnd();
	} else if (!starting) {
		startingHint?.remove();
	}
	if (stopped && !ui.log.querySelector(".wake")) {
		const wake = document.createElement("button");
		wake.className = "row wake";
		wake.textContent = info.state === "error" ? "restart session" : "wake session";
		wake.addEventListener("click", () => connect(state.sessionId));
		ui.log.append(wake);
		scrollToEnd();
	} else if (!stopped) {
		ui.log.querySelector(".wake")?.remove();
	}
}

export function setBusy(busy) {
	if (state.info) {
		state.info.state = busy ? "busy" : "idle";
		applyInfo();
	}
}
