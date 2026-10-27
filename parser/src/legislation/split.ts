/**
 * Section splitting for Singapore legislation.
 *
 * Serves both legislation corpora, which share a section-numbering scheme but
 * differ in front matter:
 *
 *   - **Principal Acts** — `ARRANGEMENT OF SECTIONS` table of contents, then
 *     the long title (`An Act relating to ...`), a commencement date in
 *     brackets, and `The Schedules`.
 *   - **Subsidiary legislation** — `ARRANGEMENT OF PARAGRAPHS` / `RULES` /
 *     `REGULATIONS`, then the enacting formula (`In exercise of the powers
 *     conferred by ...`).
 *
 * Both are handled here because the section-collection loop is identical; only
 * the front-matter boundary differs, and that is resolved by `bodyStart` below.
 *
 * Takes the flat text produced by `extractPdfText`, reflows each section body
 * from visual lines into paragraphs (`reflow.ts`), and splits it into
 * numbered sections, emitting the same Markdown shape the Python ingest
 * pipeline uses:
 *
 *     ## [s12]
 *
 *     <section body>
 *
 *     ---
 *
 * The section id is `s` + the section number as printed (`s12`, `s8A`,
 * `s386AFA`).  Documents with no recognisable section numbering fall back to
 * a single `whole_doc` section, matching the Python behaviour.
 *
 * No external dependencies.
 */

import {
  DEFAULT_CHUNK_BUDGET,
  groupByBudget,
  splitParagraphs,
  type TextMeasure,
} from "../chunk.ts"
import { reflowLegislationBody } from "./reflow.ts"

/** A parsed section: its id (`s12`) and body text. */
export interface LegislationSection {
  id: string
  text: string
  /**
   * The `# PART N — TITLE` heading that introduces this section, if any.
   * It is rendered *above* the `## [id]` marker, so it is kept out of `text`.
   */
  part?: string
  /**
   * The `# Division N — TITLE` heading that introduces this section, if any.
   * Like `part`, it is rendered above the marker and kept out of `text`.
   */
  division?: string
  /**
   * The `# Subdivision (N) — TITLE` heading that introduces this section, if
   * any.  A Subdivision is the fourth level, inside a Division inside a Part.
   */
  subdivision?: string
  /**
   * The Part label carried on a section that opens a Division or a Subdivision
   * but not the Part itself.  A Division is rendered on the same `#` line as
   * its Part (`# PART 3 — CONSTITUTION OF COMPANIES — Division 1 —
   * Incorporation`), so every Division repeats the Part even when the Part
   * heading itself was claimed by an earlier section.  Render-only: it never
   * bounds a body.
   */
  divisionPart?: string
  /**
   * The Division label carried on a section that opens a Subdivision but not
   * the Division itself, so the Subdivision can repeat its Division on the same
   * `#` line.  Render-only, like `divisionPart`.
   */
  subdivisionDivision?: string
  /**
   * The `# FIRST SCHEDULE` / `# LEGISLATIVE HISTORY` heading for a Schedule or
   * appendix section, if any.  Like `part`, it is rendered above the marker.
   */
  heading?: string
  /**
   * The section's title (`Power to detain stolen vehicle …`), rendered on the
   * `## [id]` marker line.  It is kept out of `text` so it is not repeated.
   */
  title?: string
}

/**
 * A section start is a line beginning with the section number followed by a
 * separator.  Three shapes occur in the corpus:
 *
 *   `12. Short title`      — number, period, title (no subsections)
 *   `12.—(1) ...`          — number, em dash, subsection (the common case)
 *   `12.`                  — bare number on its own line
 *
 * The number may carry letter suffixes (`8A`, `386AFA`).
 *
 * A hyphen is only a separator when followed by whitespace, so a hyphenated
 * compound at the start of a wrapped line (`12-month post-confinement
 * period`) is not mistaken for a section.  An em dash or en dash is always a
 * separator, with or without a following space (`12.—(1)`, `3.— (1)`).
 *
 * A dash followed by another number is a page range, not a section
 * (`157–158, 169–172C` in a Schedule's page list), so it is excluded.
 *
 * A section start can land inside a reconstructed table cell, where the row
 * begins with a pipe (`| 7.—(1) A person must not — |  |`).  The leading pipe
 * and its padding are skipped so the section is still recognised.
 *
 * A footnote or amendment marker (`*`, `†`, `‡`, `§`, `¶`) can precede the
 * number.  The Constitution of the Republic of Singapore sets Article 3 as
 * `*3. Singapore shall be …`, where the asterisk marks an amendment footnote.
 * Without allowing the marker, Article 3 is missed and every later Article is
 * rejected as a forward jump, collapsing Parts 2–5 into Article 2.
 */
const FOOTNOTE_PREFIX = String.raw`[*†‡§¶]*\s*`
const CELL_PREFIX = String.raw`^\|?\s*` + FOOTNOTE_PREFIX
const SECTION_START_RE = new RegExp(`${CELL_PREFIX}(\\d{1,4}[A-Z]{0,4})\\s*(?:\\.\\s*)?(?:—|–|-\\s+)\\s*(?!\\d)(?=\\S)`)

/** `12. Short title` — number, period, then text on the same line. */
const NUMBERED_TITLE_RE = new RegExp(`${CELL_PREFIX}(\\d{1,4}[A-Z]{0,4})\\.\\s+(\\S.*)$`)

/** `49. to 53. [Repealed]` — a range of repealed or deleted sections. */
const REPEALED_RANGE_RE = new RegExp(
  `${CELL_PREFIX}(\\d{1,4}[A-Z]{0,4})\\.\\s+to\\s+(\\d{1,4}[A-Z]{0,4})\\.\\s*\\[(?:Repealed|Deleted|Omitted|Spent)\\b`,
  "i",
)

/** `54. [Repealed by Act ...]` — a single repealed section. */
const REPEALED_SINGLE_RE = new RegExp(`${CELL_PREFIX}(\\d{1,4}[A-Z]{0,4})\\.\\s*\\[Repealed`, "i")

/**
 * A bare `[Deleted by ...]` / `[Repealed by ...]` marker with no section
 * number.  It marks a whole Part or Division as removed, so the next section
 * may jump ahead.
 */
const BARE_DELETED_RE = /^\[(?:Deleted|Repealed|Omitted|Spent)\b/i

/** Bare `12.` on its own line — the title follows on the next line. */
const BARE_NUMBER_RE = new RegExp(`${CELL_PREFIX}(\\d{1,4}[A-Z]{0,4})\\.\\s*$`)

/**
 * Lines that look like a section start but are not: a bare number used as a
 * page number, or a numbered list item inside a schedule.
 */
const PAGE_NUMBER_RE = /^\d{1,4}$/

/**
 * The appendices that follow the Schedules.  The Arrangement of Sections lists
 * them as top-level entries beside the Schedules, so each is its own section.
 *
 * `Abbreviations` is title case; the other two are all caps.  Each must be the
 * whole line, so a cross-reference in body text does not match.
 */
const APPENDIX_RE = /^(LEGISLATIVE HISTORY|Abbreviations|COMPARATIVE TABLE)\s*$/i

/** Appendix heading → section id. */
const APPENDIX_IDS: Record<string, string> = {
  "legislative history": "legislative_history",
  abbreviations: "abbreviations",
  "comparative table": "comparative_table",
}

/** The section id for an appendix heading, or null if it is not one. */
function appendixId(line: string): string | null {
  const m = APPENDIX_RE.exec(line.trim())
  if (!m) return null
  return APPENDIX_IDS[m[1].toLowerCase()] ?? null
}

/** The `# LEGISLATIVE HISTORY` heading for an appendix section. */
function appendixHeading(line: string): string {
  const m = APPENDIX_RE.exec(line.trim())
  return m ? `# ${m[1].toUpperCase()}` : "# APPENDIX"
}

/**
 * A Part heading: `PART 21`, `PART 20A`, `PART A`, `PART IV`, `PART B-1` on a
 * line of its own.
 *
 * The number is Arabic (`21`, `20A`), a single letter (`A`, `C`), a Roman
 * numeral (`IV`, `IVAA`), or one of those with a hyphenated sub-number
 * (`B-1`, `A-1`) — the Safety Convention Regulations divide Chapter II-1 into
 * Parts B-1 to B-4.  Roman numerals are common in the older subsidiary
 * legislation (the Public Utilities (Water Supply) Regulations number their
 * Parts I–V), and without them the Part heading stayed in the section body
 * instead of being lifted onto a `#` line.
 *
 * The title is either on the same line, after an em dash (`PART C — MACHINERY
 * INSTALLATIONS`), or on the lines below the number (`PART B-1` /
 * `STABILITY`).  Both shapes occur in the corpus, and a Part is only
 * recognised when its heading is a whole line.
 *
 * A Part is a divider, not a retrievable unit — it has no body of its own,
 * only a title and the sections under it.  It is rendered as a `#` heading
 * at the top of the section that follows it, so it never becomes a section id.
 *
 * `PART A` / `PART 1` also occur *inside* a Schedule, where they divide the
 * Schedule rather than the Act.  Those are handled by
 * {@link SCHEDULE_DIVISION_RE}, which gives them a Schedule-scoped id.
 */
const PART_RE =
  /^PART\s+([0-9]+[A-Z]*(?:-[0-9]+)?|[IVXLCDM]+[A-Z]*(?:-[0-9]+)?|[A-Z](?:-[0-9]+)?)\s*(?:[—–]\s*(.+?))?\s*$/

/**
 * How many lines a Part title may occupy.  The title wraps over two lines in
 * the corpus (`PART 20B` / `INTERNATIONAL AGREEMENTS TO` / `IMPROVE TAX
 * COMPLIANCE`) and over three for `PART 20A`, where a blank line separates the
 * second and third (`EXCHANGE OF INFORMATION UNDER AVOIDANCE` / `OF DOUBLE
 * TAXATION ARRANGEMENTS AND` / `` / `EXCHANGE OF INFORMATION ARRANGEMENTS`).
 * The Safety Convention Regulations run to four (`PART D` / `SPECIAL
 * REQUIREMENTS FOR THE CARRIAGE` / `OF PACKAGED IRRADIATED NUCLEAR FUEL,` /
 * `PLUTONIUM AND HIGH-LEVEL RADIOACTIVE` / `WASTES ON BOARD SHIPS`).
 */
const PART_TITLE_MAX_LINES = 5

/**
 * A division heading that stops a Part title — `SECTION I — PASSENGER SHIPS`,
 * `DIVISION 1`.  It is all caps and can sit directly under a Part title, so it
 * must not be absorbed into the title.
 *
 * A title can itself name a Part or section (`ADDITIONAL PROVISIONS RELATING TO
 * PART 7, 8 OR 9`, `PART 2 DIRECTION — RECONSIDERATION AND APPEAL`), so this
 * only stops the title across a blank line, which is where the corpus puts a
 * division heading under its Part title.
 */
const PART_TITLE_STOP_RE =
  /^(PART|SECTION|DIVISION|CHAPTER|SCHEDULE|ANNEX|APPENDIX)\s+([0-9IVXLCDM]+\b|THE\b)/i

/**
 * A Part title line is all caps.  A line may open with a bracket
 * (`(SPECTRUM) CLASS LICENCE`), but the words inside it must still be caps, so
 * a parenthesised body line (`(Except where expressly provided otherwise`) is
 * not taken for title.
 */
const PART_TITLE_LINE_RE = /^\(?[A-Z][A-Z0-9 ,'’()\-–—/&.]*$/

/**
 * The number of lines the Part title at `i` occupies: the non-blank lines
 * after the `PART n` heading, up to {@link PART_TITLE_MAX_LINES}.
 *
 * The title is all caps and does not end a sentence, so a body line that
 * happens to follow a Part heading is not mistaken for a title.  A blank line
 * inside the title is skipped rather than ending it, because `PART 20A`'s
 * title is split by one.
 */
function titleLines(lines: string[], i: number): number {
  let n = 0
  let k = i + 1
  while (k < lines.length && n < PART_TITLE_MAX_LINES) {
    const t = lines[k].trim()
    if (!t) {
      // A blank line ends the title unless another title line follows it.  A
      // division heading is all caps too, but it opens a division of its own
      // rather than continuing the title.
      const next = k + 1 < lines.length ? lines[k + 1].trim() : ""
      if (!next || !PART_TITLE_LINE_RE.test(next) || PART_TITLE_STOP_RE.test(next)) break
      k++
      continue
    }
    if (!PART_TITLE_LINE_RE.test(t)) break
    n++
    k++
  }
  return k - (i + 1)
}

/** The Part title at `i`, joined across its wrapped lines, or "". */
function partTitle(lines: string[], i: number): string {
  const n = titleLines(lines, i)
  if (n === 0) return ""
  return lines
    .slice(i + 1, i + 1 + n)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ")
}

/**
 * A Division heading — `Division 2 — Powers`, `Division 3A — Reduction of
 * share capital`.  It divides a Part and is not part of a section title.
 *
 * The number is required and the title is title case, so a cross-reference
 * (`Division 2 of Part 11 — the unique entity number …`) and a Schedule
 * division (`DIVISION 1A`, all caps) are not matched.  A table-of-contents
 * entry is shaped exactly like a heading, so the heading is only honoured when
 * a section start follows it — see `DIVISION_WINDOW` and `claimHeadings`.
 */
const DIVISION_HEADING_RE = /^Division\s+(\d+[A-Z]*)\s*(?:[—–]\s*(.+?))?\s*$/

/**
 * A Subdivision heading — `Subdivision (1) — Works`, `Subdivision (2A) —
 * Voluntary transfer of business of`, `Subdivision 3 — General Technology Note
 * (GTN)`.  It divides a Division (a fourth level below the Part) and is not
 * part of a section title.
 *
 * The number is parenthesised in the principal Acts and bare in a Schedule
 * (`Subdivision 1 — General Notes`).  The title is title case, so a
 * cross-reference (`Subdivision (3) of Division 2 of Part XIII`) is not
 * matched.
 */
const SUBDIVISION_HEADING_RE =
  /^Subdivision\s+(?:\((\d+[A-Z]*)\)|(\d+[A-Z]*))\s*(?:—\s*(.+?))?\s*$/

/**
 * How many lines a Division or Subdivision title may wrap over.  The section
 * title is the last line of the region, so this bounds how much of a region
 * with no section start can be taken as a title.
 */
const WRAPPED_TITLE_MAX_LINES = 4

/**
 * How far below a Division heading its section may start.  A real heading sits
 * above the section title it introduces — measured over the corpus, the section
 * start is within 10 lines (a blank line, an amendment citation, a wrapped
 * title and a subdivision heading can intervene).  A table-of-contents entry is
 * caught by the `sections N` lookahead instead, so this is a safety net.
 */
const DIVISION_WINDOW = 20

/**
 * A Schedule begins a block whose numbered items are not sections.  Section
 * detection stops here so that schedule entries (which restart at 1) are not
 * mistaken for sections.
 *
 * The heading is `THE SCHEDULE` or `FIRST SCHEDULE` … on a line of its own.
 * A cross-reference inside body text (`Second Schedule;`) must not match, so
 * the line is required to be nothing but the heading.
 *
 * The heading is set in caps; a marginal note beside a section (`Second
 * Schedule`, title case, on its own line between a section's subsections) is
 * not a heading and must not open a Schedule.
 *
 * The ordinal is captured so the Schedule can be emitted as its own section
 * (`schedule1`, `schedule2`, …) rather than left to bleed into the last
 * numbered section's body.
 */
const SCHEDULE_RE = /^(?:THE\s+)?(?:(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ELEVENTH|TWELFTH)\s+)?SCHEDULE\s*$/

/** Ordinal word → number, for the Schedule id. */
const SCHEDULE_ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
}

/**
 * The section id for a Schedule heading: `schedule1` … `schedule12`, or
 * `schedule` for a bare `THE SCHEDULE` / `SCHEDULE`.
 *
 * The `schedule` prefix cannot collide with the `sN` namespace, so a Schedule
 * row that happens to read `1. Foo` can never be mistaken for a section.
 */
/**
 * The division a rendered `# PART 4 — TITLE` heading names, without its title
 * (`PART 4`).  Used to tell a repeated heading from a distinct one.
 */
function divisionKey(part: string | undefined): string | null {
  if (!part) return null
  const m = /^#\s+((?:PART|CHAPTER|TABLE|APPENDIX|DIVISION)\s+[0-9A-Z]+)\b/.exec(part)
  return m ? m[1] : null
}

function scheduleId(ordinal: string | undefined): string {
  if (!ordinal) return "schedule"
  const n = SCHEDULE_ORDINALS[ordinal.toLowerCase()]
  return n ? `schedule${n}` : "schedule"
}

/** Ordinal number → word, for reconstructing the Schedule heading. */
const SCHEDULE_ORDINAL_WORDS = [
  "",
  "FIRST",
  "SECOND",
  "THIRD",
  "FOURTH",
  "FIFTH",
  "SIXTH",
  "SEVENTH",
  "EIGHTH",
  "NINTH",
  "TENTH",
  "ELEVENTH",
  "TWELFTH",
]

/**
 * The `# FIRST SCHEDULE` heading for a Schedule section.
 *
 * The heading is reconstructed from the ordinal rather than copied from the
 * source, because a wrapped heading (`FIRST` / `SCHEDULE`) and a page-break
 * continuation (`FIRST SCHEDULE — continued`) would otherwise render as two
 * lines or carry the continuation marker.
 */
function scheduleHeading(ordinal: string | undefined): string {
  if (!ordinal) return "# THE SCHEDULE"
  const n = SCHEDULE_ORDINALS[ordinal.toLowerCase()]
  return n ? `# ${SCHEDULE_ORDINAL_WORDS[n]} SCHEDULE` : "# THE SCHEDULE"
}

/** A line that is nothing but a Schedule ordinal (`FIRST`, `SECOND`, …). */
const SCHEDULE_ORDINAL_LINE_RE = /^(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ELEVENTH|TWELFTH)$/i

/**
 * Match a Schedule heading at `lines[i]`, allowing the ordinal to have wrapped
 * onto the line above.
 *
 * A wide heading font wraps `FIRST SCHEDULE` across two lines — the Central
 * Provident Fund Act 1953 sets it as `FIRST` / `SCHEDULE`, and its page-break
 * continuation as `FIRST` / `SCHEDULE` / `—` / `continued`.  The bare
 * `SCHEDULE` line then fails `isStandaloneHeading`, because the line above it
 * (`FIRST`) does not end a sentence, so the Schedule was never opened.
 *
 * @returns The ordinal (`"FIRST"`) and the line the heading starts on, or null.
 */
function matchScheduleHeading(
  lines: string[],
  i: number,
): { ordinal: string | undefined; line: number; sameLine: boolean } | null {
  const t = lines[i].trim()
  const m = SCHEDULE_RE.exec(t)
  if (m) {
    // `FIRST SCHEDULE` on one line.
    if (m[1]) return { ordinal: m[1], line: i, sameLine: true }
    // A bare `SCHEDULE`: the ordinal may be on the line above.
    const prev = i > 0 ? lines[i - 1].trim() : ""
    const om = SCHEDULE_ORDINAL_LINE_RE.exec(prev)
    if (om) return { ordinal: om[1], line: i - 1, sameLine: false }
    return { ordinal: undefined, line: i, sameLine: false }
  }
  return null
}

/**
 * A division *inside* a Schedule — `PART 1`, `CHAPTER II`, `TABLE 3`,
 * `APPENDIX I`.  A Schedule is a section of its own, and these divide it
 * further.  Without them a Schedule that runs to dozens of divisions becomes
 * one enormous section: the Strategic Goods (Control) Order 2025's Schedule
 * (two Parts) and the Home Protection Insurance Scheme's First Schedule (20
 * tables) each split into 50 unlabelled chunks.
 *
 * The number is required, so `TABLE OF CONTENTS` and `TABLE — DEPOSITION
 * TECHNIQUES` are not divisions, and the whole line must be the heading, so a
 * body line that merely opens with the word (`PART OF THE COMPOSITION OF
 * COSMETIC PRODUCTS`) does not match.
 */
const SCHEDULE_DIVISION_RE =
  /^(PART|CHAPTER|TABLE|APPENDIX)\s+([0-9]+[A-Z]*|[IVXLCDM]+[A-Z]*|[A-Z])(?:-[0-9]+)?(?:\s*[—–-]\s*(.+?))?\s*$/

/**
 * The Arrangement of Sections (table of contents) repeats every section
 * number as `12. Short title`.  Subsidiary legislation calls it
 * `ARRANGEMENT OF PARAGRAPHS` or `ARRANGEMENT OF RULES`; all are skipped.
 */
const ARRANGEMENT_RE = /^ARRANGEMENT OF (SECTIONS|PARAGRAPHS|RULES|REGULATIONS|ARTICLES)\s*$/i

/**
 * The enacting formula that precedes the operative text in subsidiary
 * legislation: `In exercise of the powers conferred by ... makes the following
 * Regulations:`.  It is the most reliable boundary between the front matter
 * (including the Arrangement of Sections) and the first section.
 */
const ENACTING_RE = /^In exercise of the powers conferred\b/i

/** The leading digits of a section number: `386AFA` → `386`. */
function numericPart(id: string): number {
  const m = /^(\d+)/.exec(id)
  return m ? parseInt(m[1], 10) : 0
}

/**
 * True when a number is a year rather than a section number.
 *
 * A date that wraps across a line or page break leaves the year alone on a
 * line — `... take effect from (and including) 1 January` / `2024.` — which is
 * shaped exactly like a bare section start.  Left unguarded it is accepted as
 * a section, and because numbering must advance, every real section after it
 * is then discarded as a backward jump.  In the Income Tax Act that collapsed
 * all 1,320 pages into two bogus sections.
 */
function isYear(n: number): boolean {
  return n >= 1900 && n <= 2100
}

/**
 * How many lines a section title may occupy.  Measured over the corpus: 45% of
 * sections have the title on the single line above the number and 6% have it
 * wrapped over two, so three bounds the damage if a body line happens to look
 * like a title.  The extra step covers a wrapped title with a page break
 * between its halves (`Accessing or disclosing identifying information, crew` /
 * blank / `information or passenger information`).
 */
const TITLE_MAX_LINES = 3

/**
 * A marginal note (the running heading printed beside a section) is a full
 * phrase, so both it and the title below it must carry at least this many
 * words before the upper line is treated as a note rather than the first half
 * of a wrapped title (`Provision in advance by person due to arrive in or due
 * to leave` / `Singapore by land`).
 */
const MARGINAL_NOTE_MIN_WORDS = 4

/**
 * True when a line is entirely upper case (`PRELIMINARY`, `MISCELLANEOUS`).
 * Such a line is a division title, not a section title.
 */
function isAllCaps(line: string): boolean {
  const t = line.trim()
  return t.length > 0 && t === t.toUpperCase() && /[A-Z]/.test(t)
}

/**
 * A division marker: `PART 4`, `DIVISION 3`, `CHAPTER 1`, `SUBDIVISION (2)`.
 * It divides the Act (or a Schedule) and is not part of a section title.
 *
 * The number is required, and it must be followed by an em dash or end the
 * line.  That separates a marker (`Division 2 — Offences`) from a title that
 * merely starts with one of these words (`Division into Parts`,
 * `Article 83 bis agreements`, `Part 10A Registrar`).
 */
const DIVISION_RE = /^(?:PART|DIVISION|SUBDIVISION|CHAPTER|ARTICLE|SUBHEADING)\s+(?:\d+[A-Z]*|\((?:\d+|[a-z])\))\s*(?:—.*)?$/i

/**
 * True when a heading reads as a complete title on its own, rather than the
 * first half of a wrapped one.  A wrapped half ends mid-phrase — with a
 * conjunction, a preposition or an article (`… information, crew`,
 * `… to and by Guardian-in-Adoption or`).
 */
function isCompleteHeading(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  return !/\b(?:and|or|of|to|the|a|an|in|for|with|by|on|at|from|as|that|which|whose|its|their|his|her|within|under|over|upon|into|during|between|against|without|about|after|before|through|towards|toward|per)$/i.test(t)
}

/** Number of whitespace-separated words in a line. */
function wordCount(line: string): number {
  return line.trim().split(/\s+/).filter(Boolean).length
}

/**
 * True when a line ends a sentence or a clause.  A trailing abbreviation
 * (`… authorised area, etc.`) is not a sentence end, so the period is only
 * counted when it is not part of one.
 */
function endsSentence(line: string): boolean {
  const t = line.trim()
  if (/[;:,)\]”’"—–]$/.test(t)) return true
  if (/\.$/.test(t) && !/\b(?:etc|e\.g|i\.e|cf|No|Ltd|Pte|Co|Inc|St)\.$/i.test(t)) return true
  return false
}

/**
 * A word that cannot end a title, so the title must continue below it
 * (`… Voluntary Transfer of Business of` / `Approved Exchange …`).
 */
const TITLE_OPEN_TAIL_RE =
  /\b(?:a|an|and|as|at|before|by|for|from|in|into|of|on|or|the|to|under|with)$/i

/**
 * The next line at or after `from`, within `limit` lines, that opens a section,
 * or -1.
 */
function nextSectionStart(lines: string[], from: number, limit: number): number {
  const stop = Math.min(lines.length, from + limit)
  for (let k = from; k < stop; k++) {
    const t = lines[k].trim()
    if (!t) continue
    if (SECTION_START_RE.test(t) || NUMBERED_TITLE_RE.test(t) || BARE_NUMBER_RE.test(t)) return k
  }
  return -1
}

/** The next Part, Division, Subdivision or Schedule heading at or after `from`, or -1. */
function nextDividerHeading(lines: string[], from: number, limit: number): number {
  const stop = Math.min(lines.length, from + limit)
  for (let k = from; k < stop; k++) {
    const t = lines[k].trim()
    if (!t) continue
    if (PART_RE.test(t)) return k
    // A bare `Division N` is the tail of a wrapped title, not a heading, so the
    // em dash and a title are required — the same rule the scan loop uses.
    const titled = t.includes("—") || t.includes("–")
    if (titled && (DIVISION_HEADING_RE.test(t) || SUBDIVISION_HEADING_RE.test(t))) return k
    if (matchScheduleHeading(lines, k)) return k
  }
  return -1
}

/**
 * The Division or Subdivision title at `i`, and the offset from the heading line
 * to the last line the title occupies.
 *
 * A divider's title and the title of the section it introduces both sit between
 * the heading and the section number, and the section's title is always the last
 * of them — so every other title line belongs to the divider.  A lower-case last
 * line is the tail of the section title (`… what are the visual images, sounds
 * and` / `soundtrack of a film`), so the line above it is part of the section
 * title too.
 *
 * The region ends at the section start, or at the next divider heading when one
 * comes first (`Division 2 — Regulation of Licensed` / `Trade Repositories` /
 * `Subdivision (1) — …` — the whole region is the Division's title, because the
 * section title sits below the Subdivision heading).  Lines that are neither
 * title — an amendment citation, a Part title in caps — are skipped.  `below` is
 * an offset, so a blank line or a citation inside the title is counted.
 */
function wrappedTitleBelow(
  lines: string[],
  i: number,
  sectionAt: number,
): { title: string; below: number } {
  const dividerAt = nextDividerHeading(lines, i + 1, DIVISION_WINDOW)
  const stop = dividerAt >= 0 && (sectionAt < 0 || dividerAt < sectionAt) ? dividerAt : sectionAt
  if (stop < 0) return { title: "", below: 0 }
  const region: number[] = []
  for (let k = i + 1; k < stop; k++) {
    const t = lines[k].trim()
    if (!t || /^\[[^\]]*\]$/.test(t)) continue
    region.push(k)
  }
  if (region.length === 0) return { title: "", below: 0 }
  let cont = region
  if (stop === sectionAt) {
    // The section's own title is the last line, plus one more when that line is
    // a lower-case continuation (`… what are the visual images, sounds and` /
    // `soundtrack of a film`) or when the line above it cannot end a title
    // (`… requirements in` / `Division 5`).
    let titleCount = 1
    while (titleCount < 2 && titleCount < region.length) {
      const head = lines[region[region.length - titleCount]].trim()
      const above = lines[region[region.length - titleCount - 1]].trim()
      if (/^[a-z(“"]/.test(head) || TITLE_OPEN_TAIL_RE.test(above)) titleCount++
      else break
    }
    cont = region.slice(0, region.length - titleCount)
  }
  cont = cont.slice(0, WRAPPED_TITLE_MAX_LINES)
  if (cont.length === 0) return { title: "", below: 0 }
  return { title: cont.map((k) => lines[k].trim()).join(" "), below: cont[cont.length - 1] - i }
}

/**
 * True when a line reads as a section heading rather than body text.
 *
 * The heading sits immediately above its section number, so without this it
 * falls at the end of the previous section's body — and the first section's
 * heading is dropped along with the front matter.
 */
function isHeadingLine(line: string): boolean {
  const t = line.trim()
  if (!t || t.length > 80) return false
  // A heading is a title: it does not end a sentence or a clause.
  if (endsSentence(t)) return false
  // Sub-clauses and list markers are body text.
  if (/^\(/.test(t)) return false
  // A table-of-contents entry (`2. Definitions`) is numbered; a heading is not.
  if (/^\d/.test(t)) return false
  // A lowercase start continues the sentence above.
  return /^[A-Z“"]/.test(t)
}

/**
 * True when `line` is the continuation of a wrapped title: it starts lower
 * case, and the line above it is a heading that does not end a sentence.
 *
 * A wrapped title (`Accessing or disclosing identifying information, crew` /
 * `information or passenger information`) has exactly this shape.  Body text
 * does not: a lower-case line following a sentence-ending line is a new
 * sentence, and the line above a body line ends a sentence.
 *
 * A division heading (`Division 3 — Role of Guardian-in-Adoption in` /
 * `adoption proceedings`) has the same shape, so a line whose predecessor is a
 * division marker is not a title continuation — it belongs to the division.
 *
 * The heading above must itself start a block: the line above *it* must end a
 * sentence or be blank.  Without that, a mid-sentence body line that happens to
 * start upper case (`… the` / `Guardian-in-Adoption must take into account …`)
 * would be read as the first half of a title.
 */
function isTitleContinuation(line: string, above: string, aboveAbove: string): boolean {
  const t = line.trim()
  if (!t || t.length > 80) return false
  if (!/^[a-z(“"]/.test(t)) return false
  // A title fragment does not end a sentence; a body line does.
  if (endsSentence(t)) return false
  // The line above must be a heading that does not end a sentence.  A wrapped
  // title's first half may end with a comma (`… identifying information,`),
  // which `isHeadingLine` rejects and `endsSentence` accepts, so that case is
  // allowed here.
  const a = above.trim()
  const commaHalf = a.length <= 80 && /^[A-Z“"]/.test(a) && /,$/.test(a)
  if (!isHeadingLine(a) && !commaHalf) return false
  if (!commaHalf && endsSentence(a)) return false
  // A division marker and its title are not part of the section title.
  if (DIVISION_RE.test(a)) return false
  // The heading must start a block: the line above it ends a sentence or is
  // blank.  A Part, Division or Subdivision heading starts a block too, so a
  // title's first half may sit directly below one.
  const aa = aboveAbove.trim()
  return (
    aa === "" ||
    endsSentence(aa) ||
    DIVISION_RE.test(aa) ||
    SUBDIVISION_HEADING_RE.test(aa) ||
    PART_RE.test(aa)
  )
}

/**
 * True when `lines[i]` is a heading that stands on its own.  A wrapped title
 * continuation (`61. Summary disposal ... in First` / `Schedule`) fails this
 * test: the preceding line is body text that does not end a sentence.
 */
function isStandaloneHeading(lines: string[], i: number): boolean {
  const prev = i > 0 ? lines[i - 1].trim() : ""
  if (prev === "") return true
  // A page number or running header can precede a heading.
  if (/^\d{1,4}$/.test(prev)) return true
  // A rendered table row is never a wrapped title continuation.  A Schedule
  // that opens on the page after its predecessor's last table row arrives with
  // no blank line between them.
  if (prev.endsWith("|")) return true
  // Otherwise the previous line must look like the end of a sentence or a
  // structural marker; a wrapped title continuation does not.
  return /[.;:)\]”’"—–]$/.test(prev) || DIVISION_RE.test(prev)
}

/**
 * True when a `Schedule` line is the table-of-contents entry rather than the
 * Schedule itself.  The TOC entry is followed by the commencement date or the
 * enacting formula; a real Schedule heading is followed by its content.
 */
function isTocScheduleEntry(lines: string[], i: number): boolean {
  for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
    const l = lines[j].trim()
    if (l === "") continue
    if (/^\[\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\]$/.test(l)) return true
    if (ENACTING_RE.test(l)) return true
    return false
  }
  return false
}

/**
 * Split extracted legislation text into numbered sections.
 *
 * @param text Flat text from `extractPdfText`.
 * @returns Sections in document order.  Always at least one entry.
 */
export function splitLegislationSections(text: string): LegislationSection[] {
  const lines = text.split("\n")

  // A section number is occasionally split across two lines by the typesetter —
  // the Housing and Development (Polling for Upgrading Works) Rules print `3`
  // on one line and `3.—(1) …` on the next, for section 33 — leaving the first
  // digit on a line of its own.  Join it back so the section is recognised
  // rather than swallowed by the section above it.
  for (let i = 0; i + 1 < lines.length; i++) {
    const lone = lines[i].trim()
    if (!/^\d{1,3}$/.test(lone)) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() === "") j++
    if (j >= lines.length) continue
    const m = /^(\d{1,3})([A-Z]?)\.\s*[—–]/.exec(lines[j].trim())
    // The fragment must be the leading digits of the number below it, so a
    // wrapped citation (`… Act 1925, s.` / `164` / `69A.—`) is not joined.
    if (!m || !m[1].startsWith(lone)) continue
    lines[j] = lone + lines[j].trim()
    lines.splice(i, 1)
    i--
  }

  // Locate the start of the operative text.  The Arrangement of Sections is a
  // table of contents whose entries look exactly like section starts, so it
  // must be skipped or every section would be duplicated.
  //
  // Two signals mark the boundary:
  //   - the `ARRANGEMENT OF ...` heading, when present
  //   - the enacting formula (`In exercise of the powers conferred by ...`),
  //     which precedes the body in every subsidiary instrument
  // The later of the two wins.
  let bodyStart = 0
  let arrangementAt = -1
  for (let i = 0; i < lines.length; i++) {
    if (ARRANGEMENT_RE.test(lines[i].trim())) {
      arrangementAt = i
      break
    }
  }
  // The enacting formula is the most reliable boundary: it always sits between
  // the front matter and the first section.
  let enactingAt = -1
  for (let i = 0; i < lines.length; i++) {
    if (ENACTING_RE.test(lines[i].trim())) {
      enactingAt = i
      break
    }
  }
  if (enactingAt !== -1) {
    bodyStart = enactingAt + 1
  } else if (arrangementAt !== -1) {
    bodyStart = arrangementAt + 1
    // Walk forward past the TOC.  TOC entries are `N. Title` lines separated
    // by blank lines, with no body text.  The operative text begins at the
    // first section start whose following non-blank line is prose rather than
    // another numbered entry.
    //
    // The TOC is followed by the long title (`An Act relating to ...`), a
    // commencement date in brackets, or a `The Schedule` line before the body
    // proper.  When one of those markers is present, start after it — it is a
    // more reliable boundary than the entry shape.
    let markerAt = -1
    for (let i = arrangementAt + 1; i < lines.length; i++) {
      const l = lines[i].trim()
      if (/^An Act\b/.test(l) || /^\[\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\]$/.test(l) || /^The Schedules?$/i.test(l)) {
        markerAt = i
        break
      }
    }
    if (markerAt !== -1) {
      bodyStart = markerAt + 1
    } else {
      for (let i = arrangementAt + 1; i < lines.length; i++) {
        const line = lines[i]
        const isStart =
          SECTION_START_RE.test(line) ||
          BARE_NUMBER_RE.test(line) ||
          NUMBERED_TITLE_RE.test(line)
        if (!isStart) continue
        // Look at the next non-blank line: if it is another numbered entry,
        // this is still the TOC.
        let j = i + 1
        while (j < lines.length && !lines[j].trim()) j++
        const next = j < lines.length ? lines[j] : ""
        const nextIsEntry =
          SECTION_START_RE.test(next) ||
          BARE_NUMBER_RE.test(next) ||
          NUMBERED_TITLE_RE.test(next)
        if (!nextIsEntry) {
          bodyStart = i
          break
        }
      }
    }
  }

  // The Arrangement of Sections lists every section number the document
  // declares, including the gaps left by repealed sections.  A repealed run
  // often leaves no marker in the body at all — the Penal Code omits sections
  // 13–16 entirely, so the body steps straight from `12.` to `17.` — and a
  // bare forward jump is otherwise rejected, after which every later section
  // is swallowed by the last one detected.  The table of contents is the
  // authority for which numbers are real sections, so a forward jump is
  // allowed when the number is listed there.
  const tocIds = new Set<string>()
  if (arrangementAt !== -1) {
    for (let i = arrangementAt + 1; i < bodyStart; i++) {
      const t = lines[i].trim()
      const m = SECTION_START_RE.exec(t) ?? NUMBERED_TITLE_RE.exec(t) ?? BARE_NUMBER_RE.exec(t)
      if (m) tocIds.add(m[1])
    }
  }

  // Collect candidate section starts after the front matter.
  //
  // The `N.—` and bare `N.` forms are unambiguous.  The `N. text` form is not:
  // a numbered list item inside a schedule looks identical.  It is accepted
  // only when the number continues the sequence established by the
  // unambiguous forms, which is how the real section starts are laid out.
  const starts: { line: number; id: string; part?: string; partFrom?: number; partBelow?: number; division?: string; divisionPart?: string; divisionFrom?: number; divisionBelow?: number; subdivision?: string; subdivisionDivision?: string; subdivisionFrom?: number; subdivisionBelow?: number; heading?: string; headingBelow?: number }[] = []
  let lastNumber = 0
  // Set after a deleted/repealed range: the next section may jump ahead.
  let allowJump = false
  // Set once a Schedule heading is seen.  A Schedule's rows restart at 1, so
  // they must not be read as sections — the Schedule is one section, and its
  // rows are its body.
  let inSchedule = false
  // The Schedule a division heading belongs to.  A division inside a Schedule
  // is a section of its own (`schedule1_part2`), so it needs the Schedule's id
  // to stay unique.
  let currentScheduleId = ""
  // How many times a Schedule division id has been used.  A Schedule can list
  // its divisions in a table of contents before repeating them, and the id
  // dedup below would otherwise drop the real one.
  const scheduleDivSeen = new Map<string, number>()
  // Set once an appendix heading is seen.  The appendices are the document
  // tail, and their own numbered entries (`5. G.N. No. S 344/1995 — …`) look
  // exactly like section starts, so section detection stops there.
  let inAppendix = false
  // A Part heading seen since the last section start.  It is attached to the
  // next section, which is the one it introduces.  A Part that no section ever
  // opens is emitted as a section of its own — see `flushPendingPart`.
  let pendingPart: { text: string; from: number; to: number; token: string; below: number } | null = null
  // A Division heading seen since the last section start.  Like a Part it is a
  // divider, not a section, so it is attached to the section it introduces and
  // rendered as a `#` heading above that section's marker, on the same line as
  // its Part.  A heading that no section follows is a table-of-contents entry —
  // see `claimHeadings`.
  let pendingDivision: { text: string; from: number; below: number } | null = null
  // A Subdivision heading seen since the last section start.  A fourth level
  // inside a Division; held and claimed exactly like a Division.
  let pendingSubdivision: { text: string; from: number; below: number } | null = null
  // The Part most recently seen.  `pendingPart` is consumed by the first
  // section under the Part, but every Division must be able to name its Part,
  // so the Part is remembered separately and never consumed.
  let currentPart: { text: string } | null = null
  // The Division most recently seen, remembered for the same reason: every
  // Subdivision must be able to name its Division.
  let currentDivision: { text: string } | null = null
  // A Part that no numbered section opened.  It is kept aside rather than
  // pushed into `starts` as it is found, so the section detection below still
  // sees the numbered sections alone; the two lists are merged in document
  // order once the scan is done.
  const partStarts: { line: number; id: string; part: string; partFrom: number; partBelow: number }[] = []
  // Part letters repeat across the Chapters of one instrument (the Safety
  // Convention Regulations restart at `PART A` in every Chapter), and a
  // hyphenated sub-number would collide with a repeat suffix (`PART B-2` and
  // the second `PART B` both want `part_b_2`), so the id is numbered in
  // document order: `part_1_a`, `part_7_b_1`.
  let partCount = 0
  // Emit a Part that no numbered section opened.  A document whose units are
  // the Parts themselves — the Safety Convention Regulations head each
  // provision `Regulation 5`, never `5.` — would otherwise lose every Part but
  // the last, because each heading overwrites the pending one before any
  // section can claim it.
  const flushPendingPart = (): void => {
    if (!pendingPart) return
    partCount++
    partStarts.push({
      line: pendingPart.from,
      id: `part_${partCount}_${pendingPart.token.toLowerCase().replace(/-/g, "_")}`,
      part: pendingPart.text,
      partFrom: pendingPart.from,
      partBelow: pendingPart.below,
    })
    pendingPart = null
  }
  // Claim the Part, Division and Subdivision headings that introduce the
  // section at `i`.  All are dividers, not sections, so they are attached to
  // the section they introduce and rendered above its marker.  A heading that
  // no section follows within `DIVISION_WINDOW` lines is a table-of-contents
  // entry, not a divider — it is dropped and stays in the body.
  const claimHeadings = (i: number, id: string): (typeof starts)[number] => {
    const start: (typeof starts)[number] = {
      line: i,
      id,
      part: pendingPart?.text,
      partFrom: pendingPart?.from,
      partBelow: pendingPart?.below,
    }
    pendingPart = null
    if (pendingDivision && i - pendingDivision.from <= DIVISION_WINDOW) {
      start.division = pendingDivision.text
      start.divisionFrom = pendingDivision.from
      start.divisionBelow = pendingDivision.below
      // A Division is rendered on the same `#` line as its Part, so the
      // section that opens it carries the Part even when the Part heading was
      // already claimed by an earlier section.
      if (!start.part && currentPart) start.divisionPart = currentPart.text
    }
    pendingDivision = null
    if (pendingSubdivision && i - pendingSubdivision.from <= DIVISION_WINDOW) {
      start.subdivision = pendingSubdivision.text
      start.subdivisionFrom = pendingSubdivision.from
      start.subdivisionBelow = pendingSubdivision.below
      // A Subdivision is rendered on the same `#` line as its Part and
      // Division, so the section that opens it carries both even when they
      // were already claimed by earlier sections.
      if (!start.part && !start.divisionPart && currentPart) start.divisionPart = currentPart.text
      if (!start.division && currentDivision) start.subdivisionDivision = currentDivision.text
    }
    pendingSubdivision = null
    return start
  }
  // A Part that restarts its numbering — its first section number is below the
  // previous Part's last — would have its sections rejected as backward jumps
  // and then dropped by the id dedup.  The Family Justice Rules number their
  // rules per Part (`1.` recurs under all 73 Parts), so such a Part's ids are
  // qualified with the Part number (`s2_1` for rule 1 of Part 2) to stay
  // unique.
  let currentPartNum: number | null = null
  let restartPartNum: number | null = null
  let awaitingPartFirst = false
  // The last line that looks like a body section start, before the first
  // appendix heading.  The appendices are the document tail, so an appendix
  // heading before this line is out of place — see the appendix branch below.
  // The scan stops at the first appendix heading, because the Legislative
  // History's own entries (`1. Ordinance 39 of 1947 — …`) look like section
  // starts.
  let lastBodySectionLine = -1
  for (let i = bodyStart; i < lines.length; i++) {
    const t = lines[i].trim()
    if (appendixId(t)) break
    if (SECTION_START_RE.test(t) || BARE_NUMBER_RE.test(t) || NUMBERED_TITLE_RE.test(t)) {
      lastBodySectionLine = i
    }
  }
  // A body section start *after* the first appendix heading means the appendix
  // pages are interleaved with body pages, so no appendix heading opens a
  // section — the trailing body would be attributed to it.
  //
  // The signal is a *repeat*: the interleaved PDFs duplicate the body, so a
  // section number seen before the appendix appears again after it.  A new
  // section that merely continues the sequence is the normal case.  The
  // Legislative History's own entries (`1. Ordinance 39 of 1947 — …`) are
  // excluded by the spaced em dash, which a section start (`30.—(1)`) does not
  // carry.
  const seenNumbers = new Set<number>()
  for (let i = bodyStart; i <= lastBodySectionLine; i++) {
    const m = SECTION_START_RE.exec(lines[i].trim()) ?? NUMBERED_TITLE_RE.exec(lines[i].trim())
    if (m) seenNumbers.add(numericPart(m[1]))
  }
  let bodyAfterAppendix = false
  for (let i = lastBodySectionLine + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    // The Comparative Table is a renumbering list whose rows (`6—(2) 6—(1A)`)
    // look like section starts; it is not body text.
    if (/^COMPARATIVE TABLE$/i.test(t)) break
    // A Legislative History entry (`3. G.N. No. 280/1903 —"Rule under …"`)
    // carries a dash after its text; a section start (`30.—(1)`) has the dash
    // immediately after the number.
    if (/[—–]/.test(t) && !SECTION_START_RE.test(t)) continue
    const m = SECTION_START_RE.exec(t) ?? NUMBERED_TITLE_RE.exec(t)
    if (!m || !seenNumbers.has(numericPart(m[1]))) continue
    // A section start carries a short title; a Legislative History entry is a
    // sentence (`1. Where the subject-matter is insured "lost or not lost" …`).
    const rest = t.slice(m[0].length).trim()
    if (rest.length > 80 || /[.;]$/.test(rest)) continue
    bodyAfterAppendix = true
    break
  }
  // The id for a section: `s12`, or `s2_12` when the enclosing Part restarts
  // its numbering (see `restartPartNum`).
  const sectionId = (numStr: string): string =>
    restartPartNum !== null && currentPartNum !== null ? `s${currentPartNum}_${numStr}` : `s${numStr}`

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i]
    // A Schedule restarts numbering, so its items are not sections.  A bare
    // `Schedule` can also be the wrapped tail of a section title (`61. Summary
    // disposal ... in First` / `Schedule`), so it only counts as a heading when
    // it stands alone between blank lines.
    //
    // The TOC lists `The Schedules` before the body begins; that entry is
    // followed by the commencement date or the enacting formula, whereas a real
    // Schedule heading is followed by its content.  A Schedule heading seen
    // before any section marks the start of the Schedule block.
    //
    // The Schedule is emitted as its own section (`schedule1`, `schedule2`, …)
    // rather than left to bleed into the last numbered section's body.  Its
    // rows still cannot become `sN` sections: the id is in a separate
    // namespace, and `inSchedule` suppresses section detection until the next
    // Schedule heading.
    const sched = matchScheduleHeading(lines, i)
    // A heading that carries its own ordinal (`SECOND SCHEDULE`) is never a
    // wrapped title continuation, so it needs no standalone check.  A bare
    // `SCHEDULE`, or a wrapped `FIRST` / `SCHEDULE`, does.
    if (sched && (sched.sameLine || isStandaloneHeading(lines, sched.line)) && !isTocScheduleEntry(lines, i)) {
      flushPendingPart()
      // A Division heading above the Schedule belongs to the body before it,
      // and no section opened it — it is a stub, so it stays in the body.
      pendingDivision = null
      pendingSubdivision = null
      currentPart = null
      currentDivision = null
      starts.push({
        line: sched.line,
        id: scheduleId(sched.ordinal),
        heading: scheduleHeading(sched.ordinal),
        // A wide heading font wraps `FIRST SCHEDULE` over two lines; the body
        // starts below the last of them.
        headingBelow: i - sched.line + 1,
      })
      currentScheduleId = scheduleId(sched.ordinal)
      inSchedule = true
      continue
    }
    // The appendices follow the Schedules and are sections of their own.  They
    // are checked before the `inSchedule` guard, because they come after the
    // last Schedule heading.
    //
    // A PDF whose appendix pages are interleaved with body pages (the Unfair
    // Contract Terms Act 1977, the Intestate Succession Act 1967) puts an
    // appendix heading *before* the body has finished, so opening a section
    // there would attribute the trailing body to the appendix.  The appendices
    // are the document tail, so an appendix heading is only honoured once no
    // body section start follows it.
    const app = appendixId(line)
    if (app && !bodyAfterAppendix) {
      flushPendingPart()
      pendingDivision = null
      pendingSubdivision = null
      currentPart = null
      currentDivision = null
      starts.push({ line: i, id: app, heading: appendixHeading(line), headingBelow: 1 })
      inSchedule = false
      inAppendix = true
      continue
    }
    // Inside a Schedule, a numbered row is body text, not a section start.  A
    // division heading (`PART 1`, `CHAPTER II`, `TABLE 3`) does open a section,
    // though — a Schedule that runs to dozens of divisions would otherwise
    // become one enormous section.
    if (inSchedule) {
      const div = SCHEDULE_DIVISION_RE.exec(line.trim())
      // A division stands on its own line.  The code-of-conduct Schedules
      // carry a `TABLE OF CONTENTS` whose `PART n —` rows sit inside a pipe
      // table, and those are rows, not divisions.
      if (div && !line.includes("|")) {
        // A stub heading whose own heading is printed again immediately below
        // it (`PART 4` then `PART 4 — AUDITOR'S DECLARATION`) is one division,
        // not two.
        let j = i + 1
        while (j < lines.length && lines[j].trim() === "") j++
        const nextDiv = j < lines.length ? SCHEDULE_DIVISION_RE.exec(lines[j].trim()) : null
        if (
          nextDiv &&
          !lines[j].includes("|") &&
          nextDiv[1].toUpperCase() === div[1].toUpperCase() &&
          nextDiv[2].toUpperCase() === div[2].toUpperCase()
        ) {
          continue
        }
        const sameLine = div[3]?.trim() ?? ""
        const below = sameLine ? 0 : titleLines(lines, i)
        const wrapped = sameLine ? "" : partTitle(lines, i)
        const title = [sameLine, wrapped].filter(Boolean).join(" ")
        const kind = div[1].toLowerCase()
        const num = div[2].toLowerCase().replace(/-/g, "_")
        const base = `${currentScheduleId}_${kind}${num}`
        // A Schedule can repeat a division number — the code-of-conduct
        // Schedules list every Part in a table of contents before the Parts
        // themselves — so a repeat is numbered rather than dropped by the id
        // dedup, which would lose the division's body.
        const seen = scheduleDivSeen.get(base) ?? 0
        scheduleDivSeen.set(base, seen + 1)
        starts.push({
          line: i,
          id: seen === 0 ? base : `${base}_${seen + 1}`,
          part: `# ${div[1].toUpperCase()} ${div[2]}${title ? ` — ${title}` : ""}`,
          partFrom: i,
          partBelow: below,
        })
      }
      continue
    }
    // Inside an appendix, a numbered entry (`5. G.N. No. S 344/1995 — …`) is a
    // list item in the Legislative History, not a section start.  The
    // appendices are the document tail, so nothing after one is a section.
    if (inAppendix) continue
    // A Part heading introduces the sections under it.  It is a divider, not a
    // section, so it is held until the next section start and rendered as a
    // `#` heading at the top of that section's body.  A Part inside a
    // Schedule is a sub-division of the Schedule, so it is only honoured
    // before the first Schedule heading.
    const part = PART_RE.exec(line.trim())
    if (part) {
      // A Part heading with no numbered section under it: the previous Part is
      // closed here rather than overwritten.
      flushPendingPart()
      // A Division heading above the new Part belongs to the old one, and no
      // section opened it — it is a stub, so it stays in the body.
      pendingDivision = null
      pendingSubdivision = null
      currentDivision = null
      // The title is either on the heading line, after the em dash (`PART C —
      // MACHINERY INSTALLATIONS`), or on the lines below the number (`PART B-1`
      // / `STABILITY`).
      const sameLine = part[2]?.trim() ?? ""
      const below = titleLines(lines, i)
      const wrapped = partTitle(lines, i)
      // A title can start on the heading line and wrap onto the next
      // (`PART B — REQUIREMENTS FOR SHIPS AND` / `LIFE-SAVING APPLIANCES`).
      const title = [sameLine, wrapped].filter(Boolean).join(" ")
      pendingPart = {
        text: title ? `# PART ${part[1]} — ${title}` : `# PART ${part[1]}`,
        from: i,
        to: i + below,
        token: part[1],
        below,
      }
      currentPart = { text: pendingPart.text }
      // The next section decides whether this Part restarts the numbering.
      currentPartNum = /^\d/.test(part[1]) ? parseInt(part[1], 10) : null
      restartPartNum = null
      awaitingPartFirst = true
      continue
    }
    // A Division heading introduces the sections under it.  It is a divider,
    // not a section, so it is held until the next section start and rendered as
    // a `#` heading above that section's marker, on the same line as its Part.
    const div = DIVISION_HEADING_RE.exec(line.trim())
    if (div) {
      // The "Division into Parts" table of contents lists its entries as body
      // text, and an entry is shaped exactly like a heading (`Division 2 —
      // Powers`).  Its next line is the range it covers (`sections 23‑41C,
      // 42A.`), where a real heading is followed by the section title it
      // introduces, so the range line marks the entry as body text.
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      if (j < lines.length && /^sections\s+\d/.test(lines[j].trim())) continue
      const sameLine = div[2]?.trim() ?? ""
      const wrapped = wrappedTitleBelow(lines, i, nextSectionStart(lines, i + 1, DIVISION_WINDOW))
      const title = [sameLine, wrapped.title].filter(Boolean).join(" ")
      // A bare `Division N` with no title is the tail of a wrapped title above
      // it (`… requirements in Division 5`), not a heading — the SSO always
      // prints a title — so it stays in the body and leaves the pending
      // Division alone.
      if (!title) continue
      // A new Division heading closes the previous one (and any Subdivision
      // under it) rather than being overwritten by it.
      const text = `# Division ${div[1]} — ${title}`
      pendingDivision = { text, from: i, below: wrapped.below }
      currentDivision = { text }
      pendingSubdivision = null
      continue
    }
    // A Subdivision heading introduces the sections under it, inside a
    // Division.  It is held and claimed exactly like a Division, and rendered
    // on the same `#` line as its Part and Division.
    const sub = SUBDIVISION_HEADING_RE.exec(line.trim())
    if (sub) {
      // A Subdivision entry in the "Division into Parts" table of contents is
      // followed by the range it covers (`sections 8‑12.`), like a Division
      // entry — see the Division branch above.
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      if (j < lines.length && /^sections\s+\d/.test(lines[j].trim())) continue
      const sameLine = sub[3]?.trim() ?? ""
      const wrapped = wrappedTitleBelow(lines, i, nextSectionStart(lines, i + 1, DIVISION_WINDOW))
      const title = [sameLine, wrapped.title].filter(Boolean).join(" ")
      // A bare `Subdivision N` with no title is the tail of a wrapped title
      // above it, not a heading.
      if (!title) continue
      const num = sub[1] ? `(${sub[1]})` : sub[2]
      pendingSubdivision = { text: `# Subdivision ${num} — ${title}`, from: i, below: wrapped.below }
      continue
    }
    // `49. to 53. [Repealed]` accounts for a run of repealed sections, so the
    // next real section may jump ahead by more than one.  Only honour it when
    // the range starts where the sequence left off — either the next number
    // (`49` after `48`) or the same number with a letter suffix (`4A` after
    // `4`).  The range start is itself emitted as a section, matching the
    // reference output.
    const range = REPEALED_RANGE_RE.exec(line)
    if (range) {
      const startNum = numericPart(range[1])
      const continues = startNum === lastNumber + 1 || (startNum === lastNumber && /[A-Z]/.test(range[1]))
      if (continues) {
        starts.push(claimHeadings(i, `s${range[1]}`))
        lastNumber = numericPart(range[2])
        // Sections between the range end and the next real section may also
        // have been deleted, so allow the next section to jump ahead.
        allowJump = true
        continue
      }
    }
    // A whole Part can be deleted without naming a section range: the heading
    // is followed by a bare `[Deleted by ...]` marker.  The next section then
    // jumps ahead, so allow it.
    if (BARE_DELETED_RE.test(line.trim())) {
      allowJump = true
      continue
    }
    // The first section under a Part decides whether the Part restarts its
    // numbering.  A restart drops the monotonic guards below so the sections
    // are not lost, and qualifies their ids with the Part number.
    if (awaitingPartFirst) {
      const probe = SECTION_START_RE.exec(line) ?? NUMBERED_TITLE_RE.exec(line) ?? BARE_NUMBER_RE.exec(line)
      if (probe && !isYear(numericPart(probe[1]))) {
        awaitingPartFirst = false
        if (numericPart(probe[1]) < lastNumber) restartPartNum = currentPartNum
      }
    }
    const m = SECTION_START_RE.exec(line)
    if (m) {
      const n = numericPart(m[1])
      // A year is not a section number — see `isYear`.
      if (isYear(n)) continue
      // Numbering must advance.  A backward jump is a wrapped fragment (a
      // specification number, a list item), not a section — skip it rather
      // than ending detection, since a stray number can appear anywhere.  A
      // Part that restarts its numbering is the exception.
      if (restartPartNum === null && n < lastNumber) continue
      // The first section may start above 1: an amending instrument can begin
      // at section 2 when section 1 is omitted.  A forward jump is otherwise
      // rejected.  (The Arrangement of Sections is not consulted for this
      // form: a wrapped cross-reference list ends `… section 16, 17 or` /
      // `18 — the Arts Entertainment Licensing Officer`, which is shaped like
      // `18.—` and would be accepted, collapsing every section below it.)
      // A forward jump is normally a wrapped cross-reference rather than a
      // section (`… section 16, 17 or` / `18 — the …`).  It is a section when
      // the Arrangement of Sections lists the number and it is set tight
      // against the dash (`11.—(1)`), which the wrapped form is not.
      const tight = /^\s*\d{1,4}[A-Z]{0,4}\.\s*[—–]/.test(line)
      if (
        starts.length > 0 &&
        restartPartNum === null &&
        !allowJump &&
        n > lastNumber + 1 &&
        !(tight && tocIds.has(m[1]))
      )
        continue
      starts.push(claimHeadings(i, sectionId(m[1])))
      lastNumber = n
      allowJump = false
      continue
    }
    const bare = BARE_NUMBER_RE.exec(line)
    if (bare && !PAGE_NUMBER_RE.test(line.trim())) {
      const n = numericPart(bare[1])
      // A wrapped date leaves the year on its own line, looking like a bare
      // section number — see `isYear`.
      if (isYear(n)) continue
      // A bare number is only a section start if it continues the sequence;
      // otherwise it is a wrapped sentence fragment ending in a year or figure.
      // Unlike the `N.—` and `N. Title` forms, the Arrangement of Sections is
      // not consulted here: a wrapped cross-reference list leaves its last
      // number alone on a line (`… sections 238, 239 or` / `240.`), which would
      // otherwise be accepted and collapse every section below it.
      if (restartPartNum !== null || n === lastNumber + 1 || (n === lastNumber && /[A-Z]/.test(bare[1])) || (allowJump && n > lastNumber)) {
        starts.push(claimHeadings(i, sectionId(bare[1])))
        lastNumber = n
        allowJump = false
      }
      continue
    }
    const titled = NUMBERED_TITLE_RE.exec(line)
    if (titled) {
      const n = numericPart(titled[1])
      // A wrapped date can also leave the year followed by a sentence's full
      // stop, matching `N. ` — see `isYear`.
      if (isYear(n)) continue
      // Accept a forward step of 1, the same number with a new letter suffix
      // (`8A` after `8`), a repealed section that continues the sequence, a
      // jump after a deleted range, a number declared in the Arrangement of
      // Sections (bridging a repealed run), a section of a Part that restarts
      // its numbering, or the first section of an amending instrument that
      // starts above 1.
      const repealed = REPEALED_SINGLE_RE.test(line)
      const first = starts.length === 0
      if (restartPartNum !== null || n === lastNumber + 1 || (n === lastNumber && /[A-Z]/.test(titled[1])) || (repealed && n > lastNumber) || (allowJump && n > lastNumber) || (tocIds.has(titled[1]) && n > lastNumber) || first) {
        starts.push(claimHeadings(i, sectionId(titled[1])))
        lastNumber = n
        allowJump = false
      }
    }
  }
  // A Part heading that ends the document, with no section after it.
  flushPendingPart()

  // The Part-sections are dividers for text that has no numbered sections
  // under it; put them back in document order with the numbered ones.
  if (partStarts.length > 0) {
    starts.push(...partStarts)
    starts.sort((a, b) => a.line - b.line)
  }

  if (starts.length === 0) {
    const body = reflowLegislationBody(text.trim())
    return body ? [{ id: "whole_doc", text: body }] : []
  }

  // Keep only the first occurrence of each id.  The Arrangement of Sections is
  // skipped above, but a document may still repeat a number (e.g. a schedule
  // that restarts numbering); the first is the operative one.
  const seen = new Set<string>()
  const unique: (typeof starts)[number][] = []
  for (const s of starts) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    unique.push(s)
  }

  // A section's heading sits immediately above its number, so it would fall at
  // the end of the previous section's body.  Walk each start back over its
  // heading lines so the heading opens the section it belongs to.  The walk is
  // bounded by the previous section's start, so it can never reach past a
  // section boundary, and by TITLE_MAX_LINES, so it cannot swallow body text.
  //
  // A title may wrap, and the continuation can start lower case
  // (`Accessing or disclosing identifying information, crew` /
  // `information or passenger information`).  A lower-case line is therefore
  // accepted as a continuation when the nearest non-blank line above it is a
  // heading that does not end a sentence — which is exactly the shape a
  // wrapped title has.  A page break can leave a blank line between the two
  // halves, so blanks are stepped over.
  //
  // A Schedule heading is itself the section's first line, so the walk must not
  // step over it: doing so would steal the last line of the preceding section's
  // body.
  const fromLine: number[] = unique.map((s, i) => {
    const floor = i > 0 ? unique[i - 1].line + 1 : bodyStart
    let from = s.line
    if (matchScheduleHeading(lines, s.line) || PART_RE.test(lines[s.line].trim())) return from
    // Set when the last step accepted a lower-case continuation, so the line
    // above it is the first half of the title rather than a marginal note.
    let continued = false
    for (let k = 0; k < TITLE_MAX_LINES && from - 1 >= floor; k++) {
      // Step over a blank line left by a page break inside a wrapped title.
      let at = from - 1
      while (at >= floor && !lines[at].trim()) at--
      if (at < floor) break
      const prev = lines[at].trim()
      // A wrapped title's first half may end with a comma
      // (`… identifying information,`), which `isHeadingLine` rejects.
      const commaHalf = prev.length <= 80 && /^[A-Z“"]/.test(prev) && /,$/.test(prev)
      if (isHeadingLine(prev) || (continued && commaHalf)) {
        // Two consecutive complete headings mean the upper one is a marginal
        // note (the running heading printed beside the section), not part of
        // the title.  A wrapped title's first half does not read as a complete
        // heading on its own — it ends mid-phrase — and its second half is a
        // short fragment (`Singapore by land`), not a title that stands alone.
        if (
          !continued &&
          from < s.line &&
          isCompleteHeading(prev) &&
          isCompleteHeading(lines[from].trim()) &&
          wordCount(prev) >= MARGINAL_NOTE_MIN_WORDS &&
          wordCount(lines[from].trim()) >= MARGINAL_NOTE_MIN_WORDS
        ) {
          break
        }
        from = at
        continued = false
        continue
      }
      // A wrapped-title continuation: lower case, and the nearest non-blank
      // line above it is a heading that does not end a sentence.  It must be
      // the line immediately above the number — a lower-case line further up
      // is the continuation of a marginal note, not of the title.
      if (from !== s.line) break
      let above = at - 1
      while (above >= floor && !lines[above].trim()) above--
      let aboveAbove = above - 1
      while (aboveAbove >= floor && !lines[aboveAbove].trim()) aboveAbove--
      if (
        above >= floor &&
        isTitleContinuation(prev, lines[above].trim(), aboveAbove >= floor ? lines[aboveAbove].trim() : "")
      ) {
        from = at
        continued = true
        continue
      }
      break
    }
    return from
  })

  const sections: LegislationSection[] = []
  for (let i = 0; i < unique.length; i++) {
    const from = fromLine[i]
    // A Part or Division heading introduces this section, so the previous
    // section's body ends where the heading begins — otherwise the bare
    // `PART 21` line would trail the previous section and the heading would be
    // duplicated.
    const partFrom = unique[i].partFrom
    const to = i + 1 < unique.length
      ? (unique[i + 1].partFrom ??
        unique[i + 1].divisionFrom ??
        unique[i + 1].subdivisionFrom ??
        fromLine[i + 1])
      : lines.length
    // The Part heading and its title are rendered as the `#` line, so they
    // are dropped from the body rather than repeated.
    const afterPart = unique[i].part
      ? partFrom! + 1 + (unique[i].partBelow ?? titleLines(lines, partFrom!))
      : from
    // The Division heading and its title are rendered above the marker too, so
    // the body starts below them — anything between the heading and the section
    // title (an amendment citation, a subdivision heading) stays in the body.
    const afterDivision = unique[i].division
      ? unique[i].divisionFrom! + 1 + (unique[i].divisionBelow ?? 0)
      : undefined
    // A Subdivision heading is rendered above the marker as well.
    const afterSubdivision = unique[i].subdivision
      ? unique[i].subdivisionFrom! + 1 + (unique[i].subdivisionBelow ?? 0)
      : undefined
    // The heading lines between the title start and the section number are the
    // section's title.  They are lifted onto the `## [id]` marker, so they are
    // dropped from the body rather than repeated.  A Part section starts the
    // walk below the Part title, but a marginal note may still sit between the
    // two, so the title is taken from whichever start is lower.  A division
    // marker (`CHAPTER 1`) and the division title above it (`PRELIMINARY`) are
    // not part of the section title, so they are dropped from the front of the
    // walk.  A division marker is dropped even when it is the only line,
    // because it is never a section title; an all-caps line is only dropped
    // when a title follows it.
    // The title sits below the Part, Division and Subdivision headings, so the
    // walk never reaches above them.
    const titleFrom = Math.max(
      unique[i].part ? afterPart : 0,
      afterDivision ?? 0,
      afterSubdivision ?? 0,
      from,
    )
    const titleLines_ = unique[i].heading
      ? []
      : lines.slice(titleFrom, unique[i].line).map((l) => l.trim()).filter(Boolean)
    while (titleLines_.length > 0 && DIVISION_RE.test(titleLines_[0])) titleLines_.shift()
    while (titleLines_.length > 1 && isAllCaps(titleLines_[0])) titleLines_.shift()
    const title = titleLines_.join(" ")
    // A Part section's body starts at the Part title's end, so anything the
    // title walk stepped over (an amendment citation, a marginal note) stays in
    // the body.  Only the lines that actually became the title are lifted out —
    // `titleLines_` is a suffix of the non-blank candidate lines, because the
    // stripping above only removes from the front.
    //
    // A non-Part section's body starts at its title start for the same reason:
    // the walk can step over an all-caps division or Part title (`PART IV` /
    // `METERED WATER CONSUMPTION AND WATER` / `CONSERVATION`) that is then
    // stripped from the title, and those lines must stay in the body rather
    // than vanish between the previous section's end and the section number.
    const candIdx: number[] = []
    for (let k = titleFrom; k < unique[i].line; k++) if (lines[k].trim()) candIdx.push(k)
    const titleIdx = new Set(
      titleLines_.length ? candIdx.slice(candIdx.length - titleLines_.length) : [],
    )
    // A Schedule / appendix heading is rendered above the marker, so it is
    // dropped from the body rather than repeated there.
    if (unique[i].heading) {
      for (let k = unique[i].line; k < unique[i].line + (unique[i].headingBelow ?? 1); k++) {
        titleIdx.add(k)
      }
    }
    // A Division heading is rendered above the marker too, and the title walk
    // may have stepped over it, so it is dropped from the body as well.
    if (unique[i].division && unique[i].divisionFrom !== undefined) {
      const divFrom = unique[i].divisionFrom
      for (let k = divFrom; k <= divFrom + (unique[i].divisionBelow ?? 0); k++) titleIdx.add(k)
    }
    // A Subdivision heading is rendered above the marker too.
    if (unique[i].subdivision && unique[i].subdivisionFrom !== undefined) {
      const subFrom = unique[i].subdivisionFrom
      for (let k = subFrom; k <= subFrom + (unique[i].subdivisionBelow ?? 0); k++) titleIdx.add(k)
    }
    // The extractor emits one line per visual line of the PDF; reflow joins
    // them back into paragraphs so a wrapped sentence is not cut across lines.
    const bodyFrom = unique[i].part
      ? afterPart
      : (afterDivision ?? afterSubdivision ?? titleFrom)
    const body = reflowLegislationBody(
      lines
        .slice(bodyFrom, to)
        .filter((_, k) => !titleIdx.has(bodyFrom + k))
        .join("\n")
        .trim(),
    )
    // A section with no body is normally dropped.  A divider that stands on
    // its own — a Schedule that opens straight into its first division, a Part
    // marked `INTENTIONALLY LEFT BLANK` — is kept, because its heading is the
    // only thing that marks it and the heading is dropped from the body below.
    if (!body) {
      const heading =
        unique[i].part ?? unique[i].division ?? unique[i].subdivision ?? unique[i].heading
      if (!heading) continue
      // A stub division whose own heading is printed again immediately below
      // it (`PART 4` then `PART 4 — AUDITOR'S DECLARATION`) is one division,
      // not two.
      const key = divisionKey(unique[i].part)
      if (key && divisionKey(unique[i + 1]?.part) === key) continue
      sections.push({
        id: unique[i].id,
        text: "",
        part: unique[i].part,
        division: unique[i].division,
        subdivision: unique[i].subdivision,
        divisionPart: unique[i].divisionPart,
        subdivisionDivision: unique[i].subdivisionDivision,
        heading: unique[i].heading,
      })
      continue
    }
    sections.push({
      id: unique[i].id,
      text: body,
      part: unique[i].part,
      division: unique[i].division,
      subdivision: unique[i].subdivision,
      divisionPart: unique[i].divisionPart,
      subdivisionDivision: unique[i].subdivisionDivision,
      heading: unique[i].heading,
      title: title || undefined,
    })
  }

  return sections
}

/** Tuning for {@link chunkLegislationSections}. */
export interface LegislationChunkOptions {
  /** Target size of each section, in `measure` units (Qwen3 tokens). */
  budget?: number
  /**
   * How to measure text.  Defaults to character length, which reproduces the
   * reference pipeline's character budget for the baseline tests; the parser
   * passes the Qwen3 token measure from `token-budget.ts`.
   */
  measure?: TextMeasure
}

/**
 * Split sections larger than the budget at paragraph boundaries.
 *
 * A section that fits keeps its id.  One that does not is split into
 * `sN_chunk1`, `sN_chunk2`, … — each at most `budget` units including its
 * `## [sN_chunkK]` header — so every chunk fits the embedding model's window.
 * Splitting only happens at a blank line, so a sentence, a list item and a
 * table row are never cut in half.
 *
 * @param sections Sections from {@link splitLegislationSections}.
 * @param opts Budget tuning.  The parser passes `{ budget: 1024, measure }`
 *   with the Qwen3 token measure (`token-budget.ts`); the defaults reproduce
 *   the reference pipeline's character budget.
 */
export async function chunkLegislationSections(
  sections: LegislationSection[],
  opts: LegislationChunkOptions = {},
): Promise<LegislationSection[]> {
  const measure = opts.measure ?? ((t: string) => t.length)
  const budget = opts.budget ?? DEFAULT_CHUNK_BUDGET
  const out: LegislationSection[] = []
  for (const s of sections) {
    // Reserve the rendered header (`## [sN_chunkK]` plus the blank line after
    // it) so the whole chunk, not just its body, stays inside the budget.  The
    // title is repeated on every chunk, so it is part of the header and is
    // measured too.  The extra two units cover a chunk index wider than the
    // `_chunk1` measured here.
    const headerLen = await measure(
      s.title ? `## [${s.id}_chunk1] ${s.title}\n\n` : `## [${s.id}_chunk1]\n\n`,
    )
    const bodyBudget = Math.max(1, budget - headerLen - 2)
    if ((await measure(s.text)) <= bodyBudget) {
      out.push(s)
      continue
    }
    const chunks = await groupByBudget(splitParagraphs(s.text), bodyBudget, measure)
    if (chunks.length <= 1) {
      out.push(s)
      continue
    }
    for (let i = 0; i < chunks.length; i++) {
      // The Part / Division / Schedule heading introduces the section, so it
      // belongs to the first chunk only — repeating it on every chunk would
      // duplicate it.  The section title, by contrast, is repeated on every
      // chunk so each chunk is self-describing.
      out.push({
        id: `${s.id}_chunk${i + 1}`,
        text: chunks[i],
        part: i === 0 ? s.part : undefined,
        division: i === 0 ? s.division : undefined,
        subdivision: i === 0 ? s.subdivision : undefined,
        divisionPart: i === 0 ? s.divisionPart : undefined,
        subdivisionDivision: i === 0 ? s.subdivisionDivision : undefined,
        heading: i === 0 ? s.heading : undefined,
        title: s.title,
      })
    }
  }
  return out
}

/**
 * Render sections as the Markdown the embed step reads.
 *
 * The format matches the reference parse notebook exactly so
 * the embedding step can consume the output unchanged:
 *
 *     ## [s1]
 *
 *     <body>
 *
 *     ---
 *
 *     ## [s2]
 *
 *     <body>
 *
 * A Part, Division, Subdivision, Schedule or appendix heading is emitted above
 * the `## [id]` marker, and the section's title is emitted on the marker line
 * itself:
 *
 *     # PART 4 — EXEMPTION FROM INCOME TAX
 *
 *     ## [s23] Capacity and powers of company
 *
 *     <body>
 *
 * A Division is a `#` heading like a Part, not a `##` one: `##` is the section
 * marker the embed step parses (`## [sN]`), so a Division must not use it.  The
 * divider chain is printed on one `#` line, so the PART > Division >
 * Subdivision hierarchy is a single heading that names every level:
 *
 *     # PART 10 — DISSOLUTION — Division 4 — Provisions applicable to every mode of winding up — Subdivision (5) — Dissolution
 *
 *     ## [s335] Dissolution
 *
 *     <body>
 */
export function renderLegislationMarkdown(sections: LegislationSection[]): string {
  return sections
    .map((s) => {
      const partLabel = s.divisionPart ?? s.part
      const divisionLabel = s.division ?? s.subdivisionDivision
      const divider = [partLabel, divisionLabel, s.subdivision].filter(Boolean)
      const heading = divider.length
        ? `# ${divider.map((l) => l!.replace(/^#\s+/, "")).join(" — ")}`
        : s.heading
      const marker = s.title ? `## [${s.id}] ${s.title}` : `## [${s.id}]`
      return heading ? `${heading}\n\n${marker}\n\n${s.text}` : `${marker}\n\n${s.text}`
    })
    .join("\n\n---\n\n")
}
