/**
 * Minimal type declarations for bun:sqlite used by the testing module.
 * Kept intentionally narrow to avoid conflicts with @cloudflare/workers-types.
 */
declare module "bun:sqlite" {
	class Database {
		constructor(filename: string);
		exec(query: string): void;
		prepare(query: string): Statement;
		close(): void;
	}

	class Statement {
		run(...params: unknown[]): { changes: number };
		all(...params: unknown[]): unknown[];
	}
}
