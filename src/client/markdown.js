// Markdown -> HTML for assistant text. The only import is the vendored marked
// build (`vendor/marked.esm.js`, MIT, license beside it), so `node --test` and
// the browser render with the same code and no build step is involved.
//
// Two deliberate departures from marked's defaults:
//   - raw HTML in the source is escaped, never executed: model output can not
//     inject DOM, so `<div>` shows up as the literal text `<div>`;
//   - links only become anchors for http(s), mailto and in-page targets, and
//     open in a new tab so tapping one never navigates the app away.

import { Renderer, marked } from "./vendor/marked.esm.js";

const SAFE_HREF = /^(?:https?:|mailto:|#)/i;
const BASE_TABLE = Renderer.prototype.table;

export function escapeHtml(value) {
	return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const renderer = new Renderer();

renderer.html = ({ text }) => escapeHtml(text ?? "");

renderer.link = function link(token) {
	const label = token.tokens ? this.parser.parseInline(token.tokens) : escapeHtml(token.text ?? "");
	const href = String(token.href ?? "");
	if (!SAFE_HREF.test(href)) return label;
	const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
	return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${label}</a>`;
};

renderer.table = function table(token) {
	return `<div class="md-table">${BASE_TABLE.call(this, token)}</div>`;
};

marked.use({
	gfm: true,
	renderer: {
		html: renderer.html,
		link: renderer.link,
		table: renderer.table,
	},
});

/** Render assistant markdown to HTML. Never throws; empty input renders as "". */
export function markdownToHtml(source) {
	const text = String(source ?? "");
	if (!text.trim()) return "";
	try {
		return marked.parse(text);
	} catch {
		// A renderer bug must not eat the transcript: fall back to literal text.
		return `<p>${escapeHtml(text)}</p>`;
	}
}
