# @stablemodels/qmd-cf

Hybrid full-text + vector search for Cloudflare Durable Objects. A DO-native reimagination of [qmd](https://github.com/tobi/qmd).

FTS5 runs co-located in the DO's SQLite for zero-latency BM25 keyword search. Optionally add Cloudflare Vectorize for semantic search, fused via Reciprocal Rank Fusion.

## Install

```bash
npm install @stablemodels/qmd-cf
```

Peer dependency: `@cloudflare/workers-types` (optional, for type checking).

## Usage

### FTS-only (zero external dependencies)

```ts
import { Qmd } from "@stablemodels/qmd-cf";

export class MyDO extends DurableObject {
  qmd: Qmd;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.qmd = new Qmd(ctx.storage.sql);
  }

  async index(id: string, content: string) {
    return this.qmd.index({ id, content });
  }

  async search(query: string) {
    return this.qmd.search(query);
  }
}
```

### Hybrid FTS + Vector

```ts
this.qmd = new Qmd(ctx.storage.sql, {
  vectorize: env.VECTORIZE,
  embedFn: (texts) =>
    env.AI.run("@cf/baai/bge-m3", { text: texts }).then((r) => r.data),
});
```

Requires a [Vectorize index](https://developers.cloudflare.com/vectorize/) and [Workers AI](https://developers.cloudflare.com/workers-ai/) binding in your `wrangler.toml`:

```toml
[ai]
binding = "AI"

[[vectorize]]
binding = "VECTORIZE"
index_name = "my-index"
```

## API

### Indexing

```ts
// Index a document
await qmd.index({ id: "doc.md", content: "...", title: "My Doc" });

// Batch index
await qmd.indexBatch(docs);

// Remove a document
await qmd.remove("doc.md");
```

Documents support optional `title`, `docType`, `namespace`, and `metadata` fields. Content hashing skips re-indexing when content is unchanged.

### Searching

```ts
// Hybrid search (FTS + vector when configured, FTS-only otherwise)
const results = await qmd.search("query", { limit: 5 });

// FTS-only search
const ftsResults = qmd.searchFts("query");

// Vector-only search
const vecResults = await qmd.searchVector("query");
```

Filter by `docType` or `namespace`:

```ts
const results = await qmd.search("query", { docType: "note", namespace: "projects/web" });
```

### Other methods

```ts
qmd.has("doc.md");                     // Check if document exists
qmd.get("doc.md");                     // Get document content
qmd.list({ namespace: "projects" });   // List document IDs
qmd.listByNamespace("projects/*");     // List docs by namespace pattern
qmd.stats();                           // Index statistics
qmd.rebuild();                         // Rebuild FTS index
```

### Contexts

Contexts enrich vector embeddings with semantic path descriptions:

```ts
qmd.setContext("projects/", "Engineering project documentation");
qmd.setContext("projects/web/", "Frontend web application docs");
```

## Testing

The package provides test utilities via the `/testing` subpath:

```ts
import { MockSqlStorage, createMockEmbedFn } from "@stablemodels/qmd-cf/testing";
import { Qmd } from "@stablemodels/qmd-cf";

const sql = new MockSqlStorage();
const qmd = new Qmd(sql);

await qmd.index({ id: "doc-1", content: "Hello world" });
const results = qmd.searchFts("hello");

sql.close();
```

`MockSqlStorage` is backed by `bun:sqlite` with real FTS5 support. `MockVectorize` provides in-memory vector search with brute-force cosine similarity. `createMockEmbedFn(dims?)` returns a deterministic embedding function for reproducible tests.

Requires [Bun](https://bun.sh) as the test runner.

### Running the library's own tests

```bash
# Unit tests (bun, ~200ms)
bun test tests/*.test.ts

# Workerd integration tests (vitest + @cloudflare/vitest-pool-workers)
vitest run --config vitest.config.ts

# Both
npm test
```
