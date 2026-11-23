// Per-module configure boundaries. A feature keeps its callbacks private and
// validates the whole shape once when the composition root installs them.
export function installDeps(moduleName, configureName, next, required) {
	for (const name of required) {
		if (typeof next?.[name] !== "function") {
			throw new Error(`${moduleName}: ${configureName}({ ${name} }) requires a function`);
		}
	}
	return next;
}
