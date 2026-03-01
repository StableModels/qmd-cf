import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initSchema } from "../src/schema.js";
import {
	formatDocForEmbedding,
	formatQueryForEmbedding,
	indexVectors,
	removeVectors,
	searchVector,
} from "../src/vector.js";
import { MockSqlStorage, MockVectorize, createMockEmbedFn } from "./helpers.js";

describe("formatDocForEmbedding", () => {
	test("formats with title", () => {
		expect(formatDocForEmbedding("hello world", "My Doc")).toBe(
			"title: My Doc | text: hello world",
		);
	});

	test("formats without title", () => {
		expect(formatDocForEmbedding("hello world")).toBe(
			"title: none | text: hello world",
		);
	});

	test("formats with empty title", () => {
		expect(formatDocForEmbedding("hello world", "")).toBe(
			"title: none | text: hello world",
		);
	});

	test("formats with context", () => {
		expect(
			formatDocForEmbedding("hello world", "My Doc", "Health documents"),
		).toBe("context: Health documents | title: My Doc | text: hello world");
	});

	test("formats without context (backward compatible)", () => {
		expect(formatDocForEmbedding("hello world", "My Doc")).toBe(
			"title: My Doc | text: hello world",
		);
	});
});

describe("formatQueryForEmbedding", () => {
	test("formats query string", () => {
		expect(formatQueryForEmbedding("find stuff")).toBe(
			"search_query: find stuff",
		);
	});
});

describe("indexVectors", () => {
	let vectorize: MockVectorize;
	const embedFn = createMockEmbedFn();

	beforeEach(() => {
		vectorize = new MockVectorize();
	});

	test("does nothing for empty chunks", async () => {
		await indexVectors(vectorize, embedFn, []);
		expect(vectorize.storedVectors.size).toBe(0);
	});

	test("indexes chunks with correct IDs", async () => {
		await indexVectors(vectorize, embedFn, [
			{ docId: "doc1", seq: 0, text: "hello world" },
			{ docId: "doc1", seq: 1, text: "goodbye world" },
		]);

		expect(vectorize.storedVectors.has("doc1_0")).toBe(true);
		expect(vectorize.storedVectors.has("doc1_1")).toBe(true);
	});

	test("stores first path segment as Vectorize namespace", async () => {
		await indexVectors(vectorize, embedFn, [
			{ docId: "doc1", seq: 0, text: "hello", namespace: "people/ryan" },
		]);

		const stored = vectorize.storedVectors.get("doc1_0");
		expect(stored?.namespace).toBe("people");
	});

	test("stores full directory in metadata", async () => {
		await indexVectors(vectorize, embedFn, [
			{ docId: "doc1", seq: 0, text: "hello", namespace: "people/ryan" },
		]);

		const stored = vectorize.storedVectors.get("doc1_0");
		expect(stored?.metadata?.directory).toBe("people/ryan");
	});

	test("stores metadata with docId, seq, docType, directory", async () => {
		await indexVectors(vectorize, embedFn, [
			{
				docId: "doc1",
				seq: 0,
				text: "hello",
				docType: "fact",
				namespace: "people/ryan",
			},
		]);

		const stored = vectorize.storedVectors.get("doc1_0");
		expect(stored?.metadata).toEqual({
			docId: "doc1",
			seq: 0,
			docType: "fact",
			directory: "people/ryan",
		});
	});

	test("defaults missing docType and namespace to empty string", async () => {
		await indexVectors(vectorize, embedFn, [
			{ docId: "doc1", seq: 0, text: "hello" },
		]);

		const stored = vectorize.storedVectors.get("doc1_0");
		expect(stored?.metadata?.docType).toBe("");
		expect(stored?.metadata?.directory).toBe("");
	});

	test("batches large sets of chunks", async () => {
		const chunks = Array.from({ length: 150 }, (_, i) => ({
			docId: "doc1",
			seq: i,
			text: `chunk ${i}`,
		}));

		await indexVectors(vectorize, embedFn, chunks);
		expect(vectorize.storedVectors.size).toBe(150);
	});

	test("generates embeddings with correct dimensions", async () => {
		const dims = 8;
		const embed = createMockEmbedFn(dims);

		await indexVectors(vectorize, embed, [
			{ docId: "doc1", seq: 0, text: "hello" },
		]);

		const stored = vectorize.storedVectors.get("doc1_0");
		expect(stored?.values).toHaveLength(dims);
	});
});

describe("removeVectors", () => {
	let sql: MockSqlStorage;
	let vectorize: MockVectorize;
	const embedFn = createMockEmbedFn();

	beforeEach(() => {
		sql = new MockSqlStorage();
		vectorize = new MockVectorize();
		initSchema(sql);
	});

	afterEach(() => {
		sql.close();
	});

	test("removes vectors for a document", async () => {
		// Set up document in SQL
		sql.exec("INSERT INTO qmd_documents (id, title) VALUES ('doc1', 'Title')");
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES ('doc1', 0, 'hello', 0)",
		);
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES ('doc1', 1, 'world', 100)",
		);

		// Index vectors
		await indexVectors(vectorize, embedFn, [
			{ docId: "doc1", seq: 0, text: "hello" },
			{ docId: "doc1", seq: 1, text: "world" },
		]);

		expect(vectorize.storedVectors.size).toBe(2);

		// Remove
		await removeVectors(vectorize, sql, "doc1");
		expect(vectorize.storedVectors.size).toBe(0);
	});

	test("handles document with no chunks gracefully", async () => {
		// No chunks in SQL for this doc
		await removeVectors(vectorize, sql, "nonexistent");
		// Should not throw
		expect(vectorize.storedVectors.size).toBe(0);
	});

	test("only removes vectors for the specified document", async () => {
		sql.exec("INSERT INTO qmd_documents (id, title) VALUES ('doc1', 'T1')");
		sql.exec("INSERT INTO qmd_documents (id, title) VALUES ('doc2', 'T2')");
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES ('doc1', 0, 'a', 0)",
		);
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES ('doc2', 0, 'b', 0)",
		);

		await indexVectors(vectorize, embedFn, [
			{ docId: "doc1", seq: 0, text: "a" },
			{ docId: "doc2", seq: 0, text: "b" },
		]);

		await removeVectors(vectorize, sql, "doc1");

		expect(vectorize.storedVectors.has("doc1_0")).toBe(false);
		expect(vectorize.storedVectors.has("doc2_0")).toBe(true);
	});
});

describe("searchVector", () => {
	let sql: MockSqlStorage;
	let vectorize: MockVectorize;
	const embedFn = createMockEmbedFn();

	beforeEach(() => {
		sql = new MockSqlStorage();
		vectorize = new MockVectorize();
		initSchema(sql);
	});

	afterEach(() => {
		sql.close();
	});

	async function setupDoc(
		id: string,
		content: string,
		opts?: { title?: string; docType?: string; namespace?: string },
	) {
		sql.exec(
			"INSERT INTO qmd_documents (id, title, doc_type, namespace) VALUES (?, ?, ?, ?)",
			id,
			opts?.title ?? null,
			opts?.docType ?? null,
			opts?.namespace ?? null,
		);
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES (?, 0, ?, 0)",
			id,
			content,
		);
		await indexVectors(vectorize, embedFn, [
			{
				docId: id,
				seq: 0,
				text: content,
				title: opts?.title,
				namespace: opts?.namespace,
				docType: opts?.docType,
			},
		]);
	}

	test("returns empty array when no vectors match", async () => {
		const results = await searchVector(vectorize, embedFn, sql, "hello");
		expect(results).toEqual([]);
	});

	test("finds similar documents", async () => {
		await setupDoc("doc1", "The quick brown fox jumps over the lazy dog");
		await setupDoc("doc2", "A fast brown fox leaps across a sleepy hound");

		const results = await searchVector(
			vectorize,
			embedFn,
			sql,
			"brown fox jumping",
		);
		expect(results.length).toBeGreaterThan(0);
	});

	test("returns scores in [0, 1]", async () => {
		await setupDoc("doc1", "hello world");

		const results = await searchVector(vectorize, embedFn, sql, "hello");
		expect(results).toHaveLength(1);
		expect(results[0].score).toBeGreaterThanOrEqual(0);
		expect(results[0].score).toBeLessThanOrEqual(1);
	});

	test("respects limit option", async () => {
		for (let i = 0; i < 10; i++) {
			await setupDoc(`doc${i}`, `Document ${i} about testing`);
		}

		const results = await searchVector(vectorize, embedFn, sql, "testing", {
			limit: 3,
		});
		expect(results.length).toBeLessThanOrEqual(3);
	});

	test("filters by namespace", async () => {
		await setupDoc("doc1", "hello world", { namespace: "ns1" });
		await setupDoc("doc2", "hello world", { namespace: "ns2" });

		const results = await searchVector(vectorize, embedFn, sql, "hello", {
			namespace: "ns1",
		});
		expect(results).toHaveLength(1);
		expect(results[0].docId).toBe("doc1");
	});

	test("filters by directory namespace with glob pattern", async () => {
		await setupDoc("doc1", "hello world people ryan", {
			namespace: "people/ryan",
		});
		await setupDoc("doc2", "hello world people jane", {
			namespace: "people/jane",
		});
		await setupDoc("doc3", "hello world projects ember", {
			namespace: "projects/ember",
		});

		// people/* should match both people docs
		const results = await searchVector(vectorize, embedFn, sql, "hello", {
			namespace: "people/*",
		});
		const docIds = results.map((r) => r.docId).sort();
		expect(docIds).toContain("doc1");
		expect(docIds).toContain("doc2");
		expect(docIds).not.toContain("doc3");
	});

	test("filters by exact directory namespace", async () => {
		await setupDoc("doc1", "hello world people ryan", {
			namespace: "people/ryan",
		});
		await setupDoc("doc2", "hello world people jane", {
			namespace: "people/jane",
		});

		const results = await searchVector(vectorize, embedFn, sql, "hello", {
			namespace: "people/ryan",
		});
		expect(results).toHaveLength(1);
		expect(results[0].docId).toBe("doc1");
	});

	test("filters by docType", async () => {
		await setupDoc("doc1", "hello world", { docType: "fact" });
		await setupDoc("doc2", "hello world", { docType: "note" });

		const results = await searchVector(vectorize, embedFn, sql, "hello", {
			docType: "fact",
		});
		expect(results).toHaveLength(1);
		expect(results[0].docId).toBe("doc1");
	});

	test("deduplicates multiple chunks from same document", async () => {
		sql.exec("INSERT INTO qmd_documents (id, title) VALUES ('doc1', 'Title')");
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES ('doc1', 0, 'chunk one hello', 0)",
		);
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES ('doc1', 1, 'chunk two hello', 100)",
		);

		await indexVectors(vectorize, embedFn, [
			{ docId: "doc1", seq: 0, text: "chunk one hello" },
			{ docId: "doc1", seq: 1, text: "chunk two hello" },
		]);

		const results = await searchVector(vectorize, embedFn, sql, "hello");
		// Should be deduplicated to one result
		expect(results).toHaveLength(1);
		expect(results[0].docId).toBe("doc1");
	});

	test("returns snippet from best matching chunk", async () => {
		await setupDoc("doc1", "hello world content here", { title: "My Title" });

		const results = await searchVector(vectorize, embedFn, sql, "hello");
		expect(results[0].snippet).toBe("hello world content here");
		expect(results[0].title).toBe("My Title");
	});
});
