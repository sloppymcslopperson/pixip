import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	archivedCount,
	badgeLabel,
	capLevel,
	capThresholds,
	emptyInbox,
	filterMessages,
	inboxVisible,
	mergeWarnings,
	mergeInboxSummary,
	newCapWarnings,
	newestPreview,
	normalizeInbox,
	purposeLabel,
	replyPrefix,
	replySession,
	senderStatusFor,
	shortId,
} from "../src/client/inboxModel.js";

function message(id, overrides = {}) {
	return {
		id,
		subject: `subject ${id}`,
		body: "body",
		purpose: "attention-needed",
		createdAt: `2026-11-21T00:00:0${id}.000Z`,
		readAt: null,
		archivedAt: null,
		sender: { logicalId: `session-${id}`, name: `sender ${id}` },
		...overrides,
	};
}

describe("inbox model", () => {
	it("normalizes summaries and keeps the badge compact", () => {
		assert.deepEqual(normalizeInbox({ unread: 2, total: 7, limit: 20, newest: { id: "x" } }), {
			unread: 2,
			total: 7,
			limit: 20,
			newest: { id: "x" },
			extension: false,
		});
		assert.equal(normalizeInbox(undefined).limit, 200);
		assert.equal(badgeLabel(0), "");
		assert.equal(badgeLabel(3), "3");
		assert.equal(badgeLabel(120), "99+");
		assert.equal(shortId("abcdef123"), "abcdef12");
		assert.equal(purposeLabel("extra-info"), "extra info");
		assert.deepEqual(newestPreview(null), { subject: "inbox", preview: "no messages yet" });
		assert.deepEqual(newestPreview({ subject: "Subject", body: "line one\nline two", sender: { name: "Sam" } }), {
			subject: "Subject",
			preview: "line one line two",
		});
	});

	it("shows the bar only for a message or an announced extension", () => {
		assert.equal(inboxVisible(emptyInbox()), false);
		assert.equal(inboxVisible(undefined), false);
		assert.equal(inboxVisible({ unread: 0, total: 0, limit: 200, newest: null, extension: true }), true);
		assert.equal(inboxVisible({ unread: 1, total: 1, limit: 200, newest: message(1) }), true);
		assert.equal(inboxVisible({ unread: 0, total: 1, limit: 200, newest: message(1) }), true);
		// Archived-only inboxes (total > 0, no visible newest) stay hidden.
		assert.equal(inboxVisible({ unread: 0, total: 3, limit: 200, newest: null }), false);
	});

	it("keeps the visible summary when a list snapshot updates the counts", () => {
		// The list response carries no newest message and no addon flag; replacing
		// the summary with it hid the bar as soon as the inbox page was opened.
		const bar = { unread: 1, total: 2, limit: 200, newest: message(1), extension: true };
		const merged = mergeInboxSummary(bar, { unread: 0, total: 2, limit: 200, messages: [] });
		assert.deepEqual(merged, { unread: 0, total: 2, limit: 200, newest: message(1), extension: true });
		assert.equal(inboxVisible(merged), true);

		// Without a previous summary it still yields a usable shape.
		assert.deepEqual(mergeInboxSummary(undefined, { unread: 3, total: 3, limit: 20 }), {
			unread: 3,
			total: 3,
			limit: 20,
			newest: null,
			extension: false,
		});
	});

	it("grades the cap and only warns once per threshold", () => {
		assert.equal(capLevel(0, 200), "ok");
		assert.equal(capLevel(99, 200), "ok");
		assert.equal(capLevel(100, 200), "warn");
		assert.equal(capLevel(197, 200), "warn");
		assert.equal(capLevel(198, 200), "full");
		assert.deepEqual(capThresholds("ok"), []);
		assert.deepEqual(capThresholds("warn"), ["half"]);
		assert.deepEqual(capThresholds("full"), ["half", "full"]);
		assert.deepEqual(newCapWarnings("full", ["half"]), ["full"]);
		assert.deepEqual(newCapWarnings("full", []), ["half", "full"]);
		assert.deepEqual(mergeWarnings(["half"], ["full"]), ["half", "full"]);
	});

	it("filters by archive, read state and purpose, newest first", () => {
		const messages = [
			message("1"),
			message("2", { readAt: "2026-11-22T00:00:00.000Z" }),
			message("3", { purpose: "deliverable" }),
			message("4", { archivedAt: "2026-11-22T00:00:00.000Z" }),
		];
		assert.deepEqual(
			filterMessages(messages).map((item) => item.id),
			["3", "2", "1"],
		);
		assert.deepEqual(
			filterMessages(messages, { filter: "unread" }).map((item) => item.id),
			["3", "1"],
		);
		assert.deepEqual(
			filterMessages(messages, { purpose: "deliverable" }).map((item) => item.id),
			["3"],
		);
		assert.deepEqual(
			filterMessages(messages, { archived: true }).map((item) => item.id),
			["4"],
		);
		assert.equal(archivedCount(messages), 1);
	});

	it("resolves sender status and only replies to addressable sessions", () => {
		const sessions = [
			{ id: "p1", logicalId: "a", state: "busy" },
			{ id: "p2", logicalId: "b", state: "idle" },
			{ id: "p3", logicalId: "c", state: "stopped" },
		];
		assert.equal(senderStatusFor({ logicalId: "a" }, sessions), "running");
		assert.equal(senderStatusFor({ logicalId: "b" }, sessions), "idle");
		assert.equal(senderStatusFor({ logicalId: "c" }, sessions), "stopped");
		assert.equal(senderStatusFor({ logicalId: "gone" }, sessions), "deleted");
		assert.equal(replySession({ logicalId: "c" }, sessions)?.id, "p3");
		assert.equal(replySession({ logicalId: "gone" }, sessions), null);
		assert.equal(replyPrefix("abcdef123456"), "[inbox abcdef12] ");
	});
});
