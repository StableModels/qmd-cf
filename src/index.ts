/**
 * @stablemodels/qmd-cf — Hybrid full-text + vector search for Cloudflare Durable Objects.
 *
 * A DO-native reimagination of qmd (https://github.com/tobi/qmd).
 *
 * FTS5 runs co-located in the Durable Object's SQLite for zero-latency BM25 keyword search.
 * Optionally, Cloudflare Vectorize adds semantic vector search, fused via Reciprocal Rank Fusion.
 *
 * Cloudflare platform types (SqlStorage, SqlStorageCursor, SqlStorageValue) are
 * re-exported so consumers can import them without ambient globals.
 *
 * @example FTS-only (zero external dependencies)
 * ```ts
 * import { Qmd } from "@stablemodels/qmd-cf";
 *
 * export class MyDurableObject extends DurableObject {
 *   qmd: Qmd;
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.qmd = new Qmd(ctx.storage.sql);
 *   }
 *
 *   async search(query: string) {
 *     return this.qmd.search(query);
 *   }
 * }
 * ```
 *
 * @example Hybrid FTS + Vector search
 * ```ts
 * import { Qmd } from "@stablemodels/qmd-cf";
 *
 * export class MyDurableObject extends DurableObject {
 *   qmd: Qmd;
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.qmd = new Qmd(ctx.storage.sql, {
 *       vectorize: env.VECTORIZE,
 *       embedFn: (texts) =>
 *         env.AI.run("@cf/baai/bge-m3", { text: texts })
 *           .then(r => r.data),
 *     });
 *   }
 * }
 * ```
 */

// Main class
export { Qmd } from "./qmd.js";

// Domain types
export type {
	Document,
	Chunk,
	FtsResult,
	VectorResult,
	SearchResult,
	SearchOptions,
	HybridSearchOptions,
	QmdConfig,
	IndexStats,
	EmbedFn,
} from "./types.js";

// Re-export Cloudflare platform types so consumers don't need ambient globals
type _SqlStorage = SqlStorage;
type _SqlStorageCursor<
	T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>,
> = SqlStorageCursor<T>;
type _SqlStorageValue = SqlStorageValue;
export type {
	_SqlStorage as SqlStorage,
	_SqlStorageCursor as SqlStorageCursor,
	_SqlStorageValue as SqlStorageValue,
};

// Utilities (useful for custom pipelines)
export { chunkText } from "./chunker.js";
export { buildFts5Query } from "./fts.js";
export { fnv1a32 } from "./hash.js";
export { buildNamespaceFilter, safeParseMetadata } from "./namespace.js";
export { reciprocalRankFusion } from "./rrf.js";
export { formatDocForEmbedding, formatQueryForEmbedding } from "./vector.js";
