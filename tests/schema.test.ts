import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initSchema } from "../src/schema.js";
import { MockSqlStorage } from "./helpers.js";

describe("initSchema", () => {
	let sql: MockSqlStorage;

	beforeEach(() => {
		sql = new MockSqlStorage();
	});

	afterEach(() => {
		sql.close();
	});

	test("creates all required tables", () => {
		initSchema(sql);

		// Check qmd_documents
		const docs = sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='qmd_documents'",
			)
			.toArray();
		expect(docs).toHaveLength(1);

		// Check qmd_chunks
		const chunks = sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='qmd_chunks'",
			)
			.toArray();
		expect(chunks).toHaveLength(1);

		// Check qmd_meta
		const meta = sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='qmd_meta'",
			)
			.toArray();
		expect(meta).toHaveLength(1);

		// Check FTS5 virtual table
		const fts = sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='qmd_chunks_fts'",
			)
			.toArray();
		expect(fts).toHaveLength(1);
	});

	test("creates triggers for FTS sync", () => {
		initSchema(sql);

		const triggers = sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
			)
			.toArray();

		const triggerNames = triggers.map((t) => t.name);
		expect(triggerNames).toContain("qmd_chunks_ai"); // AFTER INSERT
		expect(triggerNames).toContain("qmd_chunks_ad"); // AFTER DELETE
		expect(triggerNames).toContain("qmd_chunks_au"); // AFTER UPDATE
	});

	test("creates indexes", () => {
		initSchema(sql);

		const indexes = sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_qmd%'",
			)
			.toArray();

		const names = indexes.map((i) => i.name);
		expect(names).toContain("idx_qmd_documents_namespace");
		expect(names).toContain("idx_qmd_documents_doc_type");
	});

	test("sets schema version to 2", () => {
		initSchema(sql);

		const version = sql
			.exec<{ version: number }>(
				"SELECT version FROM qmd_meta WHERE key = 'schema'",
			)
			.one();
		expect(version.version).toBe(2);
	});

	test("is idempotent — second call is a no-op", () => {
		initSchema(sql);

		// Insert a test doc to verify tables aren't wiped
		sql.exec(
			"INSERT INTO qmd_documents (id, title) VALUES ('test', 'Test Doc')",
		);

		// Call again
		initSchema(sql);

		// Data should still be there
		const docs = sql
			.exec<{ id: string }>("SELECT id FROM qmd_documents")
			.toArray();
		expect(docs).toHaveLength(1);
		expect(docs[0].id).toBe("test");
	});

	test("FTS trigger: insert into chunks auto-populates FTS", () => {
		initSchema(sql);

		sql.exec(
			"INSERT INTO qmd_documents (id, title) VALUES ('doc1', 'My Title')",
		);
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES ('doc1', 0, 'hello world', 0)",
		);

		const ftsRows = sql
			.exec<{ doc_id: string; content: string; title: string }>(
				"SELECT doc_id, content, title FROM qmd_chunks_fts",
			)
			.toArray();

		expect(ftsRows).toHaveLength(1);
		expect(ftsRows[0].doc_id).toBe("doc1");
		expect(ftsRows[0].content).toBe("hello world");
		expect(ftsRows[0].title).toBe("My Title");
	});

	test("FTS trigger: delete from chunks removes FTS entry", () => {
		initSchema(sql);

		sql.exec("INSERT INTO qmd_documents (id, title) VALUES ('doc1', 'Title')");
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES ('doc1', 0, 'hello', 0)",
		);

		// Verify FTS has it
		let ftsCount = sql
			.exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM qmd_chunks_fts")
			.one().cnt;
		expect(ftsCount).toBe(1);

		// Delete the chunk
		sql.exec("DELETE FROM qmd_chunks WHERE doc_id = 'doc1' AND seq = 0");

		ftsCount = sql
			.exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM qmd_chunks_fts")
			.one().cnt;
		expect(ftsCount).toBe(0);
	});

	test("FTS trigger: update chunk updates FTS entry", () => {
		initSchema(sql);

		sql.exec("INSERT INTO qmd_documents (id, title) VALUES ('doc1', 'Title')");
		sql.exec(
			"INSERT INTO qmd_chunks (doc_id, seq, content, char_offset) VALUES ('doc1', 0, 'old content', 0)",
		);

		// Update
		sql.exec(
			"UPDATE qmd_chunks SET content = 'new content' WHERE doc_id = 'doc1' AND seq = 0",
		);

		const ftsRows = sql
			.exec<{ content: string }>(
				"SELECT content FROM qmd_chunks_fts WHERE doc_id = 'doc1'",
			)
			.toArray();

		expect(ftsRows).toHaveLength(1);
		expect(ftsRows[0].content).toBe("new content");
	});

	test("accepts custom tokenizer", () => {
		initSchema(sql, "porter unicode61");

		// Should work without errors — just verify FTS table exists
		const fts = sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='qmd_chunks_fts'",
			)
			.toArray();
		expect(fts).toHaveLength(1);
	});

	test("creates content_hash column on fresh install", () => {
		initSchema(sql);

		sql.exec(
			"INSERT INTO qmd_documents (id, title, content_hash) VALUES ('test', 'T', 'abc123')",
		);
		const doc = sql
			.exec<{ content_hash: string }>(
				"SELECT content_hash FROM qmd_documents WHERE id = 'test'",
			)
			.one();
		expect(doc.content_hash).toBe("abc123");
	});

	test("creates contexts table on fresh install", () => {
		initSchema(sql);

		const tables = sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='qmd_contexts'",
			)
			.toArray();
		expect(tables).toHaveLength(1);
	});

	test("migrates from v1 to v2: adds content_hash column", () => {
		initSchema(sql);
		// Force version back to 1 to simulate upgrade
		sql.exec("UPDATE qmd_meta SET version = 1 WHERE key = 'schema'");
		// Re-init should migrate
		initSchema(sql);

		sql.exec(
			"INSERT INTO qmd_documents (id, title, content_hash) VALUES ('test', 'T', 'abc123')",
		);
		const doc = sql
			.exec<{ content_hash: string }>(
				"SELECT content_hash FROM qmd_documents WHERE id = 'test'",
			)
			.one();
		expect(doc.content_hash).toBe("abc123");
	});

	test("migrates from v1 to v2: creates contexts table", () => {
		initSchema(sql);
		sql.exec("UPDATE qmd_meta SET version = 1 WHERE key = 'schema'");
		initSchema(sql);

		const tables = sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='qmd_contexts'",
			)
			.toArray();
		expect(tables).toHaveLength(1);
	});

	test("contexts table supports prefix + namespace primary key", () => {
		initSchema(sql);

		sql.exec(
			"INSERT INTO qmd_contexts (prefix, namespace, description) VALUES ('life/', '', 'Life docs')",
		);
		sql.exec(
			"INSERT INTO qmd_contexts (prefix, namespace, description) VALUES ('life/', 'ns1', 'NS1 life docs')",
		);

		const rows = sql
			.exec<{ description: string }>(
				"SELECT description FROM qmd_contexts ORDER BY namespace",
			)
			.toArray();
		expect(rows).toHaveLength(2);
		expect(rows[0].description).toBe("Life docs");
		expect(rows[1].description).toBe("NS1 life docs");
	});
});
