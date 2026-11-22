import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	resolveCliModel,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * One-shot print mode for the title summarizer.
 *
 * This is deliberately the smallest possible session: an in-memory SessionManager
 * (no JSONL file), no tools, no extensions/skills/templates/context files, and the
 * user's normal settings/auth. The reply is printed as plain text, not JSONL, so
 * `pixip` can reuse its existing `execFile` title path.
 */

export interface PrintArgs {
	model?: string;
	prompt: string;
}

/** Parse `--print [--model <provider/id>] <prompt>`. */
export function parsePrintArgs(argv: string[]): PrintArgs {
	const args = argv.slice();
	const first = args.shift();
	if (first !== "--print" && first !== "-p") {
		throw new Error("print mode requires --print");
	}
	let model: string | undefined;
	const words: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--model") {
			const value = args[++index];
			if (value === undefined) throw new Error("--model requires a value");
			model = value;
			continue;
		}
		if (arg.startsWith("--model=")) {
			model = arg.slice("--model=".length);
			continue;
		}
		// Parity with the CLI title flags; the print session already has no
		// extensions, skills, templates, context files, MCP or tools.
		if (
			arg === "--no-session" ||
			arg === "--no-tools" ||
			arg === "--no-extensions" ||
			arg === "--no-skills" ||
			arg === "--no-prompt-templates" ||
			arg === "--no-context-files" ||
			arg === "--no-mcp"
		) {
			continue;
		}
		if (arg === "--thinking") {
			index += 1;
			if (args[index] === undefined) throw new Error("--thinking requires a value");
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown argument: ${arg}`);
		words.push(arg);
	}
	const prompt = words.join(" ").trim();
	if (!prompt) throw new Error("print mode requires a prompt");
	return { ...(model ? { model } : {}), prompt };
}

/** Run one prompt in an ephemeral session and return the final assistant text. */
export async function printOnce(args: PrintArgs, cwd = process.cwd()): Promise<string> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		noTools: "all",
	});
	try {
		if (args.model) {
			const resolved = resolveCliModel({
				cliModel: args.model,
				modelRuntime: session.modelRuntime,
			});
			if (!resolved.model) {
				throw new Error(resolved.error ?? `Unknown model: ${args.model}`);
			}
			await session.setModel(resolved.model);
		}
		await session.prompt(args.prompt);
		return session.getLastAssistantText() ?? "";
	} finally {
		session.dispose();
	}
}
