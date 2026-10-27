/**
 * Paragraph reflow for legislation section bodies.
 *
 * `extractPdfText` emits one line per visual line of the PDF, so a section
 * body arrives as a run of short lines:
 *
 *     In this Act, unless the subject or context otherwise
 *     requires —
 *
 * This module joins those visual lines back into paragraphs: a paragraph, a
 * list item, a heading and a table row each become one line, and blocks are
 * separated by blank lines.
 *
 * A sibling pass exists elsewhere in the wider project (`reflowParagraphs` in
 * `judiciary/ingest.ts`).  The rules differ because legislation's structure is
 * the printed numbering — subsections `(1)`, paragraphs `(a)`, amendment
 * citations `[Act …]`, Schedule divisions and pipe tables — rather than
 * numbered paragraphs and footnotes.
 *
 * No external dependencies.
 */

/** A pipe-table row. */
const PIPE_ROW_RE = /^\|/

/**
 * A list marker at the start of a line: `(a)`, `(i)`, `(1)`, `(viii)`, `(A)`.
 * The marker must be followed by whitespace or end the line, so a trailing
 * acronym parenthetical (`… Expressway (CTE).`) stays prose.
 */
const LIST_MARKER_RE = /^\((?:\d{1,3}|[a-z]{1,3}|[ivxlcdm]{1,5}|[A-Z]{1,3})\)(?=\s|$)/

/** A numbered row: `12. The underpass …`, `12C. [Deleted by …]`. */
const NUMBERED_ROW_RE = /^\d{1,4}[A-Z]?\.\s/

/** A bracket line: an amendment citation, a footnote, or a wrapped instruction. */
const CITATION_RE = /^\[/

/**
 * True when a bracket line stands alone: a closed citation
 * (`[Act 30 of 2023 wef 01/01/2024]`) or an edition page footer
 * (`[2024 Ed. p. 1`).  An unclosed bracket line is a wrapped instruction or
 * legislative-history row, so its continuation joins it.
 */
function isStandaloneBracket(line: string): boolean {
  const t = line.trim()
  return t.endsWith("]") || /^\[\d{4} Ed\./.test(t)
}

/** A page-break continuation marker. */
const CONTINUED_RE = /^[—–-]\s*continued$/i

/**
 * A division heading: `PART 1`, `SECTION I`, `TABLE 2A`.  All-caps keywords
 * only and number-bearing: a wrapped sentence that starts `Section 120
 * applies …` or `Division 4 of Part 4 …` is prose, not a heading.
 */
const DIVISION_RE =
  /^(?:PART|DIVISION|SUBSECTION|SECTION|CHAPTER|TABLE|SCHEDULE|ANNEX|APPENDIX)\s+(?:\d+[A-Z]?|[IVXLCDM]+)\b/

/**
 * A Division heading in title case (`Division 2 — Powers`).  The all-caps form
 * above is a Schedule division; this is the Act-level heading, which the
 * splitter lifts onto the section marker.  A heading that no section claimed
 * (a table-of-contents entry) stays in the body, and must not absorb the range
 * line below it (`sections 23‑41C, 42A.`).  The number and the em dash are
 * required, so a wrapped sentence that starts `Division 2 of Part 11 …` stays
 * prose.
 */
const TITLE_CASE_DIVISION_RE = /^Division\s+\d+[A-Z]*\s*(?:[—–]\s*(.+?))?\s*$/

/**
 * The same barrier for a Subdivision heading — `Subdivision (1) — Works`,
 * `Subdivision 3 — General Notes`.  The number and the em dash are required, so
 * a wrapped sentence that starts `Subdivision (3) of Division 2 …` stays prose.
 */
const TITLE_CASE_SUBDIVISION_RE =
  /^Subdivision\s+(?:\(\d+[A-Z]*\)|\d+[A-Z]*)\s*(?:[—–]\s*(.+?))?\s*$/

/**
 * A unit heading whose text is not on the same line: `Regulation 5`,
 * `Rule 3`.  Case-sensitive, so a wrapped `rule 12(1);` cross-reference
 * stays prose.
 */
const UNIT_HEADING_RE = /^(?:Regulation|Rule|Article|By-law|Bye-law)\s+\d+[A-Z]?\s*$/

/** True when the line is entirely upper case (`PRELIMINARY`). */
function isAllCaps(line: string): boolean {
  const t = line.trim()
  return t.length > 0 && t === t.toUpperCase() && /[A-Z]/.test(t)
}

/**
 * True when the line is an all-caps heading (`PRELIMINARY`, `DIAGRAM 2`)
 * rather than an all-caps continuation: a parenthesised fragment (`(ICAEW);`,
 * `(CHAPTER 7A)`), a data row (`99953A, 99450K PT`), a single-letter drop cap
 * (`T` + `rustee`) or a quoted fragment (`“SINGAPORE”`).
 */
function isAllCapsHeading(line: string): boolean {
  const t = line.trim()
  return (
    t.length > 1 &&
    isAllCaps(t) &&
    !/^[(\d]/.test(t) &&
    !/[,;]$/.test(t) &&
    !/[“”"]/.test(t)
  )
}

/**
 * True when `line` opens a block but may take wrapped continuations — a list
 * marker or a numbered row.  A structural *barrier* (citation, heading, page
 * number, table row) is handled by {@link isBarrier} instead.
 */
function opensBlock(line: string): boolean {
  const t = line.trim()
  return LIST_MARKER_RE.test(t) || NUMBERED_ROW_RE.test(t)
}

/**
 * True when `line` is a structural barrier: it opens a block and never
 * absorbs the line below it.  A heading, a closed citation and a page footer
 * stand alone; prose after them belongs to the next block.
 */
function isBarrier(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (LIST_MARKER_RE.test(t) || NUMBERED_ROW_RE.test(t)) return false
  return (
    PIPE_ROW_RE.test(t) ||
    (CITATION_RE.test(t) && isStandaloneBracket(t)) ||
    CONTINUED_RE.test(t) ||
    DIVISION_RE.test(t) ||
    TITLE_CASE_DIVISION_RE.test(t) ||
    TITLE_CASE_SUBDIVISION_RE.test(t) ||
    UNIT_HEADING_RE.test(t) ||
    isAllCapsHeading(t)
  )
}

/**
 * True when `line` ends a sentence or clause.  A trailing abbreviation
 * (`… under section 4 No.`) is not an end, so the blank line after it is still
 * a wrap in the middle of a sentence.
 */
function endsSentence(line: string): boolean {
  const t = line.trim()
  if (!/[.?!;:][)\]”’"']*$/.test(t)) return false
  return !/\b(?:etc|e\.g|i\.e|cf|No|Ltd|Pte|Co|Inc|St|para|art|ch|Cap|s)\.$/i.test(t)
}

/** True when the last line of `block` is a pipe row. */
function endsWithTableRow(block: string[]): boolean {
  return PIPE_ROW_RE.test(block[block.length - 1])
}

/**
 * Reflow a section body: join the extractor's visual lines into paragraphs.
 *
 * Blocks are separated by a blank line.  A wrapped line is joined onto the
 * block above it with one space; a line ending in a hyphen is joined without
 * one, keeping the hyphen (`non-` + `compliance` → `non-compliance`).
 *
 * @param text A section body from `splitLegislationSections` (raw lines).
 * @returns The same text with each paragraph / list item / heading / table row
 *   on one line.  Idempotent.
 */
export function reflowLegislationBody(text: string): string {
  const blocks: string[][] = []
  let block: string[] | null = null
  // A blank line was seen since the last content line.
  let afterBlank = false

  const flush = (): void => {
    if (block && block.length > 0) blocks.push(block)
    block = null
  }

  for (const raw of text.split("\n")) {
    const t = raw.trim()
    if (!t) {
      afterBlank = true
      continue
    }

    // A pipe row continues the table above it.
    if (block && endsWithTableRow(block) && PIPE_ROW_RE.test(t)) {
      block.push(t)
      afterBlank = false
      continue
    }

    if (block) {
      const prev = block[block.length - 1]
      // A barrier, a new structural block, a bracket line or a table ends the
      // current block.
      if (
        isBarrier(prev) ||
        endsWithTableRow(block) ||
        opensBlock(t) ||
        CITATION_RE.test(t) ||
        isBarrier(t)
      ) {
        flush()
      } else if (afterBlank && endsSentence(prev)) {
        // A blank line between two sentences is a paragraph break.
        flush()
      } else {
        // A wrapped line: join it, keeping a trailing hyphen.
        block[block.length - 1] = /(?<!-)[-‐‑]$/.test(prev) ? `${prev}${t}` : `${prev} ${t}`
        afterBlank = false
        continue
      }
    }

    block = [t]
    afterBlank = false
  }
  flush()

  return blocks.map((b) => b.join("\n")).join("\n\n")
}
