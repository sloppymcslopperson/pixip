// Dashboard entry point: reset the route state, load /api/info, then hand the
// session list to dashboardList. HTTP, rendering, picker and settings live in
// dashboardApi, dashboardList, dashboardPicker and dashboardSettings.
import { createAddonUi } from "./addonUi.js";
import { clearPendingAttachment } from "./composer.js";
import { closeMenu, renderQueue } from "./controls.js";
import { fetchInfo, listSessions } from "./dashboardApi.js";
import { renderList } from "./dashboardList.js";
import { resetSurface } from "./surface.js";
import { connect } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

export async function showList() {
	state.sessionId = null;
	ui.jump.hidden = true;
	state.info = null;
	state.pendingCreate = null;
	state.tools.clear();
	state.streaming = null;
	state.pendingUser = null;
	clearPendingAttachment();
	state.restarting = false;
	state.restartWasBusy = false;
	state.restartNoticePending = false;
	state.policy = null;
	state.dynamicCommands = [];
	state.queue = { steering: [], followUp: [] };
	renderQueue();
	closeMenu();
	state.bashRunning = false;
	state.quitting = false;
	state.bash.clear();
	state.entries = [];
	state.more = false;
	state.loadingEarlier = false;
	state.addon = createAddonUi();
	resetSurface();
	ui.session.hidden = true;
	ui.composer.hidden = true;
	ui.footer.hidden = true;
	ui.dock.hidden = true;
	ui.stop.hidden = true;
	ui.back.hidden = true;
	ui.settings.hidden = false;
	ui.list.hidden = false;
	ui.title.textContent = "sessions";
	ui.sub.textContent = "";
	ui.dot.className = "dot idle";
	ui.dot.hidden = true;
	document.title = "pixip";

	connect(null);

	const info = await fetchInfo();
	if (typeof info.defaultCwd === "string") state.defaultCwd = info.defaultCwd;
	if (typeof info.home === "string") state.home = info.home;
	const sessions = await listSessions();
	renderList(sessions, state.defaultCwd, state.home);
}
