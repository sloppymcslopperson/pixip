// `--watch` browser side: the "reload deferred" card. It is local UI only and
// disappears as soon as the daemon reloads; the watcher keeps polling unless the
// user explicitly says they will reissue the reload later.
import { appendPauseTimeoutCard } from "./transcript.js";
import { send } from "./transport.js";

let card = null;

function clear() {
	card?.remove();
	card = null;
}

/**
 * A `watchDeferred` notice paints (or refreshes) the card. Any reload notice
 * dismisses it because the daemon is about to swap assets and refresh the page.
 */
export function handleWatchNotice(frame) {
	if (frame.watchDeferred === true) {
		clear();
		card = appendPauseTimeoutCard(String(frame.text ?? "watch reload deferred"), [
			{
				id: "keep",
				label: "Keep waiting",
				onClick: () => {
					card = null;
				},
			},
			{
				id: "reissue",
				label: "I'll reissue later",
				onClick: () => {
					card = null;
					send({ t: "watch_cancel" });
				},
			},
		]);
		return true;
	}
	if (frame.watchDeferred === false || frame.reload === true) clear();
	return false;
}
