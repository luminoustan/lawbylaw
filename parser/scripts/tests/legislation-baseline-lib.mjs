#!/usr/bin/env node
/**
 * Shared helpers for the golden-corpus regression gate.
 *
 * The gate compares a fresh parse of the legislation corpus against a committed
 * per-file fingerprint baseline, so a parser change that silently drops content
 * fails the test suite instead of shipping.  Both the baseline generator and the
 * comparator import from here so the fingerprint is defined in exactly one place.
 *
 * A fingerprint is deliberately cheap: line/char/section counts plus a hash of
 * the sorted set of per-line hashes.  The counts catch any net decrease (a
 * dropped last line, a lost section); the set hash surfaces a same-length
 * rewrite as *changed* so it can be reviewed.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

export const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")

export const BASELINE_PATH = path.join(
  repoRoot,
  "scripts/tests/fixtures/legislation-baseline.json",
)

/** FNV-1a, 32-bit.  Deterministic and dependency-free. */
export function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Fingerprint a rendered Markdown document.
 *
 * Lines are normalised (trailing whitespace stripped) before hashing so a
 * whitespace-only change does not register.  `setHash` is order-independent, so
 * a reordering of the same lines is not a change.
 */
export function fingerprint(md) {
  const lines = md.split("\n")
  const hashes = lines.map((l) => fnv1a(l.replace(/\s+$/, "")))
  const sorted = [...new Set(hashes)].sort((a, b) => a - b)
  return {
    lines: lines.length,
    chars: md.length,
    sections: (md.match(/^## \[/gm) || []).length,
    setHash: fnv1a(sorted.join(",")).toString(16).padStart(8, "0"),
  }
}

/** Load the committed baseline, or null when it is absent. */
export function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"))
}

/**
 * Resolve the corpus root.  Defaults to `<repo>/legislation/<date>`; override
 * with `LEG_SRC`.  Returns null when the corpus is not present (it is
 * gitignored, so a fresh checkout must skip rather than fail).
 */
export function resolveCorpusRoot(date = "2026-05-30") {
  const src = process.env.LEG_SRC || path.join(repoRoot, "legislation", date)
  return fs.existsSync(src) ? src : null
}

/**
 * Render one PDF exactly as `parse-legislation.mjs` does, so the fingerprint
 * matches the corpus output byte for byte.  `meta` is the SSO frontmatter entry
 * (or null); the caller resolves it from the legislation index.
 */
export async function renderPdf(pdfPath, chunkOpts, meta = null) {
  const { extractPdfText } = await import(
    pathToFileURL(path.join(repoRoot, "src/pdf/extract.ts")).href
  )
  const { chunkLegislationSections, renderLegislationMarkdown, splitLegislationSections } =
    await import(
      pathToFileURL(
        path.join(repoRoot, "src/legislation/split.ts"),
      ).href
    )
  const text = extractPdfText(fs.readFileSync(pdfPath), { tables: true })
  if (!text.trim()) return null
  const sections = await chunkLegislationSections(splitLegislationSections(text), chunkOpts)
  const parts = []
  const fm = frontmatter(meta)
  if (fm) parts.push(fm)
  parts.push(renderLegislationMarkdown(sections))
  return parts.join("\n\n---\n\n")
}

/** Python `str.rstrip(". ")` plus the invalid-character substitution. */
export function sanitiseFilename(name) {
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
export function frontmatter(meta) {
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

/**
 * Resolve the SSO frontmatter for one corpus file, mirroring the index lookup in
 * `parse-legislation.mjs`.  `rel` is the corpus-relative `.md` path
 * (`<Act>/<Act>.md` for a principal Act, `<Act>/Subsidiary Legislation/<stem>.md`
 * for an SL).
 */
export function resolveMeta(index, rel) {
  const parts = rel.split(path.sep)
  const actName = parts[0]
  const actIndex = new Map()
  for (const e of index) {
    if (e.type === "act" && !actIndex.has(e.title)) actIndex.set(e.title, { act: e, sl: [] })
  }
  for (const e of index) {
    if (e.type === "subsidiary_legislation" && actIndex.has(e.parent_act)) {
      actIndex.get(e.parent_act).sl.push(e)
    }
  }
  const entry = actIndex.get(actName)
  if (!entry) return null
  if (parts.length === 2) {
    const a = entry.act
    return { sso_url: a.url || "", sso_title: a.title || "", sso_number: "", sso_has_pdf: true }
  }
  const stem = path.basename(rel).replace(/\.md$/i, "")
  const sl = entry.sl.find((e) =>
    stem.startsWith(sanitiseFilename(e.title || "").slice(0, 50)),
  )
  if (!sl) return null
  return {
    sso_url: sl.url || "",
    sso_title: sl.title || "",
    sso_number: sl.number || "",
    sso_has_pdf: sl.has_pdf === undefined ? true : sl.has_pdf,
  }
}

/** Load the legislation index for the corpus, or an empty list when absent. */
export function loadIndex(src) {
  try {
    return JSON.parse(fs.readFileSync(path.join(src, "legislation_index.json"), "utf8"))
  } catch {
    return []
  }
}

/**
 * Build the chunk options the parse runner uses: the Qwen3 token measure at
 * the 1,024-token budget.  Mirrors `parse-legislation.mjs`; there is no
 * character fallback, so a missing tokenizer fails the gate rather than
 * silently changing the unit.
 */
export async function makeChunkOpts() {
  const { EMBEDDING_TOKEN_BUDGET, loadEmbeddingMeasure } = await import(
    pathToFileURL(path.join(repoRoot, "src/token-budget.ts")).href
  )
  const tokenBudget = Number(process.env.TOKEN_BUDGET ?? EMBEDDING_TOKEN_BUDGET)
  const measure = await loadEmbeddingMeasure([repoRoot])
  return { budget: tokenBudget, measure }
}

/** Run `worker` over `items` with `concurrency` workers, preserving order. */
export async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  const run = async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return results
}
