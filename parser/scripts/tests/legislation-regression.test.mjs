#!/usr/bin/env node
/**
 * Tier 1 — golden-corpus regression gate.
 *
 * Re-parses the legislation corpus with the current extractor and compares each
 * file's fingerprint against the committed baseline.  Fails when a file loses
 * lines, characters, or sections relative to the baseline — the class of silent
 * content loss that shipped the dropped-last-line bug and the SSO footer leak.
 *
 * A same-length rewrite (counts equal, `setHash` differs) is reported as
 * *changed*, not a failure: the fingerprint cannot tell a rewrite from a
 * drop+add of equal size, so it is surfaced for review.
 *
 * The corpus is gitignored, so the gate skips cleanly when it is absent.
 *
 * Usage:
 *   node scripts/tests/legislation-regression.test.mjs
 *   LEG_SRC=/path/to/legislation/2026-05-30 node scripts/tests/legislation-regression.test.mjs
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  fingerprint,
  loadBaseline,
  loadIndex,
  makeChunkOpts,
  mapConcurrent,
  renderPdf,
  resolveCorpusRoot,
  resolveMeta,
} from "./legislation-baseline-lib.mjs"

const DATE = process.env.LEG_DATE || "2026-05-30"

const baseline = loadBaseline()
if (!baseline) {
  console.error(
    `no baseline at scripts/tests/fixtures/legislation-baseline.json\n` +
      `generate it with: node scripts/tests/update-legislation-baseline.mjs --from <parsed-output-dir>`,
  )
  process.exit(1)
}

const src = resolveCorpusRoot(DATE)
if (!src) {
  console.log(
    `  skip  legislation corpus regression (corpus not present; set LEG_SRC to run)`,
  )
  process.exit(0)
}

const chunkOpts = await makeChunkOpts()
const index = loadIndex(src)
const entries = Object.entries(baseline.files)

const losses = []
const changed = []
const missing = []
let checked = 0

await mapConcurrent(entries, Math.max(2, os.cpus().length), async ([rel, base]) => {
  const pdf = path.join(src, rel.replace(/\.md$/i, ".pdf"))
  if (!fs.existsSync(pdf)) {
    missing.push(rel)
    return
  }
  const md = await renderPdf(pdf, chunkOpts, resolveMeta(index, rel))
  if (md === null) {
    losses.push({ rel, kind: "empty", base, now: { lines: 0, chars: 0, sections: 0 } })
    return
  }
  const now = fingerprint(md)
  checked++
  const lostLines = base.lines - now.lines
  const lostChars = base.chars - now.chars
  const lostSections = base.sections - now.sections
  if (lostLines > 0 || lostChars > 0 || lostSections > 0) {
    losses.push({ rel, kind: "loss", base, now, lostLines, lostChars, lostSections })
  } else if (now.setHash !== base.setHash) {
    changed.push({ rel, base, now })
  }
})

console.log(`\n── Legislation corpus regression (golden baseline) ──`)
console.log(`  baseline commit   ${baseline.meta.parserCommit}  (${baseline.meta.files} files)`)
console.log(`  files checked     ${checked}`)
console.log(`  files changed     ${changed.length}`)
console.log(`  files with loss   ${losses.length}`)
if (missing.length) console.log(`  files missing     ${missing.length}`)

if (changed.length) {
  console.log(`\n  changed (same counts, different content — review):`)
  for (const c of changed.slice(0, 20)) {
    console.log(`    ${c.rel}  (${c.base.lines} lines)`)
  }
  if (changed.length > 20) console.log(`    ... ${changed.length - 20} more`)
}

if (losses.length) {
  console.error(`\n  CONTENT LOSS vs baseline:`)
  for (const l of losses.slice(0, 40)) {
    const parts = []
    if (l.lostLines > 0) parts.push(`${l.lostLines} lines`)
    if (l.lostChars > 0) parts.push(`${l.lostChars} chars`)
    if (l.lostSections > 0) parts.push(`${l.lostSections} sections`)
    console.error(`    ${l.rel}  (-${parts.join(", ")})`)
  }
  if (losses.length > 40) console.error(`    ... ${losses.length - 40} more`)
  console.error(
    `\n  ${losses.length} file(s) lost content.  Fix the parser, or — if the loss is\n` +
      `  intended — refresh the baseline:\n` +
      `    node scripts/tests/update-legislation-baseline.mjs --from <parsed-output-dir> --force`,
  )
  process.exit(1)
}

if (missing.length) {
  console.error(`\n  ${missing.length} baseline file(s) have no source PDF — corpus is incomplete`)
  for (const m of missing.slice(0, 10)) console.error(`    ${m}`)
  process.exit(1)
}

console.log(`\nlegislation regression tests passed`)
