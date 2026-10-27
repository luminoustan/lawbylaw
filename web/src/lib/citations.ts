/**
 * Inline SSO links for statutory citations (ported from grpo's legislationCitations.ts).
 *
 * For each "Section N" / "s. N" mention (Acts) or "Regulation N" / "Rule N" mention
 * (subsidiary legislation) in an answer, link it to Singapore Statutes Online as
 * `[SSO](url)`. When several documents share a provision number, the nearest document
 * name picks the right one; if none is nearby the link is skipped rather than guessed.
 */

export interface Citation {
  act_name: string
  section: string
  label: string
  url: string
  /** `act` or `subsidiary_legislation`; absent on older payloads (treated as an Act). */
  doc_type?: string
}

const SSO_HOST = /^https:\/\/sso\.agc\.gov\.sg\//i

/** Server-supplied citations are untrusted input: keep only well-formed https SSO links. */
export function sanitizeCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return []
  const out: Citation[] = []
  for (const c of raw) {
    if (!c || typeof c !== "object") continue
    const { act_name, section, label, url, doc_type } = c as Record<string, unknown>
    if (typeof url !== "string" || !SSO_HOST.test(url) || /[\s()<>"]/.test(url)) continue
    out.push({
      act_name: typeof act_name === "string" ? act_name : "",
      section: typeof section === "string" ? section : "",
      label: typeof label === "string" && label ? label : url,
      url,
      doc_type: typeof doc_type === "string" ? doc_type : "act",
    })
  }
  return out
}

const SL_TYPE = "subsidiary_legislation"

/** Words that introduce a reference to a provision of subsidiary legislation. */
const SL_PREFIX = /^(?:regulations?|regs?\.?|rules?|r\.|paragraphs?|paras?\.?)$/i

/**
 * A provision reference may be followed by subsection parts and a range or list of
 * further subsections: "13(7A)–(8)", "13(1), (2) and (3)". The link goes after the
 * whole reference, never in the middle of it.
 */
const SUBSECTIONS = "(?:\\([\\w]+\\))*(?:\\s*(?:[\u2013\u2014-]|,|and|&)\\s*(?:\\([\\w]+\\))+)*"

/** "13–15" after a provision number: one link after the whole range, pointing at its first provision. */
const NUMBER_RANGE = "(?:\\s*[\u2013\u2014-]\\s*\\d+[A-Za-z]{0,3}(?![\\w]))?"

const ORDINALS = [
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth",
]

/**
 * "First Schedule", "Schedule 2", "the Schedule". The server cites a schedule as
 * "schedule1" ("schedule" for an Act's single unnumbered schedule).
 */
const SCHEDULE_RE = new RegExp(
  `(?<![\\w'\u2019])(?:(${ORDINALS.join("|")})\\s+schedule|schedule\\s+(\\d+)|(the\\s+schedule))(?![\\w])`,
  "gi",
)

const isScheduleKey = (k: string) => k.startsWith("schedule")

/** A link already follows this reference (ours from an earlier run, or one the model wrote). */
function alreadyLinked(text: string, end: number): boolean {
  const after = text.slice(end, end + 30)
  return after.startsWith(" [SSO]") || after.includes("sso.agc.gov.sg")
}

export interface EnrichOptions {
  /**
   * The text was cut short (the user pressed Stop, or the stream failed), so its last
   * words may be half a reference: "Section 1" is "Section 13" cut off. A reference that
   * runs to the very end of the text is left unlinked rather than guessed.
   */
  partial?: boolean
}

export function enrichWithCitations(text: string, citations: Citation[], opts: EnrichOptions = {}): string {
  if (!citations.length || !text) return text
  const limit = opts.partial ? text.trimEnd().length : Infinity

  const bySec = new Map<string, Citation[]>()
  for (const c of citations) {
    if (!c.section) continue
    const key = c.section.toLowerCase()
    const arr = bySec.get(key)
    if (arr) {
      if (!arr.some((x) => x.act_name === c.act_name)) arr.push(c)
    } else bySec.set(key, [c])
  }
  // Longest first so "13A" is matched before "13".
  const sections = [...bySec.keys()].filter((k) => !isScheduleKey(k)).sort((a, b) => b.length - a.length)

  const reps: Array<{ start: number; end: number; replacement: string }> = []
  let m: RegExpExecArray | null
  const re = new RegExp(
    // "s 19", "s. 19", "ss 19", "section 19": the bare "s" is how Singapore text usually
    // cites sections. Not after a word character or an apostrophe ("Lina's 19 vans").
    `(?<![\\w'\u2019])(sections?|ss?\\.?|regulations?|regs?\\.?|rules?|r\\.|paragraphs?|paras?\\.?)\\s*(${sections.map(escapeRegex).join("|")})${SUBSECTIONS}${NUMBER_RANGE}(?![\\w(])`,
    "gi",
  )
  while (sections.length && (m = re.exec(text)) !== null) {
    const candidates = bySec.get(m[2]!.toLowerCase())
    if (!candidates?.length) continue
    const end = m.index + m[0].length
    if (end >= limit || alreadyLinked(text, end)) continue
    const cit = pick(text, m.index, end, candidates, SL_PREFIX.test(m[1]!) ? "sl" : "act")
    if (!cit) continue
    reps.push({ start: m.index, end, replacement: `${m[0]} [SSO](${cit.url})` })
  }
  // Schedules never link on the mention alone: the document's name must be near it.
  SCHEDULE_RE.lastIndex = 0
  while ((m = SCHEDULE_RE.exec(text)) !== null) {
    const key = m[3] ? "schedule" : `schedule${m[1] ? ORDINALS.indexOf(m[1].toLowerCase()) + 1 : m[2]}`
    const candidates = bySec.get(key)
    if (!candidates?.length) continue
    const end = m.index + m[0].length
    if (end >= limit || alreadyLinked(text, end)) continue
    const cit = pick(text, m.index, end, candidates, "sl", true)
    if (!cit) continue
    reps.push({ start: m.index, end, replacement: `${m[0]} [SSO](${cit.url})` })
  }
  reps.sort((a, b) => a.start - b.start)
  let result = text
  for (let i = reps.length - 1; i >= 0; i--) {
    const r = reps[i]!
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end)
  }
  return result
}

/**
 * Pick the document a mention refers to.
 *
 * "Section 13" prefers Acts and "Regulation 13" / "Rule 13" prefers subsidiary
 * legislation. An Act with no competitor is linked on the section alone (the
 * long-standing behaviour); subsidiary legislation and any ambiguity need the
 * document's name near the mention, otherwise the link is skipped rather than
 * guessed. The name may come before ("Under the X Regulations, regulation 19")
 * or after ("regulation 19 of the X Regulations").
 */
function pick(
  text: string,
  start: number,
  end: number,
  candidates: Citation[],
  want: "act" | "sl",
  /** Require the document's name nearby, even for a lone Act. */
  strict = false,
): Citation | null {
  const isSl = (c: Citation) => c.doc_type === SL_TYPE
  const preferred = strict ? [] : candidates.filter((c) => isSl(c) === (want === "sl"))
  const pool = preferred.length ? preferred : candidates
  if (!strict && pool.length === 1 && !isSl(pool[0]!)) return pool[0]!

  const from = Math.max(0, start - 500)
  const window = text.slice(from, Math.min(text.length, end + 200)).toLowerCase()
  const at = start - from
  const atEnd = end - from
  let best: Citation | null = null
  let bestDist = Infinity
  for (const c of pool) {
    const name = c.act_name.toLowerCase()
    if (!name) continue
    for (let pos = window.indexOf(name); pos !== -1; pos = window.indexOf(name, pos + 1)) {
      const nameEnd = pos + name.length
      const dist = nameEnd <= at ? at - nameEnd : pos >= atEnd ? pos - atEnd : 0
      if (dist < bestDist) {
        bestDist = dist
        best = c
      }
    }
  }
  return best
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
