// Client controls module; shared state lives in kernel/state.js.
import { addonStatusText, addonWidgets } from "./addonUi.js";
import { contextLevel, footerPwdLine, footerStatsLeft, footerStatsRight } from "./footer.js";
import { ansiToHtml, escapeHtml } from "./render.js";
import { queueCount, queueTexts } from "./queue.js";
import { refreshSendState } from "./sendState.js";
import { toast } from "./toast.js";
import {
	DEFAULT_PERCENT,
	STEPS,
	STORAGE_KEY,
	clampPercent,
	decreaseLabel,
	increaseLabel,
	nextPercent,
	parseStored,
	previousPercent,
	scaleFactor,
} from "./transcriptScale.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";
import { connect, send } from "./transport.js";

export function readScale() {
	try {
		return parseStored(localStorage.getItem(STORAGE_KEY));
	} catch {
		// Storage can throw in private modes / blocked-cookie contexts.
		return DEFAULT_PERCENT;
	}
}

export function saveScale(percent) {
	try {
		localStorage.setItem(STORAGE_KEY, String(percent));
	} catch {}
}

export function setScale(percent, { persist = true } = {}) {
	const next = clampPercent(percent);
	if (next !== state.scale) {
		const distance = state.stick ? ui.log.clientHeight : ui.log.scrollHeight - ui.log.scrollTop;
		state.scale = next;
		document.documentElement.style.setProperty("--transcript-scale", String(scaleFactor(next)));
		ui.log.scrollTop = Math.max(0, ui.log.scrollHeight - distance);
	}
	if (persist) saveScale(next);
	updateScaleButtons();
}

export function updateScaleButtons() {
	ui.scaleDown.disabled = state.scale === STEPS[0];
	ui.scaleUp.disabled = state.scale === STEPS[STEPS.length - 1];
	ui.scaleDown.setAttribute("aria-label", decreaseLabel(state.scale));
	ui.scaleUp.setAttribute("aria-label", increaseLabel(state.scale));
	ui.scaleValue.textContent = `${state.scale}%`;
	ui.scaleValue.title = `Transcript text size: ${state.scale}%`;
}

export function bindScaleButton(button, step) {
	let timer = 0;
	let longPressed = false;
	const cancel = () => {
		clearTimeout(timer);
		timer = 0;
	};
	button.addEventListener("pointerdown", () => {
		cancel();
		longPressed = false;
		timer = setTimeout(() => {
			longPressed = true;
			timer = 0;
			setScale(DEFAULT_PERCENT);
		}, 550);
	});
	for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
		button.addEventListener(type, cancel);
	}
	button.addEventListener("contextmenu", (event) => event.preventDefault());
	button.addEventListener("click", () => {
		if (longPressed) {
			longPressed = false;
			return;
		}
		setScale(step === "up" ? nextPercent(state.scale) : previousPercent(state.scale));
	});
}

export async function softRefresh() {
	ui.reload.disabled = true;
	try {
		const response = await fetch("/api/refresh", { method: "POST" });
		const body = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(body.error ?? `refresh failed (${response.status})`);
		location.reload();
	} catch (error) {
		ui.reload.disabled = false;
		toast(`reload failed: ${error.message}`);
	}
}

export function setBarMenu(open) {
	ui.barMenu.hidden = !open;
	ui.more.setAttribute("aria-expanded", String(open));
}

/** Close the command menu without depending on the menu feature module. */
export function closeMenu() {
	const wasOpen = !ui.menu.hidden;
	ui.menu.hidden = true;
	state.menu.items = [];
	state.menu.index = 0;
	if (!wasOpen) return;
	ui.menu.textContent = "";
	scheduleScroll();
}

export function appendBlock(kind, html, raw = false) {
	const section = document.createElement(kind ? "section" : "div");
	if (kind) section.className = `block ${kind}`;
	if (raw) section.innerHTML = html;
	else section.textContent = html;
	ui.log.append(section);
	scheduleScroll();
	return section;
}

export function showThinkingIndicator() {
	if (ui.session.hidden) return;
	const existing = ui.log.querySelector(".thinking-indicator");
	if (existing) {
		// Keep it after the newest block (for example the real user message that
		// replaces the optimistic echo) without repainting it.
		if (existing !== ui.log.lastElementChild) ui.log.append(existing);
		return;
	}
	const section = document.createElement("div");
	section.className = "block meta thinking-indicator";
	section.textContent = "agent is thinking…";
	ui.log.append(section);
	scheduleScroll();
}

export function hideThinkingIndicator() {
	ui.log.querySelector(".thinking-indicator")?.remove();
}

export function setBusy(busy) {
	if (state.info) {
		state.info.state = busy ? "busy" : "idle";
		applyInfo();
	}
}

export function scrollToEnd(force = false) {
	if (force) state.stick = true;
	updateJump();
	scheduleScroll();
}

export function updateJump() {
	ui.jump.hidden = state.stick || ui.session.hidden;
}

export let scrollQueued = false;

export function scheduleScroll() {
	if (scrollQueued) return;
	scrollQueued = true;
	requestAnimationFrame(() => {
		scrollQueued = false;
		if (!state.stick) return;
		ui.log.scrollTop = ui.log.scrollHeight;
	});
}

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

export function applyInfo() {
	const info = state.info;
	if (!info) return;
	const restarting = state.restarting;
	const name = info.name ?? info.id.slice(0, 8);
	ui.title.textContent = name;
	document.title = `${name} · pixip`;
	// Separators live inside the `.wide` wrapper so hiding it on narrow screens
	// does not leave dangling "· ·" separators behind.
	let subtitle = escapeHtml(restarting ? "restarting…" : info.state);
	const wide = [info.model, info.thinkingLevel].filter(Boolean).map((part) => escapeHtml(part));
	if (wide.length > 0) subtitle += ` · <span class="wide">${wide.join(" · ")}</span>`;
	if (info.messageCount) subtitle += ` · ${info.messageCount} msg`;
	ui.sub.innerHTML = subtitle;
	ui.sub.title = [restarting ? "restarting" : info.state, info.model, info.thinkingLevel].filter(Boolean).join(" · ");
	ui.dot.hidden = false;
	ui.dot.className = `dot ${restarting ? "busy" : info.state}`;
	const stopped = !restarting && (info.state === "stopped" || info.state === "error");
	const starting = !restarting && info.state === "starting";
	if (stopped || starting) hideThinkingIndicator();
	ui.input.disabled = restarting || stopped || starting;
	ui.attach.disabled = restarting || stopped || starting;
	refreshSendState();
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

export function renderQueue() {
	const queue = state.queue;
	const count = queueCount(queue);
	if (count === 0) {
		if (ui.queue.hidden) return;
		ui.queue.hidden = true;
		ui.queue.textContent = "";
		scheduleScroll();
		return;
	}
	ui.queue.textContent = "";
	const head = document.createElement("div");
	head.className = "queue-head";
	const label = document.createElement("span");
	label.className = "queue-label";
	label.textContent = `${count} queued`;
	const clear = document.createElement("button");
	clear.type = "button";
	clear.className = "queue-clear";
	clear.setAttribute("aria-label", "Clear queued messages");
	clear.title = "clear and restore to the composer";
	clear.textContent = "×";
	clear.addEventListener("click", () => send({ t: "clear_queue" }));
	head.append(label, clear);

	const chips = document.createElement("div");
	chips.className = "queue-chips";
	for (const text of queueTexts(queue)) {
		const chip = document.createElement("button");
		chip.type = "button";
		chip.className = "queue-chip";
		chip.textContent = text;
		chip.title = "tap to expand";
		chip.addEventListener("click", () => chip.classList.toggle("expanded"));
		chips.append(chip);
	}
	ui.queue.append(head, chips);
	ui.queue.hidden = false;
	scheduleScroll();
}

export function resize() {
	ui.input.style.height = "auto";
	ui.input.style.height = `${Math.min(ui.input.scrollHeight, window.innerHeight * 0.4)}px`;
}
