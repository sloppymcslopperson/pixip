// Pure `/reload` notice persistence. Kept DOM-free so the client tests can cover
// the one-shot handoff across the forced page reload.
const STORAGE_PREFIX = "pixip.reload.notice.";

/** Storage key for one session's post-reload row. */
export function reloadNoticeKey(id) {
	return `${STORAGE_PREFIX}${id}`;
}

/** Remember one notice across the forced page reload (storage failures are fine). */
export function rememberReloadNotice(storage, id, text) {
	try {
		storage.setItem(reloadNoticeKey(id), text);
	} catch {
		// private mode/storage full: the row is still visible until the reload
	}
}

/** Take the remembered row once, so a later reconnect does not duplicate it. */
export function takeReloadNotice(storage, id) {
	try {
		const text = storage.getItem(reloadNoticeKey(id));
		if (text) storage.removeItem(reloadNoticeKey(id));
		return text;
	} catch {
		return null;
	}
}
