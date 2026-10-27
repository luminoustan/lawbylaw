#!/usr/bin/env node
/**
 * Generate the golden-corpus regression baseline.
 *
 * Writes `scripts/tests/fixtures/legislation-baseline.json`: a per-file
 * fingerprint of the full legislation corpus, used by
 * `legislation-regression.test.mjs` to fail a parse that drops content.
 *
 * Source, in order of preference:
 *   1. `--from <dir>`  an existing parsed output tree (fast, no re-parse)
 *   2. the corpus PDFs under `LEG_SRC` (default `legislation/<date>`), re-parsed
 *      with the current extractor
 *
 * Refuses to overwrite an existing baseline unless `--force` is passed, and
 * prints the diff against the old baseline so a refresh is a deliberate act.
 *
 * Usage:
 *   node scripts/tests/update-legislation-baseline.mjs [--from DIR] [--force]
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import {
  BASELINE_PATH,
  fingerprint,
  loadBaseline,
  loadIndex,
  makeChunkOpts,
  mapConcurrent,
  renderPdf,
  repoRoot,
  resolveCorpusRoot,
  resolveMeta,
} from "./legislation-baseline-lib.mjs"

const DATE = process.env.LEG_DATE || "2026-05-30"

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const fromDir = arg("--from")
const force = process.argv.includes("--force")

/** Every `.md` under `dir`, as corpus-relative paths. */
function walkMd(dir) {
  const out = []
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) rec(p)
      else if (e.name.endsWith(".md")) out.push(path.relative(dir, p))
    }
  }
  rec(dir)
  return out.sort()
}

/** Fingerprint every file in an existing parsed output tree. */
function fromOutput(dir) {
  const files = {}
  for (const rel of walkMd(dir)) {
    files[rel] = fingerprint(fs.readFileSync(path.join(dir, rel), "utf8"))
  }
  return files
}

/** Re-parse the corpus PDFs and fingerprint the rendered Markdown. */
async function fromCorpus(src) {
  const chunkOpts = await makeChunkOpts()
  const index = loadIndex(src)
  const pdfs = []
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) rec(p)
      else if (e.name.toLowerCase().endsWith(".pdf")) pdfs.push(p)
    }
  }
  rec(src)
  pdfs.sort()
  console.error(`re-parsing ${pdfs.length} PDFs from ${src}`)
  const files = {}
  let done = 0
  await mapConcurrent(pdfs, 8, async (pdf) => {
    const rel = path.relative(src, pdf).replace(/\.pdf$/i, ".md")
    const md = await renderPdf(pdf, chunkOpts, resolveMeta(index, rel))
    if (md !== null) files[rel] = fingerprint(md)
    if (++done % 500 === 0) console.error(`  ${done}/${pdfs.length}`)
  })
  return files
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim()
  } catch {
    return "unknown"
  }
}

const old = loadBaseline()
if (old && !force) {
  console.error(
    `refusing to overwrite ${path.relative(repoRoot, BASELINE_PATH)} without --force\n` +
      `(run the comparator first, confirm every reported loss is understood, then --force)`,
  )
  process.exit(1)
}

let files
if (fromDir) {
  if (!fs.existsSync(fromDir)) {
    console.error(`no such directory: ${fromDir}`)
    process.exit(1)
  }
  console.error(`fingerprinting existing output at ${fromDir}`)
  files = fromOutput(fromDir)
} else {
  const src = resolveCorpusRoot(DATE)
  if (!src) {
    console.error(`corpus not found (set LEG_SRC or pass --from <parsed-output-dir>)`)
    process.exit(1)
  }
  files = await fromCorpus(src)
}

const paths = Object.keys(files)
const meta = {
  corpusDate: DATE,
  files: paths.length,
  totalLines: paths.reduce((n, p) => n + files[p].lines, 0),
  totalSections: paths.reduce((n, p) => n + files[p].sections, 0),
  parserCommit: gitCommit(),
  generatedAt: new Date().toISOString(),
}

fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true })
fs.writeFileSync(BASELINE_PATH, JSON.stringify({ meta, files }, null, 0) + "\n", "utf8")

console.error(`\nwrote ${path.relative(repoRoot, BASELINE_PATH)}`)
console.error(
  `  files ${meta.files}  lines ${meta.totalLines}  sections ${meta.totalSections}  ` +
    `commit ${meta.parserCommit}`,
)

if (old) {
  const oldPaths = new Set(Object.keys(old.files))
  const newPaths = new Set(paths)
  const added = paths.filter((p) => !oldPaths.has(p))
  const removed = [...oldPaths].filter((p) => !newPaths.has(p))
  let lineDelta = 0
  let sectionDelta = 0
  for (const p of paths) {
    if (!oldPaths.has(p)) continue
    lineDelta += files[p].lines - old.files[p].lines
    sectionDelta += files[p].sections - old.files[p].sections
  }
  console.error(
    `\nvs previous baseline: +${added.length} files, -${removed.length} files, ` +
      `${lineDelta >= 0 ? "+" : ""}${lineDelta} lines, ` +
      `${sectionDelta >= 0 ? "+" : ""}${sectionDelta} sections`,
  )
  for (const p of removed.slice(0, 10)) console.error(`  removed: ${p}`)
}
