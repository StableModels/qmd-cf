/**
 * Domain types for qmd-cf.
 *
 * Cloudflare platform types (SqlStorage, SqlStorageCursor, Vectorize,
 * VectorizeVector, etc.) are ambient — provided by @cloudflare/workers-types
 * via tsconfig's "types" array. They don't need to be imported or re-exported.
 */

/** A document to be indexed. */
export interface Document {
	/** Unique identifier for this document (e.g. file path). */
	id: string;
	/** The full text content. */
	content: string;
	/** Optional title (boosts search relevance when matched). */
	title?: string;
	/** Optional document type for filtering (e.g. "fact", "daily_note", "summary"). */
	docType?: string;
	/** Optional namespace for scoped search (e.g. entity path, agent ID). */
	namespace?: string;
	/** Arbitrary metadata stored alongside the document. */
	metadata?: Record<string, string | number | boolean | null>;
}

/** A single chunk produced from a document. */
export interface Chunk {
	/** Parent document ID. */
	docId: string;
	/** Sequence index within the document (0-based). */
	seq: number;
	/** The chunk text content. */
	text: string;
	/** Character offset in the original document. */
	charOffset: number;
}

/** A search result returned from BM25 full-text search. */
export interface FtsResult {
	docId: string;
	/** BM25 score normalized to (0, 1] — higher is better. */
	score: number;
	/** The matching chunk text (snippet). */
	snippet: string;
	/** Chunk sequence number. */
	seq: number;
	title: string | null;
	docType: string | null;
	namespace: string | null;
	metadata: Record<string, string | number | boolean | null> | null;
}

/** A search result returned from vector similarity search. */
export interface VectorResult {
	docId: string;
	/** Cosine similarity score in [0, 1] — higher is better. */
	score: number;
	/** The matching chunk text. */
	snippet: string;
	/** Chunk sequence number. */
	seq: number;
	title: string | null;
	docType: string | null;
	namespace: string | null;
	metadata: Record<string, string | number | boolean | null> | null;
}

/** A merged search result after hybrid fusion. */
export interface SearchResult {
	docId: string;
	/** Final fused score — higher is better. */
	score: number;
	/** The best matching chunk text. */
	snippet: string;
	/** Source of the result: which retrieval methods contributed. */
	sources: Array<"fts" | "vector">;
	/** Individual scores from each source. */
	sourceScores: { fts?: number; vector?: number };
	title: string | null;
	docType: string | null;
	namespace: string | null;
	metadata: Record<string, string | number | boolean | null> | null;
}

/** Options for search queries. */
export interface SearchOptions {
	/** Maximum number of results to return. Default: 10. */
	limit?: number;
	/** Filter by document type. */
	docType?: string;
	/** Filter by namespace. */
	namespace?: string;
}

/** Options for hybrid search queries (extends SearchOptions). */
export interface HybridSearchOptions extends SearchOptions {
	/** Weight for FTS results in RRF fusion. Default: 1.0. */
	ftsWeight?: number;
	/** Weight for vector results in RRF fusion. Default: 1.0. */
	vectorWeight?: number;
	/** RRF constant k. Higher values reduce the impact of high rankings. Default: 60. */
	rrfK?: number;
}

/** Configuration for the QMD index. */
export interface QmdConfig {
	/** Maximum characters per chunk. Default: 3200 (~800 tokens). */
	chunkSize?: number;
	/** Overlap characters between chunks. Default: 480 (15% of chunkSize). */
	chunkOverlap?: number;
	/** FTS5 tokenizer configuration. Default: "unicode61". */
	tokenizer?: string;
}

/** Embedding function signature — maps text to a vector. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Index statistics. */
export interface IndexStats {
	totalDocuments: number;
	totalChunks: number;
	totalVectors: number;
	namespaces: string[];
	docTypes: string[];
}
