// The client's single shared mutable store. It is intentionally flat: slices
// are documented groupings, not separate reactive stores. Feature modules import
// this object directly; nothing here touches the DOM (that is kernel/ui.js).
import { createAddonUi } from "../addonUi.js";
import { createSessionCache } from "../sessionCache.js";
import { COLLAPSED_STORAGE_KEY, KEEP_ACTIVE_STORAGE_KEY, parseCollapsed, parseKeepActive } from "../sessionGroups.js";
import { DEFAULT_PERCENT } from "../transcriptScale.js";

/** Dashboard collapse state from device-local storage; never throws. */
export function readCollapsedGroups() {
	try {
		return parseCollapsed(localStorage.getItem(COLLAPSED_STORAGE_KEY));
	} catch {
		return {};
	}
}

/** Dashboard pinning preference from device-local storage; never throws. */
export function readKeepActive() {
	try {
		return parseKeepActive(localStorage.getItem(KEEP_ACTIVE_STORAGE_KEY));
	} catch {
		return true;
	}
}

export const state = {
	// connection: the live session, socket and reconnect bookkeeping.
	sessionId: null,
	sessionCache: createSessionCache(8), // recently viewed transcripts, in-memory only
	info: null,
	ws: null,
	retries: 0,
	restarting: false, // old daemon announced a restart; socket is about to close
	restartWasBusy: false, // a turn was in flight when the restart was announced
	restartNoticePending: false, // paint the interruption notice after the reconnect snapshot

	// dashboard: the session list and its directory/settings state.
	inbox: { unread: 0, total: 0, limit: 200, newest: null }, // live badge summary from the hub
	home: "", // $HOME for dashboard path shortening (device-local cache)
	defaultCwd: "", // last discovery value, so list refreshes do not clear the form
	sessions: [], // last dashboard list, for local re-renders
	collapsed: readCollapsedGroups(), // cwd key -> true when collapsed
	keepActive: readKeepActive(), // pin hot/warm/newest when collapsed
	pendingCreate: null, // dashboard `new` action waiting for the first session id

	// session: the transcript window and live event state.
	stick: true,
	streaming: null, // { section, text }
	pendingUser: null,
	tools: new Map(), // toolCallId -> <details>
	renderQueued: false,
	footer: null,
	bashRunning: false,
	quitting: false,
	bash: new Map(), // bash id -> optimistic card, matched by event id
	entries: [], // what the client currently knows, oldest first
	more: false, // older entries exist before entries[0]
	loadingEarlier: false,

	// composer: the pending attachment and command/menu/queue state.
	pendingAttachment: null, // one image or file, never both: { kind, name, size, ... }
	attachmentSeq: 0, // invalidates an in-flight image prepare/upload after replace/clear
	dynamicCommands: [], // live get_commands entries for the `/` menu
	menu: { items: [], index: 0 },
	queue: { steering: [], followUp: [] }, // Pi's pending steer/follow-up texts
	policy: null, // effective per-session command policy (hub-resolved)

	// addon/panel: Pi extension status/widgets and device-local presentation.
	addon: createAddonUi(), // Pi extension setStatus/setWidget state
	models: [],
	levels: [],
	scale: DEFAULT_PERCENT, // transcript text size, percent (device-local)
	coarse: window.matchMedia("(pointer: coarse)").matches,
};
