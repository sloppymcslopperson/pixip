// Explicit navigation intents for dashboard <-> session. The composition root
// installs the handlers, so feature modules never import one another just to
// change route.
let handlers = {};

export function configureNavigation(next) {
	handlers = next ?? {};
}

export function openSession(id) {
	return handlers.openSession?.(id);
}

export function showList() {
	return handlers.showList?.();
}

export function showInbox() {
	return handlers.showInbox?.();
}

export function beginNewSession(cwd, worktree) {
	return handlers.beginNewSession?.(cwd, worktree);
}

export function cacheCurrentSession() {
	return handlers.cacheCurrentSession?.();
}

export function forgetCachedSession(session) {
	return handlers.forgetCachedSession?.(session);
}

export function route() {
	const match = /^#s=(.+)$/.exec(location.hash);
	const id = match ? decodeURIComponent(match[1]) : null;
	if (id) openSession(id);
	else if (location.hash === "#inbox") void showInbox();
	else if (location.hash === "#new") {
		// A reload lands here without a create in flight: fall back to the dashboard.
		if (!handlers.hasPendingCreate?.()) {
			history.replaceState(null, "", "");
			void showList();
		}
	} else void showList();
}
