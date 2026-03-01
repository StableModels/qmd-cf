/**
 * FNV-1a 32-bit hash — fast, deterministic, non-cryptographic.
 * Used to detect content changes for skip-on-unchanged indexing.
 * Returns an 8-character lowercase hex string.
 */
export function fnv1a32(input: string): string {
	let hash = 0x811c9dc5; // FNV offset basis
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193); // FNV prime
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
