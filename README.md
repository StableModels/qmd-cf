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

The `@stablemodels/qmd-cf/testing` sub-export provides mocks for testing without Cloudflare services:

```ts
import { Qmd } from "@stablemodels/qmd-cf";
import { MockSqlStorage, MockVectorize, createMockEmbedFn } from "@stablemodels/qmd-cf/testing";

// FTS-only
const qmd = new Qmd(new MockSqlStorage());

// Hybrid
const qmd = new Qmd(new MockSqlStorage(), {
  vectorize: new MockVectorize(),
  embedFn: createMockEmbedFn(),
});

await qmd.index({ id: "test", content: "hello world" });
const results = await qmd.search("hello");
```

`MockSqlStorage` uses `bun:sqlite` in-memory with real FTS5. `MockVectorize` provides in-memory cosine similarity. Requires [Bun](https://bun.sh) as the test runner.

### Running the library's own tests

```bash
# Unit tests (bun, ~200ms)
bun test tests/*.test.ts

# Workerd integration tests (vitest + @cloudflare/vitest-pool-workers)
vitest run --config vitest.config.ts

# Both
npm test
```
