# @stablemodels/qmd-cf — Hybrid Search for Durable Objects

A DO-native reimagination of [qmd](https://github.com/tobi/qmd). Brings hybrid BM25 full-text + vector semantic search to Cloudflare Durable Objects.

## Architecture

```
┌───────────────────────────────────────────────────┐
│              Durable Object (SQLite)               │
│                                                   │
│  qmd_documents  ─── doc metadata + content_hash   │
│  qmd_chunks     ─── chunked content               │
│  qmd_chunks_fts ─── FTS5 virtual table (BM25)     │
│  qmd_contexts   ─── semantic path descriptions    │
│                                                   │
│  Qmd class      ─── orchestrates index + search   │
│    ├── FTS search (always available, zero-dep)    │
│    ├── Vector search (optional, via Vectorize)    │
│    ├── RRF fusion (when both available)           │
│    ├── Strong signal probe (skip vector if BM25   │
│    │   has clear winner: score≥0.85, gap≥0.15)    │
│    ├── Content hashing (skip re-index if unchanged)│
│    └── Context system (path-prefix enrichment)    │
│                                                   │
└─────────────┬────────────┬────────────────────────┘
              │            │
              │  optional  │
              ▼            ▼
      ┌──────────┐  ┌─────────────┐
      │Workers AI│  │  Vectorize  │
      │(embedFn) │  │(vector idx) │
      └──────────┘  └─────────────┘
```

## Key Design Decisions

- **FTS5 is the foundation** — always available with zero external dependencies, co-located in DO SQLite
- **Vectorize is optional** — add semantic search by passing `vectorize` + `embedFn` to constructor
- **RRF fusion** — Reciprocal Rank Fusion (k=60) combines FTS + vector rankings, matching qmd's approach
- **Strong signal probe** — in hybrid mode, FTS runs first. If BM25 top score ≥ 0.85 with gap ≥ 0.15 to second, skips the Vectorize round-trip. Thresholds configurable via `strongSignalMinScore` and `strongSignalMinGap` in `QmdConfig`
- **Content hashing** — FNV-1a 32-bit hash stored in `content_hash` column. `index()` skips re-chunking and re-embedding when content is unchanged
- **Context system** — semantic descriptions attached to path prefixes. Enriches vector embeddings via hierarchical prefix matching. Does not affect FTS
- **Smart chunking** — scored break point system: headings (100-50), code fences (80), HRs (60), paragraphs (20), list items (5), newlines (1). Squared distance decay prefers breaks closer to target. Avoids splitting inside fenced code blocks
- **BM25 normalization** — `abs(raw) / (1 + abs(raw))` maps raw FTS5 scores to (0, 1) where higher = stronger match
- **No runtime dependencies** — only `@cloudflare/workers-types` as a peer dep for types
- **Real Cloudflare types** — programs against ambient CF types (`SqlStorage`, `Vectorize`) from `@cloudflare/workers-types` via tsconfig. Key types (`SqlStorage`, `SqlStorageCursor`, `SqlStorageValue`) are re-exported from `src/index.ts` so consumers don't need ambient globals. Mocks in `./testing` are structurally compatible
- **Multilingual tokenizer** — FTS5 uses `unicode61` (no Porter stemmer), enabling language-neutral keyword search
- **Multilingual embeddings** — `@cf/baai/bge-m3` supports 100+ languages (1024-dimensional vectors)
- **Content reconstruction** — `get()` uses `char_offset` for overlap-aware reconstruction, accurately rebuilding the original document from overlapping chunks
- **Vector count tracking** — `qmd_meta` stores a `vector_count` key updated during index/remove operations, so `stats().totalVectors` returns accurate counts
- **Chunk limit guard** — configurable `maxChunksPerDocument` in `QmdConfig` prevents runaway chunking of extremely large documents
- **Safe metadata parsing** — `JSON.parse` calls for stored metadata are wrapped in try-catch, preventing corrupted JSON from crashing searches
- **Empty query validation** — `searchFts()`, `searchVector()`, and `search()` return empty results for empty/whitespace queries instead of executing
- **Namespace utility** — shared `buildNamespaceFilter()` standardizes glob/exact namespace matching between FTS and vector search
- **Schema versioning** — `qmd_meta` tracks version (currently v2). Incremental migration support (v1 → v2 adds `content_hash` column + `qmd_contexts` table)

## File Map

| File | Purpose |
|------|---------|
| `src/index.ts` | Public API surface — re-exports Qmd class, types, and utilities |
| `src/qmd.ts` | Main `Qmd` class — orchestrates indexing, search, contexts, content hashing |
| `src/types.ts` | All TypeScript interfaces and types |
| `src/schema.ts` | Schema initialization with versioned migration (v1 → v2) |
| `src/fts.ts` | BM25 full-text search (FTS5 query building + execution) |
| `src/vector.ts` | Vectorize embedding indexing + similarity search + context enrichment |
| `src/rrf.ts` | Reciprocal Rank Fusion for hybrid result merging |
| `src/chunker.ts` | Smart document chunking with scored break points + code fence awareness |
| `src/hash.ts` | FNV-1a 32-bit hash for content change detection |
| `src/namespace.ts` | Shared namespace glob/exact filter utility for FTS + vector consistency |
| `src/testing.ts` | Mock implementations (`MockSqlStorage`, `MockVectorize`, `createMockEmbedFn`) for testing without CF runtime |
| `src/bun-sqlite.d.ts` | Minimal bun:sqlite type declarations (avoids conflicts with `@cloudflare/workers-types` globals) |

## Testing

Two-tier test strategy:

- **Unit tests** (`bun test tests/*.test.ts`) — 181 tests, ~200ms. Uses `MockSqlStorage` (bun:sqlite backed) and `MockVectorize` (in-memory cosine similarity). No Cloudflare runtime needed.
- **Workerd tests** (`vitest run --config vitest.config.ts`) — 26 tests via `@cloudflare/vitest-pool-workers`. Runs in real workerd with actual `SqlStorage`. Tests the full DO integration path.

The `./testing` sub-export provides mocks for consuming projects to test their Qmd integration without Cloudflare dependencies.

## Exports

Two package entry points:
- `@stablemodels/qmd-cf` — Main library (`Qmd` class, domain types, utilities, and Cloudflare platform types: `SqlStorage`, `SqlStorageCursor`, `SqlStorageValue`)
- `@stablemodels/qmd-cf/testing` — Test mocks (`MockSqlStorage`, `MockVectorize`, `createMockEmbedFn`)
