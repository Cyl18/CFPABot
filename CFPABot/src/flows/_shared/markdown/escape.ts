// src/flows/_shared/markdown/escape.ts
// PURE: Markdown text escaping and sanitization for safe inclusion
// in GitHub comments and review bodies.
// No I/O, no globals, no side effects.

/**
 * Characters that have special meaning in GitHub-Flavored Markdown
 * and must be escaped when appearing as literal text.
 */
const GFM_ESCAPE_RE = /([\\`*_{}[\]()#+\-!.~|<>])/g;

/**
 * Escape a string for literal inclusion in Markdown text.
 * Prevents markdown characters from being interpreted as formatting.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(GFM_ESCAPE_RE, "\\$1");
}


/**
 * Escape a string for inclusion in a Markdown table cell.
 * Pipe characters are escaped, newlines replaced with <br>.
 */
export function escapeTableCell(text: string): string {
  return text
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

/**
 * Escape a string for inclusion in a Markdown code span (backtick-delimited).
 * Multiple backticks are reduced to avoid breaking the code fence.
 */
export function escapeInlineCode(text: string): string {
  // Replace backticks with a safe alternative
  return text.replace(/`/g, "\\`");
}

/**
 * Escape a URL for inclusion in a Markdown link or image target.
 */
export function escapeUrl(url: string): string {
  return url
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/ /g, "%20");
}

/**
 * Convert arbitrary text to a safe Markdown link label (the [...] part).
 * Strips brackets and newlines.
 */
export function escapeLinkLabel(text: string): string {
  return text.replace(/[[\]]/g, "").replace(/\r?\n/g, " ");
}

/**
 * Sanitize user-provided text for safe inclusion in GitHub Flavored Markdown.
 * Strips or escapes characters that could break the comment layout.
 * This is NOT an HTML sanitizer - GitHub comments support only a safe subset
 * of HTML, but we avoid HTML entirely in deterministic sections.
 */
export function sanitizeMarkdown(text: string): string {
  return text
    // Escape markdown syntax characters
    .replace(GFM_ESCAPE_RE, "\\$1")
    // Remove HTML tags (simple strip)
    .replace(/<[^>]*>/g, "")
    // Normalize whitespace
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ");
}
