import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentSessionRuntime,
	CreateAgentSessionRuntimeFactory,
	InlineExtension,
} from "@earendil-works/pi-coding-agent";

import type { HostArgs } from "./args.ts";

/**
 * Built-in extension factories that the CLI installs ahead of user extensions.
 *
 * The SDK exports the three factories but not its `builtInExtensions` array.
 * Keep the same names and `replaceable`/`builtin` flags so a user extension can
 * still take over MCP, codemode or tool search exactly as it does under `pi`.
 */
const BUILTIN_EXTENSIONS: InlineExtension[] = [
	{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
	{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
	{ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
];

function sessionManagerFor(args: HostArgs, cwd: string): SessionManager {
	if (args.session) return SessionManager.open(args.session, args.sessionDir);
	return SessionManager.create(cwd, args.sessionDir);
}

/**
 * Create the real Pi runtime with the user's default agent dir, settings and
 * extension set. No second config dir, no auth/model copies.
 */
export async function createHostRuntime(args: HostArgs): Promise<AgentSessionRuntime> {
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const sessionManager = sessionManagerFor(args, cwd);
	if (args.name !== undefined) sessionManager.appendSessionInfo(args.name.trim());

	const trustStore = new ProjectTrustStore(agentDir);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		agentDir: runtimeAgentDir,
		sessionManager: runtimeSessionManager,
		sessionStartEvent,
	}) => {
		const projectTrusted =
			!hasTrustRequiringProjectResources(runtimeCwd) || trustStore.get(runtimeCwd) === true;
		const settingsManager = SettingsManager.create(runtimeCwd, runtimeAgentDir, {
			projectTrusted,
		});
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			settingsManager,
			resourceLoaderOptions: { extensionFactories: BUILTIN_EXTENSIONS },
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: runtimeSessionManager,
			sessionStartEvent,
		});
		const extensionErrors = services.resourceLoader.getExtensions().errors ?? [];
		return {
			...created,
			services,
			diagnostics: [
				...services.diagnostics,
				...extensionErrors.map(({ path, error }) => ({
					type: "error" as const,
					message: `Failed to load extension "${path}": ${error}`,
				})),
			],
		};
	};

	return createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
}

export interface StartupExtensionError {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

/** Turn startup extension failures into protocol records, never stdout logs. */
export function startupExtensionErrors(runtime: AgentSessionRuntime): StartupExtensionError[] {
	const errors = runtime.services.resourceLoader.getExtensions().errors ?? [];
	return errors.map(({ path, error }) => ({
		type: "extension_error" as const,
		extensionPath: path,
		event: "startup",
		error,
	}));
}
