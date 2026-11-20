import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * Thin `pi --mode rpc` peer.
 *
 * Deliberately dumb: spawn, split stdout on LF, correlate responses by id, and
 * hand every other record to the caller *as the original string*. Nothing here
 * re-encodes an event; that is both the fast path and the shape a Rust port
 * wants (a `LinesCodec` plus a `HashMap<Id, oneshot::Sender>`).
 *
 * Framing rules (docs/rpc.md): records are one JSON object per LF. Split only on
 * LF, strip one optional CR. Do not use readline: U+2028/U+2029 are legal inside
 * JSON strings and readline treats them as boundaries.
 */

export interface RpcChildOptions {
	command: string;
	args: string[];
	cwd: string;
	onRecord: (raw: string, record: unknown) => void;
	onStderr?: (chunk: string) => void;
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
	requestTimeoutMs?: number;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface RpcResponse {
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

/** LF-only line splitter, kept separate so it can be tested in isolation. */
export class LineBuffer {
	private decoder = new StringDecoder("utf8");
	private buffer = "";

	push(chunk: Buffer): string[] {
		this.buffer += this.decoder.write(chunk);
		return this.drain();
	}

	flush(): string[] {
		const lines = this.drain();
		this.buffer += this.decoder.end();
		const tail = this.buffer.replace(/\r$/, "");
		this.buffer = "";
		if (tail.length > 0) lines.push(tail);
		return lines;
	}

	private drain(): string[] {
		const lines: string[] = [];
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			let line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.length > 0) lines.push(line);
			index = this.buffer.indexOf("\n");
		}
		return lines;
	}
}

export class RpcChild {
	readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, Pending>();
	private readonly lines = new LineBuffer();
	private readonly options: RpcChildOptions;
	private seq = 0;
	private exited = false;
	private closed = false;

	constructor(options: RpcChildOptions) {
		this.options = options;
		this.child = spawn(options.command, options.args, {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		this.child.stdout.on("data", (chunk: Buffer) => {
			for (const line of this.lines.push(chunk)) this.handleLine(line);
		});
		this.child.stderr.on("data", (chunk: Buffer) => {
			options.onStderr?.(chunk.toString("utf8"));
		});
		this.child.on("exit", (code, signal) => {
			this.exited = true;
			for (const [, entry] of this.pending) {
				clearTimeout(entry.timer);
				entry.reject(new Error("pi exited before responding"));
			}
			this.pending.clear();
			options.onExit?.(code, signal);
		});
		this.child.on("error", (error) => {
			this.exited = true;
			options.onStderr?.(`spawn failed: ${error.message}\n`);
		});
	}

	get running(): boolean {
		return !this.exited && !this.closed;
	}

	/** Send a command and await its `response` record. */
	command(command: Record<string, unknown>, timeoutMs = this.options.requestTimeoutMs ?? 20_000): Promise<unknown> {
		if (!this.running) return Promise.reject(new Error("pi is not running"));
		const id = `c${++this.seq}`;
		const payload = JSON.stringify({ ...command, id });
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timeout waiting for ${String(command.type)}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write(payload);
		});
	}

	/** Fire-and-forget record (no id, no response expected). */
	send(record: Record<string, unknown>): void {
		if (!this.running) return;
		this.write(JSON.stringify(record));
	}

	/** Orderly shutdown: close stdin first, then escalate. */
	async close(graceMs = 3000): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.child.stdin.end();
		if (this.exited) return;
		const exited = await waitForExit(this.child, graceMs);
		if (!exited) this.child.kill("SIGTERM");
	}

	private write(payload: string): void {
		this.child.stdin.write(`${payload}\n`);
	}

	private handleLine(line: string): void {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			this.options.onStderr?.(`unparsable record: ${line.slice(0, 200)}\n`);
			return;
		}
		const typed = record as { type?: string; id?: string };
		if (typed.type === "response" && typeof typed.id === "string") {
			const entry = this.pending.get(typed.id);
			if (entry) {
				this.pending.delete(typed.id);
				clearTimeout(entry.timer);
				const response = record as RpcResponse;
				if (response.success) entry.resolve(response.data);
				else entry.reject(new Error(response.error ?? `command ${response.command} failed`));
			}
		}
		// Reserve the fast path: caller gets the untouched string.
		this.options.onRecord(line, record);
	}
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}
