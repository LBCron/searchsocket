/**
 * Input bounds shared by every search entry point: the HTTP route, the MCP
 * tools and direct `SearchEngine` callers.
 *
 * Kept in their own module, with no imports, so the MCP server and the browser
 * layers can use them without pulling in the engine.
 */

/**
 * Longest search query accepted, in characters after trimming.
 *
 * Generous for any real query — keyword searches are tens of characters, a
 * pasted sentence a few hundred — while keeping the per-result excerpt and
 * ranking work that scales with query length bounded. An unbounded query let a
 * single 63 KB request burn roughly 12 seconds of CPU.
 */
export const MAX_QUERY_LENGTH = 512;

/** Longest page path or URL accepted by page lookups. */
export const MAX_PATH_LENGTH = 2048;
