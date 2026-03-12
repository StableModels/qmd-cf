import { buildNamespaceFilter, safeParseMetadata } from "./namespace.js";
import type { FtsResult, SearchOptions } from "./types.js";

/**
 * Build an FTS5 query string from a natural language query.
 *
 * Strategy (from qmd):
 * - Single term: prefix match ("term"*)
 * - Multi-term: exact phrase OR NEAR(terms, 10) OR individual terms ORed
 *
 * This gives good recall while still ranking exact matches highest via BM25.
 */
export function buildFts5Query(query: string): string {
	const terms = query
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0)
		// Strip characters that break FTS5 syntax
		.map((t) => t.replace(/['"(){}[\]*^~:]/g, ""));

	if (terms.length === 0) return '""';

	if (terms.length === 1) {
		// Single term: prefix match
		return `"${terms[0]}" *`;
	}

	// Multi-term: combine strategies for best recall
	const phrase = `"${terms.join(" ")}"`;
	const near = `NEAR(${terms.map((t) => `"${t}"`).join(" ")}, 10)`;
	const orTerms = terms.map((t) => `"${t}"`).join(" OR ");

	return `(${phrase}) OR (${near}) OR (${orTerms})`;
}

/**
 * Normalize a raw BM25 score to (0, 1).
 * SQLite FTS5 bm25() returns negative values where lower (more negative) = better match.
 * We convert to: score = abs(raw) / (1 + abs(raw))
 */
function normalizeBm25(raw: number): number {
	return Math.abs(raw) / (1 + Math.abs(raw));
}

type FtsRow = {
	doc_id: string;
	seq: number;
	content: string;
	rank: number;
	title: string | null;
	doc_type: string | null;
	namespace: string | null;
	metadata: string | null;
};

/**
 * Execute a full-text search using FTS5 BM25 ranking.
 *
 * BM25 weights: title gets 10x boost, content gets 1x.
 * Results are deduplicated by document (keeping the best-scoring chunk).
 */
export function searchFts(
	sql: SqlStorage,
	query: string,
	options: SearchOptions = {},
): FtsResult[] {
	const ftsQuery = buildFts5Query(query);
	const limit = options.limit ?? 10;

	// Build WHERE clauses for optional filters
	const filters: string[] = [];
	const bindings: unknown[] = [ftsQuery];

	if (options.docType) {
		filters.push("d.doc_type = ?");
		bindings.push(options.docType);
	}
	if (options.namespace) {
		const nsFilter = buildNamespaceFilter(options.namespace, "d.namespace");
		filters.push(nsFilter.clause);
		bindings.push(nsFilter.binding);
	}

	const whereClause = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";

	// BM25 weights: doc_id (unindexed, 0), seq (unindexed, 0), title (10.0), content (1.0)
	const rows = sql
		.exec<FtsRow>(
			`
			SELECT
				f.doc_id,
				f.seq,
				f.content,
				bm25(qmd_chunks_fts, 0, 0, 10.0, 1.0) as rank,
				d.title,
				d.doc_type,
				d.namespace,
				d.metadata
			FROM qmd_chunks_fts f
			JOIN qmd_documents d ON d.id = f.doc_id
			WHERE qmd_chunks_fts MATCH ?
			${whereClause}
			ORDER BY rank
			LIMIT ?
		`,
			...bindings,
			// Fetch extra to allow dedup
			limit * 3,
		)
		.toArray();

	// Deduplicate by doc_id, keeping the best-scoring chunk
	const seen = new Map<string, FtsResult>();

	for (const row of rows) {
		const score = normalizeBm25(row.rank);
		const existing = seen.get(row.doc_id);

		if (!existing || score > existing.score) {
			seen.set(row.doc_id, {
				docId: row.doc_id,
				score,
				snippet: row.content,
				seq: row.seq as number,
				title: row.title,
				docType: row.doc_type,
				namespace: row.namespace,
				metadata: safeParseMetadata(row.metadata),
			});
		}
	}

	return Array.from(seen.values())
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}
