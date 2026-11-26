/**
 * Thin client for the pixip inbox endpoint. The extension never guesses an
 * address and never writes inbox.json: the hub owns the file, and
 * PIXIP_DAEMON_URL/PIXIP_INBOX_TOKEN are injected by the hub into its children.
 */
export const INBOX_TOOL = "inbox_send";
export const INBOX_PURPOSES = ["attention-needed", "deliverable", "extra-info", "no-rush"] as const;
export type InboxPurpose = (typeof INBOX_PURPOSES)[number];

export interface InboxSendInput {
	subject: string;
	body: string;
	purpose: InboxPurpose;
}

export interface InboxSendResult {
	id: string;
	subject: string;
	purpose: string;
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
	};
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
