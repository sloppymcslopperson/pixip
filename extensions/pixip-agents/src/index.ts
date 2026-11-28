/**
 * `agent_list` and `agent_send`: discovery and messaging for pixip sessions.
 *
 * Opt-in by design. The hub spawns the real `pi` binary, so loading this
 * extension (project extension set, package install or `-e`) is the only way it
 * becomes available; pixip adds no private extension API and the tools only
 * speak the normal REST endpoints.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { AGENT_LIST_TOOL, AGENT_SEND_TOOL, AGENT_STATES, runAgentListTool, runAgentSendTool } from "./agents.ts";

const AgentSendParams = Type.Object({
	target: Type.String({
		description:
			"Target session: exact id or logical id, or a unique active name or id prefix. Archived/trash targets require an explicit id.",
	}),
	message: Type.String({ description: "Message to deliver as a normal prompt, prefixed with the sender marker" }),
});

const AgentListParams = Type.Object({
	all: Type.Optional(
		Type.Boolean({ description: "Include archived and trash sessions, marked with their stored state" }),
	),
	cwd: Type.Optional(
		Type.String({ description: "Only agents whose cwd is exactly this path (relative or ~ allowed)" }),
	),
	repo: Type.Optional(
		Type.String({ description: "Only agents in a git repository whose main root is exactly this path" }),
	),
	state: Type.Optional(
		Type.String({
			enum: [...AGENT_STATES],
			description: "starting, idle, busy, stopped or error",
		}),
	),
	query: Type.Optional(
		Type.String({ description: "Case-insensitive substring over name, id, logical id, cwd, repo and branch" }),
	),
});

export default function pixipAgents(pi: ExtensionAPI) {
	pi.registerTool({
		name: AGENT_LIST_TOOL,
		label: "List agents",
		description:
			"Find other pixip sessions without opening the web UI. Returns active sessions (live, attached and " +
			"stopped) with id, stable logical id, name, state, cwd, repo, branch/worktree, awaitingUser, " +
			"lastActivity, isSelf and an absolute URL that opens the session page. Archived and trash sessions " +
			"are hidden unless all is true. Read-only: this tool never creates, wakes, stops, archives or deletes " +
			"a session.",
		promptSnippet: "Discover other pixip sessions and their page URLs",
		promptGuidelines: [
			"Use agent_list to find another pixip session before asking the user to switch pages; the returned URL opens that session.",
			"Pass all:true only when archived or trash sessions are relevant; the calling session is marked isSelf and listed first.",
		],
		parameters: AgentListParams,
		async execute(_toolCallId, params) {
			return await runAgentListTool({
				...(params.all !== undefined ? { all: params.all } : {}),
				...(params.cwd ? { cwd: params.cwd } : {}),
				...(params.repo ? { repo: params.repo } : {}),
				...(params.state ? { state: params.state } : {}),
				...(params.query ? { query: params.query } : {}),
			});
		},
	});

	pi.registerTool({
		name: AGENT_SEND_TOOL,
		label: "Send agent message",
		description:
			"Send a message to another pixip session exactly like a human prompt. Resolves the target by exact id/logical " +
			"id first, then by unique active name or id prefix; archived and trash sessions require an explicit id. A " +
			"stopped target is attached, an archived/trash target is restored, and a busy target is steered. Returns " +
			"immediately with a delivery acknowledgement that includes the target URL; it never waits for the target's " +
			"turn. The target can reply by calling agent_send back.",
		promptSnippet: "Message another pixip session and get its page URL",
		promptGuidelines: [
			"Use agent_send when another pixip session needs to act; keep the message self-contained because the target sees only the text and your sender marker.",
			"Use agent_list first when the target is unclear. Exact ids always win; ambiguous names or prefixes are refused with candidates.",
			"A successful send returns immediately. Check agent_list lastDelivery later if you need confirmation; no automatic receipt is sent.",
		],
		parameters: AgentSendParams,
		async execute(_toolCallId, params) {
			return await runAgentSendTool({ target: params.target, message: params.message });
		},
	});
}
