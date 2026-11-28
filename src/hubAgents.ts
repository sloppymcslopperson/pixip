// @ts-nocheck -- these methods are written against the Hub instance as `this`; the public Hub declarations and tests are typed.
// Hub methods split by concern; each function runs with the Hub instance as `this`.
import { randomUUID } from "node:crypto";

import {
	AgentSendError,
	agentUrl,
	normalizeAgentSend,
	resolveAgentTarget,
	type AgentSendAck,
	type AgentSendRequest,
} from "./agents.ts";
import type { AgentDeliveryRecord } from "./agentDeliveries.ts";
import type { SessionInfo } from "./wire.ts";

/**
 * Deliver one agent message the way a human prompt would.
 *
 * A stopped target is attached, an archived/trash target is restored first, and
 * the text is prefixed with the sender marker. Busy targets use `prompt` plus
 * `streamingBehavior: "steer"`; nothing waits for the target's turn to finish.
 */
export async function sendAgentMessage(this: any, input: AgentSendRequest, baseUrl: string): Promise<AgentSendAck> {
	const { target, message, senderId } = normalizeAgentSend(input);
	const active = await this.list();
	const archived = await this.listArchived();
	const trash = await this.listTrash();
	const resolved = resolveAgentTarget(active, archived, trash, target);

	const targetIds = new Set([resolved.info.id, resolved.info.logicalId]);
	if (senderId !== "local-shell" && targetIds.has(senderId)) {
		throw new AgentSendError("cannot send an agent message to the sender session", 400);
	}

	const stateBefore = resolved.info.state;
	let current: SessionInfo = resolved.info;
	let woken = false;
	try {
		if (resolved.stored === "archive") {
			current = await this.restoreArchived(resolved.info.id);
			woken = true;
		} else if (resolved.stored === "trash") {
			current = await this.restoreTrash(resolved.info.id);
			woken = true;
		}
		if (resolved.stored || resolved.info.state === "stopped") {
			current = await this.attach(current.id);
			woken = true;
		}
	} catch (error) {
		throw new AgentSendError(
			`could not wake agent "${target}": ${error instanceof Error ? error.message : String(error)}`,
			502,
		);
	}

	const streaming = current.state === "busy";
	const text = `[pixip-agent=${senderId}]\n${message}`;
	try {
		await this.prompt(current.id, text, streaming ? "steer" : undefined);
	} catch (error) {
		throw new AgentSendError(
			`could not deliver to agent "${target}": ${error instanceof Error ? error.message : String(error)}`,
			502,
		);
	}

	// A successful prompt may allocate a new Pi id (index-only session) or change
	// state as the first event lands; the acknowledgement follows the live row.
	const after = (await this.list().catch(() => [])).find(
		(info: SessionInfo) => info.id === current.id || (current.logicalId && info.logicalId === current.logicalId),
	);
	const targetId = after?.id ?? current.id;
	const targetLogicalId = after?.logicalId ?? current.logicalId ?? targetId;
	const stateAfter = after?.state ?? current.state;
	const at = new Date().toISOString();
	const ack: AgentSendAck = {
		deliveryId: randomUUID(),
		target: {
			id: targetId,
			name: after?.name ?? current.name ?? "",
			url: agentUrl(baseUrl, targetId),
			stateBefore,
			stateAfter,
		},
		delivered: true,
		woken,
		streaming,
		at,
	};

	const record: AgentDeliveryRecord = {
		deliveryId: ack.deliveryId,
		senderId,
		at: ack.at,
		delivered: ack.delivered,
		woken: ack.woken,
		streaming: ack.streaming,
		stateBefore: ack.target.stateBefore,
		stateAfter: ack.target.stateAfter,
		targetId,
		targetLogicalId,
	};
	await this.recordDelivery(record);
	return ack;
}
