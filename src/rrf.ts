import type { FtsResult, SearchResult, VectorResult } from "./types.js";

/**
 * Reciprocal Rank Fusion (RRF) — merge ranked result lists into a single ranking.
 *
 * RRF score for document d = Σ(weight_i / (k + rank_i + 1)) across all lists
 * where rank_i is the 0-based position in list i.
 *
 * From qmd: k=60 is the standard constant. Higher k reduces the impact of
 * being ranked #1 vs #5, making the fusion more conservative.
 *
 * Additionally applies a top-rank bonus (from qmd):
 * - Rank #1 in any list: +0.05
 * - Rank #2-3 in any list: +0.02
 * This prevents exact matches from being diluted by expansion queries.
 */
export function reciprocalRankFusion(
	ftsResults: FtsResult[],
	vectorResults: VectorResult[],
	options: {
		ftsWeight?: number;
		vectorWeight?: number;
		k?: number;
		limit?: number;
	} = {},
): SearchResult[] {
	const k = options.k ?? 60;
	const ftsWeight = options.ftsWeight ?? 1.0;
	const vectorWeight = options.vectorWeight ?? 1.0;
	const limit = options.limit ?? 10;

	const scores = new Map<
		string,
		{
			rrfScore: number;
			topRank: number;
			sources: Set<"fts" | "vector">;
			sourceScores: { fts?: number; vector?: number };
			bestResult: FtsResult | VectorResult;
		}
	>();

	// Process FTS results
	for (let rank = 0; rank < ftsResults.length; rank++) {
		const r = ftsResults[rank];
		const contribution = ftsWeight / (k + rank + 1);
		const entry = scores.get(r.docId);

		if (entry) {
			entry.rrfScore += contribution;
			entry.topRank = Math.min(entry.topRank, rank);
			entry.sources.add("fts");
			entry.sourceScores.fts = r.score;
		} else {
			scores.set(r.docId, {
				rrfScore: contribution,
				topRank: rank,
				sources: new Set(["fts"]),
				sourceScores: { fts: r.score },
				bestResult: r,
			});
		}
	}

	// Process vector results
	for (let rank = 0; rank < vectorResults.length; rank++) {
		const r = vectorResults[rank];
		const contribution = vectorWeight / (k + rank + 1);
		const entry = scores.get(r.docId);

		if (entry) {
			entry.rrfScore += contribution;
			entry.topRank = Math.min(entry.topRank, rank);
			entry.sources.add("vector");
			entry.sourceScores.vector = r.score;
			// Keep the result with better snippet context
			if (r.score > (entry.sourceScores.fts ?? 0)) {
				entry.bestResult = r;
			}
		} else {
			scores.set(r.docId, {
				rrfScore: contribution,
				topRank: rank,
				sources: new Set(["vector"]),
				sourceScores: { vector: r.score },
				bestResult: r,
			});
		}
	}

	// Apply top-rank bonus
	for (const entry of scores.values()) {
		if (entry.topRank === 0) {
			entry.rrfScore += 0.05;
		} else if (entry.topRank <= 2) {
			entry.rrfScore += 0.02;
		}
	}

	// Sort by RRF score and return
	return Array.from(scores.entries())
		.sort((a, b) => b[1].rrfScore - a[1].rrfScore)
		.slice(0, limit)
		.map(([docId, entry]) => ({
			docId,
			score: entry.rrfScore,
			snippet: entry.bestResult.snippet,
			sources: Array.from(entry.sources),
			sourceScores: entry.sourceScores,
			title: entry.bestResult.title,
			docType: entry.bestResult.docType,
			namespace: entry.bestResult.namespace,
			metadata: entry.bestResult.metadata,
		}));
}
