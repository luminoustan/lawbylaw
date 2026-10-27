# Formula parsing gaps — Monotype `AdvP4C4E*` symbol fonts

Status: **fixed** (decoder override in `tex-math-fonts.ts`; corpus regenerated).
The defect was pre-existing, not a regression, and was not covered by the
golden-corpus gate.

## Summary

A subset of the legislation PDFs typeset by Monotype's "Advantage" engine
stores their mathematical operators and parentheses in three embedded symbol
fonts:

- `AdvP4C4E74`
- `AdvP4C4E51`
- `AdvP4C4E46`

Those fonts ship a broken character-to-Unicode mapping, so the extractor
decoded the glyphs to the wrong characters — or dropped them entirely. The
result was that formulas in **50 files** were silently corrupted:

- **27 files** showed *visible* corruption (`ð`, `Þ`, `þ`, `¼`, `!`, `"`, `#`,
  or `;` where a comma belongs).
- The remaining **23 files** lost the operators silently: `(`, `)`, `+`, `−`,
  `×`, `=`, `[`, `]`, `Σ` decoded to nothing, so the formula collapsed into a
  run of bare operands.

The defect was independent of the two bugs already fixed in this repo (the
dropped last line of a page and the SSO footer). It was *not* caught by the
golden-corpus regression gate, because the corruption is content-preserving
from the gate's point of view: line, character and section counts are unchanged,
and the corrupted text was already baked into the committed baseline.

### Fix

`src/pdf/tex-math-fonts.ts` now carries two
override tables alongside the existing `TEX_MATH_GLYPHS`:

- `SYMBOL_FONT_GLYPHS` — keyed by `(BaseFont, glyphName)`, used when the font
  declares a `/Differences` array. The custom subset labels (`eth`, `Thorn`,
  `thorn`, `onequarter`, `onehalf`, `C0`, `C2`, `C138`, `g`, `C0`–`C27`) are the
  stable identity of a glyph and recur across documents, so the label is the
  right key even though the codes are remapped per subset.
- `SYMBOL_FONT_CODES` — keyed by `(BaseFont, code)`, used only when the font
  declares **no** `/Differences` (some `AdvP4C4E74` subsets declare only
  `/Encoding/WinAnsiEncoding`). Those subsets use the standard Adobe codes
  (`222`→`)`, `240`→`(`, `254`→`+`, `188`→`=`, `189`→`[`, `103`→`}`), so a
  code-keyed table is correct there.

`applyTexMathGlyphs(baseFont, cmap, hasDifferences)` applies the name-keyed
table inside `parseDifferences` (via `symbolGlyphName`) and the code-keyed table
only when `hasDifferences` is false, so a present `/Differences` array — which
remaps codes per document — stays authoritative.

After the fix the corpus check reports **0 visible corruption** (down from 27)
and the regenerated corpus contains no `ð`/`Þ`/`þ` anywhere. The only residual
`digit;digit` match is `Banking Act 1970` (`person2022.2022;1970`), which uses
no `Adv` fonts and is a pre-existing table/column-ordering issue, out of scope
here.

## Symptoms

### Visible corruption

`COVID-19 (Temporary Measures) (Rental and Related Measures) Regulations 2020
[S 664/2020]`, page 62 — rendered PDF vs extracted Markdown:

```
Real:      [ ( B1/30 + C1/31 + D1/30 + E1/31 ) × A ] – F – F0
Extracted: B1C1D1E1/31313030 þþþ A ð 2 AÞ ð F þ F
```

`Securities and Futures (Short Selling) Regulations 2018 [S 328/2018]` — the
comma glyph decodes to a semicolon:

```
Real:      $2,000,000 / X
Extracted: $2;000;000
           X
```

### Silent corruption

`Hire-Purchase (Motor Vehicles) Regulations 2013 [S 205/2013]`, page 2:

```
Real:      A − ( B / (120 − C) ) × A
Extracted: A
           B
           120 C
           A;
```

`Income Tax (Approved Unit Trust) Regulations [Cap. 134, RG 12]`:

```
Real:      A/C × B          Extracted: A/C B;
```

`Estate Duty (Remission for Deaths in Quick Succession) Order 2005 [S 896/2005]`:

```
Real:      A/B × C × P      Extracted: A/B C P;
```

## Root cause

### The fonts are embedded CFF subsets with a wrong name table

Each affected PDF embeds the three symbol fonts as `FontFile3` / `Type1C`
(Compact Font Format) subsets. For example, in the COVID-19 file:

```
FNNINJ+AdvP4C4E74  FontDescriptor 306 -> FontFile3 obj 308 (673 bytes)
```

The PDF declares a `/ToUnicode` CMap that is a **byte-identity map** — code
`0xF0` → U+00F0 `ð`, code `0xDE` → U+00DE `Þ`, code `0xFE` → U+00FE `þ` — and a
`/Differences` array whose glyph names are **misleading labels**:

```
1/C2 3/C0/C138 103/g 188/onequarter/onehalf 222/Thorn 240/eth 254/thorn
```

The glyph labelled `eth` (code `240`) does **not** draw an `eth`; it draws a
`(`. The label is wrong; the outline is correct. A PDF viewer renders the
outline, so the page *looks* right, but a text extractor that trusts the name
table decodes `ð`.

### How the extractor went wrong

`resolveFontRaw` prefers `/Differences` for a simple font, then falls back to
the `/ToUnicode` CMap, then to WinAnsi:

```930:950:src/pdf/extract.ts
    if (diff) return { cmap: diff, single: true }
    // No CMap at all: a simple font with a standard encoding (WinAnsiEncoding,
    // MacRomanEncoding, ...).  `decodeString` falls back to WinAnsi, but the
    // font is still single-byte and the width model needs to know that.
    const single = singleByteByFontObjId.get(fontObjId)
    if (single === undefined) return undefined
    return { cmap: new Map<number, string>(), single }
```

Two failure modes followed:

1. **Wrong character.** A standard Adobe glyph name (`eth`, `thorn`, `Thorn`,
   `onequarter`, `g`) resolved to its normal Unicode — `ð`, `þ`, `Þ`, `¼`, `g` —
   but the glyph draws `(`, `+`, `)`, `=`, `×`. The extractor emitted the name's
   character, not the drawn one.
2. **Dropped character.** A custom subset label (`C0`, `C2`, `C138`) had no
   Unicode mapping, so the code decoded to nothing and the operator vanished
   from the output. This was the silent-loss mode, and the more dangerous one.

Note that the custom labels are the *stable* identity of a glyph within the
font: the same label set (`C0`, `C2`, …) recurs across documents, while the
codes they sit at are remapped per subset (Hire-Purchase maps `1/C0 3/C2`;
COVID maps `1/C2 3/C0`). That is why the fix keys the override on the glyph
name, not the code.

### Why the existing override did not help

The extractor already had a glyph-override mechanism for broken LaTeX fonts:

```884:908:src/pdf/extract.ts
  /**
   * Resolve a font object to its code→Unicode map, applying the TeX math-font
   * glyph overrides when the font is one of the broken Computer Modern math
   * faces.  Those PDFs ship a /ToUnicode that is an ASCII identity map, so the
   * CMap decodes the glyphs to U+FFFD or stray Latin-1 letters; the overrides
   * restore the characters the glyphs actually draw (see tex-math-fonts.ts).
   ...
   */
  const resolveFont = (fontObjId: number): ResolvedFont | undefined => {
    if (resolvedCache.has(fontObjId)) return resolvedCache.get(fontObjId)
    const raw = resolveFontRaw(fontObjId)
    let result: ResolvedFont | undefined = raw
    if (raw) {
      const bf = baseFontByObjId.get(fontObjId)
      const cmap = applyTexMathGlyphs(bf, raw.cmap)
      const mathFont = isTexMathFont(bf)
      if (cmap !== raw.cmap || mathFont) result = { cmap, single: raw.single, mathFont }
    }
    resolvedCache.set(fontObjId, result)
    return result
  }
```

`applyTexMathGlyphs` only recognised the `TeX_CM_Maths_Symbols`,
`TeX_CM_Maths_Italic` and `TeX_CM_Maths_Extension` BaseFonts. The Monotype
`AdvP4C4E74` / `AdvP4C4E51` / `AdvP4C4E46` fonts were not in its table, so the
broken CMap was used as-is. The fix extends that same hook with the two
Monotype tables described above.

By contrast, the `√`-bearing formulas (typeset with the TeX fonts) parse
correctly, which isolates the defect to these three Monotype fonts.

## Affected files

50 files across the corpus (523 Acts / 5,540 SL). `Visible` = the output
contains one of the tell-tale characters (`ð`, `Þ`, `þ`, or `digit;digit`).
`Mentions formula` = the output contains "formula"; every silently-corrupted
file in the sample does.

<!-- generated by scripts/tests/unparsed-formulas.test.mjs --report -->
| File | Fonts | Visible | Mentions formula |
| --- | --- | --- | --- |
| Casino Control Act 2006/Subsidiary Legislation/Casino Control (Casino Tax) Regulations 2010 [S 59_2010].md | AdvP4C4E74 | yes | yes |
| Civil Aviation Authority of Singapore Act 2009/Subsidiary Legislation/Civil Aviation Authority of Singapore (Airport Development Levy) Order 2018 [S 437_2018].md | AdvP4C4E74,AdvP4C4E51 | yes | yes |
| Civil Aviation Authority of Singapore Act 2009/Subsidiary Legislation/Civil Aviation Authority of Singapore (Price Control of Aeronautical Charges) Rules 2009 [S 298_2009].md | AdvP4C4E74 | yes | yes |
| COVID-19 (Temporary Measures) Act 2020/Subsidiary Legislation/COVID-19 (Temporary Measures) (Part 8C Relief) Regulations 2021 [S 497_2021].md | AdvP4C4E74,AdvP4C4E51,AdvP4C4E46 | yes | yes |
| COVID-19 (Temporary Measures) Act 2020/Subsidiary Legislation/COVID-19 (Temporary Measures) (Prescribed Matters for Second Schedule) Regulations 2021 [S 20_2021].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| COVID-19 (Temporary Measures) Act 2020/Subsidiary Legislation/COVID-19 (Temporary Measures) (Prescribed Matters for Third Schedule) Regulations 2021 [S 21_2021].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| COVID-19 (Temporary Measures) Act 2020/Subsidiary Legislation/COVID-19 (Temporary Measures) (Rental and Related Measures) Regulations 2020 [S 664_2020].md | AdvP4C4E74,AdvP4C4E51,AdvP4C4E46 | yes | yes |
| COVID-19 (Temporary Measures) Act 2020/Subsidiary Legislation/COVID-19 (Temporary Measures) (Rental Waiver Due to COVID-19 Event in 2021) Regulations 2021 [S 751_2021].md | AdvP4C4E74,AdvP4C4E51,AdvP4C4E46 | yes | yes |
| COVID-19 (Temporary Measures) Act 2020/Subsidiary Legislation/COVID-19 (Temporary Measures) (Transfer of Benefit of Property Tax Remission) Regulations 2020 [S 375_2020].md | AdvP4C4E74,AdvP4C4E51,AdvP4C4E46 | yes | yes |
| Economic Expansion Incentives (Relief from Income Tax) Act 1967/Subsidiary Legislation/Economic Expansion Incentives (Relief from Income Tax) (Intellectual Property Income) Regulations 2018 [S 269_2018].md | AdvP4C4E74,AdvP4C4E51,AdvP4C4E46 | — | yes |
| Employment Act 1968/Subsidiary Legislation/Employment (Part-Time Employees) Regulations [Cap. 91, RG 8].md | AdvP4C4E74,AdvP4C4E51 | yes | yes |
| Estate Duty Act 1929/Subsidiary Legislation/Estate Duty (Remission for Deaths in Quick Succession) Order 2005 [S 896_2005].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| Hire-Purchase Act 1969/Subsidiary Legislation/Hire-Purchase (Motor Vehicles) Regulations 2013 [S 205_2013].md | AdvP4C4E74,AdvP4C4E51,AdvP4C4E46 | — | yes |
| Housing and Development Act 1959/Subsidiary Legislation/Housing and Development (Mortgage to Lender) Rules [Cap. 129, R 10].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| Income Tax Act 1947/Subsidiary Legislation/Income Tax (Approved Unit Trust) Regulations [Cap. 134, RG 12].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| Income Tax Act 1947/Subsidiary Legislation/Income Tax (Concessionary Rate of Tax for Intellectual Property Income) Regulations 2021 [S 36_2021].md | AdvP4C4E74,AdvP4C4E51 | yes | yes |
| Income Tax Act 1947/Subsidiary Legislation/Income Tax (Deduction for Acquisition of Shares of Companies) Regulations 2012 [S 584_2012].md | AdvP4C4E74 | yes | yes |
| Income Tax Act 1947/Subsidiary Legislation/Income Tax (Exemption and Concessionary Tax Rate for Income from Composite Insurance Business) Regulations [Cap. 134, RG 27].md | AdvP4C4E74,AdvP4C4E51,AdvP4C4E46 | yes | yes |
| Income Tax Act 1947/Subsidiary Legislation/Income Tax (Exemption and Concessionary Tax Rate for Income from General Insurance Business) Regulations [Cap. 134, RG 26].md | AdvP4C4E74,AdvP4C4E51,AdvP4C4E46 | yes | yes |
| Income Tax Act 1947/Subsidiary Legislation/Income Tax (Exemption and Concessionary Tax Rate for Income from Life Insurance Business) Regulations [Cap. 134, RG 28].md | AdvP4C4E74,AdvP4C4E51,AdvP4C4E46 | yes | yes |
| Income Tax Act 1947/Subsidiary Legislation/Income Tax (Exemption of Interest and Other Payments for Economic and Technological Development) (No. 4) Notification 2013 [S 609_2013].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| Income Tax Act 1947/Subsidiary Legislation/Income Tax (Exemption of Interest and Other Payments on Economic and Technological Development Loans) (No. 2) Notification 2014 [S 73_2014].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| Income Tax Act 1947/Subsidiary Legislation/Income Tax (Exemption of Interest and Other Payments on Economic and Technological Development Loans) (No. 4) Notification 2018 [S 467_2018].md | AdvP4C4E74,AdvP4C4E51 | yes | yes |
| Income Tax Act 1947/Subsidiary Legislation/Income Tax (Exemption of Interest and Other Payments on Economic and Technological Development Loans) (No. 5) Notification 2015 [S 722_2015].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| Income Tax Act 1947/Subsidiary Legislation/Income Tax (Exemption of Interest and Other Payments on Economic and Technological Development Loans) (No. 6) Notification 2014 [S 465_2014].md | AdvP4C4E74,AdvP4C4E51 | yes | yes |
| Income Tax Act 1947/Subsidiary Legislation/Income Tax (Payments by Approved Aircraft Leasing Entities under Loans and Finance Leases — Section 13(4) Exemption) Notification 2020 [S 947_2020].md | AdvP4C4E74,AdvP4C4E51 | yes | yes |
| Insurance Act 1966/Subsidiary Legislation/Insurance (Financial Guarantee Insurance) Regulations [Cap. 142, RG 6].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| Insurance Act 1966/Subsidiary Legislation/Insurance (General Provisions) Regulations [Cap. 142, RG 17].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| Insurance Act 1966/Subsidiary Legislation/Insurance (Lloyd’s Asia Scheme) Regulations [Cap. 142, RG 9].md | AdvP4C4E51 | — | yes |
| Insurance Act 1966/Subsidiary Legislation/Insurance (Web Aggregator Fees) Regulations 2015 [S 819_2015].md | AdvP4C4E74,AdvP4C4E51,AdvP4C4E46 | yes | — |
| Land Betterment Charge Act 2021/Subsidiary Legislation/Land Betterment Charge (Concessionary Relief) Order 2022 [S 570_2022].md | AdvP4C4E74,AdvP4C4E51 | yes | yes |
| Merchant Shipping Act 1995/Subsidiary Legislation/Merchant Shipping (Pleasure Craft) Regulations 2020 [S 161_2020].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| Ngee Ann Kongsi (Incorporation) Ordinance 1933/Ngee Ann Kongsi (Incorporation) Ordinance 1933.md | AdvP4C4E74,AdvP4C4E51 | yes | yes |
| Pharmacists Registration Act 2007/Subsidiary Legislation/Pharmacists Registration (Practising Certificates) Regulations 2008 [S 438_2008].md | AdvP4C4E74 | — | — |
| Police Force Act 2004/Subsidiary Legislation/Police Force (Special Constabulary — Detention) Regulations 2016 [S 137_2016].md | AdvP4C4E74,AdvP4C4E51 | yes | — |
| Presidential Elections Act 1991/Subsidiary Legislation/Presidential Elections (Certificate of Eligibility) Regulations 2017 [S 263_2017].md | AdvP4C4E74,AdvP4C4E51 | yes | yes |
| Presidential Elections Act 1991/Subsidiary Legislation/Presidential Elections (Prescribed Forms) Regulations [Cap. 240A, RG 1].md | AdvP4C4E74,AdvP4C4E51 | yes | — |
| Property Tax Act 1960/Subsidiary Legislation/Property Tax (Circle Line) Order 2012 [S 280_2012].md | AdvP4C4E74 | — | yes |
| Property Tax Act 1960/Subsidiary Legislation/Property Tax (Downtown Line) Order 2015 [S 58_2015].md | AdvP4C4E74,AdvP4C4E51 | — | — |
| Property Tax Act 1960/Subsidiary Legislation/Property Tax (Land Under Development for Owner-Occupied House) (Remission) Order 2013 [S 726_2013].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| Property Tax Act 1960/Subsidiary Legislation/Property Tax (Non-Residential Properties) (Remission) Order 2020 [S 155_2020].md | AdvP4C4E51 | — | yes |
| Property Tax Act 1960/Subsidiary Legislation/Property Tax (Replacement Owner-Occupied House Under Construction) (Remission) Order 2013 [S 727_2013].md | AdvP4C4E74,AdvP4C4E51,AdvP4C4E46 | — | yes |
| Public Trustee Act 1915/Public Trustee Act 1915.md | AdvP4C4E74,AdvP4C4E51 | — | — |
| Road Traffic Act 1961/Subsidiary Legislation/Road Traffic (Recovery of Vehicle Licence Fees) Rules [Cap. 276, R 30].md | AdvP4C4E74 | yes | — |
| Securities and Futures Act 2001/Subsidiary Legislation/Securities and Futures (Offers of Investments) (Shares) (Exemption for Units of Shares) Regulations 2016 [S 408_2016].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| Securities and Futures Act 2001/Subsidiary Legislation/Securities and Futures (Offers of Investments) (Shares) (Exemption for Units of Shares) Regulations 2017 [S 330_2017].md | AdvP4C4E74,AdvP4C4E51 | — | yes |
| Securities and Futures Act 2001/Subsidiary Legislation/Securities and Futures (Short Selling) Regulations 2018 [S 328_2018].md | AdvP4C4E51 | yes | yes |
| Sewerage, Drainage and Coastal Protection Act 1999/Subsidiary Legislation/Sewerage and Drainage (Sanitary Appliances and Water Charges) (Revocation) Regulations 2013 [S 69_2013].md | AdvP4C4E74,AdvP4C4E51 | yes | — |
| Stamp Duties Act 1929/Subsidiary Legislation/Stamp Duties (Conveyance Directions) (Remission) Rules 2015 [S 778_2015].md | AdvP4C4E74,AdvP4C4E51 | yes | yes |
| Weights and Measures Act 1975/Subsidiary Legislation/Weights and Measures (Defences under Section 19) Regulations 2022 [S 894_2022].md | AdvP4C4E74,AdvP4C4E51 | yes | — |

## Detecting it

`scripts/tests/unparsed-formulas.test.mjs` scans the corpus for this class of
defect and ratchets against the known-affected set above: it skips when the
corpus is absent, fails when a *new* file appears, and reports (without
failing) when a known file is no longer flagged. Run it with `--report` for the
full table.

Because the defect is a same-length corruption, the golden-corpus regression
gate (`legislation-regression.test.mjs`) cannot see it. The formula check is the
automated guard for this class — it is what caught the residual `ð`/`Þ`/`þ` in
five `AdvP4C4E74` subsets that declare only `/Encoding/WinAnsiEncoding` (no
`/Differences`), which the name-keyed override alone did not cover. After the
code-keyed fallback was added, the check reports `visible corrupt 0`.

## Evidence trail

- Content stream + CFF dump: the `AdvP4C4E*` fonts are `FontFile3`/`Type1C`
  subsets; their `/ToUnicode` is byte-identity and their `/Differences` names
  are scrambled.
- Rendered-page screenshots (local scratch):
  `COVID-19-Temporary-Measures-Rental-and-Related-Measures-Regu-p62.png`,
  `Hire-Purchase-Motor-Vehicles-Regulations-2013-S-205_2013-p2.png`.
- Glyph sheets: `scripts/build-cff-glyph-sheet.mjs` re-embeds each CFF subset
  and renders one glyph per row labelled by its `/Differences` name, which is
  how the `label → drawn character` table was read off.
- Corpus scan: 47 PDFs use `AdvP4C4E74`, 44 use `AdvP4C4E51`, 11 use
  `AdvP4C4E46`; 50 files are flagged by the check above.
