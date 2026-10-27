#!/usr/bin/env node
/**
 * Tier 1 — unit tests for the legislation section splitter
 * (`legislation/split.ts`).
 *
 * The splitter is a pure function of extracted text, so these tests pass
 * fixtures directly — no PDF or build step needed.  Run:
 *
 *   node scripts/tests/legislation-split.test.mjs
 *
 * Exits non-zero if any check fails, so `run-tests.sh` fails.
 */
import assert from "node:assert/strict"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")
const { chunkLegislationSections, renderLegislationMarkdown, splitLegislationSections } = await import(
  pathToFileURL(
    path.join(repoRoot, "src/legislation/split.ts"),
  ).href
)

let failed = 0

function check(name, fn) {
  try {
    fn()
    console.log(`  ok    ${name}`)
  } catch (e) {
    failed++
    console.error(`  FAIL  ${name}\n        ${e.message}`)
  }
}

/** Async variant, for the `await`-ing chunker. */
async function acheck(name, fn) {
  try {
    await fn()
    console.log(`  ok    ${name}`)
  } catch (e) {
    failed++
    console.error(`  FAIL  ${name}\n        ${e.message}`)
  }
}

const ids = (text) => splitLegislationSections(text).map((s) => s.id)

// A date that wraps across a line or page break leaves the year alone on a
// line, shaped exactly like a bare section start.  The `[Deleted by ...]`
// marker before it is what sets `allowJump`, which is how the year got
// accepted as a section in the Income Tax Act and swallowed the rest of it.
check("a wrapped date is not a section start", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "3.—(1) Regulations may be made to take effect from (and including) 1 January",
    "",
    "[Deleted by Act 30 of 2023 wef 15/02/2023]",
    "",
    "2024.",
    "",
    "[Act 25 of 2025 wef 08/12/2025]",
    "",
    "(17D) Further regulations.",
    "",
    "4.—(1) Income is ascertained.",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "s2", "s3", "s4"])
})

check("a bare year on its own is not a section", () => {
  assert.deepEqual(ids("2024."), ["whole_doc"])
})

check("a year followed by a title is not a section", () => {
  assert.deepEqual(ids("2024. Something happened."), ["whole_doc"])
})

check("a year does not interrupt a normal sequence", () => {
  const text = [
    "1. Short title",
    "",
    "2. Interpretation",
    "",
    "3. Application",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "s2", "s3"])
})

// ── Schedules ─────────────────────────────────────────────────────────

// A Schedule restarts numbering, so its rows must not become `sN` sections.
// It is emitted as its own section instead, in a namespace that cannot collide
// with `sN`.
check("a Schedule becomes its own section", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "FIRST SCHEDULE",
    "",
    "1. Foo",
    "",
    "2. Bar",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "s2", "schedule1"])
})

check("the last section does not swallow the Schedule", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "FIRST SCHEDULE",
    "",
    "1. Foo",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s2 = secs.find((s) => s.id === "s2")
  assert.ok(!s2.text.includes("FIRST SCHEDULE"), "s2 swallowed the Schedule heading")
  assert.ok(!s2.text.includes("1. Foo"), "s2 swallowed the Schedule body")
})

check("numbered Schedules get numbered ids", () => {
  const text = [
    "1. Short title",
    "",
    "FIRST SCHEDULE",
    "",
    "1. Foo",
    "",
    "SECOND SCHEDULE",
    "",
    "1. Bar",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "schedule1", "schedule2"])
})

check("a bare THE SCHEDULE gets the unnumbered id", () => {
  const text = ["1. Short title", "", "THE SCHEDULE", "", "1. Foo"].join("\n")
  assert.deepEqual(ids(text), ["s1", "schedule"])
})

check("a Schedule-only instrument is not whole_doc", () => {
  const text = ["THE SCHEDULE", "", "1. Foo", "", "2. Bar"].join("\n")
  assert.deepEqual(ids(text), ["schedule"])
})

// A page break repeats the heading as `FIRST SCHEDULE — continued`.  That is
// the same Schedule, not a new one.
check("a continued Schedule heading does not open a second section", () => {
  const text = [
    "1. Short title",
    "",
    "FIRST SCHEDULE",
    "",
    "1. Foo",
    "",
    "FIRST SCHEDULE — continued",
    "",
    "2. Bar",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "schedule1"])
})

// The Arrangement of Sections lists `First Schedule — Institution, ...` before
// the body.  It is a TOC entry, not the Schedule itself.
check("a TOC Schedule entry does not open a Schedule", () => {
  const text = [
    "ARRANGEMENT OF SECTIONS",
    "",
    "1. Short title",
    "",
    "2. Interpretation",
    "",
    "First Schedule — Institution, authority, person",
    "",
    "An Act relating to things.",
    "",
    "[1 January 1948]",
    "",
    "1. Short title",
    "",
    "2.—(1) Interpretation.",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "s2"])
})

// A Schedule's rows restart at 1, so without the namespace they would be read
// as a backward jump and dropped — or, worse, accepted as sections.
check("Schedule rows do not become sections", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "FIRST SCHEDULE",
    "",
    "1. Foo",
    "",
    "2. Bar",
    "",
    "3. Baz",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "s2", "schedule1"])
})

// A wide heading font wraps `FIRST SCHEDULE` across two lines — the Central
// Provident Fund Act 1953 sets it as `FIRST` / `SCHEDULE`, and its page-break
// continuation as `FIRST` / `SCHEDULE` / `—` / `continued`.
check("a Schedule heading wrapped across two lines is recognised", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "FIRST",
    "SCHEDULE",
    "",
    "1. Foo",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "s2", "schedule1"])
})

check("a wrapped continued Schedule heading does not open a second section", () => {
  const text = [
    "1. Short title",
    "",
    "FIRST",
    "SCHEDULE",
    "",
    "1. Foo",
    "",
    "FIRST",
    "SCHEDULE",
    "—",
    "continued",
    "",
    "2. Bar",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "schedule1"])
})

// ── Section titles ────────────────────────────────────────────────────

// A section's title sits immediately above its number, so it would otherwise
// fall at the end of the previous section's body.  It is lifted onto the
// `## [id]` marker instead.
check("a section title is lifted onto the marker line", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Power to detain stolen vehicle within authorised area, etc.",
    "3.—(1) This section applies to a vehicle that —",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.title, "Power to detain stolen vehicle within authorised area, etc.")
  assert.ok(!s3.text.includes("Power to detain"), "the title is still in the body")
  const s2 = secs.find((s) => s.id === "s2")
  assert.ok(!s2.text.includes("Power to detain"), "the title trails the previous section")
  const md = renderLegislationMarkdown(secs)
  assert.ok(
    md.includes("## [s3] Power to detain stolen vehicle within authorised area, etc.\n\n"),
    md.slice(-160),
  )
})

// A title ending in an abbreviation (`etc.`) is still a title, not a sentence.
check("a title ending in an abbreviation is recognised", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Power to arrest other persons within authorised area, etc.",
    "3.—(1) This section applies to a person.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.equal(secs.find((s) => s.id === "s3").title, "Power to arrest other persons within authorised area, etc.")
})

// A division marker (`CHAPTER 1`) and the division title above it
// (`PRELIMINARY`) are not part of the section title.
check("a division heading is not part of the section title", () => {
  const text = [
    "CHAPTER 1",
    "PRELIMINARY",
    "Short title",
    "1. This Act is the Test Act 2026.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.equal(secs[0].title, "Short title")
})

// A wrapped title is joined onto one marker line.
check("a wrapped section title is joined", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Power to detain stolen vehicle within",
    "Authorised Area",
    "3.—(1) This section applies to a vehicle.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.equal(secs.find((s) => s.id === "s3").title, "Power to detain stolen vehicle within Authorised Area")
})

// A wrapped title whose continuation starts lower case, with a page break
// between the halves — the Immigration Act 1959's s36C.
check("a wrapped title with a lower-case continuation is joined", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Accessing or disclosing identifying information, crew",
    "",
    "information or passenger information",
    "3.—(1) If a person accesses identifying information.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(
    s3.title,
    "Accessing or disclosing identifying information, crew information or passenger information",
  )
  assert.ok(!s3.text.includes("Accessing or disclosing"), "the title is still in the body")
  const s2 = secs.find((s) => s.id === "s2")
  assert.ok(!s2.text.includes("Accessing or disclosing"), "the title trails the previous section")
  const md = renderLegislationMarkdown(secs)
  assert.ok(
    md.includes(
      "## [s3] Accessing or disclosing identifying information, crew information or passenger information\n\n",
    ),
    md.slice(-200),
  )
})

// A lower-case line following a sentence-ending line is a new sentence, not a
// title continuation, so it must not be absorbed into the title.
check("a lower-case body line is not absorbed into the title", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Interpretation",
    "3.—(1) In this Act, unless the context otherwise requires —",
    "",
    "the following words have the meanings given.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.title, "Interpretation")
  assert.ok(s3.text.includes("the following words"), "the body line was absorbed into the title")
})

// A mid-sentence body line that happens to start upper case must not be read
// as the first half of a wrapped title.
check("a mid-sentence body line is not read as a title", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "the report when preparing the Guardian-in-Adoption’s affidavit.",
    "",
    "Significance of Guardian-in-Adoption’s affidavit",
    "3.—(1) The court must give due consideration to the affidavit.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.title, "Significance of Guardian-in-Adoption’s affidavit")
})

// A division heading and its wrapped title are lifted onto the marker, not
// absorbed into the section title.
check("a wrapped division heading is not absorbed into the title", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Division 3 — Role of Guardian-in-Adoption in",
    "adoption proceedings",
    "Duty of Guardian-in-Adoption to file affidavit",
    "3.—(1) Upon the making of an adoption application.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.title, "Duty of Guardian-in-Adoption to file affidavit")
  assert.equal(s3.division, "# Division 3 — Role of Guardian-in-Adoption in adoption proceedings")
  assert.ok(!s3.text.includes("Division 3"), `the division heading was left in the body: ${s3.text}`)
  const s2 = secs.find((s) => s.id === "s2")
  assert.ok(!s2.text.includes("Division 3"), `the division heading trails the previous section: ${s2.text}`)
})

// A marginal note (the running heading printed beside the section) sits above
// the title.  Only the title belongs on the marker.
check("a marginal note above the title is not absorbed", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Letters of administration limited to collection and preservation of",
    "property",
    "Letters of administration to collect and preserve property",
    "3.—(1) In any case in which it appears necessary.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.title, "Letters of administration to collect and preserve property")
})

// A title that wraps across a page break, where the first half reads as a
// complete heading and the second half is a short fragment.
check("a title wrapped across a page break is joined", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Provision in advance by person due to arrive in or due to leave",
    "Singapore by land",
    "3.—(1) This section applies to a person.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.title, "Provision in advance by person due to arrive in or due to leave Singapore by land")
})

// A title whose first half ends with a comma and whose second half starts
// lower case, separated by a page break.
check("a title wrapped at a comma is joined", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Authorising access to or disclosure of identifying information,",
    "",
    "crew information and passenger information",
    "3.—(1) The Minister may, in writing, authorise a specified person.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(
    s3.title,
    "Authorising access to or disclosure of identifying information, crew information and passenger information",
  )
})

// The section title is repeated on every chunk, so each chunk is
// self-describing.  The Part / Schedule heading is still carried onto the
// first chunk only.
await acheck("the section title is repeated on every chunk", async () => {
  const text = [
    "Regulations",
    "1.—(1) " + "The Minister may make regulations. ".repeat(200),
  ].join("\n")
  const secs = await chunkLegislationSections(splitLegislationSections(text), { budget: 400 })
  assert.ok(secs.length > 1, "the section did not chunk")
  for (const s of secs) assert.equal(s.title, "Regulations", `${s.id} lost the title`)
  const md = renderLegislationMarkdown(secs)
  assert.equal(md.split("## [s1_chunk1] Regulations").length - 1, 1)
  assert.equal(md.split("## [s1_chunk2] Regulations").length - 1, 1)
})

// Repeating the title makes the header longer, so the budget must account for
// it — otherwise a titled chunk could overshoot the embedding window.
await acheck("a titled section's chunks each fit the budget", async () => {
  const budget = 200
  const body = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ${"x".repeat(30)}.`).join(" ")
  const text = ["Interpretation", "1.—(1) " + body].join("\n")
  const out = await chunkLegislationSections(splitLegislationSections(text), {
    budget,
    measure: (t) => t.length,
  })
  assert.ok(out.length > 1, "the section did not chunk")
  for (const s of out) {
    assert.equal(s.title, "Interpretation", `${s.id} lost the title`)
    const rendered = `## [${s.id}] ${s.title}\n\n${s.text}`
    assert.ok(rendered.length <= budget, `${s.id} is ${rendered.length} > ${budget}`)
  }
})

// ── Parts ─────────────────────────────────────────────────────────────

// A Part is a divider, not a retrievable unit: it has no body of its own, so
// it is carried on the section it introduces and rendered as a `#` heading
// *above* the `## [sN]` marker rather than becoming a section id.
check("a Part heading opens the next section as a # heading", () => {
  const text = [
    "PART 1",
    "PRELIMINARY",
    "Short title",
    "1. This Act is the Test Act 2026.",
    "",
    "PART 2",
    "ADMINISTRATION",
    "Comptroller",
    "2.—(1) There is to be a Comptroller.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s1", "s2"])
  assert.equal(secs[0].part, "# PART 1 — PRELIMINARY")
  assert.equal(secs[1].part, "# PART 2 — ADMINISTRATION")
  // The section still carries its own title, and it is lifted onto the marker
  // rather than left at the top of the body.
  assert.equal(secs[0].title, "Short title")
  assert.equal(secs[1].title, "Comptroller")
  const md = renderLegislationMarkdown(secs)
  assert.ok(
    md.startsWith("# PART 1 — PRELIMINARY\n\n## [s1] Short title\n\n"),
    md.slice(0, 60),
  )
  assert.ok(
    md.includes("# PART 2 — ADMINISTRATION\n\n## [s2] Comptroller\n\n"),
    "the Part heading is not above the section marker",
  )
})

// A marginal note (the running heading) can sit between the Part title and the
// section number — the Immigration Act 1959's s5, where the note repeats the
// Part title.  It is the section's title, so it belongs on the marker, not at
// the top of the body.
check("a marginal note below a Part title becomes the section title", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "PART 2",
    "ENTRY INTO AND DEPARTURE FROM SINGAPORE",
    "Entry into and departure from Singapore",
    "3.—(1) The Minister may prescribe approved routes.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.part, "# PART 2 — ENTRY INTO AND DEPARTURE FROM SINGAPORE")
  assert.equal(s3.title, "Entry into and departure from Singapore")
  assert.ok(!s3.text.includes("Entry into and departure"), "the title is still in the body")
  assert.ok(s3.text.startsWith("3.—(1)"), s3.text.slice(0, 40))
  const md = renderLegislationMarkdown(secs)
  assert.ok(
    md.includes(
      "# PART 2 — ENTRY INTO AND DEPARTURE FROM SINGAPORE\n\n## [s3] Entry into and departure from Singapore\n\n3.—(1)",
    ),
    md.slice(-160),
  )
})

check("the Part heading is not repeated in the body", () => {
  const text = [
    "PART 1",
    "PRELIMINARY",
    "Short title",
    "1. This Act is the Test Act 2026.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const body = secs[0].text
  assert.equal(body.split("PRELIMINARY").length - 1, 0, "PRELIMINARY is still in the body")
  assert.ok(!body.includes("\nPART 1\n"), "the bare PART 1 line is still in the body")
})

check("the Part heading is not left trailing the previous section", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "PART 2",
    "ADMINISTRATION",
    "3.—(1) There is to be a Comptroller.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s2 = secs.find((s) => s.id === "s2")
  assert.ok(!s2.text.includes("PART 2"), "s2 trails the PART 2 heading")
  assert.equal(secs.find((s) => s.id === "s3").part, "# PART 2 — ADMINISTRATION")
})

check("a Part title wrapped over two lines is joined", () => {
  const text = [
    "PART 20B",
    "INTERNATIONAL AGREEMENTS TO",
    "IMPROVE TAX COMPLIANCE",
    "1. Short title",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.equal(secs[0].part, "# PART 20B — INTERNATIONAL AGREEMENTS TO IMPROVE TAX COMPLIANCE")
})

// The Part heading introduces the section, so it belongs to the first chunk
// only — repeating it on every chunk would duplicate the heading.
await acheck("the Part heading is carried onto the first chunk only", async () => {
  const text = [
    "PART 4",
    "EXEMPTION FROM INCOME TAX",
    "13.—(1) " + "Income is exempt. ".repeat(200),
  ].join("\n")
  const secs = await chunkLegislationSections(splitLegislationSections(text), { budget: 400 })
  assert.ok(secs.length > 1, "the section did not chunk")
  assert.equal(secs[0].part, "# PART 4 — EXEMPTION FROM INCOME TAX")
  for (const s of secs.slice(1)) assert.equal(s.part, undefined, `${s.id} repeats the Part heading`)
  const md = renderLegislationMarkdown(secs)
  assert.equal(md.split("# PART 4").length - 1, 1, "the Part heading is rendered more than once")
})

// `PART A` / `PART 1` also divide a Schedule.  Those are sub-divisions of the
// Schedule, not Parts of the Act, so they must not be promoted.
check("a Part inside a Schedule opens a Schedule-scoped section", () => {
  const text = [
    "1. Short title",
    "",
    "FIRST SCHEDULE",
    "",
    "PART 1",
    "GENERAL",
    "1. Foo",
  ].join("\n")
  const secs = splitLegislationSections(text)
  // The Schedule has no body of its own; it is kept as a divider so its
  // heading (and id) survives, and the division opens the section after it.
  assert.deepEqual(secs.map((s) => s.id), ["s1", "schedule1", "schedule1_part1"])
  assert.equal(secs[1].text, "")
  assert.equal(secs[2].part, "# PART 1 — GENERAL")
  const md = renderLegislationMarkdown(secs)
  assert.ok(
    md.includes("# FIRST SCHEDULE\n\n## [schedule1]\n\n"),
    md,
  )
  assert.ok(md.includes("# PART 1 — GENERAL\n\n## [schedule1_part1]\n\n"), md)
})

// A Schedule that runs to dozens of divisions must not become one enormous
// section: the Strategic Goods (Control) Order 2025's Schedule has two Parts
// and the Home Protection Insurance Scheme's First Schedule has twenty tables,
// and each split into 50 unlabelled chunks before the divisions were sections.
check("divisions inside a Schedule are sections of their own", () => {
  const text = [
    "1. Short title",
    "",
    "FIRST SCHEDULE",
    "Regulation 2(1)",
    "",
    "TABLE 1",
    "HOME PROTECTION INSURANCE",
    "| a | b |",
    "",
    "TABLE 2",
    "SURRENDER VALUES",
    "| c | d |",
    "",
    "SECOND SCHEDULE",
    "",
    "PART 1",
    "GENERAL",
    "1. Foo",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), [
    "s1",
    "schedule1",
    "schedule1_table1",
    "schedule1_table2",
    "schedule2",
    "schedule2_part1",
  ])
  assert.equal(secs[1].heading, "# FIRST SCHEDULE")
  assert.ok(!secs[1].text.includes("FIRST SCHEDULE"), "the Schedule heading is repeated in the body")
  assert.equal(secs[2].part, "# TABLE 1 — HOME PROTECTION INSURANCE")
  assert.ok(secs[2].text.startsWith("| a | b |"), secs[2].text)
  assert.equal(secs[3].part, "# TABLE 2 — SURRENDER VALUES")
  assert.equal(secs[5].part, "# PART 1 — GENERAL")
})

// A table-of-contents row (`| PART 1 — | COMPLYING WITH … |`) is not a
// division, and a repeated division number is numbered rather than dropped.
// A division heading can follow another one directly — a Part whose text is
// intentionally blank sits above the Part that follows it.
check("consecutive Schedule divisions are separate sections", () => {
  const text = [
    "1. Short title",
    "",
    "THE SCHEDULE",
    "",
    "PART 1 — INTENTIONALLY LEFT BLANK",
    "PART 2 — PUBLIC ACCOUNTANTS",
    "1. Body two",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s1", "schedule", "schedule_part1", "schedule_part2"])
  assert.equal(secs[2].part, "# PART 1 — INTENTIONALLY LEFT BLANK")
  assert.equal(secs[3].part, "# PART 2 — PUBLIC ACCOUNTANTS")
  assert.ok(secs[3].text.includes("1. Body two"), secs[3].text)
})

check("a table-of-contents row is not a Schedule division", () => {
  const text = [
    "1. Short title",
    "",
    "THE SCHEDULE",
    "",
    "TABLE OF CONTENTS",
    "| PART 1 — | COMPLYING WITH THE CODE |",
    "| PART 2 — | INTENTIONALLY LEFT BLANK |",
    "",
    "PART 1 — COMPLYING WITH THE CODE",
    "1. Body one",
    "",
    "PART 2 — INTENTIONALLY LEFT BLANK",
    "2. Body two",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s1", "schedule", "schedule_part1", "schedule_part2"])
  assert.ok(secs[1].text.includes("TABLE OF CONTENTS"), "the TOC is the Schedule's preamble")
  assert.equal(secs[2].part, "# PART 1 — COMPLYING WITH THE CODE")
  assert.ok(!secs[2].text.includes("TABLE OF CONTENTS"), "the TOC was split off")
})

// A division heading between the Part title and the section number is not the
// section title, so it is lifted onto the marker — dropping it would lose it.
// The Air Navigation Act 1966's s49 has `Division 1 — Repealed` above a
// repealed range, with no title of its own.
check("a division heading below a Part title is lifted onto the marker", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "PART 3",
    "AIR TRANSPORT",
    "[Act 36 of 2018 wef 01/01/2024]",
    "Division 1 — Repealed",
    "3. to 5. [Repealed by Act 36 of 2018 wef 01/01/2024]",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.part, "# PART 3 — AIR TRANSPORT")
  assert.equal(s3.division, "# Division 1 — Repealed")
  assert.equal(s3.title, undefined)
  assert.ok(!s3.text.includes("Division 1"), `the division heading was left in the body: ${s3.text}`)
  assert.ok(s3.text.includes("[Act 36 of 2018 wef 01/01/2024]"), "the citation was dropped")
})

// A Division heading introduces the sections under it, so it is rendered above
// the marker of the first section it covers.  The Companies Act 1967's Part 3
// has `Division 1 — Incorporation` above s17 and `Division 2 — Powers` above
// s23.
check("a Division heading is lifted onto the section it introduces", () => {
  const text = [
    "PART 3",
    "CONSTITUTION OF COMPANIES",
    "Division 1 — Incorporation",
    "Formation of companies",
    "17.—(1) Subject to the provisions of this Act, any person may form a company.",
    "",
    "Division 2 — Powers",
    "Capacity and powers of company",
    "18.—(1) A company has the capacity to do anything.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s17", "s18"])
  assert.equal(secs[0].part, "# PART 3 — CONSTITUTION OF COMPANIES")
  assert.equal(secs[0].division, "# Division 1 — Incorporation")
  assert.equal(secs[0].divisionPart, undefined)
  assert.equal(secs[0].title, "Formation of companies")
  assert.ok(!secs[0].text.includes("Division 1"), `the division heading was left in the body: ${secs[0].text}`)
  assert.equal(secs[1].part, undefined)
  assert.equal(secs[1].division, "# Division 2 — Powers")
  // The Part heading was claimed by s17, but Division 2 still names its Part.
  assert.equal(secs[1].divisionPart, "# PART 3 — CONSTITUTION OF COMPANIES")
  assert.equal(secs[1].title, "Capacity and powers of company")
  assert.ok(!secs[1].text.includes("Division 2"), `the division heading was left in the body: ${secs[1].text}`)
  // The Division is rendered on the same `#` line as its Part, above the
  // marker, so the PART > Division hierarchy is one heading.
  const md = renderLegislationMarkdown(secs)
  assert.ok(
    md.includes(
      "# PART 3 — CONSTITUTION OF COMPANIES — Division 1 — Incorporation\n\n## [s17] Formation of companies\n\n",
    ),
    md.slice(0, 300),
  )
  assert.ok(
    md.includes(
      "# PART 3 — CONSTITUTION OF COMPANIES — Division 2 — Powers\n\n## [s18] Capacity and powers of company\n\n",
    ),
    md.slice(0, 500),
  )
})

// A Part can hold sections of its own before its first Division.  The Part
// heading is claimed by that first section, so the later Division must carry
// the Part itself — and the first section's body must not be cut at the Part.
check("a Division below a Part's own section still names the Part", () => {
  const text = [
    "PART 1",
    "GENERAL",
    "Short title",
    "1. This Act may be cited as the Companies Act 1967.",
    "",
    "Division 2 — Powers",
    "Capacity and powers of company",
    "2. A company has the capacity to do anything.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s1", "s2"])
  assert.equal(secs[0].part, "# PART 1 — GENERAL")
  assert.equal(secs[0].division, undefined)
  assert.equal(secs[0].title, "Short title")
  assert.ok(secs[0].text.includes("This Act may be cited"), `the first section's body was lost: ${secs[0].text}`)
  assert.equal(secs[1].part, undefined)
  assert.equal(secs[1].division, "# Division 2 — Powers")
  assert.equal(secs[1].divisionPart, "# PART 1 — GENERAL")
  const md = renderLegislationMarkdown(secs)
  assert.ok(md.includes("# PART 1 — GENERAL\n\n## [s1] Short title\n\n"), md.slice(0, 300))
  assert.ok(
    md.includes("# PART 1 — GENERAL — Division 2 — Powers\n\n## [s2] Capacity and powers of company\n\n"),
    md.slice(0, 500),
  )
})

// The "Division into Parts" table of contents lists its entries as body text,
// and an entry is shaped exactly like a heading.  Its next line is the range it
// covers, where a real heading is followed by the section title it introduces.
check("a Division table-of-contents entry is not a heading", () => {
  const text = [
    "1. Short title",
    "",
    "2. This Act is divided into Divisions as follows:",
    "Division 1 — Incorporation",
    "sections 17‑22.",
    "Division 2 — Powers",
    "sections 23‑41C, 42A.",
    "",
    "3.—(1) The written laws mentioned in the First Schedule are repealed.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s1", "s2", "s3"])
  assert.ok(secs.every((s) => s.division === undefined), "a table-of-contents entry became a heading")
  assert.ok(secs[1].text.includes("Division 2 — Powers"), `the TOC entry was dropped: ${secs[1].text}`)
})

// A Division heading that no section follows is a stub, not a divider, so it
// stays in the body rather than becoming a heading on the next section.
check("a Division heading with no section under it stays in the body", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Division 2 — Powers",
    "",
    "PART 4",
    "SHARES",
    "3.—(1) A share is movable property.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.part, "# PART 4 — SHARES")
  assert.equal(s3.division, undefined)
  assert.ok(secs[1].text.includes("Division 2 — Powers"), `the stub heading was dropped: ${secs[1].text}`)
})

// A wrapped Division title can end in a line that looks like a bare heading
// (`… requirements in Division 5`); it is a title tail, not a second heading.
check("a wrapped Division title ending in `Division N` is not a second heading", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Division 6 — Non-compliance with certain",
    "requirements in Division 5",
    "Consequences of non-compliance with certain requirements in",
    "Division 5",
    "3.—(1) The court may draw such inference as it thinks fit.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.division, "# Division 6 — Non-compliance with certain requirements in Division 5")
  assert.equal(s3.title, "Consequences of non-compliance with certain requirements in Division 5")
  assert.ok(!s3.text.includes("Division 5"), `the title tail leaked into the body: ${s3.text}`)
})

// A wrapped title can continue in upper case when a citation follows it —
// `… Revision of proceedings before` / `State Courts` / `[5/2014]`.
check("a wrapped Division title continued in upper case before a citation is joined", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Division 3 — Revision of proceedings before",
    "State Courts",
    "",
    "[5/2014]",
    "Power to call for records of State Courts",
    "3.—(1) The General Division may call for and examine the record.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.division, "# Division 3 — Revision of proceedings before State Courts")
  assert.equal(s3.title, "Power to call for records of State Courts")
  assert.ok(s3.text.includes("[5/2014]"), `the citation was dropped: ${s3.text}`)
})

// A title that cannot end where it does (`… Business of`) continues on the
// next line even though that line opens with a capital.
check("a Division title ending in a function word continues on the next line", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Division 5 — Voluntary Transfer of Business of",
    "Approved Exchange or Recognised Market Operator",
    "Interpretation of this Division",
    "3.—(1) In this Division, unless the context otherwise requires —",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(
    s3.division,
    "# Division 5 — Voluntary Transfer of Business of Approved Exchange or Recognised Market Operator",
  )
  assert.equal(s3.title, "Interpretation of this Division")
})

// A title continued before a subdivision heading is joined too.
check("a Division title continued before a subdivision heading is joined", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Division 2 — Regulation of Licensed",
    "Trade Repositories",
    "Subdivision (1) — Obligations of licensed trade repositories",
    "3.—(1) A licensed trade repository must comply with this Act.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.division, "# Division 2 — Regulation of Licensed Trade Repositories")
})

// Anything between the Division heading and the section title — an amendment
// citation, a subdivision heading — stays in the body rather than falling
// between the previous section's end and this one's start.
check("a citation between the Division heading and the title stays in the body", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Division 4 — Register of members kept by public company",
    "[36/2014]",
    "Application and interpretation of Division",
    "3.—(1) This Division applies only in relation to a public company.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.division, "# Division 4 — Register of members kept by public company")
  assert.equal(s3.title, "Application and interpretation of Division")
  assert.ok(s3.text.includes("[36/2014]"), `the citation was dropped: ${s3.text}`)
  const s2 = secs.find((s) => s.id === "s2")
  assert.ok(!s2.text.includes("[36/2014]"), `the citation trails the previous section: ${s2.text}`)
})

// ── Subdivisions ──────────────────────────────────────────────────────

// A Subdivision is the fourth level, inside a Division inside a Part.  It is
// lifted onto the section it introduces and printed on the same `#` line as
// the levels above it, so the hierarchy is one heading.
check("a Subdivision heading is lifted onto the section it introduces", () => {
  const text = [
    "PART 2",
    "INTERPRETATION",
    "Division 2 — Works and performances",
    "What is a work",
    "3.—(1) A work is an original literary work.",
    "",
    "Subdivision (1) — Performances",
    "What is a performance",
    "4.—(1) A performance means a live performance.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s3", "s4"])
  assert.equal(secs[0].part, "# PART 2 — INTERPRETATION")
  assert.equal(secs[0].division, "# Division 2 — Works and performances")
  assert.equal(secs[0].subdivision, undefined)
  assert.equal(secs[1].part, undefined)
  assert.equal(secs[1].division, undefined)
  assert.equal(secs[1].subdivision, "# Subdivision (1) — Performances")
  // The Part and Division headings were claimed by s3, but the Subdivision
  // still names them.
  assert.equal(secs[1].divisionPart, "# PART 2 — INTERPRETATION")
  assert.equal(secs[1].subdivisionDivision, "# Division 2 — Works and performances")
  assert.ok(!secs[1].text.includes("Subdivision (1)"), `the heading was left in the body: ${secs[1].text}`)
  const md = renderLegislationMarkdown(secs)
  assert.ok(
    md.includes(
      "# PART 2 — INTERPRETATION — Division 2 — Works and performances — Subdivision (1) — Performances\n\n## [s4] What is a performance\n\n",
    ),
    md.slice(0, 500),
  )
})

// A Subdivision that opens its own Division and Part (the first heading under
// them) renders the same combined line.
check("a Subdivision opening a Division names its Part too", () => {
  const text = [
    "PART 10",
    "DISSOLUTION",
    "Division 4 — Provisions applicable to every mode of winding up",
    "Subdivision (5) — Dissolution",
    "Dissolution",
    "5.—(1) The Court may order the winding up of a company.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.equal(secs.length, 1)
  assert.equal(secs[0].part, "# PART 10 — DISSOLUTION")
  assert.equal(secs[0].division, "# Division 4 — Provisions applicable to every mode of winding up")
  assert.equal(secs[0].subdivision, "# Subdivision (5) — Dissolution")
  assert.equal(secs[0].divisionPart, undefined)
  assert.equal(secs[0].subdivisionDivision, undefined)
  assert.equal(secs[0].title, "Dissolution")
  const md = renderLegislationMarkdown(secs)
  assert.ok(
    md.includes(
      "# PART 10 — DISSOLUTION — Division 4 — Provisions applicable to every mode of winding up — Subdivision (5) — Dissolution\n\n## [s5] Dissolution\n\n",
    ),
    md.slice(0, 500),
  )
})

// A Subdivision heading is shaped exactly like a table-of-contents entry, whose
// next line is the range it covers.
check("a Subdivision table-of-contents entry is not a heading", () => {
  const text = [
    "1. Short title",
    "",
    "2. This Act is divided into Divisions as follows:",
    "Division 2 — Works and performances",
    "sections 8‑18.",
    "Subdivision (1) — Works",
    "sections 8‑12.",
    "Subdivision (2) — Performances",
    "sections 13‑18.",
    "",
    "3.—(1) The written laws mentioned in the First Schedule are repealed.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s1", "s2", "s3"])
  assert.ok(secs.every((s) => s.subdivision === undefined), "a table-of-contents entry became a heading")
  assert.ok(secs.every((s) => s.division === undefined), "a table-of-contents entry became a heading")
  assert.ok(secs[1].text.includes("Subdivision (1) — Works"), `the TOC entry was dropped: ${secs[1].text}`)
})

// A Subdivision title wraps like a Division title.
check("a wrapped Subdivision title is joined", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Subdivision (2A) — Voluntary transfer of business of",
    "approved exchange",
    "Transfer of business",
    "3.—(1) An approved exchange may transfer its business.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(
    s3.subdivision,
    "# Subdivision (2A) — Voluntary transfer of business of approved exchange",
  )
  assert.equal(s3.title, "Transfer of business")
  assert.ok(!s3.text.includes("Voluntary transfer"), `the title leaked into the body: ${s3.text}`)
})

// The Schedule form has a bare number (`Subdivision 1 — General Notes`).
check("a bare-numbered Subdivision heading is recognised", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Subdivision 1 — General Notes",
    "Notes",
    "3.—(1) The following notes apply.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.subdivision, "# Subdivision 1 — General Notes")
  assert.equal(s3.title, "Notes")
})

// A bare `Subdivision N` with no title is never a heading — the SSO always
// prints a title — so it stays in the body.
check("a bare `Subdivision N` with no title stays in the body", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Subdivision (3)",
    "3.—(1) In this Subdivision, unless the context otherwise requires —",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.subdivision, undefined)
  assert.ok(secs[1].text.includes("Subdivision (3)"), `the bare line was dropped: ${secs[1].text}`)
})

// A Subdivision heading that no section follows is a stub, so it stays in the
// body rather than becoming a heading on the next section.
check("a Subdivision heading with no section under it stays in the body", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Subdivision (2) — Works",
    "",
    "PART 3",
    "ADMINISTRATION",
    "3.—(1) The Registrar must keep a register.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.part, "# PART 3 — ADMINISTRATION")
  assert.equal(s3.subdivision, undefined)
  assert.ok(secs[1].text.includes("Subdivision (2) — Works"), `the stub heading was dropped: ${secs[1].text}`)
})

// A divider title can continue in title case: the section's own title is the
// last line before the section number, so the line above it belongs to the
// divider (`… Regulation of Licensed` / `Foreign Trade Repositories` /
// `General obligations` / `46ZB.—(1)`).
check("a divider title continued in title case before the section title is joined", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Division 3 — Regulation of Licensed",
    "Foreign Trade Repositories",
    "General obligations",
    "3.—(1) A licensed foreign trade repository must operate safely.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.division, "# Division 3 — Regulation of Licensed Foreign Trade Repositories")
  assert.equal(s3.title, "General obligations")
  assert.ok(!s3.text.includes("Foreign Trade Repositories"), `the title leaked into the body: ${s3.text}`)
})

// The section's own title may wrap with a title-case tail, which must not be
// taken as the divider's continuation (`Subdivision (7) — Films` / `What is a
// film; what are the visual images, sounds and` / `soundtrack of a film`).
check("a wrapped section title with a title-case tail stays the section title", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Subdivision (7) — Films",
    "What is a film; what are the visual images, sounds and",
    "soundtrack of a film",
    "3.—(1) A film is all the visual images embodied in a thing.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(s3.subdivision, "# Subdivision (7) — Films")
  assert.equal(s3.title, "What is a film; what are the visual images, sounds and soundtrack of a film")
  assert.ok(!s3.text.includes("soundtrack of a film"), `the title leaked into the body: ${s3.text}`)
})

// A page break can leave a blank line between the two halves of a divider
// title.
check("a divider title wrapping across a blank line is joined", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Subdivision (3) — Disabling access to",
    "",
    "flagrantly infringing online locations",
    "Access disabling order",
    "3.—(1) The Court may order an NCP to disable access.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s3 = secs.find((s) => s.id === "s3")
  assert.equal(
    s3.subdivision,
    "# Subdivision (3) — Disabling access to flagrantly infringing online locations",
  )
  assert.equal(s3.title, "Access disabling order")
})

// ── Appendices ────────────────────────────────────────────────────────

// The Arrangement of Sections lists the appendices as top-level entries beside
// the Schedules, so each is its own section rather than part of the last
// Schedule's body.
check("the appendices become their own sections", () => {
  const text = [
    "1. Short title",
    "",
    "FIRST SCHEDULE",
    "",
    "1. Foo",
    "",
    "LEGISLATIVE HISTORY",
    "TEST ACT 2026",
    "This Legislative History is provided for the convenience of users.",
    "",
    "Abbreviations",
    "",
    "| G.N. | Gazette Notification |",
    "",
    "COMPARATIVE TABLE",
    "TEST ACT 2026",
    "This Act has undergone renumbering.",
  ].join("\n")
  assert.deepEqual(ids(text), [
    "s1",
    "schedule1",
    "legislative_history",
    "abbreviations",
    "comparative_table",
  ])
})

// A Schedule and an appendix are top-level divisions, so each carries a `#`
// heading above its `## [id]` marker.  The Schedule heading is reconstructed
// from the ordinal, so a wrapped heading and a `— continued` marker do not
// leak into it.
check("a Schedule and an appendix carry a # heading", () => {
  const text = [
    "1. Short title",
    "",
    "FIRST SCHEDULE",
    "",
    "1. Foo",
    "",
    "LEGISLATIVE HISTORY",
    "TEST ACT 2026",
    "This Legislative History is provided for the convenience of users.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.equal(secs.find((s) => s.id === "schedule1").heading, "# FIRST SCHEDULE")
  assert.equal(secs.find((s) => s.id === "legislative_history").heading, "# LEGISLATIVE HISTORY")
  const md = renderLegislationMarkdown(secs)
  assert.ok(md.includes("# FIRST SCHEDULE\n\n## [schedule1]\n\n"), md.slice(0, 120))
  assert.ok(
    md.includes("# LEGISLATIVE HISTORY\n\n## [legislative_history]\n\n"),
    "the appendix heading is not above the marker",
  )
})

check("a bare Schedule is headed THE SCHEDULE", () => {
  const text = ["1. Short title", "", "THE SCHEDULE", "", "1. Foo"].join("\n")
  const secs = splitLegislationSections(text)
  assert.equal(secs.find((s) => s.id === "schedule").heading, "# THE SCHEDULE")
})

check("a wrapped Schedule heading is reconstructed on one line", () => {
  const text = ["1. Short title", "", "FIRST", "SCHEDULE", "", "1. Foo"].join("\n")
  const secs = splitLegislationSections(text)
  assert.equal(secs.find((s) => s.id === "schedule1").heading, "# FIRST SCHEDULE")
})

check("a Schedule continuation is not carried into the heading", () => {
  const text = [
    "1. Short title",
    "",
    "FIRST SCHEDULE",
    "",
    "1. Foo",
    "",
    "FIRST SCHEDULE — continued",
    "",
    "2. Bar",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.equal(secs.find((s) => s.id === "schedule1").heading, "# FIRST SCHEDULE")
  assert.equal(secs.filter((s) => s.id === "schedule1").length, 1, "the continuation opened a second section")
})

check("a Schedule heading below a table row is recognised", () => {
  // A Schedule that opens on the page after its predecessor's last table row
  // arrives with no blank line between them, so the row above is a pipe row.
  const text = [
    "1. Short title",
    "",
    "FIRST SCHEDULE",
    "",
    "| 60 102.62 | 102.62 | 102.62 |",
    "SECOND SCHEDULE",
    "Regulations 11 and 17(3) and (7)",
    "",
    "TABLE 1A",
    "",
    "1. Foo",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(
    secs.map((s) => s.id),
    ["s1", "schedule1", "schedule2", "schedule2_table1a"],
  )
  assert.equal(secs.find((s) => s.id === "schedule2").heading, "# SECOND SCHEDULE")
})

check("a Schedule heading with no blank line above it is recognised", () => {
  // The last body line of the previous Schedule runs straight into the next
  // heading, so the line above it does not end a sentence.
  const text = [
    "1. Short title",
    "",
    "FIRST SCHEDULE",
    "",
    "Zuclopenthixol; its salts",
    "SECOND SCHEDULE",
    "Rule 14",
    "",
    "1. Foo",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(
    secs.map((s) => s.id),
    ["s1", "schedule1", "schedule2"],
  )
  assert.equal(secs[1].heading, "# FIRST SCHEDULE")
  assert.equal(secs[2].heading, "# SECOND SCHEDULE")
})

check("a division heading printed twice is one division", () => {
  // The Platform Work Associations Regulations print `PART 4` as a stub and
  // then `PART 4 — AUDITOR'S DECLARATION` below it.  That is one division.
  const text = [
    "1. Short title",
    "",
    "THE SCHEDULE",
    "",
    "PART 4",
    "",
    "PART 4 — AUDITOR’S DECLARATION",
    "",
    "I, the auditor, report that —",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(
    secs.map((s) => s.id),
    ["s1", "schedule", "schedule_part4"],
  )
  assert.equal(secs[2].part, "# PART 4 — AUDITOR’S DECLARATION")
})

check("a title-case marginal note does not open a Schedule", () => {
  // A marginal note beside a section (`Second Schedule`, title case) sits on
  // its own line between the section's subsections and looks like a heading.
  const text = [
    "1. Short title",
    "",
    "2.—(1) Foo.",
    "",
    "Second Schedule",
    "",
    "(2) Bar.",
    "",
    "FIRST SCHEDULE",
    "",
    "1. Baz",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(
    secs.map((s) => s.id),
    ["s1", "s2", "schedule1"],
  )
  assert.ok(secs[1].text.includes("Second Schedule"), "the marginal note left the section")
})

check("the last Schedule does not swallow the appendices", () => {
  const text = [
    "1. Short title",
    "",
    "FIRST SCHEDULE",
    "",
    "1. Foo",
    "",
    "LEGISLATIVE HISTORY",
    "TEST ACT 2026",
    "This Legislative History is provided for the convenience of users.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const sched = secs.find((s) => s.id === "schedule1")
  assert.ok(!sched.text.includes("LEGISLATIVE HISTORY"), "the Schedule swallowed the appendix")
})

// The Legislative History's own entries are numbered (`5. G.N. No. S 344/1995
// — …`), so they look exactly like section starts.  Once an appendix opens,
// nothing after it is a section — otherwise the entries become phantom `sN`
// sections and the appendix is split in two.
check("the Legislative History entries do not become sections", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "3.—(1) There is to be a Comptroller.",
    "",
    "4.—(1) The Minister may make regulations.",
    "",
    "5.—(1) The Board may make regulations.",
    "",
    "6.—(1) This section applies to the Board.",
    "",
    "LEGISLATIVE HISTORY",
    "TEST ACT 2026",
    "This Legislative History is provided for the convenience of users.",
    "",
    "1. Act 22 of 1989 — Test Act 1989",
    "",
    "5. G.N. No. S 344/1995 — Test Act (Amendment) Order 1995",
    "",
    "6. G.N. No. S 405/1996 — Test Act (Amendment) Schedule Order 1996",
    "",
    "Abbreviations",
    "",
    "| G.N. | Gazette Notification |",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), [
    "s1",
    "s2",
    "s3",
    "s4",
    "s5",
    "s6",
    "legislative_history",
    "abbreviations",
  ])
  const lh = secs.find((s) => s.id === "legislative_history")
  assert.ok(lh.text.includes("S 405/1996"), "the Legislative History lost its later entries")
})

// A leading footnote / amendment marker must not hide the section number.
// The Constitution of the Republic of Singapore sets Article 3 as
// `*3. Singapore shall be …`; missing it left `lastNumber` at 2, so every
// later Article was rejected as a forward jump and Parts 2–5 collapsed into
// Article 2.
check("a footnote marker before the number does not hide the section", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "Republic of Singapore",
    "*3. Singapore shall be a sovereign republic.",
    "",
    "Supremacy of Constitution",
    "4. This Constitution is the supreme law.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s1", "s2", "s3", "s4"])
  assert.equal(secs.find((s) => s.id === "s3").title, "Republic of Singapore")
})

// A section start can land inside a reconstructed table cell, where the row
// begins with a pipe (`| 7.—(1) A person must not — |  |`).  Missing it breaks
// the number sequence, so every later section is dropped too.
check("a section start inside a table cell is recognised", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "3.—(1) There is to be a Comptroller.",
    "",
    "4.—(1) The Minister may appoint officers.",
    "",
    "5.—(1) A person must not carry out the activity.",
    "",
    "6.—(1) A person must not employ another person.",
    "",
    "| 7.—(1) A person must not supply the services. |  |",
    "",
    "8.—(1) A person must not employ another person.",
    "",
    "9.—(1) A licensed agency must keep records.",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"])
})

// A PDF whose appendix pages are interleaved with body pages puts an appendix
// heading before the body has finished, and the body then repeats.  Opening a
// section there would attribute the trailing body to the appendix, so the
// heading is only honoured when no body section repeats after it.
check("an appendix heading before the body repeats does not open a section", () => {
  const text = [
    "1. Short title",
    "",
    "2.—(1) Income is exempt.",
    "",
    "LEGISLATIVE HISTORY",
    "This Legislative History is provided for the convenience of users.",
    "",
    "2. Interpretation",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "s2"])
})

// ── Budget chunking ───────────────────────────────────────────────────

/** `n` paragraphs of a predictable length. */
const paras = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i} ${"x".repeat(30)}.`)
const len = (t) => t.length

await acheck("an oversized Schedule chunks to scheduleN_chunkK", async () => {
  const text = [
    "1. Short title",
    "",
    "FIRST SCHEDULE",
    "",
    paras(10).join("\n\n"),
  ].join("\n")
  const out = await chunkLegislationSections(splitLegislationSections(text), {
    budget: 120,
    measure: len,
  })
  const schedIds = out.map((s) => s.id).filter((id) => id.startsWith("schedule"))
  assert.ok(schedIds.length > 1, `expected several chunks, got ${schedIds.length}`)
  assert.deepEqual(schedIds, schedIds.map((_, i) => `schedule1_chunk${i + 1}`))
})

await acheck("keeps a section that fits its budget whole", async () => {
  const secs = [{ id: "s1", text: "Short." }]
  const out = await chunkLegislationSections(secs, { budget: 100, measure: len })
  assert.deepEqual(out, [{ id: "s1", text: "Short." }])
})

await acheck("splits an oversized section into sN_chunk1, sN_chunk2, …", async () => {
  const secs = [{ id: "s7", text: paras(10).join("\n\n") }]
  const out = await chunkLegislationSections(secs, { budget: 120, measure: len })
  assert.ok(out.length > 1, `expected several chunks, got ${out.length}`)
  assert.deepEqual(out.map((s) => s.id), out.map((_, i) => `s7_chunk${i + 1}`))
})

await acheck("every rendered chunk fits the budget", async () => {
  const budget = 120
  const out = await chunkLegislationSections([{ id: "s7", text: paras(10).join("\n\n") }], {
    budget,
    measure: len,
  })
  for (const s of out) {
    const rendered = `## [${s.id}]\n\n${s.text}`
    assert.ok(rendered.length <= budget, `${s.id} is ${rendered.length} > ${budget}`)
  }
})

await acheck("chunking preserves the section text at paragraph boundaries", async () => {
  const body = paras(10).join("\n\n")
  const out = await chunkLegislationSections([{ id: "s3", text: body }], {
    budget: 120,
    measure: len,
  })
  assert.equal(out.map((s) => s.text).join("\n\n"), body)
})

await acheck("keeps a table row intact", async () => {
  const table = [
    "| Offence | Fine |",
    "| --- | --- |",
    "| Parking | $50 |",
    "| Speeding | $100 |",
  ].join("\n")
  const body = [...paras(6), table].join("\n\n")
  const out = await chunkLegislationSections([{ id: "s9", text: body }], {
    budget: 200,
    measure: len,
  })
  assert.ok(out.length > 1, "expected the section to be split")
  const rows = new Set(table.split("\n"))
  for (const s of out) {
    for (const line of s.text.split("\n")) {
      if (line.startsWith("|")) assert.ok(rows.has(line), `partial table row: ${line}`)
    }
  }
})

// A run of repealed sections can leave no marker in the body at all — the
// Penal Code omits sections 13–16, so its body steps straight from `12.` to
// `17.`.  The Arrangement of Sections still lists the real numbers, so the
// jump is bridged rather than swallowing every later section.
check("a repealed run declared in the Arrangement of Sections is bridged", () => {
  const text = [
    "ARRANGEMENT OF SECTIONS",
    "",
    "1. Short title",
    "",
    "2. Interpretation",
    "",
    "5. Offences",
    "",
    "An Act relating to things.",
    "",
    "[1 January 1948]",
    "",
    "1. Short title",
    "",
    "2. Interpretation",
    "",
    "5. Offences",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "s2", "s5"])
})

// The Housing and Development (Polling for Upgrading Works) Rules print `3` on
// a line of its own above `3.—(1) …` for section 33, so the section would
// otherwise be swallowed by the section above it.
check("a section number split across two lines is joined", () => {
  const text = [
    "ARRANGEMENT OF SECTIONS",
    "",
    "1. Short title",
    "32. Final statement of poll",
    "33. Results of poll",
    "34. Failure to comply with Rules",
    "",
    "An Act relating to things.",
    "",
    "1. Short title",
    "",
    "32. Final statement of poll",
    "",
    "As soon as practicable after the last polling day —",
    "",
    "3",
    "3.—(1) The results of a primary poll shall be ascertained in",
    "accordance with the formula.",
    "",
    "34. Failure to comply with Rules",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "s32", "s33", "s34"])
})

// A section whose number is skipped in the source still needs the sections
// after it.  The Arrangement of Sections lists the real numbers, so a jump to
// `11.—(1)` is bridged rather than swallowing it and every later section.
check("a section gap declared in the Arrangement of Sections is bridged", () => {
  const text = [
    "ARRANGEMENT OF SECTIONS",
    "",
    "9A. Cessation of status",
    "11. Cessation of business",
    "12. Application for appointment",
    "13. Duties of holder",
    "",
    "An Act relating to things.",
    "",
    "9A. Cessation of status",
    "",
    "Cessation of business by holder",
    "11.—(1) Where the holder ceases to carry on business —",
    "",
    "12.—(1) For the purposes of section 96(1) —",
    "",
    "13. The holder shall comply with all laws.",
  ].join("\n")
  assert.deepEqual(ids(text), ["s9A", "s11", "s12", "s13"])
})

// The Family Justice Rules number their rules per Part, so `1.` recurs under
// all 73 Parts.  Without qualification the repeats are dropped as duplicates
// and most of the Rules disappear.
check("a Part that restarts numbering gets Part-qualified ids", () => {
  const text = [
    "PART 1",
    "GENERAL",
    "",
    "1. Short title",
    "",
    "2. Interpretation",
    "",
    "PART 2",
    "SPECIAL PROVISIONS",
    "",
    "1. Application",
    "",
    "2. Definitions",
  ].join("\n")
  assert.deepEqual(ids(text), ["s1", "s2", "s2_1", "s2_2"])
})

// Older subsidiary legislation numbers its Parts with Roman numerals
// (`PART IV`), and the Public Utilities (Water Supply) Regulations number
// Parts I–V.  Without them the Part heading and its title stayed in the
// section body instead of being lifted onto a `#` line.
check("a Roman-numeral Part heading is recognised", () => {
  const text = [
    "PART IV",
    "METERED WATER CONSUMPTION AND WATER CONSERVATION",
    "",
    "34. Application of this Part",
    "",
    "35. Supplies through meter",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s34", "s35"])
  assert.equal(
    secs[0].part,
    "# PART IV — METERED WATER CONSUMPTION AND WATER CONSERVATION",
  )
})

// The Safety Convention Regulations divide Chapter II-1 into Parts B-1 to B-4.
// A hyphenated sub-number was not matched, so every one of those headings
// stayed in the body and the whole Chapter was attributed to the single
// `PART B` above it.
check("a hyphenated Part heading is recognised", () => {
  const text = [
    "PART B-1",
    "STABILITY",
    "",
    "5. Intact stability",
    "",
    "6. Stability information",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s5", "s6"])
  assert.equal(secs[0].part, "# PART B-1 — STABILITY")
})

// A Part title can sit on the heading line itself, after an em dash
// (`PART C — MACHINERY INSTALLATIONS`), rather than on the line below.
check("a Part titled on its heading line is recognised", () => {
  const text = [
    "PART C — MACHINERY INSTALLATIONS",
    "",
    "12. Application of this Part",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["s12"])
  assert.equal(secs[0].part, "# PART C — MACHINERY INSTALLATIONS")
})

// The heading line can hold the first line of a wrapped title, and the
// division heading below the title is all caps too — it must not be swallowed.
check("a Part title wrapped past its heading line is joined", () => {
  const text = [
    "PART B — REQUIREMENTS FOR SHIPS AND",
    "LIFE-SAVING APPLIANCES",
    "",
    "SECTION I — PASSENGER SHIPS AND",
    "CARGO SHIPS",
    "",
    "6. Application",
  ].join("\n")
  const secs = splitLegislationSections(text)
  const s6 = secs.find((s) => s.id === "s6")
  assert.equal(s6.part, "# PART B — REQUIREMENTS FOR SHIPS AND LIFE-SAVING APPLIANCES")
  assert.ok(
    s6.text.includes("SECTION I — PASSENGER SHIPS AND"),
    `the division heading was dropped: ${s6.text}`,
  )

  // A blank inside the title is stepped over when what follows is more title,
  // not a division heading.
  const wrapped = [
    "PART 10",
    "DEPOSIT INSURANCE AND POLICY OWNERS’",
    "",
    "PROTECTION FUND AGENCY",
    "",
    "31. Establishment of Agency",
  ].join("\n")
  assert.equal(
    splitLegislationSections(wrapped)[0].part,
    "# PART 10 — DEPOSIT INSURANCE AND POLICY OWNERS’ PROTECTION FUND AGENCY",
  )
})

// Only a *numbered* division heading stops the title: a title can open with
// the word itself.
check("a Part title opening with DIVISION is still joined", () => {
  const text = [
    "PART 3A",
    "DIVISION OF FUND-RELATED ASSETS",
    "IN MATRIMONIAL PROCEEDINGS",
    "",
    "27A. Interpretation of this Part",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.equal(
    secs[0].part,
    "# PART 3A — DIVISION OF FUND-RELATED ASSETS IN MATRIMONIAL PROCEEDINGS",
  )
  assert.doesNotMatch(secs[0].text, /DIVISION OF/)
})

// A title may name another Part or section, so a wrapped title line can open
// with `PART 2`, `PART 7` or `SECTION 9` and still be title, not a division.
check("a Part title may name another Part", () => {
  const text = [
    "PART 3",
    "PART 2 DIRECTION — RECONSIDERATION AND APPEAL",
    "",
    "15. Part 2 direction — appellants",
  ].join("\n")
  assert.equal(
    splitLegislationSections(text)[0].part,
    "# PART 3 — PART 2 DIRECTION — RECONSIDERATION AND APPEAL",
  )

  const charter = [
    "PART 9A",
    "ADDITIONAL PROVISIONS RELATING TO",
    "PART 7, 8 OR 9",
    "",
    "91U. Power of the Family Court",
  ].join("\n")
  assert.equal(
    splitLegislationSections(charter)[0].part,
    "# PART 9A — ADDITIONAL PROVISIONS RELATING TO PART 7, 8 OR 9",
  )

  const consumer = [
    "PART 3",
    "CANCELLATION OF CONTRACTS UNDER",
    "SECTION 9(12) OF ACT",
    "",
    "4A. Manner and effect of cancelling a contract",
  ].join("\n")
  assert.equal(
    splitLegislationSections(consumer)[0].part,
    "# PART 3 — CANCELLATION OF CONTRACTS UNDER SECTION 9(12) OF ACT",
  )
})

// A document whose units are the Parts themselves — the Safety Convention
// Regulations head each provision `Regulation 5`, never `5.` — never claims a
// Part with a numbered section, so every Part but the last used to be
// overwritten before it could be emitted.  Each Part is now its own section,
// and a repeated Part letter (it restarts in every Chapter) gets a
// disambiguated id.
check("a Part with no numbered section becomes its own section", () => {
  const text = [
    "PART A",
    "GENERAL PROVISIONS",
    "",
    "Regulation 1",
    "",
    "PART B-1",
    "STABILITY",
    "",
    "Regulation 5",
    "",
    "PART B-2",
    "SUBDIVISION AND WATERTIGHT INTEGRITY",
    "",
    "Regulation 9",
    "",
    "PART A",
    "GENERAL PROVISIONS",
    "",
    "Regulation 1",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.deepEqual(secs.map((s) => s.id), ["part_1_a", "part_2_b_1", "part_3_b_2", "part_4_a"])
  assert.deepEqual(secs.map((s) => s.part), [
    "# PART A — GENERAL PROVISIONS",
    "# PART B-1 — STABILITY",
    "# PART B-2 — SUBDIVISION AND WATERTIGHT INTEGRITY",
    "# PART A — GENERAL PROVISIONS",
  ])
  assert.match(secs[0].text, /Regulation 1/)
  assert.doesNotMatch(secs[0].text, /Regulation 5/)
  assert.match(secs[2].text, /Regulation 9/)
})

check("a whole_doc body is reflowed", () => {
  const text = [
    "WHEREAS pursuant to section 9(1) of the Application of English Law",
    "Act, the Commissioners have prepared and published a",
    "revised edition in loose-leaf form:",
  ].join("\n")
  const secs = splitLegislationSections(text)
  assert.equal(secs.length, 1)
  assert.equal(secs[0].id, "whole_doc")
  assert.equal(
    secs[0].text,
    "WHEREAS pursuant to section 9(1) of the Application of English Law Act, the Commissioners have prepared and published a revised edition in loose-leaf form:",
  )
})

if (failed > 0) {
  console.error(`\n${failed} legislation-split test(s) failed`)
  process.exit(1)
}
console.log("\nlegislation-split tests passed")
