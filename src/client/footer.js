// TUI footer formatting, ported from the Pi footer component so the web status
// line reads the same as the terminal one:
//   line 1: ~/cwd (branch) • session name
//   line 2: ↑in ↓out R<read> W<write> CH<hit>% $cost  ctx%/window (auto)   model • thinking
// Kept pure so it is testable without a DOM.

export function formatTokens(count) {
	const value = Number(count) || 0;
	if (value < 1000) return String(value);
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
	return `${Math.round(value / 1000000)}M`;
}

export function formatCwd(cwd, home) {
	if (!cwd) return "";
	if (!home) return cwd;
	const root = home.replace(/\/+$/, "");
	if (cwd === root) return "~";
	if (cwd.startsWith(`${root}/`)) return `~${cwd.slice(root.length)}`;
	return cwd;
}

export function footerPwdLine(footer) {
	let pwd = formatCwd(footer.cwd, footer.home);
	if (footer.branch) pwd = `${pwd} (${footer.branch})`;
	if (footer.name) pwd = `${pwd} • ${footer.name}`;
	return pwd;
}

/** Left side of the stats line: usage totals plus context usage. */
export function footerStatsLeft(footer) {
	const parts = [];
	const { input, output, cacheRead, cacheWrite } = footer.tokens;
	if (input) parts.push(`↑${formatTokens(input)}`);
	if (output) parts.push(`↓${formatTokens(output)}`);
	if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
	if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
	if (footer.cost) parts.push(`$${footer.cost.toFixed(3)}`);
	const percent = footer.context.percent;
	const window = formatTokens(footer.context.window);
	const auto = footer.autoCompact ? " (auto)" : "";
	parts.push(percent === null ? `?/${window}${auto}` : `${percent.toFixed(1)}%/${window}${auto}`);
	return parts.join(" ");
}

/** Right side of the stats line: model and thinking level, as the TUI prints it. */
export function footerStatsRight(footer) {
	const model = footer.model?.id ?? "no-model";
	const base = footer.model?.reasoning
		? `${model} • ${footer.thinking === "off" ? "thinking off" : footer.thinking}`
		: model;
	return footer.model?.provider ? `${base}` : base;
}

export function contextLevel(footer) {
	const percent = footer.context.percent;
	if (percent === null || percent === undefined) return "none";
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	return "ok";
}
