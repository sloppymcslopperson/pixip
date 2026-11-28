/**
 * Bounded delivery history for agent-to-agent messages.
 *
 * The acknowledgement is the durable thing: a sender can look up the target's
 * `lastDelivery` from `GET /api/agents` instead of waiting for a receipt turn.
 * This log only keeps the newest entries; it is not a transcript.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { SessionState } from "./wire.ts";

export const AGENT_DELIVERY_LIMIT = 200;

/** The public part of one successful send, safe to return in discovery. */
export interface AgentDeliveryReceipt {
	deliveryId: string;
	senderId: string;
	at: string;
	delivered: boolean;
	woken: boolean;
	streaming: boolean;
	stateBefore: SessionState;
	stateAfter: SessionState;
}

/** A receipt plus the target keys needed to find it again. */
export interface AgentDeliveryRecord extends AgentDeliveryReceipt {
	targetId: string;
	targetLogicalId: string;
}

export interface AgentDeliveryLogOptions {
	path: string;
	limit?: number;
	log?: (message: string) => void;
}

function isState(value: unknown): value is SessionState {
	return value === "starting" || value === "idle" || value === "busy" || value === "stopped" || value === "error";
}

function toRecord(raw: unknown): AgentDeliveryRecord | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const item = raw as Record<string, unknown>;
	if (typeof item["deliveryId"] !== "string" || typeof item["targetId"] !== "string") return undefined;
	if (typeof item["targetLogicalId"] !== "string" || typeof item["senderId"] !== "string") return undefined;
	if (typeof item["at"] !== "string" || typeof item["delivered"] !== "boolean") return undefined;
	if (typeof item["woken"] !== "boolean" || typeof item["streaming"] !== "boolean") return undefined;
	if (!isState(item["stateBefore"]) || !isState(item["stateAfter"])) return undefined;
	return {
		deliveryId: item["deliveryId"],
		targetId: item["targetId"],
		targetLogicalId: item["targetLogicalId"],
		senderId: item["senderId"],
		at: item["at"],
		delivered: item["delivered"],
		woken: item["woken"],
		streaming: item["streaming"],
		stateBefore: item["stateBefore"],
		stateAfter: item["stateAfter"],
	};
}

/** Append-only ring persisted as one JSON array; writes are serialized and atomic. */
export class AgentDeliveryLog {
	private readonly path: string;
	private readonly limit: number;
	private readonly log: (message: string) => void;
	private records: AgentDeliveryRecord[] = [];
	private loaded?: Promise<void>;
	private writes: Promise<void> = Promise.resolve();

	constructor(options: AgentDeliveryLogOptions) {
		this.path = options.path;
		this.limit = Math.max(1, options.limit ?? AGENT_DELIVERY_LIMIT);
		this.log = options.log ?? (() => {});
	}

	private async load(): Promise<void> {
		if (this.loaded) return await this.loaded;
		this.loaded = (async () => {
			try {
				const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
				if (!Array.isArray(parsed)) return;
				const valid = parsed.map(toRecord).filter((item): item is AgentDeliveryRecord => item !== undefined);
				this.records = valid.slice(-this.limit);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					this.log(`delivery log unreadable (${(error as Error).message}); starting empty`);
				}
			}
		})();
		return await this.loaded;
	}

	/** Append one receipt and keep only the newest `limit` entries. */
	async record(record: AgentDeliveryRecord): Promise<void> {
		await this.load();
		this.records.push(record);
		if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit);
		const snapshot = `${JSON.stringify(this.records, null, 2)}\n`;
		this.writes = this.writes
			.then(async () => {
				await mkdir(dirname(this.path), { recursive: true });
				const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
				await writeFile(temp, snapshot);
				await rename(temp, this.path);
			})
			.catch((error: unknown) => {
				this.log(`delivery log write failed (${(error as Error).message})`);
			});
		await this.writes;
	}

	/** Latest receipt per logical target id; absent means the target was never messaged. */
	async lastByLogicalId(): Promise<Map<string, AgentDeliveryReceipt>> {
		await this.load();
		const latest = new Map<string, AgentDeliveryReceipt>();
		// Ascending order, so a later record replaces an earlier one.
		for (const record of this.records) {
			latest.set(record.targetLogicalId, {
				deliveryId: record.deliveryId,
				senderId: record.senderId,
				at: record.at,
				delivered: record.delivered,
				woken: record.woken,
				streaming: record.streaming,
				stateBefore: record.stateBefore,
				stateAfter: record.stateAfter,
			});
		}
		return latest;
	}
}
