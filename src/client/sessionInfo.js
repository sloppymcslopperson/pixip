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
