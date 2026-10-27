/**
 * Glyph overrides for the LaTeX math fonts used by the AGC legislation PDFs.
 *
 * Those PDFs embed the standard Computer Modern math fonts
 * (`TeX_CM_Maths_Symbols`, `TeX_CM_Maths_Italic`, `TeX_CM_Maths_Extension`)
 * but ship a /ToUnicode CMap that is a plain ASCII identity map: glyph code N
 * decodes to the character with code N-1, regardless of what the glyph actually
 * draws.  So `×` (drawn from the symbol font) decodes to U+FFFD, and the
 * parentheses decode to `ð` / `Þ`.  The rendered page is correct — only the
 * text layer is wrong, and every text extractor that trusts /ToUnicode
 * (including poppler's pdftotext and Ghostscript's txtwrite) reproduces the
 * corruption.
 *
 * The fonts cannot be fixed from metadata: the embedded programs have had their
 * glyph names rewritten (code 134 is named `eth`, code 41 `parenleft`, …), so
 * neither the encoding nor the CMap identifies a glyph.  The tables below were
 * therefore built empirically: each font was re-embedded into a synthetic PDF,
 * every code that occurs in the corpus was rendered, and the glyph was read off
 * the rendering.  The keys are the codes that actually occur in
 * `legislation/2026-05-30`; a code outside the table keeps its (wrong) CMap
 * value rather than being guessed at.
 *
 * To extend or rebuild the tables, see `scripts/build-math-glyph-sheet.mjs`.
 */
export const TEX_MATH_GLYPHS: Record<string, Record<number, string>> = {
  // Computer Modern math symbols (cmsy10-like).
  TeX_CM_Maths_Symbols: {
    1: "\u2212", // −  minus
    2: "\u22c5", // ⋅  dot operator
    3: "\u00d7", // ×  multiply
    4: "\u2217", // ∗  asterisk operator
    5: "\u00f7", // ÷  divide
    47: "\u2216", // ∖  set minus
    48: "\u2205", // ∅  empty set
    49: "/", //      /  slash
    50: "\u221e", // ∞  infinity
    51: "\u2208", // ∈  element of
    52: "\u220b", // ∋  contains as member
    134: "(", //     (  parenleft
    135: ")", //     )  parenright
    136: "+", //     +  plus
    137: "=", //     =  equals
    138: "[", //     [  bracketleft
    139: "]", //     ]  bracketright
  },

  // Computer Modern math italic (cmmi10-like).
  TeX_CM_Maths_Italic: {
    55: "6",
    56: "7",
    57: "8",
    58: "9",
    59: ".",
    60: ",",
    61: "<",
    62: "/",
    63: ">",
    64: "\u22c6", // ⋆  star operator
  },

  // Computer Modern math extensions (cmex10-like): big delimiters, radicals
  // and integrals.  Stretchable delimiters are drawn as stacked pieces; each
  // piece is mapped to its Unicode bracket-piece character.
  TeX_CM_Maths_Extension: {
    1: "(",
    2: ")",
    3: "[",
    4: "]",
    9: "{",
    10: "}",
    17: "\u239b", // ⎛
    18: "\u239d", // ⎝
    19: "\u239c", // ⎜
    20: "\u239e", // ⎞
    21: "\u23a0", // ⎠
    22: "\u239f", // ⎟
    27: "\u23a3", // ⎣
    28: "\u23a6", // ⎦
    35: "\u23aa", // ⎪
    36: "\u23aa", // ⎪
    47: "\u221a", // √  radical
    49: "\u239b", // ⎛  large-parenthesis top-left piece
    50: "\u239e", // ⎞  large-parenthesis top-right piece
    65: "\u23a7", // ⎧
    66: "\u23a8", // ⎨
    67: "\u23a9", // ⎩
    68: "\u23ab", // ⎫
    105: "\u23a1", // ⎡  large square-bracket piece
    106: "\u23a4", // ⎤  large square-bracket piece
    113: "\u221a", // √  radical
    114: "\u221a", // √  radical
    116: "\u221a", // √  radical
    130: "\u221a", // √  radical
  },
}

/**
 * Glyph-name overrides for the Monotype "Advantage" symbol fonts used by the
 * AGC legislation PDFs (`AdvP4C4E74`, `AdvP4C4E46`, `AdvP4C4E51`).
 *
 * These are CFF (Type1C) subsets with a broken name table.  Their
 * `/Differences` array labels the glyphs with names that do not describe the
 * outlines — the glyph named `eth` draws `(`, `thorn` draws `+`, `onehalf`
 * draws `[`, and the operator glyphs carry bare subset labels (`C0`, `C2`,
 * `C138`) that resolve to nothing, so the extractor either emits the wrong
 * character (`ð`, `Þ`, `þ`, `¼`) or silently drops the glyph.  The rendered
 * page is correct; only the text layer is wrong, and every extractor that
 * trusts the name table (including pdftotext and Ghostscript) reproduces the
 * corruption.
 *
 * The tables are keyed by glyph *name*, not by code: the subset remaps codes
 * per document (Hire-Purchase maps `1/C0 3/C2`; COVID-19 maps `1/C2 3/C0`),
 * but the label a glyph carries is stable across documents.  They were built
 * empirically by re-embedding each font into a synthetic PDF, rendering each
 * glyph, and reading the outline off the rendering (see
 * `scripts/build-cff-glyph-sheet.mjs`).
 *
 * `AdvP4C4E46` also draws large stretchable delimiters as *stacked pieces*
 * (a top piece, a shaft, a bottom piece).  Only the single-glyph labels whose
 * identity is confirmed by the rendered formulas are listed here; the piece
 * labels are deliberately left unmapped rather than guessed at.
 */
export const SYMBOL_FONT_GLYPHS: Record<string, Record<string, string>> = {
  // Monotype Advantage math symbol font: operators, small delimiters and the
  // square/round/curly bracket glyphs.
  AdvP4C4E74: {
    eth: "(", //  (  parenleft
    Thorn: ")", //  )  parenright
    thorn: "+", //  +  plus
    onequarter: "=", //  =  equals
    onehalf: "[", //  [  bracketleft
    C138: "]", //  ]  bracketright
    g: "}", //  }  braceright
    C0: "\u2212", //  −  minus
    C2: "\u00d7", //  ×  multiply
  },

  // Monotype Advantage large-delimiter font.  The `C18`/`C19` pair is a single
  // round bracket (confirmed on the Hire-Purchase formula); the `C0`..`C3`,
  // `C20`/`C21` and `C26`/`C27` pairs are the smaller bracket / brace faces.
  AdvP4C4E46: {
    C0: "(",
    C1: ")",
    C2: "[",
    C3: "]",
    C18: "(",
    C19: ")",
    C20: "[",
    C21: "]",
    C26: "{",
    C27: "}",
  },
}

/**
 * Code-keyed overrides for the symbol fonts that carry no `/Differences`
 * array, so their codes are fixed by the font's built-in encoding rather
 * than remapped per document.
 *
 * `AdvP4C4E74` carries the same named glyphs as its `/Differences` form, but
 * some subsets omit the array entirely and declare only
 * `/Encoding/WinAnsiEncoding`, so code `222` decodes to `Þ`, `240` to `ð` and
 * `254` to `þ`.  Those glyphs sit at their standard Adobe codes (confirmed by
 * the `/Widths` array: `Thorn`/`eth` are 385, `thorn` 770), so a code-keyed
 * fallback recovers them.  It is only consulted when the font has no
 * `/Differences` array, because a present array remaps the codes per document
 * and its names are authoritative.  `AdvP4C4E51` carries only the two
 * punctuation glyphs below and never declares `/Differences`.
 */
export const SYMBOL_FONT_CODES: Record<string, Record<number, string>> = {
  AdvP4C4E74: {
    103: "}", //  }  braceright
    188: "=", //  =  equals
    189: "[", //  [  bracketleft
    222: ")", //  )  parenright
    240: "(", //  (  parenleft
    254: "+", //  +  plus
  },
  AdvP4C4E51: {
    58: ".", //  .  period
    59: ",", //  ,  comma
  },
}

/**
 * Resolve a glyph *name* to the character its outline actually draws, for the
 * Monotype symbol fonts.  Returns `undefined` when the font has no name-keyed
 * overrides or the name is not listed, so the caller falls back to the normal
 * Adobe glyph-name table.
 */
export function symbolGlyphName(
  baseFont: string | undefined,
  name: string,
): string | undefined {
  return baseFont ? SYMBOL_FONT_GLYPHS[baseFont]?.[name] : undefined
}

/**
 * Return `cmap` with the math-font overrides for `baseFont` applied.  Returns
 * the input unchanged when the font carries no overrides, so the common case
 * allocates nothing.
 *
 * `hasDifferences` suppresses the code-keyed symbol-font table: a
 * `/Differences` array remaps the codes per document, so its glyph names (which
 * the caller has already resolved) are authoritative and the standard-code
 * fallback must not overwrite them.
 */
export function applyTexMathGlyphs(
  baseFont: string | undefined,
  cmap: Map<number, string>,
  hasDifferences = false,
): Map<number, string> {
  const overrides = baseFont ? TEX_MATH_GLYPHS[baseFont] : undefined
  const codes = baseFont && !hasDifferences ? SYMBOL_FONT_CODES[baseFont] : undefined
  if (!overrides && !codes) return cmap
  const out = new Map(cmap)
  if (overrides) for (const [code, ch] of Object.entries(overrides)) out.set(Number(code), ch)
  if (codes) for (const [code, ch] of Object.entries(codes)) out.set(Number(code), ch)
  return out
}

/** True when `baseFont` is one of the broken LaTeX math fonts. */
export function isTexMathFont(baseFont: string | undefined): boolean {
  return baseFont !== undefined && TEX_MATH_GLYPHS[baseFont] !== undefined
}
