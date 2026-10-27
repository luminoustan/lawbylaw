/**
 * markdown-lite.ts — tiny in-house Markdown renderer for chat text parts.
 *
 * Deliberately small: fenced code blocks, headings, lists, blockquote, GFM
 * pipe tables, bold / italic / strikethrough, inline code, and links. No
 * highlighters, no workers, no external libraries. All input is HTML-escaped
 * before markup is applied, so LLM output can never inject script (the page's
 * CSP blocks script anyway).
 *
 * Links are emitted as <a data-href="…"> and opened through the `openExternal`
 * host message after a confirmation (click handling in the components).
 * Images are never loaded — the CSP only allows same-origin images — so
 * `![alt](url)` renders as its alt text.
 */

import { escapeHtml } from "./escape"
import { renderMermaid } from "./mermaid-lite"

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, "&#96;")
}

/** Only http(s) and mailto links are handed to the host's openExternal. */
function safeHref(raw: string): string | null {
  const url = raw.trim()
  return /^(?:https?:|mailto:)/i.test(url) ? url : null
}

/**
 * Defense-in-depth for the generated diagram SVG: the renderer already escapes
 * its text, but strip script/event-handler/javascript: vectors before the SVG
 * is injected through innerHTML anyway.
 */
function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "")
}

/** Inline emphasis/code/link parsing. */
function inline(src: string): string {
  // Every piece of *generated* markup is parked in `masked` and replaced by a
  // \x00N\x00 sentinel, so the text that remains is exactly the model's own
  // text. That text is then HTML-escaped before emphasis is applied, which is
  // what makes raw model output (including anything that merely *looks* like a
  // tag) inert.
  const masked: string[] = []
  const protect = (html: string): string => {
    masked.push(html)
    return `\uE000${masked.length - 1}\uE001`
  }

  let text = src
  // Inline code (escape content fully so it can hold `<` etc.)
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => protect(`<code>${escapeHtml(code)}</code>`))

  // Images: ![alt](url) — never loaded; shown as their alt text. Must be
  // handled before links so the `[alt](url)` part is not read as a link.
  text = text.replace(/!\[([^\]\n]*)\]\(([^()\s]+)\)/g, (_m, alt: string) => protect(escapeHtml(alt)))

  // Links: [label](url) — url must not contain spaces or parens. Only
  // navigable schemes become anchors; anything else (javascript:, data:,
  // file:) renders as escaped plain text.
  text = text.replace(
    /\[([^\]\n]+)\]\(([^()\s]+)\)/g,
    (_m, label: string, href: string) => {
      const safe = safeHref(href)
      if (!safe) return escapeHtml(label)
      if (label === "SSO" && /^https:\/\/sso\.agc\.gov\.sg\//i.test(safe)) {
        return protect(
          `<a href="#" class="dsm-sso-link" data-href="${escapeAttr(safe)}" title="View on Singapore Statutes Online">link</a>`,
        )
      }
      return protect(`<a href="#" data-href="${escapeAttr(safe)}" title="${escapeAttr(safe)}">${escapeHtml(label)}</a>`)
    },
  )

  // Autolink bare URLs: http://, https://, or bare localhost:port / 127.0.0.1:port.
  text = text.replace(
    /\b(?:https?:\/\/[^\s<>"'`]+|(?:localhost|127\.0\.0\.1):\d+(?:\/[^\s<>"'`]*)?)/gi,
    (rawUrl) => {
      let url = rawUrl
      url = url.replace(/<[^>]*>.*$/, "")
      let trail = ""
      while (url.length > 0 && /[.,;:!?)*_~<>"']$/.test(url)) {
        trail = url.slice(-1) + trail
        url = url.slice(0, -1)
      }
      if (!url) return rawUrl
      const href = /^https?:\/\//i.test(url) ? url : `http://${url}`
      return protect(`<a href="#" data-href="${escapeAttr(href)}" title="${escapeAttr(href)}">${escapeHtml(url)}</a>`) + trail
    },
  )

  // Escape every character that is NOT a generated-markup sentinel.
  text = text
    .split(/(\uE000\d+\uE001)/)
    .map((seg) => (/^\uE000\d+\uE001$/.test(seg) ? seg : escapeHtml(seg)))
    .join("")

  // Emphasis passes now wrap already-escaped inner text.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) => `<strong>${inner}</strong>`)
  text = text.replace(/__([^_\n]+)__/g, (_m, inner: string) => `<strong>${inner}</strong>`)
  text = text.replace(/~~([^~\n]+)~~/g, (_m, inner: string) => `<del>${inner}</del>`)
  // Single asterisk emphasis — only when not part of `**`.
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_m, lead: string, inner: string) => `${lead}<em>${inner}</em>`)
  // Single underscore emphasis.
  text = text.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, (_m, lead: string, inner: string) => `${lead}<em>${inner}</em>`)

  // Unmask all generated markup
  text = text.replace(/\uE000(\d+)\uE001/g, (_m, idx: string) => masked[Number(idx)] ?? "")
  return text
}

/** Strip the common leading indentation shared by every non-blank line, so a
 * code block the model indented (e.g. inside a list) renders flush-left. */
function dedent(lines: string[]): string {
  let min = Infinity
  for (const line of lines) {
    if (/^\s*$/.test(line)) continue
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0
    if (indent < min) min = indent
  }
  if (!Number.isFinite(min) || min === 0) return lines.join("\n")
  return lines.map((line) => (/^\s*$/.test(line) ? line : line.slice(min))).join("\n")
}

/** The "Copy"/"Copied" pill shown in every code-block header. */
function copyButton(): string {
  // Pill button styled like .dsm-menu-trigger; the two labels swap on the
  // .is-copied class that the click handler toggles.
  return `<button type="button" class="dsm-code-copy" title="Copy code" aria-label="Copy code"><span class="dsm-code-copy-label">Copy</span><span class="dsm-code-copy-label-copied">Copied</span></button>`
}

/**
 * Render a `mermaid` fence as a diagram. The source is kept in a collapsed
 * `<details>` so it stays copyable/quotable. The diagram itself is the
 * affordance: clicking it (or pressing Enter/Space) opens the fullscreen
 * viewer wired in `components/markdown-text.tsx`. Returns null when the
 * diagram cannot be drawn, so the caller can fall back to the plain code block.
 */
function renderMermaidBlock(body: string): string | null {
  const diagram = renderMermaid(body)
  if (!diagram.ok) return null
  return (
    `<div class="dsm-code dsm-code--mermaid">` +
    `<div class="dsm-mermaid-diagram" role="button" tabindex="0" aria-label="Open diagram full screen" title="Click to open full screen">${sanitizeSvg(diagram.svg)}</div>` +
    `<details class="dsm-mermaid-source">` +
    `<summary>` +
    `<span class="dsm-mermaid-source-closed">View source</span>` +
    `<span class="dsm-mermaid-source-open">Hide source</span>` +
    `</summary>` +
    `<pre>${escapeHtml(body)}</pre></details>` +
    `</div>`
  )
}

function renderCodeBlock(code: string, lang: string): string {
  const header = lang ? `<div class="dsm-code-lang">${escapeHtml(lang)}</div>` : ""
  const copy = copyButton()
  const body = code.replace(/\n$/, "")

  // Mermaid fences become an SVG diagram; unsupported/unparseable diagrams fall
  // through to the plain code block below so nothing is ever hidden.
  if (/^mermaid$/i.test(lang.trim())) {
    const rendered = renderMermaidBlock(body)
    if (rendered) return rendered
  }

  const lines = body.split("\n")

  // Long blocks collapse to a preview. A native <details> keeps this
  // pure-HTML (no signals here) and works with the existing copy handler.
  // Threshold: 30 lines — small code snippets stay fully visible; large
  // file dumps (e.g. model quoting entire files) collapse with a preview.
  const PREVIEW_LINES = 30
  if (lines.length > PREVIEW_LINES) {
    const preview = escapeHtml(lines.slice(0, PREVIEW_LINES).join("\n"))
    const rest = escapeHtml(lines.slice(PREVIEW_LINES).join("\n"))
    const hidden = lines.length - PREVIEW_LINES
    const moreLabel = `Show ${hidden} more line${hidden === 1 ? "" : "s"}`
    return (
      `<div class="dsm-code dsm-code--collapsed">` +
      `<div class="dsm-code-head">${header}${copy}</div>` +
      `<pre>${preview}</pre>` +
      `<details class="dsm-code-more">` +
      `<summary>` +
      `<span class="dsm-code-more-closed">${moreLabel}</span>` +
      `<span class="dsm-code-more-open">Show less</span>` +
      `</summary>` +
      `<pre>${rest}</pre></details>` +
      `</div>`
    )
  }

  return `<div class="dsm-code"><div class="dsm-code-head">${header}${copy}</div><pre>${escapeHtml(body)}</pre></div>`
}

/** Split a GFM table row into raw cell strings. Pipes that appear inside
 * inline-code spans or link targets are temporarily masked so the split never
 * breaks on them. */
function splitTableRow(row: string): string[] {
  let s = row.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|")) s = s.slice(0, -1)
  const masked: string[] = []
  const protectedStr = s.replace(/`[^`\n]*`|\[[^\]\n]*\]\([^()\s]*\)/g, (m) => {
    masked.push(m)
    return `\x00${masked.length - 1}\x00`
  })
  return protectedStr.split("|").map((cell) =>
    // eslint-disable-next-line no-control-regex -- \x00 is the intentional mask sentinel
    cell.replace(/\x00(\d+)\x00/g, (_m, idx: string) => masked[Number(idx)] ?? ""),
  )
}

/** Map a delimiter cell (`---`, `:---`, `:---:`, `---:`) to an alignment. */
function alignFor(cell: string): string | null {
  const t = cell.trim()
  const left = t.startsWith(":")
  const right = t.endsWith(":")
  if (left && right) return "center"
  if (right) return "right"
  if (left) return "left"
  return null
}

/** Render one table cell. `inline()` escapes the text itself, so the raw cell
 *  must not be escaped first (that rendered quotes as a literal `&quot;`). */
function cellHtml(raw: string, align: string | null, tag: "th" | "td"): string {
  const a = align ? ` style="text-align:${align}"` : ""
  return `<${tag}${a}>${inline(raw.trim())}</${tag}>`
}

/** True when a line is a GFM delimiter row (`|`, `-`, `:`, spaces; has `-`). */
function isDelimiterRow(s: string): boolean {
  const t = s.trim()
  return /^[\s:|-]+$/.test(t) && t.includes("|") && t.includes("-")
}

/**
 * Render a markdown string to an HTML fragment (safe, escaped).
 *
 * `hardBreaks` renders a single newline inside a paragraph as `<br>` instead of
 * collapsing it to a space (CommonMark soft break). User-authored prompts opt
 * in so the line breaks they typed with Shift+Enter stay visible; assistant
 * output keeps the standard soft-break behaviour.
 */
export function renderMarkdown(src: string, opts: { hardBreaks?: boolean } = {}): string {
  const text = src.replace(/\r\n?/g, "\n")
  const lines = text.split("\n")
  const out: string[] = []
  let i = 0

  /** Inline-render a paragraph, turning its newlines into hard breaks when the
   *  caller opted in (user prompts). Applied after `inline()` so the emphasis
   *  regexes — which deliberately exclude `\n` — still see the raw newlines. */
  const paragraphHtml = (para: string): string => {
    const html = inline(para)
    return opts.hardBreaks ? html.replace(/\n/g, "<br>") : html
  }

  const flushParagraph = (start: number, end: number) => {
    // In hard-break mode (user prompts) keep the line structure intact —
    // including trailing newlines — so Shift+Enter blank lines stay visible.
    // Otherwise collapse the paragraph to a single space-joined line.
    const para = opts.hardBreaks
      ? lines
          .slice(start, end)
          .map((l) => l.trim())
          .join("\n")
          .replace(/^\n+/, "")
          .replace(/[ \t]+$/, "")
      : lines
          .slice(start, end)
          .map((l) => l.trim())
          .join(" ")
          .trim()
    if (!para) return

    out.push(`<p>${paragraphHtml(para)}</p>`)
  }

  // Index of the delimiter row for a potential table starting at `start`,
  // skipping blank lines between header and delimiter (or -1 if none).
  const findDelimiter = (start: number): number => {
    let j = start + 1
    while (j < lines.length && /^\s*$/.test(lines[j]!)) j++
    return j < lines.length && isDelimiterRow(lines[j]!) ? j : -1
  }

  const isTableStart = (idx: number): boolean =>
    lines[idx]!.includes("|") && findDelimiter(idx) !== -1

  while (i < lines.length) {
    const line = lines[i]!
    // Info string may be any single token, not just a language name: CODE
    // REFERENCES use `startLine:endLine:filepath` (colons and slashes).
    const fence = line.match(/^\s*```\s*([^\s`]*)\s*$/)
    if (fence) {
      const lang = fence[1] ?? ""
      i++
      const buf: string[] = []
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        buf.push(lines[i]!)
        i++
      }
      i++ // skip the closing fence (safe when it does not exist — loop ends)
      out.push(renderCodeBlock(dedent(buf), lang))
      continue
    }

    if (/^\s*$/.test(line)) {
      i++
      continue
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1]!.length
      out.push(`<h${level}>${inline(heading[2]!.trim())}</h${level}>`)
      i++
      continue
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      out.push("<hr>")
      i++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*>\s?/, ""))
        i++
      }
      out.push(`<blockquote>${inline(buf.join(" ").trim())}</blockquote>`)
      continue
    }

    // GFM table: a header row containing `|` followed by a delimiter row.
    if (line.includes("|")) {
      const delimIdx = findDelimiter(i)
      if (delimIdx !== -1) {
        const headerCells = splitTableRow(line)
        const headerCount = headerCells.length
        const delimCells = splitTableRow(lines[delimIdx]!)
        const aligns: (string | null)[] = []
        for (let k = 0; k < headerCount; k++) aligns.push(alignFor(delimCells[k] ?? ""))
        const body: string[][] = []
        let j = delimIdx + 1
        while (j < lines.length) {
          const n = lines[j]!
          if (/^\s*$/.test(n) || !n.includes("|")) break
          body.push(splitTableRow(n))
          j++
        }
        const thead = `<tr>${headerCells
          .map((c, k) => cellHtml(c, aligns[k] ?? null, "th"))
          .join("")}</tr>`
        const tbody = body
          .map((cells) => {
            const padded = cells.slice(0, headerCount)
            while (padded.length < headerCount) padded.push("")
            return `<tr>${padded
              .map((c, k) => cellHtml(c, aligns[k] ?? null, "td"))
              .join("")}</tr>`
          })
          .join("")
        out.push(
          `<div class="dsm-md-table-wrap"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`,
        )
        i = j
        continue
      }
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/)
    if (ul || ol) {
      const ordered = Boolean(ol)
      const items: string[] = []
      // Keep each item's own number: statutory text such as "17. Judgment ..."
      // must not be renumbered to "1.".
      const nums: string[] = []
      if (ul) items.push(ul[1]!)
      else {
        items.push(ol![2]!)
        nums.push(ol![1]!)
      }
      i++
      while (i < lines.length) {
        const next = lines[i]!
        const u2 = next.match(/^\s*[-*+]\s+(.*)$/)
        const o2 = next.match(/^\s*(\d+)[.)]\s+(.*)$/)
        if (ordered && o2) {
          items.push(o2[2]!)
          nums.push(o2[1]!)
          i++
        } else if (!ordered && u2) {
          items.push(u2[1]!)
          i++
        } else if (/^\s*$/.test(next)) {
          // allow blank lines between items
          if (i + 1 < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[i + 1]!) : /^\s*[-*+]\s+/.test(lines[i + 1]!))) {
            i++
            continue
          }
          break
        } else {
          break
        }
      }
      if (ordered) {
        out.push(`<ol start="${nums[0]}">${items.map((it, k) => `<li value="${nums[k]}">${inline(it.trim())}</li>`).join("")}</ol>`)
      } else {
        out.push(`<ul>${items.map((it) => `<li>${inline(it.trim())}</li>`).join("")}</ul>`)
      }
      continue
    }

    // Plain paragraph: accumulate until a structural line.
    const start = i
    i++
    while (i < lines.length) {
      const n = lines[i]!
      if (
        /^\s*$/.test(n) ||
        /^\s*```/.test(n) ||
        /^\s*#{1,6}\s+/.test(n) ||
        /^\s*>\s?/.test(n) ||
        /^\s*[-*+]\s+/.test(n) ||
        /^\s*\d+[.)]\s+/.test(n) ||
        isTableStart(i)
      ) {
        break
      }
      i++
    }
    // In hard-break mode (user prompts) absorb trailing blank lines into the
    // paragraph so intentional Shift+Enter blank lines render as <br> instead
    // of being dropped as paragraph separators.
    if (opts.hardBreaks) {
      while (i < lines.length && /^\s*$/.test(lines[i]!)) i++
    }
    flushParagraph(start, i)
  }

  return out.join("\n")
}
