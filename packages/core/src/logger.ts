/**
 * Optional structured logger. `@nostr-agx/*` never depends on a concrete logging
 * library — a host injects one (or nothing). All methods are optional; the
 * default is a no-op so libraries stay silent unless a host opts in.
 */
export interface AgxLogger {
	debug?(message: string, meta?: unknown): void;
	info?(message: string, meta?: unknown): void;
	warn?(message: string, meta?: unknown): void;
	error?(message: string, meta?: unknown): void;
}

/** A logger that discards everything. */
export const noopLogger: AgxLogger = {};
