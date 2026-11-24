// Dashboard HTTP surface: every dashboard fetch lives here, never in a render
// module. Callers own the rendering and error/empty fallbacks.

export async function listSessions() {
	try {
		return await (await fetch("/api/sessions")).json();
	} catch {
		return [];
	}
}

export async function apiJson(path, options = {}) {
	const response = await fetch(path, options);
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		const error = new Error(body.error ?? `request failed (${response.status})`);
		// Callers that need structured refusals (dirty worktrees, referenced
		// sessions) read the parsed body without a second request.
		error.body = body;
		error.status = response.status;
		throw error;
	}
	return body;
}

export async function fetchInfo() {
	try {
		return await (await fetch("/api/info")).json();
	} catch {
		return {};
	}
}

/** Archive or trash list for the settings sheets. */
export async function fetchStored(kind) {
	const items = await apiJson(kind === "archive" ? "/api/archived" : "/api/trash");
	return Array.isArray(items) ? items : [];
}
