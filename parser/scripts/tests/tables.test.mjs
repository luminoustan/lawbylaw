#!/usr/bin/env node
/**
 * Tier 1 — unit tests for the table renderer (`pdf/tables.ts`).
 *
 * The renderer is a pure function of the structured line model, so these tests
 * build `TextLine[]` fixtures directly — no PDF or build step needed.  Run:
 *
 *   node scripts/tests/tables.test.mjs
 *
 * Exits non-zero on the first failed assertion group so `run-tests.sh` fails.
 */
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")
const { renderTables, renderPlainText, renderPlainLine } = await import(
  pathToFileURL(path.join(repoRoot, "src/pdf/tables.ts")).href
)
const { applyTexMathGlyphs, isTexMathFont, symbolGlyphName } = await import(
  pathToFileURL(path.join(repoRoot, "src/pdf/tex-math-fonts.ts")).href
)

/** SSO corpus root (not shipped; set LEG_SRC). Corpus-backed checks skip when absent. */
const CORPUS = process.env.LEG_SRC || path.join(repoRoot, "legislation", "2026-05-30")

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

/** A run with an explicit x-extent. */
const r = (x, xEnd, text, y, size = 10) => ({ x, xEnd, y, size, text })
/** A line built from `[x, xEnd, text]` cells. */
const line = (y, cells, size = 10) => ({
  y,
  runs: cells.map(([x, xEnd, text]) => r(x, xEnd, text, y, size)),
})

check("renders a two-column table with a header", () => {
  const md = renderTables([
    line(100, [[70, 160, "First column"], [260, 380, "Second column"]]),
    line(90, [[70, 180, "Replaced section"], [260, 390, "Applicable section"]]),
    line(80, [[70, 100, "(i) 7"], [320, 360, "34D"]]),
    line(70, [[70, 105, "(ii) 8"], [320, 360, "34F"]]),
  ])
  assert.match(md, /^\| First column \| Second column \|$/m)
  assert.match(md, /^\| --- \| --- \|$/m)
  assert.match(md, /^\| Replaced section \| Applicable section \|$/m)
  assert.match(md, /^\| \(i\) 7 \| 34D \|$/m)
})

check("folds wrapped cell lines into one row", () => {
  const md = renderTables([
    line(100, [[70, 160, "First column"], [260, 380, "Second column"]]),
    line(90, [[70, 180, "(iii) an employee's"], [260, 380, "a platform worker"]]),
    line(80, [[70, 220, "employment with an"], [260, 390, "a platform service"]]),
    line(70, [[70, 200, "employer"], [260, 300, "agreement"]]),
  ])
  assert.match(
    md,
    /^\| \(iii\) an employee's employment with an employer \| a platform worker a platform service agreement \|$/m,
  )
})

check("keeps a full-width group row on its own line", () => {
  const md = renderTables([
    line(100, [[70, 160, "First column"], [260, 380, "Second column"]]),
    line(90, [[70, 235, "Diseases caused by physical agents"]]),
    line(80, [[70, 135, "1. Barotrauma"], [300, 360, "12 months"]]),
  ])
  assert.match(md, /^\| Diseases caused by physical agents \| {2}\|$/m)
})

check("a larger-font all-caps heading closes the table above it", () => {
  // The Estate Duty Act's Second Schedule opens on the page below the First
  // Schedule's last rate row.  Its heading is all caps and set in a larger
  // font, so it ends the table rather than joining it as a group row.
  const md = renderTables([
    line(100, [[70, 160, "Principal value of the estate"], [260, 380, "Rate of duty"]]),
    line(90, [[70, 180, "For every dollar of the first $100,000"], [260, 300, "Nil"]]),
    { y: 80, runs: [r(150, 230, "SECOND SCHEDULE", 80, 13)] },
    line(70, [[70, 140, "RATES OF ESTATE DUTY IN THE CASE OF"]]),
    line(60, [[70, 160, "Principal value of the estate"], [260, 380, "Rate of duty"]]),
    line(50, [[70, 180, "For every dollar of the first $200,000"], [260, 300, "Nil"]]),
  ])
  assert.match(md, /^\| For every dollar of the first \$100,000 \| Nil \|$/m)
  assert.match(md, /^SECOND SCHEDULE$/m)
  assert.match(md, /^RATES OF ESTATE DUTY IN THE CASE OF$/m)
  assert.match(md, /^\| For every dollar of the first \$200,000 \| Nil \|$/m)
})

check("drops a lone dot sitting between two header cells", () => {
  const md = renderTables([
    line(100, [[70, 160, "First column"], [210, 215, "."], [260, 380, "Second column"]]),
    line(90, [[70, 100, "(i) 7"], [320, 360, "34D"]]),
    line(80, [[70, 105, "(ii) 8"], [320, 360, "34F"]]),
  ])
  assert.match(md, /^\| First column \| Second column \|$/m)
  assert.doesNotMatch(md, /\. Second column/)
})

check("folds a hanging list-marker column into the cell it labels", () => {
  const md = renderTables([
    line(100, [[70, 200, "First column"], [260, 420, "Second column"]]),
    line(90, [[70, 200, "1. Residential developments"], [225, 231, "(a)"], [260, 420, " 1 car parking lot"]]),
    line(80, [[70, 200, "2. Non-residential developments"], [225, 231, "(a)"], [260, 420, " 1 car parking lot"]]),
  ])
  assert.match(md, /^\| 1\. Residential developments \| \(a\) 1 car parking lot \|$/m)
  assert.doesNotMatch(md, /^\| --- \| --- \| --- \|$/m)
})

check("keeps leader dots in a column that carries real values", () => {
  const md = renderTables([
    line(100, [[70, 160, "Loan"], [200, 240, "1"], [300, 340, "2"], [400, 440, "3"]]),
    line(90, [[70, 100, "1"], [200, 240, "10,000"], [300, 310, "."], [400, 410, "."]]),
    line(80, [[70, 100, "2"], [200, 240, "10,000"], [300, 340, "5,152"], [400, 440, "6,867"]]),
  ])
  assert.match(md, /^\| 1 \| 10,000 \| \. \| \. \|$/m)
})

check("keeps non-alphanumeric cell content such as checkboxes", () => {
  const md = renderTables([
    line(100, [[70, 160, "Item"], [300, 340, "A"], [400, 440, "B"]]),
    line(90, [[70, 100, "9a"], [300, 310, "\u25A1"], [400, 410, "\u25A1"]]),
    line(80, [[70, 100, "9b"], [300, 310, "\u25A1"], [400, 410, "\u25A1"]]),
  ])
  assert.match(md, /^\| 9a \| \u25A1 \| \u25A1 \|$/m)
})

check("keeps an apostrophe inside a word", () => {
  const md = renderTables([
    line(100, [[70, 160, "First column"], [260, 380, "Second column"]]),
    {
      y: 90,
      runs: [
        r(70, 90, "(i)", 90),
        r(260, 290, "worker", 90),
        r(290, 295, "\u2019", 90),
        r(295, 300, "s", 90),
        r(340, 360, "12", 90),
      ],
    },
    line(80, [[70, 90, "(ii)"], [260, 300, "employer"], [340, 360, "15"]]),
  ])
  assert.match(md, /worker\u2019s/)
})

check("synthesises a header when a block starts mid-table", () => {
  const md = renderTables([
    line(90, [[70, 100, "(i) 7"], [320, 360, "34D"]]),
    line(80, [[70, 105, "(ii) 8"], [320, 360, "34F"]]),
  ])
  assert.match(md, /^\| {2}\| {2}\|$/m)
  assert.match(md, /^\| \(i\) 7 \| 34D \|$/m)
})

check("does not table a justified line with stale-x runs", () => {
  // `9(1)(a)(i)` is drawn without a `Td`, so every run in the group keeps the
  // same x and the group's reported right edge falls short of the next word.
  // The inflated gap passes the table threshold; the prose must survive.
  const stale = (marker, ref) => [
    [97.51, 101.84, "("],
    [97.51, 104.01, marker],
    [97.51, 101.84, ")"],
    [119.17, 131.44, " an"],
    [136.12, 163.55, " order"],
    [168.21, 176.88, " is"],
    [181.59, 209.74, " made"],
    [214.41, 244.01, " under"],
    [248.71, 285.54, " section"],
    [290.21, 316.20, " 9(1)("],
    [290.21, 296.71, "a"],
    [290.21, 306.81, ref],
    [344.01, 401.80, " prohibiting"],
    [406.49, 422.37, " the"],
  ]
  const lines = [line(100, stale("b", ")(i)")), line(90, stale("c", ")(ii)"))]
  const md = renderTables(lines)
  assert.equal(md, renderPlainText(lines))
  assert.doesNotMatch(md, /\|/)
})

check("does not promote a label row to the header", () => {
  // A legislative-history block opens with `Bill | : G.N. No. …`; the first row
  // is data, so the table is given an empty header instead.
  const md = renderTables([
    line(100, [[70, 100, "Bill"], [200, 360, ": G.N. No. 1311/1932"]]),
    line(90, [[70, 160, "First Reading"], [200, 360, ": 8 August 1932"]]),
    line(80, [[70, 170, "Second Reading"], [200, 360, ": 19 October 1932"]]),
  ])
  assert.match(md, /^\| {2}\| {2}\|$/m)
  assert.match(md, /^\| Bill \| : G\.N\. No\. 1311\/1932 \|$/m)
})

check("leaves prose untouched", () => {
  const prose = [
    line(100, [[70, 300, "This is a sentence of ordinary prose that"]]),
    line(90, [[70, 320, "continues on the next line without any columns."]]),
  ]
  assert.equal(renderTables(prose), renderPlainText(prose))
})

check("does not turn a single line into a table", () => {
  const one = [line(100, [[70, 160, "First column"], [260, 380, "Second column"]])]
  assert.equal(renderTables(one), renderPlainText(one))
})

check("plain render joins lines and preserves blank lines", () => {
  const lines = [
    line(100, [[70, 100, "Hello"], [100, 140, " world"]]),
    { y: 90, runs: [] },
    line(80, [[70, 90, "Bye"]]),
  ]
  assert.equal(renderPlainText(lines), "Hello world\n\nBye")
})

check("moves an out-of-order math bracket back into place", () => {
  const mk = (x, xEnd, text, mathFont) => ({ x, xEnd, y: 100, size: 10, text, mathFont })
  const line = {
    y: 100,
    runs: [
      mk(205, 229, "50%"),
      mk(236, 246, " \u00d7", true),
      mk(258, 268, " A"),
      mk(271, 281, " \u2212", true),
      mk(284, 292, " B"),
      mk(253, 258, "(", true),
      mk(292, 297, ")", true),
      mk(292, 296, ","),
    ],
  }
  assert.equal(renderPlainLine(line), "50% \u00d7 (A \u2212 B),")
})

check("does not move runs when x is unreliable", () => {
  // Words drawn with no repositioning between calls: every x but the first is
  // the stale text-matrix origin, so nothing may be reordered.
  const runs = [
    r(144, 156, "23", 100),
    r(180, 191, " In", 100),
    r(217, 245, "event", 100),
    r(147, 163, "the", 100),
    r(166, 220, "applicant\u2019s", 100),
  ]
  const raw = runs.map((x) => x.text).join("").replace(/\s+/g, " ").trim()
  assert.equal(renderPlainLine({ y: 100, runs }), raw)
})

// ── Stacked fractions ────────────────────────────────────────────────────────
// A fraction is a small-font numerator above a small-font denominator, both
// straddling the baseline of the surrounding text.  The extractor emits the
// parts as separate lines; the pass rewrites them as `num/den` in place.

check("linearises a stacked fraction into the baseline line", () => {
  // `A` over `B`, then `× C,` on the baseline — the shape of `A/B × C`.  The
  // denominator shares its line with the baseline text, as the extractor emits
  // it when the y-gap is under the line-break threshold.
  const lines = [
    line(100, [[70, 200, "computed by the formula"]]),
    line(104, [[205, 212, "A"]], 7),
    {
      y: 96,
      runs: [
        r(205, 212, "B", 96, 7),
        r(216, 226, "\u00d7", 100),
        r(229, 238, " C", 100),
        r(229, 233, ",", 100),
      ],
    },
  ]
  assert.equal(
    renderPlainText(lines),
    "computed by the formula A/B \u00d7 C,",
  )
})

check("linearises a mixed number", () => {
  // `6` on the baseline, `2` over `3`, then `%` — the shape of `6 2/3%`.
  const lines = [
    line(100, [[70, 90, "(c) 6"], [105, 110, "%"]]),
    line(104, [[95, 100, "2"]], 7),
    {
      y: 96,
      runs: [r(95, 100, "3", 96, 7), r(115, 140, " if the period", 100)],
    },
  ]
  assert.equal(renderPlainText(lines), "(c) 6 2/3 % if the period")
})

check("linearises a fraction whose numerator spans several runs", () => {
  // `C − B` over `C`: the numerator is three runs on its own line, centred on
  // the denominator.  The numerator is compound, so it is parenthesised.
  const lines = [
    line(100, [[70, 90, "A \u00d7"]]),
    line(104, [[95, 100, "C"], [100, 104, "\u2212"], [106, 110, " B"]], 7),
    {
      y: 96,
      runs: [r(99, 104, "C", 96, 7), r(108, 114, ",", 100), r(116, 134, " where", 100)],
    },
  ]
  assert.equal(renderPlainText(lines), "A \u00d7 (C\u2212 B)/C, where")
})

check("does not treat stacked table cells as a fraction", () => {
  // A table column stacks short cells at the same x; the row between them is
  // another cell in that column, so it overlaps the pair rather than sitting
  // beside it.
  const lines = [
    line(120, [[70, 200, "Offence"]]),
    line(107, [[205, 212, "3"]]),
    line(93, [[205, 212, "7"]]),
    line(100, [[205, 212, "2"]]),
  ]
  assert.equal(renderPlainText(lines), "Offence\n3\n7\n2")
})

check("linearises a body-sized fraction beside an operator", () => {
  // Some generators draw the parts at the body size; an operator beside the
  // fraction marks it as math rather than a pair of stacked table cells.
  const lines = [
    line(120, [[70, 200, "computed by the formula"]]),
    line(107, [[205, 212, "C"]]),
    line(93, [[205, 212, "D"]]),
    line(100, [[216, 226, "\u00d7"], [229, 238, " E"], [229, 233, ","]]),
  ]
  assert.equal(renderPlainText(lines), "computed by the formula\nC/D \u00d7 E,")
})

check("parenthesises a compound denominator", () => {
  // `A` over `B + C` must not linearise to `A/B + C`.
  const lines = [
    line(120, [[70, 200, "the rate of tax as ascertained by the formula"]]),
    line(107, [[234, 243, "A"]]),
    line(93, [[222, 231, "B"], [234, 244, " +"], [247, 255, " C"]]),
    line(100, [[258, 264, ","]]),
  ]
  assert.equal(
    renderPlainText(lines),
    "the rate of tax as ascertained by the formula\nA/(B + C),",
  )
})

check("parenthesises a compound numerator", () => {
  const lines = [
    line(120, [[70, 200, "computed by the formula"]]),
    line(107, [[222, 231, "B"], [234, 244, " \u2212"], [247, 255, " C"]]),
    line(93, [[234, 243, "D"]]),
    line(100, [[258, 268, "\u00d7"], [271, 280, " E"]]),
  ]
  assert.equal(renderPlainText(lines), "computed by the formula\n(B \u2212 C)/D \u00d7 E")
})

check("linearises a display fraction framed by a stretchy delimiter", () => {
  // A phrase-long numerator over a single denominator, framed by
  // `\left\{ … \right\}` and set beside the text it multiplies — the shape of
  // `Amount of cash payout × (5 − …)/5`.  The parts are body-sized and the
  // numerator is prose, so only the delimiter frame identifies it; the frame is
  // drawn as stacked math-font pieces, which are dropped.
  const delim = (x, xEnd, text, y) => ({ ...r(x, xEnd, text, y), mathFont: true })
  const lines = [
    line(626, [[280, 444, "5 \u2212 Number of complete years"]]),
    line(611, [[270, 454, "the intellectual property rights were"]]),
    line(596, [[288, 440, "held by the qualifying person"]]),
    line(587, [[119, 175, "Amount of"], [176, 241, " cash payout"], [244, 254, " \u00d7"]]),
    line(578, [[361, 367, "5"]]),
    { y: 636, runs: [delim(257, 268, "\u221b", 636), delim(461, 472, "\u221c", 636)] },
    { y: 614, runs: [delim(257, 268, "\u23a7", 614), delim(461, 472, "\u23a8", 614)] },
  ]
  assert.equal(
    renderPlainText(lines),
    "Amount of cash payout \u00d7 (5 \u2212 Number of complete years the " +
      "intellectual property rights were held by the qualifying person)/5",
  )
})

check("collapses a stretchy delimiter frame around a linearised fraction", () => {
  // `A + (A/B × 150% × C × D),`: the stacked fraction is linearised by the
  // single-row pass, which consumes its parts; the surrounding `\left( …
  // \right)` is drawn as math-font pieces on the row above and must be
  // collapsed to brackets on the formula line rather than left as debris.
  const delim = (x, xEnd, text, y) => ({ ...r(x, xEnd, text, y, 13), mathFont: true })
  const lines = [
    line(130, [[70, 160, "using the formula"]], 13),
    line(
      100,
      [
        [163, 173, "A"],
        [177, 187, " +"],
        [213, 223, "\u00d7"],
        [226, 256, " 150%"],
        [259, 269, " \u00d7"],
        [272, 281, " C"],
        [284, 294, " \u00d7"],
        [297, 306, " D"],
        [315, 319, ","],
      ],
      13,
    ),
    line(109, [[201, 210, "A"]], 13),
    line(91, [[201, 210, "B"]], 13),
    { y: 118, runs: [delim(191, 201, "\u239c", 118), delim(306, 316, " \u239e", 118)] },
  ]
  assert.equal(
    renderPlainText(lines),
    "using the formula\nA + (A/B \u00d7 150% \u00d7 C \u00d7 D),",
  )
})

check("linearises a framed formula holding two stacked fractions", () => {
  // `Sintermediate,i = (GZmax/0.05 × Range/7)^1/4`: two single-row fractions sit
  // side by side over a shared denominator row, a subscript is extracted on its
  // own row, and the frame pieces carry no left bracket at all.  The pieces are
  // right-parenthesis glyphs on both sides, so the left is forced open.
  const delim = (x, xEnd, text, y) => ({ ...r(x, xEnd, text, y, 11), mathFont: true })
  const run = (x, xEnd, text, y, size) => ({ x, xEnd, y, size, text })
  const lines = [
    {
      y: 432.45,
      runs: [
        run(179.9, 186.1, "S", 432.45, 11),
        run(186.1, 224.6, "intermediate", 430.81, 7.7),
        run(186.1, 188.1, ",", 430.81, 7.7),
        run(186.1, 188.2, "i", 430.81, 7.7),
        run(232.3, 240.8, "=", 432.45, 11),
        run(280.5, 288.9, "\u00d7", 432.45, 11),
      ],
    },
    {
      y: 439.94,
      runs: [
        run(249.6, 264.2, "GZ", 439.94, 11),
        run(264.2, 277.5, "max", 438.29, 7.7),
        run(291.4, 319.5, "Range", 439.94, 11),
      ],
    },
    {
      y: 424.91,
      runs: [
        run(254.0, 259.5, "0", 424.91, 11),
        run(254.0, 257.0, ".", 424.91, 11),
        run(254.0, 265.0, "05", 424.91, 11),
        run(302.7, 308.2, "7", 424.91, 11),
      ],
    },
    {
      y: 447.99,
      runs: [
        delim(243.8, 249.6, "\u23a0", 447.99),
        delim(319.5, 325.2, " \u239f", 447.99),
        run(325.2, 327.9, "1", 447.99, 5.5),
      ],
    },
    { y: 442.71, runs: [run(325.2, 327.9, "4", 442.71, 5.5)] },
  ]
  assert.equal(
    renderPlainText(lines),
    "Sintermediate,i = (GZmax/0.05 \u00d7 Range/7)^1/4",
  )
})

check("linearises a framed formula with subscripted denominators", () => {
  // `Sfinal,i = K × (GZmax/TGZmax × Range/TRange)^1/4`: each denominator's
  // `max` subscript is extracted on its own row below the symbol, and the
  // baseline text stops short of the frame.
  const delim = (x, xEnd, text, y) => ({ ...r(x, xEnd, text, y, 11), mathFont: true })
  const run = (x, xEnd, text, y, size) => ({ x, xEnd, y, size, text })
  const lines = [
    {
      y: 136.46,
      runs: [
        run(169.2, 175.3, "S", 136.46, 11),
        run(175.4, 189.5, "final", 136.46, 7.7),
        run(175.4, 177.4, ",", 136.46, 7.7),
        run(175.4, 177.5, "i", 136.46, 7.7),
        run(197.9, 206.3, "=", 136.46, 11),
        run(213.1, 221.0, " K", 136.46, 11),
        run(227.1, 235.6, " \u00d7", 136.46, 11),
        run(285.1, 293.5, "\u00d7", 136.46, 11),
      ],
    },
    {
      y: 143.94,
      runs: [
        run(250.8, 265.5, "GZ", 143.94, 11),
        run(265.5, 278.8, "max", 143.94, 7.7),
        run(299.0, 327.1, "Range", 143.94, 11),
      ],
    },
    {
      y: 128.92,
      runs: [
        run(247.5, 268.8, "TGZ", 128.92, 11),
        run(295.9, 330.2, "TRange", 128.92, 11),
      ],
    },
    { y: 127.28, runs: [run(268.8, 282.1, "max", 127.28, 7.7)] },
    {
      y: 151.99,
      runs: [
        delim(241.7, 247.5, "\u23a0", 151.99),
        delim(330.2, 335.9, " \u239f", 151.99),
        run(335.9, 338.7, "1", 151.99, 5.5),
      ],
    },
    { y: 146.72, runs: [run(335.9, 338.7, "4", 146.72, 5.5)] },
  ]
  assert.equal(
    renderPlainText(lines),
    "Sfinal,i = K \u00d7 (GZmax/TGZmax \u00d7 Range/TRange)^1/4",
  )
})

check("collapses a radical over its radicand", () => {
  // `d = 25 + 1.68√(L(B + D))`: a `\sqrt` is drawn as one root glyph plus a long
  // overbar of repeated radical pieces on the row above the radicand.  The
  // pieces are dropped and the root rebuilt as `√(…)` on the radicand's line.
  const delim = (x, xEnd, text, y) => ({ ...r(x, xEnd, text, y, 11), mathFont: true })
  const run = (x, xEnd, text, y, size) => ({ x, xEnd, y, size, text })
  const lines = [
    {
      y: 443.06,
      runs: [
        run(70.2, 75.7, "d", 443.06, 11),
        run(78.7, 87.2, " =", 443.06, 11),
        run(90.3, 101.3, " 25", 443.06, 11),
        run(103.7, 112.2, " +", 443.06, 11),
        run(114.6, 125.6, " 1.68", 443.06, 11),
        run(145.1, 151.9, "L", 443.06, 11),
        run(145.1, 149.4, "(", 443.06, 11),
        run(145.1, 152.5, "B", 443.06, 11),
        run(165.9, 174.4, " +", 443.06, 11),
        run(176.8, 184.7, " D", 443.06, 11),
        run(176.8, 181.0, ")", 443.06, 11),
      ],
    },
    {
      y: 452.47,
      runs: [
        delim(134.1, 145.1, "\u221a", 452.47),
        delim(145.1, 188.6, "\u221a\u221a\u221a\u221a\u221a\u221a\u221a\u221a\u221a\u221a\u221a\u221a\u221a\u221a\u221a\u221a\u221a\u221a", 452.47),
        delim(186.7, 189.0, "\u221a", 452.47),
      ],
    },
  ]
  assert.equal(renderPlainText(lines), "d = 25 + 1.68 \u221a(L(B + D))")
})

check("pairs a stretchy piece with a literal bracket", () => {
  // `b12 = 2[pk/Jk − (1 − pk)/(Jm − Jk)]`: the frame's left side is a lone
  // right-parenthesis piece standing in for the opener, and its right side is a
  // literal `]`.  The literal fixes the family, so the pair reads `[…]`.
  const delim = (x, xEnd, text, y) => ({ ...r(x, xEnd, text, y, 11), mathFont: true })
  const run = (x, xEnd, text, y, size) => ({ x, xEnd, y, size, text })
  const lines = [
    {
      y: 181.98,
      runs: [
        run(200.6, 206.1, "b", 181.98, 11),
        run(206.1, 213.8, "12", 181.98, 7.7),
        run(217.4, 225.8, "=", 181.98, 11),
        run(228.9, 234.4, " 2", 181.98, 11),
        run(252.4, 260.9, "\u2212", 181.98, 11),
        delim(304.8, 307.8, "]", 181.98),
      ],
    },
    {
      y: 189.47,
      runs: [
        run(240.1, 245.6, "p", 189.47, 11),
        run(245.6, 249.4, "k", 189.47, 7.7),
        run(265.2, 270.7, "1", 189.47, 11),
        run(273.1, 281.6, " \u2212", 189.47, 11),
        run(284.1, 289.6, " p", 189.47, 11),
        run(289.6, 293.4, "k", 189.47, 7.7),
      ],
    },
    {
      y: 174.44,
      runs: [
        run(240.7, 245.0, "J", 174.44, 11),
        run(245.0, 248.8, "k", 174.44, 7.7),
        run(263.3, 267.6, "J", 174.44, 11),
        run(267.6, 273.6, "m", 174.44, 7.7),
        run(276.5, 285.0, " \u2212", 174.44, 11),
        run(287.4, 291.7, " J", 174.44, 11),
        run(291.7, 295.2, "k", 174.44, 7.7),
      ],
    },
    { y: 197.52, runs: [delim(234.4, 240.1, "\u23a0", 197.52)] },
  ]
  assert.equal(
    renderPlainText(lines),
    "b12 = 2[pk/Jk \u2212 (1 \u2212 pk)/(Jm \u2212 Jk)]",
  )
})

check("linearises a framed display fraction whose operand wraps", () => {
  // The hire-purchase formula in the Income Tax Act: the numerator is framed by
  // a stretchy delimiter whose pieces each sit on their own row, and the operand
  // `Amount of cash payout` wraps around the operator.  The frame pieces form a
  // fake column gutter, so the table detector must not swallow the block.
  const delim = (x, xEnd, text, y) => ({ ...r(x, xEnd, text, y, 13), mathFont: true })
  const lines = [
    line(386.65, [[119.2, 294.9, "as a debt due to the Government:"]], 13),
    line(312.38, [[149.2, 207.0, "Amount of"]], 13),
    line(296.73, [[147.3, 210.2, "cash payout"]], 13),
    line(304.56, [[215.2, 225.2, "\u00d7"]], 13),
    line(360.4, [[241.7, 374.9, "5 \u2212 Number of complete"]], 13),
    line(344.81, [[253.4, 363.2, "years the intellectual"]], 13),
    line(329.22, [[254.5, 362.1, "property rights were"]], 13),
    line(313.63, [[258.9, 357.8, "held by the person"]], 13),
    line(295.65, [[305.1, 311.6, "5"]], 13),
    line(304.56, [[390.7, 394.2, "."]], 13),
    {
      y: 370.49,
      runs: [delim(228.1, 239.5, "\u221b", 370.49), delim(377.1, 388.5, "\u221c", 370.49)],
    },
    {
      y: 347.75,
      runs: [delim(228.1, 239.5, "\u23a9", 347.75), delim(377.1, 388.5, "\u23ab", 347.75)],
    },
    {
      y: 340.04,
      runs: [delim(228.1, 239.5, "\u23a9", 340.04), delim(377.1, 388.5, "\u23ab", 340.04)],
    },
    {
      y: 332.34,
      runs: [delim(228.1, 239.5, "\u23a7", 332.34), delim(377.1, 388.5, "\u23a8", 332.34)],
    },
  ]
  const out = renderTables(lines)
  assert.match(
    out,
    /Amount of cash payout \u00d7 \(5 \u2212 Number of complete years the intellectual property rights were held by the person\)\/5\./,
  )
  assert.doesNotMatch(out, /[\u239b-\u23ad\u221a-\u221c]/)
})

check("linearises an unframed display fraction beside a lone operator", () => {
  // A phrase-long numerator stacked over a single denominator, set beside a
  // lone `×` with no delimiter frame — the Income Tax Act's hire-purchase
  // formula.  The wrapped operand shares baselines with the numerator, so the
  // rows interleave; the fraction is recognised from the operator outwards and
  // the operand keeps its reading order.
  const lines = [
    line(610.8, [[152.2, 178.2, "Cash"], [182.5, 217.9, " payout"]], 13),
    line(595.2, [[152.2, 203.4, "computed"], [207.8, 217.9, " in"]], 13),
    line(579.6, [[142.1, 200.5, "accordance"], [204.9, 228.0, " with"]], 13),
    line(564.0, [[134.9, 208.6, "subsection (4E)(b)"]], 13),
    line(587.3, [[240.2, 250.2, "\u00d7"]], 13),
    line(626.9, [[258.6, 301.2, "Number"], [305.6, 316.4, " of"], [322.0, 369.6, " complete"], [373.9, 401.4, " years"], [405.7, 421.6, " the"]], 13),
    line(611.3, [[255.3, 313.1, "intellectual"], [317.4, 361.4, " property"], [365.7, 395.3, " rights"], [399.7, 424.9, " were"]], 13),
    line(595.7, [[261.8, 284.1, "held"], [288.5, 301.5, " by"], [305.8, 321.7, " the"], [326.0, 379.5, " qualifying"], [383.8, 418.5, " person"]], 13),
    line(578.4, [[336.9, 343.4, "5"]], 13),
  ]
  assert.equal(
    renderPlainText(lines),
    "Cash payout\ncomputed in\naccordance with\nsubsection (4E)(b)\n" +
      "\u00d7 Number of complete years the intellectual property rights were " +
      "held by the qualifying person/5",
  )
})

check("leaves a superscript alone", () => {
  // A superscript sits above the baseline but has no denominator below it.
  const lines = [
    line(100, [[70, 90, "A"], [90, 94, "1"], [96, 110, " is the amount"]]),
  ]
  assert.equal(renderPlainText(lines), "A1 is the amount")
})

check("leaves two unrelated small-font lines alone", () => {
  // Small-font lines that do not overlap in x are not a fraction.
  const lines = [
    line(100, [[70, 200, "body text here"]]),
    line(104, [[70, 80, "x"]], 7),
    line(96, [[150, 160, "y"]], 7),
  ]
  assert.equal(renderPlainText(lines), "body text here\nx\ny")
})

check("does not treat a list marker as a fraction", () => {
  // `(a)` and `(b)` are list markers on consecutive lines, not a fraction.
  const lines = [
    line(100, [[70, 90, "(a) adopts an engine"]]),
    line(90, [[70, 90, "(b) adopts a motor"]]),
  ]
  assert.equal(renderPlainText(lines), "(a) adopts an engine\n(b) adopts a motor")
})

check("does not treat stacked form labels as a fraction", () => {
  // A form stacks two labels over one baseline; they are not a fraction.
  const lines = [
    line(100, [[70, 90, "being"], [120, 160, " ................"]]),
    line(104, [[120, 160, "employees of"]], 7),
    line(96, [[120, 160, "members of"]], 7),
  ]
  assert.equal(
    renderPlainText(lines),
    "being ................\nemployees of\nmembers of",
  )
})

check("does not treat leader dots as a fraction", () => {
  // A table of contents repeats a run of leader dots at the same x.
  const lines = [
    line(100, [[70, 90, "Part 1"], [221, 229, " ..."], [240, 300, " Preliminary"]]),
    line(90, [[70, 90, "Part 2"], [221, 229, " ..."], [240, 300, " Administration"]]),
  ]
  assert.equal(
    renderPlainText(lines),
    "Part 1 ... Preliminary\nPart 2 ... Administration",
  )
})

check("does not treat a footnote marker as a fraction", () => {
  // A superscript marker above a body line is not a numerator.
  const lines = [
    line(100, [[70, 200, "the Mental Health (Care and Treatment) Act 2008"]]),
    line(104, [[205, 210, "*"]], 7),
    line(96, [[70, 200, "[*Updated to be consistent with the 2020 Revised Edition]"]]),
  ]
  assert.equal(
    renderPlainText(lines),
    "the Mental Health (Care and Treatment) Act 2008\n*\n[*Updated to be consistent with the 2020 Revised Edition]",
  )
})

check("maps a broken math-font glyph to the character it draws", () => {
  const cmap = new Map([[3, "\uFFFD"], [134, "\u00F0"], [200, "x"]])
  const fixed = applyTexMathGlyphs("TeX_CM_Maths_Symbols", cmap)
  assert.equal(fixed.get(3), "\u00d7")
  assert.equal(fixed.get(134), "(")
  assert.equal(fixed.get(200), "x")
  assert.equal(cmap.get(3), "\uFFFD", "input map must not be mutated")
})

check("leaves a fraction inside a table block alone", () => {
  // A table's cells stack short values at the same x, which mimics a fraction.
  // `renderTables` detects the block first and confines the fraction pass to the
  // prose between blocks, so the cells are not rewritten.
  const lines = [
    line(120, [[70, 90, "Offence"], [200, 240, "Punishment"]]),
    line(107, [[70, 90, "arrest"], [200, 240, "fine"]]),
    line(93, [[70, 90, "Court"], [200, 240, "years"]]),
    line(100, [[70, 90, "abuse"], [200, 240, "both"]]),
  ]
  const out = renderTables(lines)
  assert.doesNotMatch(out, /arrest\/Court/)
})

check("recovers a narrow column boundary closed by a wide cell", () => {
  // The damage-extent table: the gutter between the label column and the first
  // data column is only ~0.6 em (set by the widest label), and one row's cell
  // overflows far enough to close the data-column gutter.  The rows still show
  // three cells, so the boundaries must be recovered.
  const md = renderTables([
    line(442.6, [[68.4, 70.9, "."], [199.5, 283.2, "For 0.3 L from the"]]),
    line(441.87, [[302.1, 418.2, "Any other part of the ship"]]),
    line(428.88, [[192.1, 290.7, "forward perpendicular"]]),
    line(415.9, [[217.6, 265.1, "of the ship"]]),
    line(401.5, [[211.8, 272.0, "2/3or 14.5 m,"], [325.3, 385.5, "2/3or 14.5 m,"]]),
    line(396.62, [
      [68.4, 155.5, "Longitudinal extent"],
      [187.7, 211.8, " 1/3 L"],
      [301.3, 325.3, "1/3 L"],
    ]),
    line(383.64, [[187.7, 264.0, "whichever is less"], [301.3, 377.5, "whichever is less"]]),
    line(364.37, [
      [68.4, 146.6, "Transverse extent"],
      [187.7, 245.0, "B/6 or 10 m,"],
      [301.3, 353.0, "B/6 or 5 m,"],
    ]),
    line(351.38, [[187.7, 264.0, "whichever is less"], [301.3, 377.5, "whichever is less"]]),
    line(332.11, [
      [68.4, 181.1, "Vertical extent, measured"],
      [187.7, 281.9, "B/20, to be taken not"],
      [301.3, 415.2, "B/20, to be taken not less"],
    ]),
    line(319.12, [
      [68.4, 148.0, "from the keel line"],
      [187.7, 295.0, "less than 0.76 m and not"],
      [301.3, 417.0, "than 0.76 m and not more"],
    ]),
    line(306.14, [[187.7, 253.2, "more than 2 m"], [301.3, 340.8, "than 2 m"]]),
  ])
  assert.match(
    md,
    /^\| \. \| For 0\.3 L from the forward perpendicular of the ship \| Any other part of the ship \|$/m,
  )
  assert.match(
    md,
    /^\| Longitudinal extent \| 1\/3 L2\/3or 14\.5 m, whichever is less \| 1\/3 L2\/3or 14\.5 m, whichever is less \|$/m,
  )
  assert.match(
    md,
    /^\| Vertical extent, measured from the keel line \| B\/20, to be taken not less than 0\.76 m and not more than 2 m \| B\/20, to be taken not less than 0\.76 m and not more than 2 m \|$/m,
  )
})

check("does not split a cell at its own word spacing", () => {
  // A row can gap by more than the row threshold inside one cell — a wide space
  // between two words, or a lone dot between columns.  Two such gaps that only
  // overlap in a sliver are not a column boundary; without the width guard the
  // sliver becomes a third column and the cell is torn in two.
  const md = renderTables([
    line(100, [[60, 140, "A"], [300, 380, "B"]]),
    line(90, [[60, 140, "C"], [300, 380, "D"]]),
    line(80, [[60, 100, "E"], [130, 160, "F"], [300, 380, "G"]]),
    line(70, [[60, 130, "H"], [300, 380, "I"]]),
  ])
  assert.match(md, /^\| EF \| G \|$/m)
  assert.doesNotMatch(md, /^\| --- \| --- \| --- \|$/m)
})

check("leaves a font with no overrides alone", () => {
  const cmap = new Map([[3, "\uFFFD"]])
  assert.equal(applyTexMathGlyphs("TimesNewRomanPSMT", cmap), cmap)
  assert.equal(applyTexMathGlyphs(undefined, cmap), cmap)
  assert.equal(isTexMathFont("TeX_CM_Maths_Extension"), true)
  assert.equal(isTexMathFont("TimesNewRomanPSMT"), false)
})

check("resolves a Monotype symbol-font glyph name to the character it draws", () => {
  // The `AdvP4C4E*` subsets label their glyphs with names that do not describe
  // the outlines — the glyph named `eth` draws `(` — and label the operator
  // glyphs with bare subset tags (`C0`, `C2`, `C138`) that resolve to nothing.
  assert.equal(symbolGlyphName("AdvP4C4E74", "eth"), "(")
  assert.equal(symbolGlyphName("AdvP4C4E74", "Thorn"), ")")
  assert.equal(symbolGlyphName("AdvP4C4E74", "thorn"), "+")
  assert.equal(symbolGlyphName("AdvP4C4E74", "onequarter"), "=")
  assert.equal(symbolGlyphName("AdvP4C4E74", "onehalf"), "[")
  assert.equal(symbolGlyphName("AdvP4C4E74", "C138"), "]")
  assert.equal(symbolGlyphName("AdvP4C4E74", "g"), "}")
  assert.equal(symbolGlyphName("AdvP4C4E74", "C0"), "\u2212")
  assert.equal(symbolGlyphName("AdvP4C4E74", "C2"), "\u00d7")
  assert.equal(symbolGlyphName("AdvP4C4E46", "C18"), "(")
  assert.equal(symbolGlyphName("AdvP4C4E46", "C19"), ")")
  // Unlisted names and fonts fall through to the Adobe glyph-name table.
  assert.equal(symbolGlyphName("AdvP4C4E74", "A"), undefined)
  assert.equal(symbolGlyphName("TimesNewRomanPSMT", "eth"), undefined)
  assert.equal(symbolGlyphName(undefined, "eth"), undefined)
})

check("applies the code-keyed symbol-font overrides", () => {
  // `AdvP4C4E51` carries no /Differences array, so its codes are fixed by the
  // font's built-in encoding and are keyed by code rather than by name.
  const fixed = applyTexMathGlyphs("AdvP4C4E51", new Map())
  assert.equal(fixed.get(58), ".")
  assert.equal(fixed.get(59), ",")
  assert.equal(fixed.get(60), undefined)
  // `AdvP4C4E74` subsets that omit /Differences and declare WinAnsiEncoding
  // use the standard Adobe codes for the named glyphs.
  const e74 = applyTexMathGlyphs("AdvP4C4E74", new Map())
  assert.equal(e74.get(222), ")")
  assert.equal(e74.get(240), "(")
  assert.equal(e74.get(254), "+")
  // ...but the fallback must not run when a /Differences array is present: it
  // remaps the codes per document, so its names are authoritative.
  const guarded = applyTexMathGlyphs("AdvP4C4E74", new Map(), true)
  assert.equal(guarded.has(240), false)
})

// Default output must stay table-free; tables are opt-in.  Skipped when the
// (gitignored) corpus is not present.
const wicaPdf = path.join(CORPUS, "Work Injury Compensation Act 2019/Work Injury Compensation Act 2019.pdf")
if (fs.existsSync(wicaPdf)) {
  const { extractPdfText } = await import(
    pathToFileURL(path.join(repoRoot, "src/pdf/extract.ts")).href
  )
  check("default extraction emits no tables; tables mode does", () => {
    const buf = fs.readFileSync(wicaPdf)
    assert.doesNotMatch(extractPdfText(buf), /^\|/m)
    assert.match(extractPdfText(buf, { tables: true }), /^\|.*\|$/m)
  })
} else {
  console.log("  skip  default-vs-tables guard (WICA PDF not present)")
}

// The last line of a content stream is dropped when its final text object
// declares its own position (`sawPosition`) and no later text triggers a
// flush: `ET` does not flush a positioned block, and the end-of-stream flush
// only ran while `inText` was true.  The Legislative History's
// `Date of operation : 25 March 1992` is the last line of its page, so it
// vanished.  Skipped when the (gitignored) corpus is not present.
const ditPdf = path.join(CORPUS, "Income Tax Act 1947/Subsidiary Legislation/Deduction of Income Tax (Employments) Rules [Cap. 134, R 2].pdf")
if (fs.existsSync(ditPdf)) {
  const { extractPdfText } = await import(
    pathToFileURL(path.join(repoRoot, "src/pdf/extract.ts")).href
  )
  check("the last line of a stream is not dropped", () => {
    const text = extractPdfText(fs.readFileSync(ditPdf), { tables: true })
    assert.match(text, /Date of operation:25 March 1992/)
  })
} else {
  console.log("  skip  last-line-of-stream guard (Deduction of Income Tax PDF not present)")
}

// A running footer repeats on every page, so a two-page document carries it
// twice.  The dedup pass used to require three streams, so a short
// instrument's footer survived — and once the last line of a stream was always
// flushed, the "Informal Consolidation – version in force from …" footer
// leaked into the output and was absorbed into the section title below it.
// Skipped when the (gitignored) corpus is not present.
const amaPdf = path.join(CORPUS, "Active Mobility Act 2017/Subsidiary Legislation/Active Mobility (Mandatory Testing — Motorised PMD with Handlebars) Order 2020 [S 241_2020].pdf")
if (fs.existsSync(amaPdf)) {
  const { extractPdfText } = await import(
    pathToFileURL(path.join(repoRoot, "src/pdf/extract.ts")).href
  )
  check("a running footer is stripped from a two-page document", () => {
    const text = extractPdfText(fs.readFileSync(amaPdf), { tables: true })
    assert.doesNotMatch(text, /Informal Consolidation/)
  })
} else {
  console.log("  skip  short-document footer guard (Active Mobility PDF not present)")
}

// The Monotype symbol fonts carry the math operators and delimiters but ship a
// broken name table, so the extractor used to decode them to `ð`/`Þ`/`þ` or
// drop them.  These two PDFs cover the two faces: `AdvP4C4E74` (the operators)
// and `AdvP4C4E46` (the delimiters).  Skipped when the corpus is not present.
const hpPdf = path.join(CORPUS, "Hire-Purchase Act 1969/Subsidiary Legislation/Hire-Purchase (Motor Vehicles) Regulations 2013 [S 205_2013].pdf")
const covidPdf = path.join(CORPUS, "COVID-19 (Temporary Measures) Act 2020/Subsidiary Legislation/COVID-19 (Temporary Measures) (Rental and Related Measures) Regulations 2020 [S 664_2020].pdf")
// A subset that omits /Differences entirely and declares only WinAnsiEncoding,
// so its codes are the standard Adobe ones (`222` -> `Þ`, `240` -> `ð`).
const presPdf = path.join(CORPUS, "Presidential Elections Act 1991/Subsidiary Legislation/Presidential Elections (Prescribed Forms) Regulations [Cap. 240A, RG 1].pdf")
if (fs.existsSync(hpPdf) || fs.existsSync(covidPdf) || fs.existsSync(presPdf)) {
  const { extractPdfText } = await import(
    pathToFileURL(path.join(repoRoot, "src/pdf/extract.ts")).href
  )
  if (fs.existsSync(hpPdf)) {
    check("recovers the Hire-Purchase formula operators", () => {
      // `A − (B/(120 − C)) × A,` — before the override this extracted as
      // `A;` / `A` / `120 C`, losing the minus, the parentheses and the times.
      const text = extractPdfText(fs.readFileSync(hpPdf), { tables: true })
      assert.match(text, /B\/\(120 \u2212 C\)/)
      assert.match(text, /\u00d7 A,/)
      assert.match(text, /A \u2212/)
    })
  } else {
    console.log("  skip  Hire-Purchase formula guard (PDF not present)")
  }
  if (fs.existsSync(covidPdf)) {
    check("recovers the COVID-19 formula operators", () => {
      const text = extractPdfText(fs.readFileSync(covidPdf), { tables: true })
      // The `þ`/`ð`/`Þ` garbage is gone and the operators survive.
      assert.doesNotMatch(text, /[\u00F0\u00DE\u00FE]/)
      assert.match(text, /\(2 \u00d7 A\) \u2013 F \u2013 F/)
    })
  } else {
    console.log("  skip  COVID-19 formula guard (PDF not present)")
  }
  if (fs.existsSync(presPdf)) {
    check("recovers the E74 subset that declares only WinAnsiEncoding", () => {
      const text = extractPdfText(fs.readFileSync(presPdf), { tables: true })
      assert.doesNotMatch(text, /[\u00F0\u00DE\u00FE]/)
      assert.match(text, /\(date\)/)
    })
  } else {
    console.log("  skip  WinAnsi-only E74 guard (PDF not present)")
  }
} else {
  console.log("  skip  Monotype symbol-font formula guards (corpus not present)")
}

if (failed > 0) {
  console.error(`\n${failed} table test(s) failed`)
  process.exit(1)
}
console.log("\ntable tests passed")
