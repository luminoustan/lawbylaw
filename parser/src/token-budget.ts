/**
 * The embedding token budget and the Qwen3 tokenizer that measures it.
 *
 * Every chunker in the parser — the two parse scripts, the golden-corpus
 * baseline and the `parse_legislation` tool — measures
 * with this tokenizer at {@link EMBEDDING_TOKEN_BUDGET} tokens, so one budget
 * and one unit cover the whole pipeline.  There is no character mode: when the
 * tokenizer cannot be loaded the caller fails with an actionable error rather
 * than silently chunking by character count.
 *
 * The native `tokenizers` binding is a native module, so it is
 * resolved at runtime from the caller's roots (the workspace) and the
 * tokenizer JSON is cached under `<root>/.cache/`, fetched from
 * HuggingFace on first use.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { createRequire } from "node:module"
import type { TextMeasure } from "./chunk"

/** The embedding model's chunk budget, in Qwen3 tokens. */
export const EMBEDDING_TOKEN_BUDGET = 1024

/** The Qwen3 tokenizer the embedding model uses. */
export const QWEN_TOKENIZER_URL =
  "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/resolve/main/tokenizer.json"

/** Where the tokenizer JSON is cached under a root. */
export function tokenizerCachePath(root: string): string {
  return path.join(root, ".cache", "cache", "qwen3-tokenizer.json")
}

interface QwenEncoding {
  getIds(): number[]
}

interface QwenTokenizer {
  encode(text: string): Promise<QwenEncoding>
}

interface TokenizersModule {
  Tokenizer: { fromFile(path: string): QwenTokenizer }
}

/** Resolve `tokenizers` from a root's node_modules, then from this module. */
async function loadTokenizers(roots: string[]): Promise<TokenizersModule> {
  for (const root of roots) {
    try {
      const req = createRequire(path.join(root, "package.json"))
      return req("tokenizers") as TokenizersModule
    } catch {
      // try the next root
    }
  }
  try {
    // A non-literal specifier so a bundler leaves the import to runtime; in
    // it resolves from this package's own node_modules.
    const spec = "tokenizers"
    return (await import(spec)) as TokenizersModule
  } catch {
    throw new Error(
      "`tokenizers` is not installed — the parser chunks at 1,024 tokens and has no " +
        "character fallback.  Install it (npm i tokenizers) in the workspace, or point " +
        "QWEN_TOKENIZER_JSON at a tokenizer.json.",
    )
  }
}

/** The cached tokenizer JSON to read, or null when none exists yet. */
function findTokenizerJson(roots: string[]): string | null {
  const override = process.env.QWEN_TOKENIZER_JSON
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`QWEN_TOKENIZER_JSON not found: ${override}`)
    }
    return override
  }
  for (const root of roots) {
    const candidate = tokenizerCachePath(root)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** Fetch the tokenizer JSON once, so a fresh checkout needs no manual step. */
async function downloadTokenizer(jsonPath: string): Promise<string> {
  const url = process.env.QWEN_TOKENIZER_URL ?? QWEN_TOKENIZER_URL
  try {
    console.error(`fetching Qwen3 tokenizer from ${url}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
    fs.writeFileSync(jsonPath, Buffer.from(await res.arrayBuffer()))
    return jsonPath
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(
      `could not fetch the Qwen3 tokenizer (${msg}) — the parser chunks at 1,024 tokens ` +
        `and has no character fallback; place tokenizer.json at ${jsonPath}`,
      { cause: e },
    )
  }
}

const measures = new Map<string, Promise<TextMeasure>>()

/**
 * Load the Qwen3 token measure, cached per root set for the process lifetime.
 *
 * The tokenizer JSON is read from `<root>/.cache/qwen3-tokenizer.json`
 * (or `QWEN_TOKENIZER_JSON`) and fetched when absent; the native binding is
 * resolved from the roots' node_modules.  Throws — never falls back to
 * characters — when either is unavailable.
 */
export function loadEmbeddingMeasure(roots: string[]): Promise<TextMeasure> {
  const key = roots.join("\u0000")
  let measure = measures.get(key)
  if (!measure) {
    measure = createMeasure(roots).catch((e) => {
      measures.delete(key)
      throw e
    })
    measures.set(key, measure)
  }
  return measure
}

async function createMeasure(roots: string[]): Promise<TextMeasure> {
  const cached = findTokenizerJson(roots)
  const jsonPath = cached ?? (await downloadTokenizer(tokenizerCachePath(roots[0])))
  const { Tokenizer } = await loadTokenizers(roots)
  const tok = Tokenizer.fromFile(jsonPath)
  const counts = new Map<string, number>()
  return async (text: string) => {
    let n = counts.get(text)
    if (n === undefined) {
      if (counts.size > 100_000) counts.clear()
      n = (await tok.encode(text)).getIds().length
      counts.set(text, n)
    }
    return n
  }
}
