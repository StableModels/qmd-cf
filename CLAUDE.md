# @ember/qmd-cf — Hybrid Search for Durable Objects

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
- **Strong signal probe** — in hybrid mode, FTS runs first. If BM25 top score ≥ 0.85 with gap ≥ 0.15 to second, skips the Vectorize round-trip
- **Content hashing** — FNV-1a 32-bit hash stored in `content_hash` column. `index()` skips re-chunking and re-embedding when content is unchanged
- **Context system** — semantic descriptions attached to path prefixes. Enriches vector embeddings via hierarchical prefix matching. Does not affect FTS
- **Smart chunking** — scored break point system: headings (100-50), code fences (80), HRs (60), paragraphs (20), list items (5), newlines (1). Squared distance decay prefers breaks closer to target. Avoids splitting inside fenced code blocks
- **BM25 normalization** — `abs(raw) / (1 + abs(raw))` maps raw FTS5 scores to [0, 1) where higher = stronger match
- **No runtime dependencies** — only `@cloudflare/workers-types` as a peer dep for types
- **SqlStorage interface** — decouples from Cloudflare's exact API shape for testability
- **Multilingual tokenizer** — FTS5 uses `unicode61` (no Porter stemmer), enabling language-neutral keyword search
- **Multilingual embeddings** — `@cf/baai/bge-m3` supports 100+ languages (1024-dimensional vectors)
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

## Usage from Agent Package

QMD is integrated into the agent's EmberAgent DO for auto-inject memory recall. The agent initializes QMD with hybrid FTS5 + Vectorize search in its constructor, indexes memory files on first activation, and queries QMD before each `streamText()` call to inject relevant context into the system prompt.

```ts
import { Qmd } from "@ember/qmd-cf";

// In DurableObject constructor (with optional Vectorize):
this.qmd = new Qmd(ctx.storage.sql, {
  vectorize: env.VECTORIZE,
  embedFn: (texts) => env.AI.run("@cf/baai/bge-m3", { text: texts }).then(r => r.data),
});

// Set up contexts for path prefixes:
this.qmd.setContext("life/areas/health/", "Health and wellness documents");

// Index a document (skips if content unchanged):
const { chunks, skipped } = await this.qmd.index({ id: "soul.md", content: "...", title: "Soul", docType: "identity" });

// Search (uses strong signal probe in hybrid mode):
const results = await this.qmd.search("what does the agent care about?");
```

The agent's `memory/indexing.ts` and `memory/recall.ts` modules handle the indexing lifecycle and search-to-prompt formatting.
