/**
 * Pure `/session` formatting. The hub already sends everything in the snapshot's
 * `session` info and the footer frame, so this is local UI: no new RPC and
 * nothing added to the model context.
 */

const MISSING = "—";

function line(label, value) {
	const text = value === undefined || value === null || value === "" ? MISSING : String(value);
	return `${label.padEnd(9)} ${text}`;
}

function modelLine(info, footer) {
	const model = footer?.model;
	if (model?.id) return model.provider ? `${model.provider}/${model.id}` : model.id;
	return info?.model;
}

function tokenLine(footer) {
	const tokens = footer?.tokens;
	if (!tokens) return undefined;
	const round = (value) => Math.round(Number.isFinite(value) ? value : 0);
	return `↑${round(tokens.input)} ↓${round(tokens.output)} R${round(tokens.cacheRead)} W${round(tokens.cacheWrite)}`;
}

function costLine(footer) {
	if (typeof footer?.cost !== "number") return undefined;
	return `$${footer.cost.toFixed(4)}`;
}

function contextLine(footer) {
	const context = footer?.context;
	if (!context) return undefined;
	if (typeof context.percent === "number") {
		return `${context.percent.toFixed(1)}% of ${context.window || "?"}`;
	}
	return context.window ? `${context.window} tokens` : undefined;
}

/** Multi-line meta block for the `/session` sheet. */
export function formatSession(info, footer) {
	return [
		line("id", info?.id),
		line("logical", info?.logicalId),
		line("name", info?.name),
		line("file", info?.sessionFile),
		line("messages", info?.messageCount ?? 0),
		line("model", modelLine(info, footer)),
		line("thinking", footer?.thinking ?? info?.thinkingLevel),
		line("tokens", tokenLine(footer)),
		line("cost", costLine(footer)),
		line("context", contextLine(footer)),
	].join("\n");
}

/**
 * The state a dot and row label should show. An error always wins, then a
 * session waiting on a human (a blocking request or a recorded re-ask card).
 * Pure so the header and dashboard cannot disagree.
 */
export function displayState(info) {
	if (info?.state === "error") return "error";
	if (info?.awaitingUser === true) return "waiting";
	return info?.state ?? "stopped";
}

/**
 * Download filename for `/export` (08): a slug of the session name plus a short
 * id, never the raw id or any path separator. Deterministic for the same info.
 */
export function exportFileName(info, ext = "html") {
	const slug = String(info?.name ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const short =
		String(info?.id ?? "session")
			.replace(/[^A-Za-z0-9]/g, "")
			.slice(0, 8) || "session";
	return `${slug || "session"}-${short}.${ext}`;
}
