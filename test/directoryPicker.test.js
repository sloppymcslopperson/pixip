import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	crumbTrail,
	filterDirEntries,
	initialDirectory,
	parentDirectory,
} from "../src/client/directoryPicker.js";

describe("initialDirectory", () => {
	it("uses the cwd only when it is inside home", () => {
		assert.equal(initialDirectory("/home/x/proj", "/home/x"), "/home/x/proj");
		assert.equal(initialDirectory("/home/xy/proj", "/home/x"), "/home/x");
		assert.equal(initialDirectory("/tmp", "/home/x"), "/home/x");
		assert.equal(initialDirectory("", "/home/x"), "/home/x");
	});

	it("tolerates a missing home or cwd", () => {
		assert.equal(initialDirectory("", ""), "");
		assert.equal(initialDirectory("/tmp", ""), "/tmp");
		assert.equal(initialDirectory(undefined, "/home/x"), "/home/x");
	});
});

describe("crumbTrail", () => {
	it("starts at ~ and walks down to the current path", () => {
		assert.deepEqual(crumbTrail("/home/x/proj/src", "/home/x"), [
			{ label: "~", path: "/home/x" },
			{ label: "proj", path: "/home/x/proj" },
			{ label: "src", path: "/home/x/proj/src" },
		]);
		assert.deepEqual(crumbTrail("/home/x", "/home/x"), [{ label: "~", path: "/home/x" }]);
	});

	it("falls back to one crumb for an unknown path", () => {
		assert.deepEqual(crumbTrail("/tmp", "/home/x"), [{ label: "/tmp", path: "/tmp" }]);
		assert.deepEqual(crumbTrail("", "/home/x"), []);
	});
});

describe("parentDirectory", () => {
	it("returns the parent but never walks above home", () => {
		assert.equal(parentDirectory("/home/x/proj/src", "/home/x"), "/home/x/proj");
		assert.equal(parentDirectory("/home/x/proj", "/home/x"), "/home/x");
		assert.equal(parentDirectory("/home/x", "/home/x"), null);
		assert.equal(parentDirectory("/tmp", "/home/x"), null);
	});
});

describe("filterDirEntries", () => {
	const entries = [{ name: "Alpha" }, { name: "beta" }, { name: "gamma" }];

	it("matches case-insensitively and returns the same list when empty", () => {
		assert.deepEqual(
			filterDirEntries(entries, "AL").map((entry) => entry.name),
			["Alpha"],
		);
		assert.deepEqual(
			filterDirEntries(entries, " a ").map((entry) => entry.name),
			["Alpha", "beta", "gamma"],
		);
		assert.equal(filterDirEntries(entries, ""), entries);
	});

	it("tolerates malformed lists and entries", () => {
		assert.deepEqual(filterDirEntries(undefined, "x"), []);
		assert.deepEqual(filterDirEntries([null, { name: "x" }], "x"), [{ name: "x" }]);
	});
});
