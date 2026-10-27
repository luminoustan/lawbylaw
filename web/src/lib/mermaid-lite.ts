/**
 * mermaid-lite.ts — tiny in-house renderer for Mermaid diagrams in chat.
 *
 * The app deliberately ships no external UI libraries (see
 * `lib/markdown-lite.ts`), so instead of pulling in the ~3 MB `mermaid`
 * package this module parses and lays out the two diagram types that actually
 * show up in agent output — `flowchart` / `graph` and `sequenceDiagram` — and
 * renders them to inline SVG. Anything it cannot parse falls back to the plain
 * code block, so a diagram is never lost, only left un-rendered.
 *
 * The output is a fully-escaped SVG string (no script, no event handlers)
 * injected through `innerHTML` like the rest of markdown-lite. All styling is
 * left to CSS classes so the diagram follows the editor theme.
 *
 * This file is a thin facade: the implementation lives in `lib/mermaid/`
 * (`lexer`, `parse`, `layout`, `render`). The public surface below is
 * unchanged so existing importers keep working.
 */

export type { MermaidRender } from "./mermaid/lexer"
export { MERMAID_FILL_CAP, MERMAID_MIN_SCALE } from "./mermaid/lexer"
export { renderMermaid } from "./mermaid/render"
