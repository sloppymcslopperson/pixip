import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeSources, checkClientImports } from "../tools/check-client-imports.mjs";

describe("client import guard", () => {
	it("passes the real client graph", async () => {
		const { graph, violations } = await checkClientImports();
		assert.ok(graph.size > 0);
		assert.deepEqual(violations, []);
	});

	it("rejects a synthetic cycle, including dynamic imports", () => {
		const { violations } = analyzeSources({
			a: 'import "./b.js";',
			b: 'export const load = () => import("./a.js");',
		});
		assert.ok(
			violations.some((violation) => violation.startsWith("cycle: ")),
			violations.join("\n"),
		);
	});

	it("rejects a forbidden cross-cluster import", () => {
		const { violations } = analyzeSources({
			dashboard: 'import "./session.js";',
			session: "",
		});
		assert.ok(
			violations.some((violation) => violation.includes("dashboard (dashboard) imports session (session)")),
			violations.join("\n"),
		);
	});

	it("rejects a non-feature module importing a feature handler", () => {
		const { violations } = analyzeSources({
			transcript: 'import "./dashboard.js";',
			dashboard: "",
		});
		assert.ok(
			violations.some((violation) => violation.includes("transcript imports feature module dashboard")),
			violations.join("\n"),
		);
	});

	it("allows same-cluster siblings and kernel imports", () => {
		const { violations } = analyzeSources({
			dashboardList: 'import "./dashboardModel.js";\nimport "./kernel/state.js";',
			dashboardModel: "",
			"kernel/state": "",
		});
		assert.deepEqual(violations, []);
	});

	it("rejects importing the composition root", () => {
		const { violations } = analyzeSources({
			session: 'import "./app.js";',
			app: "",
		});
		assert.ok(
			violations.some((violation) => violation.includes("session imports app.js")),
			violations.join("\n"),
		);
	});
});
