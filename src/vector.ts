import { safeParseMetadata } from "./namespace.js";
import type { EmbedFn, SearchOptions, VectorResult } from "./types.js";

/**
 * Format text for embedding (document indexing).
 * Follows nomic/qmd convention of prefixing with title context.
 */
export function formatDocForEmbedding(
	text: string,
	title?: string,
	context?: string,
): string {
	const parts: string[] = [];
	if (context) parts.push(`context: ${context}`);
	parts.push(`title: ${title || "none"}`);
	parts.push(`text: ${text}`);
	return parts.join(" | ");
}

/**
 * Format a query string for embedding (search time).
 */
export function formatQueryForEmbedding(query: string): string {
	return `search_query: ${query}`;
}

/**
 * Index chunks into Vectorize with embeddings.
 *
 * Each chunk gets a vector ID of "{docId}_{seq}" which maps back to qmd_chunks.
 * Vectors are stored in a namespace matching the document's namespace for scoped search.
 */
export async function indexVectors(
	vectorize: Vectorize,
	embedFn: EmbedFn,
	chunks: Array<{
		docId: string;
		seq: number;
		text: string;
		title?: string;
		namespace?: string;
		docType?: string;
		context?: string;
	}>,
): Promise<void> {
	if (chunks.length === 0) return;

	// Format texts for embedding (includes context if provided)
	const texts = chunks.map((c) =>
		formatDocForEmbedding(c.text, c.title, c.context),
	);

	// Generate embeddings in batch (Workers AI supports up to 100 at a time)
	const batchSize = 100;
	for (let i = 0; i < texts.length; i += batchSize) {
		const batchTexts = texts.slice(i, i + batchSize);
		const batchChunks = chunks.slice(i, i + batchSize);

		const embeddings = await embedFn(batchTexts);

		const vectors = batchChunks.map((c, j) => ({
			id: `${c.docId}_${c.seq}`,
			values: embeddings[j],
			namespace: c.namespace ? c.namespace.split("/")[0] : undefined,
			metadata: {
				docId: c.docId,
				seq: c.seq,
				docType: c.docType ?? "",
				directory: c.namespace ?? "",
			},
		}));

		await vectorize.upsert(vectors);
	}
}

/**
 * Remove all vectors for a document from Vectorize.
 */
export async function removeVectors(
	vectorize: Vectorize,
	sql: SqlStorage,
	docId: string,
): Promise<void> {
	// Look up all chunk seq numbers for this document
	const chunks = sql
		.exec<{ seq: number }>("SELECT seq FROM qmd_chunks WHERE doc_id = ?", docId)
		.toArray();

	if (chunks.length === 0) return;

	const ids = chunks.map((c) => `${docId}_${c.seq}`);
	await vectorize.deleteByIds(ids);
}

type ChunkRow = {
	doc_id: string;
	seq: number;
	content: string;
	title: string | null;
	doc_type: string | null;
	namespace: string | null;
	metadata: string | null;
};

/**
 * Execute a vector similarity search via Vectorize.
 *
 * 1. Embed the query
 * 2. Query Vectorize for nearest neighbors (scoped by namespace if provided)
 * 3. Look up chunk content from the local SQLite for snippet extraction
 */
export async function searchVector(
	vectorize: Vectorize,
	embedFn: EmbedFn,
	sql: SqlStorage,
	query: string,
	options: SearchOptions = {},
): Promise<VectorResult[]> {
	const limit = options.limit ?? 10;

	// Embed the query
	const queryText = formatQueryForEmbedding(query);
	const [queryVector] = await embedFn([queryText]);

	// Resolve namespace for Vectorize query: use first path segment for glob/path patterns
	let vectorizeNamespace: string | undefined;
	let directoryPrefix: string | undefined;
	if (options.namespace) {
		if (options.namespace.includes("*")) {
			// Glob pattern: people/* → Vectorize ns "people", no post-filter needed for top-level
			const prefix = options.namespace.replace(/\*+$/, "").replace(/\/+$/, "");
			vectorizeNamespace = prefix.split("/")[0];
			// Only need post-filter if glob is deeper than top-level (e.g. projects/ember/*)
			if (prefix.includes("/")) {
				directoryPrefix = `${prefix}/`;
			}
		} else {
			// Exact directory: people/ryan → Vectorize ns "people", post-filter by full path
			vectorizeNamespace = options.namespace.split("/")[0];
			if (options.namespace.includes("/")) {
				directoryPrefix = options.namespace;
			}
		}
	}

	// Query Vectorize
	const matches = await vectorize.query(queryVector, {
		topK: limit * 3, // Fetch extra for dedup
		returnMetadata: "all",
		namespace: vectorizeNamespace,
	});

	if (matches.matches.length === 0) return [];

	// Collect chunk IDs to look up content from local SQLite
	const chunkKeys = matches.matches.map((m) => {
		const meta = m.metadata as
			| { docId: string; seq: number; docType?: string }
			| undefined;
		return {
			vectorId: m.id,
			score: m.score,
			docId: meta?.docId ?? m.id.split("_").slice(0, -1).join("_"),
			seq: meta?.seq ?? Number.parseInt(m.id.split("_").pop() ?? "0", 10),
		};
	});

	// Filter by docType if specified (Vectorize metadata filtering could also do this,
	// but we filter here for portability)
	let filteredKeys = options.docType
		? chunkKeys.filter((k) => {
				const meta = matches.matches.find((m) => m.id === k.vectorId)?.metadata;
				return meta?.docType === options.docType;
			})
		: chunkKeys;

	// Post-filter by directory prefix when namespace is deeper than first segment
	if (directoryPrefix) {
		filteredKeys = filteredKeys.filter((k) => {
			const meta = matches.matches.find((m) => m.id === k.vectorId)?.metadata;
			const dir = meta?.directory as string | null;
			if (!dir) return false;
			return dir === directoryPrefix || dir.startsWith(`${directoryPrefix}/`);
		});
	}

	if (filteredKeys.length === 0) return [];

	// Batch look up chunk content from SQLite
	const placeholders = filteredKeys.map(() => "(?, ?)").join(", ");
	const bindings = filteredKeys.flatMap((k) => [k.docId, k.seq]);

	const rows = sql
		.exec<ChunkRow>(
			`
			SELECT c.doc_id, c.seq, c.content, d.title, d.doc_type, d.namespace, d.metadata
			FROM qmd_chunks c
			JOIN qmd_documents d ON d.id = c.doc_id
			WHERE (c.doc_id, c.seq) IN (VALUES ${placeholders})
		`,
			...bindings,
		)
		.toArray();

	// Build lookup map
	const chunkMap = new Map<string, ChunkRow>();
	for (const row of rows) {
		chunkMap.set(`${row.doc_id}_${row.seq}`, row);
	}

	// Merge scores with content, dedup by docId
	const seen = new Map<string, VectorResult>();

	for (const key of filteredKeys) {
		const row = chunkMap.get(`${key.docId}_${key.seq}`);
		if (!row) continue;

		const existing = seen.get(key.docId);
		if (!existing || key.score > existing.score) {
			seen.set(key.docId, {
				docId: key.docId,
				score: key.score,
				snippet: row.content,
				seq: key.seq,
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
