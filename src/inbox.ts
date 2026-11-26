/**
 * Durable message inbox for pixip.
 *
 * The inbox belongs to the data dir, not to a session: agents post to it, the
 * user reads it from the dashboard, and both survive a daemon restart and the
 * deletion of the sending session. The store is a single JSON file written with
 * a temp file plus rename under one serialized writer (the hub is the only
 * process that mutates it).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const INBOX_PURPOSES = ["attention-needed", "deliverable", "extra-info", "no-rush"] as const;
export type InboxPurpose = (typeof INBOX_PURPOSES)[number];

export const DEFAULT_INBOX_LIMIT = 200;
/** Bodies are bounded so one message cannot bloat the dashboard or the JSON file. */
export const MAX_INBOX_BODY_BYTES = 8 * 1024;
export const MAX_INBOX_SUBJECT_CHARS = 200;

export type InboxSenderStatus = "running" | "idle" | "stopped" | "archived" | "deleted";

/** Identity of the sender at send time; status is resolved later from the hub. */
export interface InboxSender {
	logicalId: string;
	name: string;
	cwd?: string;
	branch?: string;
	piId?: string;
}

export interface InboxMessage {
	id: string;
	subject: string;
	body: string;
	purpose: InboxPurpose;
	createdAt: string;
	readAt: string | null;
	archivedAt: string | null;
	sender: InboxSender;
}

export interface InboxView extends InboxMessage {
	senderStatus: InboxSenderStatus;
}

/** The live frame the dashboard badge consumes; deliberately smaller than the list. */
export interface InboxSummary {
	unread: number;
	total: number;
	limit: number;
	newest?: InboxView;
	/** True once the optional `pixip-inbox` extension has announced itself to this daemon. */
	extension?: boolean;
}

export interface InboxList {
	messages: InboxView[];
	unread: number;
	total: number;
	limit: number;
}

export interface InboxFilter {
	/** Only archived messages (the sheet's archive toggle). */
	archived?: boolean;
	/** Include both archived and active messages (id resolution). */
	all?: boolean;
	/** `all` (default), `unread` or `read`. */
	filter?: "all" | "unread" | "read";
	purpose?: InboxPurpose;
}

export interface InboxSendInput {
	subject: string;
	body: string;
	purpose: InboxPurpose;
	sender: InboxSender;
}

export class InboxError extends Error {
	readonly status: number;

	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

interface InboxFile {
	version: 1;
	messages: InboxMessage[];
}

function isPurpose(value: unknown): value is InboxPurpose {
	return typeof value === "string" && (INBOX_PURPOSES as readonly string[]).includes(value);
}

function normalizeSender(raw: unknown): InboxSender | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const sender = raw as Partial<InboxSender>;
	if (typeof sender.logicalId !== "string" || typeof sender.name !== "string") return undefined;
	return {
		logicalId: sender.logicalId,
		name: sender.name,
		...(typeof sender.cwd === "string" ? { cwd: sender.cwd } : {}),
		...(typeof sender.branch === "string" ? { branch: sender.branch } : {}),
		...(typeof sender.piId === "string" ? { piId: sender.piId } : {}),
	};
}

function normalizeMessage(raw: unknown): InboxMessage | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const item = raw as Partial<InboxMessage>;
	if (
		typeof item.id !== "string" ||
		typeof item.subject !== "string" ||
		typeof item.body !== "string" ||
		!isPurpose(item.purpose) ||
		typeof item.createdAt !== "string"
	) {
		return undefined;
	}
	const sender = normalizeSender(item.sender);
	if (!sender) return undefined;
	return {
		id: item.id,
		subject: item.subject,
		body: item.body,
		purpose: item.purpose,
		createdAt: item.createdAt,
		readAt: typeof item.readAt === "string" ? item.readAt : null,
		archivedAt: typeof item.archivedAt === "string" ? item.archivedAt : null,
		sender,
	};
}

/** Newest first; the file keeps insertion order so cap eviction is oldest first. */
function newestFirst(messages: InboxMessage[]): InboxMessage[] {
	return [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export class InboxStore {
	private readonly path: string;
	private readonly cap: number;
	private readonly log: (message: string) => void;
	private messages: InboxMessage[] | null = null;
	/** Serializes every read-modify-write and its atomic rename. */
	private writes: Promise<unknown> = Promise.resolve();

	constructor(options: { path: string; limit?: number; log?: (message: string) => void }) {
		this.path = options.path;
		this.cap = Math.max(1, Math.trunc(options.limit ?? DEFAULT_INBOX_LIMIT));
		this.log = options.log ?? (() => {});
	}

	get filePath(): string {
		return this.path;
	}

	get limit(): number {
		return this.cap;
	}

	async all(): Promise<InboxMessage[]> {
		return [...(await this.load())];
	}

	async snapshot(filter: InboxFilter = {}): Promise<InboxMessage[]> {
		let messages = newestFirst(await this.load());
		if (filter.archived) messages = messages.filter((message) => message.archivedAt !== null);
		else if (!filter.all) messages = messages.filter((message) => message.archivedAt === null);
		if (filter.filter === "unread") messages = messages.filter((message) => message.readAt === null);
		if (filter.filter === "read") messages = messages.filter((message) => message.readAt !== null);
		if (filter.purpose) messages = messages.filter((message) => message.purpose === filter.purpose);
		return messages;
	}

	async unreadCount(): Promise<number> {
		return (await this.load()).filter((message) => message.readAt === null && message.archivedAt === null).length;
	}

	async add(input: InboxSendInput): Promise<InboxMessage> {
		const subject = input.subject.trim();
		if (!subject) throw new InboxError("subject is required");
		if (subject.length > MAX_INBOX_SUBJECT_CHARS) {
			throw new InboxError(`subject is too long (max ${MAX_INBOX_SUBJECT_CHARS} characters)`);
		}
		if (!isPurpose(input.purpose)) {
			throw new InboxError(`purpose must be one of ${INBOX_PURPOSES.join(", ")}`);
		}
		if (Buffer.byteLength(input.body, "utf8") > MAX_INBOX_BODY_BYTES) {
			throw new InboxError(`body is too large (max ${MAX_INBOX_BODY_BYTES} bytes)`, 413);
		}
		return await this.mutate((messages) => {
			const message: InboxMessage = {
				id: randomUUID(),
				subject,
				body: input.body,
				purpose: input.purpose,
				createdAt: new Date().toISOString(),
				readAt: null,
				archivedAt: null,
				sender: input.sender,
			};
			messages.push(message);
			this.evict(messages);
			return message;
		});
	}

	async markRead(id: string): Promise<number> {
		return await this.mutate((messages) => {
			const now = new Date().toISOString();
			const targets =
				id === "all"
					? messages.filter((message) => message.readAt === null && message.archivedAt === null)
					: [this.require(messages, id)];
			let changed = 0;
			for (const message of targets) {
				if (message.readAt !== null) continue;
				message.readAt = now;
				changed += 1;
			}
			return changed;
		});
	}

	async archive(id: string): Promise<InboxMessage> {
		return await this.mutate((messages) => {
			const message = this.require(messages, id);
			if (!message.archivedAt) message.archivedAt = new Date().toISOString();
			return message;
		});
	}

	async restore(id: string): Promise<InboxMessage> {
		return await this.mutate((messages) => {
			const message = this.require(messages, id);
			message.archivedAt = null;
			return message;
		});
	}

	async delete(id: string): Promise<InboxMessage> {
		return await this.mutate((messages) => {
			const index = messages.findIndex((message) => message.id === id);
			if (index === -1) throw new InboxError(`unknown inbox message ${id}`, 404);
			const [removed] = messages.splice(index, 1);
			if (!removed) throw new InboxError(`unknown inbox message ${id}`, 404);
			return removed;
		});
	}

	/** Cap eviction: archived first, then read, then unread with an explicit log line. */
	private evict(messages: InboxMessage[]): void {
		while (messages.length > this.cap) {
			const archived = messages.findIndex((message) => message.archivedAt !== null);
			const read = messages.findIndex((message) => message.readAt !== null);
			const index = archived >= 0 ? archived : read >= 0 ? read : 0;
			const [removed] = messages.splice(index, 1);
			if (!removed) break;
			if (removed.readAt === null && removed.archivedAt === null) {
				this.log(`inbox full (${this.cap}): evicted unread message ${removed.id} (“${removed.subject}”)`);
			}
		}
	}

	private require(messages: InboxMessage[], id: string): InboxMessage {
		const message = messages.find((item) => item.id === id);
		if (!message) throw new InboxError(`unknown inbox message ${id}`, 404);
		return message;
	}

	private async load(): Promise<InboxMessage[]> {
		if (this.messages) return this.messages;
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.log(`inbox unreadable (${(error as Error).message}); starting empty`);
			}
			this.messages = [];
			return this.messages;
		}
		try {
			const parsed = JSON.parse(text) as Partial<InboxFile> | InboxMessage[];
			const raw = Array.isArray(parsed) ? parsed : parsed.messages;
			const messages = Array.isArray(raw)
				? raw.map(normalizeMessage).filter((message): message is InboxMessage => Boolean(message))
				: [];
			if (!Array.isArray(raw)) this.log(`inbox file ${this.path} has no message array; starting empty`);
			this.messages = messages;
		} catch (error) {
			this.log(`inbox file ${this.path} is malformed (${(error as Error).message}); starting empty`);
			this.messages = [];
		}
		return this.messages;
	}

	/** One serialized read-modify-write; returns the mutation's result. */
	private mutate<T>(operation: (messages: InboxMessage[]) => T): Promise<T> {
		const run = async (): Promise<T> => {
			const messages = await this.load();
			const result = operation(messages);
			await this.persist(messages);
			return result;
		};
		const next = this.writes.then(run, run);
		this.writes = next.catch(() => {});
		return next;
	}

	private async persist(messages: InboxMessage[]): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temp = `${this.path}.${process.pid}.tmp`;
		const body: InboxFile = { version: 1, messages };
		await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`);
		await rename(temp, this.path);
	}
}
