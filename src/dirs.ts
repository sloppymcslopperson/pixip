/**
 * Directory discovery for the dashboard's new-session picker.
 *
 * The browser is unauthenticated, so this is deliberately read-mostly and
 * fenced to `$HOME`: every requested path is resolved with `realpath`, and a
 * symlink that escapes the home root is refused. Listing reads names and checks
 * for a `.git` child; it never reads file contents.
 */
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface DirEntry {
	name: string;
	/** Navigable path (may include a symlink alias inside the home root). */
	path: string;
	/** A `.git` entry exists in this directory (file or directory). */
	repo: boolean;
}

export interface DirListing {
	/** Resolved real path of the directory being listed. */
	path: string;
	/** Resolved real path of the home root. */
	home: string;
	/** Parent path, or `null` at the home root (or above it). */
	parent: string | null;
	entries: DirEntry[];
}

export class DirError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "DirError";
		this.status = status;
	}
}

/** True when `target` is `root` or a descendant of it. Both must be resolved. */
export function isWithin(root: string, target: string): boolean {
	if (target === root) return true;
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return target.startsWith(prefix);
}

/**
 * Resolve user input to a lexical path: `~` and `~/x` are relative to home,
 * absolute paths stand alone, and any other relative path is home-relative.
 * `realpath` is applied later, so this never grants access by itself.
 */
export function resolveDirPath(input: string | null | undefined, home: string): string {
	const raw = typeof input === "string" ? input.trim() : "";
	if (!raw) return resolve(home);
	if (raw === "~") return resolve(home);
	if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
	if (isAbsolute(raw)) return resolve(raw);
	return resolve(home, raw);
}

/** Repo roots first, then case-insensitive name, then exact name for stability. */
export function sortDirEntries(entries: DirEntry[]): DirEntry[] {
	return [...entries].sort((a, b) => {
		if (a.repo !== b.repo) return a.repo ? -1 : 1;
		const folded = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
		return folded || a.name.localeCompare(b.name);
	});
}

/** A single path segment, no traversal, and visible (dot-dirs stay hidden). */
export function validateNewDirName(name: unknown): string {
	const text = typeof name === "string" ? name : "";
	if (!text) throw new DirError(400, "folder name is required");
	if (text !== text.trim()) throw new DirError(400, "folder name cannot start or end with spaces");
	if (text === "." || text === "..") throw new DirError(400, "folder name cannot be . or ..");
	if (text.startsWith(".")) throw new DirError(400, "folder name cannot start with a dot");
	if (text.includes("/") || text.includes("\\") || text.includes("\0")) {
		throw new DirError(400, "folder name cannot contain a path separator");
	}
	if (text.length > 255) throw new DirError(400, "folder name is too long");
	return text;
}

function fsError(error: unknown, path: string): DirError {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT" || code === "ENOTDIR") return new DirError(404, `${path} is not a directory`);
	if (code === "EACCES" || code === "EPERM") return new DirError(403, `${path} is not readable`);
	return error instanceof DirError ? error : new DirError(500, (error as Error).message);
}

/** Resolve `input` and prove its real path is inside the real home root. */
async function realDirectory(input: string | null | undefined, home: string): Promise<{ root: string; path: string }> {
	const root = await realpath(resolve(home)).catch((error: unknown): never => {
		throw fsError(error, home);
	});
	const requested = resolveDirPath(input, root);
	const path = await realpath(requested).catch((error: unknown): never => {
		throw fsError(error, requested);
	});
	if (!isWithin(root, path)) throw new DirError(403, `${requested} is outside the home directory`);
	return { root, path };
}

async function isRepo(path: string): Promise<boolean> {
	return stat(join(path, ".git")).then(
		() => true,
		() => false,
	);
}

async function entryFor(current: string, root: string, name: string): Promise<DirEntry | null> {
	if (name.startsWith(".")) return null;
	const path = join(current, name);
	try {
		// stat follows a symlink, so a link to a directory is navigable only when
		// its real target stays inside the root; a link to a file is omitted.
		const info = await stat(path);
		if (!info.isDirectory()) return null;
		const resolved = await realpath(path);
		if (!isWithin(root, resolved)) return null;
		return { name, path, repo: await isRepo(resolved) };
	} catch {
		return null;
	}
}

/** List visible child directories of `input`, restricted to the home root. */
export async function listDirectories(input: string | null | undefined, home: string): Promise<DirListing> {
	const { root, path } = await realDirectory(input, home);
	const dirents = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
		throw fsError(error, path);
	});
	const entries = (await Promise.all(dirents.map((dirent) => entryFor(path, root, dirent.name)))).filter(
		(entry): entry is DirEntry => entry !== null,
	);
	return {
		path,
		home: root,
		parent: path === root ? null : dirname(path),
		entries: sortDirEntries(entries),
	};
}

/** Create one folder under `input`; returns the resolved new path. */
export async function createDirectory(
	input: string | null | undefined,
	name: unknown,
	home: string,
): Promise<{ path: string }> {
	const { root, path } = await realDirectory(input, home);
	const segment = validateNewDirName(name);
	const target = join(path, segment);
	if (!isWithin(root, target)) throw new DirError(403, `${target} is outside the home directory`);
	try {
		await mkdir(target);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") throw new DirError(409, `${segment} already exists`);
		throw fsError(error, target);
	}
	return { path: await realpath(target).catch(() => target) };
}
