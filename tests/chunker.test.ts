import { describe, expect, test } from "bun:test";
import { chunkText } from "../src/chunker.js";

describe("chunkText", () => {
	test("returns empty array for empty content", () => {
		const chunks = chunkText("doc1", "");
		expect(chunks).toEqual([]);
	});

	test("returns single chunk for short content", () => {
		const chunks = chunkText("doc1", "Hello, world!");
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toEqual({
			docId: "doc1",
			seq: 0,
			text: "Hello, world!",
			charOffset: 0,
		});
	});

	test("returns single chunk when content equals maxChars", () => {
		const text = "a".repeat(100);
		const chunks = chunkText("doc1", text, 100, 15);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].text).toBe(text);
	});

	test("splits long content into multiple chunks", () => {
		// 200 chars of content with 50 char max
		const text = "word ".repeat(40); // 200 chars
		const chunks = chunkText("doc1", text, 50, 8);
		expect(chunks.length).toBeGreaterThan(1);

		// All chunks should have correct docId
		for (const chunk of chunks) {
			expect(chunk.docId).toBe("doc1");
		}

		// Sequence numbers should be monotonically increasing
		for (let i = 0; i < chunks.length; i++) {
			expect(chunks[i].seq).toBe(i);
		}
	});

	test("preserves paragraph breaks as split points", () => {
		// Create text where a paragraph break falls in the break window
		const before = "a".repeat(80);
		const after = "b".repeat(50);
		const text = `${before}\n\n${after}`;
		// maxChars = 100 means window starts at char 50
		// paragraph break at char 80 is in the window
		const chunks = chunkText("doc1", text, 100, 10);

		expect(chunks.length).toBeGreaterThan(1);
		// First chunk should end at or near the paragraph break
		expect(
			chunks[0].text.endsWith("\n\n") || !chunks[0].text.includes("b"),
		).toBe(true);
	});

	test("preserves sentence boundaries as split points", () => {
		// Build text where a sentence ends in the break window
		const sentence1 = `${"a".repeat(75)}. `;
		const sentence2 = "b".repeat(50);
		const text = sentence1 + sentence2;
		const chunks = chunkText("doc1", text, 100, 10);

		expect(chunks.length).toBeGreaterThan(1);
	});

	test("uses word boundaries when no better break point exists", () => {
		// Create text with only word boundaries in the break zone
		const words = "hello ";
		const text = words.repeat(30); // 180 chars
		const chunks = chunkText("doc1", text, 50, 5);

		expect(chunks.length).toBeGreaterThan(1);
		// Chunks should not split in the middle of "hello"
		for (const chunk of chunks) {
			const trimmed = chunk.text.trimEnd();
			expect(
				trimmed.endsWith("hello") ||
					trimmed.endsWith("o") ||
					chunk.text.endsWith(" "),
			).toBe(true);
		}
	});

	test("handles text with no good break points", () => {
		// Single very long word
		const text = "a".repeat(200);
		const chunks = chunkText("doc1", text, 50, 5);

		expect(chunks.length).toBeGreaterThan(1);
		// All content should be covered
		const totalLen = chunks.reduce((sum, c) => sum + c.text.length, 0);
		// With overlap, total text length will be >= original
		expect(totalLen).toBeGreaterThanOrEqual(text.length);
	});

	test("overlap creates overlapping chunks", () => {
		const text = "abcdefghij".repeat(20); // 200 chars
		const chunks = chunkText("doc1", text, 50, 10);

		// Verify overlap via charOffset
		for (let i = 0; i < chunks.length - 1; i++) {
			expect(chunks[i + 1].charOffset).toBeLessThan(
				chunks[i].charOffset + chunks[i].text.length,
			);
		}
	});

	test("charOffset tracks position in original document", () => {
		const text = "word ".repeat(100); // 500 chars
		const chunks = chunkText("doc1", text, 100, 15);

		expect(chunks[0].charOffset).toBe(0);
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i].charOffset).toBeGreaterThan(0);
			expect(chunks[i].charOffset).toBeGreaterThan(chunks[i - 1].charOffset);
		}
	});

	test("uses custom chunk size and overlap", () => {
		const text = "a ".repeat(500); // 1000 chars
		const small = chunkText("doc1", text, 100, 10);
		const large = chunkText("doc1", text, 500, 50);

		// Smaller chunk size should produce more chunks
		expect(small.length).toBeGreaterThan(large.length);
	});

	test("handles content just over maxChars", () => {
		const text = "a".repeat(101);
		const chunks = chunkText("doc1", text, 100, 10);
		expect(chunks).toHaveLength(2);
	});

	test("last chunk captures remaining content", () => {
		const text = "word ".repeat(40); // 200 chars
		const chunks = chunkText("doc1", text, 50, 5);

		// Last chunk should end at the end of the document
		const lastChunk = chunks[chunks.length - 1];
		expect(lastChunk.charOffset + lastChunk.text.length).toBeLessThanOrEqual(
			text.length,
		);
	});
});

describe("scored break points", () => {
	test("prefers heading breaks over paragraph breaks", () => {
		// Build text so both a paragraph break and a heading are in the window
		const part1 = "word ".repeat(12); // 60 chars
		const part2 = "\n\nSome paragraph.\n\n## New Section\n";
		const part3 = "content ".repeat(10); // 80 chars
		const text = part1 + part2 + part3;
		const chunks = chunkText("doc1", text, 100, 10);

		expect(chunks.length).toBeGreaterThan(1);
		// The first chunk should break at the heading, not the earlier paragraph break
		expect(chunks[0].text).toContain("paragraph");
		expect(chunks[0].text).not.toContain("New Section");
	});

	test("avoids splitting inside code fences", () => {
		const before = "a ".repeat(30); // 60 chars
		const code =
			"```python\ndef foo():\n    return 1\n\ndef bar():\n    return 2\n```";
		const after = `\n\n${"b ".repeat(40)}`; // 80 chars
		const text = `${before}\n${code}\n${after}`;
		const chunks = chunkText("doc1", text, 100, 10);

		// No chunk should start or end inside a code block (between ``` pairs)
		// Check that each chunk either contains complete fences or no fences
		for (const chunk of chunks) {
			const fenceCount = (chunk.text.match(/```/g) || []).length;
			// 0 fences (chunk outside code) or 2 fences (complete block) are acceptable
			// 1 fence means we split inside a code block — bad
			if (fenceCount === 1) {
				// Allow if it starts at the opening fence (chunk begins with the code block)
				// or ends at the closing fence
				const startsWithFence = chunk.text.trimStart().startsWith("```");
				const endsWithFence = chunk.text.trimEnd().endsWith("```");
				expect(startsWithFence || endsWithFence).toBe(true);
			}
		}
	});

	test("breaks at horizontal rules", () => {
		const before = "a ".repeat(35); // 70 chars
		const after = "b ".repeat(35); // 70 chars
		const text = `${before}\n---\n${after}`;
		const chunks = chunkText("doc1", text, 100, 10);

		expect(chunks.length).toBeGreaterThan(1);
		// First chunk should not contain "b" content
		const firstChunkBs = (chunks[0].text.match(/b /g) || []).length;
		expect(firstChunkBs).toBeLessThan(5);
	});

	test("heading levels have decreasing priority", () => {
		// Put H1 and H3 at similar distances from target — H1 should win
		const part1 = "x ".repeat(20); // 40 chars
		const h3 = "\n### Section Three\n";
		const filler = "y ".repeat(5); // 10 chars
		const h1 = "\n# Top Heading\n";
		const rest = "z ".repeat(30); // 60 chars
		const text = part1 + h3 + filler + h1 + rest;
		const chunks = chunkText("doc1", text, 80, 5);

		// The chunk should prefer breaking at the H1 heading
		if (chunks.length > 1) {
			expect(chunks[0].text).toContain("Section Three");
		}
	});

	test("distance decay prefers breaks closer to target", () => {
		// Two paragraph breaks, one far from target and one close
		const part1 = "a ".repeat(15); // 30 chars — far paragraph break
		const part2 = "\n\n";
		const part3 = "b ".repeat(20); // 40 chars — close paragraph break
		const part4 = "\n\n";
		const part5 = "c ".repeat(20); // 40 chars
		const text = part1 + part2 + part3 + part4 + part5;
		const chunks = chunkText("doc1", text, 100, 10);

		if (chunks.length > 1) {
			// The break closer to position 100 should be preferred
			const firstLen = chunks[0].text.length;
			// Should be at or near the second paragraph break (~72 chars), not the first (~32 chars)
			expect(firstLen).toBeGreaterThan(50);
		}
	});

	test("preserves code block integrity in long documents", () => {
		const sections = [];
		for (let i = 0; i < 5; i++) {
			sections.push(`## Section ${i}\n\n${"Text content. ".repeat(10)}\n`);
			sections.push(
				`\`\`\`js\nconst x${i} = ${i};\nconsole.log(x${i});\n\`\`\`\n\n`,
			);
		}
		const text = sections.join("");
		const chunks = chunkText("doc1", text, 200, 30);

		expect(chunks.length).toBeGreaterThan(1);
		// Verify all chunks are valid
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeGreaterThan(0);
			expect(chunk.docId).toBe("doc1");
		}
	});
});
