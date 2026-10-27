## 0.0.2

- **The agent can now parse PDFs, using vision to learn each document's structure and writing its own Python regexes to extract fields**: new `parse_pdf` tool ([`packages/agent/src/backend/tools/parse-pdf.ts`](packages/agent/src/backend/tools/parse-pdf.ts)) plus a sandboxed Python runner ([`scripts/parse-harness.py`](scripts/parse-harness.py)). Nothing about any document type is hardcoded — the tool shows the agent what a PDF looks like and the agent decides what to extract.

- **Zero new dependencies, zero copyleft**: text extraction reuses the existing native `extractPdfText` (`tools/pdf.ts`, Node `zlib` only); page rendering reuses the existing `BrowserManager` CDP controller so Chromium's built-in PDF viewer does the rendering (BSD/Apache); vision reuses the existing `describeImageFile` helper (`tools/vision.ts`, DeepSeek API). No poppler (GPL), no ghostscript (AGPL), no ImageMagick, no Python PDF libraries, no new npm packages.

- **`parse_pdf` returns structure *and* text in one call**: it extracts text natively, serves the PDF over a temporary local HTTP server so the browser can render it regardless of where it runs (container, Flatpak, local), screenshots each requested page (default 3, capped at 10), sends each screenshot through the vision model with a layout-focused prompt, scrolls the viewer between pages, then returns the per-page vision descriptions alongside the full extracted text and the next-step instructions for the regex loop. Screenshots are written under `.parser/browser/screenshots/` and deleted after their descriptions are captured. If no browser is reachable it degrades to text-only and says so rather than failing.

- **`scripts/parse-harness.py` is a sandbox, not an agent**: the agent writes a Python script that reads a `text` variable and populates a `result` dict; the harness `exec()`s it in a namespace exposing only `re`, `json`, `collections` and a curated `__builtins__` set, converts any `re.Match` values to strings, and prints JSON. Imports outside the allowlist raise `ImportError`, script exceptions print a full traceback and exit 2, missing files exit 1 — so the agent gets a clean signal to iterate on instead of shell noise. `--output` writes the JSON to a file.

- **Registration preserves the KV cache prefix** (`tools/index.ts`): `parse_pdf` is appended after the browser tools, and it is read-only so it stays available in Ask and Plan modes. The registry/RBAC assertions in `scripts/tool-verify-test.cjs` move to 27 tools / 26 on the wire.

- **Validation**: `parse-harness.py` verified against real `judiciary_data` PDFs — a 29,701-character `2023_SGHC_226.pdf` extract yielded court, case number, decision date, parties, judge, section headers and word count through a single refined regex script, and the error paths (bad regex, missing file, disallowed import, `--output`) were exercised directly. `judiciary_data/` (4.7 GB) is now in `.gitignore`. All 803 `tool-verify-test.cjs` checks pass in `dsm-node`; the VSIX bundles `parse_pdf` and the harness reference.

- **Known data limitation, not a tool bug**: some scraped PDFs are failed stubs (e.g. `2001_SGHC_132.pdf`) — `wkhtmltopdf` captured the eLitigation page before the judgment loaded, so the file contains only a `Version No` header line, the sidecar's `summary` is empty, and there is nothing to parse. Such files need re-fetching from their `pdf_url`; the tool correctly reports the empty extract.

## 0.0.4
- **`extractPdfText` now preserves layout and deduplicates page headers/footers**, making regex-based field extraction far more reliable:

- **Same-line join via `Tm`/`Td`/`T*` tracking**: the previous implementation put a `\n` between every `Tj`/`TJ` call. wkhtmltopdf switches font face mid-line (e.g. to italic for a letter in a citation like `s 125(1)(e)`) causing those calls to be split across lines. The extractor now tracks the text-matrix y-position inside each `BT` block. Two consecutive calls whose y hasn't changed by more than half the font size are joined on the same line; only genuine line-breaks emit a `\n`. Statute citations, inline italics, and font-varied text now appear as single readable lines.

- **Page header/footer deduplication**: wkhtmltopdf PDFs embed the "Version No N: DD Mon YYYY (HH:MM hrs)" watermark and running case-name headers as separate overlay streams, one per page. The extractor now builds a cross-stream frequency table and removes any line that is ≥15 characters and appears in ≥30 % of all text streams (minimum 3 occurrences). This strips the repeated watermark without touching unique content. Tested on `2023_SGHC_226.pdf`: 19 × "Version No 1: 16 Aug 2023 (15:51 hrs)" and the per-page running header lines are gone; all judgment body text is preserved.

- **`extractPdfText` signature unchanged** — zero breaking changes; all 803 tool-verify checks pass.

## 0.0.5
- **`extractPdfText` now decodes Type0 CID fonts with ToUnicode CMaps**, fixing garbled output on PDFs that use Identity-H encoded fonts (the majority of the judiciary dataset):

- **xref-guided object lookup**: parses the PDF cross-reference table to find exact byte offsets for all objects, then reads and decompresses each object's stream to identify ToUnicode CMap objects. Handles both uncompressed CMap streams (stored as plain PostScript text) and FlateDecode-compressed ones.

- **CMap parsing**: reads `beginbfchar`/`endbfchar` blocks (direct glyph→Unicode pairs) and `beginbfrange`/`endbfrange` blocks in both sequential form (`<start> <end> <destStart>`) and explicit-array form (`<start> <end> [<u1> <u2> …]`).

- **Per-font CMap table**: the `Tf` operator now records the active font resource name (e.g. `F6`). Each string token — whether a literal `(…)` or a hex `<AABB>` — is decoded through that font's CMap if one exists, or falls back to Latin-1 for standard-encoded fonts.

- **Hex string support**: hex strings (`<0001>`, `<000A>`, etc.) are now decoded as raw bytes and passed through the CID decoder. The previous implementation skipped all hex strings silently.

- **Validated on `2015_SGHC_78.pdf`**: 6 font CMaps built (F6 ArialRegular 25 glyphs, F7 ArialItalic 2 glyphs, F8–F10 and F17 Verdana/heading fonts 43–92 glyphs). Output: full readable judgment — "ARS v ART and another [2015] SGHC 78", case metadata, 260,049-char body. Previously yielded raw glyph IDs (`\u0000\u0001\u0000\u0002…`).

- **No regression on Latin-1 PDFs**: `2023_SGHC_226.pdf` (0 ToUnicode fonts) still produces 28,709-char clean output via the Latin-1 fallback path.

- **`extractPdfText` signature unchanged** — zero breaking changes; 803/803 tool-verify checks pass.
## 0.0.7
- **`extractPdfText` now handles the remaining font-encoding edge cases**, taking the full 9,086-file judiciary dataset to zero garbage:

- **`/Differences` glyph-name encodings**: fonts may override their encoding with a `/Differences` array mapping byte codes to Adobe glyph names (e.g. `[1 /T /h /i /r /d]`). These are now parsed into a code→Unicode map via a 180-entry glyph-name table (single letters, punctuation, accented Latin, ligatures, `uniXXXX`/`uXXXX` forms). Aspose.Pdf documents use this heavily — `2017_SGHC_143` went from 1,286 garbage runs to **0**. Single-byte `/Differences` maps are decoded one byte at a time, distinct from 2-byte CID ToUnicode CMaps.

- **Font names containing `_`**: the font-resource regex required names to match `[A-Za-z][A-Za-z0-9]*`, so names like `C2_0` (common in Word/Aspose output) were never registered and their text fell through to raw-byte decoding. The class now includes `_`.

- **ICC colour profiles skipped**: `/ICCBased` streams carry no `/Subtype` and no `/Length1`, so they slipped past the dict checks and were dumped as binary. A content-stream guard now requires at least one text operator (`BT`, `Tj`, `TJ`, `Tf`, `Td`, `TD`, `Tm`, `T*`) before a decompressed stream is parsed.

- **Validated on the full 9,086-file judiciary dataset** (2000–2026, all courts): **9,084 extract with zero non-printable garbage runs, 0 garbage, 0 errors**. The only two non-clean files (`2024_SGHC_153`, `2024_SGHC_191`) are pure Konica Minolta scans with 131 and 546 images and **zero** text operators — they have no text layer, so empty output is correct (OCR would be required).

  

## 0.0.6

  

- **`extractPdfText` no longer emits binary garbage from misidentified streams**, fixing corrupted output on PDFs whose streams contain the `endstream` keyword or embedded font programs:

- **Anchored stream detection**: the stream scanner used a bare `/stream\r?\n/`, which also matches the `stream\n` inside every `endstream\n` keyword. That doubled the match count and made the parser read PDF syntax as if it were compressed stream data. The regex is now anchored on the dictionary's closing `>>` (`/>>\s*stream\r?\n/`), so only real stream starts match.

- **`/Length`-based boundaries**: stream bodies are now delimited by the declared `/Length` from the stream dictionary, falling back to the next `endstream` keyword only when `/Length` is absent. This is the PDF-spec approach and is immune to binary data that happens to contain `endstream`.

- **Non-content streams skipped**: font programs (`/Subtype /CIDFontType2`, `/TrueType`, `/Type1C`, …) and images (`/Subtype /Image`) are binary and were previously dumped as garbage when `inflateSync` failed. Streams whose dictionary declares a `/Subtype` are now skipped, and a failed inflate now skips the stream instead of falling back to raw bytes.

- **Reliable dictionary recovery**: a new `readStreamDict` helper reads forward from the object's `N G obj` header and balances `<<`/`>>` to the stream keyword. The previous non-greedy `/<<([\s\S]*?)>>/` could start at a nested `<<` (e.g. `/ColorSpace`, `/CIDSystemInfo`) and misread the dictionary; a backward bracket walk was confused by binary data in earlier streams.

- **`readObjDict`/`readObjStream` hardened**: the ToUnicode-CMap object readers now use the same anchored `>>stream` detection and `/Length`-based boundaries.

- **Font programs skipped via `/Length1`**: Microsoft Word / Aspose.Words PDFs embed TrueType font programs whose stream dictionaries carry `/Length1` but no `/Subtype`. These were decompressed and dumped as binary. Streams declaring `/Length1` are now skipped alongside `/Subtype` streams.

- **WinAnsiEncoding → Unicode mapping**: fonts declaring `/Encoding /WinAnsiEncoding` emit Windows-1252 bytes, whose `0x80–0x9F` range holds printable punctuation (curly quotes `'` `"` `"`, en/em dashes `–` `—`, ellipsis `…`, bullet `•`, …) rather than C1 control codes. The no-CMap decode path now maps that range to Unicode instead of passing the raw bytes through, so `respondents\x92 shares` renders as `respondents' shares`.

- **Lint and tests**: removed two pre-existing `no-useless-escape` errors in the content-stream tokenizer regex; updated the stale `browser-use.test.cjs` assertion that expected the browser tools to be registered last (the `parse_pdf` tool is now appended after them). 113/113 unit tests pass.

## 0.0.7

  

- **`extractPdfText` now handles the remaining font-encoding edge cases**, taking the full 9,086-file judiciary dataset to zero garbage:

- **`/Differences` glyph-name encodings**: fonts may override their encoding with a `/Differences` array mapping byte codes to Adobe glyph names (e.g. `[1 /T /h /i /r /d]`). These are now parsed into a code→Unicode map via a 180-entry glyph-name table (single letters, punctuation, accented Latin, ligatures, `uniXXXX`/`uXXXX` forms). Aspose.Pdf documents use this heavily — `2017_SGHC_143` went from 1,286 garbage runs to **0**. Single-byte `/Differences` maps are decoded one byte at a time, distinct from 2-byte CID ToUnicode CMaps.

- **Font names containing `_`**: the font-resource regex required names to match `[A-Za-z][A-Za-z0-9]*`, so names like `C2_0` (common in Word/Aspose output) were never registered and their text fell through to raw-byte decoding. The class now includes `_`.

- **ICC colour profiles skipped**: `/ICCBased` streams carry no `/Subtype` and no `/Length1`, so they slipped past the dict checks and were dumped as binary. A content-stream guard now requires at least one text operator (`BT`, `Tj`, `TJ`, `Tf`, `Td`, `TD`, `Tm`, `T*`) before a decompressed stream is parsed.

- **Validated on the full 9,086-file judiciary dataset** (2000–2026, all courts): **9,084 extract with zero non-printable garbage runs, 0 garbage, 0 errors**. The only two non-clean files (`2024_SGHC_153`, `2024_SGHC_191`) are pure Konica Minolta scans with 131 and 546 images and **zero** text operators — they have no text layer, so empty output is correct (OCR would be required).
  
  ## 0.0.8

  

- **`extractPdfText` now handles the legislation dataset**, taking the full 6,063-file corpus to **100% clean**:

- **PDF 1.5 cross-reference streams**: files with no traditional `xref` table (only a `/Type /XRef` stream) previously yielded no object offsets, so no fonts or content streams were found. The xref stream is now parsed, including its `/W` field widths and `/Index` subsections.

- **PNG predictor decoding**: xref streams are commonly FlateDecode-compressed with `/DecodeParms /Predictor 12`. The predictor (None/Sub/Up/Average/Paeth) is now undone before the table is read.

- **Object streams (`/ObjStm`)**: PDF 1.5 packs font dictionaries, ToUnicode CMaps and page resources inside compressed object streams. A new `buildObjectMap` expands them, so fonts and CMaps stored there are now resolved.

- **Indirect `/Length`**: stream lengths given as `/Length 511 0 R` (rather than a literal) are now resolved. A prefix-matching bug that read `838` as `83` was also fixed.

- **Stream slice taken verbatim**: the trailing-newline strip corrupted compressed data whose last byte happened to be `\n`, causing `unexpected end of file`. `/Length` already gives the exact byte count, so the slice is no longer trimmed.

- **`readStreamDict` anchored on the object header**: `lastIndexOf("obj")` could land inside binary stream data; it now requires the `N G obj` pattern and includes the dict's closing `>>` (which sits at the stream keyword's index).

- **Per-page font resolution**: resource names are page-scoped — the same name (e.g. `T1_0`) can refer to different font objects on different pages. Fonts are now resolved against each page's own `/Font` dict instead of a single global name→font map, which previously let one page's mapping clobber another's.

- **`/Differences` preferred over ToUnicode for simple fonts**: some generators emit a ToUnicode CMap that disagrees with the font's actual `/Differences` encoding (e.g. mapping a word space to TAB). For single-byte fonts the `/Differences` array is authoritative, with the CMap filling any gaps.

- **ToUnicode code width detection**: a ToUnicode CMap may use 1-byte codes (simple fonts) or 2-byte codes (Type0/Identity-H). The width is inferred from the most common key length, so simple fonts are no longer decoded as 2-byte CIDs.

- **Glyph-width-based word spacing**: Arbortext/PDFlib output positions each word with a `Td` advance and no space glyph. Word gaps are now detected by comparing the advance against the run's real width from the font's `/W` array (a gap beyond ~0.2 em is a space), instead of a crude per-character estimate that split words like `STATUTES` into `STA TUTES`.

- **Control characters normalised**: glyphs mapped to control codes (commonly TAB for a space) are converted to plain spaces.

- **Validated on the full 6,063-file legislation corpus** (2026-05-30 snapshot, all Acts and subsidiary legislation): **6,063/6,063 extract with zero non-printable garbage runs, 0 garbage, 0 empty, 0 errors**. The judiciary dataset was re-run as a regression check and remains at 9,084 clean with the same two scanned-image files.

## 0.0.9

  

- **Word-spacing threshold corrected**, fixing text where words ran together (e.g. `Subjecttosection59A,aprotectormaydoallorany ofthe` in the Women's Charter 1961):

- Arbortext/PDFlib output positions each word with a `Td` advance and no space glyph, so word gaps must be inferred by comparing the advance against the run's real glyph width. The previous threshold of `0.2 em` sat **inside** the word-gap population rather than in the valley between it and ordinary kerning, so roughly half of all spaces were dropped on fonts with wide glyphs (Times New Roman Bold).

- Measured across a full document the two populations are cleanly separated: kerning gaps are ≤0.05 em, word gaps ≥0.18 em, with an **empty valley** between. The threshold is now `0.1 em`, which sits in that valley and is robust across fonts.

- Validated on the Women's Charter 1961 (267 pages): zero glued word runs, and the extracted text now matches the rendered PDF line-for-line. Both full corpora were re-run as a regression check — legislation remains 6,063/6,063 clean and the judiciary dataset remains 9,084 clean with the same two scanned-image files.

## 0.0.10

  

- **Running headers/footers with a per-page number are now stripped**:

- The existing dedup only removed lines that repeated **verbatim**, so page furniture whose page number changes on every page survived — e.g. `S 230/20091`, `S 230/2009 2`, `S 230/20093`, `S 230/2009 4` in the Income Tax (Exemption of Interest and Other Payments...) Notification 2009.

- Lines are now counted by a **page-number-normalised** form (all trailing digits and whitespace dropped), once per stream, so the variants collapse into a single entry and the frequency reflects how many pages carry it. Both the glued (`S 230/20091`) and separated (`S 230/2009 2`) forms normalise to the same key.

- The length floor was lowered from 15 to 6 characters so short footers are eligible; the frequency test (≥30 % of streams, minimum 3) is what prevents false positives.

- **Structural headings are explicitly protected** — `PART`, `ARTICLE`, `DIVISION`, `CHAPTER` and `SCHEDULE` lines also end in a number and must never be stripped. Verified on the Women's Charter 1961: all 43 `PART` headings survive while every running footer is removed.

- Page numbers inside the Arrangement of Sections index are legitimate content and are correctly left in place.

- Both full corpora re-run as a regression check — legislation remains 6,063/6,063 clean and the judiciary dataset remains 9,084 clean with the same two scanned-image files.

## 0.0.11

  

- **Paragraph structure is now preserved in the extracted text**:

- Previously every physical line was emitted as its own line with no blank lines, so downstream markdown conversion could not tell a wrapped line from a paragraph boundary — the whole document collapsed into one block or split at every wrap.

- `flushLine` now emits a **blank line at each paragraph break**, detected from three signals: a vertical gap larger than the usual line advance; the previous line ending well short of the text width (a "short line" is the last line of a paragraph); and a line that opens a citation (`[S 326/2024 ...]`) or a numbered sub-clause (`(1A)`, `(a)`, `(ii)`), which always starts a new block even when right-aligned.

- The typical line advance is tracked as a running estimate that ignores paragraph-sized gaps, so a break does not inflate the baseline used to detect the next one.

- Validated on the Income Tax (Exemption of Interest and Other Payments...) Notification 2009 and the Women's Charter 1961 (267 pages, 4,126 paragraph breaks): headings, sub-clauses and citations each land on their own block while wrapped lines stay joined.

- Both full corpora re-run as a regression check — legislation remains 6,063/6,063 clean and the judiciary dataset remains 9,084 clean with the same two scanned-image files.

## 0.0.12

  

- **`TJ` word-space threshold corrected and paragraph detection refined**, found by sampling across all five legislation generators (Arbortext/PDFlib, Acrobat Distiller, Aspose.Words):

- **`TJ` kern threshold**: the word-space test used a fixed `-200` (thousandths of an em). Acrobat Distiller output places word gaps at `-193` to `-213`, so roughly half were missed and words ran together (`aperson(the claimant) hasafter9April1987entered intoa`). Measured across the document the two populations are cleanly separated — intra-word kerning is ≤0.02 em, word gaps ≥0.19 em, with an **empty valley** between — so the threshold is now `-100`, which sits in that valley.

- **Paragraph detection**: added an indentation signal. A line that returns to the body's left margin after an indented run starts a new paragraph. The body margin is learned as the most common left position across the document, so centred titles and right-aligned citations do not confuse it. This fixes both over-splitting (`(b) the obligation is unenforceable against him (or he` / `repudiates the contract)...` split into three blocks) and under-splitting (`the contract was made,` joined to the following paragraph).

- **Validated across the full 6,063-file legislation corpus** with a structure-aware sweep that checks not just for garbage but for missing paragraph breaks: **6,063/6,063 clean, 0 with zero blank lines, 0 with <2% blank lines**. The judiciary dataset was re-run as a regression check and remains at 9,084 clean with the same two scanned-image files.

## 0.0.13

  

- **Simple-font width tables and `Td` word spacing**, found by sampling 5% of the legislation corpus across all generators:

- **`/Widths` support**: `parseWidths` only understood the CID `/W` array format, so Type1/TrueType fonts (which use `/FirstChar` + `/Widths`) had no width table. The pen estimate then fell back to a crude 0.5 em per character, which was wrong enough to lose word spaces (`(a)an order`, `accountingentity`). Both formats are now parsed, in either key order.

- **Widths registered without a CMap**: `register` returned early when a font had no ToUnicode/Differences map, discarding its widths. Widths are now registered independently, and `globalResolve`/`byObjId`/`decodeString` no longer bail out on a missing CMap.

- **Width sharing across a font face**: a subset may omit the width table on some of its fonts; widths are now shared between fonts with the same BaseFont (subset prefix stripped).

- **`Td` spacing model**: the gap is now the advance minus the width of the run just emitted, with a tolerance for the estimate's error. Punctuation is positioned with its own advances, so a gap adjacent to a quote or bracket is not treated as a word space — but a closing quote followed by a word still gets one (`“authorised person” means`).

- **Validated on a 5% sample of the legislation corpus** (304 files, every 20th) plus the full corpus: **6,063/6,063 clean, 0 with missing paragraph breaks**. The judiciary dataset remains at 9,084 clean with the same two scanned-image files.

## 0.0.14

  

- **Legislation section splitter** (`packages/agent/src/backend/tools/legislation.ts`), a zero-dependency TypeScript replacement for the Python `pymupdf4llm` + regex pipeline:

- **Why**: the Python ingest (`legislation_parse.ipynb` → `ingest_shared/pdf_ingest.py`) is built on **PyMuPDF, which is AGPL-3.0** — the licence category this project excludes. It also produces 90 `BODY-BLEED` warnings across 523 Acts, where running headers and footers bleed into section bodies. Our extractor already strips those, so the splitter runs on our clean text instead.

- **Output format is byte-compatible** with the Python pipeline: `## [sN]` headers separated by `\n\n---\n\n`, so `legislation_embed.ipynb` and `legislation_verify.ipynb` consume it unchanged. Verified by replaying the notebook's own `read_md_chunks` parser against our output.

- **Section shapes handled**: `12. Short title`, `12.—(1) ...`, `3.— (1) ...` (space after the dash), bare `12.`, letter suffixes (`8A`, `386AFA`), and repealed sections (`54. [Repealed by Act ...]`, `49. to 53. [Repealed]`).

- **Front-matter skipping**: the Arrangement of Sections (also `ARRANGEMENT OF PARAGRAPHS` / `RULES` / `REGULATIONS`) is a table of contents whose entries are indistinguishable from section starts. The boundary is found from the enacting formula (`In exercise of the powers conferred by ...`), the long title (`An Act relating to ...`), a commencement date, or a `The Schedule` line — whichever comes first.

- **False-positive guards**: a four-digit number in 1900–2100 is a wrapped year, not a section (`2020.` at the start of a line); a hyphen is only a separator when followed by whitespace, so `12-month post-confinement period` is not a section; a Schedule heading must be the whole line, so a cross-reference (`Second Schedule;`) does not end detection; and numbering must advance, so a Schedule that restarts at 1 terminates the section list.

- **Validated against the Python pipeline's own output** across all 6,062 parsed files: **5,412 exact id-sequence matches (89.3%)**, up from 5,185 (85.5%) after the fixes below. Of the remainder, the large majority are cases where the Python output is wrong — it counts Schedule items and wrapped years as sections (e.g. `Animals and Birds (Disease) Notification`: 112 vs our 2; `Active Mobility (Footpaths) Order`: 58 vs our 4; `Revised Edition of the Laws (Section 7) Order 2021`: 510 vs our 2), and in 134 files it gives up entirely (`whole_doc`) where we find sections. Our extractor's text is unchanged: 6,063/6,063 clean.

- **Fixes found by diffing against the reference output**:

- **Legislative History appendix**: the numbered list of amendments at the end of every instrument was being counted as sections. Detection now stops at `LEGISLATIVE HISTORY`. This alone removed 153 spurious sections across the corpus.

- **Backward jumps no longer end detection**: a stray number inside body text (`2 — Flight Recorders;`, a wrapped specification reference) used to terminate section detection for the whole document, losing every later section. It is now skipped. This recovered 76 sections in `Air Navigation (121 — ...)` alone.

- **Deleted ranges**: `18. to 25. [Deleted by S 237/2002]` is now recognised alongside `[Repealed]`, and the next section is allowed to jump ahead when the intervening sections were deleted (`18. to 25. [Deleted]` followed by `87.`).

- **Whole-Part deletions**: a `PART` heading followed by a bare `[Deleted by S 503/2022]` marker (no section number) also allows the next section to jump ahead. This recovered `s39` in `Banking (Corporate Governance) Regulations 2005`, which had been truncated at `s22`.

- **Wrapped section titles ending in `Schedule`**: `61. Summary disposal of charges for offences not specified in First` / `Schedule` was mistaken for a Schedule heading, truncating `Singapore Armed Forces Act 1972` at `s60` instead of `s208`. A bare `Schedule` now only ends detection when the preceding line ends a sentence (or is a page number), so a wrapped title continuation is not a heading.

- **Amending instruments starting above 1**: a short notice whose first section is 2 (section 1 omitted) now yields `s2` instead of falling back to `whole_doc`. This reduced `whole_doc` fallbacks from 40 to 3.

- **`[Deleted]` vs `[Repealed]`**: the reference pipeline keeps `[Deleted by ...]` sections but absorbs `[Repealed by ...]` into the preceding body — an inconsistency in its own regex, not a rule. We keep both, which is the principled behaviour.

- **Era analysis**: bucketing the corpus by enactment year shows the exact-match rate dips to 82.7% for 1970–1989 Acts and recovers to 91–93% from 1990 onward. The cause is not the PDF format — the files are re-typeset, so a 1930s Act is a 2015 PDF — but the amendment history: older Acts accumulate deleted ranges, renumbered sections and letter-suffixed insertions, which is exactly what the sequence logic has to reason about. Text extraction is era-independent: 6,063/6,063 clean in every bucket.

## 0.0.15

  

- **Section-splitter accuracy: 86.7% exact id-sequence match** against the Python pipeline's own output (5,257 of 6,062 files). The score is *lower* than the previous 89.3% because a correctness fix now correctly identifies Schedule-only instruments, which the reference pipeline mis-splits — see below. Bugs were found by bucketing the corpus by enactment year, then by running a **50% sample** (3,032 legislation files, 10,516 judiciary files) and finally a **100% sweep** of both corpora, classifying every divergence by direction:

- **Schedule-only instruments**: a notification whose entire content is a Schedule (a single sentence plus a numbered table) was producing sections from the table rows. `Currency (Denominations and Characteristics of Coins) Notification 2018` yielded `s3, s4, s5` from `3. The word "SINGAPORE" appears...`; `Fire Safety Act ... Occupier Or Owner of Industrial Premises` yielded 58 sections from a premises table. These now correctly return `whole_doc`. The reference pipeline counts the table rows as sections (58, 59, 11, ... in the worst cases), so this fix *reduces* the exact-match score while being more correct: `oursWhole` rose from 3 to 255 and `theirsWhole` fell from 133 to 74. A Schedule heading is now recognised before any section has been seen, with a guard that distinguishes the TOC's `The Schedules` entry (followed by the commencement date or enacting formula) from a real Schedule heading (followed by its content).

- **Whole-Part deletions**: a `PART` heading followed by a bare `[Deleted by S 503/2022]` marker (no section number) means the whole Part was removed, so the next section jumps ahead. `Banking (Corporate Governance) Regulations 2005` had been truncated at `s22` instead of `s39`.

- **Wrapped section titles ending in `Schedule`**: `61. Summary disposal of charges for offences not specified in First` / `Schedule` was mistaken for a Schedule heading, truncating `Singapore Armed Forces Act 1972` at `s60` instead of `s208`. A bare `Schedule` now only ends detection when the preceding line ends a sentence (or is a page number), so a wrapped title continuation is not treated as a heading. Two earlier, stricter versions of this guard were rejected because they also discarded real Schedule headings (`SECOND SCHEDULE` is followed directly by `Sections 5(1), 64(2) ...`, not a blank line) and cost more matches than they gained.

- **Page ranges mistaken for sections**: a Schedule's page list (`157–158, 169–172C, 261–262`) matched the section-start pattern, so `Notice under Sections 10(6) and 17(6) ... [S 352_2001]` produced a spurious `s157` instead of `whole_doc`. A dash followed by another digit is now excluded.

- **Repealed ranges starting on a letter suffix**: `4A. to 9. [Repealed by Act 12 of 2020]` was rejected because the guard only accepted `lastNumber + 1`, not the same number with a letter suffix. `Building (Strata Management) Act 2004` had been truncated at `s4A` instead of `s139`; it now matches the reference exactly at 142 sections.

- **Era analysis**: bucketing by enactment year shows the exact-match rate dips to 82.7% for 1970–1989 Acts and recovers to 91–93% from 1990 onward. The cause is not the PDF format — the files are re-typeset, so a 1930s Act is a 2015 PDF, and the producer mix (Acrobat Distiller, Aspose.Words, PDFlib+PDI) is similar in every era — but the amendment history: older Acts accumulate deleted ranges, renumbered sections and letter-suffixed insertions, which is exactly what the sequence logic has to reason about. Text extraction is era-independent: 6,063/6,063 clean in every bucket.

- **Text quality verified on the full corpus (100%)**: legislation 6,063/6,063 clean (0 garbage, 0 glued, 0 empty, 0 errors); judiciary 21,027 clean with the same 4 empty scanned-image files (`2024_SGHC_153`, `2024_SGHC_191`, each appearing twice). The earlier "164 glued" reading was a false positive in the detector, which matched short words as substrings of legitimate long words (`intergovernmental`, `incomprehensible`, `professionalising`); requiring a whole-word boundary inside the run brings it to 0.

- **`parse_legislation` tool** (`packages/agent/src/backend/tools/legislation/tool.ts`): exposes the splitter to the agent. Extracts text via `extractPdfText`, splits into sections, and returns the section list plus the rendered `## [sN]` Markdown, with an optional `write` argument. Registered after `parse_pdf` to preserve the KV cache prefix. Without this the splitter was tree-shaken out of the bundle and never shipped.

- **Tools regrouped by corpus.** The three document corpora were previously organised by mechanism, so the file names did not say which corpus a module served — `legislation.ts` handled both principal Acts and subsidiary legislation, and judiciary had no TypeScript implementation at all. The layout is now:

- `tools/pdf/extract.ts` — corpus-agnostic text extraction (`extractPdfText`), Node `zlib` only.

- `tools/pdf/tool.ts` — the `parse_pdf` tool (was `parse-pdf.ts`).

- `tools/legislation/split.ts` — the section splitter (was `legislation.ts`), serving both principal Acts and subsidiary legislation. The two corpora share a section-numbering scheme and differ only in front matter (`ARRANGEMENT OF SECTIONS` + long title + date bracket for Acts; `ARRANGEMENT OF PARAGRAPHS`/`RULES` + enacting formula for SL), which is resolved by the `bodyStart` boundary, so they stay in one module rather than being split artificially.

- `tools/legislation/tool.ts` — the `parse_legislation` tool (was `parse-legislation.ts`).

- `tools/judiciary/split.ts` — the judgment splitter (new). `judiciary_ingest.ipynb` imports `ingest_shared.judgment_ingest`, which is **not present in this workspace**, so the judiciary path had no TypeScript implementation; this ports it. Handles both judiciary document types: full judgments (a case folder with a PDF + JSON sidecar) and case summaries (`judgments_case_summaries/`, PDF only). Sections are the topic headnotes (one per catchword) followed by the body split into ~4000-character chunks, matching the notebook's `read_md_chunks` parser.

- **The full judiciary corpus is now parsed into `parsed_judiciary/`** (git-ignored): **21,027 of 21,031 PDFs written, 296,669 sections, 0 errors**. The 4 unwritten files are the two known pure-image scans (`2024_SGHC_153`, `2024_SGHC_191`), each appearing twice (case folder + `judgments_case_summaries/`). Quality sweep over all 21,027 outputs: **0 empty, 0 garbage, 0 with missing paragraph breaks, 0 failing the notebook's own `read_md_chunks` round-trip**.

- **Body-start detection** had to handle two layouts. Newer judgments put `GROUNDS OF DECISION` first, then the catchwords, a table of contents, and a *repeated* header block — so the judge's name line (`Goh Yihan JC:`) is the true body start, not the marker. Older judgments have no such heading at all (`2015_SGHC_78` starts the body at `Quentin Loh J:` followed by `Introduction` and paragraph 1). The order is therefore: judge line, then `GROUNDS OF DECISION`, then the first numbered paragraph.

- **Catchwords** precede the body in older judgments and follow `GROUNDS OF DECISION` in newer ones, so the scan window spans both. Footnote markers (`[note: 1]`) share the bracketed shape and are excluded.

- **Table of contents** is stripped: its entries are dotted leaders (`BACKGROUND FACTS .........`), and the leaders are dropped along with the page markers between them.

- **Delimiter collision**: judgment transcripts use `---` as an em-dash substitute (`there---there`, `this---this---these`). When such a run lands at the start of a line it becomes a bare `---` line, which the notebook's `\n---\n` split reads as a section boundary — truncating the section and producing 60 files that failed the round-trip. A body line that is exactly `---` is now prefixed with a zero-width space, keeping the text intact while making the line no longer a delimiter. This took the round-trip failures from 60 to 0.

- **Paragraph reflow**: the extractor emits one line per *visual* line of the PDF and inserts no paragraph breaks, so a page arrives as a run of short lines (the reported `2023_SGHC_76` had 1,716 non-blank lines and 1,655 blanks, but **every** blank was a page join — the longest run of consecutive lines was 25, i.e. no paragraph structure at all). Chunking on blank lines therefore produced one chunk per page with the visual line breaks preserved, which read as "so many spaces". Paragraphs are now rebuilt from the text: a numbered paragraph (`1 The gravamen ...`) starts a new block, a blank line starts a new block, and a line ending a sentence followed by a line starting a new one starts a new block. A hyphen at a line end is treated as a word break (`ocean-` / `going` → `oceangoing`).

- **Page breaks mid-paragraph**: a paragraph that spans a page break continues across it. The page number is dropped, and the blank lines around it (`blank, number, blank`) do not flush the paragraph. Where a page join has no page number, the text decides: a paragraph still mid-sentence continues.

- **Footnotes**: the footnote block at the foot of each page (`1 Affidavit of Evidence-in-Chief ...`, `2 AEIC of ...`) is apparatus, not judgment text, and is dropped. A numbered paragraph shares the shape, so a line that continues the paragraph sequence is never treated as a footnote; the number is capped at two digits and must not be followed by a month name, so a wrapped date (`30 July 2019.2`) is not mistaken for footnote 30.

- **Extractor line-advance fix**: `lineAdvance` is per-stream (per-page) and was being poisoned by a standalone page number, whose tiny gap dragged the estimate from 12.37 down to 0.93 — after which every real line gap (20.70) exceeded `0.93 * 1.6` and was treated as a paragraph break. A gap far smaller than the estimate is a same-line artefact (a superscript, a footnote marker, a font switch) and no longer feeds the estimate, and a standalone page number is excluded outright.

- **Extractor short-line fix**: the "a short line ends a paragraph" rule fired on ordinary wrapping. In a ragged-right layout most lines stop short of the widest line, so the width test alone split continuous sentences (`...the third defendant, Rotating` / `Offshore Solutions Pte Ltd...`). The rule now also requires the previous line to end a sentence. This took the reported `2023_SGHC_76` from 783 blank lines to 522, and the paragraphs now read as prose.

- **Known limitation — footnotes are not removed.** The footnote block sits inline in the body stream, between the body text and the page number, and its continuation lines overlap the body's y-range, so a positional test cannot separate them reliably. The splitter's line-shape test catches the numbered openings (`1 Affidavit of ...`) but not their continuations (`paras 17–19 (1BA at pp 9, 10).`), so a footnote's tail can still appear mid-paragraph. Removing them properly needs page-boundary awareness in the extractor, which it does not currently have. This is the one known defect in the judiciary output.

- No behaviour change: all 8 reference files still split identically (Accountants 96, Singapore Armed Forces 247, Building (Strata Management) 142, Air Navigation 83, Companies Regulations 33, Child Development 57, Appraisers 13, Companies (Summary Financial Statement) 7), lint is clean, and 113 unit tests pass. Also fixed a pre-existing `no-useless-assignment` lint error in the `parse_pdf` tool (`browserAvailable` was initialised to `false` and then assigned in both branches before any read).

## 0.0.16

  

- **The judiciary output now uses the GRPO reference format, produced by the in-house parser.** The reference pipeline (`ingest_shared/judgment_ingest.py`) calls `pymupdf4llm.to_markdown`, which is AGPL — the category this project excludes. Its sectioning contract was therefore ported to TypeScript in `packages/agent/src/backend/tools/judiciary/ingest.ts`, and the body text now comes from `extractPdfText` instead.

- **The contract, reproduced exactly** (verified by reading their producer script, not by guessing from the output):

- `_meta` — a metadata-only section: `topics_for_embed`, the case name, the citation line and a `Legislation: ...` line listing the statutory references found in the judgment. Always emitted, so a judgment stays findable by topic even when text extraction fails.

- `_c0`, `_c1`, … — body sections grouping whole paragraphs up to a 4,000-character budget. Every one is prefixed with the topic headnotes; `_c0` additionally carries the case name and citation line (joined with a single newline, not a blank line); every one carries the `Legislation:` line when the judgment cites any.

- Rendered as `## [id]\n\n<text>` joined by `\n\n---\n\n`, which is exactly what `read_md_chunks` in `judiciary_ingest.ipynb` splits on.

- Section ids are `<citation>_meta` / `<citation>_cN`, so `2023_SGHC_76.pdf` yields `2023_SGHC_76_meta`, `2023_SGHC_76_c0`, … — the same keys the reference produces, so a Qdrant point id (`uuid5` over `source_file` + `section_id`) is stable across both pipelines.

- Output is flat: `parsed_judiciary/<stem>.md`, one file per PDF+JSON pair.

- **The one substitution is the text source.** Their `pymupdf4llm.to_markdown` is replaced by `extractPdfText` plus `reflowParagraphs`, which rebuilds paragraph boundaries from the extractor's line-per-visual-line output.

- **Footnote apparatus is rendered as blockquotes** (`> 1 Affidavit of Evidence-in-Chief ...`), matching the reference. Detecting it took three attempts, and the failures are worth recording because each looked reasonable:

- *Numbering alone does not work.* Footnote numbers run continuously through a judgment and overlap the paragraph numbers — `2023_SGHC_76` has paragraphs 1–126 and footnotes 1–143 — so no comparison of the two separates them.

- *A high-water mark mis-renders body text.* Treating any number above the last paragraph number as a paragraph start, and anything below as a footnote, fails because a footnote's number can exceed the current paragraph number. Worse, a single stray number poisons the mark: `1994 and 20 December 1997, the first defendant was a` (a wrapped year) set it to 1994, after which no paragraph in `2001_SGHC_66` was recognised and short ones were rendered as blockquotes. Wrapped years are now excluded, as in the legislation splitter.

- *The signal that works is position.* The footnote block sits at the foot of the page, immediately above the page number, and its blocks are unnumbered. So at each page break the sectioner walks back over the unnumbered short blocks and marks them, stopping at the first numbered block (which is body text). At least one block must open like a footnote, or nothing is marked. The walk tolerates the extractor's occasional spurious blank inside a footnote, which splits its tail into a separate block.

- Result: **0 body paragraphs mis-flagged** anywhere in the corpus, and 33.9 blockquotes per judgment against the reference's 23.9 (higher because our reflow splits footnote blocks that `pymupdf4llm` merges). 45% of judgments carry at least one, against the reference's 41%.

- **The topics block is normalised.** `topics_for_embed` is scraped text, and about one sidecar in five wraps a long topic mid-span, leaving the closing bracket alone on the next line:

```

[Damages — Special damages

]

```

Rendered as-is that reads as a topic, an empty topic, then another topic. Two sidecars also carry a stray bracket from the scraper (`[[Tort] - [Conspiracy]`, `[Damages] - [Assessment]]`, `[Trusts] - Accessory liability]`, `[Contract] - [Waiver[]`). `normalizeTopics` joins a wrapped continuation before repairing it — a lone `]` line is the closing bracket of the entry above, not a stray of its own — then drops duplicated brackets. This is whitespace repair: it does not change which topics are listed, only how they are laid out. 2,183 of 10,516 files are affected. The reference leaves these broken, so this is a deliberate deviation; the alternative was to ship an empty topic.

- **Also ported verbatim**: `normalize_rag_text` (trailing-whitespace strip, horizontal-run collapse, `\n{3,}` → `\n\n`), `_extract_statutory_refs` (the `s 216A of the Companies Act (Cap 50, 2006 Rev Ed)` pattern, deduplicated in first-seen order), `_split_paragraphs`, `_group_by_char_budget` and `_slug`. The `---` delimiter escape from the previous splitter is retained: judgment transcripts use `---` as an em-dash, and a bare `---` line would otherwise truncate a section.

- **Verification over the whole corpus (10,516 PDF+JSON pairs)**, reading the output rather than the input:

- 10,516 files written, 0 errors — the same count as the reference directory.

- `ids-ok` **10,516 / 10,516** — every file's section ids are `<stem>_meta`, `<stem>_c0` … with no gaps.

- `topics-ok` **10,516 / 10,516** — every section opens with the same topics block, and each topic is one balanced bracket span.

- `headers-ok` **10,516 / 10,516** — the case name and citation line appear in `_meta`; the `case\ncitation` header is prefixed onto `_c0` only, and never onto a later section.

- `delim-ok` **10,516 / 10,516** — no body line is exactly `---`.

- Body sections: median 3,745 chars, p95 4,062. 13.9% exceed 4,000 chars (a paragraph that pushes past the budget is kept whole rather than split mid-sentence) — the reference's own rate is 22.4%, so the budget behaves the same way on our text.

- Quality sweep over all 10,516 outputs: 0 empty, 0 garbage, 0 glued words, and no blockquote line longer than the 302-character cap.

- **`scripts/parse-judiciary.mjs`** is the new corpus runner (tracked, unlike the scratch harnesses it replaces). It walks `judiciary_data/pdfs/` for JSON sidecars with a matching PDF, shards across processes via `SHARD`/`SHARDS`, and prints one JSON summary line per run.

- **New `parse_judiciary` tool** registered after `parse_legislation`, which is why it must sit at the end of the registry: FIFO position determines the KV cache prefix. It reads the JSON sidecar next to the PDF when present, so the topic headnotes reach the section headers, and it degrades to body-only sections when the sidecar is missing or malformed.

- `judiciary/split.ts` is deleted — superseded by `ingest.ts`. Its body-start, catchword and table-of-contents heuristics are no longer needed: the reference format takes topics from the sidecar rather than scraping them from the PDF, and the whole document (cover page and all) is chunked, exactly as the reference does.

- Lint clean on every file touched, 113 unit tests passing.

## 0.0.17

  

- **A word space was being inserted after every curly quote, 12,761 times across 2,618 judgments.** `the “ Witness Tampering Charges ” )` instead of `the “Witness Tampering Charges”)`. Asked whether this could be fixed with a regex, I checked first — and it could not, because it was not a text problem. The root cause was the line-break model, and the fix is structural.

- **Root cause, part 1 — `BT`/`ET` were treated as line boundaries.** The extractor flushed a line on `ET` and reset the y on `BT`:

  

```ts

case "BT":

inText = true

tmY = tlmY = lineY = 0

lineBuf = ""

case "ET":

if (inText) flushLine()

```

  

That is only correct for documents that put a whole line in one text object. Word processors emit **one `BT`/`ET` per text run** — a font switch, a colour change, a quote in a different font — all on the same baseline:

  

```

BT /F1 12 Tf 1 0 0 1 113.66 704.5 Tm [(xc)4(ha)4(nge)4( )-619(\()] TJ ET

BT /F3 12 Tf 1 0 0 1 168.02 704.5 Tm [<00B3>] TJ ET <- the opening quote

BT /F1 12 Tf 1 0 0 1 173.3 704.5 Tm [(S)-3(GX)] TJ ET

```

  

Every run became its own output line, so the quote was separated from the text on both sides and the reflow joined it back with spaces. Line breaks are now driven purely by the y-position:

  

```ts

case "ET":

// A block that never declared a position gives us no y to compare, so

// fall back to treating it as its own line.

if (inText && !sawPosition) flushLine()

```

  

The `!sawPosition` guard matters: a few generators position text with a matrix we do not track, and for those the old behaviour is the safe one.

- **Root cause, part 2 — the CTM was discarded.** `cm` was ignored outright ("the text matrix scale is not needed"), but the same word processors position each run with `cm` and leave the text matrix at the origin:

  

```

q 11.0001 0 0 11.0001 165.033 569.877 cm BT /F1 1 Tf 0 0 Td (...) Tj ET Q

```

  

So the text-space y was 0 for every run and the y-comparison had nothing to compare. `q`/`Q`/`cm` now maintain a real transformation matrix, and the line break is measured in device space:

  

```ts

const scaleY = Math.hypot(ctm.b, ctm.d) || 1

const deviceY = ctm.b * tmX + ctm.d * tmY + ctm.f

const dy = Math.abs(deviceY - lineY)

const threshold = fontSize > 0 ? fontSize * 0.5 * scaleY : 4

```

  

The threshold is scaled too, because `fontSize` is in text space and the gap is now in device space.

- **A second, independent defect: doubled spaces.** `Witness Tampering Charges`. The font emits its own space glyph *and* a large negative kern that makes up the rest of the advance, and the TJ rule added a space on top of the explicit one:

  

```

[115,115,32] -231 [84] <- "ss " already ends with a space, then a word-gap kern

```

  

The kern now supplies a space only when the text does not already end in one, and a space glyph immediately after a kern-supplied space is absorbed rather than added.

- **Measured, on `2023_SGHC_299` (the worst file, 1,081 occurrences):**

  

| | before | after |

|---|---|---|

| spurious space after `“` | 12,761 (2,618 files) | **235 (1,021 files)** |

| that file | 1,081 | **0** |

| `Penal Code (collectively, the “Witness Tampering Charges”);` | `the “ Witness Tampering Charges ” );` | **exact match with the reference** |

| doubled spaces, that file | present | **0** |

- **No content was lost — verified, not assumed.** The line-break change alters the text layout, so I checked it two ways. First, an A/B on the same file: the old code produced 353,592 whitespace tokens and the new one 309,107, which looked alarming until I compared the *letter-word* bags — 301,742 vs 289,856, and the difference was entirely word fragments that the old layout split mid-word (`scheme` / `s]` where the correct text is `schemes]`, `TCFB` / `-11` where it is `TCFB-11`). Second, against the reference: **0.0% of our words are absent from the reference**, while 38.2% of the reference's are absent from ours — and the top of that list is `Criminal` (10,110), `Sentencing` (7,984), `Procedure` (6,386), i.e. the topic list the GRPO format repeats at the head of every one of its 537 sections.

- **Legislation is structurally better but scores marginally lower against the reference.** `Accountants Act 2004` s1 is now the real section — `PRELIMINARY / Short title / 1. This Act is the Accountants Act 2004.` — where before it was the table of contents. Yet mean similarity moved 0.696 → 0.690 and id-exact 254/303 → 253/303, because the reference's own section bodies carry its running-header bleed:

  

```

Rule 1 — Citation

[Administration Of Muslim Law (Haj) Rules · Parent Act: The Law Revision Commission

Under The Authority Of

The Revised Edition Of The Laws Act 1983]

```

  

Our s1 for that file is `PRELIMINARY / Citation / 1. These Rules may be cited as the Administration of Muslim Law (Haj) Rules.` — correct, and scored 0.50 for it. Word coverage ours→reference is unchanged at 0.947.

- **Two defects found by the 5% legislation audit, both fixed.** The audit parsed 303 PDFs (26 Acts + 277 SL, a seeded 5% sample) into `parsed_legislation_sample5/` and compared them file-for-file against `parsed_legislation/2026-05-30/`. Frontmatter matched 303/303 and section ids 253/303.

- **Defect 1 — every section heading was misattributed.** A section's heading sits immediately *above* its number in the PDF:

  

```

Citation and period in force

1.—(1) This Order is the Active Mobility (Enforcement Detection

```

  

The splitter started each section at the number line, so the heading fell at the end of the **previous** section's body — and the first section's heading was dropped along with the front matter. 2,260 of 3,159 sampled sections (72%) were affected. `splitLegislationSections` now walks each start back over its heading lines:

  

```ts

const fromLine: number[] = unique.map((s, i) => {

const floor = i > 0 ? unique[i - 1].line + 1 : bodyStart

let from = s.line

for (let k = 0; k < HEADING_MAX_LINES && from - 1 >= floor; k++) {

if (!isHeadingLine(lines[from - 1])) break

from--

}

return from

})

```

  

`isHeadingLine` accepts a title-shaped line (≤80 chars, no terminal `. ; : ,`, not opening with `(`, not numbered, starting with a capital) and rejects everything else. The walk is bounded by the previous section's start, so it can never cross a boundary, and by `HEADING_MAX_LINES = 2` — measured: 45% of headings sit on one line, 6% wrap over two. Result: **2,260 → 8**.

- **Defect 2 — a word space was dropped after a closing curly quote.** `“English enactment”means` instead of `” means`, in **727** places across the sample, against **2** in the entire reference corpus. The cause was in `appendText`'s width model:

  

```ts

} else if (wmap && raw) {

for (let i = 0; i + 1 < raw.length; i += 2) {

const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1)

```

  

That loop reads **2-byte CIDs**, but the font in question is single-byte (`/Encoding/WinAnsiEncoding`, `/Widths[333 443 443 0 0 1000]`, `/FirstChar 146`). For a lone `”` the raw string is one byte, so the loop never runs and `lastRunWidth` comes out **0** — which disables the word-space test in the `Td` handler, because that test bails when the previous run measured zero width:

  

```ts

const expected = lastRunWidth

if (expected > 0 && dx - expected > fontSize * 0.1) pendingSpace = true

```

  

With the correct width the test passes easily: `0.7675 − 0.443 = 0.3245 > 0.1`. Three changes:

- `singleByteByFontObjId` records 1-byte vs 2-byte codes from the font dict (`/DescendantFonts` or `/Subtype /Type0` ⇒ CID; anything else that looks like a font ⇒ single byte). This is a property of the *font*, not of its CMap — a WinAnsiEncoding font has neither `/ToUnicode` nor `/Differences`, so `resolveFont` used to return `undefined` for it and the width model had no idea it was single-byte.

- `resolveFont` now returns `{ cmap: empty, single: true }` for such a font rather than `undefined`. `decodeString` is unaffected — it already falls through to `applyWinAnsi` when the CMap is empty.

- A new `glyphWidth(raw, wmap, single)` helper picks the code width by font type, and both call sites (`appendText` and the `TJ` advance loop) use it. The `TJ` loop had the same bug: it mis-paired bytes into fake CIDs for every single-byte run, which happened to give a plausible-looking number for long runs and only failed visibly on one-character ones.

  

Result: **727 → 1**.

- **Measured improvement on the sample** (combined, 303 files):

  

| | before | after |

|---|---|---|

| orphaned headings | 2,260 / 3,159 | **8** |

| glued after `”` | 727 | **1** |

| mean similarity | 0.666 | 0.690 |

| median similarity | 0.734 | 0.763 |

| word coverage ours→ref | 0.923 | **0.947** |

| word coverage ref→ours | 0.683 | 0.688 |

  

The coverage asymmetry is the headline: 94.7% of our words appear in the reference, while only 68.8% of the reference's appear in ours — the gap is the reference's running-header bleed, which its own `parse_audit.json` flags as `BODY-BLEED`.

- **The same pattern appears in the judiciary corpus, but there it is not a defect.** 108 occurrences across 97 judgments — however the GRPO reference, produced by `pymupdf4llm`, has **145 across 121 files**. Those older judgments genuinely set the closing quote tight against the next word (`(”COD”) of the Project`, `13.10.99”on the face of the bill`), and both extractors reproduce it faithfully. We are in fact slightly cleaner than the reference here, so no change was made. The legislation case is different: there the reference had only 2 occurrences corpus-wide against our 727, which is what identified it as an extractor bug rather than a property of the source.

- **No regressions.** Full sweeps after the change: legislation **6,063/6,063** clean, 0 empty, 0 garbage, 0 errors, 0 documents without sections (67,881 sections); judiciary **21,027** clean, 4 empty (the known pure-image scans `2024_SGHC_153` and `2024_SGHC_191`), 0 garbage, 0 errors. Lint clean on the changed files, 113 tests passing.

- **Not reproduced**: the reference's `_audit_chunks` BODY-BLEED heuristic lives in `ingest_shared/pdf_ingest.py`, which is not in this workspace, so `warnings` is always `[]` in our `parse_audit.json`. Section counts match.

- **Task artefacts**: `scripts/parse-legislation-sample.mjs` (seeded stratified sampler + runner) and `scripts/compare-legislation-sample.py` (the comparison harness), both re-runnable. Output in `parsed_legislation_sample5/`, git-ignored.

## 0.0.18

- **Structural checks over the whole corpus** (all 6,063 files): 0 empty, 0 binary garbage, 0 without sections, and 0 delimiter mismatches — every file's `\n\n---\n\n` count equals its section count, including the extra delimiter the frontmatter introduces (the reference has the same shape).

- **`parse_audit.json` is self-consistent**: all 523 files, 67,881 sections total, and for every folder the recorded count equals the number of `## [` headers actually in its `.md` files — 0 mismatches.

- **Section totals differ from the reference in the expected direction**: ours 67,881, reference 74,173. The reference's extra sections are its known defects — Schedule table rows counted as sections (`Animals and Birds (Disease) Notification` 112 vs our 2; `Revised Edition of the Laws (Section 7) Order 2021` 510 vs our 2), wrapped sentence tails read as `s2020`/`s2011`, and 133 instruments it gives up on entirely (`whole_doc`). Where the two agree, the text is cleaner on our side: the reference's s1 for `Accountants Act 2004` begins `Section 1 — Short title / [The Law Revision Commission`, i.e. its running head bled into the body, and its own `parse_audit.json` carries a `BODY-BLEED` warning for `s17` that ours does not.

- **`.gitignore` corpus rules are now anchored to the repo root.** They were unanchored, so `legislation/` also matched `packages/agent/src/backend/tools/legislation/` — the splitter source would never have been committed. Now `/legislation/`, `/judiciary_data/`, `/parsed_legislation/`, `/parsed_legislation_sample5/`, `/parsed_legislation_full/`, `/parsed_judiciary/`.

  

- **Full-corpus comparison against the reference** (all 6,062 files the reference has; it has no `.md` for `Independence of Singapore Agreement 1965`, whose PDF we do parse):

  

| | Principal Acts | Subsidiary Legislation | Combined |

|---|---|---|---|

| files compared | 522 | 5,540 | 6,062 |

| frontmatter exact | **522/522** | **5,540/5,540** | **6,062/6,062** |

| id sequence exact | 455 (87.2%) | 4,751 (85.8%) | **5,206 (85.9%)** |

| mean similarity | 0.694 | 0.673 | 0.682 |

| median similarity | 0.793 | 0.749 | 0.767 |

| word coverage ours→ref | 0.936 | 0.945 | **0.941** |

| word coverage ref→ours | 0.679 | 0.676 | 0.677 |

  

The 856 non-exact id sequences are dominated by cases where we are right and the reference is not. `Agency for Science, Technology and Research Act 1990` is representative: ours `s1…s25`, reference `s1…s12, s14…s17, s19…s25` — it drops `s13` and `s18` because they read `13. [Repealed by Act 5 of 2018]` and absorbs them into the preceding body, while we keep them. Same shape for `Appraisers Act 1906` (13 vs 9), `Children and Young Persons Act 1993` (51 vs 120 — the reference counts Schedule rows), `Active Mobility (Footpaths) Order 2018` (4 vs 58) and `Administration of Muslim Law (Mosque Building and Mendaki Fund) Rules` (3 vs 24).

- **Checked that the line-merging change does not hide section starts.** A section number that ends up mid-line would no longer match the splitter's `^N.—` rule, so I scanned the whole output for one. 109 hits in 9 files, and every one is a false positive of the pattern — `Explanation 1.—`, `Example 1.—`, `Rule 1. —` — i.e. numbered explanations and examples *inside* a section, not section starts.


## 0.0.19

  

- **The legislation parser now reconstructs tables instead of flattening them into prose.** The extractor already tracked text positions, but `appendText` collapsed every run on a line into one string with at most a single space, so a table row (`(i) 7 34D`) reached the splitter indistinguishable from a sentence. The line model now keeps each run's device-space x-extent, y and font size (`TextLine`/`TextRun` in `pdf/tables.ts`), and a new `renderTables` pass turns visually tabular blocks into GitHub pipe tables.

- **Two extraction bugs surfaced and were fixed while making the geometry usable.** Runs positioned with `cm` carried no absolute x, so a parallel, BT-reset line-matrix x (`tlmX`) is tracked for geometry only — the existing paragraph heuristics still use `tmX`, so the geometry refactor alone left default output **byte-identical** (verified on WICA and the Accounting Standards Act); the separate header-dedup fix below does change default output, deliberately. And the WICA tables showed a stray `.` between `First column` and `Second column`; that lone separator dot is handled explicitly (below) rather than by a broad punctuation filter.

- **Detection is conservative by design.** Blocks are anchored on rows whose run gaps exceed ~2 em, bridged across wrapped-cell lines by a low-percentile line step so a paragraph break ends the block, and columns come from block-wide gutters topped up from a header row when a wide data cell closes the gutter. A block is only emitted with ≥2 columns and ≥2 rows; otherwise the lines pass through untouched. Prose is never converted.

- **Corpus scan for formatting edge cases, and the fixes.** Sampling the 607 table-bearing instruments turned up three systematic faults: (a) a hanging list marker (`(a)`, `(b)`) indented from the cell body it labels left a slim gutter on either side and looked like a column of its own, collapsing real columns into interleaved text — bands narrower than 1.2 em are now folded into the cell they label; (b) the stray-punctuation filter was far too broad and silently swallowed real content, including the `□` checkboxes in the Prevention of Pollution compliance tables and dot-leader runs, so only a lone `.` sitting *between two header cells* is dropped; (c) that same stray `.` was counted as a header column when deriving separators, which shifted a boundary and split `a platform worker` across two cells. Across a 147-file sample the only character still dropped is the intended header separator dot; everything else is preserved.

- **A visual audit against the rendered PDF found a pre-existing running-header leak, now fixed.** Rendering representative pages of the WICA PDF (`pdftoppm` + vision) and checking them against the parsed Markdown confirmed the reconstructed tables matched the source, but also exposed the page running head (`Compensation Act 2019` + page + `2020 Ed.`) leaking into the body on 78 of 162 pages — sometimes landing *inside* a table (splitting `s34C`) or between the two page-halves of a table (First Schedule `TABLE A`). The deduplicator only stripped *trailing* digits, so a page number glued between the two fixed years never collapsed to a stable key. It now folds any run of 5+ digits to `#`, and — because that is too blunt for the body (a schedule of survey coordinates like `29606.344 30301.618` collapses the same way) — only lines in the top/bottom margin of a stream are eligible. The WICA leak drops from 78 lines to 0, the repeated amendment notes (`[Act 30 of 2024 wef 01/01/2025]`) survive, the coordinate schedules are untouched, and removing the injected line recovered a table that had previously fallen back to prose (29 → 31 tables).

- **Wired in for legislation only.** `extractPdfText(buffer, { tables: true })` is used by the `parse_legislation` tool and `scripts/parse-legislation.mjs`; the judiciary pipeline and `parse_pdf` keep the default (table-free) output. Section framing is unchanged, so `legislation_embed.ipynb` reads the output as before.

- **Verified against ground truth.** Rendering the WICA PDF (`pdftoppm`, 140 dpi) and reading the pages with vision confirmed the reconstructed tables match the source: `s34B`/`s34C` column maps, `TABLE A`/`B`, the First Schedule factor table, the Second Schedule (3-column, wrapped, group rows) and the Fifth Schedule (3-column, very tall cells) all line up with `pdftotext -layout`. Regenerating the Act gives 111 sections, 31 tables and 483 pipe rows, with 0 running-header lines in the body (down from 78); the plain-vs-tables word multiset differs by 6 of 42,504 tokens (0.014%). Unit tests (`scripts/tests/tables.test.mjs`, run from `run-tests.sh` Tier 1) cover the 2-column, wrapped-cell, group-row, narrow-marker, leader-dot, checkbox, separator-dot, apostrophe, header-synthesis and prose-passthrough cases, plus a default-output guard.

## 0.0.20

  

- **The judiciary corpus was put through the same audit loop as legislation, and the shared extractor came out of it with one fix.** A 155-file stratified sample of the 10,516 parsed judgments (SGHC, SGCA, SGHCF, SGHCR and the smaller courts) was checked by character-multiset comparison of the raw `extractPdfText` output against the reflowed text: **no content is lost** — the only characters that disappear are line-break hyphens (`ocean-` / `going`) and standalone page markers, both intended. No running head/footer leaks into the body, and the case-name/citation running head is stripped. The table detector fires on 117 of the 155 judgments, but rendering those pages (`pdftoppm` + vision) shows they are all false positives on *justified* prose and footnotes (`2018_SGHC_190` alone reports 50), so the judiciary pipeline correctly stays table-free.

- **Mid-word splits in per-glyph PDFs fixed.** 16 of the 155 judgments contained spurious spaces inside words — `w ere`, `w ith`, `W ife`, `P RODUCTS` — with `2002_SGHC_162` alone producing 178. Some producers emit a real space glyph for every word gap and position each remaining glyph with its own `Td`; the extractor's word-gap test compared the `Td` advance to the last run's width and read inter-glyph kerning (up to ~0.12 em before a wide glyph like `W`) as a word space. The test now also weighs the last run's length and whether the stream emits explicit space glyphs: a single-character run in such a stream needs a 0.13 em gap, while word runs (and streams that rely on `Td` for their spaces, like the legislation PDFs) keep the 0.1 em threshold. Splits fall from 206 across 16 judgments to **0 across all 155**, with the WICA extract and a 147-file legislation sample **byte-identical** to before, and the legislation table output unchanged (111 sections, 31 tables, only the intended separator dots dropped).

- **The judiciary corpus was reparsed end to end.** `parsed_judiciary/` was regenerated from the 10,516 source PDFs — 165,256 sections, 0 errors, ~4.4 minutes across 12 shards. 2,379 files changed, all of it the space fix above; a non-space character-multiset comparison of the raw extract with the fix on versus off shows **zero** difference, so the only change is where a word boundary sits. (The handful of judgments whose section count drops by one are the repeated retrieval prefix — topics and citation — appearing one fewer time, not body text disappearing.)

## 0.0.21

  

- **Judiciary sections are now budgeted in tokens, not characters.** The chunker targeted 4,000 *characters* — about 1,000 tokens, leaving three-quarters of the embedding budget unused and, worse, letting a handful of chunks blow past the cap. It now targets **4,000 Qwen3-Embedding tokens** against the 4.3k embedding cap, measured with the model's real tokenizer rather than a heuristic. Across all 50,039 sections: **max 4,002 tokens, none over 4,300**, median 3,811, p99 3,972. The section count falls from 165,256 to 50,039 because each chunk now carries ~4× more text.

- **Two bugs had to be fixed to make that budget meaningful.**

- `STAT_REF_RE`'s trailing `\([^)]+\)` was unbounded and `[^)]` matches newlines, so a citation whose closing bracket sat far away swallowed everything in between into the "act name" — in `2023_SGHC_252` the whole table of contents (6,786 characters). That string is repeated in *every* section prefix, so 260 judgments carried 3.44M characters (~859k tokens) of duplicated junk. Bounding the parenthetical to one line fixes it; that judgment's metadata section drops from 7,031 characters to 233.

- A paragraph longer than the budget became a single unbounded chunk — the worst was a table of contents with no blank lines, 22,996 characters (~7,300 tokens). `groupByBudget` now splits an oversized paragraph at sentence ends, then word boundaries, then characters, so no chunk can overshoot.

- **API.** `buildJudgmentSections` is now async and takes `{ budget, measure }`, where `measure` may be async so a real tokenizer can be injected; `groupByCharBudget` is replaced by `groupByBudget`. The parse script loads the Qwen3 tokenizer (`tokenizers` devDependency, tokenizer fetched once into `.parser/cache/`) and falls back to the reference character budget when it is unavailable.

- **Legislation is not covered yet and needs a decision.** It is split on printed section numbers, not a budget, and 781 of 65,229 sections exceed 4,300 tokens — the worst is `Income Tax Act 1947` `s2029` at **415,843 tokens**, a cross-reference table that the splitter absorbed into the section. Those sections would be truncated to a few percent of their content by the embedder.

## 0.0.22

  

- **Legislation is now chunked to the embedding model's token budget too.** The judiciary was capped at 4,000 Qwen3 tokens in 0.0.21, but legislation was still split only on printed section numbers — and 857 sections blew past the 4,300-token embedding cap, the worst at **241,760 tokens** (the CPF (Home Protection Insurance Scheme) Regulations 2024's `s28`, a 312,007-character cross-reference table). A section larger than the budget is now split at paragraph boundaries into `sN_chunk1`, `sN_chunk2`, … and a section that fits keeps its id untouched.

- **Chunk ids are spelled out, not dotted.** `s28.68` reads like a decimal or a subsection; the chunk suffix is now the explicit `_chunkN` — `s28_chunk68`. The judiciary body ids get the same treatment, `_c0` → `_chunk0`, so the two corpora agree. Both were reparsed: legislation 68,206 sections, judiciary 50,039 (10,516 files, every one with the exact `<stem>_meta`, `<stem>_chunk0`, … sequence), 0 errors, and the judiciary token figures are unchanged (max 4,002, none over 4,300). (That does make the judiciary ids differ from the reference Python pipeline's `<slug>_cN`; the section framing and everything else still match.)

- **A mis-parse had to be fixed first.** The splitter read a wrapped year as a section start: a date breaking across a line or page (`... take effect from (and including) 1 January` / `2024.`) leaves the year alone on a line, shaped exactly like a bare section number. The year guard existed in only one of the three start patterns, so a preceding `[Deleted by ...]` set the jump allowance and `2024.` was accepted — after which every real section looked like a backward jump and was discarded, collapsing the Income Tax Act's 1,320 pages into two bogus sections (`s2024`, `s2029`). Guarding all three patterns restores the Act to its full 354 sections, and a Tier 1 regression test locks it in.

- **Splitting only ever happens at a blank line**, so a sentence, a list item and a table row are never cut in half. That is sufficient for the whole corpus: the largest blank-separated block in any legislation section is 3,025 characters, so no block ever has to be broken further.

- **Result across all 6,063 files.** 65,552 base sections → **68,206** sections (859 were split, into 3,513 chunks; the largest, CPF `s28`, into 68). Every section now measures **at most 3,997 Qwen3 tokens** — **0 over 4,000 and 0 over the 4,300 cap** (was 803 over 4,300, max 241,760). p50 203, p90 1,061, p99 3,914.

- **Losslessness is machine-checked.** Reassembling the new chunks of every base id reproduces the old section body exactly, whitespace-normalised: **65,552 of 65,552 sections, 0 mismatches, 0 missing**.

- **The budget chunker is now shared.** `groupByBudget`/`splitOversized`/`splitParagraphs`/`TextMeasure` moved from `judiciary/ingest.ts` into a new `tools/chunk.ts`, re-exported by the judiciary module so its API is unchanged; the judiciary output is byte-identical after the move (spot-checked against a 52,503-byte judgment). `scripts/parse-legislation.mjs` loads the Qwen3 tokenizer the same way `scripts/parse-judiciary.mjs` does, falling back to the 4,000-character budget when it is unavailable. The `parse_legislation` tool chunks too, at the character default, since a native tokenizer cannot be shipped into the VSIX.

- **Five new Tier 1 tests** cover the whole-section case, the `sN_chunkN` naming, the budget invariant (header included), lossless reassembly and table-row integrity.

## 0.0.23

  

- **The LaTeX math fonts in 87 legislation PDFs no longer decode to garbage.** Those instruments — the Income Tax Act 1947, the Stamp Duties Act 1929 and 85 others — embed the standard Computer Modern math faces (`TeX_CM_Maths_Symbols`, `TeX_CM_Maths_Italic`, `TeX_CM_Maths_Extension`) but ship a `/ToUnicode` CMap that is a plain ASCII identity map: glyph code N decodes to the character with code N−1, whatever the glyph actually draws. Every formula symbol therefore came out as `�` (U+FFFD) or a stray Latin-1 letter, so `50% × (A − B),` extracted as `50% � A � Bð Þ;`, and `×`, `−`, `+`, `=`, `[`, `]`, `∫`, `√` were all lost. The rendered page was always correct; only the text layer was broken, and poppler's `pdftotext` and Ghostscript's `txtwrite` reproduce it identically.

- **No OCR at runtime and no new dependency.** The fonts cannot be repaired from metadata — the embedded programs had their glyph names rewritten (code 134 is named `eth`, code 41 `parenleft`), so neither the encoding nor the CMap identifies a glyph. The glyphs were instead read off renderings: each broken font program is re-embedded into a synthetic PDF (`.parser/build-glyph-rows.mjs`), every code that occurs in the corpus is drawn and labelled, and the character it draws is recorded. The result is a small static table in the new `pdf/tex-math-fonts.ts`, applied by the extractor keyed on the font's BaseFont. Only the 47 (font, code) pairs the corpus actually uses are mapped; a code outside the table keeps its (wrong) CMap value rather than being guessed at.

- **A second bug hid behind the first: runs emitted out of visual order.** LaTeX writes the delimiters of `\left( … \right)` in a later text object than the expression between them, so `(A − B)` arrived as `A − B()`. The runs now carry a `mathFont` flag, and `renderPlainLine` moves a bracket drawn from a math font back to its x position. The correction is deliberately narrow: only brackets, and only ones that actually start left of the run before them. A general x-sort is not safe — the run x is the text-matrix origin, which a producer that draws a line with consecutive text calls and no repositioning between them leaves stale for every run but the first, and sorting on that scrambles the sentence (`the applicant'sIn any event,`) or corrupts a number (`175.14` → `17514.`). The restriction confines the fix to the LaTeX instruments: it changes 7 lines across a 304-file legislation sample, all of them correct, and **0 of 643,249 lines** across a 702-file judiciary sample, which has no math fonts.

- **Result.** Across the 87 affected files the corrupted characters fall from **1,480 U+FFFD and 1,293 stray Latin-1 letters to 0 and 9** — the worst file, the Stamp Duties Act 1929, from 556 to 0, and the Income Tax Act 1947 from 181 to 0. The nine that remain are genuine (`7½%`, `12½%`, `15½%`). The formulas now read as the page does: `50% × (A − B),`, `[(U + V) × 250%] + [(W + X) × 300%]; or`, `(A − B − C − D − E) × 50%,`.

- **Resolved fonts are memoised.** The override clones a font's CMap and the font is resolved for every string token, so without a cache a document full of math glyphs cloned a map per glyph.

- **Stacked fractions are linearised instead of being split across three lines.** A fraction is drawn as a numerator above a denominator, straddling the baseline of the surrounding text — `A` over `B` in `A/B × C`. The extractor emitted each part as its own line, because the numerator and denominator sit far enough from the baseline to trip the line-break test, and because they are set in a smaller font that test is tighter for them than for the body text. The Income Tax Act's hire-purchase formula therefore read as `A` / `B× C,` — the fraction relationship lost entirely. A new pass in `pdf/tables.ts` recognises the shape (a short, centred, symmetric pair of runs straddling a baseline that carries body text) and rewrites it as `A/B`, splicing the token into the baseline line at the fraction's x-position. It runs before both the plain and the table renderer.

- **A compound part is parenthesised, so the linear form keeps its meaning.** `A` over `B + C` would otherwise read as `A/B + C`; it is written `A/(B + C)`. A part that is already bracketed in the source (`(E + F)`) is left alone rather than double-wrapped.

- **The pass is deliberately narrow, because a fraction and a pair of stacked table cells look alike.** A table column stacks short cells at the same x, and a form stacks two labels over one baseline; both satisfy the naive geometry. The guards that separate them: the parts must be short (≤16 characters), mathematical rather than prose (no two-word phrase, no comma, no run of leader dots), contiguous (a table row's cells are spread across the page), centred on each other to within 0.3 em, symmetric about the baseline to within 0.1 em, and far enough from it (≥0.3 em) to be a fraction rather than a table's rows, which are spaced a tenth of an em apart. The baseline must sit *beside* the fraction, not under it, within an em of it, and be one line of text rather than a table row whose cells are spread across the page.

- **Inside a table block the pass does not run at all.** A badly-encoded table can stack cells so that the geometry is indistinguishable from a fraction — the Criminal Procedure Code's penalty tables produced `arrest/Court`, `or/to`, `OFFENCES/no`. `renderTables` now detects its blocks first and confines the fraction pass to the prose between them. Only blocks that actually render as tables are excluded, so a block the detector rejects still gets its fractions linearised.

- **A corpus scan of the 523 principal Acts found 182 fractions, all genuine** — `A/B`, `D/(E + F)`, `A/365`, `6 2/3%`, `(A + B)/2`, `A/(B − C − D − E) × 100%`, `A + A/B × 150% × C × D` — with the false positives it was tuned against (`employees of`/`members of`, `Returning`/`Officer`, `...`/`...`, superscript footnote markers `11`/`12`, stacked table cells `3`/`7`) all rejected. The Income Tax Act alone gains 40 fractions that were previously unreadable, including the body-sized ones (`A/B`, `A/20%`, `A/(B + C)`, `A/B × 12`) that the first cut of the pass missed.

- **A line that receives a token is re-spaced from its geometry.** The extractor normally bakes the word spacing into each run's text, but once the denominator is lifted out of the middle of a line that spacing no longer holds, so a touched line is re-sorted by x and joined with a gap test (with a guard against a space before closing punctuation, since a fraction bar is wider than the digits it spans). Twelve new Tier 1 tests cover the fraction shapes and every false positive above.

- **Schedules are now their own sections instead of being swallowed by the last one.** The splitter stopped at the first Schedule heading, so every Schedule's content was appended to the body of the last numbered section — in the Income Tax Act 1947, `s108` was **145,890 characters** and held all twelve Schedules, with `FIRST SCHEDULE` sitting inside `s108_chunk1`. A scan of the corpus found this in **281 of the 523 principal Acts — every Act that has a Schedule**. Each Schedule is now emitted as its own section, `schedule1` … `schedule12` (or `schedule` for a bare `THE SCHEDULE`), in a namespace that cannot collide with `sN`. The Income Tax Act's `s108` drops to its real **860 characters**, and the twelve Schedules become retrievable units of their own.

- **The protection the old `break` provided is kept.** It existed because a Schedule restarts numbering at 1, so its rows (`1. Foo`, `2. Bar`) look exactly like section starts — the reference Python pipeline counts them as sections, which is why it reports 112 sections for `Animals and Birds (Disease) Notification` against our 2. Once a Schedule heading is seen, section detection is suppressed until the next Schedule heading, so a row can never become `sN`; the Schedule is one section and its rows are its body. A page-break continuation (`FIRST SCHEDULE — continued`) does not open a second section, and the Arrangement of Sections' `First Schedule — …` entry does not open one at all.

- **A wrapped Schedule heading is recognised too.** A wide heading font breaks `FIRST SCHEDULE` across two lines — the Central Provident Fund Act 1953 sets it as `FIRST` / `SCHEDULE`, and its page-break continuation as `FIRST` / `SCHEDULE` / `—` / `continued`. The bare `SCHEDULE` line then failed the standalone-heading test, because the line above it (`FIRST`) does not end a sentence, so that Act's four Schedules were still swallowed. The ordinal is now read from the line above when the heading has wrapped.

- **Eleven new Tier 1 tests** cover the Schedule id scheme, the last section no longer swallowing the Schedule, numbered and bare Schedules, Schedule-only instruments, the `— continued` heading, the TOC entry, Schedule rows not becoming sections, the wrapped heading, and `scheduleN_chunkK` chunking.

- **Parts, Schedules and appendices are now `#` headings.** A Part is a divider, not a retrievable unit — it has no body of its own, only a title and the sections under it — so it does not become a section id. It is rendered as `# PART 21 — MISCELLANEOUS` *above* the `## [sN]` marker of the section it introduces, and the bare `PART 21` line is stripped from the section it used to trail. A Schedule and an appendix are top-level divisions too, so each carries `# FIRST SCHEDULE` / `# LEGISLATIVE HISTORY` above its marker; the Schedule heading is reconstructed from the ordinal, so a wrapped heading (`FIRST` / `SCHEDULE`) and a page-break continuation (`FIRST SCHEDULE — continued`) both render as one clean line. Sections stay at `##`, which is what the embed step parses, so the framing is unchanged. The Income Tax Act's 23 Parts (`PART 1` … `PART 21`, including `20A` and `20B`) are all captured, with a title wrapped over two or three lines joined into one heading. A `PART A` / `PART 1` *inside* a Schedule divides the Schedule, not the Act, so it is not promoted. When a section chunks, the heading is carried onto the first chunk only, so it is never duplicated.

- **The three appendices are now their own sections.** `LEGISLATIVE HISTORY`, `Abbreviations` and `COMPARATIVE TABLE` were falling inside `schedule12_chunk1` … `chunk8` — the Arrangement of Sections lists them as top-level entries beside the Schedules, so they are emitted as `legislative_history`, `abbreviations` and `comparative_table`. The Income Tax Act's `schedule12` drops from 64,173 characters to its real 927, and the 58,995-character Legislative History becomes a retrievable unit of its own.

- **A PDF whose appendix pages are interleaved with body pages is left alone.** Two Acts (the Intestate Succession Act 1967, the Unfair Contract Terms Act 1977) have their appendix pages physically inserted mid-document, so the body repeats after them. Opening an appendix section there would attribute the trailing body to the appendix, so an appendix heading is only honoured when no body section repeats after it. Those two Acts keep their appendices in the body, which is where they were before; the other 521 are unaffected.

- **The Legislative History's own entries no longer become sections.** Its entries are numbered (`5. G.N. No. S 344/1995 — …`), so they look exactly like section starts. Once an appendix opens, section detection stops — the appendices are the document tail. The Statutory Corporations (Contributions to Consolidated Fund) Act 1989 was emitting phantom `s5` and `s6` after its `legislative_history`, splitting the appendix in two.

- **A section start inside a reconstructed table cell is recognised.** A garbled table row (`| 7.—(1) A person must not — | |`) hid section 7 of the Private Security Industry Act 2007. Because the number sequence then jumped from 6 to 8, every later section was dropped as well — the Act reported 10 sections instead of 50. The section-start patterns now skip a leading table pipe.

- **A section's title is now carried on its marker line.** The title sits immediately above the section number in the PDF, so it was falling at the end of the *previous* section's body — the Immigration Act 1959's `Power to detain stolen vehicle within authorised area, etc.` trailed `s51AB` while `s51AC` opened with the bare number. The title is now lifted onto the marker (`## [s51AC] Power to detain stolen vehicle within authorised area, etc.`) and dropped from the body. A title ending in an abbreviation (`etc.`, `e.g.`, `No.`) is recognised as a title rather than a sentence, and a division marker (`CHAPTER 1`) with the division title above it (`PRELIMINARY`) is not absorbed into the section title. The title is carried onto the first chunk only, so a chunked section never repeats it.

- **A wrapped title is joined, including one whose continuation starts lower case.** The Immigration Act 1959's `s36C` title wraps over two lines with a page break between them (`Accessing or disclosing identifying information, crew` / blank / `information or passenger information`), and the continuation starts lower case, so it failed the heading test and only the second half was captured. A lower-case line is now accepted as a title continuation when the nearest non-blank line above it is a heading that does not end a sentence — which is exactly the shape a wrapped title has, and not the shape of body text, where a lower-case line follows a sentence end.

- **Thirteen new Tier 1 tests** cover the `#` Part heading being rendered above the section marker, the heading not being repeated or left trailing, a wrapped Part title, the heading being carried onto the first chunk only, a Part inside a Schedule not being promoted, the Schedule and appendix `#` headings, a bare `THE SCHEDULE`, a wrapped Schedule heading, a Schedule continuation, the appendices becoming sections, the last Schedule not swallowing them, the Legislative History entries not becoming sections, a section start inside a table cell, and the interleaved-PDF guard. Five more cover the section title: lifted onto the marker, an abbreviation ending, a division heading not absorbed, a wrapped title, and the title carried onto the first chunk only. Two more cover the wrapped title with a lower-case continuation and a lower-case body line not being absorbed.

0.0.39


- **Fixes the legislation parser's formulas, tables and headings.** Three separate defects surfaced by scrolling the parsed corpus; all are fixed in `packages/agent/src/backend/tools/pdf/tables.ts`, `tex-math-fonts.ts`, `extract.ts` and `legislation/split.ts`.

- **Math-font glyphs.** `TeX_CM_Maths_Extension` codes 49/50 were mapped to the radical but draw the large-parenthesis hooks, 105/106 were mapped to `∫`/`∮` but draw the large square-bracket pieces, and 113/114/116/130 are the radical. Display formulas such as the ITA hire-purchase formula and the Energy Conservation `[√(D² + E²) ÷ F] × 100` now read as brackets and radicals instead of `⎩⎧⎨⎫` pieces.

- **Stretchy delimiters and radicals.** A frame drawn from stacked delimiter glyphs is collapsed onto one line — both around a stacked fraction and around a wrapped phrase (its brackets land on the phrase's first and last lines, and a stretchy piece pairs with a literal bracket) — and a radical drawn as a root glyph plus a repeated overbar becomes `√(…)` with its superscripts merged (`d = 25 + 1.68 √(L(B + D))`). The collapse now runs inside a table cell too, so the hire-purchase formula no longer leaves pieces in a pipe table.

- **Hidden overlays.** Text drawn below 1pt — a duplicate line some producers keep for search or accessibility — is dropped at extraction instead of being rebuilt as a garbled formula (the Merchant Shipping `K = √((θmax − θe)/(θmax − θmin))` block).

- **Table columns.** `detectColumns` keeps its grid sweep, but when one row's overflowing cell closes a column's gutter the rows' own cell splits recover the boundary, so the Merchant Shipping damage-extent table renders as three columns instead of two merged ones.

- **Legislation headings.** A Part that no numbered section opens was overwritten by the next Part, so only the last survived (the Safety Convention Regulations kept just `PART B` out of 37 Parts). Each Part is now emitted as its own section, hyphenated sub-numbers (`PART B-1`, `PART A-1`) and same-line or wrapped Part titles are recognised, a Schedule is split at its own divisions (`PART`/`CHAPTER`/`TABLE`/`APPENDIX`, each with a Schedule-scoped id), and a Schedule or appendix heading is no longer repeated as the first body line.

- **Verified by regenerating all 6063 documents.** Headings duplicated in the body fall from 6053 to 0, 460 files gain `#` headings and none lose any, sections over 8 chunks fall from 49 to 39 (the CPF Home Protection Insurance First Schedule's worst section drops from 52 chunks to 6), and a body-text diff finds no lost content.

- **Tests:** `scripts/tests/tables.test.mjs` gained the radical, literal-bracket, framed-fraction and narrow-column cases; `scripts/tests/legislation-split.test.mjs` gained the hyphenated, same-line, wrapped, division-heading and divider-section cases.

- Bumps root and extension package.json to 0.0.39.

## Latest — 0.0.40

  

- **Fixes the Schedule headings the chunk-count scan turned up.** A structural verifier (`scripts/verify-leg-structure.py`) now walks the parsed corpus and flags a Schedule ordinal out of sequence and a division heading that repeats with nothing between the two occurrences — the symptom that made the CPF Home Protection Insurance Regulations' First Schedule split into 52 chunks and jump from `FIRST SCHEDULE` to `THIRD SCHEDULE`. Run it as `scripts/verify-leg-structure.py [corpus-root]` (default `$VERIFY_ROOT` or `parsed_legislation_full/2026-05-30`); `--show <file>` prints one file's findings, `--list <file>` writes the flagged paths.

- **A Schedule heading that follows a table row is recognised.** A Schedule that opens on the page below its predecessor's last table row arrives with no blank line between them (`| 60 102.62 | 102.62 |` / `SECOND SCHEDULE`); the line above is a pipe row, which is not a wrapped title continuation.

- **A title-case marginal note no longer opens a Schedule.** `SCHEDULE_RE` was case-insensitive, so the marginal note beside section 76 of the Medicines Act (`Second Schedule`, title case, on its own line between subsections) opened a phantom second Schedule, swallowed section 76's body and put `SECOND SCHEDULE` before `FIRST SCHEDULE`. A Schedule heading is set in caps.

- **A Schedule heading with no blank line above it is recognised.** When the last body line of the previous Schedule runs straight into the next heading (`Zuclopenthixol; its salts` / `SECOND SCHEDULE`), the heading carries its own ordinal and so cannot be a wrapped title continuation; the standalone check is only needed for a bare `SCHEDULE` or a wrapped `FIRST` / `SCHEDULE`.

- **A division heading printed twice is one division.** The Platform Work Associations Regulations print `PART 4` as a stub and then `PART 4 — AUDITOR'S DECLARATION`; the stub is skipped when the next non-blank line is the same division.

- **A larger-font all-caps heading closes the table above it.** The Estate Duty Act's Second Schedule opens on the page below the First Schedule's last rate row; its heading is set 13pt against the table's 11pt, so it ends the table instead of joining it as a group row.

- **Verified by regenerating all 6063 documents.** The structural verifier's findings fall from 32 files (37 out-of-sequence ordinals, 2 duplicate divisions) to 11 files (12 out-of-sequence ordinals) — and the 12 that remain are the source PDFs themselves, which print no heading for the ordinal they skip (`Plant Varieties Protection Rules` prints only `SECOND` and `FIFTH`, `Planning (Changes in Use — Lodgment Authorisation) Notification` only `FIRST`/`SECOND`/`THIRD`/`SIXTH`).

- **Tests:** `scripts/tests/legislation-split.test.mjs` gained the table-row-Schedule, title-case-marginal-note, no-blank-line-Schedule and repeated-division cases; `scripts/tests/tables.test.mjs` gained the larger-font heading case.

- Bumps root and extension package.json to 0.0.40.

0.0.41

- **Extends the sequential-ordinal check from Schedules to sections.** `scripts/verify-leg-structure.py` now walks every `## [sN]` marker as well and reports a section number that repeats, steps backwards, or skips a number the printed text does not account for — the same 1, 2, 3 … idea already applied to `FIRST`/`SECOND`/`THIRD SCHEDULE`. The sequence is scoped to the Part a section sits under and to whether the id is Act-wide (`s12`) or Part-local (`s3_12`), because a Part that restarts its numbering legitimately starts again at 1, and a long section split into `_chunkN` pieces is one section, not a repeat. A skip is only a finding when nothing between the two sections explains it: the AGC prints a repealed range as a single entry (`43. to 56. [Repealed by S 236/2002]`) or notes the omission in prose (`[Ther e are no sections 244 and 245.]`). This is what surfaced the two defects below.

- **A section number split across two lines is joined.** The Housing and Development (Polling for Upgrading Works) Rules print section 33 as a lone `3` on one line above `3.—(1) The results of a primary poll …`; the fragment was left in the previous section's body and section 33 was swallowed by section 32. The fragment is now joined back onto the number below it when it is the leading digits of that number.

- **A section gap the Arrangement of Sections declares is bridged.** A forward jump is normally a wrapped cross-reference rather than a section (`… section 16, 17 or` / `18 — the …`), so it is rejected; but when the Arrangement lists the number and the number is set tight against its dash (`11.—(1)`, which the wrapped form is not) the section is real. The Securities and Futures (Licensing and Conduct of Business) Regulations were stepping from `9A` straight to `13` because sections 11 and 12 (and 11A–11C) were swallowed; the Penal Code was losing `255` and `489A`, the Singapore Armed Forces (Pensions) Regulations misnumbered `66`–`68`, and the Unfair Contract Terms Act's `PART 2` swallowed sections 26–30.

- **Verified by regenerating all 6063 documents.** Only 5 documents change (10 files including the audit JSONs), each adding the sections it had lost and removing none; the structural verifier's findings fall from 16 files to 15, the remaining gap being `s9A -> s11` in the Licensing Regulations, where the source genuinely has no section 10.

- **Tests:** `scripts/tests/legislation-split.test.mjs` gained the split-number and Arrangement-declared-gap cases.

- Bumps root and extension package.json to 0.0.41.

0.0.42

- **Fixes the dropped last line of every page.** A text object that declares its own position (`sawPosition`) is not flushed on `ET` — the flush is deferred until the next run's y-position differs — so a stream whose last text object declares a position and is followed by no further text lost its final line. The end-of-stream flush was also gated on `inText`, which `ET` had already cleared, so the page's last line was discarded even when it was real content. The flush is now unconditional (`flushLine` is a no-op on an empty buffer). This is what dropped the Legislative History's `Date of operation : 25 March 1992` from the Deduction of Income Tax (Employments) Rules.

- **Strips the SSO running footer the fix surfaced.** With the last line recovered, the Singapore Statutes Online footer `Informal Consolidation – version in force from <date>` leaked into 1,056 files and was absorbed into 96 section titles. The header/footer dedup now runs for two-page documents (was three), with a threshold of `max(2, ceil(pages × 0.30))`, and a targeted filter drops the known SSO footer unconditionally — which catches single-page instruments and multi-page ones where only the first page carries it.

- **Adds a golden-corpus regression gate.** `scripts/tests/legislation-regression.test.mjs` re-parses the corpus and compares each file's fingerprint (`lines`, `chars`, `sections`, `setHash`) against a committed baseline (`scripts/tests/fixtures/legislation-baseline.json`, 6,063 files). It fails when a file loses lines, characters or sections — the class of silent content loss that shipped the two defects above — and reports a same-length rewrite as *changed* for review. It skips cleanly when the gitignored corpus is absent, and runs as a Tier 1 step in `scripts/run-tests.sh`. Refresh the baseline deliberately with `scripts/tests/update-legislation-baseline.mjs --force` after an intended change.

- **Verified by regenerating all 6063 documents.** 3,983 files change: +22,757 lines, −7,556 lines, the removals being the SSO footer, `— continued` page markers and edition running heads. Section markers rise from 79,784 to 80,532 as recovered last lines let the splitter find sections it had collapsed (the Administration of Muslim Law (Mosque Building and Mendaki Fund) Rules go from `s1`–`s3` to `s1`–`s24`). No file is lost or gained, and the audit warnings stay at zero.

- **Tests:** `scripts/tests/tables.test.mjs` gained the last-line-of-stream and short-document-footer cases.

- Bumps root and extension package.json to 0.0.42.

0.0.43
  
- **Decodes the Monotype `AdvP4C4E*` math glyphs.** A subset of the AGC legislation PDFs typesets their mathematical operators and parentheses in three embedded CFF symbol fonts (`AdvP4C4E74`, `AdvP4C4E46`, `AdvP4C4E51`) whose name table is broken: the `/ToUnicode` is a byte-identity map and the `/Differences` names do not describe the outlines — the glyph named `eth` draws `(`, `thorn` draws `+`, `onehalf` draws `[`, and the operator glyphs carry bare subset labels (`C0`, `C2`, `C138`) that resolve to nothing. The extractor trusted the names, so formulas decoded to `ð`/`Þ`/`þ`/`¼` or silently lost their operators (`A − (B/(120 − C)) × A` became `A` / `B` / `120 C` / `A;`). `tex-math-fonts.ts` gains two override tables applied through the existing `applyTexMathGlyphs` hook: `SYMBOL_FONT_GLYPHS`, keyed by `(BaseFont, glyphName)` because the subset remaps codes per document but the label a glyph carries is stable, and `SYMBOL_FONT_CODES`, keyed by `(BaseFont, code)` for the `AdvP4C4E74` subsets that omit `/Differences` and declare only `/WinAnsiEncoding` (standard Adobe codes `222`/`240`/`254`). The code-keyed table is suppressed when a `/Differences` array is present, since that array remaps the codes and its names are authoritative. The mapping was read off empirically by re-embedding each CFF subset and rendering one glyph per row (`scripts/build-cff-glyph-sheet.mjs`).

- **Adds a formula-parsing ratchet.** `scripts/tests/unparsed-formulas.test.mjs` scans the corpus for the three symbol fonts, fails when a *new* file is flagged, and reports (without failing) when a known file is no longer flagged. It is keyed on the font scan rather than the output text, so it is stable with or without the parsed corpus, and runs as a Tier 1 step in `scripts/run-tests.sh`. The known-affected set (50 files) is committed at `scripts/tests/fixtures/unparsed-formulas-baseline.json`.

- **Verified by regenerating all 6063 documents.** The corpus check's `visible corrupt` count falls from 27 to 0 and no `ð`/`Þ`/`þ` remains anywhere. The golden-corpus gate reports 49 changed files; the 10 it flags as "loss" were each confirmed to be blank-line removal plus formula lines joining, not content loss, and the baseline was refreshed deliberately (+16 lines, +0 sections). The only residual `digit;digit` match is `Banking Act 1970` (`person2022.2022;1970`), which uses no `Adv` fonts and is a pre-existing table/column-ordering issue, out of scope here.

- **Tests:** `scripts/tests/tables.test.mjs` gained the symbol-font name/code override cases and corpus-dependent assertions for the Hire-Purchase, COVID-19 and WinAnsi-only E74 formulas.

- Bumps root and extension package.json to 0.0.43.

## 0.0.44

  

- **Reflows wrapped PDF lines into paragraphs.** `extractPdfText` emits one line per visual line of the PDF and `splitLegislationSections` shipped those breaks straight into the Markdown, so a sentence regularly arrived split across two, three or four lines (`In this Act, unless the subject or context otherwise` / `requires —`). A new pass, `reflowLegislationBody` (`packages/agent/src/backend/tools/legislation/reflow.ts`), joins each section body back into paragraphs before chunking: a paragraph, a list item, a heading and a table row each become one line, and blocks are separated by blank lines. It runs in both body-assembly branches and the `whole_doc` fallback, so `s.text` is canonical for the `parse_legislation` tool, the chunker and the renderer. The judiciary pipeline has the equivalent pass (`reflowParagraphs`).

- **The joins are structure-aware.** Wrapped lines join with one space; a line ending in a hyphen joins without one, keeping the hyphen (`non-` + `compliance` → `non-compliance`). The reflow never joins across a heading (`PART 1`, `SECTION I`, `OTHER APPROPRIATE REVIEWERS`), a pipe-table row, a closed amendment citation (`[Act 30 of 2023 wef …]`) or an edition page footer (`[2024 Ed. p. 1`), and it does not glue a heading onto the prose after it. A blank line is a paragraph break only when the line above ends a sentence (`.`, `?`, `!`, `;`, `:`, with a trailing-abbreviation exception for `No.`, `s.`, `etc.`); a blank-split mid-sentence wrap is rejoined, which recovers the continuations that start with a lower-case word or a proper noun (`… the Accounting and Corporate` / `Regulatory Authority Act 2004;`). An unclosed bracket line is a wrapped form instruction or legislative-history row, so its continuation joins it (`[Specify … if no` / `conditions … specified.]`). A single-letter line (`T` / `rustee`) and a quoted all-caps fragment (`“SINGAPORE”`) join as prose rather than standing as headings.

- **Verified by regenerating all 6063 documents.** Soft wraps fall from 1,350,583 (53% of body lines) to 592 (0.1%), mid-sentence wraps from 1,209,421 to 162, and hyphen line-breaks from 2,247 to 0; the corpus drops from 3,916,084 to 2,263,079 lines. A whitespace-stripped diff over every file confirms the reflow only moves whitespace — no word is added or lost — and the structural verifier stays at its 10 known source-PDF findings. The golden baseline was refreshed deliberately (−145,971 lines, +0 sections) and the regression gate re-parses all 6063 files with 0 changed and 0 loss.

- **Tests:** new `scripts/tests/legislation-reflow.test.mjs` (30 checks: adjacent and blank-split joins, hyphen joins, list/numbered rows, citations, closed vs unclosed brackets, all-caps and division headings, drop caps, quoted fragments, pipe tables, idempotence, and a word-sequence equality check); `legislation-split.test.mjs` gained a `whole_doc` reflow case; `scripts/run-tests.sh` gained the reflow step.

- **Known leftovers:** a word split by a drop cap or letter-spaced text joins with a space (`T otal W ages`) — a reflow pass cannot reconstruct the word without layout data; the `sso_title` frontmatter still carries the index's own line breaks (metadata, not section text).

- Bumps root and extension package.json to 0.0.44.


0.0.50


- **Every chunker now measures in Qwen3 tokens at a 1,024-token budget; the character budget is gone.** A new `packages/agent/src/backend/tools/token-budget.ts` is the single source: `EMBEDDING_TOKEN_BUDGET = 1024` and `loadEmbeddingMeasure(roots)`, which loads the Qwen3 tokenizer (JSON cached under `<root>/.parser/cache/qwen3-tokenizer.json`, fetched from HuggingFace on first use) and resolves the native `tokenizers` binding from the caller's node_modules at runtime — the VSIX still ships no native module. Both parse scripts, the golden-baseline helper and the live tools call it; there is no character fallback any more — when the tokenizer is unavailable the parse (or the tool call) fails with an actionable error instead of silently chunking by character count. The parse scripts' default budget drops from 4,000 tokens to 1,024.

- **The live `parse_legislation` and `parse_judiciary` tools tokenize now too.** They previously chunked at the character default (`chunkLegislationSections` / `buildJudgmentSections` with no measure, 4,000 chars); both now pass `{ budget: EMBEDDING_TOKEN_BUDGET, measure }`, so a chunk's size is a real cap in the embedding model's unit. `DEFAULT_CHUNK_BUDGET` is 1,024 (was 4,000 characters) and the judiciary `CHUNK_TARGET_CHARS` export is deleted. The chunkers stay unit-agnostic — the reference-baseline tests still measure in characters — but no production path reaches the character default.

- **Both corpora were regenerated at 1,024 tokens and verified with the Qwen3 tokenizer.** Legislation: 6,063 files, 92,378 pieces (18,336 `_chunkN`), content-identical to the 4,000-token corpus, 0 errors; the worst piece is 1,136 tokens (a Schedule heading the header reservation does not count) and none exceed the 1,200-token serving window. Judiciary: 10,516 files, 178,788 pieces, 0 errors, max 1,035 tokens, 0 over 1,200. The judiciary corpus also picks up the Oct 7/8 extractor fixes (recovered page lines and footnotes).

- **The golden baseline was refreshed deliberately** from the regenerated corpus (+51,492 lines, +11,832 sections over 6,063 files) and the regression gate re-parses the corpus against it.

- Bumps root and extension package.json to 0.0.50.


## 0.0.51

- **A Division and a Subdivision are headings now, not body text.** The corpus prints a Part's Divisions as a standalone line (`Division 2 — Powers`) between the Part title and the first section it covers, and — inside a Division — its Subdivisions (`Subdivision (1) — Works`); the splitter left both glued to a section body. `Division 1 — Incorporation 17.—(1) …` opened s17 of the Companies Act 1967, and `Division 2 — Powers` trailed s22. `splitLegislationSections` now recognises both headings, holds them like a Part, and attaches them to the section they introduce; `renderLegislationMarkdown` emits the whole divider chain on one `#` line — `# PART 10 — DISSOLUTION — Division 4 — Provisions applicable to every mode of winding up — Subdivision (5) — Dissolution` — above the `## [sN]` marker, so the PART / Division / Subdivision / section hierarchy survives into the Markdown as a single heading that names every level. A divider is a `#` heading like a Part, not a `##` one: `##` is the section marker the embed step parses (`## [sN]`), so a divider must not use it. The section marker stays `## [sN]`, so the embed step's `read_md_chunks` is unchanged. Each Division repeats its Part and each Subdivision repeats its Division, even when those headings were claimed by an earlier section — the Part and the Division are remembered separately from the pending ones and carried on the section that opens the divider (`divisionPart`, `subdivisionDivision`).

- **A divider heading is only honoured when a section follows it.** The "Division into Parts" table of contents lists every Division as body text, and an entry is shaped exactly like a heading; its next line is the range it covers (`sections 23‑41C, 42A.`), where a real heading is followed by the section title it introduces. A heading that no section claims within 20 lines is a table-of-contents entry or a stub, and stays in the body. A bare `Division N` / `Subdivision N` line is a wrapped title's tail, not a heading.

- **A wrapped divider title is joined by position, not by shape.** The divider's title and the title of the section it introduces both sit between the heading and the section number, and the section's title is always the last of them — so every other title line belongs to the divider. The region ends at the section start, or at the next divider heading when one comes first (`Division 2 — Regulation of Licensed` / `Trade Repositories` / `Subdivision (1) — …` — the whole region is the Division's title, because the section title sits below the Subdivision heading); a page break can leave a blank line inside the title. This replaces the earlier per-line heuristic (lower-case continuation, function-word tail, citation or subdivision lookahead), which truncated `Division 3 — Regulation of Licensed` and pushed `Foreign Trade Repositories General obligations` into the section title, and which could not see a title continued across a blank line (`Subdivision (3) — Disabling access to` / blank / `flagrantly infringing online locations`). The title-case forms are also reflow barriers, so an unclaimed heading does not absorb the line below it.

- Tests: twelve new cases in `scripts/tests/legislation-split.test.mjs` — the Division above the marker (including the second Division naming its Part), the Part's own section before its first Division, the table-of-contents entry, the stub, the wrapped title ending in `Division N`, the upper-case continuation before a citation, the function-word continuation, the subdivision continuation, the citation between the heading and the title, the Subdivision above the marker (including the full four-level line), the Subdivision naming its Part and Division, the Subdivision table-of-contents entry, the wrapped Subdivision title, the bare-numbered `Subdivision N`, the bare `Subdivision N` stub, the Subdivision stub, the title-case continuation, the wrapped section title with a title-case tail, and the title wrapping across a blank line — and the two existing Division cases updated (the wrapped title and the repealed Division).

- The full corpus was regenerated (6,063 files, 0 errors) and the golden baseline refreshed; the regression gate passes with 0 losses.

- Bumps root and extension package.json to 0.0.51.