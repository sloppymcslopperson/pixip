/**
 * Daemon generation manager: import a fresh module graph, apply it, and keep the
 * old one serving until the commit point. The manager itself is not reloaded; it
 * is the seam that survives a generation swap.
 */
export interface Generation<T> {
	generation: number;
	modules: T;
}

export interface GenerationManagerOptions<T> {
	/** Import one fresh generation without touching live state. */
	load: (generation: number) => Promise<T>;
	/** The generation currently serving. */
	initial: T;
	/** Swap live objects to the new modules. Must be reversible by `rollback`. */
	apply: (next: T, previous: T) => void;
	/** Put the previous modules back after a failed apply. */
	rollback: (previous: T) => void;
	/** Non-reloadable inputs that changed since startup, if any. */
	requiresRestart?: () => string | undefined;
}

export class GenerationManager<T> {
	#generation: number;
	#attempt = 0;
	#current: T;
	#pending?: Generation<T>;
	readonly #options: GenerationManagerOptions<T>;

	constructor(options: GenerationManagerOptions<T>, initialGeneration = 0) {
		this.#options = options;
		this.#current = options.initial;
		this.#generation = initialGeneration;
	}

	get generation(): number {
		return this.#generation;
	}

	get current(): T {
		return this.#current;
	}

	/** A change reload cannot apply, for the report rather than a false claim. */
	requiresRestart(): string | undefined {
		return this.#options.requiresRestart?.();
	}

	/**
	 * Import the next generation. Nothing live changes yet; an import failure
	 * throws and leaves the current generation serving.
	 */
	async prepare(): Promise<Generation<T>> {
		// Node caches a rejected dynamic import by URL, so a failed attempt must
		// consume its generation number; retrying `?gen=N` would reuse the error.
		const generation = ++this.#attempt;
		const modules = await this.#options.load(generation);
		const pending = { generation, modules };
		this.#pending = pending;
		return pending;
	}

	/**
	 * Swap to the prepared generation. If the apply itself throws, roll back to
	 * the previous modules and rethrow so the caller can report an error.
	 */
	applyPending(): void {
		const pending = this.#pending;
		if (!pending) throw new Error("no prepared generation");
		try {
			this.#options.apply(pending.modules, this.#current);
		} catch (error) {
			this.#options.rollback(this.#current);
			this.#pending = undefined;
			throw error;
		}
	}

	/** Commit the applied generation; the previous one is now collectable. */
	commit(): number {
		const pending = this.#pending;
		if (!pending) throw new Error("no prepared generation");
		this.#current = pending.modules;
		this.#generation = pending.generation;
		this.#pending = undefined;
		return this.#generation;
	}

	/** Put the current (previous) modules back and forget the failed attempt. */
	rollback(): void {
		if (!this.#pending) return;
		this.#options.rollback(this.#current);
		this.#pending = undefined;
	}

	/** Drop an imported generation without applying it. */
	discard(): void {
		this.#pending = undefined;
	}
}
