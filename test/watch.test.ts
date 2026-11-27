import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { startWatch } from "../src/reload/watch.ts";
import type { ReloadReport } from "../src/reload.ts";
import { cleanupRoots, fixtureRoot } from "./helpers/harness.ts";

after(async () => {
	await cleanupRoots();
});

function report(overrides: Partial<ReloadReport> = {}): ReloadReport {
	return {
		ok: true,
		status: "ok",
		message: "reloaded assets; config (0 session(s)); index (0 session(s)); commands",
		blockers: [],
		children: [],
		reloaded: ["assets", "config", "index", "commands"],
		reloads: 1,
		...overrides,
	};
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for condition");
}

function fakeWatcher() {
	const listeners = new Map<string, (event: string, filename: string | null) => void>();
	const closed: string[] = [];
	return {
		factory: (root: string, onEvent: (event: string, filename: string | null) => void) => {
			listeners.set(root, onEvent);
			return {
				close: () => {
					closed.push(root);
				},
			};
		},
		trigger: (filename: string) => {
			for (const listener of listeners.values()) listener("change", filename);
		},
		closed,
	};
}

describe("--watch reload loop", () => {
	it("debounces a burst into one reload and ignores dependency paths", async () => {
		const paths = await fixtureRoot("pixip-watch-");
		const fake = fakeWatcher();
		const reloads: string[] = [];
		const watch = startWatch({
			roots: [paths.dir],
			reload: () => {
				reloads.push("reload");
				return Promise.resolve(report());
			},
			blockers: () => [],
			log: () => {},
			debounceMs: 10,
			createWatcher: fake.factory,
		});
		try {
			fake.trigger("src/client/app.js");
			fake.trigger("src/server.ts");
			fake.trigger("extensions/pixip-inbox/index.ts");
			fake.trigger("node_modules/pkg/index.js");
			fake.trigger("fit/open/01-x.md");
			await waitFor(() => reloads.length === 1);
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(reloads.length, 1);
		} finally {
			watch.close();
		}
		assert.deepEqual(fake.closed, [paths.dir]);
	});

	it("defers while sessions are busy, prompts, then reloads when idle", async () => {
		const paths = await fixtureRoot("pixip-watch-");
		const fake = fakeWatcher();
		let busy = true;
		let reloads = 0;
		const notices: Array<Record<string, unknown>> = [];
		const watch = startWatch({
			roots: [paths.dir],
			reload: () => {
				reloads += 1;
				return Promise.resolve(report());
			},
			blockers: () => (busy ? [{ id: "s1", name: "Busy session", reason: "busy" }] : []),
			log: () => {},
			notice: (text, extra = {}) => notices.push({ text, ...extra }),
			debounceMs: 5,
			busyPollMs: 10,
			busyPromptMs: 20,
			createWatcher: fake.factory,
		});
		try {
			fake.trigger("src/hub.ts");
			await waitFor(() => notices.some((notice) => notice["watchDeferred"] === true));
			assert.equal(reloads, 0);
			assert.match(String(notices.find((notice) => notice["watchDeferred"])?.["text"]), /Busy session/);

			busy = false;
			await waitFor(() => reloads === 1);
		} finally {
			watch.close();
		}
	});

	it("drops a deferred reload when the user will reissue it later", async () => {
		const paths = await fixtureRoot("pixip-watch-");
		const fake = fakeWatcher();
		let busy = true;
		let reloads = 0;
		const watch = startWatch({
			roots: [paths.dir],
			reload: () => {
				reloads += 1;
				return Promise.resolve(report());
			},
			blockers: () => (busy ? [{ id: "s1", reason: "busy" }] : []),
			log: () => {},
			debounceMs: 5,
			busyPollMs: 10,
			busyPromptMs: 10_000,
			createWatcher: fake.factory,
		});
		try {
			fake.trigger("src/hub.ts");
			await waitFor(() => reloads === 0 && busy);
			watch.cancel();
			busy = false;
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(reloads, 0);
		} finally {
			watch.close();
		}
	});

	it("surfaces a failed reload and keeps watching for the next edit", async () => {
		const paths = await fixtureRoot("pixip-watch-");
		const fake = fakeWatcher();
		let calls = 0;
		const notices: Array<Record<string, unknown>> = [];
		const watch = startWatch({
			roots: [paths.dir],
			reload: () => {
				calls += 1;
				return Promise.resolve(
					calls === 1
						? report({ ok: false, status: "error", message: "reload failed before any change: broken edit" })
						: report(),
				);
			},
			blockers: () => [],
			log: () => {},
			notice: (text, extra = {}) => notices.push({ text, ...extra }),
			debounceMs: 5,
			createWatcher: fake.factory,
		});
		try {
			fake.trigger("extensions/pixip-inbox/index.ts");
			await waitFor(() => notices.some((notice) => notice["watchError"] === true));
			fake.trigger("extensions/pixip-inbox/index.ts");
			await waitFor(() => calls === 2);
		} finally {
			watch.close();
		}
	});
});
