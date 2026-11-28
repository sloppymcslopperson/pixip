/**
 * `agent_list`: read-only discovery of pixip sessions.
 *
 * Opt-in by design. The hub spawns the real `pi` binary, so loading this
 * extension (project extension set, package install or `-e`) is the only way it
 * becomes available; pixip adds no private extension API and the tool only
 * speaks the normal REST endpoint.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { AGENT_LIST_TOOL, AGENT_STATES, runAgentListTool } from "./agents.ts";

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
}
