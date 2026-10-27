/**
 * Table reconstruction for legislation PDFs.
 *
 * The extractor emits one `TextLine` per baseline group, each carrying its
 * runs' device-space x-extent, device y and font size.  Prose lines have a
 * single run (or a few runs separated by word spaces); a table row has two or
 * more runs separated by a column gutter.  This module finds those blocks and
 * renders them as GitHub pipe tables, leaving every other line untouched.
 *
 * Detection is deliberately conservative: a block is only converted when it
 * yields at least two columns and two rows, and every run lands in a cell (a
 * lone stray punctuation mark in a gutter aside), so no text is ever dropped.
 *
 * Two quirks of the source shape the algorithm:
 *   - A table header is often emitted as one output line per column, and the
 *     column-major draw order interleaves the two header rows (`First column`,
 *     `Replaced section`, `Second column`, `Applicable section`).  Visual rows
 *     are therefore clustered by device y across the whole stream, not by
 *     consecutive lines.
 *   - Table rows are frequently separated by blank lines, because a row that
 *     opens with `(i)` trips the extractor's paragraph-break rule.  Blocks
 *     therefore span blank lines freely.
 *
 * No external dependencies.
 */

/** A single decoded text run, with the geometry the table pass needs. */
export interface TextRun {
  /** Device-space x where the run starts (CTM applied). */
  x: number
  /** Device-space x where the run ends (estimated advance). */
  xEnd: number
  /** Device-space y of the run's baseline. */
  y: number
  /** Font size scaled to device x units. */
  size: number
  /** Decoded text, possibly with a leading inserted space. */
  text: string
  /**
   * True when the run was drawn from one of the broken LaTeX math fonts whose
   * glyphs are repaired by `tex-math-fonts.ts`.  Only these runs may be moved
   * back into x order (see `renderPlainLine`).
   */
  mathFont?: boolean
}

/** One extracted line: its baseline y and the runs on that baseline. */
export interface TextLine {
  y: number
  runs: TextRun[]
  /**
   * True when `runs` is known to be in exact x order and the spacing between
   * them must be recomputed from the geometry rather than trusted from each
   * run's text.  Set by the fraction pass on a line it has spliced a token
   * into; every other line keeps the extractor's own spacing.
   */
  xOrdered?: boolean
}

/** Lines within this many em of each other share a visual row. */
const Y_TOL_EM = 0.6
/**
 * A run gap at least this many em wide marks a row as a table candidate.  It
 * sits above section-heading (`1. Title`, ~1.5 em) and list-marker gaps.
 */
const GAP_ROW_EM = 2.0
/**
 * A block-level gutter must be at least this many em wide.  It is narrower than
 * the per-row threshold because a column boundary is set by the widest cell:
 * one row's short first cell leaves only a slim gap to the next column.
 */
const GAP_COL_EM = 0.8
/** A block needs at least this many rows and columns to become a table. */
const MIN_ROWS = 2
const MIN_COLS = 2
/**
 * A column band narrower than this many em is a hanging list marker (`(a)`),
 * not a column: it is folded into the cell body it labels.
 */
const MIN_COL_EM = 1.2

/** Plain-text render of one line, matching the pre-table output exactly. */
export function renderPlainLine(line: TextLine): string {
  const text = line.xOrdered ? joinByX(line.runs) : renderLineText(line.runs)
  return text.replace(/\s+/g, " ").trim()
}

/**
 * Join a line's runs into text.
 *
 * Runs are normally appended in reading order, so the accumulated text is used
 * as-is — that preserves the word spacing the extractor inferred from the text
 * operators.
 *
 * The exception is the LaTeX math fonts.  LaTeX emits the delimiters of
 * `\left( … \right)` in a later text object than the expression between them,
 * so `(A − B)` arrives as `A − B()`.  A bracket drawn from a math font is
 * positioned with an explicit matrix (so its x is exact) and is moved back into
 * x order.  Only brackets qualify, and only when they actually start left of
 * the run before them: the x of other runs — a decimal point drawn as part of a
 * number, a word drawn with no repositioning between calls — is stale, and
 * moving on it would corrupt the text (`175.14` → `17514.`).
 */
function renderLineText(runs: TextRun[]): string {
  const joined = (): string => runs.map((r) => r.text).join("")
  if (runs.length < 2 || inXOrder(runs)) return joined()

  const movable: TextRun[] = []
  const anchors: TextRun[] = []
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    if (r.mathFont && isBracket(r.text.trim()) && i > 0 && r.x < runs[i - 1].x) movable.push(r)
    else anchors.push(r)
  }
  if (movable.length === 0 || !inXOrder(anchors)) return joined()

  movable.sort((a, b) => a.x - b.x)
  const out = anchors.slice()
  for (const m of movable) {
    let i = 0
    while (i < out.length && out[i].x <= m.x) i++
    out.splice(i, 0, m)
  }
  return joinByX(out)
}

/**
 * Join runs that are already in x order, inserting a space wherever the gap
 * between one run's end and the next run's start is wide enough to be a word
 * space.  Used only where the run order is known to be exact (a reordered math
 * bracket, a spliced fraction token); the ordinary path trusts the spacing the
 * extractor already baked into each run's text.
 */
function joinByX(runs: TextRun[]): string {
  let text = ""
  let prevEnd: number | null = null
  for (const r of runs) {
    const t = r.text.trim()
    if (!t) continue
    // A gap before closing punctuation is the punctuation's own advance, not a
    // word space — the fraction bar is wider than the digits it spans, so the
    // comma after `A/B` sits further right than the denominator's xEnd.
    const closes = /^[.,;:)\]}”’]/.test(t)
    if (!closes && prevEnd !== null && r.x - prevEnd > (r.size > 0 ? r.size : 10) * 0.15) text += " "
    text += t
    prevEnd = r.xEnd
  }
  return text
}

/** A bracket glyph: `()[]{}` or a piece of a stretchable delimiter. */
function isBracket(text: string): boolean {
  return text.length === 1 && ("()[]{}".includes(text) || /[\u239b-\u23ad]/.test(text))
}

/** True when no run starts left of its predecessor. */
function inXOrder(runs: TextRun[]): boolean {
  for (let i = 1; i < runs.length; i++) if (runs[i].x < runs[i - 1].x) return false
  return true
}

// ─── Stacked fractions ────────────────────────────────────────────────────────
//
// A fraction is drawn as a numerator above a denominator, straddling the
// baseline of the surrounding text: `A` over `B` in `A/B × C`.  The extractor
// emits each of the three as its own line, because the numerator and
// denominator sit far enough from the baseline to trip the line-break test —
// and because they are set in a smaller font, that test is tighter for them
// than for the body text.  The result reads as `A` / `B × C`, which loses the
// fraction entirely.
//
// The pass below recognises the shape and rewrites it as `A/B`, merging the
// fraction into the baseline line at the fraction's x-position.  It runs before
// both the plain and the table renderer, so a fraction inside a table cell is
// linearised too.

/**
 * A fraction's numerator and denominator are set smaller than the body text.
 * The cap is what separates a fraction from a pair of stacked table cells,
 * which are drawn at the body size; the remaining geometry checks are not
 * enough on their own (a table column's cells are short, centred and symmetric
 * too).
 */
const FRACTION_MAX_SIZE_RATIO = 0.85
/**
 * How far the numerator/denominator may sit from the baseline, as a multiple of
 * the body font size.  A stacked fraction keeps its parts within about half an
 * em of the baseline; a superscript or a footnote marker sits closer still, and
 * an ordinary wrapped line sits much further away.
 */
const FRACTION_MAX_OFFSET_EM = 0.75
/**
 * How far the parts must sit from the baseline.  A fraction's parts straddle it
 * at roughly half an em; a table's rows are spaced a tenth of an em apart, so
 * the row that falls between two stacked cells is far too close to be a
 * baseline.
 */
const FRACTION_MIN_OFFSET_EM = 0.3
/**
 * The numerator and denominator must overlap horizontally by at least this
 * fraction of the narrower one's width.  A fraction bar spans both, so they
 * line up; two unrelated small-font runs on adjacent lines do not.
 */
const FRACTION_MIN_OVERLAP = 0.5
/**
 * A fraction's parts are short — a variable, a number, a small expression.  A
 * long run is a sentence, not a numerator: a footnote marker `*` above the
 * line `[*Updated to be consistent with the 2020 Revised Edition]` overlaps it
 * in x and sits within the offset window, but is not a fraction.  The cap has
 * to admit a denominator like `B − C − D − E` (13 characters).
 */
const FRACTION_MAX_PART_CHARS = 16
/**
 * A fraction's parts are mathematical, not prose.  A part that reads as two
 * words (`employees of` above `members of` in a form), that carries no
 * alphanumeric at all (a run of leader dots), or that carries a comma (a table
 * cell's text) is not a numerator.
 */
const FRACTION_PART_RE = /^(?=.*[A-Za-z0-9])(?!.*[A-Za-z]\s+[A-Za-z])(?!.*,).*$/
/**
 * The runs of a part must be contiguous.  A fraction's part is one expression
 * (`B − C − D − E`), whose runs sit a word-space apart; a table row's cells are
 * spread across the page, so the gap between them is far wider.
 */
const FRACTION_MAX_PART_GAP_EM = 1.0
/**
 * A part that carries a binary operator is a compound expression, and is
 * parenthesised when the fraction is linearised so that `A` over `B + C` reads
 * as `A/(B + C)` rather than `A/B + C`.
 */
const FRACTION_COMPOUND_RE = /[+\u2212×÷=]/
/**
 * The numerator and denominator must be centred on each other, as a fraction
 * bar centres its parts.  The tolerance is tight: a fraction's parts share a
 * centre to within a fraction of an em, whereas two left-aligned table cells of
 * different widths (`triable` above `the`) differ by half their width.
 */
const FRACTION_MAX_CENTRE_EM = 0.3
/**
 * The baseline text must reach within this many em of the fraction.  A fraction
 * is embedded in the line it belongs to (`formula A/B × C`), so the operator or
 * comma that follows it sits under an em away — a little further when the
 * producer does not emit the fraction bar's spacing as a run.  A table cell in
 * the next column is further still.
 */
const FRACTION_MAX_BASELINE_GAP_EM = 1.5
/**
 * The numerator and denominator must sit at roughly equal distances from the
 * baseline, as a fraction bar centres them.  The tolerance is tight: a real
 * fraction's parts are equidistant to within a few hundredths of an em, whereas
 * a table's rows are spaced a couple of units apart, so some row always falls
 * near the midpoint of a stacked pair of cells.
 */
const FRACTION_MAX_ASYMMETRY_EM = 0.1
/**
 * The baseline run must sit *beside* the fraction, not under it.  A fraction's
 * baseline text (the operator, or the comma that follows it) starts where the
 * fraction ends; a table column's cells share the fraction's x-range exactly,
 * so the row between them overlaps it.
 */
const FRACTION_MAX_BASELINE_OVERLAP_EM = 0.2

/** The x-extent of a run list, or null when it carries no text. */
function runExtent(runs: TextRun[]): { x: number; xEnd: number } | null {
  let x = Infinity
  let xEnd = -Infinity
  for (const r of runs) {
    if (!r.text.trim()) continue
    if (r.x < x) x = r.x
    if (r.xEnd > xEnd) xEnd = r.xEnd
  }
  return xEnd > x ? { x, xEnd } : null
}

/** The text of a run list, joined in x order and trimmed. */
function runText(runs: TextRun[]): string {
  return runs
    .slice()
    .sort((a, b) => a.x - b.x)
    .map((r) => r.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * A stretchy-delimiter piece drawn from the math fonts.  A `\left( … \right)`
 * is emitted as several stacked glyphs (top hook, extension bar, bottom hook),
 * each carrying no meaning of its own.  A real table never contains one, so
 * their presence marks a display formula rather than tabular content.
 */
function isDelimiterPiece(r: TextRun): boolean {
  return r.mathFont === true && /^[\u239b-\u23ad\u221a-\u221c]+$/.test(r.text.trim())
}

/**
 * A radical piece drawn from the math fonts.  A `\sqrt{…}` is emitted as a
 * single root glyph at the left plus a long overbar built from repeated
 * radical glyphs; a lone glyph is a real square-root sign (`10√n`) rather than
 * a frame.
 */
function isRadicalPiece(r: TextRun): boolean {
  return r.mathFont === true && /^[\u221a-\u221c]+$/.test(r.text.trim())
}

/**
 * A lone bracket drawn from the math fonts.  It is the frame's other side when
 * the generator drew only one stretchy piece (`⎠ … ]`), and it must not be read
 * as body text when measuring a baseline's continuity.
 */
function isLiteralBracketRun(r: TextRun): boolean {
  return r.mathFont === true && /^[()[\]{}]$/.test(r.text.trim())
}

/**
 * Rewrite stacked fractions as `num/den`, merging them into the baseline line.
 *
 * A fraction is a small-font numerator and denominator on opposite sides of a
 * baseline, horizontally overlapping.  The baseline is the body-sized text
 * whose y lies between them; the fraction token is spliced into it at the
 * fraction's x-position, and the numerator/denominator runs are removed.
 *
 * The parts are grouped by their own y rather than by `TextLine`, because the
 * extractor folds a denominator and the baseline text that follows it onto one
 * line when their y-gap is under the line-break threshold — `B` and `× C,` in
 * `A/B × C` arrive as a single `TextLine`.
 *
 * Returns the input unchanged when no fraction is found, so the common case
 * allocates nothing.
 */
export function linearizeFractions(
  lines: TextLine[],
  exclude?: (run: TextRun) => boolean,
): TextLine[] {
  // The body font size is the one that carries the most text; a fraction's
  // parts are smaller than it.  Weighting by character count rather than run
  // count keeps the body size correct on a page that is mostly formula, where
  // the small-font parts would otherwise outnumber the prose runs.
  const sizeChars = new Map<number, number>()
  for (const l of lines) {
    for (const r of l.runs) {
      if (r.size <= 0) continue
      if (exclude?.(r)) continue
      const key = Math.round(r.size * 10) / 10
      sizeChars.set(key, (sizeChars.get(key) ?? 0) + r.text.trim().length)
    }
  }
  let bodySize = 0
  let best = 0
  for (const [size, chars] of sizeChars) {
    if (chars > best) { best = chars; bodySize = size }
  }
  if (bodySize <= 0) return lines

  const maxPartSize = bodySize * FRACTION_MAX_SIZE_RATIO
  const maxOffset = bodySize * FRACTION_MAX_OFFSET_EM

  // Group every run by its own y, so a line that mixes a denominator with the
  // baseline text that follows it is split into its two visual rows.  A
  // whitespace run is kept: it carries no text, but it marks where the baseline
  // row begins, which is what the proximity test measures against.
  const rows: { y: number; runs: TextRun[] }[] = []
  for (const l of lines) {
    for (const r of l.runs) {
      if (exclude?.(r)) continue
      let row = rows.find((v) => Math.abs(v.y - r.y) <= 0.5)
      if (!row) { row = { y: r.y, runs: [] }; rows.push(row) }
      row.runs.push(r)
    }
  }
  rows.sort((a, b) => b.y - a.y)

  // A part is a short, mathematical run.  It is normally smaller than the body
  // text; a body-sized part is only accepted when the baseline sits beside it
  // (see the baseline check below), which is what separates a body-sized
  // fraction from a pair of stacked table cells.
  const isPart = (row: { runs: TextRun[] }, allowBodySize: boolean): boolean => {
    const cap = allowBodySize ? bodySize * 1.1 : maxPartSize
    if (!row.runs.every((r) => r.size > 0 && r.size <= cap)) return false
    // The runs must be contiguous: a fraction's part is one expression, whereas
    // a table row's cells are spread across the page.
    const sorted = row.runs.slice().sort((a, b) => a.x - b.x)
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k].x - sorted[k - 1].xEnd > bodySize * FRACTION_MAX_PART_GAP_EM) return false
    }
    const text = runText(row.runs)
    return text.length <= FRACTION_MAX_PART_CHARS && FRACTION_PART_RE.test(text)
  }

  /**
   * Render one side of a fraction.  A compound part (`B − C − D − E`) is
   * parenthesised, because the linear form `A/B − C − D − E` would otherwise
   * read as `(A/B) − C − D − E`.  A part that is already bracketed is left
   * alone.
   */
  const fractionPart = (runs: TextRun[]): string => {
    const text = runText(runs)
    if (/^\(.*\)$/.test(text)) return text
    return FRACTION_COMPOUND_RE.test(text) ? `(${text})` : text
  }

  /**
   * Split a run list into x-separated clusters.  A row can carry two fraction
   * parts side by side — `GZmax` and `Range` over `0.05` and `7` — and each
   * cluster is a candidate part on its own; a gap wider than a fraction's own
   * inter-run spacing starts a new cluster.
   */
  const xClusters = (runs: TextRun[]): TextRun[][] => {
    const out: TextRun[][] = []
    for (const r of runs.slice().sort((a, b) => a.x - b.x)) {
      const last = out[out.length - 1]
      const lastEnd = last ? Math.max(...last.map((o) => o.xEnd)) : -Infinity
      if (last && r.x - lastEnd <= bodySize * FRACTION_MAX_PART_GAP_EM) last.push(r)
      else out.push([r])
    }
    return out
  }

  const consumed = new Set<TextRun>()
  /** Fraction tokens spliced into the baseline at its right edge. */
  const tokens: TextRun[] = []
  /**
   * Tokens appended after all of the baseline's own runs.  The baseline keeps
   * the spacing the extractor baked into its runs, because re-spacing it from
   * the geometry drops the word space in `Amount of cash payout`.
   */
  const suffixed: TextRun[] = []
  /**
   * Set by the unframed display pass.  It places a token on an operator row
   * that sits *between* the lines of a wrapped operand, so the rebuilt lines
   * must keep the extractor's reading order rather than being sorted by y.  The
   * single-row and framed passes put their token on a row that already carries
   * the operand text, where the y-sort is correct.
   */
  let preserveOrder = false
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].runs.every((r) => consumed.has(r))) continue
    // A row can carry more than one numerator side by side; each x-cluster is
    // its own fraction.
    for (let numRuns of xClusters(rows[i].runs.filter((r) => !consumed.has(r)))) {
      let num = runExtent(numRuns)
      if (!num) continue
      // A subscript (`GZ` with a trailing `max`) is drawn as a small run on its
      // own row just below and to the right of the symbol it belongs to; pull
      // it into the numerator so the part reads `GZmax`.
      const numSize = Math.max(...numRuns.map((r) => r.size))
      let numX = num.x
      let numXEnd = num.xEnd
      const scripts: TextRun[] = []
      for (const v of rows) {
        if (v === rows[i]) continue
        const scriptDy = rows[i].y - v.y
        if (scriptDy <= 0 || scriptDy > maxOffset) continue
        for (const r of v.runs) {
          if (consumed.has(r) || r.text.trim() === "" || isDelimiterPiece(r)) continue
          if (r.size >= numSize) continue
          if (r.x > numXEnd + bodySize * FRACTION_MAX_PART_GAP_EM) continue
          if (r.xEnd < numX - bodySize * FRACTION_MAX_PART_GAP_EM) continue
          scripts.push(r)
          numX = Math.min(numX, r.x)
          numXEnd = Math.max(numXEnd, r.xEnd)
        }
      }
      if (scripts.length > 0) {
        numRuns = [...numRuns, ...scripts]
        num = runExtent(numRuns) ?? num
      }
      // Find the denominator: a short row below, overlapping in x.
      for (let j = i + 1; j < rows.length; j++) {
        if (rows[j].runs.every((r) => consumed.has(r))) continue
        const dy = rows[i].y - rows[j].y
        if (dy <= 0) continue
        if (dy > maxOffset * 2) break
        // Only the cluster beneath this numerator is its denominator; a second
        // denominator beside it belongs to the neighbouring numerator.
        let denRuns: TextRun[] = []
        let overlap = 0
        for (const cluster of xClusters(
          rows[j].runs.filter((r) => !consumed.has(r) && r.text.trim() !== ""),
        )) {
          const e = runExtent(cluster)
          if (!e) continue
          const ov = Math.min(num.xEnd, e.xEnd) - Math.max(num.x, e.x)
          if (ov > overlap) { overlap = ov; denRuns = cluster }
        }
        let den = runExtent(denRuns)
        if (!den) continue
        // A subscript on the denominator (`TGZ` with a trailing `max`) is drawn
        // on its own row just below the symbol; pull it into the denominator so
        // the part reads `TGZmax`.
        const denSize = Math.max(...denRuns.map((r) => r.size))
        let denX = den.x
        let denXEnd = den.xEnd
        const denScripts: TextRun[] = []
        for (const v of rows) {
          if (v === rows[j] || v === rows[i]) continue
          const scriptDy = rows[j].y - v.y
          if (scriptDy <= 0 || scriptDy > maxOffset) continue
          for (const r of v.runs) {
            if (consumed.has(r) || r.text.trim() === "" || isDelimiterPiece(r)) continue
            if (r.size >= denSize) continue
            if (r.x > denXEnd + bodySize * FRACTION_MAX_PART_GAP_EM) continue
            if (r.xEnd < denX - bodySize * FRACTION_MAX_PART_GAP_EM) continue
            denScripts.push(r)
            denX = Math.min(denX, r.x)
            denXEnd = Math.max(denXEnd, r.xEnd)
          }
        }
        if (denScripts.length > 0) {
          denRuns = [...denRuns, ...denScripts]
          den = runExtent(denRuns) ?? den
          overlap = Math.min(num.xEnd, den.xEnd) - Math.max(num.x, den.x)
        }
        const narrower = Math.min(num.xEnd - num.x, den.xEnd - den.x)
        if (narrower <= 0 || overlap < narrower * FRACTION_MIN_OVERLAP) continue
        // The parts must be centred on each other, as a fraction bar centres
        // them.  A subscript hangs off the main symbol and shifts the part's
        // extent, so the centre is measured on the largest-sized runs.
        const maxSize = Math.max(...numRuns.map((r) => r.size))
        const core = runExtent(numRuns.filter((r) => r.size >= maxSize - 0.1)) ?? num
        const denMax = Math.max(...denRuns.map((r) => r.size))
        const denCore = runExtent(denRuns.filter((r) => r.size >= denMax - 0.1)) ?? den
        const centreGap = Math.abs((core.x + core.xEnd) / 2 - (denCore.x + denCore.xEnd) / 2)
        if (centreGap > bodySize * FRACTION_MAX_CENTRE_EM) continue
        // The baseline sits between the two parts, carries body text, and sits
        // beside the fraction rather than under it.
        const midY = (rows[i].y + rows[j].y) / 2
        const fracX = Math.min(num.x, den.x)
        const fracXEnd = Math.max(num.xEnd, den.xEnd)
        const partRuns = new Set([...numRuns, ...denRuns])
        const base = rows.find((v) => {
          if (v === rows[i] || v === rows[j]) return false
          if (Math.abs(v.y - midY) > maxOffset) return false
          // The row must carry body text.
          if (
            !v.runs.some(
              (r) => !consumed.has(r) && r.size > maxPartSize && r.text.trim(),
            )
          ) {
            return false
          }
          // A subscript is sometimes extracted on its own row a fraction of a
          // line below the symbol it belongs to, splitting the baseline's runs
          // across two rows.  Gather the small runs from the rows beside this
          // one when measuring continuity, so the split is not read as a table
          // row's column gap.  The fraction's own parts are left out.
          const live = rows
            .filter(
              (w) =>
                w === v ||
                (w !== rows[i] && w !== rows[j] && Math.abs(w.y - v.y) <= maxOffset),
            )
            .flatMap((w) =>
              w.runs.filter(
                (r) =>
                  !consumed.has(r) &&
                  !partRuns.has(r) &&
                  !isLiteralBracketRun(r) &&
                  (w === v ||
                    // A subscript split onto its own row belongs to a symbol on
                    // this row, so it must sit next to one of its runs; a small
                    // run far to the right belongs to another expression.
                    (r.size <= maxPartSize &&
                      v.runs.some(
                        (o) =>
                          r.x <= o.xEnd + bodySize * 0.5 &&
                          r.xEnd >= o.x - bodySize * 0.5,
                      ))),
              ),
            )
          // The row must be one line of text, not a table row whose cells are
          // spread across the page.  The gap the fraction itself occupies is
          // allowed: the baseline text resumes on the far side of the bar.  A
          // subscript's x is stale, so the gap is measured from the running
          // right edge, not the previous run's own end.
          const sorted = live.slice().sort((a, b) => a.x - b.x)
          if (sorted.length === 0) return false
          let prevEnd = sorted[0].xEnd
          for (let k = 1; k < sorted.length; k++) {
            const gap = sorted[k].x - prevEnd
            if (gap > bodySize * FRACTION_MAX_PART_GAP_EM) {
              // The gap is the fraction's own space when it spans the part, or
              // when the text resumes to the left of the part (the fraction is
              // the last thing on the line).
              const spansFraction = prevEnd <= fracXEnd && sorted[k].x >= fracX
              const beforeFraction = sorted[k].x <= fracX
              if (!spansFraction && !beforeFraction) return false
            }
            if (sorted[k].xEnd > prevEnd) prevEnd = sorted[k].xEnd
          }
          // No run may sit under the fraction; the baseline is beside it.
          if (
            live.some(
              (r) =>
                Math.min(r.xEnd, fracXEnd) - Math.max(r.x, fracX) >
                bodySize * FRACTION_MAX_BASELINE_OVERLAP_EM,
            )
          ) {
            return false
          }
          // Some run must reach the fraction, whitespace included: a fraction bar
          // is wider than its digits, so the baseline text starts a little way
          // past the part.
          return live.some(
            (r) =>
              r.x - fracXEnd <= bodySize * FRACTION_MAX_BASELINE_GAP_EM &&
              fracX - r.xEnd <= bodySize * FRACTION_MAX_BASELINE_GAP_EM,
          )
        })
        if (!base) continue
        // The parts must straddle the baseline symmetrically, and far enough from
        // it to be a fraction rather than a table's stacked cells.
        const upper = rows[i].y - base.y
        const lower = base.y - rows[j].y
        if (Math.min(upper, lower) < bodySize * FRACTION_MIN_OFFSET_EM) continue
        const asymmetry = Math.abs(upper - lower)
        if (asymmetry > bodySize * FRACTION_MAX_ASYMMETRY_EM) continue
        // A body-sized pair is only a fraction when its parts are still short
        // mathematical tokens; the baseline check above has already ruled out the
        // stacked table cells that share the fraction's x-range.
        if (!isPart({ y: rows[i].y, runs: numRuns }, true) || !isPart({ y: rows[j].y, runs: denRuns }, true))
          continue
        tokens.push({
          x: fracX,
          xEnd: fracXEnd,
          y: base.y,
          size: bodySize,
          text: `${fractionPart(numRuns)}/${fractionPart(denRuns)}`,
        })
        for (const r of numRuns) consumed.add(r)
        for (const r of denRuns) consumed.add(r)
        break
      }
    }
  }

  // ── Display fractions ─────────────────────────────────────────────────────
  // A fraction whose numerator is a whole phrase is set over several lines and
  // framed by a stretchy delimiter — `\left\{ … \right\}`, or a long radical —
  // drawn as stacked glyph pieces, with the denominator on the line below the
  // baseline.  The single-row search above cannot see it: the parts are
  // body-sized, the numerator is prose, and the parts sit more than an em
  // apart.  The delimiter frame identifies it, and only a formula draws one, so
  // it is recognised from the frame outwards and the numerator's lines are
  // joined top to bottom:
  //
  //   Amount of cash payout × (5 − Number of complete years …)/5
  //
  // The pieces of a stretchy delimiter carry no text of their own; they are
  // dropped along with the rest of the frame.
  const isDelimRun = isDelimiterPiece
  /**
   * The bracket a stretchy-delimiter piece stands for.  A `\left( … \right)`
   * that frames an expression rather than a stacked fraction is drawn as
   * stacked pieces (top hook, extension, bottom hook); every piece of one side
   * collapses to that side's single bracket character.  Radicals are not
   * brackets and are left out, so a radical-only frame is ignored.
   */
  const bracketOfPiece: Record<string, string> = {
    "\u239b": "(", "\u239c": "(", "\u239d": "(",
    "\u239e": ")", "\u239f": ")", "\u23a0": ")",
    "\u23a1": "[", "\u23a2": "[", "\u23a3": "[",
    "\u23a4": "]", "\u23a5": "]", "\u23a6": "]",
    "\u23a7": "{", "\u23a8": "{", "\u23a9": "{",
    "\u23ab": "}", "\u23ac": "}", "\u23ad": "}",
    "\u23aa": "|",
  }
  // A frame's pieces carry the bracket family but not reliably which side they
  // open from: some generators draw both sides with the same (right) glyph.  The
  // left bracket is forced to the family's opener and the right to its closer.
  const OPEN_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" }
  const CLOSE_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
  const carriesText = (v: { runs: TextRun[] }): boolean =>
    v.runs.some((r) => r.text.trim() !== "" && !isDelimRun(r))
  const stackText = (vrows: { y: number; runs: TextRun[] }[]): string =>
    vrows
      .slice()
      .sort((a, b) => b.y - a.y)
      .map((v) => runText(v.runs))
      .filter(Boolean)
      .join(" ")
  const wrapPart = (t: string): string =>
    /^\(.*\)$/.test(t) ? t : FRACTION_COMPOUND_RE.test(t) ? `(${t})` : t

  for (const frame of rows) {
    if (frame.runs.some((r) => consumed.has(r))) continue
    const pieces = frame.runs.filter(isDelimRun)
    if (pieces.length < 2) continue
    const bandX = Math.min(...pieces.map((r) => r.x))
    const bandXEnd = Math.max(...pieces.map((r) => r.xEnd))
    if (bandXEnd - bandX < bodySize * 2) continue
    // A row is inside the frame when its extent lies within the delimiter band.
    const inside = (v: { runs: TextRun[] }): boolean => {
      const e = runExtent(v.runs)
      return (
        e !== null && e.x >= bandX - bodySize * 0.5 && e.xEnd <= bandXEnd + bodySize * 0.5
      )
    }
    // Only the rows level with the frame can belong to the fraction.
    const near = rows.filter(
      (v) =>
        !v.runs.some((r) => consumed.has(r)) &&
        v.y <= frame.y + bodySize * 4 &&
        v.y >= frame.y - bodySize * 4,
    )
    // The baseline is the body-text row beside the band — the text the fraction
    // multiplies — not a row inside it.  Prefer a row whose text abuts the band
    // horizontally, so a nearby prose row set further to the left is not taken
    // for the baseline; fall back to the nearest row when nothing abuts it.
    let baseline: { y: number; runs: TextRun[] } | undefined
    let beside: { y: number; runs: TextRun[] } | undefined
    for (const v of near) {
      if (inside(v)) continue
      if (!v.runs.some((r) => r.size > maxPartSize && r.text.trim() !== "")) continue
      const closer = (cur: { y: number } | undefined): boolean =>
        cur === undefined || Math.abs(v.y - frame.y) < Math.abs(cur.y - frame.y)
      const abuts = v.runs.some((r) => {
        if (r.text.trim() === "" || isDelimRun(r)) return false
        return (
          (r.xEnd <= bandX && bandX - r.xEnd <= bodySize) ||
          (r.x >= bandXEnd && r.x - bandXEnd <= bodySize)
        )
      })
      if (abuts && closer(beside)) beside = v
      if (closer(baseline)) baseline = v
    }
    if (beside !== undefined) baseline = beside
    if (baseline === undefined) continue
    const inner = near.filter((v) => inside(v) && carriesText(v))
    const num = inner.filter((v) => v.y > baseline.y)
    const den = inner.filter((v) => v.y < baseline.y)
    // A fraction has exactly one denominator; a further row below the baseline
    // inside the band is the next paragraph, not part of the fraction.
    if (num.length === 0 || den.length !== 1) continue
    const numText = stackText(num)
    const denText = stackText(den)
    if (numText === "" || denText === "") continue
    // The operand the fraction multiplies may itself be wrapped over two lines
    // with the operator set between them — `Amount of` / `×` / `cash payout`.
    // Gather the rows that sit to the left of the band beside the baseline,
    // join them, and splice the result before the operator so the line reads
    // `Amount of cash payout × (…)/5`.
    const operands = rows
      .filter((v) => {
        if (v === baseline || v.runs.some((r) => consumed.has(r))) return false
        if (inside(v) || !carriesText(v)) return false
        if (Math.abs(v.y - baseline.y) > bodySize * 1.5) return false
        const e = runExtent(v.runs)
        return e !== null && e.xEnd <= bandX
      })
      .sort((a, b) => b.y - a.y)
    if (operands.length > 0) {
      const ex = runExtent(operands.flatMap((v) => v.runs))
      const text = operands.map((v) => runText(v.runs)).filter(Boolean).join(" ")
      if (ex !== null && text !== "") {
        tokens.push({
          x: ex.x,
          xEnd: ex.xEnd,
          y: baseline.y,
          size: bodySize,
          text: `${text} `,
        })
        for (const v of operands) for (const r of v.runs) consumed.add(r)
      }
    }
    // The token takes the fraction's own extent, not the delimiter band: the
    // band is wider than the parts, so it would place the token before the
    // operator that precedes the fraction (`= 1 − X/100`).
    const parts = [...num, ...den].flatMap((v) => v.runs)
    const span = runExtent(parts)
    if (span === null) continue
    suffixed.push({
      x: span.x,
      xEnd: span.xEnd,
      y: baseline.y,
      size: bodySize,
      text: ` ${wrapPart(numText)}/${wrapPart(denText)} `,
    })
    for (const v of near) {
      if (v === baseline) continue
      if (v !== frame && !inside(v)) continue
      for (const r of v.runs) consumed.add(r)
    }
  }

  // ── Unframed display fractions ────────────────────────────────────────────
  // A phrase-long numerator can be set over a single denominator beside a lone
  // operator rather than a delimiter frame — the shape of the hire-purchase
  // formula in the Income Tax Act:
  //
  //   Cash payout
  //   computed in
  //   accordance with
  //   subsection (4E)(b)   ×   Number of complete years the
  //                            intellectual property rights were
  //                            held by the qualifying person
  //                            5
  //
  // The operator row is the baseline: the row carries nothing but the operator
  // and the fraction sits to its right.  The numerator is the run of rows above
  // the baseline that are centred on the denominator; the denominator is the
  // single short mathematical row below.  The single-row search cannot see this
  // shape (the numerator is prose and spans several rows) and the delimiter
  // search cannot either (there is no frame).
  const OPERATOR_RE = /^[×÷]$/
  for (const base of rows) {
    const baseRuns = base.runs.filter((r) => !consumed.has(r) && r.text.trim() !== "")
    // The row must be nothing but the operator.  A lone operator marks a
    // display formula (the operand is on its own lines beside the fraction);
    // an operator embedded in an expression (`4% × U/V × W`) is not one.
    if (baseRuns.length !== 1 || !OPERATOR_RE.test(baseRuns[0].text.trim())) continue
    const op = baseRuns[0]
    // The fraction's rows lie to the right of the operator.
    const rightOfOp = (v: { runs: TextRun[] }): TextRun[] =>
      v.runs.filter((r) => !consumed.has(r) && (r.x + r.xEnd) / 2 >= op.xEnd)
    for (const den of rows) {
      if (den.y >= base.y - 0.5) continue
      if (base.y - den.y > bodySize * 2) break
      const denRuns = rightOfOp(den)
      if (denRuns.length === 0) continue
      if (!isPart({ y: den.y, runs: denRuns }, true)) continue
      const denExt = runExtent(denRuns)
      if (denExt === null) continue
      const denCentre = (denExt.x + denExt.xEnd) / 2
      // Numerator rows: the rows above the baseline that are centred on the
      // denominator, read top to bottom.
      const numRows: { y: number; runs: TextRun[]; ext: { x: number; xEnd: number } }[] = []
      for (const num of rows) {
        if (num.y <= base.y) continue
        const numRuns = rightOfOp(num)
        if (numRuns.length === 0) continue
        const ext = runExtent(numRuns)
        if (ext === null) continue
        if (Math.abs((ext.x + ext.xEnd) / 2 - denCentre) > bodySize * FRACTION_MAX_CENTRE_EM) continue
        numRows.push({ y: num.y, runs: numRuns, ext })
      }
      numRows.sort((a, b) => b.y - a.y)
      // The numerator is the run of rows sitting immediately above the
      // baseline; a gap ends it.  Two rows at least — a single-row numerator
      // is the single-row pass's job.
      const stack: typeof numRows = []
      for (let k = numRows.length - 1; k >= 0; k--) {
        if (stack.length > 0 && stack[0].y - numRows[k].y > bodySize * 1.7) break
        stack.unshift(numRows[k])
      }
      if (stack.length < 2) continue
      if (base.y - stack[stack.length - 1].y > bodySize * 1.7) continue
      const fracX = Math.min(denExt.x, ...stack.map((n) => n.ext.x))
      const fracXEnd = Math.max(denExt.xEnd, ...stack.map((n) => n.ext.xEnd))
      // No baseline run may sit under the fraction; the operator is beside it.
      if (
        baseRuns.some(
          (r) =>
            Math.min(r.xEnd, fracXEnd) - Math.max(r.x, fracX) >
            bodySize * FRACTION_MAX_BASELINE_OVERLAP_EM,
        )
      ) {
        continue
      }
      const numText = stack.map((n) => runText(n.runs)).filter(Boolean).join(" ")
      const denText = runText(denRuns)
      if (numText === "" || denText === "") continue
      // The numerator is prose (the phrase the fraction is named by) and the
      // denominator a simple token.  A numerator carrying its own operator is
      // a fragment of a larger expression, not the display fraction this pass
      // targets — the single-row and framed passes handle those.
      if (FRACTION_COMPOUND_RE.test(numText)) continue
      if (numText.split(/\s+/).filter(Boolean).length < 3) continue
      if (denText.length > 4 || !/^[A-Za-z0-9]+$/.test(denText)) continue
      suffixed.push({
        x: fracX,
        xEnd: fracXEnd,
        y: base.y,
        size: bodySize,
        text: ` ${wrapPart(numText)}/${wrapPart(denText)} `,
      })
      for (const n of stack) for (const r of n.runs) consumed.add(r)
      for (const r of denRuns) consumed.add(r)
      preserveOrder = true
      break
    }
  }

  // ── Stretchy delimiter frames around an expression ────────────────────────
  // A `\left( … \right)` that frames an expression rather than a stacked
  // fraction — `A + (A/B × 150% × C × D)` — is drawn as math-font pieces on a
  // row of its own.  The passes above leave it untouched (there is no stacked
  // fraction to recognise), so each frame is collapsed to its two brackets and
  // spliced onto the body-text row it encloses.
  const framePieces = rows.flatMap((v) =>
    v.runs.filter(
      (r) =>
        !consumed.has(r) &&
        ((isDelimRun(r) && !isRadicalPiece(r)) ||
          // A frame's opposite side is sometimes a literal bracket rather than
          // a stretchy piece — `⎠ … ]`.
          isLiteralBracketRun(r)),
    ),
  )
  if (framePieces.length >= 2) {
    // The pieces of one frame sit within a few lines of each other; different
    // formulas on the page are set further apart.
    const groups: TextRun[][] = []
    for (const r of framePieces) {
      const g = groups.find((fr) => fr.some((o) => Math.abs(o.y - r.y) <= bodySize * 8))
      if (g) g.push(r)
      else groups.push([r])
    }
    for (const group of groups) {
      // At least one stretchy piece is needed; two literal brackets alone are
      // an ordinary bracketed expression.
      if (!group.some((r) => isDelimRun(r))) continue
      const bandX = Math.min(...group.map((r) => r.x))
      const bandXEnd = Math.max(...group.map((r) => r.xEnd))
      if (bandXEnd - bandX < bodySize * 2) continue
      const mid = (bandX + bandXEnd) / 2
      const left = group.filter((r) => (r.x + r.xEnd) / 2 < mid)
      const right = group.filter((r) => (r.x + r.xEnd) / 2 >= mid)
      const literal = (r: TextRun): string | undefined => {
        const t = r.text.trim()
        return /^[()[\]{}]$/.test(t) ? t : undefined
      }
      const leftRaw = left.map((r) => bracketOfPiece[r.text.trim()] ?? literal(r)).find(Boolean)
      const rightRaw = right.map((r) => bracketOfPiece[r.text.trim()] ?? literal(r)).find(Boolean)
      if (leftRaw === undefined || rightRaw === undefined) continue
      // A literal bracket fixes the family for both sides — a right-parenthesis
      // piece standing in for the left of `[…]` must read `[`.
      const litSide = [...left, ...right].map(literal).find(Boolean)
      const leftCh =
        litSide !== undefined ? OPEN_OF[litSide] ?? litSide : OPEN_OF[leftRaw] ?? leftRaw
      const rightCh =
        litSide !== undefined ? CLOSE_OF[litSide] ?? litSide : CLOSE_OF[rightRaw] ?? rightRaw
      // The baseline is the nearest body-text row the frame encloses.  The
      // bracket pieces sit above the formula's baseline (the extractor anchors
      // a `\left[…]` at the top of the bracket), so a row below the frame is
      // preferred over a prose row just above it.
      const frameY = group.reduce((s, r) => s + r.y, 0) / group.length
      const frameTop = Math.max(...group.map((r) => r.y))
      const frameBottom = Math.min(...group.map((r) => r.y))
      const spansText = frameTop - frameBottom > bodySize * 1.5
      let baseY: number
      let baseYEnd: number
      if (spansText) {
        // A frame several lines tall encloses a wrapped phrase; its brackets
        // belong on the phrase's first and last lines rather than collapsed
        // onto one.
        const inside = rows.filter((v) => {
          if (v.runs.some((r) => consumed.has(r))) return false
          const e = runExtent(v.runs)
          if (e === null) return false
          if (!v.runs.some((r) => r.text.trim() !== "" && !isDelimRun(r))) return false
          // The phrase may overflow the drawn delimiter, so the row only needs
          // to sit inside the frame's columns and near it vertically.
          return (
            e.x >= bandX - bodySize * 0.5 &&
            e.xEnd <= bandXEnd + bodySize * 0.5 &&
            v.y <= frameTop + bodySize &&
            v.y >= frameBottom - bodySize * 10
          )
        })
        if (inside.length === 0) continue
        baseY = Math.max(...inside.map((v) => v.y))
        baseYEnd = Math.min(...inside.map((v) => v.y))
      } else {
        let baseline: { y: number; runs: TextRun[] } | undefined
        let below: { y: number; runs: TextRun[] } | undefined
        for (const v of rows) {
          if (v.runs.some((r) => consumed.has(r))) continue
          const e = runExtent(v.runs)
          if (e === null) continue
          if (!v.runs.some((r) => r.size > maxPartSize && r.text.trim() !== "" && !isDelimRun(r)))
            continue
          if (e.xEnd < bandX - bodySize || e.x > bandXEnd + bodySize) continue
          if (baseline === undefined || Math.abs(v.y - frameY) < Math.abs(baseline.y - frameY))
            baseline = v
          if (
            v.y < frameY &&
            (below === undefined || Math.abs(v.y - frameY) < Math.abs(below.y - frameY))
          )
            below = v
        }
        if (below !== undefined) baseline = below
        if (baseline === undefined) continue
        baseY = baseline.y
        baseYEnd = baseline.y
      }
      // A superscript sits just right of the closing bracket, above the
      // baseline — the exponent of `[ … ]^{1/4}`.  A stacked pair is a small
      // fraction.
      const sup = rows
        .flatMap((v) => v.runs.map((r) => ({ r, y: v.y })))
        .filter(
          ({ r, y }) =>
            !consumed.has(r) &&
            r.text.trim() !== "" &&
            !isDelimRun(r) &&
            r.size < maxPartSize &&
            r.x >= bandXEnd - bodySize &&
            y > baseY &&
            y <= frameY + bodySize,
        )
        .sort((a, b) => b.y - a.y)
      let supText = ""
      if (sup.length === 1) supText = runText([sup[0].r])
      else if (sup.length >= 2) {
        const stacked = Math.abs(sup[0].r.x - sup[1].r.x) <= bodySize * 0.1
        supText = stacked
          ? `${runText([sup[0].r])}/${runText([sup[1].r])}`
          : sup.map((s) => runText([s.r])).join(" ")
      }
      tokens.push(
        {
          x: Math.min(...left.map((r) => r.x)),
          xEnd: Math.max(...left.map((r) => r.xEnd)),
          y: baseY,
          size: bodySize,
          text: leftCh,
        },
        {
          x: Math.min(...right.map((r) => r.x)),
          xEnd: Math.max(...right.map((r) => r.xEnd)),
          y: baseYEnd,
          size: bodySize,
          text: rightCh + (supText === "" ? "" : `^${supText}`),
        },
      )
      for (const r of group) consumed.add(r)
      for (const s of sup) consumed.add(s.r)
    }
  }

  // ── Stretchy radicals (√) around an expression ────────────────────────────
  // A `\sqrt{…}` is drawn as a single root glyph at the left of a long overbar
  // built from repeated radical pieces; the radicand is the body-text row just
  // below.  The pieces carry no meaning of their own, so the frame is collapsed
  // to `√(…)` on the radicand's line.  A lone radical glyph is a real
  // square-root sign (`10√n`), not a frame, and is left alone.
  const radicalPieces = rows.flatMap((v) =>
    v.runs.filter((r) => !consumed.has(r) && isRadicalPiece(r)),
  )
  const radicalGroups: TextRun[][] = []
  for (const r of radicalPieces.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
    const g = radicalGroups.find((cl) => {
      if (Math.abs(cl[0].y - r.y) > bodySize) return false
      const lo = Math.min(...cl.map((o) => o.x))
      const hi = Math.max(...cl.map((o) => o.xEnd))
      return r.x <= hi + bodySize * 1.5 && r.xEnd >= lo - bodySize * 1.5
    })
    if (g) g.push(r)
    else radicalGroups.push([r])
  }
  for (const group of radicalGroups) {
    // A drawn radical is an overbar of several pieces; a lone glyph is a real
    // square-root sign.
    const chars = group.reduce((s, r) => s + r.text.trim().length, 0)
    if (group.length < 2 && chars < 2) continue
    const sorted = group.slice().sort((a, b) => a.x - b.x)
    const radX = sorted[0].x
    const radXEnd = Math.max(...group.map((r) => r.xEnd))
    if (radXEnd - radX < bodySize * 0.5) continue
    // A radical drawn at a fraction of the body size is a degenerate overlay
    // (a hidden duplicate line); drop it rather than rebuild it.
    if (Math.max(...group.map((r) => r.size)) < bodySize * 0.25) {
      for (const r of group) consumed.add(r)
      continue
    }
    const rootY = Math.max(...group.map((r) => r.y))
    const rootCh = sorted[0].text.trim()[0]
    // The radicand is the body-text row just below the overbar that the radical
    // spans.
    let row: { y: number; runs: TextRun[] } | undefined
    for (const v of rows) {
      if (v.runs.every((r) => consumed.has(r))) continue
      if (v.y >= rootY) continue
      if (rootY - v.y > bodySize * 4) continue
      const live = v.runs.filter((r) => !consumed.has(r) && !isRadicalPiece(r))
      if (!live.some((r) => r.size > maxPartSize && r.text.trim() !== "")) continue
      const e = runExtent(live)
      if (e === null) continue
      if (e.xEnd < radX - bodySize || e.x > radXEnd + bodySize) continue
      if (row === undefined || v.y > row.y) row = v
    }
    if (row === undefined) continue
    // A superscript or subscript is drawn on its own row just above or below
    // the radicand's baseline — `D² + E²` splits into `D` on the baseline and
    // `2 + E 2` on the row above.  Move every run the radical spans onto the
    // baseline, marking the small runs so the exponent reads `D^2`.
    for (const v of rows) {
      if (v === row) continue
      if (Math.abs(v.y - row.y) > bodySize * 1.2) continue
      for (const r of v.runs) {
        if (consumed.has(r) || isRadicalPiece(r) || r.text.trim() === "") continue
        const cx = (r.x + r.xEnd) / 2
        if (cx < radX - bodySize * 0.5 || cx > radXEnd + bodySize * 0.3) continue
        const mark = r.size < bodySize * 0.85 ? (v.y > row.y ? "^" : "_") : ""
        tokens.push({
          x: r.x,
          xEnd: r.xEnd,
          y: row.y,
          size: bodySize,
          text: mark + r.text.trim(),
        })
        consumed.add(r)
      }
    }
    tokens.push(
      { x: radX, xEnd: sorted[0].xEnd, y: row.y, size: bodySize, text: `${rootCh}(` },
      {
        x: radXEnd,
        xEnd: radXEnd,
        y: row.y,
        size: bodySize,
        text: ")",
      },
    )
    for (const r of group) consumed.add(r)
  }

  if (consumed.size === 0) return lines

  // Rebuild the lines from the surviving runs, grouped by y, so a fraction
  // token lands on the same line as the baseline text it belongs to even when
  // the extractor had folded that text onto the denominator's line.
  //
  // Each run's original line is remembered so the rebuilt lines keep the
  // extractor's reading order.  A display formula sets a wrapped operand beside
  // a fraction, so sorting the rebuilt lines by y would interleave the operand
  // with the fraction; the extractor's order is the reading order.
  const lineOrder = new Map<TextRun, number>()
  for (let i = 0; i < lines.length; i++) for (const r of lines[i].runs) lineOrder.set(r, i)
  const out: Array<TextLine & { order: number }> = []
  const touched = new Set<TextLine>()
  // The rebuilt line each original line has already produced.  A subscript is
  // sometimes extracted on its own row a fraction of a line below its symbol;
  // keeping the original line's runs together stops the rebuild splitting them.
  const lineOf = new Map<number, TextLine & { order: number }>()
  const add = (r: TextRun, token: boolean): void => {
    const o = lineOrder.get(r)
    let line = o !== undefined ? lineOf.get(o) : undefined
    if (!line) line = out.find((l) => Math.abs(l.y - r.y) <= 0.5)
    if (!line) { line = { y: r.y, runs: [], order: Infinity }; out.push(line) }
    if (o !== undefined && !lineOf.has(o)) lineOf.set(o, line)
    line.runs.push(r)
    if (o !== undefined && o < line.order) line.order = o
    if (token) touched.add(line)
  }
  for (const l of lines) for (const r of l.runs) if (!consumed.has(r)) add(r, false)
  for (const t of tokens) add(t, true)
  // A display token goes where the fraction sits on the line, so the text that
  // follows the fraction (`Reference line value`) stays after it.  The line is
  // not marked `xOrdered`: its own runs already carry the extractor's spacing,
  // and re-spacing them from the geometry would drop the word space in
  // `Amount of cash payout`.
  for (const t of suffixed) {
    const line = out.find((l) => Math.abs(l.y - t.y) <= 0.5)
    if (!line) continue
    let i = 0
    while (i < line.runs.length && line.runs[i].x <= t.x) i++
    line.runs.splice(i, 0, t)
  }
  // A line that received a token is re-sorted by x: the token's position is
  // known exactly, and the extractor's append order no longer holds once the
  // denominator has been lifted out of the middle of the line.  Its spacing is
  // then recomputed from the geometry (see `xOrdered`).
  for (const l of touched) {
    l.runs.sort((a, b) => a.x - b.x)
    l.xOrdered = true
  }
  if (preserveOrder) out.sort((a, b) => a.order - b.order)
  else out.sort((a, b) => b.y - a.y)
  return out
}

/** Plain-text render of a stream's lines. */
export function renderPlainText(lines: TextLine[]): string {
  return linearizeFractions(lines).map(renderPlainLine).join("\n")
}

/** Median of a numeric list (0 when empty). */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/** The `p`-th percentile (0–100) of a numeric list. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

/** Collapse a cell's internal whitespace. */
function cleanCell(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** A lone full stop — the centred separator artefact some header rows carry. */
function isLoneDot(text: string): boolean {
  return text.trim() === "."
}

/** Whether a first-column cell opens a new logical row. */
function isRowStart(text: string): boolean {
  return /^[A-Z0-9([]/.test(text)
}

/**
 * Whether a visual row is a numbered item heading (`2. 2008 Revised Edition —
 * Accounting Standards Act (Chapter 2B)`).  The Legislative History lists each
 * amendment as such a heading followed by `label : value` rows; the heading is
 * not part of that table and must not be folded into it.
 */
function isItemHeading(text: string): boolean {
  return /^\d+[A-Za-z]?\.\s+\S.*\s[—–]\s+\S/.test(text)
}

/**
 * Whether a logical row reads as a table header.
 *
 * A header names its columns (`First column`, `Second column`) or is a row of
 * label cells.  A data row carries a value — a number, a reading date, a
 * colon-prefixed reference — in one of its cells, or opens with a list marker,
 * so it is not a header.  The distinction matters at a block's first row: a
 * block with no header (a page-break continuation, or a run of
 * legislative-history rows that opens `Bill | : G.N. No. …`) must be given an
 * empty header rather than have its first data row promoted to one.
 */
function isHeaderRow(row: string[]): boolean {
  const first = (row[0] ?? "").trim()
  if (/^\(?[0-9ivxlcdm]+[.)]/.test(first)) return false
  if (/column/i.test(row.join(" "))) return true
  let cells = 0
  for (const c of row) {
    const t = (c ?? "").trim()
    if (!t) continue
    cells++
    if (/[0-9:;]/.test(t)) return false
  }
  return cells >= 2
}

interface Cell {
  x: number
  xEnd: number
  text: string
}

interface VRow {
  y: number
  /** Source line indices that contributed runs to this visual row. */
  src: number[]
  runs: TextRun[]
}

/**
 * Re-anchor runs whose x is stale because they were drawn without a `Td`.
 *
 * After a show operation the PDF text matrix advances by the run's width, but
 * the extractor only advances its pen on `Td`/`Tm` (see `appendText`).  A run
 * that follows another with no repositioning therefore keeps the previous
 * run's x, and the two overlap.  The later run's `xEnd` is its own width past
 * that stale x, so the group's right edge is underestimated and the gap to the
 * next run is inflated — enough, on a justified line, to pass the table
 * threshold and turn prose into a two-cell row.  Anchoring each overlapping run
 * at the previous run's end restores the true extent.
 *
 * Only runs that actually overlap are moved, so a real column gutter (runs
 * separated by whitespace) is never bridged.  The repair is applied when
 * deciding whether a row is tabular (`splitCells`); the column geometry is left
 * on the extractor's own extents, where a genuine gutter is measured against
 * the block as a whole and a small marker-to-body gap must stay visible.
 */
function repairExtents(runs: TextRun[]): TextRun[] {
  let end = -Infinity
  let changed = false
  const out = runs.map((r) => {
    if (r.x < end - 0.01) {
      changed = true
      const fixed = { ...r, x: end, xEnd: end + Math.max(0, r.xEnd - r.x) }
      end = fixed.xEnd
      return fixed
    }
    if (r.xEnd > end) end = r.xEnd
    return r
  })
  return changed ? out : runs
}

/** Split a visual row's runs into cells at gutters of at least `gap`. */
function splitCells(runs: TextRun[], gap: number): Cell[] {
  const cells: Cell[] = []
  let cur: Cell | null = null
  for (const r of repairExtents(runs)) {
    if (cur && r.x - cur.xEnd >= gap) {
      cells.push(cur)
      cur = null
    }
    if (!cur) cur = { x: r.x, xEnd: r.xEnd, text: r.text }
    else {
      cur.text += r.text
      if (r.xEnd > cur.xEnd) cur.xEnd = r.xEnd
    }
  }
  if (cur) cells.push(cur)
  return cells
}

/**
 * Find the column bands of a block: project every run onto the x-axis and take
 * the maximal empty intervals at least `gap` wide as gutters.  What remains is
 * the columns, in left-to-right order.
 *
 * A hanging list marker (`(a)`, `(b)`, `(i)`) is indented from the cell body it
 * labels, which leaves a slim gutter on either side and makes the marker look
 * like a column of its own.  Any resulting band narrower than `minWidth` is
 * therefore folded into the next band (the body it belongs to).
 */
function detectColumns(runs: TextRun[], gap: number, minWidth: number): Array<[number, number]> {
  if (runs.length === 0) return []
  let minX = Infinity
  let maxX = -Infinity
  for (const r of runs) {
    if (r.x < minX) minX = r.x
    if (r.xEnd > maxX) maxX = r.xEnd
  }
  if (!(maxX > minX)) return []
  const step = Math.max(gap / 6, 0.5)
  const n = Math.max(1, Math.ceil((maxX - minX) / step))
  const covered = new Uint8Array(n + 1)
  for (const r of runs) {
    const a = Math.max(0, Math.floor((r.x - minX) / step))
    const b = Math.min(n, Math.ceil((r.xEnd - minX) / step))
    for (let k = a; k <= b; k++) covered[k] = 1
  }
  const gutters: Array<[number, number]> = []
  let start = -1
  for (let k = 0; k <= n; k++) {
    if (!covered[k]) {
      if (start === -1) start = k
      continue
    }
    if (start !== -1) {
      if ((k - start) * step >= gap) gutters.push([minX + start * step, minX + k * step])
      start = -1
    }
  }
  if (start !== -1 && (n - start) * step >= gap) {
    gutters.push([minX + start * step, minX + n * step])
  }
  const cols: Array<[number, number]> = []
  let cur = minX
  for (const [gs, ge] of gutters) {
    if (gs - cur > step) cols.push([cur, gs])
    cur = ge
  }
  if (maxX - cur > step) cols.push([cur, maxX])
  return mergeNarrowColumns(cols, minWidth)
}

/**
 * Fold any band narrower than `minWidth` into the next band (or, for a trailing
 * narrow band, the previous one).  See `detectColumns` for why.
 */
function mergeNarrowColumns(cols: Array<[number, number]>, minWidth: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i]
    if (c[1] - c[0] >= minWidth) { out.push(c); continue }
    if (i + 1 < cols.length) {
      cols[i + 1] = [c[0], cols[i + 1][1]]
      continue
    }
    if (out.length > 0) {
      out[out.length - 1] = [out[out.length - 1][0], c[1]]
      continue
    }
    out.push(c)
  }
  return out
}

/**
 * Column separators implied by a header row's cell gaps.  A header names its
 * columns (`First column`, `Second column`, …), so its gaps can supply a
 * boundary that a wide data cell has closed at block level.
 */
function headerSeparators(vrows: VRow[], gapRow: number): number[] {
  for (const v of vrows) {
    const text = v.runs.map((r) => r.text).join("")
    if (!/column/i.test(text)) continue
    const cells = splitCells(v.runs, gapRow).filter((c) => !isLoneDot(c.text))
    if (cells.length < 2) continue
    const seps: number[] = []
    for (let i = 1; i < cells.length; i++) {
      seps.push((cells[i - 1].xEnd + cells[i].x) / 2)
    }
    return seps
  }
  return []
}

/** Partition [minX, maxX] at the given separators. */
function columnsFromSeparators(
  seps: number[],
  minX: number,
  maxX: number,
): Array<[number, number]> {
  const inner = seps.slice().sort((a, b) => a - b).filter((s) => s > minX && s < maxX)
  const cols: Array<[number, number]> = []
  let cur = minX
  for (const s of inner) {
    cols.push([cur, s])
    cur = s
  }
  cols.push([cur, maxX])
  return cols
}

/**
 * Column separators implied by the rows' own cell splits.  A column boundary
 * that one row's overflowing cell closes is still a boundary, so every row's
 * cell gap votes for it.  The separator is placed in the gap just left of the
 * right column's first run, so the overflowing cell stays in the left column.
 */
function cellGapSeparators(
  vrows: VRow[],
  gapRow: number,
  minX: number,
  maxX: number,
): number[] {
  const intervals: Array<[number, number]> = []
  for (const v of vrows) {
    const cells = splitCells(v.runs, gapRow)
    for (let c = 1; c < cells.length; c++) intervals.push([cells[c - 1].xEnd, cells[c].x])
  }
  if (intervals.length === 0) return []
  intervals.sort((a, b) => a[0] - b[0])
  // Gaps that overlap describe the same boundary; intersect them so the
  // boundary sits in the part of the gap every row agrees on.
  const groups: Array<{ left: number; right: number; n: number }> = []
  for (const [l, r] of intervals) {
    const g = groups[groups.length - 1]
    if (g && l <= g.right) {
      g.left = Math.max(g.left, l)
      g.right = Math.min(g.right, r)
      g.n++
    } else groups.push({ left: l, right: r, n: 1 })
  }
  const seps: number[] = []
  let cur = minX
  for (const g of groups) {
    // A boundary the rows agree on and that is wide enough to be a real gutter
    // between columns; a narrow sliver is just the word spacing inside a cell.
    if (g.n < 2 || g.right - g.left < gapRow * 0.5) continue
    // The left column's extent: every run centred left of the boundary.  A run
    // that merely starts a hair before the right column's first run still
    // belongs to the right column, so membership is by centre, not by start.
    let leftEnd = cur
    for (const v of vrows) {
      for (const r of v.runs) {
        if ((r.x + r.xEnd) / 2 < g.right && r.xEnd > leftEnd) leftEnd = r.xEnd
      }
    }
    const sep = (leftEnd + g.right) / 2
    if (sep > cur && sep < maxX) {
      seps.push(sep)
      cur = sep
    }
  }
  return seps
}

/**
 * Index of the column containing a run (nearest column if it straddles).
 */
function columnOf(cols: Array<[number, number]>, r: TextRun): number {
  const c = (r.x + r.xEnd) / 2
  for (let i = 0; i < cols.length; i++) {
    if (c >= cols[i][0] && c <= cols[i][1]) return i
  }
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < cols.length; i++) {
    const d = Math.min(Math.abs(c - cols[i][0]), Math.abs(c - cols[i][1]))
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best
}

/**
 * Group the block's visual rows into logical rows, folding wrapped cell text
 * into the row above.  A visual row opens a new logical row when its first
 * column holds text that starts a row (`(i)`, `14`, `First column`) or when it
 * is a single cell that spans into the next column (a group heading); otherwise
 * it continues the previous row.
 */
function buildRows(vrows: VRow[], cols: Array<[number, number]>, gapRow: number): string[][] {
  const rows: string[][] = []
  for (const v of vrows) {
    const text = cols.map(() => "")
    const x1 = cols.map(() => -Infinity)
    for (let ri = 0; ri < v.runs.length; ri++) {
      const r = v.runs[ri]
      // A lone `.` centred between two header cells is a separator artefact,
      // not content.  Require a cell on each side, and only on the header row,
      // so leader dots and leading markers in data rows are preserved.
      if (rows.length === 0 && isLoneDot(r.text) && ri > 0 && ri + 1 < v.runs.length) {
        const prevEnd = v.runs[ri - 1].xEnd
        const nextX = v.runs[ri + 1].x
        if (r.x - prevEnd >= gapRow && nextX - r.xEnd >= gapRow) continue
      }
      const ci = columnOf(cols, r)
      text[ci] += r.text
      if (r.xEnd > x1[ci]) x1[ci] = r.xEnd
    }
    const cells = text.map(cleanCell)
    const nonEmpty = cells.map((c, i) => (c ? i : -1)).filter((i) => i >= 0)
    let start: boolean
    if (rows.length === 0) start = true
    else if (nonEmpty.length === 1) {
      // A single cell starts a row when it reaches the next column (a group
      // heading) or opens with a row marker (`15. Loss of thumb —`).
      const ci = nonEmpty[0]
      const nextColStart = ci + 1 < cols.length ? cols[ci + 1][0] : Infinity
      start = x1[ci] >= nextColStart || (ci === 0 && isRowStart(cells[0]))
    } else start = cells[0] !== "" && isRowStart(cells[0])
    if (start) {
      rows.push(cells)
    } else {
      const prev = rows[rows.length - 1]
      for (let c = 0; c < cells.length; c++) {
        if (!cells[c]) continue
        prev[c] = prev[c] ? prev[c] + " " + cells[c] : cells[c]
      }
    }
  }
  return rows
}

/**
 * Drop columns whose only content is a lone `.` in the header row.  A centred
 * separator dot between two header cells otherwise shows up as a spurious
 * empty column.  A column that carries real values is kept even when some rows
 * use `.` as a nil/leader mark, so leader dots are never discarded.
 */
function pruneDotColumns(rows: string[][]): string[][] {
  if (rows.length === 0) return rows
  const ncols = rows[0].length
  const keep: boolean[] = []
  for (let c = 0; c < ncols; c++) {
    const headerDot = isLoneDot(rows[0][c] ?? "")
    let onlyDot = true
    for (const row of rows) {
      const v = (row[c] ?? "").trim()
      if (v === "" || isLoneDot(v)) continue
      onlyDot = false
      break
    }
    keep.push(!(onlyDot && headerDot))
  }
  if (keep.every(Boolean)) return rows
  return rows.map((row) => row.filter((_, c) => keep[c]))
}

/** Render logical rows as a GitHub pipe table. */
function renderMarkdown(rows: string[][], ncols: number, dataFirst: boolean): string {
  const esc = (s: string): string => s.replace(/\|/g, "\\|")
  const pad = (row: string[]): string[] => {
    const out = row.slice(0, ncols)
    while (out.length < ncols) out.push("")
    return out
  }
  const header = dataFirst ? Array.from({ length: ncols }, () => "") : pad(rows[0])
  const body = dataFirst ? rows : rows.slice(1)
  const lines: string[] = []
  lines.push("| " + header.map(esc).join(" | ") + " |")
  lines.push("| " + Array.from({ length: ncols }, () => "---").join(" | ") + " |")
  for (const row of body) lines.push("| " + pad(row).map(esc).join(" | ") + " |")
  return lines.join("\n")
}

/** Count true entries in `flags[i..j]`. */
function countTrue(flags: boolean[], i: number, j: number): number {
  let n = 0
  for (let k = i; k <= j; k++) if (flags[k]) n++
  return n
}

/**
 * Render a stream's structured lines, converting tabular blocks to pipe tables.
 * Non-table lines are rendered exactly as the plain extractor would.
 */
export function renderTables(input: TextLine[]): string {
  const withRuns = input.filter((l) => l.runs.length > 0)
  if (withRuns.length < 2) return renderPlainText(input)

  const sizes: number[] = []
  for (const l of withRuns) for (const r of l.runs) if (r.size > 0) sizes.push(r.size)
  const baseSize = median(sizes) || 10
  const yTol = Y_TOL_EM * baseSize
  const gapRow = GAP_ROW_EM * baseSize
  const gapCol = GAP_COL_EM * baseSize

  // ── Cluster lines into visual rows by device y ─────────────────────────
  const vrows: VRow[] = []
  for (let i = 0; i < input.length; i++) {
    const line = input[i]
    if (line.runs.length === 0) continue
    let vr: VRow | undefined
    for (const v of vrows) {
      if (Math.abs(v.y - line.y) <= yTol) { vr = v; break }
    }
    if (!vr) {
      vr = { y: line.y, src: [], runs: [] }
      vrows.push(vr)
    }
    for (const r of line.runs) vr.runs.push(r)
    vr.src.push(i)
  }
  if (vrows.length < MIN_ROWS) return renderPlainText(input)
  vrows.sort((a, b) => b.y - a.y)
  for (const v of vrows) v.runs.sort((a, b) => a.x - b.x)

  // ── Mark visual rows that belong to a table ────────────────────────────
  // Anchors are tabular rows (a run gap wide enough to be a column gutter).
  // Wrapped-cell continuations are 1-cell rows one line below an anchor; a
  // paragraph break (a larger vertical gap) ends the block, so prose is not
  // swallowed.  A block must start and end on a tabular row.
  const tabular = vrows.map((v) => splitCells(v.runs, gapRow).length >= MIN_COLS)
  const oneCell = vrows.map((v) => splitCells(v.runs, gapRow).length === 1)
  const colonRow = vrows.map((v) => v.runs.some((r) => r.text.trim() === ":"))
  const headingRow = vrows.map((v) => isItemHeading(cleanCell(v.runs.map((r) => r.text).join(""))))
  const steps: number[] = []
  for (let k = 1; k < vrows.length; k++) {
    const d = vrows[k - 1].y - vrows[k].y
    if (d > 0) steps.push(d)
  }
  // The line step is the low end of the gap distribution: table rows are
  // spaced like body lines, and a paragraph break is clearly larger.  Superscript
  // artefacts (tiny gaps) are filtered first.
  const bodySteps = steps.filter((d) => d >= 0.6 * baseSize)
  const lineStep = percentile(bodySteps.length > 0 ? bodySteps : steps, 15) || baseSize
  const lineLike = (a: number, b: number): boolean =>
    Math.abs(vrows[a].y - vrows[b].y) <= 1.6 * lineStep
  const rowText = (v: VRow): string => cleanCell(v.runs.map((r) => r.text).join(""))
  // Whether the nearest tabular row on either side of `k` is a `label : value`
  // row.  Continuation rows (a wrapped value, an `(Amendments made by …)` note)
  // may sit between a heading and the nearest label row, so the immediate
  // neighbours are skipped until a tabular row is found.
  const colonNear = (k: number): boolean => {
    for (let a = k - 1; a >= 0; a--) if (tabular[a]) return colonRow[a]
    for (let b = k + 1; b < vrows.length; b++) if (tabular[b]) return colonRow[b]
    return false
  }
  // A 1-cell row continues a table unless it is a prose paragraph that happens
  // to sit one line below it (e.g. `(b) In sections 18, ...`).
  const bridgeable = (k: number): boolean => {
    if (!oneCell[k]) return false
    // A numbered item heading (`2. 2008 Revised Edition — …`) opens a new entry
    // in a label:value list (the legislative history), so it ends the table
    // rather than continuing it.  Schedule group rows also start `N.` but sit
    // among data rows, not colon rows, so they are unaffected.
    if (headingRow[k] && colonNear(k)) return false
    // An all-caps heading set in a larger font than the table is a new
    // structural heading, not a group row inside the table — a Schedule that
    // opens on the page below its predecessor's last table row.
    if (closesTable(k)) return false
    const t = rowText(vrows[k])
    return !(/^\([a-z]\)/.test(t) && t.length > 40)
  }
  // A one-cell row that closes the table: all caps, and set in a larger font
  // than the nearest table row above it.
  const closesTable = (k: number): boolean => {
    const t = rowText(vrows[k])
    if (!/^[A-Z0-9][A-Z0-9 ()/,.'’&—–-]*$/.test(t)) return false
    const rowMax = Math.max(...vrows[k].runs.map((r) => r.size))
    for (let a = k - 1; a >= 0; a--) {
      if (!tabular[a]) continue
      const tabMax = Math.max(...vrows[a].runs.map((r) => r.size))
      return rowMax > tabMax * 1.1
    }
    return false
  }
  // A trailing wrapped line: lowercase, short, and one line below the table.
  const trailing = (k: number): boolean => {
    if (!oneCell[k]) return false
    const t = rowText(vrows[k])
    return /^[a-z]/.test(t) && t.length <= 40
  }

  const blocks: Array<{ from: number; to: number }> = []
  let i = 0
  while (i < vrows.length) {
    if (!tabular[i]) { i++; continue }
    if (headingRow[i] && colonNear(i)) { i++; continue }
    let last = i
    let j = i + 1
    let brokeAtHeading = false
    while (j < vrows.length && lineLike(j - 1, j)) {
      if (tabular[j]) { last = j; j++; continue }
      if (bridgeable(j)) { j++; continue }
      brokeAtHeading = headingRow[j]
      break
    }
    // Absorb trailing wrapped-cell lines.  When the block ends at a
    // Legislative History item heading, the rows already walked over between
    // the last table row and the heading are that row's wrapped continuations
    // (e.g. a second commencement date), so keep them in the block.
    let to = last
    if (brokeAtHeading) to = Math.max(to, j - 1)
    let k = to + 1
    while (k < vrows.length && trailing(k) && lineLike(k - 1, k)) { to = k; k++ }
    if (countTrue(tabular, i, last) >= MIN_ROWS) blocks.push({ from: i, to })
    i = to + 1
  }
  if (blocks.length === 0) return renderPlainText(input)

  // ── Work out which blocks actually render as tables ────────────────────
  // A block that fails the column or row checks is left as prose, so its runs
  // must stay eligible for the fraction pass.
  const rendered: Array<{ srcMin: number; srcMax: number; markdown: string; runs: TextRun[] }> = []
  for (const b of blocks) {
    const blockVrows = vrows.slice(b.from, b.to + 1)
    // A display formula is not a table.  Its stretchy-delimiter pieces sit at a
    // fixed x and look like column gutters, so the stacked numerator would be
    // swallowed as table cells; leave the block as prose so the fraction pass
    // can recognise and linearise it.
    if (blockVrows.some((v) => v.runs.some(isDelimiterPiece))) continue
    let srcMin = Infinity
    let srcMax = -Infinity
    for (const v of blockVrows) {
      for (const s of v.src) {
        if (s < srcMin) srcMin = s
        if (s > srcMax) srcMax = s
      }
    }
    if (!Number.isFinite(srcMin)) continue
    // Reject a block whose source range would swallow a non-table visual row.
    let overlaps = false
    for (let k = 0; k < vrows.length && !overlaps; k++) {
      if (k >= b.from && k <= b.to) continue
      if (vrows[k].src.some((s) => s >= srcMin && s <= srcMax)) overlaps = true
    }
    if (overlaps) continue

    // Columns come from block-wide gutters, topped up with header gaps where a
    // gutter is missing (a wide data cell can close it).  The header gives the
    // expected column count.
    let minX = Infinity
    let maxX = -Infinity
    for (const v of blockVrows) {
      for (const r of v.runs) {
        if (r.x < minX) minX = r.x
        if (r.xEnd > maxX) maxX = r.xEnd
      }
    }
    const colRuns = blockVrows
      .filter((v) => splitCells(v.runs, gapRow).length >= MIN_COLS)
      .flatMap((v) => v.runs)
    const gutterCols = detectColumns(colRuns, gapCol, MIN_COL_EM * baseSize)
    const seps: number[] = []
    for (let c = 0; c + 1 < gutterCols.length; c++) {
      seps.push((gutterCols[c][1] + gutterCols[c + 1][0]) / 2)
    }
    // A row can hold more cells than the block-wide gutters reveal: one row's
    // overflowing cell can close a column's gutter outright, and the gutters
    // then merge two columns into one.  The rows' own cell splits still mark
    // that boundary, so fall back to them when they resolve more columns than
    // the gutters do.
    const maxCells = Math.max(
      ...blockVrows.map(
        (v) =>
          mergeNarrowColumns(
            splitCells(v.runs, gapRow).map((c) => [c.x, c.xEnd] as [number, number]),
            MIN_COL_EM * baseSize,
          ).length,
      ),
    )
    if (gutterCols.length >= MIN_COLS && maxCells > gutterCols.length) {
      const cellSeps = cellGapSeparators(blockVrows, gapRow, minX, maxX)
      // A column boundary must not cut through a run: a separator that a run
      // straddles is inside a cell, not between cells.  The overflowing cell
      // that closed the gutter still stops short of the boundary, so a genuine
      // one survives this test.
      const blockRuns = blockVrows.flatMap((v) => v.runs)
      const cleanSeps = cellSeps.filter(
        (s) => !blockRuns.some((r) => r.x < s && r.xEnd > s),
      )
      if (cleanSeps.length > seps.length) {
        seps.length = 0
        seps.push(...cleanSeps)
      }
    }
    const headerSeps = headerSeparators(blockVrows, gapRow)
    if (headerSeps.length > seps.length) {
      for (const hs of headerSeps) {
        if (seps.length >= headerSeps.length) break
        if (seps.some((s) => Math.abs(s - hs) <= 2 * baseSize)) continue
        seps.push(hs)
      }
    }
    seps.sort((a, b) => a - b)
    const cols = seps.length > 0
      ? columnsFromSeparators(seps, minX, maxX)
      : gutterCols
    if (cols.length < MIN_COLS) continue
    const rows = pruneDotColumns(buildRows(blockVrows, cols, gapRow))
    if (rows.length < MIN_ROWS) continue
    const ncols = rows[0].length
    if (ncols < MIN_COLS) continue

    // A block that starts mid-table (a page-break continuation, or a run of
    // legislative-history rows) has no header, so its first row is data;
    // synthesise an empty header instead of promoting a data row.
    const dataFirst = !isHeaderRow(rows[0])
    rendered.push({
      srcMin,
      srcMax,
      markdown: renderMarkdown(rows, ncols, dataFirst),
      runs: blockVrows.flatMap((v) => v.runs),
    })
  }
  if (rendered.length === 0) return renderPlainText(input)

  // ── Linearise fractions outside the table blocks ───────────────────────
  // A table's cells stack short values at the same x, which mimics a fraction's
  // geometry; running the pass over a table would rewrite cells as fractions.
  // The blocks are known now, so the pass is confined to the prose between
  // them.
  const tableRuns = new Set<TextRun>()
  for (const b of rendered) for (const r of b.runs) tableRuns.add(r)
  const lines = linearizeFractions(input, (r) => tableRuns.has(r))

  // ── Render each block, replacing its source line range ─────────────────
  const out: Array<string | null> = lines.map((l) => renderPlainLine(l))
  for (const b of rendered) {
    out[b.srcMin] = b.markdown
    for (let s = b.srcMin + 1; s <= b.srcMax; s++) out[s] = null
  }

  const parts: string[] = []
  for (const o of out) if (o !== null) parts.push(o)
  return parts.join("\n")
}
