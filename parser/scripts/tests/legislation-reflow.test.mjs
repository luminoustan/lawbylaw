#!/usr/bin/env node
/**
 * Tier 1 — unit tests for the legislation paragraph reflow
 * (`legislation/reflow.ts`).
 *
 * Reflow is a pure function of a section body, so these tests pass fixtures
 * directly — no PDF or build step needed.  Run:
 *
 *   node scripts/tests/legislation-reflow.test.mjs
 *
 * Exits non-zero if any check fails, so `run-tests.sh` fails.
 */
import assert from "node:assert/strict"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")
const { reflowLegislationBody } = await import(
  pathToFileURL(
    path.join(repoRoot, "src/legislation/reflow.ts"),
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

const words = (s) => s.split(/\s+/).filter(Boolean)

check("adjacent wrapped lines are joined", () => {
  const out = reflowLegislationBody(
    "In this Act, unless the subject or context otherwise\nrequires —\n“account” means an account;",
  )
  assert.equal(
    out,
    "In this Act, unless the subject or context otherwise requires — “account” means an account;",
  )
})

check("a section start is not a numbered row", () => {
  const out = reflowLegislationBody(
    "2.—(1) In this Act, unless the subject or context otherwise\nrequires —",
  )
  assert.equal(out, "2.—(1) In this Act, unless the subject or context otherwise requires —")
})

check("a blank line inside a sentence is joined", () => {
  const out = reflowLegislationBody(
    "3.—(1) The Minister may make regulations\n\nprescribing the fees payable.",
  )
  assert.equal(out, "3.—(1) The Minister may make regulations prescribing the fees payable.")
})

check("a blank line before a proper-noun continuation is joined", () => {
  const out = reflowLegislationBody(
    "the body known as the Accounting and Corporate\n\nRegulatory Authority Act 2004;",
  )
  assert.equal(
    out,
    "the body known as the Accounting and Corporate Regulatory Authority Act 2004;",
  )
})

check("a semicolon ends a block, so definitions stay separate", () => {
  const out = reflowLegislationBody(
    "“Complaints Panel” means the panel;\n\n“Disciplinary Panel” means the panel;",
  )
  assert.equal(out, "“Complaints Panel” means the panel;\n\n“Disciplinary Panel” means the panel;")
})

check("a trailing abbreviation is not a sentence end", () => {
  const out = reflowLegislationBody(
    "the fees payable under section 4 No.\n\nand the penalties under section 5.",
  )
  assert.equal(out, "the fees payable under section 4 No. and the penalties under section 5.")
})

check("list markers open blocks and take their wrapped continuation", () => {
  const out = reflowLegislationBody(
    "(a) gains or profits from any trade,\n\nbusiness, profession or vocation;\n\n(b) dividends and interest;",
  )
  assert.equal(
    out,
    "(a) gains or profits from any trade, business, profession or vocation;\n\n(b) dividends and interest;",
  )
})

check("a bare list marker takes its text from the next line", () => {
  const out = reflowLegislationBody("(a)\n\nit is a physical address;")
  assert.equal(out, "(a) it is a physical address;")
})

check("numbered rows open blocks and take their wrapped continuation", () => {
  const out = reflowLegislationBody(
    "12. The underpass (ID 51922) that is about 60 metres\n\nin length, starting at the point;",
  )
  assert.equal(
    out,
    "12. The underpass (ID 51922) that is about 60 metres in length, starting at the point;",
  )
})

check("an amendment citation is a barrier", () => {
  const out = reflowLegislationBody(
    "the exemptions mentioned in subsection (1)\n\n[Act 30 of 2023 wef 01/01/2024]\n\napply to the following persons.",
  )
  assert.equal(
    out,
    "the exemptions mentioned in subsection (1)\n\n[Act 30 of 2023 wef 01/01/2024]\n\napply to the following persons.",
  )
})

check("an all-caps heading is a barrier", () => {
  const out = reflowLegislationBody(
    "the following matters\n\nOTHER APPROPRIATE REVIEWERS\n\nthe reviewer must consider them.",
  )
  assert.equal(
    out,
    "the following matters\n\nOTHER APPROPRIATE REVIEWERS\n\nthe reviewer must consider them.",
  )
})

check("an all-caps division heading is a barrier", () => {
  const out = reflowLegislationBody(
    "the rates are set out below\n\nTABLE 2A\n\nthe rates apply from 1 January 2025.",
  )
  assert.equal(out, "the rates are set out below\n\nTABLE 2A\n\nthe rates apply from 1 January 2025.")
})

check("a division heading after a sentence stays its own block", () => {
  const out = reflowLegislationBody(
    "1. Body one.\n\nDivision 1 — Repealed\n\n[Act 36 of 2018 wef 01/01/2024]\n\n3. to 5. [Repealed by Act 36 of 2018]",
  )
  assert.equal(
    out,
    "1. Body one.\n\nDivision 1 — Repealed\n\n[Act 36 of 2018 wef 01/01/2024]\n\n3. to 5. [Repealed by Act 36 of 2018]",
  )
})

check("a unit heading is a barrier", () => {
  const out = reflowLegislationBody(
    "Regulation 5\n\nEquivalents\n\nWhere these Regulations require a weight.",
  )
  assert.equal(out, "Regulation 5\n\nEquivalents Where these Regulations require a weight.")
})

check("a lower-case rule cross-reference is prose, not a heading", () => {
  const out = reflowLegislationBody("the Minister may make rules\n\nrule 12(1); and")
  assert.equal(out, "the Minister may make rules rule 12(1); and")
})

check("a section cross-reference continuation is not a division heading", () => {
  const out = reflowLegislationBody(
    "“limited liability partnership” has the meaning given by\n\nsection 4(1) of the Limited Liability Partnerships Act 2005;",
  )
  assert.equal(
    out,
    "“limited liability partnership” has the meaning given by section 4(1) of the Limited Liability Partnerships Act 2005;",
  )
})

check("a subsection continuation is not a division heading", () => {
  const out = reflowLegislationBody(
    "(a) before 9 December 2024, the address (called in this\nsubsection the individual) has been entered in a register\nmentioned in section 8(1); and",
  )
  assert.equal(
    out,
    "(a) before 9 December 2024, the address (called in this subsection the individual) has been entered in a register mentioned in section 8(1); and",
  )
})

check("a parenthesised all-caps continuation joins", () => {
  const out = reflowLegislationBody(
    "(ii) the Institute of Chartered Accountants in England and Wales\n(ICAEW);",
  )
  assert.equal(
    out,
    "(ii) the Institute of Chartered Accountants in England and Wales (ICAEW);",
  )
})

check("an all-caps data row absorbs its continuation", () => {
  const out = reflowLegislationBody("99953A, 99956X PT, 99448N, 99450K PT\nand 99449X in Mukim 02;")
  assert.equal(out, "99953A, 99956X PT, 99448N, 99450K PT and 99449X in Mukim 02;")
})

check("a sentence starting with a title-case division word is prose", () => {
  const out = reflowLegislationBody(
    "Section 120 applies to independence as it does to the\nfundamental principles set out in Section 110.",
  )
  assert.equal(
    out,
    "Section 120 applies to independence as it does to the fundamental principles set out in Section 110.",
  )
})

check("a trailing acronym parenthetical joins", () => {
  const out = reflowLegislationBody("the slip road to Central Expressway\n(CTE).")
  assert.equal(out, "the slip road to Central Expressway (CTE).")
})

check("an all-caps line ending in a comma absorbs its continuation", () => {
  const out = reflowLegislationBody("NCASA,\nand the RACA must comply with that requirement.")
  assert.equal(out, "NCASA, and the RACA must comply with that requirement.")
})

check("pipe rows accumulate into one table block", () => {
  const out = reflowLegislationBody(
    "The following rates apply:\n\n| Year | Rate |\n| 2024 | 5% |\n| 2025 | 6% |\n\nThe Minister may amend the rates.",
  )
  assert.equal(
    out,
    "The following rates apply:\n\n| Year | Rate |\n| 2024 | 5% |\n| 2025 | 6% |\n\nThe Minister may amend the rates.",
  )
})

check("a hyphen at a line break is kept and joined without a space", () => {
  const out = reflowLegislationBody(
    "the non-\ncompliance penalty and the evidence-in-\nchief rule.",
  )
  assert.equal(out, "the non-compliance penalty and the evidence-in-chief rule.")
})

check("reflow is idempotent", () => {
  const input = [
    "2.—(1) In this Act, unless the subject or context otherwise",
    "requires —",
    "",
    "“account” means an account;",
    "",
    "[Act 30 of 2023 wef 01/01/2024]",
    "",
    "(a) gains or profits from any trade,",
    "",
    "business, profession or vocation;",
    "",
    "| A | B |",
    "| 1 | 2 |",
  ].join("\n")
  const once = reflowLegislationBody(input)
  assert.equal(reflowLegislationBody(once), once)
})

check("reflow only moves whitespace, it does not lose words", () => {
  const input = [
    "2.—(1) In this Act, unless the subject or context otherwise",
    "requires —",
    "",
    "“account with the electronic service”, in relation to any person,",
    "",
    "means a computer account within the electronic service",
    "which is assigned by the Comptroller to that person for the",
    "storage and retrieval of electronic records relating to that",
    "person;",
  ].join("\n")
  const out = reflowLegislationBody(input)
  assert.deepEqual(words(out), words(input))
  assert.ok(!out.includes("\n\n“account"), "the wrap before the definition is joined")
})

check("a single-letter drop cap joins its continuation", () => {
  const out = reflowLegislationBody("(a) 17% of the\n\nT\n\notal\n\nW\n\nages; and")
  assert.equal(out, "(a) 17% of the T otal W ages; and")
})

check("a wrapped bracket instruction joins its continuation", () => {
  const out = reflowLegislationBody(
    "[Specify any exceptions or conditions, including any end date. Put “N/A” if no\n\nconditions or exceptions are specified.]",
  )
  assert.equal(
    out,
    "[Specify any exceptions or conditions, including any end date. Put “N/A” if no conditions or exceptions are specified.]",
  )
})

check("an edition page footer stays a barrier", () => {
  const out = reflowLegislationBody(
    "meanings given by section 26 of the Act;\n\n[2024 Ed. p. 1\n\n“qualified individual” means a qualified individual;",
  )
  assert.equal(
    out,
    "meanings given by section 26 of the Act;\n\n[2024 Ed. p. 1\n\n“qualified individual” means a qualified individual;",
  )
})

check("a quoted all-caps line joins as prose", () => {
  const out = reflowLegislationBody("the citizens of\n\n“SINGAPORE”\n\nare reminded of their pledge.")
  assert.equal(out, "the citizens of “SINGAPORE” are reminded of their pledge.")
})

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log("\nall reflow checks passed")
