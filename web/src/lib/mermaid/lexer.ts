/**
 * mermaid/lexer.ts — shared primitives and tokenizer for the in-house Mermaid
 * renderer.
 *
 * Holds the geometry constants, label helpers, SVG scaffolding, and the
 * flowchart statement tokenizer that both the parser and the renderer build
 * on. Split out of `lib/mermaid-lite.ts`; the facade there re-exports the
 * public surface unchanged.
 */

import { escapeHtml } from "../escape"

export type MermaidRender =
  | { ok: true; kind: "flowchart" | "sequence"; svg: string }
  | { ok: false; error: string }

export const FONT_SIZE = 13
export const LINE_H = 17
/**
 * Rough advance width of the UI sans font at FONT_SIZE. Deliberately on the
 * generous side: the editor's UI font varies by platform, and an underestimate
 * lets text run into its node border.
 */
export const CHAR_W = FONT_SIZE * 0.6

/** Unique-per-document prefix so marker ids never collide between diagrams. */
let svgUid = 0

/** Allocate the next per-document SVG id prefix. */
export function nextSvgUid(): string {
  return `dsmm${++svgUid}`
}

/** Strip a single pair of matching quotes mermaid allows around a label. */
export function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2) {
    const a = t[0]
    const b = t[t.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return t.slice(1, -1)
  }
  return t
}

/**
 * Greedily wrap one line to at most `max` characters. Break opportunities are
 * after whitespace, `/` and `,`, so prose and file paths both wrap. A token
 * with no opportunity stays whole rather than being cut mid-word.
 */
export function wrapLine(line: string, max: number): string[] {
  if (line.length <= max) return [line]
  const out: string[] = []
  let cur = ""
  for (const token of line.split(/(?<=[\s/,])/)) {
    if (cur && (cur + token).trimEnd().length > max) {
      out.push(cur.trimEnd())
      cur = token.trimStart()
    } else {
      cur += token
    }
  }
  if (cur.trim()) out.push(cur.trimEnd())
  return out.length > 0 ? out : [line]
}

/**
 * Split a mermaid label into display lines (`<br/>`, `\n`, literal newlines).
 * When `wrapAt` is given, lines longer than that many characters are wrapped
 * so one long sentence does not make a node (and the whole diagram) huge.
 */
export function labelLines(raw: string, wrapAt?: number): string[] {
  const lines = unquote(raw)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  const base = lines.length > 0 ? lines : [""]
  return wrapAt ? base.flatMap((l) => wrapLine(l, wrapAt)) : base
}

export function textWidth(lines: string[]): number {
  let w = 0
  for (const line of lines) w = Math.max(w, line.length * CHAR_W)
  return w
}

export function round(n: number): number {
  return Math.round(n * 10) / 10
}

/** Arrowhead `<marker>` definitions shared by both diagram types. */
export function markerDefs(uid: string): string {
  return (
    `<defs>` +
    `<marker id="${uid}-arrow" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="7.5" markerHeight="7.5" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="dsm-mermaid-head" d="M0,0 L10,5 L0,10 z"/></marker>` +
    `<marker id="${uid}-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="dsm-mermaid-head-open" d="M1,1 L9,5 L1,9"/></marker>` +
    `<marker id="${uid}-circle" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><circle class="dsm-mermaid-head" cx="5" cy="5" r="4"/></marker>` +
    `<marker id="${uid}-cross" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="dsm-mermaid-head-open" d="M1.5,1.5 L8.5,8.5 M8.5,1.5 L1.5,8.5"/></marker>` +
    `</defs>`
  )
}

export type HeadKind = "none" | "arrow" | "open" | "circle" | "cross"

export function markerRef(kind: HeadKind, uid: string, position: "start" | "end"): string {
  if (kind === "none") return ""
  return ` marker-${position}="url(#${uid}-${kind})"`
}

/**
 * How far past its natural width a diagram may be stretched to fill the
 * transcript column (see `.dsm-mermaid-svg`). A narrow graph would otherwise
 * sit in the left of a wide column; the cap stops a two-node diagram from
 * ballooning into a giant picture.
 */
export const MERMAID_FILL_CAP = 2

/**
 * The smallest scale a diagram is shrunk to when it is wider than the column.
 * Below this the labels become unreadable, so the diagram keeps this size and
 * scrolls/pans horizontally instead (`Fit` still means "as small as allowed").
 */
export const MERMAID_MIN_SCALE = 0.7

/**
 * Wrap an SVG body in a responsive root element. The inline `max-width` is the
 * fill cap: the CSS gives the SVG `width: 100%`, so a diagram narrower than the
 * column grows into it, up to this bound.
 */
export function svgRoot(uid: string, w: number, h: number, label: string, body: string): string {
  return (
    `<svg class="dsm-mermaid-svg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(label)}" ` +
    `viewBox="0 0 ${round(w)} ${round(h)}" width="${round(w)}" height="${round(h)}" ` +
    `style="max-width:${round(w * MERMAID_FILL_CAP)}px;--dsm-mermaid-min:${round(w * MERMAID_MIN_SCALE)}px" preserveAspectRatio="xMidYMid meet">` +
    markerDefs(uid) +
    body +
    `</svg>`
  )
}

// ── Flowchart tokenizer ─────────────────────────────────────────────────────

export type FlowShape =
  | "rect"
  | "round"
  | "stadium"
  | "diamond"
  | "circle"
  | "subroutine"
  | "cylinder"
  | "hexagon"
  | "asymmetric"

export interface NodeRef {
  id: string
  label?: string
  shape?: FlowShape
}

export interface EdgeSpec {
  label: string
  head: HeadKind
  tail: HeadKind
  dashed: boolean
  thick: boolean
}

export const NODE_ID = "[A-Za-z0-9_.\\-]+"

export const SHAPE_FORMS: Array<[RegExp, FlowShape]> = [
  [new RegExp(`^(${NODE_ID})\\(\\(([\\s\\S]+)\\)\\)$`), "circle"],
  [new RegExp(`^(${NODE_ID})\\(\\[([\\s\\S]+)\\]\\)$`), "stadium"],
  [new RegExp(`^(${NODE_ID})\\[\\[([\\s\\S]+)\\]\\]$`), "subroutine"],
  [new RegExp(`^(${NODE_ID})\\[\\(([\\s\\S]+)\\)\\]$`), "cylinder"],
  [new RegExp(`^(${NODE_ID})\\{\\{([\\s\\S]+)\\}\\}$`), "hexagon"],
  [new RegExp(`^(${NODE_ID})\\{([\\s\\S]+)\\}$`), "diamond"],
  [new RegExp(`^(${NODE_ID})\\(([\\s\\S]+)\\)$`), "round"],
  [new RegExp(`^(${NODE_ID})\\[([\\s\\S]+)\\]$`), "rect"],
  [new RegExp(`^(${NODE_ID})>([\\s\\S]+)\\]$`), "asymmetric"],
]

export const BARE_ID = new RegExp(`^${NODE_ID}$`)

export function parseNodeExpr(expr: string): NodeRef | null {
  const e = expr.trim()
  if (!e) return null
  for (const [re, shape] of SHAPE_FORMS) {
    const m = re.exec(e)
    if (m) return { id: m[1]!, label: unquote(m[2]!), shape }
  }
  if (BARE_ID.test(e)) return { id: e }
  return null
}

export function headKind(ch: string | undefined): HeadKind {
  if (ch === "<" || ch === ">") return "arrow"
  if (ch === "o") return "circle"
  if (ch === "x") return "cross"
  return "none"
}

/**
 * Match an edge operator at `i` (depth 0 only). Handles the `-->`, `---`,
 * `-.->`, `==>`, `--o`/`--x` forms, a `|label|` suffix, and the inline
 * `-- label -->` form. A leading bare `o`/`x` arrowhead is only accepted at a
 * word boundary so node ids like `foo-->bar` are not mis-split.
 */
export function matchEdgeAt(s: string, i: number): { len: number; spec: EdgeSpec } | null {
  const rest = s.slice(i)
  const m = /^([<ox]?)(-{2,}|-\.-*|={2,})([>ox]?)/.exec(rest)
  if (!m) return null
  const lead = m[1]!
  if ((lead === "o" || lead === "x") && i > 0 && /[A-Za-z0-9_.-]/.test(s[i - 1]!)) return null

  let len = m[0].length
  let head = headKind(lead)
  let tail = headKind(m[3])
  const dashed = m[2]!.includes(".")
  const thick = m[2]!.includes("=")
  let label = ""

  const pipe = /^\s*\|([^|]*)\|/.exec(rest.slice(len))
  // The inline `-- label -->` form only opens with a bare two-character
  // operator. After a complete arrow or a longer link (`-->`, `---`, `==>`) the
  // text that follows is the next node in a chain (`A --> B --> C`), not a label.
  const opensInlineLabel = !lead && !m[3] && (m[2] === "--" || m[2] === "==" || m[2] === "-.")
  if (pipe) {
    label = pipe[1]!.trim()
    len += pipe[0].length
  } else if (opensInlineLabel) {
    const inline = /^\s+([^|\n]+?)\s+([<ox]?)(-{2,}|-\.-*|={2,}|\.-+)([>ox]?)/.exec(rest.slice(len))
    if (inline) {
      label = inline[1]!.trim()
      if (inline[2]) head = headKind(inline[2])
      if (inline[4]) tail = headKind(inline[4])
      len += inline[0].length
    }
  }
  return { len, spec: { label, head, tail, dashed, thick } }
}

export type FlowToken = { kind: "node"; expr: string } | { kind: "edge"; spec: EdgeSpec }

/** Split a statement into node expressions and edge operators. */
export function tokenizeStatement(stmt: string): FlowToken[] {
  const tokens: FlowToken[] = []
  let buf = ""
  let depth = 0
  let i = 0
  const n = stmt.length
  while (i < n) {
    const ch = stmt[i]!
    if (ch === '"' || ch === "'") {
      buf += ch
      i++
      while (i < n && stmt[i] !== ch) {
        buf += stmt[i]
        i++
      }
      if (i < n) {
        buf += stmt[i]
        i++
      }
      continue
    }
    if (depth === 0) {
      const edge = matchEdgeAt(stmt, i)
      if (edge) {
        if (buf.trim()) tokens.push({ kind: "node", expr: buf.trim() })
        buf = ""
        tokens.push({ kind: "edge", spec: edge.spec })
        i += edge.len
        continue
      }
    }
    if (ch === "[" || ch === "(" || ch === "{") depth++
    else if (ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1)
    buf += ch
    i++
  }
  if (buf.trim()) tokens.push({ kind: "node", expr: buf.trim() })
  return tokens
}

/** Split a node token on `&` (outside brackets/quotes) into individual refs. */
export function splitAmp(expr: string): string[] {
  const out: string[] = []
  let buf = ""
  let depth = 0
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]!
    if (ch === '"' || ch === "'") {
      buf += ch
      i++
      while (i < expr.length && expr[i] !== ch) {
        buf += expr[i]
        i++
      }
      if (i < expr.length) {
        buf += expr[i]
        i++
      }
      continue
    }
    if (ch === "[" || ch === "(" || ch === "{") depth++
    else if (ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1)
    if (ch === "&" && depth === 0) {
      out.push(buf.trim())
      buf = ""
      i++
      continue
    }
    buf += ch
    i++
  }
  out.push(buf.trim())
  return out.filter(Boolean)
}
