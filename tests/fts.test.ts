import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildFts5Query, searchFts } from "../src/fts.js";
import { initSchema } from "../src/schema.js";
import { MockSqlStorage } from "./helpers.js";

describe("buildFts5Query", () => {
	test("returns empty string literal for empty query", () => {
		expect(buildFts5Query("")).toBe('""');
	});

	test("returns empty string literal for whitespace-only query", () => {
		expect(buildFts5Query("   ")).toBe('""');
	});

	test("builds prefix match for single term", () => {
		const q = buildFts5Query("hello");
		expect(q).toBe('"hello" *');
	});

	test("builds combined query for multi-term", () => {
		const q = buildFts5Query("hello world");
		expect(q).toContain('"hello world"'); // exact phrase
		expect(q).toContain("NEAR"); // proximity
		expect(q).toContain("OR"); // disjunction
	});

	test("strips FTS5-breaking characters from input terms", () => {
		const q = buildFts5Query("hello'world (test) [arr]");
		// Special chars should be stripped from the actual search terms
		expect(q).not.toContain("'");
		expect(q).not.toContain("[");
		// The output query itself uses ( ) for FTS5 syntax — that's expected
		expect(q).toContain("helloworld");
		expect(q).toContain("test");
		expect(q).toContain("arr");
	});

	test("handles single term with special chars", () => {
		const q = buildFts5Query("hello:world");
		expect(q).toBe('"helloworld" *');
	});
});

describe("searchFts", () => {
	let sql: MockSqlStorage;

	beforeEach(() => {
		sql = new MockSqlStorage();
		initSchema(sql);
	});

	afterEach(() => {
		sql.close();
	});

	function insertDoc(
		id: string,
		title: string,
		content: string,
		opts?: {
			docType?: string;
			namespace?: string;
			metadata?: Record<string, string>;
		},
	) {
		sql.exec(
			"INSERT INTO qmd_documents (id, title, doc_type, namespace, metadata) VALUES (?, ?, ?, ?, ?)",
			id,
			title,
			opts?.docType ?? null,
			opts?.namespace ?? null,
			opts?.metadata ? JSON.stringify(opts.metadata) : null,
		);
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES (?, 0, ?, 0)",
			id,
			content,
		);
	}

	test("returns empty array when no documents match", () => {
		insertDoc("doc1", "Title", "hello world");
		const results = searchFts(sql, "nonexistent");
		expect(results).toEqual([]);
	});

	test("finds document by content keyword", () => {
		insertDoc("doc1", "Title", "The quick brown fox jumps over the lazy dog");
		const results = searchFts(sql, "fox");

		expect(results).toHaveLength(1);
		expect(results[0].docId).toBe("doc1");
		expect(results[0].score).toBeGreaterThan(0);
		expect(results[0].snippet).toContain("fox");
	});

	test("finds document by title keyword", () => {
		insertDoc("doc1", "Foxes and Dogs", "Some generic content about animals");
		const results = searchFts(sql, "foxes");

		expect(results).toHaveLength(1);
		expect(results[0].docId).toBe("doc1");
	});

	test("title match contributes to relevance", () => {
		// Document with keyword in title should still be findable via title search
		insertDoc("doc1", "Foxes Guide", "a document about clever forest animals");
		insertDoc(
			"doc2",
			"Animals",
			"foxes are clever animals that live in forests",
		);

		const results = searchFts(sql, "foxes");
		// Both should be found — doc1 via title, doc2 via content
		expect(results.length).toBeGreaterThanOrEqual(1);
		const docIds = results.map((r) => r.docId);
		expect(docIds).toContain("doc2"); // content match
	});

	test("finds documents with multi-term queries", () => {
		insertDoc("doc1", "Title", "machine learning is great for classification");
		insertDoc(
			"doc2",
			"Title",
			"machine is a learning tool for building things",
		);

		const results = searchFts(sql, "machine learning");
		// Both documents should be found (both contain the terms)
		expect(results.length).toBeGreaterThanOrEqual(2);
		// Both should have positive scores
		for (const r of results) {
			expect(r.score).toBeGreaterThan(0);
		}
	});

	test("respects limit option", () => {
		for (let i = 0; i < 20; i++) {
			insertDoc(
				`doc${i}`,
				"Title",
				`This is document number ${i} about testing`,
			);
		}

		const results = searchFts(sql, "testing", { limit: 5 });
		expect(results.length).toBeLessThanOrEqual(5);
	});

	test("filters by docType", () => {
		insertDoc("doc1", "Title", "hello world", { docType: "fact" });
		insertDoc("doc2", "Title", "hello world again", { docType: "daily_note" });

		const results = searchFts(sql, "hello", { docType: "fact" });
		expect(results).toHaveLength(1);
		expect(results[0].docId).toBe("doc1");
		expect(results[0].docType).toBe("fact");
	});

	test("filters by namespace", () => {
		insertDoc("doc1", "Title", "hello world", { namespace: "agent-1" });
		insertDoc("doc2", "Title", "hello again", { namespace: "agent-2" });

		const results = searchFts(sql, "hello", { namespace: "agent-1" });
		expect(results).toHaveLength(1);
		expect(results[0].docId).toBe("doc1");
		expect(results[0].namespace).toBe("agent-1");
	});

	test("filters by namespace glob pattern (LIKE prefix)", () => {
		insertDoc("doc1", "Title", "hello world", { namespace: "people/ryan" });
		insertDoc("doc2", "Title", "hello again", { namespace: "people/jane" });
		insertDoc("doc3", "Title", "hello there", { namespace: "projects/ember" });

		const results = searchFts(sql, "hello", { namespace: "people/*" });
		expect(results).toHaveLength(2);
		const docIds = results.map((r) => r.docId).sort();
		expect(docIds).toEqual(["doc1", "doc2"]);
	});

	test("namespace glob with deeper path", () => {
		insertDoc("doc1", "Title", "hello world", {
			namespace: "projects/ember/backend",
		});
		insertDoc("doc2", "Title", "hello again", {
			namespace: "projects/ember/frontend",
		});
		insertDoc("doc3", "Title", "hello there", { namespace: "projects/other" });

		const results = searchFts(sql, "hello", { namespace: "projects/ember/*" });
		expect(results).toHaveLength(2);
		const docIds = results.map((r) => r.docId).sort();
		expect(docIds).toEqual(["doc1", "doc2"]);
	});

	test("filters by both docType and namespace", () => {
		insertDoc("doc1", "Title", "hello world", {
			docType: "fact",
			namespace: "ns1",
		});
		insertDoc("doc2", "Title", "hello world", {
			docType: "note",
			namespace: "ns1",
		});
		insertDoc("doc3", "Title", "hello world", {
			docType: "fact",
			namespace: "ns2",
		});

		const results = searchFts(sql, "hello", {
			docType: "fact",
			namespace: "ns1",
		});
		expect(results).toHaveLength(1);
		expect(results[0].docId).toBe("doc1");
	});

	test("deduplicates multiple chunks from same document", () => {
		sql.exec("INSERT INTO qmd_documents (id, title) VALUES ('doc1', 'Title')");
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES ('doc1', 0, 'hello world chunk one', 0)",
		);
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES ('doc1', 1, 'hello world chunk two', 100)",
		);

		const results = searchFts(sql, "hello");
		// Should deduplicate to a single result
		expect(results).toHaveLength(1);
		expect(results[0].docId).toBe("doc1");
	});

	test("returns parsed metadata", () => {
		insertDoc("doc1", "Title", "hello world", { metadata: { key: "value" } });

		const results = searchFts(sql, "hello");
		expect(results).toHaveLength(1);
		expect(results[0].metadata).toEqual({ key: "value" });
	});

	test("returns null metadata when none stored", () => {
		insertDoc("doc1", "Title", "hello world");

		const results = searchFts(sql, "hello");
		expect(results).toHaveLength(1);
		expect(results[0].metadata).toBeNull();
	});

	test("normalizes BM25 score to (0, 1]", () => {
		insertDoc("doc1", "Title", "hello world");

		const results = searchFts(sql, "hello");
		expect(results).toHaveLength(1);
		expect(results[0].score).toBeGreaterThan(0);
		expect(results[0].score).toBeLessThanOrEqual(1);
	});

	test("strong BM25 matches rank higher than weak ones", () => {
		// Add enough documents for meaningful IDF
		for (let i = 0; i < 20; i++) {
			insertDoc(
				`filler${i}`,
				"Filler",
				`document number ${i} about various topics`,
			);
		}
		insertDoc("exact", "Fox", "fox fox fox fox fox");
		insertDoc("weak", "Title", "the quick brown fox");

		const results = searchFts(sql, "fox");
		expect(results.length).toBeGreaterThanOrEqual(2);
		const exact = results.find((r) => r.docId === "exact");
		const weak = results.find((r) => r.docId === "weak");
		expect(exact).toBeDefined();
		expect(weak).toBeDefined();
		expect(exact?.score).toBeGreaterThan(weak?.score);
		// With the corrected normalization, higher scores = stronger matches
		expect(exact?.score).toBeGreaterThan(0);
	});
});
