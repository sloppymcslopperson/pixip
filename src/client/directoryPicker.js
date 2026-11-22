/**
 * Pure navigation helpers for the new-session directory picker. Server paths
 * are real (symlinks resolved) and fenced to the home root; these helpers only
 * build breadcrumbs/parents and filter the already-loaded listing.
 */

function trimRoot(home) {
	const text = typeof home === "string" ? home.trim() : "";
	if (!text) return "";
	return text.replace(/\/+$/, "") || "/";
}

function within(root, target) {
	if (target === root) return true;
	const prefix = root === "/" ? "/" : `${root}/`;
	return target.startsWith(prefix);
}

/** Smart start: the server cwd when it lies inside home, otherwise home. */
export function initialDirectory(defaultCwd, home) {
	const root = trimRoot(home);
	const rawCwd = typeof defaultCwd === "string" ? defaultCwd.trim() : "";
	const cwd = rawCwd ? rawCwd.replace(/\/+$/, "") || "/" : "";
	if (!cwd) return root;
	if (!root) return cwd;
	return within(root, cwd) ? cwd : root;
}

/** Breadcrumb segments from `~` down to the current directory. */
export function crumbTrail(path, home) {
	const raw = typeof path === "string" ? path.trim() : "";
	const target = raw ? raw.replace(/\/+$/, "") || "/" : "";
	const root = trimRoot(home);
	if (!target) return [];
	if (!root || !within(root, target)) return [{ label: target || "~", path: target }];
	const crumbs = [{ label: "~", path: root }];
	if (target === root) return crumbs;
	const relative = target.slice(root === "/" ? root.length : root.length + 1);
	let current = root;
	for (const segment of relative.split("/").filter(Boolean)) {
		current = current === "/" ? `/${segment}` : `${current}/${segment}`;
		crumbs.push({ label: segment, path: current });
	}
	return crumbs;
}

/** Parent directory, or `null` at the home root. Never escapes home. */
export function parentDirectory(path, home) {
	const raw = typeof path === "string" ? path.trim() : "";
	const target = raw ? raw.replace(/\/+$/, "") || "/" : "";
	const root = trimRoot(home);
	if (!target || !root || !within(root, target) || target === root) return null;
	const index = target.lastIndexOf("/");
	const parent = index <= 0 ? "/" : target.slice(0, index);
	return within(root, parent) ? parent : root;
}

/** Case-insensitive substring filter over directory names. */
export function filterDirEntries(entries, query) {
	const list = Array.isArray(entries) ? entries : [];
	const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
	if (!needle) return list;
	return list.filter((entry) =>
		String(entry?.name ?? "")
			.toLowerCase()
			.includes(needle),
	);
}
