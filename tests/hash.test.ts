import { describe, expect, test } from "bun:test";
import { fnv1a32 } from "../src/hash.js";

describe("fnv1a32", () => {
	test("produces consistent 8-char hex output", () => {
		const hash = fnv1a32("hello world");
		expect(hash).toHaveLength(8);
		expect(hash).toMatch(/^[0-9a-f]{8}$/);
		// Same input always produces same output
		expect(fnv1a32("hello world")).toBe(hash);
	});

	test("different inputs produce different hashes", () => {
		const h1 = fnv1a32("hello world");
		const h2 = fnv1a32("hello world!");
		const h3 = fnv1a32("Hello world");
		expect(h1).not.toBe(h2);
		expect(h1).not.toBe(h3);
		expect(h2).not.toBe(h3);
	});

	test("empty string produces valid hash", () => {
		const hash = fnv1a32("");
		expect(hash).toHaveLength(8);
		expect(hash).toMatch(/^[0-9a-f]{8}$/);
	});

	test("handles unicode content", () => {
		const hash = fnv1a32("こんにちは世界");
		expect(hash).toHaveLength(8);
		expect(hash).toMatch(/^[0-9a-f]{8}$/);
	});
});
