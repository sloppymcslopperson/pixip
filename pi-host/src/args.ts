import { resolve } from "node:path";

export interface HostArgs {
	/** Accepted for Pi CLI parity; only `rpc` is supported. */
	mode: "rpc";
	sessionDir?: string;
	session?: string;
	name?: string;
}

function takeValue(argv: string[], index: number, flag: string): [string, number] {
	const value = argv[index + 1];
	if (value === undefined) throw new Error(`${flag} requires a value`);
	return [value, index + 1];
}

/**
 * Parse the spawn arguments pixip passes to `pi --mode rpc`.
 *
 * `--mode rpc` is accepted and ignored: the host only speaks RPC. Values that
 * are paths are resolved against `cwd`, matching the CLI for relative input.
 */
export function parseHostArgs(argv: string[], cwd = process.cwd()): HostArgs {
	const args: HostArgs = { mode: "rpc" };
	for (let i = 0; i < argv.length; i++) {
		const raw = argv[i]!;
		const [flag, inline] = raw.includes("=")
			? ([raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] as const)
			: ([raw, undefined] as const);

		const value = (name: string): string => {
			if (inline !== undefined) return inline;
			const [next, index] = takeValue(argv, i, name);
			i = index;
			return next;
		};

		switch (flag) {
			case "--mode": {
				const mode = value("--mode");
				if (mode !== "rpc") throw new Error(`Unsupported --mode: ${mode}`);
				break;
			}
			case "--session-dir":
				args.sessionDir = resolve(cwd, value("--session-dir"));
				break;
			case "--session":
				args.session = resolve(cwd, value("--session"));
				break;
			case "--name":
				args.name = value("--name");
				break;
			default:
				throw new Error(`Unknown argument: ${flag}`);
		}
	}
	if (args.name !== undefined && args.name.trim() === "") {
		throw new Error("--name requires a non-empty value");
	}
	return args;
}
