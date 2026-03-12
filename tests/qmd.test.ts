import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Qmd } from "../src/qmd.js";
import { MockSqlStorage, MockVectorize, createMockEmbedFn } from "./helpers.js";

describe("Qmd", () => {
	let sql: MockSqlStorage;

	beforeEach(() => {
		sql = new MockSqlStorage();
	});

	afterEach(() => {
		sql.close();
	});

	describe("constructor", () => {
		test("creates FTS-only instance", () => {
			const qmd = new Qmd(sql);
			expect(qmd.hasVectorSearch).toBe(false);
		});

		test("creates hybrid instance", () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });
			expect(qmd.hasVectorSearch).toBe(true);
		});

		test("throws when vectorize provided without embedFn", () => {
			const vectorize = new MockVectorize();
			expect(() => new Qmd(sql, { vectorize })).toThrow(
				"embedFn is required when vectorize is provided",
			);
		});

		test("accepts custom config", () => {
			const qmd = new Qmd(sql, {
				config: { chunkSize: 1600, chunkOverlap: 240, tokenizer: "unicode61" },
			});
			// Should not throw
			expect(qmd).toBeDefined();
		});
	});

	describe("index", () => {
		test("indexes a simple document", async () => {
			const qmd = new Qmd(sql);
			const result = await qmd.index({
				id: "doc1",
				content: "Hello, world!",
				title: "Greeting",
			});

			expect(result.chunks).toBe(1);
			expect(result.skipped).toBe(false);
			expect(qmd.has("doc1")).toBe(true);
		});

		test("chunks long documents", async () => {
			const qmd = new Qmd(sql, { config: { chunkSize: 50, chunkOverlap: 5 } });
			const result = await qmd.index({
				id: "doc1",
				content: "word ".repeat(40), // 200 chars
			});

			expect(result.chunks).toBeGreaterThan(1);
		});

		test("stores document metadata", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({
				id: "doc1",
				content: "Hello",
				title: "Greeting",
				docType: "fact",
				namespace: "ns1",
				metadata: { importance: "high" },
			});

			const doc = qmd.get("doc1");
			expect(doc).not.toBeNull();
			expect(doc?.title).toBe("Greeting");
			expect(doc?.docType).toBe("fact");
		});

		test("upserts on duplicate ID", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "version 1" });
			await qmd.index({ id: "doc1", content: "version 2" });

			const doc = qmd.get("doc1");
			expect(doc?.content).toContain("version 2");
			expect(doc?.content).not.toContain("version 1");
		});

		test("indexes into Vectorize when configured", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			await qmd.index({ id: "doc1", content: "Hello, world!" });
			expect(vectorize.storedVectors.size).toBe(1);
		});

		test("does not call Vectorize when not configured", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "Hello, world!" });
			// No error, FTS-only mode
			expect(qmd.has("doc1")).toBe(true);
		});
	});

	describe("indexBatch", () => {
		test("indexes multiple documents", async () => {
			const qmd = new Qmd(sql);
			const result = await qmd.indexBatch([
				{ id: "doc1", content: "Hello" },
				{ id: "doc2", content: "World" },
				{ id: "doc3", content: "Foo" },
			]);

			expect(result.documents).toBe(3);
			expect(result.chunks).toBe(3);
			expect(qmd.has("doc1")).toBe(true);
			expect(qmd.has("doc2")).toBe(true);
			expect(qmd.has("doc3")).toBe(true);
		});

		test("batch indexes vectors when configured", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			await qmd.indexBatch([
				{ id: "doc1", content: "Hello" },
				{ id: "doc2", content: "World" },
			]);

			expect(vectorize.storedVectors.size).toBe(2);
		});
	});

	describe("remove", () => {
		test("removes a document and its chunks", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "Hello, world!" });
			expect(qmd.has("doc1")).toBe(true);

			await qmd.remove("doc1");
			expect(qmd.has("doc1")).toBe(false);

			// FTS should also be cleaned up
			const results = qmd.searchFts("hello");
			expect(results).toHaveLength(0);
		});

		test("removes vectors from Vectorize", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			await qmd.index({ id: "doc1", content: "Hello, world!" });
			expect(vectorize.storedVectors.size).toBe(1);

			await qmd.remove("doc1");
			expect(vectorize.storedVectors.size).toBe(0);
		});

		test("handles removing nonexistent document gracefully", async () => {
			const qmd = new Qmd(sql);
			await qmd.remove("nonexistent");
			// Should not throw
		});
	});

	describe("searchFts", () => {
		test("finds indexed document by keyword", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({
				id: "doc1",
				content: "The quick brown fox",
				title: "Animals",
			});

			const results = qmd.searchFts("fox");
			expect(results).toHaveLength(1);
			expect(results[0].docId).toBe("doc1");
		});

		test("returns empty for no match", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "Hello, world!" });

			const results = qmd.searchFts("nonexistent");
			expect(results).toEqual([]);
		});

		test("respects search options", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({
				id: "doc1",
				content: "Hello, world!",
				docType: "fact",
			});
			await qmd.index({
				id: "doc2",
				content: "Hello, there!",
				docType: "note",
			});

			const results = qmd.searchFts("hello", { docType: "fact" });
			expect(results).toHaveLength(1);
			expect(results[0].docId).toBe("doc1");
		});
	});

	describe("searchVector", () => {
		test("throws when not configured", async () => {
			const qmd = new Qmd(sql);
			await expect(qmd.searchVector("hello")).rejects.toThrow(
				"Vector search requires vectorize and embedFn to be configured",
			);
		});

		test("finds indexed documents via vector search", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			await qmd.index({ id: "doc1", content: "machine learning algorithms" });
			await qmd.index({ id: "doc2", content: "deep neural networks" });

			const results = await qmd.searchVector("machine learning");
			expect(results.length).toBeGreaterThan(0);
		});
	});

	describe("search (hybrid)", () => {
		test("falls back to FTS-only when Vectorize not configured", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({
				id: "doc1",
				content: "Hello, world!",
				title: "Greeting",
			});

			const results = await qmd.search("hello");
			expect(results).toHaveLength(1);
			expect(results[0].sources).toEqual(["fts"]);
			expect(results[0].sourceScores.fts).toBeDefined();
			expect(results[0].sourceScores.vector).toBeUndefined();
		});

		test("runs hybrid search when both are configured", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			await qmd.index({
				id: "doc1",
				content: "machine learning algorithms for classification",
			});

			const results = await qmd.search("machine learning");
			expect(results).toHaveLength(1);
			expect(results[0].docId).toBe("doc1");
			// Should have both sources since the doc matches both FTS and vector
			expect(results[0].sources).toContain("fts");
			expect(results[0].sources).toContain("vector");
		});

		test("respects limit in hybrid mode", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			for (let i = 0; i < 20; i++) {
				await qmd.index({
					id: `doc${i}`,
					content: `document ${i} about testing software`,
				});
			}

			const results = await qmd.search("testing", { limit: 5 });
			expect(results.length).toBeLessThanOrEqual(5);
		});

		test("respects namespace filter in hybrid mode", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			await qmd.index({ id: "doc1", content: "hello world", namespace: "ns1" });
			await qmd.index({ id: "doc2", content: "hello world", namespace: "ns2" });

			const results = await qmd.search("hello", { namespace: "ns1" });
			expect(results).toHaveLength(1);
			expect(results[0].docId).toBe("doc1");
		});

		test("passes RRF options through", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			await qmd.index({ id: "doc1", content: "hello world" });

			const results = await qmd.search("hello", {
				ftsWeight: 2.0,
				vectorWeight: 0.5,
				rrfK: 30,
			});
			expect(results).toHaveLength(1);
		});
	});

	describe("get", () => {
		test("returns document content and metadata", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({
				id: "doc1",
				content: "Hello!",
				title: "Greeting",
				docType: "fact",
			});

			const doc = qmd.get("doc1");
			expect(doc).not.toBeNull();
			expect(doc?.content).toContain("Hello!");
			expect(doc?.title).toBe("Greeting");
			expect(doc?.docType).toBe("fact");
		});

		test("returns null for nonexistent document", () => {
			const qmd = new Qmd(sql);
			expect(qmd.get("nonexistent")).toBeNull();
		});

		test("reconstructs content from multiple chunks", async () => {
			const qmd = new Qmd(sql, { config: { chunkSize: 50, chunkOverlap: 5 } });
			const content = "word ".repeat(40); // 200 chars -> multiple chunks
			await qmd.index({ id: "doc1", content });

			const doc = qmd.get("doc1");
			expect(doc).not.toBeNull();
			// Content should contain key parts (may not be exact due to chunking)
			expect(doc?.content).toContain("word");
		});
	});

	describe("has", () => {
		test("returns true for indexed document", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "Hello!" });
			expect(qmd.has("doc1")).toBe(true);
		});

		test("returns false for nonexistent document", () => {
			const qmd = new Qmd(sql);
			expect(qmd.has("nonexistent")).toBe(false);
		});
	});

	describe("list", () => {
		test("lists all document IDs", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "Hello" });
			await qmd.index({ id: "doc2", content: "World" });

			const ids = qmd.list();
			expect(ids).toEqual(["doc1", "doc2"]);
		});

		test("returns empty array when no documents", () => {
			const qmd = new Qmd(sql);
			expect(qmd.list()).toEqual([]);
		});

		test("filters by namespace", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "Hello", namespace: "ns1" });
			await qmd.index({ id: "doc2", content: "World", namespace: "ns2" });

			expect(qmd.list({ namespace: "ns1" })).toEqual(["doc1"]);
		});

		test("filters by docType", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "Hello", docType: "fact" });
			await qmd.index({ id: "doc2", content: "World", docType: "note" });

			expect(qmd.list({ docType: "fact" })).toEqual(["doc1"]);
		});

		test("filters by both namespace and docType", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({
				id: "doc1",
				content: "A",
				docType: "fact",
				namespace: "ns1",
			});
			await qmd.index({
				id: "doc2",
				content: "B",
				docType: "note",
				namespace: "ns1",
			});
			await qmd.index({
				id: "doc3",
				content: "C",
				docType: "fact",
				namespace: "ns2",
			});

			expect(qmd.list({ namespace: "ns1", docType: "fact" })).toEqual(["doc1"]);
		});

		test("returns IDs sorted alphabetically", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "charlie", content: "C" });
			await qmd.index({ id: "alpha", content: "A" });
			await qmd.index({ id: "bravo", content: "B" });

			expect(qmd.list()).toEqual(["alpha", "bravo", "charlie"]);
		});
	});

	describe("listByNamespace", () => {
		test("lists documents by exact namespace", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({
				id: "doc1",
				content: "Hello",
				namespace: "people/ryan",
			});
			await qmd.index({
				id: "doc2",
				content: "World",
				namespace: "people/jane",
			});

			const results = qmd.listByNamespace("people/ryan");
			expect(results).toHaveLength(1);
			expect(results[0].docId).toBe("doc1");
			expect(results[0].content).toContain("Hello");
		});

		test("lists documents by glob pattern", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({
				id: "doc1",
				content: "Hello",
				namespace: "people/ryan",
			});
			await qmd.index({
				id: "doc2",
				content: "World",
				namespace: "people/jane",
			});
			await qmd.index({
				id: "doc3",
				content: "Foo",
				namespace: "projects/ember",
			});

			const results = qmd.listByNamespace("people/*");
			expect(results).toHaveLength(2);
			const docIds = results.map((r) => r.docId).sort();
			expect(docIds).toEqual(["doc1", "doc2"]);
		});

		test("returns empty array for no matches", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({
				id: "doc1",
				content: "Hello",
				namespace: "people/ryan",
			});

			const results = qmd.listByNamespace("projects/*");
			expect(results).toEqual([]);
		});

		test("respects limit parameter", async () => {
			const qmd = new Qmd(sql);
			for (let i = 0; i < 10; i++) {
				await qmd.index({
					id: `doc${i}`,
					content: `Content ${i}`,
					namespace: `people/p${i}`,
				});
			}

			const results = qmd.listByNamespace("people/*", 3);
			expect(results).toHaveLength(3);
		});

		test("returns title and namespace", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({
				id: "doc1",
				content: "Soul content",
				title: "soul",
				namespace: "identity/soul",
			});

			const results = qmd.listByNamespace("identity/*");
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("soul");
			expect(results[0].namespace).toBe("identity/soul");
		});
	});

	describe("stats", () => {
		test("returns zero counts when empty", () => {
			const qmd = new Qmd(sql);
			const s = qmd.stats();

			expect(s.totalDocuments).toBe(0);
			expect(s.totalChunks).toBe(0);
			expect(s.totalVectors).toBe(0);
			expect(s.namespaces).toEqual([]);
			expect(s.docTypes).toEqual([]);
		});

		test("returns correct counts after indexing", async () => {
			const qmd = new Qmd(sql, { config: { chunkSize: 50, chunkOverlap: 5 } });
			await qmd.index({
				id: "doc1",
				content: "word ".repeat(40), // multi-chunk
				docType: "fact",
				namespace: "ns1",
			});
			await qmd.index({
				id: "doc2",
				content: "short",
				docType: "note",
				namespace: "ns2",
			});

			const s = qmd.stats();
			expect(s.totalDocuments).toBe(2);
			expect(s.totalChunks).toBeGreaterThan(2); // doc1 has multiple chunks
			expect(s.namespaces.sort()).toEqual(["ns1", "ns2"]);
			expect(s.docTypes.sort()).toEqual(["fact", "note"]);
		});
	});

	describe("rebuild", () => {
		test("rebuilds FTS index without error", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "Hello, world!" });

			// Should not throw
			qmd.rebuild();

			// FTS should still work after rebuild
			const results = qmd.searchFts("hello");
			expect(results).toHaveLength(1);
		});
	});

	describe("auto-initialization", () => {
		test("schema is lazily initialized on first operation", async () => {
			const qmd = new Qmd(sql);

			// No tables should exist yet
			const tablesBeforeOp = sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'qmd_%'",
				)
				.toArray();
			expect(tablesBeforeOp).toHaveLength(0);

			// First operation triggers schema init
			await qmd.index({ id: "doc1", content: "Hello" });

			const tablesAfterOp = sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'qmd_%'",
				)
				.toArray();
			expect(tablesAfterOp.length).toBeGreaterThan(0);
		});
	});

	describe("content hash (skip-on-unchanged)", () => {
		test("skips re-indexing when content is unchanged", async () => {
			const qmd = new Qmd(sql);
			const result1 = await qmd.index({ id: "doc1", content: "Hello, world!" });
			expect(result1.skipped).toBe(false);

			const result2 = await qmd.index({ id: "doc1", content: "Hello, world!" });
			expect(result2.skipped).toBe(true);
			expect(result2.chunks).toBe(1);
		});

		test("re-indexes when content changes", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "version 1" });
			const result = await qmd.index({ id: "doc1", content: "version 2" });
			expect(result.skipped).toBe(false);
		});

		test("updates metadata even when content is unchanged", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "Hello", title: "v1" });
			const result = await qmd.index({
				id: "doc1",
				content: "Hello",
				title: "v2",
			});
			expect(result.skipped).toBe(true);

			const doc = qmd.get("doc1");
			expect(doc?.title).toBe("v2");
		});

		test("skips vector re-indexing when content unchanged", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			await qmd.index({ id: "doc1", content: "Hello, world!" });
			expect(vectorize.storedVectors.size).toBe(1);

			// Clear to detect if vectors are re-indexed
			vectorize.clear();
			const result = await qmd.index({ id: "doc1", content: "Hello, world!" });
			expect(result.skipped).toBe(true);
			expect(vectorize.storedVectors.size).toBe(0); // Not re-indexed
		});

		test("indexBatch skips unchanged documents", async () => {
			const qmd = new Qmd(sql);
			await qmd.indexBatch([
				{ id: "doc1", content: "Hello" },
				{ id: "doc2", content: "World" },
			]);

			const result = await qmd.indexBatch([
				{ id: "doc1", content: "Hello" }, // unchanged
				{ id: "doc2", content: "World updated" }, // changed
				{ id: "doc3", content: "New" }, // new
			]);

			expect(result.documents).toBe(3);
			expect(result.skipped).toBe(1); // only doc1 skipped
		});
	});

	describe("contexts", () => {
		test("setContext and listContexts", () => {
			const qmd = new Qmd(sql);
			qmd.setContext("life/", "Personal life areas");
			qmd.setContext("work/", "Work-related documents");

			const contexts = qmd.listContexts();
			expect(contexts).toHaveLength(2);
			expect(contexts[0].prefix).toBe("life/");
			expect(contexts[1].prefix).toBe("work/");
		});

		test("setContext upserts on duplicate prefix", () => {
			const qmd = new Qmd(sql);
			qmd.setContext("life/", "Original");
			qmd.setContext("life/", "Updated");

			const contexts = qmd.listContexts();
			expect(contexts).toHaveLength(1);
			expect(contexts[0].description).toBe("Updated");
		});

		test("removeContext", () => {
			const qmd = new Qmd(sql);
			qmd.setContext("life/", "Personal life areas");
			qmd.removeContext("life/");
			expect(qmd.listContexts()).toHaveLength(0);
		});

		test("listContexts filters by namespace", () => {
			const qmd = new Qmd(sql);
			qmd.setContext("life/", "Default ns", "");
			qmd.setContext("life/", "NS1 life", "ns1");

			expect(qmd.listContexts("")).toHaveLength(1);
			expect(qmd.listContexts("ns1")).toHaveLength(1);
			expect(qmd.listContexts("ns1")[0].description).toBe("NS1 life");
		});

		test("getContextsForDoc returns hierarchical matches", () => {
			const qmd = new Qmd(sql);
			qmd.setContext("life/", "Personal life areas");
			qmd.setContext("life/areas/", "Specific areas of life");
			qmd.setContext("life/areas/health/", "Health and wellness");
			qmd.setContext("work/", "Work stuff");

			const contexts = qmd.getContextsForDoc("life/areas/health/exercise.md");
			expect(contexts).toHaveLength(3);
			expect(contexts[0].prefix).toBe("life/");
			expect(contexts[1].prefix).toBe("life/areas/");
			expect(contexts[2].prefix).toBe("life/areas/health/");
		});

		test("getContextsForDoc works with single-segment docId (no slashes)", () => {
			const qmd = new Qmd(sql);
			qmd.setContext("", "Root context");
			qmd.setContext("life/", "Life context");

			const contexts = qmd.getContextsForDoc("soul.md");
			expect(contexts).toHaveLength(1);
			expect(contexts[0].prefix).toBe("");
			expect(contexts[0].description).toBe("Root context");
		});

		test("getContextsForDoc returns empty for no matching contexts", () => {
			const qmd = new Qmd(sql);
			qmd.setContext("work/", "Work stuff");

			const contexts = qmd.getContextsForDoc("life/soul.md");
			expect(contexts).toHaveLength(0);
		});

		test("contexts are included in vector embeddings", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			qmd.setContext("health/", "Documents about physical health and wellness");
			await qmd.index({ id: "health/exercise.md", content: "Running is good" });

			expect(vectorize.storedVectors.size).toBe(1);
		});
	});

	describe("search - strong signal probe", () => {
		test("skips vector search when BM25 has strong signal", async () => {
			const vectorize = new MockVectorize();
			let vectorQueryCount = 0;
			const origQuery = vectorize.query.bind(vectorize);
			vectorize.query = async (...args: Parameters<typeof vectorize.query>) => {
				vectorQueryCount++;
				return origQuery(...args);
			};

			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			// Add many filler documents so IDF makes the unique term score high
			for (let i = 0; i < 50; i++) {
				await qmd.index({
					id: `filler${i}`,
					content: `general document about topic ${i}`,
				});
			}
			// Add one document with a very distinctive term
			await qmd.index({
				id: "unique",
				content: "xyzzy xyzzy xyzzy xyzzy xyzzy xyzzy xyzzy",
			});

			vectorQueryCount = 0;
			const results = await qmd.search("xyzzy");
			expect(results).toHaveLength(1);
			expect(results[0].docId).toBe("unique");
			expect(results[0].sources).toEqual(["fts"]);
			expect(vectorQueryCount).toBe(0);
		});

		test("falls through to vector search when BM25 signal is weak", async () => {
			const vectorize = new MockVectorize();
			let vectorQueryCount = 0;
			const origQuery = vectorize.query.bind(vectorize);
			vectorize.query = async (...args: Parameters<typeof vectorize.query>) => {
				vectorQueryCount++;
				return origQuery(...args);
			};

			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			// Index many similar documents — BM25 scores will be close
			for (let i = 0; i < 10; i++) {
				await qmd.index({
					id: `doc${i}`,
					content: `testing software quality ${i}`,
				});
			}

			vectorQueryCount = 0;
			await qmd.search("testing software");
			expect(vectorQueryCount).toBe(1);
		});

		test("uses custom strong signal thresholds from config", async () => {
			const vectorize = new MockVectorize();
			let vectorQueryCount = 0;
			const origQuery = vectorize.query.bind(vectorize);
			vectorize.query = async (...args: Parameters<typeof vectorize.query>) => {
				vectorQueryCount++;
				return origQuery(...args);
			};

			const embedFn = createMockEmbedFn();
			// Set very high thresholds so strong signal is never triggered
			const qmd = new Qmd(sql, {
				vectorize,
				embedFn,
				config: { strongSignalMinScore: 0.99, strongSignalMinGap: 0.99 },
			});

			for (let i = 0; i < 50; i++) {
				await qmd.index({
					id: `filler${i}`,
					content: `general document about topic ${i}`,
				});
			}
			await qmd.index({
				id: "unique",
				content: "xyzzy xyzzy xyzzy xyzzy xyzzy xyzzy xyzzy",
			});

			vectorQueryCount = 0;
			await qmd.search("xyzzy");
			// Should NOT skip vector search because thresholds are very high
			expect(vectorQueryCount).toBe(1);
		});
	});

	describe("empty query handling", () => {
		test("searchFts returns empty for empty query", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "Hello, world!" });
			expect(qmd.searchFts("")).toEqual([]);
			expect(qmd.searchFts("   ")).toEqual([]);
		});

		test("search returns empty for empty query", async () => {
			const qmd = new Qmd(sql);
			await qmd.index({ id: "doc1", content: "Hello, world!" });
			expect(await qmd.search("")).toEqual([]);
			expect(await qmd.search("   ")).toEqual([]);
		});

		test("searchVector returns empty for empty query", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });
			await qmd.index({ id: "doc1", content: "Hello, world!" });
			expect(await qmd.searchVector("")).toEqual([]);
		});
	});

	describe("content reconstruction fidelity", () => {
		test("get() accurately reconstructs content from overlapping chunks", async () => {
			const qmd = new Qmd(sql, {
				config: { chunkSize: 100, chunkOverlap: 20 },
			});
			const original = "The quick brown fox jumps over the lazy dog. ".repeat(
				10,
			);
			await qmd.index({ id: "doc1", content: original });

			const doc = qmd.get("doc1");
			expect(doc).not.toBeNull();
			// Content should be exactly or very close to the original
			expect(doc?.content).toBe(original);
		});

		test("get() returns exact content for single-chunk documents", async () => {
			const qmd = new Qmd(sql);
			const original = "Short content.";
			await qmd.index({ id: "doc1", content: original });

			const doc = qmd.get("doc1");
			expect(doc?.content).toBe(original);
		});
	});

	describe("vector count tracking", () => {
		test("stats() tracks vector count after indexing", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			await qmd.index({ id: "doc1", content: "Hello, world!" });
			const stats = qmd.stats();
			expect(stats.totalVectors).toBe(1);
		});

		test("stats() decrements vector count after removal", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, { vectorize, embedFn });

			await qmd.index({ id: "doc1", content: "Hello, world!" });
			await qmd.index({ id: "doc2", content: "Goodbye, world!" });
			expect(qmd.stats().totalVectors).toBe(2);

			await qmd.remove("doc1");
			expect(qmd.stats().totalVectors).toBe(1);
		});

		test("stats() returns 0 vectors in FTS-only mode", () => {
			const qmd = new Qmd(sql);
			expect(qmd.stats().totalVectors).toBe(0);
		});

		test("stats() adjusts vector count on content change", async () => {
			const vectorize = new MockVectorize();
			const embedFn = createMockEmbedFn();
			const qmd = new Qmd(sql, {
				vectorize,
				embedFn,
				config: { chunkSize: 50, chunkOverlap: 5 },
			});

			await qmd.index({ id: "doc1", content: "short" });
			expect(qmd.stats().totalVectors).toBe(1);

			// Re-index with longer content that produces more chunks
			await qmd.index({ id: "doc1", content: "word ".repeat(40) });
			const stats = qmd.stats();
			expect(stats.totalVectors).toBeGreaterThan(1);
			expect(stats.totalVectors).toBe(stats.totalChunks);
		});
	});

	describe("maxChunksPerDocument", () => {
		test("throws when chunk count exceeds limit", async () => {
			const qmd = new Qmd(sql, {
				config: { chunkSize: 50, chunkOverlap: 5, maxChunksPerDocument: 2 },
			});

			await expect(
				qmd.index({ id: "doc1", content: "word ".repeat(100) }),
			).rejects.toThrow("exceeding maxChunksPerDocument");
		});

		test("allows documents within chunk limit", async () => {
			const qmd = new Qmd(sql, {
				config: { chunkSize: 50, chunkOverlap: 5, maxChunksPerDocument: 100 },
			});

			const result = await qmd.index({
				id: "doc1",
				content: "word ".repeat(40),
			});
			expect(result.chunks).toBeGreaterThan(1);
			expect(result.chunks).toBeLessThanOrEqual(100);
		});

		test("no limit when maxChunksPerDocument is 0 (default)", async () => {
			const qmd = new Qmd(sql, {
				config: { chunkSize: 50, chunkOverlap: 5 },
			});

			// Should not throw even with many chunks
			const result = await qmd.index({
				id: "doc1",
				content: "word ".repeat(100),
			});
			expect(result.chunks).toBeGreaterThan(2);
		});
	});

	describe("corrupted metadata handling", () => {
		test("searchFts returns null metadata for corrupted JSON", async () => {
			const qmd = new Qmd(sql);
			// Insert a document with valid metadata first to initialize schema
			await qmd.index({
				id: "doc1",
				content: "hello world",
				metadata: { key: "value" },
			});

			// Corrupt the metadata directly in the database
			sql.exec(
				"UPDATE qmd_documents SET metadata = '{invalid json' WHERE id = 'doc1'",
			);

			const results = qmd.searchFts("hello");
			expect(results).toHaveLength(1);
			expect(results[0].metadata).toBeNull();
		});
	});
});
