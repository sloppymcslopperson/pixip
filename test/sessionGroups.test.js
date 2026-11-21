import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	countLabel,
	groupLabel,
	groupSessions,
	groupView,
	isActiveSession,
	isHot,
	isWarm,
	normalizeCwd,
	parseCollapsed,
	parseKeepActive,
	pinnedSessions,
	serializeCollapsed,
	serializeKeepActive,
} from "../src/client/sessionGroups.js";

const sessions = [
	{ id: "a1", cwd: "/home/x/proj/", state: "stopped", lastActivity: 100 },
	{ id: "a2", cwd: "/home/x/proj", state: "idle", lastActivity: 200 },
	{ id: "a3", cwd: "/home/x/proj", state: "stopped", lastActivity: 300 },
	{ id: "b1", cwd: "/home/x/other", state: "busy", lastActivity: 250 },
	{ id: "b2", cwd: "/home/x/other", state: "stopped", lastActivity: 150 },
	{ id: "c1", cwd: "", state: "start", lastActivity: 50 },
];

describe("groupSessions", () => {
	it("groups exact cwd with trailing slashes trimmed", () => {
		const groups = groupSessions(sessions);
		assert.deepEqual(
			groups.map((group) => group.key),
			["/home/x/proj", "/home/x/other", ""],
		);
		assert.deepEqual(
			groups[0].sessions.map((session) => session.id),
			["a3", "a2", "a1"],
		);
		assert.equal(groups[0].cwd, "/home/x/proj");
	});

	it("orders groups by their newest activity, then key; rows then id", () => {
		const groups = groupSessions([
			{ id: "z", cwd: "/b", state: "stopped", lastActivity: 10 },
			{ id: "a", cwd: "/a", state: "stopped", lastActivity: 10 },
			{ id: "y", cwd: "/b", state: "stopped", lastActivity: 10 },
		]);
		assert.deepEqual(
			groups.map((group) => group.key),
			["/a", "/b"],
		);
		assert.deepEqual(
			groups[1].sessions.map((session) => session.id),
			["y", "z"],
		);
	});

	it("tolerates missing or malformed lists and entries", () => {
		assert.deepEqual(groupSessions(undefined), []);
		assert.deepEqual(groupSessions([null, "x", {}]), [{ key: "", cwd: "", sessions: [{}] }]);
	});
});

describe("pinning and collapse", () => {
	const groups = groupSessions(sessions);
	const proj = groups[0];
	const other = groups[1];
	const unknown = groups[2];

	it("classifies hot, warm and cold states", () => {
		assert.equal(isHot({ state: "busy" }), true);
		assert.equal(isHot({ state: "starting" }), true);
		assert.equal(isWarm({ state: "idle" }), true);
		assert.equal(isActiveSession({ state: "idle" }), true);
		assert.equal(isActiveSession({ state: "stopped" }), false);
		assert.equal(isActiveSession({ state: "error" }), false);
	});

	it("keeps every active session plus the newest cold one", () => {
		assert.deepEqual(
			pinnedSessions(proj).map((session) => session.id),
			["a3", "a2"],
		);
		assert.deepEqual(
			pinnedSessions(other).map((session) => session.id),
			["b1"],
		);
		assert.deepEqual(
			pinnedSessions(unknown).map((session) => session.id),
			["c1"],
		);
	});

	it("collapses to pinned rows and reports the hidden count", () => {
		assert.deepEqual(groupView(proj, true).rows.map((session) => session.id), ["a3", "a2"]);
		assert.equal(groupView(proj, true).hidden, 1);
		assert.equal(groupView(other, true).hidden, 1);
		assert.equal(groupView(unknown, true).hidden, 0);
	});

	it("hides every row when the pinning setting is off", () => {
		assert.deepEqual(groupView(proj, true, false).rows, []);
		assert.equal(groupView(proj, true, false).hidden, 3);
	});

	it("shows every row when expanded, regardless of the setting", () => {
		assert.equal(groupView(proj, false, false).rows.length, 3);
		assert.equal(groupView(proj, false, false).hidden, 0);
	});
});

describe("labels and storage", () => {
	it("formats counts with an optional hidden suffix", () => {
		assert.equal(countLabel(1), "1 session");
		assert.equal(countLabel(12), "12 sessions");
		assert.equal(countLabel(12, 5), "12 sessions · 5 hidden");
		assert.equal(countLabel(2, 0), "2 sessions");
	});

	it("shortens group labels under home and names the fallback", () => {
		const [proj] = groupSessions(sessions);
		assert.equal(groupLabel(proj, "/home/x"), "~/proj");
		assert.equal(groupLabel(proj, undefined), "/home/x/proj");
		assert.equal(groupLabel({ key: "" }, "/home/x"), "unknown cwd");
	});

	it("normalizes bucket keys without swallowing the root path", () => {
		assert.equal(normalizeCwd("/a/b/"), "/a/b");
		assert.equal(normalizeCwd("/"), "/");
		assert.equal(normalizeCwd("   "), "");
		assert.equal(normalizeCwd(undefined), "");
	});

	it("parses only boolean collapse entries and ignores bad JSON", () => {
		assert.deepEqual(parseCollapsed(JSON.stringify({ "/a": true, "/b": false, x: "yes" })), { "/a": true, "/b": false });
		assert.deepEqual(parseCollapsed("not json"), {});
		assert.deepEqual(parseCollapsed("[true]"), {});
		assert.deepEqual(parseCollapsed(null), {});
	});

	it("serializes collapse maps and keeps the pinning default on", () => {
		assert.deepEqual(JSON.parse(serializeCollapsed({ "/a": true, "/b": "no" })), { "/a": true });
		assert.equal(parseKeepActive(null), true);
		assert.equal(parseKeepActive("1"), true);
		assert.equal(parseKeepActive("0"), false);
		assert.equal(parseKeepActive("false"), false);
		assert.equal(serializeKeepActive(false), "0");
		assert.equal(serializeKeepActive(true), "1");
	});
});
