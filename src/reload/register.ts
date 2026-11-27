/**
 * Node module resolve hook for in-place reload.
 *
 * The manager imports `src/hub.ts?gen=N` and `src/server.ts?gen=N`. This hook
 * propagates `N` from a parent URL to every project `src/` specifier, so the
 * whole graph is a fresh module instance while `bin/` and `node_modules/` stay
 * shared. Without a `gen` in the parent URL the hook is a no-op, which keeps
 * the initial (generation 0) graph unversioned.
 */
const ROOT = new URL("../", import.meta.url).href;

export async function resolve(
	specifier: string,
	context: { parentURL?: string },
	nextResolve: (specifier: string, context: unknown) => Promise<{ url: string }>,
): Promise<{ url: string }> {
	const resolved = await nextResolve(specifier, context);
	const match = /[?&]gen=(\d+)/.exec(context.parentURL ?? "");
	const generation = match?.[1];
	if (!generation) return resolved;
	if (!resolved.url.startsWith(ROOT)) return resolved;
	const url = new URL(resolved.url);
	if (url.searchParams.has("gen")) return resolved;
	url.searchParams.set("gen", generation);
	return { ...resolved, url: url.href };
}
