// Inbox methods on the Hub. Sender status is resolved from the same live and
// archived session data the dashboard already has; the message keeps a snapshot
// so it survives deletion of the sender.
import type { StoredSessionInfo } from "./sessionIndex.ts";
import type { SessionInfo } from "./wire.ts";
import { frameInbox } from "./wire.ts";
import {
	type InboxFilter,
	type InboxList,
	type InboxMessage,
	type InboxPurpose,
	type InboxSender,
	type InboxSenderStatus,
	type InboxSummary,
	type InboxView,
} from "./inbox.ts";

type StatusMap = Map<string, InboxSenderStatus>;

function runningStatus(info: SessionInfo): InboxSenderStatus {
	if (info.state === "idle") return "idle";
	if (info.state === "busy" || info.state === "starting") return "running";
	return "stopped";
}

function remember(map: StatusMap, info: SessionInfo, status: InboxSenderStatus): void {
	const logicalId = info.logicalId ?? info.id;
	if (!map.has(logicalId)) map.set(logicalId, status);
	if (info.id && !map.has(info.id)) map.set(info.id, status);
}

async function statusMap(this: any): Promise<StatusMap> {
	const [active, archived]: [SessionInfo[], StoredSessionInfo[]] = await Promise.all([
		this.list(),
		this.listArchived(),
	]);
	const map: StatusMap = new Map();
	// Live/stopped active sessions win over the archive: restoring a session can
	// leave the stored record around briefly.
	for (const info of active) remember(map, info, runningStatus(info));
	for (const info of archived) remember(map, info, "archived");
	return map;
}

function senderKey(sender: InboxSender): string {
	return sender.logicalId;
}

function view(message: InboxMessage, map: StatusMap): InboxView {
	return {
		...message,
		senderStatus: map.get(senderKey(message.sender)) ?? "deleted",
	};
}

export async function inboxSummary(this: any): Promise<InboxSummary> {
	const [messages, map] = await Promise.all([this.inboxStore.all(), statusMap.call(this)]);
	const visible = messages.filter((message: InboxMessage) => message.archivedAt === null);
	const newest = [...visible].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
	return {
		unread: visible.filter((message: InboxMessage) => message.readAt === null).length,
		total: messages.length,
		limit: this.inboxStore.limit,
		...(newest ? { newest: view(newest, map) } : {}),
	};
}

export async function inboxList(this: any, filter: InboxFilter = {}): Promise<InboxList> {
	const [messages, all, map] = await Promise.all([
		this.inboxStore.snapshot(filter),
		this.inboxStore.all(),
		statusMap.call(this),
	]);
	return {
		messages: messages.map((message: InboxMessage) => view(message, map)),
		unread: all.filter((message: InboxMessage) => message.readAt === null && message.archivedAt === null).length,
		total: all.length,
		limit: this.inboxStore.limit,
	};
}

async function resolveSender(this: any, sessionId?: string): Promise<InboxSender> {
	const all: SessionInfo[] = await this.list();
	const match = sessionId ? all.find((info) => info.logicalId === sessionId || info.id === sessionId) : undefined;
	if (!match) {
		if (sessionId) {
			return {
				logicalId: sessionId,
				name: `session ${sessionId.slice(0, 8)}`,
			};
		}
		return { logicalId: "local-shell", name: "local shell", cwd: process.cwd() };
	}
	return {
		logicalId: match.logicalId ?? match.id,
		name: match.name || "Untitled session",
		cwd: match.cwd,
		...(match.branch ? { branch: match.branch } : {}),
		piId: match.id,
	};
}

export async function inboxSend(
	this: any,
	input: { subject: string; body: string; purpose: InboxPurpose; sessionId?: string },
): Promise<InboxView> {
	const sender = await resolveSender.call(this, input.sessionId);
	const message = await this.inboxStore.add({
		subject: input.subject,
		body: input.body,
		purpose: input.purpose,
		sender,
	});
	const map = await statusMap.call(this);
	await broadcastInbox.call(this);
	return view(message, map);
}

export async function inboxRead(this: any, id: string): Promise<number> {
	const changed = await this.inboxStore.markRead(id);
	await broadcastInbox.call(this);
	return changed;
}

export async function inboxArchive(this: any, id: string): Promise<void> {
	await this.inboxStore.archive(id);
	await broadcastInbox.call(this);
}

export async function inboxRestore(this: any, id: string): Promise<void> {
	await this.inboxStore.restore(id);
	await broadcastInbox.call(this);
}

export async function inboxDelete(this: any, id: string): Promise<void> {
	await this.inboxStore.delete(id);
	await broadcastInbox.call(this);
}

/** Broadcast the small badge frame to every dashboard socket. */
export async function broadcastInbox(this: any): Promise<void> {
	const frame = frameInbox(await inboxSummary.call(this));
	for (const watcher of this.watchers) {
		try {
			watcher(frame);
		} catch {
			this.watchers.delete(watcher);
		}
	}
}
