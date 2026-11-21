/**
 * Composer command surface, DOM-free so `test/` can cover it.
 *
 * Three jobs live here and nowhere else:
 * - `classifyInput()`: what a submitted line means (`/builtin`, `/tui`,
 *   `/extension-or-unknown`, `!cmd`, `!!cmd`, plain text);
 * - the catalog: the one list the menu, notices and handlers read;
 * - the policy: a restrict-only merge of `<data-dir>/pixip.json`,
 *   `<cwd>/.pixip.json` and the CLI flags, plus the check applied per command.
 *
 * `src/commands.ts` imports `resolvePolicy()` from here, so the hub and the
 * client cannot disagree about precedence.
 */

/** pixip implements these (02-builtin-commands). */
export const BUILTIN_COMMANDS = [
	{ name: "compact", args: "[instructions]", source: "builtin", summary: "compact the context" },
	{ name: "name", args: "[name]", source: "builtin", summary: "show or set the session name" },
	{ name: "session", args: "", source: "builtin", summary: "session id, file and usage" },
	{ name: "copy", args: "", source: "builtin", summary: "copy the last assistant message" },
	{ name: "model", args: "[provider/model]", source: "builtin", summary: "pick or set the model" },
	{ name: "thinking", args: "[level]", source: "builtin", summary: "pick or set the thinking level" },
	{ name: "new", args: "", source: "builtin", summary: "start a fresh session in this child" },
	{ name: "resume", args: "", source: "builtin", summary: "back to the session list" },
	{ name: "quit", args: "", source: "builtin", summary: "detach and return to the list" },
];

/**
 * Pi TUI-only commands: no RPC surface, so pixip shows a local notice instead of
 * sending the text to the model. `ticket` marks the ones a later slice will
 * replace with real behaviour.
 */
export const TUI_ONLY_COMMANDS = [
	{ name: "settings", args: "", source: "tui", summary: "Pi settings selector" },
	{ name: "scoped-models", args: "", source: "tui", summary: "configure interactive model cycling" },
	{ name: "login", args: "[provider]", source: "tui", summary: "OAuth/API-key login" },
	{ name: "logout", args: "", source: "tui", summary: "OAuth logout" },
	{ name: "llama", args: "", source: "tui", summary: "llama.cpp router management" },
	{ name: "tree", args: "", source: "tui", ticket: "08-session-commands", summary: "navigate the session tree" },
	{ name: "fork", args: "", source: "tui", ticket: "08-session-commands", summary: "fork at a user message" },
	{ name: "clone", args: "", source: "tui", ticket: "08-session-commands", summary: "duplicate the current branch" },
	{ name: "import", args: "<path>", source: "tui", ticket: "08-session-commands", summary: "import a JSONL session" },
	{ name: "export", args: "[path]", source: "tui", ticket: "08-session-commands", summary: "export HTML/JSONL" },
	{ name: "share", args: "", source: "tui", summary: "upload and share a viewer link" },
	{ name: "trust", args: "", source: "tui", summary: "save a project trust decision" },
	{ name: "mcp", args: "", source: "tui", summary: "MCP server management" },
	{ name: "reload", args: "", source: "tui", summary: "reload Pi resources" },
	{ name: "hotkeys", args: "", source: "tui", summary: "keybinding help" },
	{ name: "changelog", args: "", source: "tui", summary: "changelog viewer" },
	{ name: "debug", args: "", source: "tui", summary: "debug view" },
];

/** The whole catalog, in menu order. */
export const COMMANDS = [...BUILTIN_COMMANDS, ...TUI_ONLY_COMMANDS];

/**
 * Bare command names everywhere: files and flags may say `/compact`, the wire
 * and the tests always see `compact`.
 */
export function normalizeName(name) {
	if (typeof name !== "string") return "";
	return name.trim().replace(/^\/+/, "").trim();
}

/** Catalog lookup by bare name, or `undefined` for extension/unknown commands. */
export function findCommand(name) {
	const bare = normalizeName(name);
	return COMMANDS.find((command) => command.name === bare);
}

/**
 * Classify one submitted composer line.
 *
 * `text` is what a passthrough sends: the line with only the outer trim, so
 * arguments (and `/skill:name x`) reach Pi verbatim. `bash` keeps the TUI's
 * rules: the bang check happens on the trimmed line, the command after the bang
 * is trimmed, and `!`/`!!` with no command is a no-op the caller ignores.
 */
export function classifyInput(text) {
	const trimmed = typeof text === "string" ? text.trim() : "";
	if (!trimmed) return { kind: "empty", text: "" };

	if (trimmed.startsWith("!")) {
		const excludeFromContext = trimmed.startsWith("!!");
		const command = (excludeFromContext ? trimmed.slice(2) : trimmed.slice(1)).trim();
		return {
			kind: "bash",
			text: trimmed,
			command,
			excludeFromContext,
			name: null,
			args: command,
		};
	}

	if (trimmed.startsWith("/")) {
		const body = trimmed.slice(1);
		// `/` alone opens the menu (06-command-menu); nothing to send yet.
		if (!body.trim()) return { kind: "menu", text: trimmed, name: "", args: "" };
		const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
		const name = match?.[1] ?? "";
		const args = (match?.[2] ?? "").trim();
		const command = findCommand(name);
		const kind = command?.source === "builtin" ? "builtin" : command?.source === "tui" ? "tui" : "passthrough";
		return { kind, text: trimmed, name, args, command };
	}

	return { kind: "text", text: trimmed, name: null, args: "" };
}

/**
 * Restrict-only policy merge. A later layer can narrow but never widen:
 * - `deny` is the union;
 * - `allow` is the intersection of the non-empty allow lists (empty = no
 *   restriction);
 * - `bash` is the AND (a `false` anywhere disables `!`/`!!`).
 *
 * `deny` wins at check time (`isAllowed`), so both lists are kept.
 */
export function resolvePolicy(layers = []) {
	let allow = null;
	const deny = [];
	let bash = true;
	for (const layer of layers) {
		if (!layer || typeof layer !== "object") continue;
		if (Array.isArray(layer.deny)) {
			for (const raw of layer.deny) {
				const name = normalizeName(raw);
				if (name && !deny.includes(name)) deny.push(name);
			}
		}
		if (Array.isArray(layer.allow)) {
			const names = [];
			for (const raw of layer.allow) {
				const name = normalizeName(raw);
				if (name && !names.includes(name)) names.push(name);
			}
			if (names.length > 0) {
				allow = allow === null ? names : allow.filter((name) => names.includes(name));
			}
		}
		if (layer.bash === false) bash = false;
	}
	return { allow: allow ?? [], deny, bash };
}

/** Is a bare command name permitted by the merged policy? */
export function isAllowed(name, policy) {
	const bare = normalizeName(name);
	if (!bare) return true;
	if (!policy) return true;
	if (Array.isArray(policy.deny) && policy.deny.includes(bare)) return false;
	if (Array.isArray(policy.allow) && policy.allow.length > 0) return policy.allow.includes(bare);
	return true;
}

/** Catalog for the menu (06) and notices, already filtered by `policy`. */
export function visibleCommands(policy) {
	return COMMANDS.filter((command) => isAllowed(command.name, policy));
}

/**
 * Where a composer line sits relative to a command: the filter query when the
 * cursor is still inside a bare `/name` (06-command-menu), `null` otherwise.
 * A space ends command position, so arguments never reopen the menu.
 */
export function commandQuery(text) {
	const value = typeof text === "string" ? text : "";
	if (!value.startsWith("/") || /\s/.test(value)) return null;
	return value.slice(1);
}

/**
 * The menu's catalog: the static catalog plus the live `get_commands` entries
 * (extension, prompt, skill), denied names removed and duplicates collapsed.
 * Static entries win, so the menu cannot disagree with `classifyInput`.
 */
export function menuCatalog(policy, dynamic = []) {
	const commands = visibleCommands(policy).map((command) => ({
		name: command.name,
		args: command.args ?? "",
		source: command.source,
		summary: command.summary ?? "",
		tuiOnly: command.source === "tui",
		...(command.ticket ? { ticket: command.ticket } : {}),
	}));
	const seen = new Set(commands.map((command) => command.name));
	for (const raw of Array.isArray(dynamic) ? dynamic : []) {
		const name = normalizeName(raw?.name);
		if (!name || seen.has(name) || !isAllowed(name, policy)) continue;
		seen.add(name);
		commands.push({
			name,
			args: "",
			source: ["extension", "prompt", "skill"].includes(raw?.source) ? raw.source : "extension",
			summary: typeof raw?.description === "string" ? raw.description : "",
			tuiOnly: false,
		});
	}
	return commands;
}

/**
 * Case-insensitive substring filter on name and description. Prefix matches on
 * the name come first, then other name matches, then description matches, and
 * each group is alphabetical: no fuzzy search, no scoring beyond that.
 */
export function filterCommands(commands, query) {
	const wanted = normalizeName(query).toLowerCase();
	const list = Array.isArray(commands) ? commands : [];
	const group = (command) => {
		if (!wanted) return 0;
		const name = command.name.toLowerCase();
		if (name.startsWith(wanted)) return 0;
		if (name.includes(wanted)) return 1;
		return (command.summary ?? "").toLowerCase().includes(wanted) ? 2 : -1;
	};
	return list
		.map((command) => ({ command, rank: group(command) }))
		.filter((entry) => entry.rank >= 0)
		.sort((a, b) => a.rank - b.rank || a.command.name.localeCompare(b.command.name))
		.map((entry) => entry.command);
}

/** Text a menu selection inserts: `/name`, plus a space when it takes arguments. */
export function menuInsertText(command) {
	if (!command || typeof command.name !== "string") return "";
	return `/${command.name}${command.args ? " " : ""}`;
}

/**
 * Resolve a `/model` argument against the models Pi reported. Ordered:
 * exact `provider/id`, exact id, then a unique id/suffix. Ambiguous and unknown
 * answers carry the closest matches so the caller can toast them.
 */
export function resolveModelArgument(models, query) {
	const list = Array.isArray(models) ? models.filter((model) => model && typeof model.id === "string") : [];
	const wanted = normalizeName(query).toLowerCase();
	if (!wanted) return { error: "usage: /model [provider/model]" };
	const providerId = (model) => `${model.provider ?? ""}/${model.id}`.toLowerCase();
	const exactProvider = list.find((model) => providerId(model) === wanted);
	if (exactProvider) return { model: exactProvider };
	const exactId = list.filter((model) => model.id.toLowerCase() === wanted);
	if (exactId.length === 1) return { model: exactId[0] };
	if (exactId.length > 1) return { error: `ambiguous model "${query}": ${describeModels(exactId)}`, matches: exactId };
	const suffix = list.filter((model) => model.id.toLowerCase().endsWith(wanted) || providerId(model).endsWith(wanted));
	if (suffix.length === 1) return { model: suffix[0] };
	if (suffix.length > 1) return { error: `ambiguous model "${query}": ${describeModels(suffix)}`, matches: suffix };
	return { error: `unknown model "${query}"`, matches: [] };
}

/** Resolve a `/thinking` argument against the levels Pi reported (exact, then unique prefix). */
export function resolveThinkingArgument(levels, query) {
	const list = Array.isArray(levels) ? levels.filter((level) => typeof level === "string") : [];
	const wanted = normalizeName(query).toLowerCase();
	if (!wanted) return { error: "usage: /thinking [level]" };
	const exact = list.filter((level) => level.toLowerCase() === wanted);
	if (exact.length === 1) return { level: exact[0] };
	const prefix = list.filter((level) => level.toLowerCase().startsWith(wanted));
	if (prefix.length === 1) return { level: prefix[0] };
	if (prefix.length > 1) return { error: `ambiguous thinking level "${query}": ${prefix.join(", ")}`, matches: prefix };
	return { error: `unknown thinking level "${query}" (have: ${list.join(", ")})`, matches: [] };
}

function describeModels(models) {
	return models
		.slice(0, 5)
		.map((model) => `${model.provider ?? ""}/${model.id}`)
		.join(", ");
}
