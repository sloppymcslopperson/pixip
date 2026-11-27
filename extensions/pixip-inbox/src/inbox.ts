/**
 * Thin client for the pixip inbox endpoint. The extension never guesses an
 * address and never writes inbox.json: the hub owns the file, and
 * PIXIP_DAEMON_URL/PIXIP_INBOX_TOKEN are injected by the hub into its children.
 */
export const INBOX_TOOL = "inbox_send";
export const REPORT_TOOL = "inbox_report";
export const INBOX_PURPOSES = ["attention-needed", "deliverable", "extra-info", "no-rush"] as const;
export type InboxPurpose = (typeof INBOX_PURPOSES)[number];
export const REPORT_ACTIONS = ["new", "write", "add_asset", "remove_asset", "show"] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

export interface InboxSendInput {
	subject: string;
	body: string;
	purpose: InboxPurpose;
	reportName?: string;
}

export interface InboxReportInput {
	action?: string;
	name?: string;
	html?: string;
	existingHtml?: string;
	path?: string;
	filename?: string;
	asset?: string;
}

export const REPORT_HELP = `inbox_report: manage an HTML report for the pixip inbox.

Actions:
  new          Create a report directory. Arguments: name.
  write        Validate and replace index.html. Arguments: name, html, existingHtml?
               existingHtml is required when the report already has HTML and must be the exact current text.
  add_asset    Copy a local file into the report (top level). Arguments: name, path, filename?
               Returns the filename to reference from HTML/CSS. Images/CSS/fonts/SVG only, 1 MiB each.
  remove_asset Remove an unused top-level asset. Arguments: name, asset.
               Refuses while the current HTML/CSS still references it.
  show         Read the current report. Arguments: name.
               Returns the exact HTML, asset filenames, attachment status and URL.

Limits: index.html 1 MiB, each asset 1 MiB, whole report 10 MiB. No JavaScript, iframes,
objects/embeds, event handlers, external resource loads, or form submission. External
navigation links (<a href="https://…">) are allowed; download external images and add them
with add_asset. Assets live at the top level, so reference them as <img src="chart.png">.
Send the report by calling inbox_send with reportName set to this name.`;

export interface InboxSendResult {
	id: string;
	subject: string;
	purpose: string;
	reportName?: string;
}

export interface InboxToolDetails extends InboxSendResult {
	error?: string;
}

export interface InboxDeps {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export class InboxToolError extends Error {}

function isPurpose(value: string): value is InboxPurpose {
	return (INBOX_PURPOSES as readonly string[]).includes(value);
}

function daemonBase(env: NodeJS.ProcessEnv): string {
	const base = env["PIXIP_DAEMON_URL"]?.trim();
	if (!base) {
		throw new InboxToolError(
			"PIXIP_DAEMON_URL is not set. Run this agent inside a pixip session, or set PIXIP_DAEMON_URL to the daemon URL (for example http://127.0.0.1:8137/).",
		);
	}
	return base.endsWith("/") ? base : `${base}/`;
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	try {
		const parsed: unknown = text ? JSON.parse(text) : {};
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function failureMessage(status: number, body: Record<string, unknown>): string {
	const detail = typeof body["error"] === "string" ? body["error"] : `request failed (${status})`;
	if (status === 401) {
		return "the pixip daemon rejected PIXIP_INBOX_TOKEN (401). Check that it matches the daemon's --inbox-token, or unset it when the daemon has no token.";
	}
	if (status === 413) {
		return `the pixip inbox rejected the message: ${detail}. Shorten the body and try again.`;
	}
	return `inbox send failed: ${detail}`;
}

/** POST one message; the caller turns failures into tool errors. */
export async function sendToInbox(input: InboxSendInput, deps: InboxDeps = {}): Promise<InboxSendResult> {
	const env = deps.env ?? process.env;
	const fetchImpl = deps.fetch ?? fetch;
	const subject = input.subject.trim();
	if (!subject) throw new InboxToolError("subject is required");
	if (!input.body.trim()) throw new InboxToolError("body is required");
	if (!isPurpose(input.purpose)) {
		throw new InboxToolError(`purpose must be one of ${INBOX_PURPOSES.join(", ")}`);
	}

	const base = daemonBase(env);
	const url = new URL("api/inbox", base);
	const headers: Record<string, string> = { "content-type": "application/json" };
	const token = env["PIXIP_INBOX_TOKEN"]?.trim();
	if (token) headers["authorization"] = `Bearer ${token}`;
	const sessionId = env["PIXIP_SESSION_ID"]?.trim();

	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				subject,
				body: input.body,
				purpose: input.purpose,
				...(sessionId ? { sessionId } : {}),
				...(input.reportName ? { reportName: input.reportName } : {}),
			}),
			signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
		});
	} catch (error) {
		throw new InboxToolError(
			`could not reach the pixip daemon at ${url.origin} (${error instanceof Error ? error.message : String(error)}). Check that pixip is running; PIXIP_DAEMON_URL normally comes from the hub.`,
		);
	}

	const body = await responseBody(response);
	if (!response.ok) throw new InboxToolError(failureMessage(response.status, body));
	const message = body["message"];
	if (!message || typeof message !== "object") {
		throw new InboxToolError("the pixip daemon returned an unexpected inbox response");
	}
	const created = message as { id?: unknown; subject?: unknown; purpose?: unknown };
	if (typeof created.id !== "string") {
		throw new InboxToolError("the pixip daemon returned an inbox message without an id");
	}
	return {
		id: created.id,
		subject: typeof created.subject === "string" ? created.subject : subject,
		purpose: typeof created.purpose === "string" ? created.purpose : input.purpose,
		...(input.reportName ? { reportName: input.reportName } : {}),
	};
}

function reportResultText(input: InboxReportInput, report: Record<string, unknown>): string {
	const name = typeof report["name"] === "string" ? report["name"] : (input.name ?? "");
	const url = typeof report["url"] === "string" ? report["url"] : "";
	const action = input.action;
	if (action === "new") {
		return `Created report "${name}". Write its HTML with inbox_report({action:"write", name:"${name}", html:"…"}), then send it with inbox_send({reportName:"${name}", …}).`;
	}
	if (action === "write") {
		const bytes = typeof report["bytes"] === "number" ? ` (${report["bytes"]} bytes)` : "";
		return `Wrote report "${name}"${bytes}. View it at ${url}. Keep the returned HTML as existingHtml for the next overwrite.`;
	}
	if (action === "add_asset") {
		const asset = typeof report["asset"] === "string" ? report["asset"] : (input.filename ?? "");
		return `Added asset "${asset}" to report "${name}". Reference it as src="${asset}" in HTML, or url("${asset}") in CSS.`;
	}
	if (action === "remove_asset") {
		const asset = typeof report["asset"] === "string" ? report["asset"] : (input.asset ?? "");
		return `Removed asset "${asset}" from report "${name}".`;
	}
	if (action === "show") {
		const assets = Array.isArray(report["assets"]) ? report["assets"].join(", ") : "";
		const attached =
			Array.isArray(report["attached"]) && report["attached"].length > 0 ? report["attached"].join(", ") : "none";
		const html = typeof report["html"] === "string" ? report["html"] : "";
		return [
			`Report "${name}" at ${url}`,
			`Attached messages: ${attached}`,
			`Assets: ${assets || "none"}`,
			"",
			"HTML (exact; pass as existingHtml when overwriting):",
			html,
		].join("\n");
	}
	return JSON.stringify(report);
}

/** POST one report action; the caller turns failures into tool errors. */
export async function reportAction(input: InboxReportInput, deps: InboxDeps = {}): Promise<Record<string, unknown>> {
	const env = deps.env ?? process.env;
	const fetchImpl = deps.fetch ?? fetch;
	const base = daemonBase(env);
	const url = new URL("api/inbox/reports", base);
	const headers: Record<string, string> = { "content-type": "application/json" };
	const token = env["PIXIP_INBOX_TOKEN"]?.trim();
	if (token) headers["authorization"] = `Bearer ${token}`;

	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
		});
	} catch (error) {
		throw new InboxToolError(
			`could not reach the pixip daemon at ${url.origin} (${error instanceof Error ? error.message : String(error)}). Check that pixip is running.`,
		);
	}
	const body = await responseBody(response);
	if (!response.ok) {
		const detail = typeof body["error"] === "string" ? body["error"] : `request failed (${response.status})`;
		throw new InboxToolError(`inbox report failed: ${detail}`);
	}
	const report = body["report"];
	if (!report || typeof report !== "object")
		throw new InboxToolError("the pixip daemon returned an unexpected report response");
	return report as Record<string, unknown>;
}

/**
 * Best-effort "I am loaded" report, so the dashboard shows an empty inbox bar
 * only when some agent actually has `inbox_send`. Never throws: a daemon that
 * is down, restarting or token-mismatched must not turn an extension load into
 * an error; the bar then stays hidden until a message arrives or the next load.
 */
export async function announceInbox(deps: InboxDeps = {}): Promise<boolean> {
	const env = deps.env ?? process.env;
	const fetchImpl = deps.fetch ?? fetch;
	const base = env["PIXIP_DAEMON_URL"]?.trim();
	if (!base) return false;
	const headers: Record<string, string> = {};
	const token = env["PIXIP_INBOX_TOKEN"]?.trim();
	if (token) headers["authorization"] = `Bearer ${token}`;
	try {
		const url = new URL("api/inbox/extension", base.endsWith("/") ? base : `${base}/`);
		const response = await fetchImpl(url, {
			method: "POST",
			headers,
			signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** Pi tool result: success is informational, failure is an actionable tool error. */
export async function runReportTool(input: InboxReportInput, deps: InboxDeps = {}) {
	if (!input.action || !(REPORT_ACTIONS as readonly string[]).includes(input.action)) {
		return {
			content: [{ type: "text" as const, text: REPORT_HELP }],
			details: { help: true },
		};
	}
	try {
		const report = await reportAction(input, deps);
		return {
			content: [{ type: "text" as const, text: reportResultText(input, report) }],
			details: report,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: message }],
			isError: true,
			details: { error: message },
		};
	}
}

/** Pi tool result: success is informational, failure is an actionable tool error. */
export async function runInboxTool(input: InboxSendInput, deps: InboxDeps = {}) {
	try {
		const result = await sendToInbox(input, deps);
		return {
			content: [
				{
					type: "text" as const,
					text: `Sent “${result.subject}” to the pixip inbox (${result.purpose}, id ${result.id.slice(0, 8)}).`,
				},
			],
			details: result,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: message }],
			isError: true,
			details: { id: "", subject: input.subject, purpose: input.purpose, error: message },
		};
	}
}
