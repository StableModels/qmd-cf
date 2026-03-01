import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type { QmdObject } from "./qmd-object.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		QMD: DurableObjectNamespace<QmdObject>;
	}
}

function getStub(name: string): DurableObjectStub<QmdObject> {
	const id = env.QMD.idFromName(name);
	return env.QMD.get(id);
}

describe("Qmd in workerd", () => {
	describe("document lifecycle", () => {
		test("indexes and retrieves a document", async () => {
			const qmd = getStub("lifecycle-index");
			const result = await qmd.index({
				id: "doc1",
				content: "Hello world from Cloudflare Workers",
				title: "Greeting",
			});
			expect(result.chunks).toBeGreaterThanOrEqual(1);
			expect(result.skipped).toBe(false);

			const doc = await qmd.get("doc1");
			expect(doc).not.toBeNull();
			expect(doc!.content).toBe("Hello world from Cloudflare Workers");
			expect(doc!.title).toBe("Greeting");
		});

		test("checks document existence", async () => {
			const qmd = getStub("lifecycle-has");
			await qmd.index({ id: "doc1", content: "Some content" });

			expect(await qmd.has("doc1")).toBe(true);
			expect(await qmd.has("nonexistent")).toBe(false);
		});

		test("lists indexed documents", async () => {
			const qmd = getStub("lifecycle-list");
			await qmd.index({ id: "alpha", content: "First document" });
			await qmd.index({ id: "beta", content: "Second document" });

			const ids = await qmd.list();
			expect(ids).toContain("alpha");
			expect(ids).toContain("beta");
		});

		test("removes documents", async () => {
			const qmd = getStub("lifecycle-remove");
			await qmd.index({ id: "doc1", content: "Content to remove" });
			expect(await qmd.has("doc1")).toBe(true);

			await qmd.remove("doc1");
			expect(await qmd.has("doc1")).toBe(false);
			expect(await qmd.get("doc1")).toBeNull();
		});

		test("updates existing documents", async () => {
			const qmd = getStub("lifecycle-update");
			await qmd.index({
				id: "doc1",
				content: "Original content",
				title: "v1",
			});
			await qmd.index({
				id: "doc1",
				content: "Updated content",
				title: "v2",
			});

			const doc = await qmd.get("doc1");
			expect(doc!.content).toBe("Updated content");
			expect(doc!.title).toBe("v2");
		});
	});

	describe("FTS search", () => {
		test("finds documents by keyword", async () => {
			const qmd = getStub("fts-keyword");
			await qmd.index({
				id: "doc1",
				content: "TypeScript is a typed programming language",
				title: "TypeScript",
			});
			await qmd.index({
				id: "doc2",
				content: "JavaScript runs in the browser",
				title: "JavaScript",
			});

			const results = await qmd.searchFts("TypeScript");
			expect(results.length).toBeGreaterThanOrEqual(1);
			expect(results[0].docId).toBe("doc1");
		});

		test("returns results ranked by BM25 relevance", async () => {
			const qmd = getStub("fts-ranking");
			await qmd.index({
				id: "doc1",
				content: "The quick brown fox jumps over the lazy dog",
				title: "Fox",
			});
			await qmd.index({
				id: "doc2",
				content: "The fox is quick. The fox is brown. The fox jumps high.",
				title: "Fox Details",
			});

			const results = await qmd.searchFts("fox");
			expect(results.length).toBe(2);
			// Both should be found; scores should be normalized to (0, 1)
			for (const r of results) {
				expect(r.score).toBeGreaterThan(0);
				expect(r.score).toBeLessThan(1);
			}
		});

		test("filters by docType", async () => {
			const qmd = getStub("fts-doctype");
			await qmd.index({
				id: "doc1",
				content: "Important fact about testing",
				docType: "fact",
			});
			await qmd.index({
				id: "doc2",
				content: "Note about testing procedures",
				docType: "note",
			});

			const results = await qmd.searchFts("testing", {
				docType: "fact",
			});
			expect(results.length).toBe(1);
			expect(results[0].docId).toBe("doc1");
		});

		test("filters by namespace", async () => {
			const qmd = getStub("fts-namespace");
			await qmd.index({
				id: "doc1",
				content: "Document in first namespace",
				namespace: "project/alpha",
			});
			await qmd.index({
				id: "doc2",
				content: "Document in second namespace",
				namespace: "project/beta",
			});

			const results = await qmd.searchFts("document", {
				namespace: "project/alpha",
			});
			expect(results.length).toBe(1);
			expect(results[0].docId).toBe("doc1");
		});

		test("supports namespace glob patterns", async () => {
			const qmd = getStub("fts-glob");
			await qmd.index({
				id: "doc1",
				content: "First project item",
				namespace: "project/alpha",
			});
			await qmd.index({
				id: "doc2",
				content: "Second project item",
				namespace: "project/beta",
			});
			await qmd.index({
				id: "doc3",
				content: "Unrelated item",
				namespace: "other/gamma",
			});

			const results = await qmd.searchFts("item", {
				namespace: "project/*",
			});
			expect(results.length).toBe(2);
			const docIds = results.map((r) => r.docId).sort();
			expect(docIds).toEqual(["doc1", "doc2"]);
		});

		test("handles multi-term queries", async () => {
			const qmd = getStub("fts-multiterm");
			await qmd.index({
				id: "doc1",
				content: "The quick brown fox jumps over the lazy dog",
			});
			await qmd.index({
				id: "doc2",
				content: "A lazy cat sleeps all day",
			});

			const results = await qmd.searchFts("quick fox");
			expect(results.length).toBeGreaterThanOrEqual(1);
			expect(results[0].docId).toBe("doc1");
		});
	});

	describe("chunking", () => {
		test("chunks large documents and reconstructs content", async () => {
			const qmd = getStub("chunk-large");
			// Create content that exceeds default chunk size (3200 chars)
			const longContent = Array.from(
				{ length: 100 },
				(_, i) =>
					`Paragraph ${i}: ${"Lorem ipsum dolor sit amet. ".repeat(10)}`,
			).join("\n\n");

			const result = await qmd.index({
				id: "long-doc",
				content: longContent,
				title: "Long Document",
			});
			expect(result.chunks).toBeGreaterThan(1);

			const doc = await qmd.get("long-doc");
			expect(doc).not.toBeNull();
			expect(doc!.title).toBe("Long Document");
			// Content should contain the original text (reconstructed from chunks)
			expect(doc!.content).toContain("Paragraph 0:");
			expect(doc!.content).toContain("Paragraph 99:");
		});
	});

	describe("content hash", () => {
		test("skips re-indexing unchanged content", async () => {
			const qmd = getStub("hash-skip");
			const doc = {
				id: "doc1",
				content: "Content that stays the same",
				title: "Test",
			};

			const first = await qmd.index(doc);
			expect(first.skipped).toBe(false);

			const second = await qmd.index(doc);
			expect(second.skipped).toBe(true);
			expect(second.chunks).toBe(first.chunks);
		});

		test("re-indexes when content changes", async () => {
			const qmd = getStub("hash-changed");
			await qmd.index({
				id: "doc1",
				content: "Original content",
				title: "v1",
			});

			const result = await qmd.index({
				id: "doc1",
				content: "Changed content",
				title: "v2",
			});
			expect(result.skipped).toBe(false);
		});

		test("updates metadata even when content is unchanged", async () => {
			const qmd = getStub("hash-metadata");
			await qmd.index({
				id: "doc1",
				content: "Same content",
				title: "Old Title",
			});
			await qmd.index({
				id: "doc1",
				content: "Same content",
				title: "New Title",
			});

			const doc = await qmd.get("doc1");
			expect(doc!.title).toBe("New Title");
		});
	});

	describe("batch indexing", () => {
		test("indexes multiple documents", async () => {
			const qmd = getStub("batch-index");
			const result = await qmd.indexBatch([
				{ id: "doc1", content: "First document content" },
				{ id: "doc2", content: "Second document content" },
				{ id: "doc3", content: "Third document content" },
			]);

			expect(result.documents).toBe(3);
			expect(result.chunks).toBeGreaterThanOrEqual(3);
			expect(result.skipped).toBe(0);

			expect(await qmd.has("doc1")).toBe(true);
			expect(await qmd.has("doc2")).toBe(true);
			expect(await qmd.has("doc3")).toBe(true);
		});

		test("skips unchanged documents in batch", async () => {
			const qmd = getStub("batch-skip");
			await qmd.index({ id: "doc1", content: "Existing content" });

			const result = await qmd.indexBatch([
				{ id: "doc1", content: "Existing content" },
				{ id: "doc2", content: "New content" },
			]);

			expect(result.documents).toBe(2);
			expect(result.skipped).toBe(1);
		});
	});

	describe("listByNamespace", () => {
		test("lists documents by exact namespace", async () => {
			const qmd = getStub("listns-exact");
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

			const results = await qmd.listByNamespace("people/ryan");
			expect(results.length).toBe(1);
			expect(results[0].docId).toBe("doc1");
		});

		test("lists documents by glob pattern", async () => {
			const qmd = getStub("listns-glob");
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

			const results = await qmd.listByNamespace("people/*");
			expect(results.length).toBe(2);
			const docIds = results.map((r) => r.docId).sort();
			expect(docIds).toEqual(["doc1", "doc2"]);
		});

		test("respects limit", async () => {
			const qmd = getStub("listns-limit");
			for (let i = 0; i < 10; i++) {
				await qmd.index({
					id: `doc${i}`,
					content: `Content ${i}`,
					namespace: `people/p${i}`,
				});
			}

			const results = await qmd.listByNamespace("people/*", 3);
			expect(results.length).toBe(3);
		});
	});

	describe("contexts", () => {
		test("sets and lists contexts", async () => {
			const qmd = getStub("ctx-setlist");
			await qmd.setContext("life/", "Personal life documents");
			await qmd.setContext("life/health/", "Health and wellness tracking");

			const contexts = await qmd.listContexts();
			expect(contexts.length).toBe(2);
			expect(contexts[0].prefix).toBe("life/");
			expect(contexts[1].prefix).toBe("life/health/");
		});

		test("removes contexts", async () => {
			const qmd = getStub("ctx-remove");
			await qmd.setContext("temp/", "Temporary context");
			expect((await qmd.listContexts()).length).toBe(1);

			await qmd.removeContext("temp/");
			expect((await qmd.listContexts()).length).toBe(0);
		});

		test("gets hierarchical contexts for a document", async () => {
			const qmd = getStub("ctx-hierarchy");
			await qmd.setContext("", "Root context for everything");
			await qmd.setContext("life/", "Personal life area");
			await qmd.setContext("life/health/", "Health and wellness");

			const contexts = await qmd.getContextsForDoc("life/health/exercise.md");
			expect(contexts.length).toBe(3);
			expect(contexts[0].prefix).toBe("");
			expect(contexts[1].prefix).toBe("life/");
			expect(contexts[2].prefix).toBe("life/health/");
		});
	});

	describe("stats", () => {
		test("returns correct statistics", async () => {
			const qmd = getStub("stats-basic");
			await qmd.index({
				id: "doc1",
				content: "Hello",
				docType: "fact",
				namespace: "ns1",
			});
			await qmd.index({
				id: "doc2",
				content: "World",
				docType: "note",
				namespace: "ns2",
			});

			const stats = await qmd.stats();
			expect(stats.totalDocuments).toBe(2);
			expect(stats.totalChunks).toBeGreaterThanOrEqual(2);
			expect(stats.namespaces.sort()).toEqual(["ns1", "ns2"]);
			expect(stats.docTypes.sort()).toEqual(["fact", "note"]);
		});
	});

	describe("hybrid search (FTS-only mode)", () => {
		test("returns SearchResult format from search()", async () => {
			const qmd = getStub("hybrid-ftsonly");
			await qmd.index({
				id: "doc1",
				content: "Cloudflare Workers run at the edge",
				title: "Workers",
			});

			const results = await qmd.search("Cloudflare");
			expect(results.length).toBeGreaterThanOrEqual(1);
			expect(results[0].docId).toBe("doc1");
			expect(results[0].sources).toEqual(["fts"]);
			expect(results[0].sourceScores.fts).toBeGreaterThan(0);
			expect(results[0].snippet).toBeTruthy();
		});
	});

	describe("FTS rebuild", () => {
		test("rebuild does not corrupt the index", async () => {
			const qmd = getStub("rebuild-test");
			await qmd.index({
				id: "doc1",
				content: "Searchable content for rebuild test",
			});

			await qmd.rebuild();

			const results = await qmd.searchFts("searchable");
			expect(results.length).toBe(1);
			expect(results[0].docId).toBe("doc1");
		});
	});
});
