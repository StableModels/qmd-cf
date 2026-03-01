import type { Chunk } from "./types.js";

const DEFAULT_CHUNK_SIZE = 3200; // ~800 tokens at ~4 chars/token
const DEFAULT_CHUNK_OVERLAP = 480; // 15% overlap

/** Break point scores — spread wide so headings decisively win over paragraphs. */
const BREAK_SCORES: Record<string, number> = {
	h1: 100,
	h2: 90,
	h3: 80,
	h4: 70,
	h5: 60,
	h6: 50,
	code_fence: 80,
	hr: 60,
	paragraph: 20,
	list_item: 5,
	newline: 1,
};

interface BreakPoint {
	offset: number;
	score: number;
}

/**
 * Chunk a document into overlapping segments, seeking intelligent break points.
 *
 * Uses a scored break point system (from qmd) that pre-scans the entire document
 * for structural markers (headings, code fences, paragraphs, etc.) and picks the
 * highest-scoring break point within a window around the target cut position.
 * Avoids splitting inside fenced code blocks.
 */
export function chunkText(
	docId: string,
	content: string,
	maxChars: number = DEFAULT_CHUNK_SIZE,
	overlapChars: number = DEFAULT_CHUNK_OVERLAP,
): Chunk[] {
	if (content.length === 0) {
		return [];
	}

	// Short content: single chunk, no splitting needed
	if (content.length <= maxChars) {
		return [{ docId, seq: 0, text: content, charOffset: 0 }];
	}

	const breakPoints = scanBreakPoints(content);
	const codeFences = findCodeFences(content);
	const chunks: Chunk[] = [];
	let pos = 0;
	let seq = 0;

	while (pos < content.length) {
		const remaining = content.length - pos;

		if (remaining <= maxChars) {
			chunks.push({ docId, seq, text: content.slice(pos), charOffset: pos });
			break;
		}

		const targetEnd = pos + maxChars;
		const cutoff = findBestCutoff(
			content,
			breakPoints,
			codeFences,
			targetEnd,
			maxChars,
		);

		// Ensure we make forward progress
		const endPos = cutoff > pos ? cutoff : pos + maxChars;

		chunks.push({
			docId,
			seq,
			text: content.slice(pos, endPos),
			charOffset: pos,
		});

		// Advance position, subtracting overlap
		const advance = endPos - pos - overlapChars;
		pos += Math.max(advance, 1);

		// Don't start the next chunk inside a code fence — skip to fence end
		for (const [fStart, fEnd] of codeFences) {
			if (pos > fStart && pos < fEnd) {
				pos = fEnd;
				break;
			}
		}

		seq++;
	}

	return chunks;
}

/**
 * Pre-scan the document for structural break points with scores.
 *
 * Returns break points sorted by offset. Each offset points to the first
 * character of the new section (i.e., right after the structural marker).
 */
function scanBreakPoints(text: string): BreakPoint[] {
	const points: BreakPoint[] = [];
	const lines = text.split("\n");
	let offset = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineStart = offset;
		const nextLineStart = offset + line.length + 1; // +1 for the \n

		// Headings (must be at start of line)
		if (line.startsWith("###### ")) {
			points.push({ offset: lineStart, score: BREAK_SCORES.h6 });
		} else if (line.startsWith("##### ")) {
			points.push({ offset: lineStart, score: BREAK_SCORES.h5 });
		} else if (line.startsWith("#### ")) {
			points.push({ offset: lineStart, score: BREAK_SCORES.h4 });
		} else if (line.startsWith("### ")) {
			points.push({ offset: lineStart, score: BREAK_SCORES.h3 });
		} else if (line.startsWith("## ")) {
			points.push({ offset: lineStart, score: BREAK_SCORES.h2 });
		} else if (line.startsWith("# ")) {
			points.push({ offset: lineStart, score: BREAK_SCORES.h1 });
		}

		// Code fences (``` at start of line) — break before the fence
		if (line.startsWith("```")) {
			points.push({ offset: lineStart, score: BREAK_SCORES.code_fence });
		}

		// Horizontal rules (---, ***, ___ with optional spaces)
		if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
			points.push({ offset: lineStart, score: BREAK_SCORES.hr });
		}

		// Paragraph boundary (empty line followed by content)
		if (line === "" && i > 0) {
			points.push({ offset: nextLineStart, score: BREAK_SCORES.paragraph });
		}

		// List items
		if (/^(\s*[-*+]\s|\s*\d+\.\s)/.test(line)) {
			points.push({ offset: lineStart, score: BREAK_SCORES.list_item });
		}

		// Every newline is a minimal break point
		if (i < lines.length - 1) {
			points.push({ offset: nextLineStart, score: BREAK_SCORES.newline });
		}

		offset = nextLineStart;
	}

	return points;
}

/**
 * Find matched code fence (```) ranges. Returns [start, end] pairs
 * where start is the offset of the opening fence and end is the offset
 * just after the closing fence line's newline.
 */
function findCodeFences(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const lines = text.split("\n");
	let offset = 0;
	let fenceStart: number | null = null;

	for (const line of lines) {
		if (line.startsWith("```")) {
			if (fenceStart === null) {
				fenceStart = offset;
			} else {
				// Close the fence — end is after this line
				ranges.push([fenceStart, offset + line.length + 1]);
				fenceStart = null;
			}
		}
		offset += line.length + 1;
	}

	return ranges;
}

/**
 * Check if an offset falls inside any code fence range.
 */
function isInsideCodeFence(
	offset: number,
	codeFences: Array<[number, number]>,
): boolean {
	for (const [start, end] of codeFences) {
		// Inside means strictly between the opening and closing fence lines.
		// Breaking AT the start of a fence (before it) is fine.
		if (offset > start && offset < end) return true;
	}
	return false;
}

/**
 * Find the best break point near the target cut position.
 *
 * Searches a window from 50% to 100% of maxChars around the chunk start.
 * Applies squared distance decay so breaks closer to the target are preferred.
 * Rejects candidates inside code fences.
 */
function findBestCutoff(
	text: string,
	breakPoints: BreakPoint[],
	codeFences: Array<[number, number]>,
	targetEnd: number,
	maxChars: number,
): number {
	const windowStart = targetEnd - Math.floor(maxChars * 0.5);
	const windowEnd = targetEnd;
	const windowSize = windowEnd - windowStart;

	let bestScore = -1;
	let bestOffset = targetEnd;

	for (const bp of breakPoints) {
		if (bp.offset < windowStart || bp.offset > windowEnd) continue;
		if (isInsideCodeFence(bp.offset, codeFences)) continue;

		// Squared distance decay: prefer breaks closer to targetEnd
		const dist = Math.abs(bp.offset - targetEnd);
		const normalizedDist = dist / windowSize;
		const multiplier = 1.0 - normalizedDist * normalizedDist * 0.7;
		const weightedScore = bp.score * multiplier;

		if (weightedScore > bestScore) {
			bestScore = weightedScore;
			bestOffset = bp.offset;
		}
	}

	// Fallback: if no structural break points found, try word boundary (last space)
	if (bestScore < 0) {
		const lastSpace = text.lastIndexOf(" ", targetEnd);
		if (lastSpace >= windowStart) {
			return lastSpace + 1;
		}
	}

	return bestOffset;
}
