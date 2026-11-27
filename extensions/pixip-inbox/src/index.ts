/**
 * `inbox_send`: a durable message from an agent to the pixip dashboard inbox.
 *
 * Opt-in by design. The hub spawns the real `pi` binary, so loading this
 * extension (project extension set, package install or `-e`) is the only way it
 * becomes available; pixip adds no private extension API and the tool only
 * speaks the normal REST endpoint.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	announceInbox,
	INBOX_PURPOSES,
	INBOX_TOOL,
	type InboxPurpose,
	REPORT_ACTIONS,
	REPORT_TOOL,
	runInboxTool,
	runReportTool,
} from "./inbox.ts";

const PurposeSchema = Type.String({
	enum: [...INBOX_PURPOSES],
	description: "attention-needed, deliverable, extra-info or no-rush",
});

const InboxSendParams = Type.Object({
	subject: Type.String({ description: "Short subject the user scans in the inbox list (one line)" }),
	body: Type.String({
		description: "The message itself. Plain text, up to 8 KB. Put details, links and next steps here.",
	}),
	purpose: PurposeSchema,
	reportName: Type.Optional(
		Type.String({ description: "Attach this existing HTML report; the message gets a view-report link" }),
	),
});

const ReportParams = Type.Object({
	action: Type.Optional(
		Type.String({
			enum: [...REPORT_ACTIONS],
			description: "new, write, add_asset, remove_asset or show. Omit the whole call (or action) to print help.",
		}),
	),
	name: Type.Optional(Type.String({ description: "Report name: letters, digits, dash, underscore or dot" })),
	html: Type.Optional(Type.String({ description: "Complete index.html for action write (max 1 MiB)" })),
	existingHtml: Type.Optional(
		Type.String({
			description:
				"Exact current HTML from action show. Required when overwriting an existing report; omit on the first write.",
		}),
	),
	path: Type.Optional(Type.String({ description: "Absolute path to a local file for action add_asset" })),
	filename: Type.Optional(
		Type.String({ description: "Optional top-level destination filename for add_asset; defaults to the source name" }),
	),
	asset: Type.Optional(Type.String({ description: "Top-level asset filename to remove for action remove_asset" })),
});

export default function pixipInbox(pi: ExtensionAPI) {
	// Tell the hub this agent can reach the inbox, so the dashboard shows the bar
	// even before the first message. Fire-and-forget: load must never fail here.
	void announceInbox();

	pi.registerTool({
		name: INBOX_TOOL,
		label: "Send to inbox",
		description:
			"Send one durable message to the user's pixip dashboard inbox. The message outlives this session " +
			"and is visible in the inbox sheet. Pick a purpose: attention-needed (the user should act or decide), " +
			"deliverable (a finished result), extra-info (useful context), or no-rush (read later). Do not use " +
			"this for ordinary conversation; the transcript already carries that.",
		promptSnippet: "Leave a durable message in the pixip inbox",
		promptGuidelines: [
			"Use inbox_send when the user should see a result or question in the pixip dashboard after this session ends or from another device.",
			"Keep the subject short, put the detail in the body, and choose the purpose that matches how soon the user needs to look.",
		],
		parameters: InboxSendParams,
		async execute(_toolCallId, params) {
			return await runInboxTool({
				subject: params.subject,
				body: params.body,
				purpose: params.purpose as InboxPurpose,
				...(params.reportName ? { reportName: params.reportName } : {}),
			});
		},
	});

	pi.registerTool({
		name: REPORT_TOOL,
		label: "Manage inbox report",
		description:
			"Create and edit an HTML report hosted by pixip for the user's inbox. The report is a hub-owned " +
			"directory; edit it only through this tool. Actions: new (create), write (validate and replace " +
			"index.html), add_asset (copy a local image/CSS/font/SVG), remove_asset (remove an unused asset), " +
			"show (read the exact current HTML and assets). Reports are sandboxed: no JavaScript, iframes, " +
			"external resource loads or form submission. Call without arguments for help. Attach a report to a " +
			"message with inbox_send({reportName}).",
		promptSnippet: "Create and edit an HTML report for the inbox",
		promptGuidelines: [
			"Use inbox_report to create and update an HTML report, then send it with inbox_send({reportName}).",
			"Call inbox_report with no arguments for help. Keep reports self-contained: add local images with add_asset instead of external image URLs.",
			"When overwriting an existing report, pass the exact current HTML from action show as existingHtml.",
		],
		parameters: ReportParams,
		async execute(_toolCallId, params) {
			return await runReportTool(params);
		},
	});
}
