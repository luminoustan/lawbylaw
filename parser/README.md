# SSO legislation parser

The parser that turns the [Singapore Statutes Online](https://sso.agc.gov.sg/) (SSO)
PDF corpus into the section-per-chunk Markdown that LawByLaw searches. It is
standalone: it needs only Node and has no PDF library, no OCR and no network call
except one tokenizer download.

## Why it exists

Most PDF libraries produce poor text from SSO PDFs:

- Many SSO PDFs are typeset with embedded **math and symbol fonts** (Monotype
  `AdvP4C4E74/51/46` and LaTeX Computer Modern). Their character maps are broken,
  so a naive extractor decodes `×`, `−`, `(`, `)`, `Σ` as `ð`, `Þ`, `þ`, or drops
  them, and `A − (B/(120 − C)) × A` becomes `A B;`. This parser overrides those
  fonts so formulas survive. See [docs/formula-parsing-findings.md](docs/formula-parsing-findings.md).
- Tables are visual, not structural. They are rebuilt as GitHub pipe tables.
- The footers and the "Informal Consolidation" banner repeat on every page and are
  stripped.
- An Act is a list of numbered sections, and some are far larger than an embedding
  window. They are split at paragraph boundaries into `sN_chunk1`, `sN_chunk2`, …
  so every chunk fits at 1,024 Qwen3 tokens.

## How it works

PDF streams are `FlateDecode` (zlib) compressed. The extractor reads the PDF
directly, inflates each stream with Node's built-in `zlib`, walks the text
operators, resolves each font's encoding, `ToUnicode` map and `/Differences`
array, applies the math-font overrides, and builds a line model with positions.

```
PDF ──zlib inflate──▶ text runs ──tables.ts──▶ text + pipe tables
    ──split.ts──▶ sections ──reflow.ts──▶ paragraphs ──chunk.ts──▶ ≤1,024-token chunks ──▶ .md
```

| File | Role |
| --- | --- |
| `src/pdf/extract.ts` | PDF object and stream parser, zlib inflate, font and encoding resolution, text positioning |
| `src/pdf/tex-math-fonts.ts` | Glyph tables for the broken TeX/Monotype math fonts (the math glyph recovery) |
| `src/pdf/tables.ts` | Table detection and reconstruction, stacked fractions, large delimiters, formulas |
| `src/legislation/split.ts` | Splits text into Parts, Divisions and numbered sections; renders Markdown |
| `src/legislation/reflow.ts` | Joins hard-wrapped lines into paragraphs without losing words |
| `src/chunk.ts`, `src/token-budget.ts` | Token-budgeted chunking with the Qwen3 tokenizer |
| `scripts/parse-legislation.mjs` | CLI that parses a corpus folder into `<out>/<date>/<Act>/…` |
| `scripts/build-math-glyph-sheet.mjs`, `scripts/build-cff-glyph-sheet.mjs` | Render the glyphs of an embedded font so the tables in `tex-math-fonts.ts` can be extended by eye |

## Usage

Node 22.18 or newer is required (it runs the `.ts` sources directly). On
Fedora Silverblue, use a container:

```bash
cd parser
podman run --rm -it -v "$PWD":/w:Z -v /path/to/legislation:/leg:ro,z -w /w \
  -e LEG_SRC=/leg -e LEG_OUT=/w/out docker.io/library/node:24 \
  sh -c 'npm install && PERCENT=100 node scripts/parse-legislation.mjs'
```

The corpus layout is `<LEG_SRC>/<Act>/<Act>.pdf` plus
`<LEG_SRC>/<Act>/Subsidiary Legislation/*.pdf`, with an optional
`legislation_index.json` for the SSO URL and title frontmatter.

Environment variables: `LEG_SRC`, `LEG_OUT`, `LEG_DATE`, `PERCENT` (default `5`, a
seeded stratified sample; `100` is the whole corpus), `SEED`, `TOKEN_BUDGET`,
`QWEN_TOKENIZER_JSON` and `QWEN_TOKENIZER_URL`.

The first run downloads the Qwen3 tokenizer JSON into `.cache/`. There is no
character fallback, because the chunk size is measured in the embedding model's
own tokens. Set `QWEN_TOKENIZER_JSON` to use a local copy offline.

### Output

```
<out>/<date>/<Act>/<Act>.md
<out>/<date>/<Act>/Subsidiary Legislation/<instrument>.md
<out>/<date>/<Act>/parse_audit.json
```

Each file starts with an optional `<!-- sso_url / sso_title -->` comment, then
sections as `## [sN]` blocks joined by `---`.

## Tests

```bash
npm install
npm test            # unit tests, no corpus needed
LEG_SRC=/path/to/legislation/ npm test            # adds corpus-backed math/footer checks
LEG_SRC=/path/to/legislation/ npm run test:corpus # golden regression over every PDF
```

- `tables.test.mjs` covers table and formula rendering and the math-glyph
  decoders. With a corpus, it also checks that the Hire-Purchase, COVID-19 and
  Presidential Elections formulas decode correctly.
- `legislation-split.test.mjs` and `legislation-reflow.test.mjs` cover the section
  splitter and the paragraph reflow.
- `unparsed-formulas.test.mjs` scans the corpus for the three affected fonts and
  fails if a new, uncatalogued file uses them.
- `legislation-regression.test.mjs` re-parses every PDF and compares it with
  `fixtures/legislation-baseline.json`. It fails if any file loses lines,
  characters or sections.

## The corpus is not included

The SSO PDFs are not redistributed here. Download them from
[sso.agc.gov.sg](https://sso.agc.gov.sg/) under its terms of use, and credit the
Singapore Attorney-General's Chambers as the source. All corpus-backed tests
skip when `LEG_SRC` is absent.

## Limitations

- Built and tuned for SSO's PDF generation corpus. Other PDFs will
  work for plain text but may hit uncatalogued math fonts.
- Scanned (image-only) PDFs are not supported; there is no OCR.
- A new math font needs its glyph table extended. The glyph-sheet scripts help
  you do that.
