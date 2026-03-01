import { chunkText } from "./chunker.js";
import { searchFts } from "./fts.js";
import { fnv1a32 } from "./hash.js";
import { reciprocalRankFusion } from "./rrf.js";
import { initSchema } from "./schema.js";
import type {
	Document,
	EmbedFn,
	FtsResult,
	HybridSearchOptions,
	IndexStats,
	QmdConfig,
	SearchOptions,
	SearchResult,
	VectorResult,
} from "./types.js";
import { indexVectors, removeVectors, searchVector } from "./vector.js";

/** Minimum normalized BM25 score to consider a "strong signal". */
const STRONG_SIGNAL_MIN_SCORE = 0.85;
/** Minimum gap between top-1 and top-2 BM25 scores for strong signal. */
const STRONG_SIGNAL_MIN_GAP = 0.15;

/**
 * Qmd — Hybrid full-text + vector search for Cloudflare Durable Objects.
 *
 * A DO-native reimagination of qmd (https://github.com/tobi/qmd) that brings
 * hybrid BM25 + semantic search to Cloudflare's edge.
 *
 * FTS5 runs co-located in the Durable Object's SQLite for zero-latency keyword search.
 * Vector search optionally uses Cloudflare Vectorize for semantic similarity.
 *
 * Usage:
 * ```ts
 * // FTS-only (no external dependencies)
 * const qmd = new Qmd(ctx.storage.sql);
 *
 * // Hybrid FTS + Vector
 * const qmd = new Qmd(ctx.storage.sql, {
 *   vectorize: env.VECTORIZE,
 *   embedFn: (texts) => workerAiEmbed(env.AI, texts),
 * });
 *
 * // Index a document
 * await qmd.index({ id: "soul.md", content: "...", title: "Soul" });
 *
 * // Search
 * const results = await qmd.search("what does the agent care about?");
 * ```
 */
export class Qmd {
	private sql: SqlStorage;
	private vectorize: Vectorize | null;
	private embedFn: EmbedFn | null;
	private config: Required<QmdConfig>;
	private initialized = false;

	constructor(
		sql: SqlStorage,
		options?: {
			vectorize?: Vectorize;
			embedFn?: EmbedFn;
			config?: QmdConfig;
		},
	) {
		this.sql = sql;
		this.vectorize = options?.vectorize ?? null;
		this.embedFn = options?.embedFn ?? null;

		if (this.vectorize && !this.embedFn) {
			throw new Error("embedFn is required when vectorize is provided");
		}

		this.config = {
			chunkSize: options?.config?.chunkSize ?? 3200,
			chunkOverlap: options?.config?.chunkOverlap ?? 480,
			tokenizer: options?.config?.tokenizer ?? "unicode61",
		};
	}

	/** Ensure the FTS5 schema is initialized. Called automatically on first operation. */
	private ensureInit(): void {
		if (this.initialized) return;
		initSchema(this.sql, this.config.tokenizer);
		this.initialized = true;
	}

	/** Whether vector search is available. */
	get hasVectorSearch(): boolean {
		return this.vectorize !== null && this.embedFn !== null;
	}

	/**
	 * Index a document for search.
	 *
	 * The document is chunked and inserted into FTS5. If Vectorize is configured,
	 * chunks are also embedded and upserted into the vector index.
	 *
	 * If the content is unchanged (same hash), chunking and vector indexing are
	 * skipped. Document metadata (title, namespace, etc.) is always updated.
	 */
	async index(doc: Document): Promise<{ chunks: number; skipped: boolean }> {
		this.ensureInit();

		const contentHash = fnv1a32(doc.content);
		const metadataJson = doc.metadata ? JSON.stringify(doc.metadata) : null;

		// Check if content is unchanged
		const existing = this.sql
			.exec<{ content_hash: string | null }>(
				"SELECT content_hash FROM qmd_documents WHERE id = ?",
				doc.id,
			)
			.toArray();

		if (existing.length > 0 && existing[0].content_hash === contentHash) {
			// Content unchanged — update metadata but skip re-chunking
			this.sql.exec(
				`UPDATE qmd_documents SET title = ?, doc_type = ?, namespace = ?, metadata = ?, updated_at = datetime('now')
				 WHERE id = ?`,
				doc.title ?? null,
				doc.docType ?? null,
				doc.namespace ?? null,
				metadataJson,
				doc.id,
			);
			const chunkCount = this.sql
				.exec<{ cnt: number }>(
					"SELECT COUNT(*) as cnt FROM qmd_chunks WHERE doc_id = ?",
					doc.id,
				)
				.one().cnt;
			return { chunks: chunkCount, skipped: true };
		}

		// Upsert document metadata with content hash
		this.sql.exec(
			`INSERT OR REPLACE INTO qmd_documents (id, title, doc_type, namespace, metadata, content_hash, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
			doc.id,
			doc.title ?? null,
			doc.docType ?? null,
			doc.namespace ?? null,
			metadataJson,
			contentHash,
		);

		// Delete old chunks (triggers will clean up FTS)
		this.sql.exec("DELETE FROM qmd_chunks WHERE doc_id = ?", doc.id);

		// Chunk and insert
		const chunks = chunkText(
			doc.id,
			doc.content,
			this.config.chunkSize,
			this.config.chunkOverlap,
		);

		for (const chunk of chunks) {
			this.sql.exec(
				"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES (?, ?, ?, ?)",
				chunk.docId,
				chunk.seq,
				chunk.text,
				chunk.charOffset,
			);
		}

		// Vector indexing (async, non-blocking for FTS)
		if (this.vectorize && this.embedFn) {
			const contexts = this.getContextsForDoc(doc.id);
			const contextText = contexts.map((c) => c.description).join(". ");

			await indexVectors(
				this.vectorize,
				this.embedFn,
				chunks.map((c) => ({
					docId: c.docId,
					seq: c.seq,
					text: c.text,
					title: doc.title,
					namespace: doc.namespace,
					docType: doc.docType,
					context: contextText || undefined,
				})),
			);
		}

		return { chunks: chunks.length, skipped: false };
	}

	/**
	 * Index multiple documents in batch.
	 * More efficient than calling index() in a loop when Vectorize is configured,
	 * as embeddings are batched.
	 */
	async indexBatch(
		docs: Document[],
	): Promise<{ documents: number; chunks: number; skipped: number }> {
		this.ensureInit();

		let totalChunks = 0;
		let skippedCount = 0;
		const allVectorChunks: Array<{
			docId: string;
			seq: number;
			text: string;
			title?: string;
			namespace?: string;
			docType?: string;
			context?: string;
		}> = [];

		for (const doc of docs) {
			const contentHash = fnv1a32(doc.content);
			const metadataJson = doc.metadata ? JSON.stringify(doc.metadata) : null;

			// Check if content is unchanged
			const existing = this.sql
				.exec<{ content_hash: string | null }>(
					"SELECT content_hash FROM qmd_documents WHERE id = ?",
					doc.id,
				)
				.toArray();

			if (existing.length > 0 && existing[0].content_hash === contentHash) {
				// Update metadata, skip re-chunking
				this.sql.exec(
					`UPDATE qmd_documents SET title = ?, doc_type = ?, namespace = ?, metadata = ?, updated_at = datetime('now')
					 WHERE id = ?`,
					doc.title ?? null,
					doc.docType ?? null,
					doc.namespace ?? null,
					metadataJson,
					doc.id,
				);
				const chunkCount = this.sql
					.exec<{ cnt: number }>(
						"SELECT COUNT(*) as cnt FROM qmd_chunks WHERE doc_id = ?",
						doc.id,
					)
					.one().cnt;
				totalChunks += chunkCount;
				skippedCount++;
				continue;
			}

			this.sql.exec(
				`INSERT OR REPLACE INTO qmd_documents (id, title, doc_type, namespace, metadata, content_hash, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
				doc.id,
				doc.title ?? null,
				doc.docType ?? null,
				doc.namespace ?? null,
				metadataJson,
				contentHash,
			);

			this.sql.exec("DELETE FROM qmd_chunks WHERE doc_id = ?", doc.id);

			const chunks = chunkText(
				doc.id,
				doc.content,
				this.config.chunkSize,
				this.config.chunkOverlap,
			);

			for (const chunk of chunks) {
				this.sql.exec(
					"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES (?, ?, ?, ?)",
					chunk.docId,
					chunk.seq,
					chunk.text,
					chunk.charOffset,
				);
			}

			totalChunks += chunks.length;

			if (this.vectorize && this.embedFn) {
				const contexts = this.getContextsForDoc(doc.id);
				const contextText = contexts.map((c) => c.description).join(". ");

				for (const c of chunks) {
					allVectorChunks.push({
						docId: c.docId,
						seq: c.seq,
						text: c.text,
						title: doc.title,
						namespace: doc.namespace,
						docType: doc.docType,
						context: contextText || undefined,
					});
				}
			}
		}

		// Batch embed and upsert vectors
		if (this.vectorize && this.embedFn && allVectorChunks.length > 0) {
			await indexVectors(this.vectorize, this.embedFn, allVectorChunks);
		}

		return {
			documents: docs.length,
			chunks: totalChunks,
			skipped: skippedCount,
		};
	}

	/**
	 * Remove a document and all its chunks from the index.
	 * Also removes vectors from Vectorize if configured.
	 */
	async remove(docId: string): Promise<void> {
		this.ensureInit();

		if (this.vectorize) {
			await removeVectors(this.vectorize, this.sql, docId);
		}

		// Delete chunks (FTS cleanup via trigger)
		this.sql.exec("DELETE FROM qmd_chunks WHERE doc_id = ?", docId);
		// Delete document
		this.sql.exec("DELETE FROM qmd_documents WHERE id = ?", docId);
	}

	/**
	 * Full-text search using FTS5 BM25 ranking.
	 * Always available — no external dependencies needed.
	 */
	searchFts(query: string, options?: SearchOptions): FtsResult[] {
		this.ensureInit();
		return searchFts(this.sql, query, options);
	}

	/**
	 * Vector similarity search using Cloudflare Vectorize.
	 * Requires vectorize + embedFn to be configured.
	 */
	async searchVector(
		query: string,
		options?: SearchOptions,
	): Promise<VectorResult[]> {
		if (!this.vectorize || !this.embedFn) {
			throw new Error(
				"Vector search requires vectorize and embedFn to be configured",
			);
		}
		this.ensureInit();
		return searchVector(this.vectorize, this.embedFn, this.sql, query, options);
	}

	/**
	 * Hybrid search combining FTS5 BM25 + Vectorize similarity via Reciprocal Rank Fusion.
	 *
	 * If only FTS is available, falls back to FTS-only results wrapped as SearchResult[].
	 * If both are available, runs FTS first as a probe. If BM25 has a strong signal
	 * (top score >= 0.85 with gap >= 0.15 to second), returns FTS results directly
	 * without the Vectorize round-trip. Otherwise, runs vector search and fuses with RRF.
	 */
	async search(
		query: string,
		options?: HybridSearchOptions,
	): Promise<SearchResult[]> {
		this.ensureInit();

		const limit = options?.limit ?? 10;
		// Fetch more from each source for better fusion
		const sourceFetchLimit = limit * 3;

		const ftsOptions: SearchOptions = {
			limit: sourceFetchLimit,
			docType: options?.docType,
			namespace: options?.namespace,
		};

		// FTS-only mode
		if (!this.vectorize || !this.embedFn) {
			const ftsResults = searchFts(this.sql, query, ftsOptions);
			return ftsResults.slice(0, limit).map((r) => ({
				docId: r.docId,
				score: r.score,
				snippet: r.snippet,
				sources: ["fts"] as Array<"fts" | "vector">,
				sourceScores: { fts: r.score },
				title: r.title,
				docType: r.docType,
				namespace: r.namespace,
				metadata: r.metadata,
			}));
		}

		// Hybrid mode: run FTS first for strong signal probe
		const ftsResults = searchFts(this.sql, query, ftsOptions);

		// Strong signal detection: if BM25 has a clear winner, skip vector search
		if (ftsResults.length >= 1) {
			const topScore = ftsResults[0].score;
			const secondScore = ftsResults.length >= 2 ? ftsResults[1].score : 0;

			if (
				topScore >= STRONG_SIGNAL_MIN_SCORE &&
				topScore - secondScore >= STRONG_SIGNAL_MIN_GAP
			) {
				return ftsResults.slice(0, limit).map((r) => ({
					docId: r.docId,
					score: r.score,
					snippet: r.snippet,
					sources: ["fts"] as Array<"fts" | "vector">,
					sourceScores: { fts: r.score },
					title: r.title,
					docType: r.docType,
					namespace: r.namespace,
					metadata: r.metadata,
				}));
			}
		}

		// No strong signal — run vector search and fuse
		const vectorOptions: SearchOptions = {
			limit: sourceFetchLimit,
			docType: options?.docType,
			namespace: options?.namespace,
		};

		const vectorResults = await searchVector(
			this.vectorize,
			this.embedFn,
			this.sql,
			query,
			vectorOptions,
		);

		return reciprocalRankFusion(ftsResults, vectorResults, {
			ftsWeight: options?.ftsWeight,
			vectorWeight: options?.vectorWeight,
			k: options?.rrfK,
			limit,
		});
	}

	/**
	 * Get a document by ID. Returns the full reconstructed content.
	 */
	get(
		docId: string,
	): { content: string; title: string | null; docType: string | null } | null {
		this.ensureInit();

		const doc = this.sql
			.exec<{ title: string | null; doc_type: string | null }>(
				"SELECT title, doc_type FROM qmd_documents WHERE id = ?",
				docId,
			)
			.toArray();

		if (doc.length === 0) return null;

		const chunks = this.sql
			.exec<{ content: string }>(
				"SELECT content FROM qmd_chunks WHERE doc_id = ? ORDER BY seq",
				docId,
			)
			.toArray();

		// Reconstruct content from chunks (overlap means we can't just concatenate)
		// For now, return the first chunk's full text + subsequent chunks' non-overlapping portions
		// This is an approximation — exact reconstruction would need char_offset tracking
		const content = chunks.map((c) => c.content).join("\n\n");

		return {
			content,
			title: doc[0].title,
			docType: doc[0].doc_type,
		};
	}

	/**
	 * Check if a document exists in the index.
	 */
	has(docId: string): boolean {
		this.ensureInit();
		const result = this.sql
			.exec<{ cnt: number }>(
				"SELECT COUNT(*) as cnt FROM qmd_documents WHERE id = ?",
				docId,
			)
			.toArray();
		return result.length > 0 && result[0].cnt > 0;
	}

	/**
	 * List all indexed document IDs, optionally filtered.
	 */
	list(options?: { namespace?: string; docType?: string }): string[] {
		this.ensureInit();

		const filters: string[] = [];
		const bindings: unknown[] = [];

		if (options?.namespace) {
			filters.push("namespace = ?");
			bindings.push(options.namespace);
		}
		if (options?.docType) {
			filters.push("doc_type = ?");
			bindings.push(options.docType);
		}

		const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

		return this.sql
			.exec<{ id: string }>(
				`SELECT id FROM qmd_documents ${where} ORDER BY id`,
				...bindings,
			)
			.toArray()
			.map((r) => r.id);
	}

	/**
	 * List documents by namespace pattern. Direct SQL query — no FTS or vector search.
	 * Supports glob patterns: "people/*" matches all namespaces starting with "people/".
	 * Returns documents ordered by most recently updated first.
	 */
	listByNamespace(
		pattern: string,
		limit = 50,
	): Array<{
		docId: string;
		title: string | null;
		content: string;
		namespace: string | null;
	}> {
		this.ensureInit();

		let whereClause: string;
		let binding: string;

		if (pattern.includes("*")) {
			const prefix = pattern.replace(/\*+$/, "").replace(/\/+$/, "");
			whereClause = "d.namespace LIKE ?";
			binding = `${prefix}/%`;
		} else {
			whereClause = "d.namespace = ?";
			binding = pattern;
		}

		const rows = this.sql
			.exec<{
				id: string;
				title: string | null;
				namespace: string | null;
				content: string;
			}>(
				`SELECT d.id, d.title, d.namespace,
					GROUP_CONCAT(c.content, '\n\n') as content
				 FROM qmd_documents d
				 JOIN qmd_chunks c ON c.doc_id = d.id
				 WHERE ${whereClause}
				 GROUP BY d.id
				 ORDER BY d.updated_at DESC
				 LIMIT ?`,
				binding,
				limit,
			)
			.toArray();

		return rows.map((r) => ({
			docId: r.id,
			title: r.title,
			content: r.content,
			namespace: r.namespace,
		}));
	}

	/**
	 * Get index statistics.
	 */
	stats(): IndexStats {
		this.ensureInit();

		const docCount = this.sql
			.exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM qmd_documents")
			.one().cnt;

		const chunkCount = this.sql
			.exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM qmd_chunks")
			.one().cnt;

		const namespaces = this.sql
			.exec<{ namespace: string }>(
				"SELECT DISTINCT namespace FROM qmd_documents WHERE namespace IS NOT NULL",
			)
			.toArray()
			.map((r) => r.namespace);

		const docTypes = this.sql
			.exec<{ doc_type: string }>(
				"SELECT DISTINCT doc_type FROM qmd_documents WHERE doc_type IS NOT NULL",
			)
			.toArray()
			.map((r) => r.doc_type);

		return {
			totalDocuments: docCount,
			totalChunks: chunkCount,
			totalVectors: 0, // Can't query Vectorize count from binding
			namespaces,
			docTypes,
		};
	}

	/**
	 * Rebuild the FTS index from scratch.
	 * Useful after schema changes or data corruption.
	 */
	rebuild(): void {
		this.ensureInit();
		this.sql.exec(
			"INSERT INTO qmd_chunks_fts(qmd_chunks_fts) VALUES('rebuild')",
		);
	}

	// --- Context system ---

	/**
	 * Set a context description for a path prefix.
	 * Contexts enrich vector embeddings for all documents matching the prefix.
	 */
	setContext(prefix: string, description: string, namespace?: string): void {
		this.ensureInit();
		this.sql.exec(
			"INSERT OR REPLACE INTO qmd_contexts (prefix, namespace, description) VALUES (?, ?, ?)",
			prefix,
			namespace ?? "",
			description,
		);
	}

	/**
	 * Remove a context by prefix.
	 */
	removeContext(prefix: string, namespace?: string): void {
		this.ensureInit();
		this.sql.exec(
			"DELETE FROM qmd_contexts WHERE prefix = ? AND namespace = ?",
			prefix,
			namespace ?? "",
		);
	}

	/**
	 * List all contexts, optionally filtered by namespace.
	 */
	listContexts(
		namespace?: string,
	): Array<{ prefix: string; description: string; namespace: string }> {
		this.ensureInit();
		if (namespace !== undefined) {
			return this.sql
				.exec<{ prefix: string; description: string; namespace: string }>(
					"SELECT prefix, description, namespace FROM qmd_contexts WHERE namespace = ? ORDER BY prefix",
					namespace,
				)
				.toArray();
		}
		return this.sql
			.exec<{ prefix: string; description: string; namespace: string }>(
				"SELECT prefix, description, namespace FROM qmd_contexts ORDER BY prefix",
			)
			.toArray();
	}

	/**
	 * Get all matching contexts for a document ID.
	 * Matches hierarchically: for "life/areas/health/exercise.md",
	 * returns contexts at "", "life/", "life/areas/", "life/areas/health/".
	 * Results ordered from most general to most specific.
	 */
	getContextsForDoc(
		docId: string,
	): Array<{ prefix: string; description: string }> {
		this.ensureInit();

		// Build all possible prefixes
		const prefixes = [""];
		const parts = docId.split("/");
		let current = "";
		for (let i = 0; i < parts.length - 1; i++) {
			current += `${parts[i]}/`;
			prefixes.push(current);
		}
		prefixes.push(docId);

		const placeholders = prefixes.map(() => "?").join(", ");
		return this.sql
			.exec<{ prefix: string; description: string }>(
				`SELECT prefix, description FROM qmd_contexts
				 WHERE prefix IN (${placeholders}) AND namespace = ''
				 ORDER BY length(prefix)`,
				...prefixes,
			)
			.toArray();
	}
}
