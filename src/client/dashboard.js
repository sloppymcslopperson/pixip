// Dashboard entry point: reset the route state, load /api/info, then hand the
// session list to dashboardList. HTTP, rendering, picker and settings live in
// dashboardApi, dashboardList, dashboardPicker and dashboardSettings.
import { createAddonUi } from "./addonUi.js";
import { installDeps } from "./configure.js";
import { closeMenu } from "./menuView.js";
import { renderQueue } from "./queueView.js";
import { fetchInfo, listSessions } from "./dashboardApi.js";
import { renderList } from "./dashboardList.js";
import { connect } from "./transport.js";
import { state } from "./kernel/state.js";
import { ui } from "./kernel/ui.js";

let deps;

export function configureDashboard(next) {
	deps = installDeps("dashboard", "configureDashboard", next, [
		"cacheCurrentSession",
		"clearPendingAttachment",
		"parkCurrentSession",
		"resetSurface",
	]);
}

export async function showList() {
	deps.cacheCurrentSession();
	deps.parkCurrentSession();
	state.sessionId = null;
	ui.jump.hidden = true;
	state.info = null;
	state.pendingCreate = null;
	state.tools.clear();
	state.streaming = null;
	state.pendingUser = null;
	deps.clearPendingAttachment();
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
	deps.resetSurface();
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
