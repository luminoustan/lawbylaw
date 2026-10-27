/**
 * escape.ts — HTML/XML escaping shared by the in-house renderers.
 *
 * The page injects markdown and SVG through `innerHTML`, so every piece of
 * model output must be escaped with the same entity set before markup is
 * applied. Keeping one implementation means the two renderers can never drift.
 */

/** Escape text for safe interpolation into HTML or XML markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
