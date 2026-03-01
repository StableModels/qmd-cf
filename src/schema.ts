const CURRENT_VERSION = 2;

/**
 * Initialize the FTS5 schema on a Durable Object's SQL storage.
 *
 * Tables created:
 * - `qmd_documents`  — document metadata (id, title, docType, namespace, metadata JSON, content_hash)
 * - `qmd_chunks`     — chunked content with parent doc reference
 * - `qmd_chunks_fts` — FTS5 virtual table for full-text search over chunks
 * - `qmd_contexts`   — semantic context descriptions for path prefixes
 * - `qmd_meta`       — schema version tracking
 *
 * The FTS5 table is kept in sync via triggers on `qmd_chunks`.
 */
export function initSchema(sql: SqlStorage, tokenizer = "unicode61"): void {
	// Create version tracking table first so we can check if already initialized
	sql.exec(`
		CREATE TABLE IF NOT EXISTS qmd_meta (
			key   TEXT PRIMARY KEY,
			version INTEGER NOT NULL
		)
	`);

	const existing = sql
		.exec<{ version: number }>("SELECT version FROM qmd_meta LIMIT 1")
		.toArray();
	const currentVersion = existing.length > 0 ? existing[0].version : 0;

	if (currentVersion >= CURRENT_VERSION) {
		return; // Already at current version
	}

	// Version 0 -> 1: initial schema
	if (currentVersion < 1) {
		// Document metadata table
		sql.exec(`
			CREATE TABLE IF NOT EXISTS qmd_documents (
				id        TEXT PRIMARY KEY,
				title     TEXT,
				doc_type  TEXT,
				namespace TEXT,
				metadata  TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				updated_at TEXT DEFAULT (datetime('now'))
			)
		`);

		// Chunk content table
		sql.exec(`
			CREATE TABLE IF NOT EXISTS qmd_chunks (
				doc_id      TEXT NOT NULL,
				seq         INTEGER NOT NULL,
				content     TEXT NOT NULL,
				char_offset INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (doc_id, seq),
				FOREIGN KEY (doc_id) REFERENCES qmd_documents(id) ON DELETE CASCADE
			)
		`);

		// FTS5 virtual table — indexes chunk content with document title for boosted relevance
		sql.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS qmd_chunks_fts USING fts5(
				doc_id UNINDEXED,
				seq UNINDEXED,
				title,
				content,
				tokenize='${tokenizer}'
			)
		`);

		// Triggers to keep FTS in sync with chunks table
		sql.exec(`
			CREATE TRIGGER IF NOT EXISTS qmd_chunks_ai AFTER INSERT ON qmd_chunks
			BEGIN
				INSERT INTO qmd_chunks_fts(doc_id, seq, title, content)
				SELECT NEW.doc_id, NEW.seq, d.title, NEW.content
				FROM qmd_documents d WHERE d.id = NEW.doc_id;
			END
		`);

		sql.exec(`
			CREATE TRIGGER IF NOT EXISTS qmd_chunks_ad AFTER DELETE ON qmd_chunks
			BEGIN
				DELETE FROM qmd_chunks_fts
				WHERE doc_id = OLD.doc_id AND seq = OLD.seq;
			END
		`);

		sql.exec(`
			CREATE TRIGGER IF NOT EXISTS qmd_chunks_au AFTER UPDATE ON qmd_chunks
			BEGIN
				DELETE FROM qmd_chunks_fts
				WHERE doc_id = OLD.doc_id AND seq = OLD.seq;
				INSERT INTO qmd_chunks_fts(doc_id, seq, title, content)
				SELECT NEW.doc_id, NEW.seq, d.title, NEW.content
				FROM qmd_documents d WHERE d.id = NEW.doc_id;
			END
		`);

		// Index for namespace-scoped lookups
		sql.exec(`
			CREATE INDEX IF NOT EXISTS idx_qmd_documents_namespace
			ON qmd_documents(namespace)
		`);

		// Index for doc_type filtering
		sql.exec(`
			CREATE INDEX IF NOT EXISTS idx_qmd_documents_doc_type
			ON qmd_documents(doc_type)
		`);
	}

	// Version 1 -> 2: add content_hash column + contexts table
	if (currentVersion < 2) {
		// Add content_hash column for skip-on-unchanged indexing.
		// For fresh installs (currentVersion === 0), the column doesn't exist yet on the just-created table.
		// For upgrades from v1, ALTER TABLE adds the column to the existing table.
		// Both paths use ALTER TABLE which is idempotent-safe with IF NOT EXISTS workaround.
		const cols = sql
			.exec<{ name: string }>("PRAGMA table_info(qmd_documents)")
			.toArray()
			.map((c) => c.name);
		if (!cols.includes("content_hash")) {
			sql.exec("ALTER TABLE qmd_documents ADD COLUMN content_hash TEXT");
		}

		// Semantic context descriptions for path prefixes
		sql.exec(`
			CREATE TABLE IF NOT EXISTS qmd_contexts (
				prefix      TEXT NOT NULL,
				namespace   TEXT NOT NULL DEFAULT '',
				description TEXT NOT NULL,
				PRIMARY KEY (prefix, namespace)
			)
		`);

		sql.exec(
			"CREATE INDEX IF NOT EXISTS idx_qmd_contexts_namespace ON qmd_contexts(namespace)",
		);
	}

	// Record schema version
	sql.exec(
		"INSERT OR REPLACE INTO qmd_meta (key, version) VALUES ('schema', ?)",
		CURRENT_VERSION,
	);
}
