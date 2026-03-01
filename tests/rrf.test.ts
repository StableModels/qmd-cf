import { describe, expect, test } from "bun:test";
import { reciprocalRankFusion } from "../src/rrf.js";
import type { FtsResult, VectorResult } from "../src/types.js";

function makeFtsResult(docId: string, score: number): FtsResult {
	return {
		docId,
		score,
		snippet: `fts snippet for ${docId}`,
		seq: 0,
		title: null,
		docType: null,
		namespace: null,
		metadata: null,
	};
}

function makeVectorResult(docId: string, score: number): VectorResult {
	return {
		docId,
		score,
		snippet: `vector snippet for ${docId}`,
		seq: 0,
		title: null,
		docType: null,
		namespace: null,
		metadata: null,
	};
}

describe("reciprocalRankFusion", () => {
	test("returns empty array for empty inputs", () => {
		const results = reciprocalRankFusion([], []);
		expect(results).toEqual([]);
	});

	test("handles FTS-only results", () => {
		const fts = [makeFtsResult("doc1", 0.9), makeFtsResult("doc2", 0.5)];
		const results = reciprocalRankFusion(fts, []);

		expect(results).toHaveLength(2);
		expect(results[0].docId).toBe("doc1");
		expect(results[0].sources).toEqual(["fts"]);
		expect(results[0].sourceScores.fts).toBe(0.9);
		expect(results[0].sourceScores.vector).toBeUndefined();
	});

	test("handles vector-only results", () => {
		const vec = [makeVectorResult("doc1", 0.8), makeVectorResult("doc2", 0.6)];
		const results = reciprocalRankFusion([], vec);

		expect(results).toHaveLength(2);
		expect(results[0].docId).toBe("doc1");
		expect(results[0].sources).toEqual(["vector"]);
		expect(results[0].sourceScores.vector).toBe(0.8);
	});

	test("merges overlapping results from both sources", () => {
		const fts = [makeFtsResult("doc1", 0.9)];
		const vec = [makeVectorResult("doc1", 0.8)];

		const results = reciprocalRankFusion(fts, vec);

		expect(results).toHaveLength(1);
		expect(results[0].docId).toBe("doc1");
		expect(results[0].sources).toContain("fts");
		expect(results[0].sources).toContain("vector");
		expect(results[0].sourceScores.fts).toBe(0.9);
		expect(results[0].sourceScores.vector).toBe(0.8);
	});

	test("document appearing in both lists scores higher than single-list", () => {
		const fts = [makeFtsResult("doc1", 0.9), makeFtsResult("doc2", 0.8)];
		const vec = [makeVectorResult("doc1", 0.85)];

		const results = reciprocalRankFusion(fts, vec);

		// doc1 appears in both, should score higher than doc2 (FTS only)
		const doc1 = results.find((r) => r.docId === "doc1");
		const doc2 = results.find((r) => r.docId === "doc2");
		expect(doc1?.score).toBeGreaterThan(doc2?.score);
	});

	test("applies top-rank bonus for rank #1", () => {
		const fts = [makeFtsResult("doc1", 0.9)];
		const vec: VectorResult[] = [];

		const results = reciprocalRankFusion(fts, vec);

		// RRF score = 1/(60+0+1) + 0.05 (top-rank bonus)
		const expectedBase = 1 / 61;
		const expectedWithBonus = expectedBase + 0.05;
		expect(results[0].score).toBeCloseTo(expectedWithBonus, 5);
	});

	test("applies top-rank bonus for ranks #2-3", () => {
		const fts = [
			makeFtsResult("doc1", 0.9),
			makeFtsResult("doc2", 0.8),
			makeFtsResult("doc3", 0.7),
		];

		const results = reciprocalRankFusion(fts, []);

		// doc2 is at rank 1 (0-indexed), gets +0.02
		const doc2 = results.find((r) => r.docId === "doc2");
		const expectedBase = 1 / 62; // 1/(60+1+1)
		const expectedWithBonus = expectedBase + 0.02;
		expect(doc2?.score).toBeCloseTo(expectedWithBonus, 5);

		// doc3 is at rank 2, also gets +0.02
		const doc3 = results.find((r) => r.docId === "doc3");
		const expectedBase3 = 1 / 63;
		const expectedWithBonus3 = expectedBase3 + 0.02;
		expect(doc3?.score).toBeCloseTo(expectedWithBonus3, 5);
	});

	test("no bonus for rank >= 3", () => {
		const fts = [
			makeFtsResult("doc1", 0.9),
			makeFtsResult("doc2", 0.8),
			makeFtsResult("doc3", 0.7),
			makeFtsResult("doc4", 0.6),
		];

		const results = reciprocalRankFusion(fts, []);

		// doc4 is at rank 3 (0-indexed), gets no bonus
		const doc4 = results.find((r) => r.docId === "doc4");
		const expected = 1 / 64; // 1/(60+3+1)
		expect(doc4?.score).toBeCloseTo(expected, 5);
	});

	test("respects custom weights", () => {
		const fts = [makeFtsResult("fts-only", 0.9)];
		const vec = [makeVectorResult("vec-only", 0.9)];

		// Double the FTS weight
		const results = reciprocalRankFusion(fts, vec, {
			ftsWeight: 2.0,
			vectorWeight: 1.0,
		});

		const ftsDoc = results.find((r) => r.docId === "fts-only");
		const vecDoc = results.find((r) => r.docId === "vec-only");

		// ftsDoc should score higher because ftsWeight=2
		expect(ftsDoc?.score).toBeGreaterThan(vecDoc?.score);
	});

	test("respects custom k value", () => {
		const fts = [makeFtsResult("doc1", 0.9)];

		const smallK = reciprocalRankFusion(fts, [], { k: 10 });
		const largeK = reciprocalRankFusion(fts, [], { k: 100 });

		// Smaller k means rank #1 has more impact -> higher score
		expect(smallK[0].score).toBeGreaterThan(largeK[0].score);
	});

	test("respects limit option", () => {
		const fts = Array.from({ length: 20 }, (_, i) =>
			makeFtsResult(`doc${i}`, 0.9 - i * 0.01),
		);

		const results = reciprocalRankFusion(fts, [], { limit: 5 });
		expect(results).toHaveLength(5);
	});

	test("results are sorted by score descending", () => {
		const fts = [
			makeFtsResult("doc1", 0.5),
			makeFtsResult("doc2", 0.9),
			makeFtsResult("doc3", 0.7),
		];

		const results = reciprocalRankFusion(fts, []);

		for (let i = 1; i < results.length; i++) {
			expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
		}
	});

	test("preserves metadata from source results", () => {
		const fts: FtsResult[] = [
			{
				docId: "doc1",
				score: 0.9,
				snippet: "hello",
				seq: 0,
				title: "My Title",
				docType: "fact",
				namespace: "ns1",
				metadata: { key: "val" },
			},
		];

		const results = reciprocalRankFusion(fts, []);
		expect(results[0].title).toBe("My Title");
		expect(results[0].docType).toBe("fact");
		expect(results[0].namespace).toBe("ns1");
		expect(results[0].metadata).toEqual({ key: "val" });
	});

	test("uses vector snippet when vector score is higher", () => {
		const fts = [makeFtsResult("doc1", 0.3)];
		const vec = [makeVectorResult("doc1", 0.9)];

		const results = reciprocalRankFusion(fts, vec);
		expect(results[0].snippet).toContain("vector snippet");
	});

	test("uses fts snippet when fts score is higher", () => {
		const fts = [makeFtsResult("doc1", 0.9)];
		const vec = [makeVectorResult("doc1", 0.3)];

		const results = reciprocalRankFusion(fts, vec);
		expect(results[0].snippet).toContain("fts snippet");
	});

	test("handles duplicate docId in same FTS list (accumulates scores)", () => {
		// If the same docId appears multiple times in FTS results (e.g. from multiple chunks
		// before dedup), RRF should accumulate the contributions
		const fts = [makeFtsResult("doc1", 0.9), makeFtsResult("doc1", 0.7)];
		const results = reciprocalRankFusion(fts, []);

		expect(results).toHaveLength(1);
		expect(results[0].docId).toBe("doc1");
		// Score should be accumulated from both ranks + top-rank bonus
		const expectedScore = 1 / 61 + 1 / 62 + 0.05;
		expect(results[0].score).toBeCloseTo(expectedScore, 5);
	});
});
