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

import { INBOX_PURPOSES, INBOX_TOOL, type InboxPurpose, runInboxTool } from "./inbox.ts";

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
});

export default function pixipInbox(pi: ExtensionAPI) {
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
			});
		},
	});
}
