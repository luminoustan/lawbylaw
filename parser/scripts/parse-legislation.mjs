#!/usr/bin/env node
/**
 * Parse the legislation corpus with the in-house extractor and write it in the
 * same shape as `parsed_legislation/2026-05-30`.
 *
 * The output contract is the one `write_parsed_legislation` in
 * the reference parse notebook implements:
 *
 *   - `<out>/<date>/<Act>/<Act>.md` for the principal Act
 *   - `<out>/<date>/<Act>/Subsidiary Legislation/<SL stem>.md` for each SL
 *   - an SSO frontmatter HTML comment, only when the index has a url or title
 *   - sections as `## [sN]\n\n<text>`, joined by `\n\n---\n\n`
 *   - a section larger than the budget is split at paragraph boundaries into
 *     `sN_chunk1`, `sN_chunk2`, … so every chunk fits the embedding model's
 *     window
 *   - `<out>/<date>/<Act>/parse_audit.json` with the folder's section count
 *
 * The dated subfolder is not decoration: the embedding step derives the
 * Qdrant collection from it (`_PARSED_DIR.name[:4].isdigit()` →
 * `legislation_<date>`), so `PARSED_DIR=<out>/<date>` slots straight in.
 *
 * The text source is `extractPdfText` (Node zlib only) rather than the
 * reference's `pymupdf4llm`, which is AGPL.  Visually tabular blocks are
 * reconstructed as GitHub pipe tables by `renderTables`.
 *
 * `PERCENT=100` parses the whole corpus; a smaller value takes a stratified,
 * seeded sample (5% of the Act folders and, separately, 5% of the SL PDFs), so
 * a rerun reproduces the same selection.
 *
 * Env: LEG_SRC, LEG_OUT, LEG_DATE, PERCENT, SEED, TOKEN_BUDGET,
 *      QWEN_TOKENIZER_JSON, QWEN_TOKENIZER_URL
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const load = (rel) =>
  import(pathToFileURL(path.join(repoRoot, rel)).href)

const { extractPdfText } = await load("src/pdf/extract.ts")
const { chunkLegislationSections, renderLegislationMarkdown, splitLegislationSections } = await load(
  "src/legislation/split.ts",
)
const { EMBEDDING_TOKEN_BUDGET, loadEmbeddingMeasure } = await load(
  "src/token-budget.ts",
)

const LEG_SRC = process.env.LEG_SRC || path.join(repoRoot, "legislation/2026-05-30")
const LEG_OUT = process.env.LEG_OUT || path.join(repoRoot, "parsed_legislation_sample5")
const LEG_DATE = process.env.LEG_DATE || "2026-05-30"
const OUT = path.join(LEG_OUT, LEG_DATE)
const PERCENT = Number(process.env.PERCENT || 5)
const SEED = Number(process.env.SEED || 20260530)

// ── Section budget ────────────────────────────────────────────────────
// Sections are budgeted in the embedding model's unit — Qwen3 tokens — at
// 1,024 tokens, leaving headroom under the 1,200-token serving window.  There
// is no character fallback: without the tokenizer the parse fails.
const TOKEN_BUDGET = Number(process.env.TOKEN_BUDGET ?? EMBEDDING_TOKEN_BUDGET)
if (!Number.isFinite(TOKEN_BUDGET) || TOKEN_BUDGET <= 0) {
  console.error(`TOKEN_BUDGET must be a positive number, got ${process.env.TOKEN_BUDGET}`)
  process.exit(1)
}

let measure
try {
  measure = await loadEmbeddingMeasure([repoRoot])
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}
const chunkOpts = { budget: TOKEN_BUDGET, measure }

// ── Sampling ──────────────────────────────────────────────────────────

/** Deterministic PRNG so the sample is reproducible across runs. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sampleOf(items, percent, rnd) {
  const k = Math.max(1, Math.round((items.length * percent) / 100))
  const a = items.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, k).sort()
}

// ── Reference formatting ──────────────────────────────────────────────

/** Python `str.rstrip(". ")` plus the invalid-character substitution. */
function sanitiseFilename(name) {
  // Control characters are exactly what has to be stripped from a filename.
  // eslint-disable-next-line no-control-regex
  let n = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
  n = n.replace(/[_ ]{2,}/g, " ")
  n = n.trim()
  n = n.replace(/[. ]+$/, "")
  return n || "untitled"
}

/** Python truthiness, so an empty string or a false flag is omitted. */
function pyTruthy(v) {
  if (v === undefined || v === null) return false
  if (typeof v === "string") return v.length > 0
  if (typeof v === "number") return v !== 0
  if (typeof v === "boolean") return v
  if (Array.isArray(v)) return v.length > 0
  return true
}

function pyStr(v) {
  if (v === true) return "True"
  if (v === false) return "False"
  return String(v)
}

/** The `<!-- sso_* -->` frontmatter, in the reference's key order. */
function frontmatter(meta) {
  if (!meta) return ""
  if (!pyTruthy(meta.sso_url) && !pyTruthy(meta.sso_title)) return ""
  const lines = ["<!--"]
  for (const key of ["sso_url", "sso_title", "sso_number", "sso_has_pdf"]) {
    if (!pyTruthy(meta[key])) continue
    lines.push(`  ${key}: ${pyStr(meta[key])}`)
  }
  lines.push("-->")
  return lines.join("\n")
}

function writeMd(filePath, sections, meta) {
  const parts = []
  const fm = frontmatter(meta)
  if (fm) parts.push(fm)
  // `renderLegislationMarkdown` places a Part heading above the `## [sN]`
  // marker; rendering here instead would drop it.
  parts.push(renderLegislationMarkdown(sections))
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, parts.join("\n\n---\n\n"), "utf8")
}

// ── Corpus discovery ──────────────────────────────────────────────────

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"))
  } catch {
    return fallback
  }
}

/** Act folders: a directory with at least one PDF at its immediate root. */
function discoverActFolders(dir) {
  const acts = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const d = path.join(dir, e.name)
    const hasRootPdf = fs
      .readdirSync(d, { withFileTypes: true })
      .some((f) => f.isFile() && f.name.toLowerCase().endsWith(".pdf"))
    if (hasRootPdf) acts.push(d)
  }
  return acts.sort()
}

// ── Main ──────────────────────────────────────────────────────────────

const index = readJson(path.join(LEG_SRC, "legislation_index.json"), [])
const actIndex = new Map()
for (const e of index) {
  if (e.type === "act" && !actIndex.has(e.title)) {
    actIndex.set(e.title, { act: e, sl: [] })
  }
}
for (const e of index) {
  if (e.type === "subsidiary_legislation" && actIndex.has(e.parent_act)) {
    actIndex.get(e.parent_act).sl.push(e)
  }
}

const actFolders = discoverActFolders(LEG_SRC)
const slFiles = []
for (const folder of actFolders) {
  const slDir = path.join(folder, "Subsidiary Legislation")
  if (!fs.existsSync(slDir)) continue
  for (const f of fs.readdirSync(slDir)) {
    if (f.toLowerCase().endsWith(".pdf")) slFiles.push({ folder, file: path.join(slDir, f), name: f })
  }
}

const rnd = mulberry32(SEED)
const sampledActs = sampleOf(actFolders, PERCENT, rnd)
const sampledSl = sampleOf(slFiles, PERCENT, rnd)

// Shard by Act folder, not by file: parse_audit.json accumulates per folder as
// the folder's files are parsed, so splitting one folder across processes would
// leave each shard with a partial count and the last writer would win.
const SHARD = process.env.SHARD ? parseInt(process.env.SHARD, 10) : 0
const SHARDS = process.env.SHARDS ? parseInt(process.env.SHARDS, 10) : 1
const allFolders = [...new Set([...actFolders, ...slFiles.map((s) => s.folder)])].sort()
const shardOf = new Map(allFolders.map((f, i) => [f, i % SHARDS]))
const mine = (folder) => SHARDS === 1 || shardOf.get(folder) === SHARD
const myActs = sampledActs.filter(mine)
const mySl = sampledSl.filter((s) => mine(s.folder))

console.log(
  `corpus: ${actFolders.length} Acts, ${slFiles.length} SL  |  ` +
    `sample (${PERCENT}%): ${sampledActs.length} Acts, ${sampledSl.length} SL  |  ` +
    `shard ${SHARD}/${SHARDS}: ${myActs.length} Acts, ${mySl.length} SL`,
)

// A sharded run must not wipe the output from every process — the caller
// clears it once before starting the shards.
if (SHARDS === 1) fs.rmSync(OUT, { recursive: true, force: true })

/** Per-Act-folder accumulator, so parse_audit.json can report the total. */
const folderSections = new Map()
const bump = (actName, n) => folderSections.set(actName, (folderSections.get(actName) || 0) + n)

let written = 0
let empty = 0
let errors = 0
const empties = []

async function parseOne(pdfPath) {
  const text = extractPdfText(fs.readFileSync(pdfPath), { tables: true })
  if (!text.trim()) return null
  const sections = splitLegislationSections(text)
  return chunkLegislationSections(sections, chunkOpts)
}

// ── Acts ──
for (const folder of myActs) {
  const actName = path.basename(folder)
  const pdf = fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.toLowerCase().endsWith(".pdf"))
    .map((f) => f.name)
    .sort()[0]
  const entry = actIndex.get(actName)?.act
  const meta = entry
    ? { sso_url: entry.url || "", sso_title: entry.title || "", sso_number: "", sso_has_pdf: true }
    : null
  try {
    const sections = await parseOne(path.join(folder, pdf))
    if (!sections) {
      empty++
      empties.push(path.relative(LEG_SRC, path.join(folder, pdf)))
      continue
    }
    writeMd(path.join(OUT, actName, `${actName}.md`), sections, meta)
    bump(actName, sections.length)
    written++
  } catch (e) {
    errors++
    console.error(`  ERROR ${actName}: ${e.message}`)
  }
}

// ── Subsidiary legislation ──
for (const sl of mySl) {
  const actName = path.basename(sl.folder)
  const stem = sl.name.replace(/\.pdf$/i, "")
  const entry = (actIndex.get(actName)?.sl || []).find((e) =>
    stem.startsWith(sanitiseFilename(e.title || "").slice(0, 50)),
  )
  const meta = entry
    ? {
        sso_url: entry.url || "",
        sso_title: entry.title || "",
        sso_number: entry.number || "",
        sso_has_pdf: entry.has_pdf === undefined ? true : entry.has_pdf,
      }
    : null
  try {
    const sections = await parseOne(sl.file)
    if (!sections) {
      empty++
      empties.push(path.relative(LEG_SRC, sl.file))
      continue
    }
    writeMd(path.join(OUT, actName, "Subsidiary Legislation", `${stem}.md`), sections, meta)
    bump(actName, sections.length)
    written++
  } catch (e) {
    errors++
    console.error(`  ERROR ${sl.name}: ${e.message}`)
  }
}

// ── parse_audit.json, one per Act folder touched ──
for (const [actName, sections] of folderSections) {
  const p = path.join(OUT, actName, "parse_audit.json")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  // `warnings` mirrors the reference's key; their BODY-BLEED heuristic lives in
  // ingest_shared/pdf_ingest.py, which is not in this workspace, so it is not
  // reproduced here and the list is always empty.
  fs.writeFileSync(p, JSON.stringify({ act: actName, sections, warnings: [] }, null, 2), "utf8")
}

console.log(JSON.stringify({ shard: SHARD, written, empty, errors, actFolders: folderSections.size }))
for (const e of empties) console.log(`  empty: ${e}`)
