import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	bulkArchiveTargets,
	draftInputValue,
	groupDisplay,
	inactiveSessions,
	pickerPlan,
	storedSheetModel,
} from "../src/client/dashboardModel.js";

describe("draftInputValue", () => {
	it("keeps an in-progress draft, including an empty string", () => {
		assert.equal(draftInputValue("/typed", "/fallback"), "/typed");
		assert.equal(draftInputValue("", "/fallback"), "");
	});

	it("falls back to the default cwd when the form is not mounted", () => {
		assert.equal(draftInputValue(undefined, "/fallback"), "/fallback");
		assert.equal(draftInputValue(undefined, undefined), "");
		assert.equal(draftInputValue(undefined, null), "");
	});
});

describe("inactiveSessions", () => {
	it("counts only stopped sessions", () => {
		const sessions = [{ state: "stopped" }, { state: "idle" }, { state: "stopped" }, {}];
		assert.deepEqual(inactiveSessions(sessions), [{ state: "stopped" }, { state: "stopped" }]);
	});

	it("tolerates a missing list", () => {
		assert.deepEqual(inactiveSessions(undefined), []);
		assert.deepEqual(inactiveSessions(null), []);
	});
});

describe("bulkArchiveTargets", () => {
	it("keeps the newest row of a group whose sessions are all stopped", () => {
		const sessions = [
			{ id: "a-new", cwd: "/a", state: "stopped", lastActivity: 300 },
			{ id: "a-old", cwd: "/a", state: "stopped", lastActivity: 100 },
			{ id: "b-old", cwd: "/b", state: "stopped", lastActivity: 50 },
			{ id: "b-live", cwd: "/b", state: "idle", lastActivity: 200 },
			{ id: "c", cwd: "/c", state: "stopped", lastActivity: 10 },
		];
		assert.deepEqual(
			bulkArchiveTargets(sessions).map((session) => session.id),
			["a-old", "b-old"],
		);
	});

	it("archives every stopped row when the group still has an active session", () => {
		const sessions = [
			{ id: "d-live", cwd: "/d", state: "busy", lastActivity: 400 },
			{ id: "d-new", cwd: "/d", state: "stopped", lastActivity: 300 },
			{ id: "d-old", cwd: "/d", state: "stopped", lastActivity: 200 },
		];
		assert.deepEqual(
			bulkArchiveTargets(sessions).map((session) => session.id),
			["d-new", "d-old"],
		);
	});

	it("leaves a one-session group alone and tolerates a missing list", () => {
		assert.deepEqual(bulkArchiveTargets([{ id: "only", cwd: "/e", state: "stopped" }]), []);
		assert.deepEqual(bulkArchiveTargets(undefined), []);
	});
});

describe("groupDisplay", () => {
	const group = {
		key: "/p",
		sessions: [
			{ id: "new", state: "stopped" },
			{ id: "old", state: "stopped" },
			{ id: "live", state: "idle" },
		],
	};

	it("toggles only when collapsing would hide a row", () => {
		const display = groupDisplay(group, true, true);
		assert.equal(display.canToggle, true);
		assert.deepEqual(
			display.view.rows.map((session) => session.id),
			["new", "live"],
		);
		assert.equal(display.view.hidden, 1);
	});

	it("reports no toggle for a group whose pinned rows are everything", () => {
		const small = {
			key: "/p",
			sessions: [
				{ id: "new", state: "stopped" },
				{ id: "live", state: "idle" },
			],
		};
		const display = groupDisplay(small, true, true);
		assert.equal(display.canToggle, false);
		assert.equal(display.view.hidden, 0);
	});

	it("treats collapsing with pinning off as hiding every row", () => {
		const display = groupDisplay(group, true, false);
		assert.equal(display.view.rows.length, 0);
		assert.equal(display.view.hidden, 3);
	});

	it("shows every row while expanded but still reports the collapse effect", () => {
		const display = groupDisplay(group, false, true);
		assert.equal(display.view.rows.length, 3);
		assert.equal(display.view.hidden, 0);
		assert.equal(display.canToggle, true);
	});
});

describe("pickerPlan", () => {
	it("prioritises loading over a stale listing", () => {
		const plan = pickerPlan(
			{ loading: true, listing: { path: "/p", entries: [{ name: "a" }] }, filter: "" },
			"/home/x",
		);
		assert.equal(plan.loading, true);
		assert.equal(plan.message, "loading…");
		assert.equal(plan.error, null);
		assert.deepEqual(plan.entries, []);
	});

	it("surfaces a notice when no directory could be loaded", () => {
		const plan = pickerPlan({ loading: false, listing: null, filter: "", notice: "denied" }, "/home/x");
		assert.equal(plan.message, "no directory loaded");
		assert.equal(plan.error, "denied");
	});

	it("plans the parent, filtered entries and empty message", () => {
		const plan = pickerPlan(
			{
				loading: false,
				notice: "stale",
				path: "/home/x/proj",
				listing: { path: "/home/x/proj", entries: [{ name: "Alpha" }, { name: "beta" }] },
				filter: "al",
			},
			"/home/x",
		);
		assert.equal(plan.parent, "/home/x");
		assert.deepEqual(
			plan.entries.map((entry) => entry.name),
			["Alpha"],
		);
		assert.equal(plan.error, "stale");
		assert.equal(plan.message, null);

		const empty = pickerPlan(
			{ loading: false, listing: { path: "/home/x/proj", entries: [] }, filter: "zzz" },
			"/home/x",
		);
		assert.equal(empty.message, "no matching directories");
	});

	it("prefers the listing's home for the parent boundary", () => {
		const plan = pickerPlan(
			{ loading: false, listing: { path: "/srv/a", home: "/srv", entries: [{ name: "b" }] }, filter: "" },
			"/home/x",
		);
		assert.equal(plan.parent, "/srv");
	});
});

describe("storedSheetModel", () => {
	it("models an empty archive and trash", () => {
		const archive = storedSheetModel("archive", [], "/home/x");
		assert.equal(archive.title, "archived (0)");
		assert.equal(archive.empty, "nothing archived");
		assert.equal(archive.archived, true);
		assert.deepEqual(archive.rows, []);

		const trash = storedSheetModel("trash", null, "/home/x");
		assert.equal(trash.title, "trash (0)");
		assert.equal(trash.empty, "trash is empty");
		assert.equal(trash.archived, false);
	});

	it("labels rows with the session name and cwd/time meta", () => {
		const model = storedSheetModel(
			"archive",
			[
				{ id: "abcdefghijklmnop", cwd: "/home/x/proj", lastActivity: Date.now() },
				{ id: "shortid", name: "named", cwd: "/srv", lastActivity: Date.now() },
			],
			"/home/x",
		);
		assert.deepEqual(
			model.rows.map((row) => row.name),
			["abcdefgh", "named"],
		);
		assert.match(model.rows[0].meta, /^~\/proj · now$/);
		assert.match(model.rows[1].meta, /^\/srv · now$/);
	});
});
