/**
 * Safely parse a JSON metadata string, returning null on invalid JSON.
 */
export function safeParseMetadata(
	raw: string | null,
): Record<string, string | number | boolean | null> | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * Build a SQL WHERE clause fragment for namespace filtering.
 * Standardizes namespace matching between FTS and vector search.
 *
 * - Glob pattern "people/*": matches "people/ryan", "people/jane", etc.
 * - Exact match "people/ryan": matches only that namespace
 *
 * Returns the SQL clause fragment (e.g., "d.namespace LIKE ?") and binding value.
 */
export function buildNamespaceFilter(
	namespace: string,
	column: string,
): { clause: string; binding: string } {
	if (namespace.includes("*")) {
		const prefix = namespace.replace(/\*+$/, "").replace(/\/+$/, "");
		return {
			clause: `${column} LIKE ?`,
			binding: `${prefix}/%`,
		};
	}
	return {
		clause: `${column} = ?`,
		binding: namespace,
	};
}
