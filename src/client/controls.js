// Client controls module; shared state lives in kernel/state.js.
import { restoreDistance } from "./scroll.js";
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
import { readingDistance } from "./transcriptScroll.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

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
		const distance = readingDistance(state.stick, ui.log.clientHeight, ui.log.scrollHeight, ui.log.scrollTop);
		state.scale = next;
		document.documentElement.style.setProperty("--transcript-scale", String(scaleFactor(next)));
		restoreDistance(distance);
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
