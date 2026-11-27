/**
 * Inbox HTML reports.
 *
 * A report is a hub-owned directory under `<data-dir>/reports/<name>/` with an
 * `index.html` and top-level assets. Agents never edit those files directly:
 * the `inbox_report` tool validates every document/asset write before it
 * replaces the previous state. Serving is deliberately dumb because the files
 * are already validated, but the response CSP is still locked down as defense
 * in depth.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";

import { parse, parseFragment } from "parse5";

import { detectImageMime } from "./attachments.ts";

export const REPORT_ACTIONS = ["new", "write", "add_asset", "remove_asset", "show"] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

export const MAX_REPORT_NAME_CHARS = 64;
export const MAX_REPORT_BYTES = 1024 * 1024;
export const MAX_REPORT_ASSET_BYTES = 1024 * 1024;
export const MAX_REPORT_TOTAL_BYTES = 10 * 1024 * 1024;
export const REPORT_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const MARKER = ".pixip-report.json";
const INDEX = "index.html";
const REPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const RASTER_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const RESOURCE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ".css", ".woff", ".woff2", ".ttf", ".otf"]);
const CSS_EXTENSIONS = new Set([".css"]);

const HTML_TAGS = new Set([
	"html",
	"head",
	"title",
	"body",
	"style",
	"link",
	"meta",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"p",
	"div",
	"span",
	"blockquote",
	"pre",
	"code",
	"ul",
	"ol",
	"li",
	"dl",
	"dt",
	"dd",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"th",
	"td",
	"caption",
	"colgroup",
	"col",
	"hr",
	"br",
	"strong",
	"em",
	"b",
	"i",
	"u",
	"s",
	"small",
	"sub",
	"sup",
	"mark",
	"del",
	"ins",
	"figure",
	"figcaption",
	"img",
	"a",
	"details",
	"summary",
	"section",
	"article",
	"header",
	"footer",
	"main",
	"nav",
	"aside",
	"address",
	"cite",
	"q",
	"time",
	"abbr",
	"dfn",
	"kbd",
	"samp",
	"var",
	"wbr",
	"form",
	"label",
	"input",
	"textarea",
	"select",
	"option",
	"optgroup",
	"fieldset",
	"legend",
	"button",
	"output",
	"progress",
	"meter",
	"svg",
]);

const SVG_TAGS = new Set([
	"svg",
	"g",
	"path",
	"rect",
	"circle",
	"ellipse",
	"line",
	"polyline",
	"polygon",
	"text",
	"tspan",
	"textpath",
	"defs",
	"symbol",
	"use",
	"title",
	"desc",
	"style",
	"lineargradient",
	"radialgradient",
	"stop",
	"clippath",
	"mask",
	"pattern",
	"marker",
	"filter",
	"fegaussianblur",
	"feoffset",
	"feblend",
	"fecolormatrix",
	"fecomponenttransfer",
	"fefunca",
	"fefuncb",
	"fefuncg",
	"fefuncr",
	"fecomposite",
	"feflood",
	"femerge",
	"femergenode",
	"femorphology",
	"feturbulence",
	"fedisplacementmap",
	"image",
	"a",
]);

const ALLOWED_ATTRS = new Set([
	"class",
	"id",
	"style",
	"title",
	"lang",
	"dir",
	"role",
	"hidden",
	"tabindex",
	"open",
	"width",
	"height",
	"align",
	"valign",
	"colspan",
	"rowspan",
	"scope",
	"headers",
	"start",
	"reversed",
	"datetime",
	"cite",
	"type",
	"value",
	"checked",
	"disabled",
	"readonly",
	"required",
	"placeholder",
	"name",
	"for",
	"min",
	"max",
	"step",
	"pattern",
	"size",
	"maxlength",
	"minlength",
	"multiple",
	"selected",
	"rows",
	"cols",
	"wrap",
	"alt",
	"src",
	"loading",
	"decoding",
	"href",
	"rel",
	"media",
	"charset",
	"content",
	"xmlns",
	"xmlns:xlink",
	"viewbox",
	"fill",
	"fill-opacity",
	"fill-rule",
	"stroke",
	"stroke-width",
	"stroke-opacity",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-dasharray",
	"stroke-dashoffset",
	"stroke-miterlimit",
	"d",
	"cx",
	"cy",
	"r",
	"rx",
	"ry",
	"x",
	"y",
	"x1",
	"x2",
	"y1",
	"y2",
	"points",
	"transform",
	"opacity",
	"gradientunits",
	"gradienttransform",
	"offset",
	"stop-color",
	"stop-opacity",
	"clip-path",
	"mask",
	"marker-start",
	"marker-mid",
	"marker-end",
	"patternunits",
	"patterncontentunits",
	"preserveaspectratio",
	"focusable",
	"vector-effect",
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"text-anchor",
	"dominant-baseline",
	"paint-order",
	"shape-rendering",
	"text-rendering",
]);

interface P5Node {
	nodeName: string;
	tagName?: string;
	attrs?: Array<{ name: string; value: string }>;
	childNodes?: P5Node[];
	content?: { childNodes?: P5Node[] };
	value?: string;
}

interface ValidationContext {
	assets: Set<string>;
	refs: Set<string>;
	svgOnly: boolean;
	depth: number;
}

export interface ReportMarker {
	version: 1;
	name: string;
	createdAt: string;
	updatedAt: string;
	attachedAt: string | null;
}

export interface ReportInput {
	action?: unknown;
	name?: unknown;
	html?: unknown;
	existingHtml?: unknown;
	path?: unknown;
	filename?: unknown;
	asset?: unknown;
}

export interface ReportView {
	name: string;
	url: string;
	html: string;
	assets: string[];
	attached: string[];
}

export interface ReportWriteResult {
	name: string;
	url: string;
	bytes: number;
}

export interface ReportAssetResult {
	name: string;
	url: string;
	asset: string;
}

export class ReportError extends Error {
	readonly status: number;

	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

function fail(message: string, status = 400): never {
	throw new ReportError(message, status);
}

export function reportUrl(name: string): string {
	return `/reports/${encodeURIComponent(name)}/`;
}

export function assertReportName(raw: unknown): string {
	const name = typeof raw === "string" ? raw.trim() : "";
	if (!name) fail("report name is required");
	if (name.length > MAX_REPORT_NAME_CHARS || !REPORT_NAME.test(name)) {
		fail(
			`report name must be 1-${MAX_REPORT_NAME_CHARS} characters of letters, digits, dash, underscore or dot, starting with a letter or digit`,
		);
	}
	return name;
}

function assertAssetName(raw: unknown): string {
	const name = typeof raw === "string" ? raw.trim() : "";
	if (!name) fail("asset filename is required");
	if (!ASSET_NAME.test(name) || name.includes("/") || name.includes("\\")) {
		fail("asset filename must be one safe top-level file name (letters, digits, dash, underscore or dot)");
	}
	if (name === INDEX || name === MARKER) fail(`${name} is reserved`);
	if (!RESOURCE_EXTENSIONS.has(extname(name).toLowerCase())) {
		fail(`unsupported asset type for ${name}; allowed: PNG, JPEG, GIF, WebP, SVG, CSS, WOFF, WOFF2, TTF, OTF`);
	}
	return name;
}

function safeSourceName(path: string): string {
	const name = basename(path);
	try {
		return assertAssetName(name);
	} catch {
		fail(`source file name "${name}" is not a safe report asset name; pass filename to choose one`);
	}
}

function isElement(node: P5Node): boolean {
	return typeof node.tagName === "string";
}

function attrs(node: P5Node): Map<string, string> {
	const map = new Map<string, string>();
	for (const attr of node.attrs ?? []) map.set(attr.name.toLowerCase(), attr.value);
	return map;
}

function textContent(node: P5Node): string {
	if (node.nodeName === "#text") return node.value ?? "";
	const children = [...(node.childNodes ?? []), ...(node.content?.childNodes ?? [])];
	return children.map(textContent).join("");
}

function validateCss(css: string, assets: Set<string>, refs: Set<string>, depth: number): void {
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, " ");
	if (/@import\b/i.test(stripped)) fail("CSS @import is not allowed; inline the stylesheet or link a local .css asset");
	if (/\bexpression\s*\(/i.test(stripped)) fail("CSS expression() is not allowed");
	if (/-moz-binding\b/i.test(stripped)) fail("CSS -moz-binding is not allowed");
	if (/\bbehavior\s*:/i.test(stripped)) fail("CSS behavior is not allowed");
	if (/javascript\s*:/i.test(stripped)) fail("javascript: URLs are not allowed");
	const urlPattern = /url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
	for (const match of stripped.matchAll(urlPattern)) {
		const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		validateResourceUrl(value, assets, refs, "resource", depth, "CSS url()");
	}
}

function decodeDataImage(value: string): { mime: string; bytes: Buffer } | undefined {
	const match = /^data:image\/(png|jpeg|gif|webp|svg\+xml)(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(
		value.trim(),
	);
	if (!match?.[1] || !match[2]) return undefined;
	const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
	return { mime: match[1].toLowerCase(), bytes };
}

function validateDataImage(value: string, context: ValidationContext, where: string): void {
	if (context.depth > 4) fail("nested data:images are too deep");
	const decoded = decodeDataImage(value);
	if (!decoded) fail(`${where} has an unsupported data:image URL; use base64 PNG, JPEG, GIF, WebP or SVG`);
	if (decoded.bytes.byteLength > MAX_REPORT_ASSET_BYTES) {
		fail(`${where} data:image is larger than ${MAX_REPORT_ASSET_BYTES} bytes`);
	}
	if (decoded.mime === "svg+xml") {
		validateSvg(decoded.bytes.toString("utf8"), context.assets, context.refs, context.depth + 1);
		return;
	}
	const detected = detectImageMime(decoded.bytes);
	const expected = decoded.mime === "jpg" ? "jpeg" : decoded.mime;
	if (!detected || detected !== `image/${expected}`) {
		fail(`${where} data:image does not match its declared ${decoded.mime} type`);
	}
}

function validateResourceUrl(
	value: string,
	assets: Set<string>,
	refs: Set<string>,
	kind: "resource" | "image" | "stylesheet",
	depth: number,
	where: string,
): void {
	const url = value.trim();
	if (!url) fail(`${where} has an empty URL`);
	if (url.startsWith("data:")) {
		if (kind !== "image" && kind !== "resource") fail(`${where} cannot use a data: URL`);
		validateDataImage(url, { assets, refs, svgOnly: false, depth }, where);
		return;
	}
	if (url.startsWith("#")) {
		if (kind === "stylesheet") fail(`${where} must point to a local .css asset`);
		return;
	}
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) || url.startsWith("//") || url.startsWith("/")) {
		fail(`${where} must use a local report asset, not ${url}`);
	}
	const path = url.split(/[?#]/)[0] ?? "";
	if (!path || path.includes("\\") || path.split("/").some((part) => part === "..")) {
		fail(`${where} must be a top-level report asset name, not ${url}`);
	}
	const file = assertAssetName(path);
	const ext = extname(file).toLowerCase();
	if (kind === "image" && !IMAGE_EXTENSIONS.has(ext)) fail(`${where} must reference an image asset, not ${file}`);
	if (kind === "stylesheet" && !CSS_EXTENSIONS.has(ext)) fail(`${where} must reference a .css asset, not ${file}`);
	if (!assets.has(file)) {
		fail(`${where} references missing asset "${file}"; add it with action "add_asset" first`);
	}
	refs.add(file);
}

function validateNavigationHref(value: string, where: string): void {
	const href = value.trim();
	if (!href) fail(`${where} has an empty href`);
	if (href.startsWith("#")) return;
	if (href.startsWith("//") || href.startsWith("/")) fail(`${where} must not use a root-relative URL`);
	if (
		href.includes("\\") ||
		href
			.split(/[?#]/)[0]
			?.split("/")
			.some((part) => part === "..")
	) {
		fail(`${where} must not escape the report directory`);
	}
	if (/^(?:https?|mailto):/i.test(href)) return;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) fail(`${where} uses a disallowed URL scheme`);
}

function validateNode(node: P5Node, context: ValidationContext, refs: Set<string>, inSvg: boolean): void {
	if (node.nodeName === "#text" || node.nodeName === "#comment" || node.nodeName === "#documentType") return;
	const tag = node.tagName?.toLowerCase();
	if (!tag) {
		for (const child of node.childNodes ?? []) validateNode(child, context, refs, inSvg);
		return;
	}
	const svgMode = context.svgOnly || inSvg;
	const allowed = svgMode ? SVG_TAGS : HTML_TAGS;
	if (!allowed.has(tag)) fail(`tag <${tag}> is not allowed`);
	const childSvg = svgMode || tag === "svg";
	const map = attrs(node);
	for (const name of map.keys()) {
		if (name.startsWith("on")) fail(`event handler attribute ${name} is not allowed`);
		if (name.startsWith("aria-") || name.startsWith("data-")) continue;
		if (name === "href" || name === "xlink:href") continue;
		if (name === "src" || name === "style" || name === "rel" || name === "charset" || name === "content") continue;
		if (!ALLOWED_ATTRS.has(name)) fail(`attribute ${name} on <${tag}> is not allowed`);
	}
	const style = map.get("style");
	if (style) validateCss(style, context.assets, refs, context.depth);

	if (tag === "style") {
		validateCss(textContent(node), context.assets, refs, context.depth);
	}
	if (tag === "link") {
		const rel = (map.get("rel") ?? "").trim().toLowerCase();
		if (rel !== "stylesheet") fail('only <link rel="stylesheet"> is allowed');
		const href = map.get("href");
		if (!href) fail('<link rel="stylesheet"> requires href');
		validateResourceUrl(href, context.assets, refs, "stylesheet", context.depth, "<link href>");
	}
	if (tag === "meta") {
		if (map.has("http-equiv")) fail("meta http-equiv is not allowed");
		const name = (map.get("name") ?? "").toLowerCase();
		if (!map.has("charset") && !["viewport", "description", "color-scheme", "theme-color"].includes(name)) {
			fail("meta tags are limited to charset, viewport, description, color-scheme and theme-color");
		}
	}
	if (tag === "form") {
		for (const name of ["action", "method", "target", "enctype"]) {
			if (map.has(name)) fail(`<form ${name}> is not allowed; forms are display-only`);
		}
	}
	if (tag === "input") {
		const type = (map.get("type") ?? "text").toLowerCase();
		if (type === "submit" || type === "reset" || type === "image" || type === "file") {
			fail(`input type="${type}" is not allowed; forms are display-only`);
		}
	}
	if (tag === "button") {
		const type = (map.get("type") ?? "").toLowerCase();
		if (type !== "button") fail('buttons must use type="button"; form submission is not allowed');
	}
	if (tag === "img") {
		const src = map.get("src");
		if (src) validateResourceUrl(src, context.assets, refs, "image", context.depth, "<img src>");
	}
	if (tag === "a") {
		const href = map.get("href");
		if (href) validateNavigationHref(href, "<a href>");
	}
	if (svgMode && tag === "use") {
		const href = map.get("href") ?? map.get("xlink:href");
		if (href && !href.trim().startsWith("#")) fail("<use href> may only reference a same-document id");
	}
	if (svgMode && tag === "image") {
		const href = map.get("href") ?? map.get("xlink:href");
		if (!href) fail("<image> requires href");
		validateResourceUrl(href, context.assets, refs, "image", context.depth, "<image href>");
	}
	if (tag === "a" && svgMode) {
		const href = map.get("href") ?? map.get("xlink:href");
		if (href) validateNavigationHref(href, "SVG <a href>");
	}

	for (const child of node.childNodes ?? []) validateNode(child, context, refs, childSvg);
	for (const child of node.content?.childNodes ?? []) validateNode(child, context, refs, childSvg);
}

function parseDocument(html: string, svgOnly: boolean): P5Node[] {
	const source = svgOnly
		? html
				.replace(/^\s*<\?xml[^>]*\?>/i, "")
				.replace(/^\s*<!doctype[^>]*>/i, "")
				.trim()
		: html;
	const parsed = svgOnly ? parseFragment(source) : parse(source);
	return parsed.childNodes;
}

export function validateHtml(html: string, assets: Set<string>, into?: Set<string>): Set<string> {
	const refs = into ?? new Set<string>();
	const nodes = parseDocument(html, false);
	for (const node of nodes) validateNode(node, { assets, refs, svgOnly: false, depth: 0 }, refs, false);
	return refs;
}

export function validateSvg(svg: string, assets: Set<string>, refs: Set<string>, depth = 0): void {
	const nodes = parseDocument(svg, true);
	const top = nodes.filter((node) => isElement(node) || node.nodeName === "#text");
	const elements = top.filter(isElement);
	if (elements.length !== 1 || elements[0]?.tagName?.toLowerCase() !== "svg") {
		fail("SVG assets must contain exactly one <svg> root");
	}
	if (top.some((node) => node.nodeName === "#text" && (node.value ?? "").trim())) {
		fail("SVG assets may not contain text outside the <svg> root");
	}
	for (const node of top) validateNode(node, { assets, refs, svgOnly: true, depth }, refs, true);
}

function validateAssetContent(name: string, bytes: Buffer, assets: Set<string>, refs: Set<string>): void {
	const ext = extname(name).toLowerCase();
	if (bytes.byteLength > MAX_REPORT_ASSET_BYTES) {
		fail(`asset "${name}" is larger than ${MAX_REPORT_ASSET_BYTES} bytes; images must be 1 MiB or smaller`);
	}
	if (RASTER_EXTENSIONS.has(ext)) {
		const detected = detectImageMime(bytes);
		const expected =
			ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".png" ? "image/png" : `image/${ext.slice(1)}`;
		if (!detected || detected !== expected) fail(`asset "${name}" is not a valid ${ext.slice(1).toUpperCase()} image`);
		return;
	}
	if (ext === ".svg") {
		validateSvg(bytes.toString("utf8"), assets, refs, 1);
		return;
	}
	if (ext === ".css") {
		validateCss(bytes.toString("utf8"), assets, refs, 1);
		return;
	}
	if (ext === ".woff") {
		if (bytes.subarray(0, 4).toString("ascii") !== "wOFF") fail(`asset "${name}" is not a valid WOFF font`);
		return;
	}
	if (ext === ".woff2") {
		if (bytes.subarray(0, 4).toString("ascii") !== "wOF2") fail(`asset "${name}" is not a valid WOFF2 font`);
		return;
	}
	if (ext === ".ttf") {
		const head = bytes.subarray(0, 4).toString("ascii");
		if (head !== "true" && head !== "ttcf" && !(bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) {
			fail(`asset "${name}" is not a valid TTF font`);
		}
		return;
	}
	if (ext === ".otf") {
		if (bytes.subarray(0, 4).toString("ascii") !== "OTTO") fail(`asset "${name}" is not a valid OTF font`);
		return;
	}
	fail(`unsupported asset type for "${name}"`);
}

async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, data);
	await rename(temp, path);
}

async function readMarker(dir: string, name: string): Promise<ReportMarker> {
	try {
		const parsed = JSON.parse(await readFile(join(dir, MARKER), "utf8")) as Partial<ReportMarker>;
		if (typeof parsed.createdAt === "string" && typeof parsed.updatedAt === "string") {
			return {
				version: 1,
				name,
				createdAt: parsed.createdAt,
				updatedAt: parsed.updatedAt,
				attachedAt: typeof parsed.attachedAt === "string" ? parsed.attachedAt : null,
			};
		}
	} catch {}
	const now = new Date().toISOString();
	return { version: 1, name, createdAt: now, updatedAt: now, attachedAt: null };
}

export class InboxReportStore {
	private readonly root: string;
	private readonly log: (message: string) => void;
	private readonly now: () => number;

	constructor(options: { root: string; log?: (message: string) => void; now?: () => number }) {
		this.root = options.root;
		this.log = options.log ?? (() => {});
		this.now = options.now ?? (() => Date.now());
	}

	get rootDir(): string {
		return this.root;
	}

	private dir(name: string): string {
		return join(this.root, name);
	}

	private async requireDir(name: string): Promise<string> {
		const dir = this.dir(name);
		try {
			const info = await stat(dir);
			if (!info.isDirectory()) fail(`report "${name}" is not a directory`, 409);
			return dir;
		} catch (error) {
			if (error instanceof ReportError) throw error;
			fail(`unknown report "${name}"; create it with action "new" first`, 404);
		}
	}

	private async marker(name: string): Promise<ReportMarker> {
		return await readMarker(this.dir(name), name);
	}

	private async touch(name: string, change: Partial<ReportMarker> = {}): Promise<void> {
		const current = await this.marker(name);
		const next: ReportMarker = {
			...current,
			...change,
			version: 1,
			name,
			updatedAt: new Date(this.now()).toISOString(),
		};
		await atomicWrite(join(this.dir(name), MARKER), `${JSON.stringify(next, null, 2)}\n`);
	}

	async create(rawName: unknown): Promise<ReportWriteResult> {
		const name = assertReportName(rawName);
		const dir = this.dir(name);
		await mkdir(this.root, { recursive: true });
		try {
			await mkdir(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				fail(`report "${name}" already exists; pick a different name`, 409);
			}
			throw error;
		}
		try {
			const now = new Date(this.now()).toISOString();
			await writeFile(
				join(dir, MARKER),
				`${JSON.stringify({ version: 1, name, createdAt: now, updatedAt: now, attachedAt: null }, null, 2)}\n`,
			);
		} catch (error) {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
			throw error;
		}
		return { name, url: reportUrl(name), bytes: 0 };
	}

	async readIndex(name: string): Promise<string | undefined> {
		try {
			return await readFile(join(this.dir(name), INDEX), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async assets(name: string): Promise<string[]> {
		const dir = await this.requireDir(name);
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name !== MARKER && entry.name !== INDEX)
			.map((entry) => entry.name)
			.sort();
	}

	private async totalBytes(name: string, replacedIndexBytes?: number): Promise<number> {
		const dir = await this.requireDir(name);
		const entries = await readdir(dir, { withFileTypes: true });
		let total = 0;
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (entry.name.endsWith(".tmp")) continue;
			const info = await stat(join(dir, entry.name));
			if (entry.name === MARKER) continue;
			if (entry.name === INDEX && replacedIndexBytes !== undefined) {
				total += replacedIndexBytes;
			} else {
				total += info.size;
			}
		}
		return total;
	}

	async write(rawName: unknown, html: unknown, existingHtml: unknown): Promise<ReportWriteResult> {
		const name = assertReportName(rawName);
		await this.requireDir(name);
		if (typeof html !== "string") fail('html is required for action "write"');
		const bytes = Buffer.byteLength(html, "utf8");
		if (bytes > MAX_REPORT_BYTES) {
			fail(`report HTML is too large (max ${MAX_REPORT_BYTES} bytes)`, 413);
		}
		const current = await this.readIndex(name);
		if (current !== undefined) {
			if (typeof existingHtml !== "string") {
				fail(
					'existingHtml is required when overwriting a report; call action "show" to get the exact current HTML',
					409,
				);
			}
			if (existingHtml !== current) {
				fail(
					'report changed since existingHtml was read; call action "show" and retry with the exact current HTML',
					409,
				);
			}
		} else if (existingHtml !== undefined && existingHtml !== "") {
			fail("this report has no HTML yet; omit existingHtml on the first write", 409);
		}
		const assetNames = await this.assets(name);
		validateHtml(html, new Set(assetNames));
		const total = await this.totalBytes(name, bytes);
		if (total > MAX_REPORT_TOTAL_BYTES) {
			fail(`report directory would exceed ${MAX_REPORT_TOTAL_BYTES} bytes`, 413);
		}
		await atomicWrite(join(this.dir(name), INDEX), html);
		await this.touch(name);
		return { name, url: reportUrl(name), bytes };
	}

	async addAsset(rawName: unknown, rawPath: unknown, rawFilename: unknown): Promise<ReportAssetResult> {
		const name = assertReportName(rawName);
		await this.requireDir(name);
		const source = typeof rawPath === "string" ? rawPath.trim() : "";
		if (!source) fail('path is required for action "add_asset"');
		if (!isAbsolute(source)) fail(`path must be absolute (got "${source}")`);
		let info;
		try {
			info = await stat(source);
		} catch (error) {
			fail(`cannot read ${source}: ${(error as Error).message}`);
		}
		if (!info.isFile()) fail(`${source} is not a regular file`);
		if (info.size > MAX_REPORT_ASSET_BYTES) {
			fail(
				`asset is too large (${info.size} bytes; max ${MAX_REPORT_ASSET_BYTES}). Images over 1 MiB must be downscaled first.`,
				413,
			);
		}
		const filename =
			typeof rawFilename === "string" && rawFilename.trim() ? assertAssetName(rawFilename) : safeSourceName(source);
		const dest = join(this.dir(name), filename);
		try {
			await stat(dest);
			fail(`asset "${filename}" already exists; remove it first or choose another filename`, 409);
		} catch (error) {
			if (error instanceof ReportError) throw error;
		}
		const bytes = await readFile(source);
		if (bytes.byteLength > MAX_REPORT_ASSET_BYTES) {
			fail(`asset is too large (${bytes.byteLength} bytes; max ${MAX_REPORT_ASSET_BYTES})`, 413);
		}
		const assetNames = await this.assets(name);
		const withNew = new Set([...assetNames, filename]);
		const refs = new Set<string>();
		validateAssetContent(filename, bytes, withNew, refs);
		const total = await this.totalBytes(name);
		if (total + bytes.byteLength > MAX_REPORT_TOTAL_BYTES) {
			fail(`report directory would exceed ${MAX_REPORT_TOTAL_BYTES} bytes`, 413);
		}
		await atomicWrite(dest, bytes);
		await this.touch(name);
		return { name, url: reportUrl(name), asset: filename };
	}

	private async collectReferences(name: string, html: string, assetNames: string[]): Promise<Set<string>> {
		const refs = new Set<string>();
		const context = { assets: new Set(assetNames), refs, svgOnly: false, depth: 0 };
		validateHtml(html, context.assets, refs);
		for (const asset of assetNames) {
			const ext = extname(asset).toLowerCase();
			if (!CSS_EXTENSIONS.has(ext) && ext !== ".svg") continue;
			const bytes = await readFile(join(this.dir(name), asset));
			if (ext === ".css") validateCss(bytes.toString("utf8"), context.assets, refs, 0);
			else validateSvg(bytes.toString("utf8"), context.assets, refs, 0);
		}
		return refs;
	}

	async removeAsset(rawName: unknown, rawAsset: unknown): Promise<ReportAssetResult> {
		const name = assertReportName(rawName);
		await this.requireDir(name);
		const asset = assertAssetName(rawAsset);
		const path = join(this.dir(name), asset);
		try {
			await stat(path);
		} catch {
			fail(`unknown asset "${asset}"`, 404);
		}
		const html = (await this.readIndex(name)) ?? "";
		const refs = await this.collectReferences(name, html, await this.assets(name));
		if (refs.has(asset)) {
			fail(`asset "${asset}" is still referenced by the report; remove the reference and write the HTML first`, 409);
		}
		await rm(path);
		await this.touch(name);
		return { name, url: reportUrl(name), asset };
	}

	async assertPublishable(rawName: unknown): Promise<string> {
		const name = assertReportName(rawName);
		await this.requireDir(name);
		const html = await this.readIndex(name);
		if (html === undefined) fail(`report "${name}" has no HTML yet; write it before sending`, 409);
		const assetNames = await this.assets(name);
		validateHtml(html, new Set(assetNames));
		return name;
	}

	async markAttached(rawName: unknown): Promise<void> {
		const name = assertReportName(rawName);
		const current = await this.marker(name);
		if (current.attachedAt) return;
		await this.touch(name, { attachedAt: new Date(this.now()).toISOString() });
	}

	async show(rawName: unknown, attached: string[]): Promise<ReportView> {
		const name = assertReportName(rawName);
		await this.requireDir(name);
		const html = (await this.readIndex(name)) ?? "";
		return { name, url: reportUrl(name), html, assets: await this.assets(name), attached };
	}

	async file(rawName: unknown, rawAsset?: string): Promise<{ path: string; contentType: string; size: number }> {
		const name = assertReportName(rawName);
		const asset = rawAsset === undefined || rawAsset === "" || rawAsset === INDEX ? INDEX : assertAssetName(rawAsset);
		const path = join(this.dir(name), asset);
		let info;
		try {
			info = await stat(path);
		} catch {
			fail(`unknown report file "${asset}"`, 404);
		}
		if (!info.isFile()) fail(`unknown report file "${asset}"`, 404);
		return {
			path,
			contentType: CONTENT_TYPES[extname(asset).toLowerCase()] ?? "application/octet-stream",
			size: info.size,
		};
	}

	/** Remove published reports with no message and drafts idle past the TTL. */
	async retain(referenced: Set<string>): Promise<string[]> {
		let entries;
		try {
			entries = await readdir(this.root, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const removed: string[] = [];
		const cutoff = this.now() - REPORT_DRAFT_TTL_MS;
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const name = entry.name;
			if (referenced.has(name)) continue;
			const dir = join(this.root, name);
			const marker = await readMarker(dir, name);
			const updated = Date.parse(marker.updatedAt || marker.createdAt);
			if (marker.attachedAt || !Number.isFinite(updated) || updated < cutoff) {
				try {
					await rm(dir, { recursive: true, force: true });
					removed.push(name);
				} catch (error) {
					this.log(`report cleanup failed for ${name}: ${(error as Error).message}`);
				}
			}
		}
		return removed;
	}
}

/** Help text shared by the extension tool and the REST action endpoint. */
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
