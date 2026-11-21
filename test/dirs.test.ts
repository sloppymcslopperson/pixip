import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	createDirectory,
	DirError,
	isWithin,
	listDirectories,
	resolveDirPath,
	sortDirEntries,
	validateNewDirName,
} from "../src/dirs.ts";

const roots: string[] = [];

async function tempRoot(prefix = "pixip-dirs-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

async function homeWithProjects(): Promise<string> {
	const home = await tempRoot();
	await mkdir(join(home, "alpha"));
	await mkdir(join(home, "alpha", ".git"));
	await mkdir(join(home, "Beta"));
	await mkdir(join(home, "zeta"));
	await mkdir(join(home, ".hidden"));
	await writeFile(join(home, "file.txt"), "not a directory");
	const outside = await tempRoot("pixip-dirs-outside-");
	await symlink(outside, join(home, "escape"));
	return home;
}

after(async () => {
	for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe("dir path helpers", () => {
	it("resolves ~, absolute and home-relative input", () => {
		assert.equal(resolveDirPath("~/proj", "/home/x"), "/home/x/proj");
		assert.equal(resolveDirPath("proj", "/home/x"), "/home/x/proj");
		assert.equal(resolveDirPath("/tmp", "/home/x"), "/tmp");
		assert.equal(resolveDirPath("", "/home/x"), "/home/x");
		assert.equal(resolveDirPath(null, "/home/x"), "/home/x");
	});

	it("checks containment without matching sibling prefixes", () => {
		assert.equal(isWithin("/home/x", "/home/x"), true);
		assert.equal(isWithin("/home/x", "/home/x/proj"), true);
		assert.equal(isWithin("/home/x", "/home/xy"), false);
		assert.equal(isWithin("/", "/etc"), true);
	});

	it("sorts repo roots first then case-insensitive names", () => {
		const entries = [
			{ name: "zeta", path: "/z", repo: false },
			{ name: "alpha", path: "/a", repo: false },
			{ name: "repo", path: "/r", repo: true },
			{ name: "Beta", path: "/b", repo: false },
		];
		assert.deepEqual(
			sortDirEntries(entries).map((entry) => entry.name),
			["repo", "alpha", "Beta", "zeta"],
		);
	});

	it("accepts one visible path segment only", () => {
		assert.equal(validateNewDirName("new folder"), "new folder");
		for (const name of ["", ".", "..", ".hidden", "a/b", "a\\b", " x", "x "]) {
			assert.throws(() => validateNewDirName(name), DirError);
		}
		assert.throws(() => validateNewDirName(undefined), DirError);
	});
});

describe("listDirectories", () => {
	it("lists visible directories, repo first, from a home-relative path", async () => {
		const home = await homeWithProjects();
		const listing = await listDirectories("~", home);
		const real = await realpath(home);
		assert.equal(listing.path, real);
		assert.equal(listing.home, real);
		assert.equal(listing.parent, null);
		assert.deepEqual(
			listing.entries.map((entry) => [entry.name, entry.repo]),
			[
				["alpha", true],
				["Beta", false],
				["zeta", false],
			],
		);
	});

	it("navigates a relative child and reports its parent", async () => {
		const home = await homeWithProjects();
		const listing = await listDirectories("alpha", home);
		assert.equal(listing.path, join(await realpath(home), "alpha"));
		assert.equal(listing.parent, await realpath(home));
		assert.deepEqual(listing.entries, []);
	});

	it("refuses paths outside home and missing directories", async () => {
		const home = await homeWithProjects();
		await assert.rejects(() => listDirectories("/", home), (error: unknown) => {
			return error instanceof DirError && error.status === 403;
		});
		await assert.rejects(() => listDirectories(join(home, ".."), home), (error: unknown) => {
			return error instanceof DirError && error.status === 403;
		});
		await assert.rejects(() => listDirectories(join(home, "missing"), home), (error: unknown) => {
			return error instanceof DirError && error.status === 404;
		});
	});
});

describe("createDirectory", () => {
	it("creates one folder under the current directory", async () => {
		const home = await homeWithProjects();
		const real = await realpath(home);
		const created = await createDirectory("~", "made", home);
		assert.equal(created.path, join(real, "made"));
		const listing = await listDirectories("~", home);
		assert.ok(listing.entries.some((entry) => entry.name === "made"));
	});

	it("rejects duplicates, traversal and paths outside home", async () => {
		const home = await homeWithProjects();
		await createDirectory("~", "made", home);
		await assert.rejects(() => createDirectory("~", "made", home), (error: unknown) => {
			return error instanceof DirError && error.status === 409;
		});
		await assert.rejects(() => createDirectory("~", "../made", home), (error: unknown) => {
			return error instanceof DirError && error.status === 400;
		});
		await assert.rejects(() => createDirectory("/", "made", home), (error: unknown) => {
			return error instanceof DirError && error.status === 403;
		});
	});
});
