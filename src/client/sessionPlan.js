// Pure frame-effect plans for session.js/sessionEffects.js. No DOM, no state.

/** What a snapshot means for resume/replace/painting and restart notices. */
export function snapshotPlan(frame, view) {
	const wasRestarting = Boolean(view?.restarting);
	return {
		wasRestarting,
		interrupted: wasRestarting && Boolean(view?.restartWasBusy),
		resetLive: wasRestarting,
		render: frame?.resume === true ? "resume" : frame?.replace === true ? "replace" : "snapshot",
		repaint: wasRestarting,
	};
}

/** Route/open/reattach decision for an `opened` frame. */
export function openedPlan(frame, view) {
	const id = frame?.session?.id;
	if (typeof id !== "string") return { act: "ignore" };
	if (view?.pendingCreate) return { act: "open", id };
	if (view?.sessionId && view?.connected) {
		const changed = view.sessionId !== id;
		return {
			act: "reattach",
			id,
			previousId: view.sessionId,
			changed,
			rekey: frame.rekey === true && changed,
		};
	}
	return { act: "route", id };
}

/** Whether a status frame applies to this route and ends a soft quit. */
export function statusPlan(frame, view) {
	const id = frame?.session?.id;
	if (!(id === view?.sessionId || !view?.sessionId)) return { act: "ignore" };
	return { act: "apply", quit: Boolean(view?.quitting && frame.session.state === "stopped") };
}

/** Reconnect delay/action for a socket close. */
export function closePlan(view) {
	if (view?.pendingCreate) return { act: "fail" };
	if (!view?.sessionId) return { act: "none" };
	const retries = Math.max(0, Number(view.retries) || 0);
	return { act: "reconnect", delay: Math.min(2000, 200 * 2 ** retries) };
}
