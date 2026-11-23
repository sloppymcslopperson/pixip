// Pure transcript scroll math: how far the reader is from the bottom, whether
// live output should follow, and where to restore after a repaint. No DOM.
export const STICK_DISTANCE = 80;

/** Raw signed distance from the newest content; negative while overscrolled. */
export function distanceFromBottom(clientHeight, scrollHeight, scrollTop) {
	return scrollHeight - scrollTop - clientHeight;
}

/** Live output follows while the reader is within the stick threshold. */
export function shouldStick(distance) {
	return distance < STICK_DISTANCE;
}

/** Target distance for a repaint: client height when pinned, else the offset. */
export function readingDistance(stick, clientHeight, scrollHeight, scrollTop) {
	return stick ? clientHeight : scrollHeight - scrollTop;
}

/** Scroll offset that restores a saved distance after content prepends. */
export function restoreScrollTop(distance, scrollHeight) {
	return Math.max(0, scrollHeight - distance);
}

/** The floating jump control hides when pinned or when no session is shown. */
export function jumpHidden(stick, sessionHidden) {
	return Boolean(stick || sessionHidden);
}
