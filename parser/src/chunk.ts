/**
 * Budget-based text chunking used by the legislation parser.
 *
 * Both corpora are sectioned first — judgments by paragraph number, legislation
 * by printed section number — and a section that is larger than the embedding
 * model's window is then split at paragraph boundaries.  The budget is counted
 * in whatever unit `measure` returns: characters by default, or tokens when a
 * real tokenizer is injected.
 *
 * Splitting only ever happens at a blank line, so a sentence, a list item and
 * a table row are never cut in half.
 *
 * No external dependencies.
 */

/**
 * Measure a string in whatever unit the section budget is expressed in.
 *
 * May be async so a real tokenizer can be injected: the parser measures with
 * the Qwen3 embedding tokenizer (`token-budget.ts`) at the 1,024-token budget,
 * so a chunk's size is a real cap in the model's own unit.
 */
export type TextMeasure = (text: string) => number | Promise<number>

/**
 * Default chunk budget: 1,024 tokens — the embedding model's chunk budget,
 * with headroom under its 1,200-token serving window.  The chunker itself is
 * unit-agnostic; production callers pass the Qwen3 token measure from
 * `token-budget.ts`.
 */
export const DEFAULT_CHUNK_BUDGET = 1024

/** Split text on double-newline boundaries. */
export function splitParagraphs(md: string): string[] {
  return md
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/**
 * Split a block that exceeds the budget on its own.
 *
 * Break points are tried in order of preference: sentence ends, then word
 * boundaries, then characters.  Whitespace is preserved exactly — each piece
 * carries its trailing whitespace — so concatenating the pieces reproduces the
 * original block byte for byte.  Only the last resort (a single token longer
 * than the budget) drops whitespace.
 */
export async function splitOversized(
  block: string,
  budget: number,
  measure: TextMeasure,
): Promise<string[]> {
  const pieces: string[] = []
  let current: string[] = []
  let currentLen = 0
  const flush = () => {
    if (current.length > 0) {
      pieces.push(current.join(""))
      current = []
      currentLen = 0
    }
  }
  const push = async (atom: string, len: number) => {
    if (current.length > 0 && currentLen + len > budget) flush()
    current.push(atom)
    currentLen += len
  }

  // Sentence ends first: `word.` / `word?` / `word!` plus the whitespace after.
  const sentences = block.match(/[^.!?]*[.!?]+\s*|[^.!?]+$/g) ?? [block]
  for (const sentence of sentences) {
    const sentenceLen = await measure(sentence)
    if (sentenceLen <= budget) {
      await push(sentence, sentenceLen)
      continue
    }
    flush()
    // Sentence too long: fall back to word boundaries.
    for (const word of sentence.match(/\S+\s*/g) ?? []) {
      const wordLen = await measure(word)
      if (wordLen <= budget) {
        await push(word, wordLen)
        continue
      }
      flush()
      // A single word longer than the budget: hard split on characters.
      let buffer = ""
      for (const ch of word) {
        if (buffer && (await measure(buffer + ch)) > budget) {
          pieces.push(buffer)
          buffer = ""
        }
        buffer += ch
      }
      if (buffer) pieces.push(buffer)
    }
    flush()
  }
  flush()
  return pieces
}

/**
 * Group consecutive paragraphs into chunks that stay near `budget` units.
 *
 * A paragraph is kept whole unless it exceeds the budget on its own, in which
 * case it is split by {@link splitOversized} so no chunk can overshoot.  The
 * `measure` is what the budget counts — character length by default, or an
 * injected tokenizer for a token budget.
 */
export async function groupByBudget(
  paragraphs: string[],
  budget = DEFAULT_CHUNK_BUDGET,
  measure: TextMeasure = (t) => t.length,
): Promise<string[]> {
  const chunks: string[] = []
  let current: string[] = []
  let currentLen = 0
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join("\n\n"))
      current = []
      currentLen = 0
    }
  }

  for (const para of paragraphs) {
    const paraLen = await measure(para)
    const blocks = paraLen > budget ? await splitOversized(para, budget, measure) : [para]
    for (const block of blocks) {
      const len = blocks.length === 1 ? paraLen : await measure(block)
      if (current.length > 0 && currentLen + len > budget) flush()
      current.push(block)
      currentLen += len
    }
  }
  flush()
  return chunks
}
