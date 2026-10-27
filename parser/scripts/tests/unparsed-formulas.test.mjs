#!/usr/bin/env node
/**
 * Tier 1 — formula-parsing ratchet.
 *
 * The Monotype `AdvP4C4E74` / `AdvP4C4E51` / `AdvP4C4E46` symbol fonts carry
 * the math operators and parentheses in a subset of the legislation PDFs, but
 * ship a broken name table, so the extractor decodes those glyphs to the wrong
 * character (`ð`, `Þ`, `þ`, `;`) or drops them — leaving formulas such as
 * `A × B` rendered as `A B;`.  See docs/formula-parsing-findings.md.
 *
 * This check scans the corpus for those fonts and ratchets against the
 * committed set of known-affected files:
 *
 *   - a file that uses a symbol font but is NOT in the baseline fails the run
 *     (a new document of this class, or a font we have not catalogued);
 *   - a baseline file that is no longer flagged is reported as *fixed*.
 *
 * The font scan is the key, so the ratchet is stable whether or not the parsed
 * output is present.  When the output is available it is read only to annotate
 * each entry with whether the corruption is visible and whether the file
 * mentions "formula".
 *
 * The corpus is gitignored, so the check skips cleanly when it is absent.
 *
 * Usage:
 *   node scripts/tests/unparsed-formulas.test.mjs            # ratchet
 *   node scripts/tests/unparsed-formulas.test.mjs --report   # print the table
 *   node scripts/tests/unparsed-formulas.test.mjs --update   # refresh the baseline
 *   LEG_SRC=/path/to/legislation/2026-05-30 LEG_OUT=/path/to/parsed \
 *     node scripts/tests/unparsed-formulas.test.mjs
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mapConcurrent, repoRoot, resolveCorpusRoot } from "./legislation-baseline-lib.mjs"

const DATE = process.env.LEG_DATE || "2026-05-30"
const FONTS = ["AdvP4C4E74", "AdvP4C4E51", "AdvP4C4E46"]
const FIXTURE = path.join(repoRoot, "scripts/tests/fixtures/unparsed-formulas-baseline.json")
const UPDATE = process.argv.includes("--update")
const REPORT = process.argv.includes("--report")

// Visible corruption: the tell-tale glyphs, or a digit group joined by a
// semicolon where a comma belongs (`$2;000;000`).
const CORRUPT_RE = /[\u00F0\u00DE\u00FE]|\d;\d{3}/

function walkPdfs(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkPdfs(p))
    else if (e.name.toLowerCase().endsWith(".pdf")) out.push(p)
  }
  return out
}

/** The parsed-output directory, or null when it is not present. */
function outputDirFor(src) {
  if (process.env.LEG_OUT) return fs.existsSync(process.env.LEG_OUT) ? process.env.LEG_OUT : null
  const guess = path.join(repoRoot, "parsed_legislation_full", path.basename(src))
  return fs.existsSync(guess) ? guess : null
}

const src = resolveCorpusRoot(DATE)
if (!src) {
  console.log(`  skip  formula-parsing ratchet (corpus not present; set LEG_SRC to run)`)
  process.exit(0)
}

const outDir = outputDirFor(src)
const pdfs = walkPdfs(src)

const current = new Map()
await mapConcurrent(pdfs, Math.max(2, os.cpus().length), (pdf) => {
  const buf = fs.readFileSync(pdf)
  const fonts = FONTS.filter((f) => buf.includes(Buffer.from(f)))
  if (!fonts.length) return
  const rel = path.relative(src, pdf).replace(/\.pdf$/i, ".md")
  let corrupt = null
  let formula = null
  if (outDir) {
    const mdPath = path.join(outDir, rel)
    if (fs.existsSync(mdPath)) {
      const md = fs.readFileSync(mdPath, "utf8")
      corrupt = CORRUPT_RE.test(md)
      formula = /formula/i.test(md)
    }
  }
  current.set(rel, { fonts, corrupt, formula })
})

const sorted = [...current].sort((a, b) => a[0].localeCompare(b[0]))

if (UPDATE) {
  const files = {}
  for (const [rel, info] of sorted) files[rel] = info
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true })
  fs.writeFileSync(
    FIXTURE,
    JSON.stringify({ corpusDate: DATE, fonts: FONTS, generatedAt: new Date().toISOString(), files }, null, 2) +
      "\n",
  )
  console.log(`  wrote ${sorted.length} flagged file(s) to ${path.relative(repoRoot, FIXTURE)}`)
  process.exit(0)
}

if (REPORT) {
  console.log(`| File | Fonts | Visible | Mentions formula |`)
  console.log(`| --- | --- | --- | --- |`)
  for (const [rel, info] of sorted) {
    const vis = info.corrupt === null ? "?" : info.corrupt ? "yes" : "—"
    const frm = info.formula === null ? "?" : info.formula ? "yes" : "—"
    console.log(`| ${rel} | ${info.fonts.join(",")} | ${vis} | ${frm} |`)
  }
  console.log(`\n  ${sorted.length} file(s) use a Monotype symbol font`)
  process.exit(0)
}

if (!fs.existsSync(FIXTURE)) {
  console.error(
    `no baseline at scripts/tests/fixtures/unparsed-formulas-baseline.json\n` +
      `generate it with: node scripts/tests/unparsed-formulas.test.mjs --update`,
  )
  process.exit(1)
}

const baseline = JSON.parse(fs.readFileSync(FIXTURE, "utf8"))
const known = new Set(Object.keys(baseline.files || {}))
const found = new Set(current.keys())
const added = [...found].filter((r) => !known.has(r)).sort()
const fixed = [...known].filter((r) => !found.has(r)).sort()
const visible = sorted.filter(([, i]) => i.corrupt).length
const formulaFiles = sorted.filter(([, i]) => i.formula).length

console.log(`\n── Formula-parsing ratchet (Monotype symbol fonts) ──`)
console.log(`  corpus date       ${baseline.corpusDate}`)
console.log(`  pdfs scanned      ${pdfs.length}`)
console.log(`  flagged files     ${found.size}`)
console.log(`    visible corrupt ${outDir ? visible : "(no output)"}`)
console.log(`    mention formula ${outDir ? formulaFiles : "(no output)"}`)
console.log(`  known affected    ${known.size}`)
console.log(`  new since baseline ${added.length}`)

if (fixed.length) {
  console.log(`\n  no longer flagged (${fixed.length}) — if the decoder was fixed, refresh the baseline:`)
  for (const r of fixed.slice(0, 20)) console.log(`    ${r}`)
  if (fixed.length > 20) console.log(`    ... ${fixed.length - 20} more`)
}

if (added.length) {
  console.error(`\n  NEW files using an undecoded Monotype symbol font:`)
  for (const r of added.slice(0, 40)) console.error(`    ${r}`)
  if (added.length > 40) console.error(`    ... ${added.length - 40} more`)
  console.error(
    `\n  ${added.length} new file(s) flagged.  Either extend the symbol-font override\n` +
      `  (see .parser/plans/fix-monotype-math-glyphs.md), or — if the file is benign —\n` +
      `  add it to the baseline:\n` +
      `    node scripts/tests/unparsed-formulas.test.mjs --update`,
  )
  process.exit(1)
}

console.log(`\nunparsed-formulas tests passed`)
