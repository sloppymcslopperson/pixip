/**
 * Optional `--watch` reload loop. It watches the package's `src/` (including
 * client assets) and `extensions/`, debounces bursts, and runs the same
 * daemon-wide reload as `/reload`. A busy session never interrupts: the loop
 * polls the reload gate, logs once, and re-prompts the browser every minute.
 * Off unless the CLI entry starts it, so tests stay quiet by default.
 */
import { watch as fsWatch } from "node:fs";

import type { ReloadBlocker, ReloadReport } from "../reload.ts";

export interface WatchSource {
	close(): void;
}

/** Injectable watcher factory so tests never leave a real fs watcher running. */
export type WatchFactory = (root: string, onEvent: (event: string, filename: string | null) => void) => WatchSource;

export interface WatchOptions {
	roots: string[];
	reload: () => Promise<ReloadReport>;
	blockers: () => ReloadBlocker[];
	log: (message: string) => void;
	notice?: (text: string, extra?: Record<string, unknown>) => void;
	debounceMs?: number;
	busyPollMs?: number;
	busyPromptMs?: number;
	createWatcher?: WatchFactory;
}

export interface WatchHandle {
	/** Stop watching and clear every timer. */
	close(): void;
	/** "I'll reissue later": drop the deferred change and stop polling. */
	cancel(): void;
}

const IGNORED = new Set(["node_modules", ".git", "fit", "tmp"]);

function ignored(filename: string | null): boolean {
	if (!filename) return false;
	return filename.split(/[\\/]+/).some((part) => IGNORED.has(part));
}

export function startWatch(options: WatchOptions): WatchHandle {
	const debounceMs = options.debounceMs ?? 200;
	const busyPollMs = options.busyPollMs ?? 1000;
	const busyPromptMs = options.busyPromptMs ?? 60_000;
	const sources: WatchSource[] = [];
	let closed = false;
	let pending = false;
	let running = false;
	let waiting = false;
	let promptedAt = 0;
	let debounce: NodeJS.Timeout | undefined;
	let poll: NodeJS.Timeout | undefined;

	const busyNames = () =>
		options
			.blockers()
			.map((blocker) => blocker.name ?? blocker.id)
			.join(", ");

	const stopWaiting = () => {
		waiting = false;
		if (poll) clearInterval(poll);
		poll = undefined;
	};

	const startWaiting = () => {
		if (waiting || closed) return;
		waiting = true;
		pending = true;
		promptedAt = Date.now();
		options.log(`watch: reload deferred until idle (${busyNames()})`);
		poll = setInterval(() => {
			if (closed) return;
			if (options.blockers().length === 0) {
				stopWaiting();
				void fire();
				return;
			}
			const now = Date.now();
			if (now - promptedAt < busyPromptMs) return;
			promptedAt = now;
			options.notice?.(`watch: reload deferred — sessions still busy: ${busyNames()}`, {
				watchDeferred: true,
				blockers: options.blockers(),
			});
		}, busyPollMs);
	};

	async function fire(): Promise<void> {
		if (closed || running || waiting) return;
		if (options.blockers().length > 0) {
			startWaiting();
			return;
		}
		pending = false;
		running = true;
		try {
			const report = await options.reload();
			options.log(`watch: ${report.message}`);
			if (report.status === "refused") {
				startWaiting();
			} else if (report.status === "error") {
				options.notice?.(`watch reload failed: ${report.message}`, { watchError: true });
			}
		} catch (error) {
			options.log(`watch: reload failed: ${(error as Error).message}`);
			options.notice?.(`watch reload failed: ${(error as Error).message}`, { watchError: true });
		} finally {
			running = false;
			if (pending && !closed && !waiting) schedule();
		}
	}

	function schedule(): void {
		if (closed) return;
		pending = true;
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => {
			debounce = undefined;
			void fire();
		}, debounceMs);
	}

	const create = options.createWatcher ?? ((root, onEvent) => fsWatch(root, { recursive: true }, onEvent));

	for (const root of options.roots) {
		try {
			sources.push(
				create(root, (_event, filename) => {
					if (ignored(filename)) return;
					schedule();
				}),
			);
		} catch (error) {
			options.log(`watch: cannot watch ${root}: ${(error as Error).message}`);
		}
	}

	return {
		close: () => {
			closed = true;
			if (debounce) clearTimeout(debounce);
			debounce = undefined;
			stopWaiting();
			for (const source of sources) source.close();
		},
		cancel: () => {
			pending = false;
			if (debounce) clearTimeout(debounce);
			debounce = undefined;
			stopWaiting();
			options.log("watch: deferred reload cancelled");
		},
	};
}
