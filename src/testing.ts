/**
 * Testing utilities for @stablemodels/qmd-cf.
 *
 * Provides mock implementations of Cloudflare's SqlStorage, Vectorize, and
 * the EmbedFn type so consuming projects can test their Qmd integration
 * without Cloudflare Workers or Vectorize services.
 *
 * MockSqlStorage wraps bun:sqlite's in-memory Database, giving you real FTS5
 * execution while matching the Cloudflare DO SqlStorage interface.
 *
 * MockVectorize is an in-memory vector store with brute-force cosine similarity
 * for testing the full hybrid search pipeline locally.
 *
 * @example
 * ```ts
 * import { Qmd } from "@stablemodels/qmd-cf";
 * import { MockSqlStorage, MockVectorize, createMockEmbedFn } from "@stablemodels/qmd-cf/testing";
 *
 * // FTS-only testing
 * const sql = new MockSqlStorage();
 * const qmd = new Qmd(sql);
 * await qmd.index({ id: "doc1", content: "Hello world" });
 * const results = qmd.searchFts("hello");
 *
 * // Hybrid search testing
 * const vectorize = new MockVectorize();
 * const embedFn = createMockEmbedFn();
 * const qmd = new Qmd(sql, { vectorize, embedFn });
 * ```
 */
import { Database } from "bun:sqlite";
import type { EmbedFn } from "./types.js";

// ─── BunSqlCursor ───────────────────────────────────────────────────

/**
 * Cursor wrapping bun:sqlite results. Structurally compatible with
 * Cloudflare's SqlStorageCursor.
 */
class BunSqlCursor<T extends Record<string, SqlStorageValue>> {
	private rows: T[];
	private index = 0;
	readonly columnNames: string[];
	readonly rowsRead: number;
	readonly rowsWritten: number;

	constructor(
		rows: T[],
		columnNames: string[],
		rowsRead: number,
		rowsWritten: number,
	) {
		this.rows = rows;
		this.columnNames = columnNames;
		this.rowsRead = rowsRead;
		this.rowsWritten = rowsWritten;
	}

	toArray(): T[] {
		return this.rows;
	}

	one(): T {
		if (this.rows.length !== 1) {
			throw new Error(`Expected exactly one row, got ${this.rows.length}`);
		}
		return this.rows[0];
	}

	next(): { done?: false; value: T } | { done: true; value?: never } {
		if (this.index < this.rows.length) {
			return { value: this.rows[this.index++] };
		}
		return { done: true };
	}

	raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
		const data = this.rows.map((row) => Object.values(row)) as unknown as U[];
		return data[Symbol.iterator]() as IterableIterator<U>;
	}

	[Symbol.iterator](): IterableIterator<T> {
		return this.rows[Symbol.iterator]() as IterableIterator<T>;
	}
}

// ─── MockSqlStorage ─────────────────────────────────────────────────

/**
 * In-memory SqlStorage backed by bun:sqlite.
 *
 * Provides real SQLite with FTS5 support, structurally compatible with
 * Cloudflare Durable Object's `ctx.storage.sql` interface.
 */
export class MockSqlStorage {
	private db: Database;

	constructor() {
		this.db = new Database(":memory:");
		this.db.exec("PRAGMA journal_mode=WAL");
		this.db.exec("PRAGMA foreign_keys=ON");
	}

	exec<T extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: any[]
	): BunSqlCursor<T> {
		const stmt = this.db.prepare(query);

		const trimmed = query.trimStart().toUpperCase();
		const isSelect =
			trimmed.startsWith("SELECT") ||
			trimmed.startsWith("WITH") ||
			trimmed.startsWith("PRAGMA");
		const isInsertReturning = trimmed.includes("RETURNING");

		if (isSelect || isInsertReturning) {
			const rows = stmt.all(...bindings) as T[];
			const columnNames = rows.length > 0 ? Object.keys(rows[0] as object) : [];
			return new BunSqlCursor<T>(rows, columnNames, rows.length, 0);
		}

		const result = stmt.run(...bindings);
		return new BunSqlCursor<T>([], [], 0, result.changes);
	}

	get databaseSize(): number {
		return 0;
	}

	get Cursor(): any {
		return BunSqlCursor;
	}

	get Statement(): any {
		return class {};
	}

	close(): void {
		this.db.close();
	}
}

// ─── MockVectorize ──────────────────────────────────────────────────

interface StoredVector {
	id: string;
	values: number[];
	namespace?: string;
	metadata?: Record<string, VectorizeVectorMetadata>;
}

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

/**
 * In-memory Vectorize with brute-force cosine similarity.
 *
 * Structurally compatible with Cloudflare's Vectorize abstract class.
 * Supports insert, upsert, query, queryById, getByIds, deleteByIds.
 */
export class MockVectorize {
	private vectors: Map<string, StoredVector> = new Map();

	/** Inspect stored vectors for test assertions. */
	get storedVectors(): Map<string, StoredVector> {
		return this.vectors;
	}

	async describe(): Promise<VectorizeIndexInfo> {
		return {
			vectorCount: this.vectors.size,
			dimensions: 0,
			processedUpToDatetime: 0,
			processedUpToMutation: 0,
		};
	}

	async insert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation> {
		for (const v of vectors) {
			if (this.vectors.has(v.id)) {
				throw new Error(`Vector ${v.id} already exists`);
			}
			this.vectors.set(v.id, {
				id: v.id,
				values: Array.from(v.values),
				namespace: v.namespace,
				metadata: v.metadata,
			});
		}
		return { mutationId: `mock-insert-${Date.now()}` };
	}

	async upsert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation> {
		for (const v of vectors) {
			this.vectors.set(v.id, {
				id: v.id,
				values: Array.from(v.values),
				namespace: v.namespace,
				metadata: v.metadata,
			});
		}
		return { mutationId: `mock-upsert-${Date.now()}` };
	}

	async query(
		vector: number[] | Float32Array,
		options?: VectorizeQueryOptions,
	): Promise<VectorizeMatches> {
		const queryVec = Array.from(vector);
		const topK = options?.topK ?? 5;

		let candidates = Array.from(this.vectors.values());

		if (options?.namespace) {
			candidates = candidates.filter((v) => v.namespace === options.namespace);
		}

		const scored = candidates.map((v) => ({
			id: v.id,
			score: cosineSimilarity(queryVec, v.values),
			namespace: v.namespace,
			metadata: options?.returnMetadata === "all" ? v.metadata : undefined,
			values: options?.returnValues ? v.values : undefined,
		}));

		scored.sort((a, b) => b.score - a.score);
		const matches = scored.slice(0, topK);

		return { matches, count: matches.length };
	}

	async queryById(
		vectorId: string,
		options?: VectorizeQueryOptions,
	): Promise<VectorizeMatches> {
		const vec = this.vectors.get(vectorId);
		if (!vec) return { matches: [], count: 0 };
		return this.query(vec.values, options);
	}

	async getByIds(ids: string[]): Promise<VectorizeVector[]> {
		return ids
			.map((id) => this.vectors.get(id))
			.filter((v): v is StoredVector => v !== undefined)
			.map((v) => ({
				id: v.id,
				values: v.values,
				namespace: v.namespace,
				metadata: v.metadata,
			}));
	}

	async deleteByIds(ids: string[]): Promise<VectorizeAsyncMutation> {
		for (const id of ids) {
			this.vectors.delete(id);
		}
		return { mutationId: `mock-delete-${Date.now()}` };
	}

	/** Reset all stored vectors. */
	clear(): void {
		this.vectors.clear();
	}
}

// ─── Mock EmbedFn ───────────────────────────────────────────────────

/**
 * Create a deterministic mock embedding function.
 *
 * Generates consistent vectors based on character frequency distribution.
 * Similar texts produce similar vectors, enabling meaningful cosine similarity
 * in tests without calling a real embedding model.
 *
 * @param dims - Number of embedding dimensions (default: 8)
 */
export function createMockEmbedFn(dims = 8): EmbedFn {
	return async (texts: string[]): Promise<number[][]> => {
		return texts.map((text) => {
			const lower = text.toLowerCase();
			const vec = new Array(dims).fill(0);
			for (let i = 0; i < lower.length; i++) {
				const code = lower.charCodeAt(i);
				vec[code % dims] += 1;
			}
			const norm = Math.sqrt(
				vec.reduce((s: number, v: number) => s + v * v, 0),
			);
			return norm > 0 ? vec.map((v: number) => v / norm) : vec;
		});
	};
}
