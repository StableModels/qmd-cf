import { DurableObject } from "cloudflare:workers";
import { Qmd } from "../../src/index.js";
import type {
	Document,
	FtsResult,
	HybridSearchOptions,
	IndexStats,
	SearchOptions,
	SearchResult,
} from "../../src/types.js";

export class QmdObject extends DurableObject {
	private qmd: Qmd;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		this.qmd = new Qmd(ctx.storage.sql);
	}

	async index(doc: Document): Promise<{ chunks: number; skipped: boolean }> {
		return this.qmd.index(doc);
	}

	async indexBatch(
		docs: Document[],
	): Promise<{ documents: number; chunks: number; skipped: number }> {
		return this.qmd.indexBatch(docs);
	}

	async remove(docId: string): Promise<void> {
		return this.qmd.remove(docId);
	}

	searchFts(query: string, options?: SearchOptions): FtsResult[] {
		return this.qmd.searchFts(query, options);
	}

	async search(
		query: string,
		options?: HybridSearchOptions,
	): Promise<SearchResult[]> {
		return this.qmd.search(query, options);
	}

	get(
		docId: string,
	): { content: string; title: string | null; docType: string | null } | null {
		return this.qmd.get(docId);
	}

	has(docId: string): boolean {
		return this.qmd.has(docId);
	}

	list(options?: { namespace?: string; docType?: string }): string[] {
		return this.qmd.list(options);
	}

	listByNamespace(
		pattern: string,
		limit?: number,
	): Array<{
		docId: string;
		title: string | null;
		content: string;
		namespace: string | null;
	}> {
		return this.qmd.listByNamespace(pattern, limit);
	}

	stats(): IndexStats {
		return this.qmd.stats();
	}

	rebuild(): void {
		this.qmd.rebuild();
	}

	setContext(prefix: string, description: string, namespace?: string): void {
		this.qmd.setContext(prefix, description, namespace);
	}

	removeContext(prefix: string, namespace?: string): void {
		this.qmd.removeContext(prefix, namespace);
	}

	listContexts(
		namespace?: string,
	): Array<{ prefix: string; description: string; namespace: string }> {
		return this.qmd.listContexts(namespace);
	}

	getContextsForDoc(
		docId: string,
	): Array<{ prefix: string; description: string }> {
		return this.qmd.getContextsForDoc(docId);
	}
}

export default {
	fetch() {
		return new Response("qmd-cf test worker");
	},
};
