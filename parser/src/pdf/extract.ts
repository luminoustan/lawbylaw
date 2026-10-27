/**
 * Minimal PDF text extraction — no external dependencies.
 *
 * Handles FlateDecode-compressed streams via Node's built-in zlib.
 *
 * Text extraction strategy:
 *
 *   1. Parse the PDF cross-reference table to get exact byte offsets for all
 *      objects (works for traditional xref tables; PDF 1.4 and 1.5 with
 *      table-form xref).
 *
 *   2. Build a glyph→Unicode CMap for every font that carries a /ToUnicode
 *      stream.  Supports both uncompressed and FlateDecode CMap streams.
 *      Parses beginbfchar and beginbfrange blocks (including explicit-array
 *      ranges).
 *
 *   3. Track the active font (via the Tf operator) and font resource dict so
 *      that every string token is decoded with the right CMap.
 *      − Type0 CID fonts (Identity-H): hex strings like <0001 0002> and literal
 *        strings with 2-byte glyph IDs are decoded via the ToUnicode table.
 *      − Standard fonts (no CMap): Latin-1 byte-to-char pass-through.
 *
 *   4. Within each BT block, track the text-matrix y-position (Tm/Td/TD/T*
 *      operators).  Consecutive text calls whose y hasn't shifted by more than
 *      half the font size are joined on the same line; genuine line breaks emit
 *      a \n.
 *
 *   5. After extracting all page streams, deduplicate lines that repeat across
 *      ≥30 % of streams (page headers / footers / watermarks).
 *
 * Limitations:
 *   − Does not track the graphics-state CTM (cm operator).  Text from adjacent
 *     BT blocks that are on the same visual line but different cm contexts will
 *     appear on separate output lines.
 *   − PDF xref streams (PDF 1.5 compressed cross-references) are not parsed;
 *     the CMap/font lookups fall back to a regex scan in that case.
 *   − PDFs with custom font encodings beyond Identity-H may yield partial text.
 */

import * as zlib from "node:zlib"
import { renderPlainLine, renderPlainText, renderTables, type TextLine, type TextRun } from "./tables.ts"
import { applyTexMathGlyphs, isTexMathFont, symbolGlyphName } from "./tex-math-fonts.ts"

// ─── WinAnsiEncoding → Unicode ───────────────────────────────────────────────
//
// WinAnsiEncoding (PDF's name for Windows code page 1252) agrees with Latin-1
// for 0x00–0x7F and 0xA0–0xFF, but the 0x80–0x9F range holds printable
// punctuation (curly quotes, dashes, ellipsis, …) instead of C1 control codes.
// Fonts that declare /Encoding /WinAnsiEncoding emit those bytes directly, so
// without this table they surface as raw control characters in the output.
const WINANSI_HIGH: Record<number, string> = {
  0x80: "\u20AC", // €  euro
  0x82: "\u201A", // ‚  single low-9 quote
  0x83: "\u0192", // ƒ  florin
  0x84: "\u201E", // „  double low-9 quote
  0x85: "\u2026", // …  ellipsis
  0x86: "\u2020", // †  dagger
  0x87: "\u2021", // ‡  double dagger
  0x88: "\u02C6", // ˆ  circumflex
  0x89: "\u2030", // ‰  per mille
  0x8A: "\u0160", // Š  S caron
  0x8B: "\u2039", // ‹  single left angle quote
  0x8C: "\u0152", // Œ  OE ligature
  0x8E: "\u017D", // Ž  Z caron
  0x91: "\u2018", // '  left single quote
  0x92: "\u2019", // '  right single quote
  0x93: "\u201C", // "  left double quote
  0x94: "\u201D", // "  right double quote
  0x95: "\u2022", // •  bullet
  0x96: "\u2013", // –  en dash
  0x97: "\u2014", // —  em dash
  0x98: "\u02DC", // ˜  small tilde
  0x99: "\u2122", // ™  trade mark
  0x9A: "\u0161", // š  s caron
  0x9B: "\u203A", // ›  single right angle quote
  0x9C: "\u0153", // œ  oe ligature
  0x9E: "\u017E", // ž  z caron
  0x9F: "\u0178", // Ÿ  Y diaeresis
}

/**
 * Map a Latin-1-decoded string through WinAnsiEncoding.  Only the 0x80–0x9F
 * range differs from Latin-1; undefined slots (0x81, 0x8D, 0x8F, 0x90, 0x9D)
 * are left as-is.
 */
function applyWinAnsi(s: string): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    const mapped = code >= 0x80 && code <= 0x9f ? WINANSI_HIGH[code] : undefined
    out += mapped ?? s[i]
  }
  return out
}

// ─── Adobe glyph names → Unicode ─────────────────────────────────────────────
//
// Fonts may override their encoding with a /Differences array that maps byte
// codes to glyph *names* (e.g. [1 /T /h /i /r /d]).  To recover the text we need
// to turn those names back into characters.  This covers the standard Latin
// glyph set plus the punctuation names that appear in practice; anything not
// listed falls back to the literal name (better than dropping the glyph).
const GLYPH_NAMES: Record<string, string> = {
  // Single-letter names (Adobe convention: /A → "A", /a → "a")
  A: "A", B: "B", C: "C", D: "D", E: "E", F: "F", G: "G", H: "H",
  I: "I", J: "J", K: "K", L: "L", M: "M", N: "N", O: "O", P: "P",
  Q: "Q", R: "R", S: "S", T: "T", U: "U", V: "V", W: "W", X: "X",
  Y: "Y", Z: "Z",
  a: "a", b: "b", c: "c", d: "d", e: "e", f: "f", g: "g", h: "h",
  i: "i", j: "j", k: "k", l: "l", m: "m", n: "n", o: "o", p: "p",
  q: "q", r: "r", s: "s", t: "t", u: "u", v: "v", w: "w", x: "x",
  y: "y", z: "z",
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$",
  percent: "%", ampersand: "&", quotesingle: "'", quoteright: "\u2019",
  quoteleft: "\u2018", quotedblleft: "\u201C", quotedblright: "\u201D",
  parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",",
  hyphen: "-", period: ".", slash: "/", zero: "0", one: "1", two: "2",
  three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8",
  nine: "9", colon: ":", semicolon: ";", less: "<", equal: "=",
  greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\",
  bracketright: "]", asciicircum: "^", underscore: "_", grave: "`",
  braceleft: "{", bar: "|", braceright: "}", asciitilde: "~",
  exclamdown: "\u00A1", cent: "\u00A2", sterling: "\u00A3", currency: "\u00A4",
  yen: "\u00A5", brokenbar: "\u00A6", section: "\u00A7", dieresis: "\u00A8",
  copyright: "\u00A9", ordfeminine: "\u00AA", guillemotleft: "\u00AB",
  logicalnot: "\u00AC", registered: "\u00AE", macron: "\u00AF",
  degree: "\u00B0", plusminus: "\u00B1", twosuperior: "\u00B2",
  threesuperior: "\u00B3", acute: "\u00B4", mu: "\u00B5", paragraph: "\u00B6",
  periodcentered: "\u00B7", cedilla: "\u00B8", onesuperior: "\u00B9",
  ordmasculine: "\u00BA", guillemotright: "\u00BB", onequarter: "\u00BC",
  onehalf: "\u00BD", threequarters: "\u00BE", questiondown: "\u00BF",
  Agrave: "\u00C0", Aacute: "\u00C1", Acircumflex: "\u00C2", Atilde: "\u00C3",
  Adieresis: "\u00C4", Aring: "\u00C5", AE: "\u00C6", Ccedilla: "\u00C7",
  Egrave: "\u00C8", Eacute: "\u00C9", Ecircumflex: "\u00CA", Edieresis: "\u00CB",
  Igrave: "\u00CC", Iacute: "\u00CD", Icircumflex: "\u00CE", Idieresis: "\u00CF",
  Eth: "\u00D0", Ntilde: "\u00D1", Ograve: "\u00D2", Oacute: "\u00D3",
  Ocircumflex: "\u00D4", Otilde: "\u00D5", Odieresis: "\u00D6", multiply: "\u00D7",
  Oslash: "\u00D8", Ugrave: "\u00D9", Uacute: "\u00DA", Ucircumflex: "\u00DB",
  Udieresis: "\u00DC", Yacute: "\u00DD", Thorn: "\u00DE", germandbls: "\u00DF",
  agrave: "\u00E0", aacute: "\u00E1", acircumflex: "\u00E2", atilde: "\u00E3",
  adieresis: "\u00E4", aring: "\u00E5", ae: "\u00E6", ccedilla: "\u00E7",
  egrave: "\u00E8", eacute: "\u00E9", ecircumflex: "\u00EA", edieresis: "\u00EB",
  igrave: "\u00EC", iacute: "\u00ED", icircumflex: "\u00EE", idieresis: "\u00EF",
  eth: "\u00F0", ntilde: "\u00F1", ograve: "\u00F2", oacute: "\u00F3",
  ocircumflex: "\u00F4", otilde: "\u00F5", odieresis: "\u00F6", divide: "\u00F7",
  oslash: "\u00F8", ugrave: "\u00F9", uacute: "\u00FA", ucircumflex: "\u00FB",
  udieresis: "\u00FC", yacute: "\u00FD", thorn: "\u00FE", ydieresis: "\u00FF",
  OE: "\u0152", oe: "\u0153", Scaron: "\u0160", scaron: "\u0161",
  Ydieresis: "\u0178", Zcaron: "\u017D", zcaron: "\u017E", florin: "\u0192",
  circumflex: "\u02C6", caron: "\u02C7", tilde: "\u02DC",
  endash: "\u2013", emdash: "\u2014", quoteleft2: "\u2018",
  quotesinglbase: "\u201A", quotedblbase: "\u201E", bullet: "\u2022",
  ellipsis: "\u2026", dagger: "\u2020", daggerdbl: "\u2021",
  perthousand: "\u2030", guilsinglleft: "\u2039", guilsinglright: "\u203A",
  fraction: "\u2044", Euro: "\u20AC", trademark: "\u2122",
  minus: "\u2212", fi: "\uFB01", fl: "\uFB02", ff: "\uFB00",
  ffi: "\uFB03", ffl: "\uFB04", dotlessi: "\u0131", Lslash: "\u0141",
  lslash: "\u0142", Scommaaccent: "\u0218", scommaaccent: "\u0219",
  Tcommaaccent: "\u021A", tcommaaccent: "\u021B",
}

/** Resolve an Adobe glyph name to its Unicode character. */
function glyphNameToUnicode(name: string): string | undefined {
  if (GLYPH_NAMES[name] !== undefined) return GLYPH_NAMES[name]
  // "uniXXXX" form
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name)
  if (uni) return String.fromCodePoint(parseInt(uni[1], 16))
  // "uXXXX" / "uXXXXXX" form
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name)
  if (u) return String.fromCodePoint(parseInt(u[1], 16))
  return undefined
}

// ─── PDF string decoders ─────────────────────────────────────────────────────

/** Decode a PDF literal string including its surrounding parentheses. */
function decodePdfString(raw: string): string {
  const inner = raw.slice(1, -1)
  let out = ""
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c !== "\\") { out += c; continue }
    const n = inner[i + 1]
    if (n === undefined) break
    if (n === "n") { out += "\n"; i++ }
    else if (n === "r") { out += "\r"; i++ }
    else if (n === "t") { out += "\t"; i++ }
    else if (n === "b") { out += "\b"; i++ }
    else if (n === "f") { out += "\f"; i++ }
    else if (n === "(" || n === ")" || n === "\\") { out += n; i++ }
    else if (n === "\r") { if (inner[i + 2] === "\n") i++; i++ }
    else if (n === "\n") { i++ }
    else if (/[0-7]/.test(n)) {
      let oct = ""
      let j = i + 1
      while (j < inner.length && j < i + 4 && /[0-7]/.test(inner[j])) { oct += inner[j]; j++ }
      out += String.fromCharCode(parseInt(oct, 8))
      i = j - 1
    } else { out += n; i++ }
  }
  return out
}

/**
 * Decode a PDF hex string token `<AABBCC…>` to a raw byte string (each char's
 * code point equals the byte value).  This is the correct representation for
 * content-stream strings that use CID 2-byte glyph IDs.
 */
function decodePdfHexRaw(raw: string): string {
  const hex = raw.slice(1, -1).replace(/\s/g, "")
  let out = ""
  for (let i = 0; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2) || "00", 16))
  }
  return out
}

/**
 * Decode a raw byte string using a CID ToUnicode CMap.
 * Reads 2 bytes at a time as a big-endian glyph ID, looks it up in the CMap.
 * Unknown glyph IDs emit the Unicode replacement character (U+FFFD).
 * Null glyphs (ID = 0) are skipped silently.
 */
function decodeCIDString(raw: string, cmap: Map<number, string>): string {
  let out = ""
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const glyph = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1)
    if (glyph === 0) continue  // null/padding glyph
    const ch = cmap.get(glyph)
    if (ch !== undefined) {
      out += ch
    } else {
      // Glyph not in CMap: skip silently (partial-CMap fonts omit common chars)
    }
  }
  return out
}

/**
 * Decode a raw byte string using a single-byte encoding map (from a font's
 * /Differences array).  Codes absent from the map fall back to WinAnsi so that
 * unmapped bytes still render as sensible characters.
 */
function decodeSingleByteString(raw: string, cmap: Map<number, string>): string {
  let out = ""
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = cmap.get(code)
    out += ch !== undefined ? ch : applyWinAnsi(raw[i])
  }
  return out
}

/**
 * Undo PNG predictor encoding (PDF /Predictor 10–15) on a decompressed stream.
 * Each row is prefixed with a filter-type byte; the row data is then
 * reconstructed from the previous row.  Returns the input unchanged when the
 * predictor is 1 (none) or the data is too short to be row-structured.
 */
function undoPngPredictor(data: string, columns: number, predictor: number): string {
  if (predictor < 10 || columns <= 0) return data
  const rowLen = columns + 1  // +1 for the filter-type byte
  const rows = Math.floor(data.length / rowLen)
  if (rows === 0) return data
  const out = Buffer.alloc(rows * columns)
  let prev = Buffer.alloc(columns)
  for (let r = 0; r < rows; r++) {
    const base = r * rowLen
    const ft = data.charCodeAt(base)
    const row = Buffer.alloc(columns)
    for (let c = 0; c < columns; c++) {
      const raw = data.charCodeAt(base + 1 + c)
      const left = c > 0 ? row[c - 1] : 0
      const up = prev[c]
      const upLeft = c > 0 ? prev[c - 1] : 0
      let v: number
      switch (ft) {
        case 0: v = raw; break                                  // None
        case 1: v = raw + left; break                           // Sub
        case 2: v = raw + up; break                             // Up
        case 3: v = raw + ((left + up) >> 1); break             // Average
        case 4: {                                               // Paeth
          const p = left + up - upLeft
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft)
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          v = raw + pred
          break
        }
        default: v = raw
      }
      row[c] = v & 0xff
    }
    row.copy(out, r * columns)
    prev = row
  }
  return out.toString("latin1")
}

// ─── PDF cross-reference table ────────────────────────────────────────────────

/**
 * Parse traditional PDF cross-reference table(s) into a map from object ID to
 * byte offset in the file.  Handles multiple xref sections (incremental PDFs).
 */
function parseXref(latin: string): Map<number, number> {
  const offsets = new Map<number, number>()
  const xrefRe = /\bxref\b\r?\n(\d+)\s+(\d+)\r?\n((?:\d{10}\s+\d{5}\s+[fn][ \t]*(?:\r\n|\r|\n))+)/g
  let m: RegExpExecArray | null
  while ((m = xrefRe.exec(latin)) !== null) {
    const startId = parseInt(m[1], 10)
    const entries = [...m[3].matchAll(/(\d{10})\s+\d{5}\s+([fn])/g)]
    for (let i = 0; i < entries.length; i++) {
      const [, offset, flag] = entries[i]
      if (flag === "n") offsets.set(startId + i, parseInt(offset, 10))
    }
  }
  // PDF 1.5+ cross-reference streams: no "xref" keyword, the table lives in a
  // /Type /XRef stream.  Merge those entries in (they take precedence).
  for (const [objId, off] of parseXrefStreams(latin)) offsets.set(objId, off)
  return offsets
}

/**
 * Parse PDF 1.5 cross-reference streams (/Type /XRef).  Each stream holds a
 * binary table of fixed-width fields; the /W array gives the byte width of the
 * type, field-2 and field-3 columns, and /Index gives the starting object number
 * of each subsection.  Type-1 entries carry a byte offset; type-2 entries point
 * into an object stream (which we cannot resolve to a byte offset, so they are
 * skipped here — their contents are reached via the /ObjStm expansion instead).
 */
function parseXrefStreams(latin: string): Map<number, number> {
  const offsets = new Map<number, number>()
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(latin)) !== null) {
    const dict = m[1]
    if (!/\/Type\s*\/XRef/.test(dict)) continue
    const wm = /\/W\s*\[([\s\S]*?)\]/.exec(dict)
    if (!wm) continue
    const w = wm[1].trim().split(/\s+/).map((x) => parseInt(x, 10))
    if (w.length < 3) continue
    const [w0, w1, w2] = w
    const rowLen = w0 + w1 + w2
    if (rowLen <= 0) continue

    const declared = resolveStreamLength(latin, dict)
    const start = m.index + m[0].length
    const end = declared >= 0 ? start + declared : latin.indexOf("endstream", start)
    if (end === -1) continue
    let body: string
    try {
      body = zlib.inflateSync(Buffer.from(latin.slice(start, end), "binary")).toString("latin1")
    } catch {
      continue
    }

    // Undo PNG predictor encoding if present (/DecodeParms /Predictor 10–15).
    const predM = /\/Predictor\s+(\d+)/.exec(dict)
    const colsM = /\/Columns\s+(\d+)/.exec(dict)
    if (predM && parseInt(predM[1], 10) >= 10) {
      const cols = colsM ? parseInt(colsM[1], 10) : rowLen
      body = undoPngPredictor(body, cols, parseInt(predM[1], 10))
    }

    // /Index defaults to [0 Size]; otherwise it is a list of (start,count) pairs.
    let index: number[]
    const im = /\/Index\s*\[([\s\S]*?)\]/.exec(dict)
    if (im) {
      index = im[1].trim().split(/\s+/).map((x) => parseInt(x, 10))
    } else {
      const sm = /\/Size\s+(\d+)/.exec(dict)
      index = [0, sm ? parseInt(sm[1], 10) : 0]
    }

    let pos = 0
    for (let s = 0; s + 1 < index.length; s += 2) {
      const first = index[s]
      const count = index[s + 1]
      for (let i = 0; i < count; i++) {
        if (pos + rowLen > body.length) break
        const readField = (off: number, width: number): number => {
          if (width === 0) return 0
          let v = 0
          for (let k = 0; k < width; k++) v = v * 256 + body.charCodeAt(pos + off + k)
          return v
        }
        // Type defaults to 1 when the type field is absent (w0 === 0).
        const type = w0 === 0 ? 1 : readField(0, w0)
        const f2 = readField(w0, w1)
        if (type === 1) offsets.set(first + i, f2)
        pos += rowLen
      }
    }
  }
  return offsets
}

/**
 * Read the dictionary portion of a PDF object at `offset` (byte index in
 * `latin`).  Returns the text between `obj` and the first `stream` keyword (or
 * `endobj`).  Returns `""` if the object cannot be found.
 */
function readObjDict(latin: string, offset: number): string {
  // Advance past "N G obj"
  const objKeyword = latin.indexOf("obj", offset)
  if (objKeyword === -1 || objKeyword > offset + 40) return ""
  const bodyStart = objKeyword + 3

  // Stop at the stream keyword (anchored on the dict's closing ">>") or endobj.
  const streamIdx = latin.indexOf(">>stream", bodyStart)
  const endobjIdx = latin.indexOf("endobj", bodyStart)
  if (endobjIdx === -1) return ""

  const bodyEnd = streamIdx !== -1 && streamIdx < endobjIdx ? streamIdx + 2 : endobjIdx
  return latin.slice(bodyStart, bodyEnd)
}

/**
 * Read the dictionary of the stream whose "stream" keyword starts at
 * `streamIdx`.  Finds the enclosing "N G obj" and reads forward to the stream
 * keyword, so nested dicts and binary data in earlier streams cannot confuse
 * the bracket balance.  Returns "" if the object header cannot be found.
 */
function readStreamDict(latin: string, streamIdx: number): string {
  // Find the nearest "N G obj" header before the stream keyword.  A plain
  // lastIndexOf("obj") can land inside binary stream data, so require the
  // numeric object header and verify the dict opens before the stream keyword.
  const head = latin.slice(Math.max(0, streamIdx - 4096), streamIdx)
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  let objIdx = -1
  let m: RegExpExecArray | null
  while ((m = re.exec(head)) !== null) objIdx = m.index + m[0].length
  if (objIdx === -1) return ""
  objIdx += Math.max(0, streamIdx - 4096)

  const dictStart = latin.indexOf("<<", objIdx)
  if (dictStart === -1 || dictStart > streamIdx) return ""

  // Balance brackets forward from dictStart.  `streamIdx` points at the ">>"
  // that precedes the stream keyword, so the closing bracket is included.
  let depth = 0
  for (let i = dictStart; i <= streamIdx + 1; i++) {
    if (latin[i] === "<" && latin[i - 1] === "<") {
      depth++
      i++
    } else if (latin[i] === ">" && latin[i - 1] === ">") {
      depth--
      i++
      if (depth === 0) return latin.slice(dictStart, i + 1)
    }
  }
  return latin.slice(dictStart, streamIdx)
}

/**
 * Decompress (if needed) and return the stream content for the object at
 * `offset`.  Returns `null` if the object has no stream.
 */
function readObjStream(latin: string, offset: number): string | null {
  const objKeyword = latin.indexOf("obj", offset)
  if (objKeyword === -1 || objKeyword > offset + 40) return null
  const bodyStart = objKeyword + 3

  const endobjIdx = latin.indexOf("endobj", bodyStart)
  if (endobjIdx === -1) return null
  const objBody = latin.slice(bodyStart, endobjIdx)

  const streamMatch = /<<([\s\S]*?)>>\s*stream\r?\n/.exec(objBody)
  if (!streamMatch) return null

  const streamStart = bodyStart + streamMatch.index + streamMatch[0].length
  // Prefer the declared /Length (literal or indirect); fall back to the next
  // "endstream" keyword.
  const declared = resolveStreamLength(latin, streamMatch[1])
  let streamEnd: number
  if (declared >= 0) {
    streamEnd = streamStart + declared
  } else {
    streamEnd = latin.indexOf("endstream", streamStart)
    if (streamEnd === -1) return null
  }

  const rawBytes = latin.slice(streamStart, streamEnd)
  const isFlate = /\/Filter\s*(?:\/FlateDecode|\[\/FlateDecode\])/.test(objBody)

  if (isFlate) {
    try {
      return zlib.inflateSync(Buffer.from(rawBytes, "binary")).toString("latin1")
    } catch {
      return rawBytes  // fall back to raw on decompress failure
    }
  }
  return rawBytes
}

// ─── ToUnicode CMap parser ────────────────────────────────────────────────────

/**
 * Convert a CMap hex sequence like "0041" or "00410042" to the Unicode
 * character(s) it represents.
 */
function cmapHexToUnicode(hex: string): string {
  const h = hex.replace(/\s/g, "")
  if (h.length <= 4) return String.fromCodePoint(parseInt(h, 16))
  let out = ""
  for (let i = 0; i < h.length; i += 4) {
    out += String.fromCodePoint(parseInt(h.slice(i, i + 4) || "0", 16))
  }
  return out
}

/**
 * Parse a ToUnicode CMap stream.  Handles:
 *   - beginbfchar / endbfchar: direct glyph-to-Unicode mappings
 *   - beginbfrange / endbfrange: range mappings with sequential or explicit-
 *     array destinations
 *
 * Returns a Map from 16-bit glyph ID to Unicode character string.
 */
function parseToUnicodeCMap(cmapText: string): { cmap: Map<number, string>; codeBytes: number } {
  const cmap = new Map<number, string>()
  // Source-code width in bytes, inferred from the hex length of the mapping
  // keys.  Type0/Identity-H fonts use 2-byte codes; simple fonts with a
  // ToUnicode CMap use 1-byte codes.  A few stray entries of the other width
  // can appear (e.g. a 2-byte space mapping in an otherwise 1-byte CMap), so
  // take the most common width rather than the maximum.
  const widthCounts = new Map<number, number>()
  const noteWidth = (hex: string): void => {
    const bytes = Math.ceil(hex.length / 2)
    widthCounts.set(bytes, (widthCounts.get(bytes) ?? 0) + 1)
  }

  // ── beginbfchar ... endbfchar ───────────────────────────────────────────
  for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      noteWidth(pair[1])
      const glyphId = parseInt(pair[1], 16)
      cmap.set(glyphId, cmapHexToUnicode(pair[2]))
    }
  }

  // ── beginbfrange ... endbfrange ─────────────────────────────────────────
  for (const block of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const text = block[1]
    let pos = 0

    while (pos < text.length) {
      // Match a range entry: <start> <end> followed by <dest> or [<d1> <d2>...]
      const rangeMatch = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*/g
      rangeMatch.lastIndex = pos
      const rm = rangeMatch.exec(text)
      if (!rm) break

      noteWidth(rm[1])
      const start = parseInt(rm[1], 16)
      const end = parseInt(rm[2], 16)
      pos = rm.index + rm[0].length

      if (pos < text.length && text[pos] === "[") {
        // Explicit array form: [ <u1> <u2> ... ]
        const closeBracket = text.indexOf("]", pos)
        const arrText = text.slice(pos + 1, closeBracket !== -1 ? closeBracket : text.length)
        const hexVals = [...arrText.matchAll(/<([0-9a-fA-F]+)>/g)].map(hm => hm[1])
        for (let i = start; i <= end; i++) {
          const idx = i - start
          if (idx < hexVals.length) cmap.set(i, cmapHexToUnicode(hexVals[idx]))
        }
        pos = closeBracket !== -1 ? closeBracket + 1 : text.length
      } else {
        // Sequential form: <destStart>
        const destMatch = /<([0-9a-fA-F]+)>/.exec(text.slice(pos))
        if (!destMatch) continue
        const destStart = parseInt(destMatch[1], 16)
        for (let i = start; i <= end; i++) {
          cmap.set(i, String.fromCodePoint(destStart + (i - start)))
        }
        pos += destMatch.index + destMatch[0].length
      }
    }
  }

  // Pick the most common key width; default to 2 bytes (CID) when empty.
  let codeBytes = 2
  let best = 0
  for (const [bytes, count] of widthCounts) {
    if (count > best) { best = count; codeBytes = bytes }
  }

  return { cmap, codeBytes }
}

// ─── Font resource resolver ───────────────────────────────────────────────────

/**
 * Parse a CIDFont /W array into a map from glyph code to advance width (in
 * 1/1000 em units).  The array has two forms:
 *   c [w1 w2 …]        — consecutive widths starting at code c
 *   c1 c2 w            — the same width w for codes c1..c2
 */
function parseWidths(body: string): Map<number, number> {
  const widths = new Map<number, number>()

  // Simple fonts use /FirstChar + /Widths [w0 w1 ...], where w0 is the width of
  // /FirstChar.  This is the common case for Type1/TrueType fonts.  The two keys
  // may appear in either order.
  const fc = /\/FirstChar\s+(\d+)/.exec(body)
  const wArr = /\/Widths\s*\[([^\]]*)\]/.exec(body)
  if (fc && wArr) {
    const first = parseInt(fc[1], 10)
    const vals = wArr[1].trim().split(/\s+/).filter(Boolean).map((x) => parseInt(x, 10))
    vals.forEach((w, i) => { if (!Number.isNaN(w)) widths.set(first + i, w) })
    if (widths.size > 0) return widths
  }

  const wIdx = body.indexOf("/W")
  if (wIdx === -1) return widths
  const open = body.indexOf("[", wIdx)
  if (open === -1) return widths
  // Balance brackets to find the outer array's end (the array contains nested
  // sub-arrays, so a non-greedy match would stop at the first inner "]".
  let depth = 0
  let close = -1
  for (let i = open; i < body.length; i++) {
    if (body[i] === "[") depth++
    else if (body[i] === "]") { depth--; if (depth === 0) { close = i; break } }
  }
  if (close === -1) return widths
  const src = body.slice(open + 1, close)
  const re = /(\d+)\s*\[([^\]]*)\]|(\d+)\s+(\d+)\s+(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (m[1] !== undefined) {
      const start = parseInt(m[1], 10)
      const vals = m[2].trim().split(/\s+/).filter(Boolean).map((x) => parseInt(x, 10))
      vals.forEach((w, i) => widths.set(start + i, w))
    } else {
      const c1 = parseInt(m[3], 10), c2 = parseInt(m[4], 10), w = parseInt(m[5], 10)
      for (let c = c1; c <= c2; c++) widths.set(c, w)
    }
  }
  return widths
}

/**
 * Parse a /Differences array from a font's /Encoding dictionary into a
 * code→Unicode map.  The array alternates a starting code with a run of glyph
 * names, e.g. `[1 /T /h /i /r /d 32 /space]` → {1:"T", 2:"h", 3:"i", 4:"r",
 * 5:"d", 32:" "}.  Names that don't resolve are skipped.
 *
 * When `baseFont` is one of the Monotype symbol fonts, a name is first checked
 * against the outline-accurate overrides in tex-math-fonts.ts: those fonts
 * label their glyphs with names that do not describe the outlines, so the
 * Adobe table would yield the wrong character.
 */
function parseDifferences(diffBody: string, baseFont?: string): Map<number, string> {
  const cmap = new Map<number, string>()
  let code = 0
  for (const tok of diffBody.matchAll(/\/([A-Za-z0-9._]+)|(\d+)/g)) {
    if (tok[2] !== undefined) {
      code = parseInt(tok[2], 10)
    } else {
      const override = symbolGlyphName(baseFont, tok[1])
      const uni = override !== undefined ? override : glyphNameToUnicode(tok[1])
      if (uni !== undefined) cmap.set(code, uni)
      code++
    }
  }
  return cmap
}

/**
 * Build a map from object ID to the object's body text, covering both
 * top-level objects (via the xref table) and objects packed inside PDF 1.5
 * object streams (/Type /ObjStm).  Font dictionaries and ToUnicode CMaps are
 * frequently stored inside object streams, so this is required to resolve them.
 *
 * For objects that carry a stream, the decompressed stream content is appended
 * after the dictionary so that CMap bodies are visible to the caller.
 */
function buildObjectMap(latin: string): Map<number, string> {
  const objects = new Map<number, string>()
  const xrefOffsets = parseXref(latin)

  // Top-level objects.
  for (const [objId, offset] of xrefOffsets) {
    const body = readObjDict(latin, offset)
    if (!body) continue
    const stream = readObjStream(latin, offset)
    objects.set(objId, stream ? body + "\n" + stream : body)
  }

  // Objects packed inside /ObjStm streams.
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(latin)) !== null) {
    const dict = m[1]
    if (!/\/Type\s*\/ObjStm/.test(dict)) continue
    const firstM = /\/First\s+(\d+)/.exec(dict)
    const nM = /\/N\s+(\d+)/.exec(dict)
    if (!firstM || !nM) continue
    const declared = resolveStreamLength(latin, dict)
    const start = m.index + m[0].length
    const end = declared >= 0 ? start + declared : latin.indexOf("endstream", start)
    if (end === -1) continue
    let body: string
    try {
      body = zlib.inflateSync(Buffer.from(latin.slice(start, end), "binary")).toString("latin1")
    } catch {
      continue
    }
    const first = parseInt(firstM[1], 10)
    const n = parseInt(nM[1], 10)
    const nums = [...body.slice(0, first).matchAll(/\d+/g)].map((x) => parseInt(x[0], 10))
    const payload = body.slice(first)
    for (let i = 0; i < n && i * 2 + 1 < nums.length; i++) {
      const off = nums[i * 2 + 1]
      const nextOff = i * 2 + 3 < nums.length ? nums[i * 2 + 3] : payload.length
      objects.set(nums[i * 2], payload.slice(off, nextOff))
    }
  }

  return objects
}

/** A font's decoded glyph map plus the metrics the layout pass needs. */
type ResolvedFont = {
  cmap: Map<number, string>
  single: boolean
  widths?: Map<number, number>
  /** True for the broken LaTeX math fonts (see tex-math-fonts.ts). */
  mathFont?: boolean
}

/**
 * Scan the whole PDF for font resource dictionaries and ToUnicode CMap streams,
 * then build a map from font resource name (e.g. "F6") to its glyph→Unicode
 * CMap.  Falls back to a regex scan when the xref table is missing.
 *
 * Fonts are resolved from two sources, in priority order:
 *   1. a /ToUnicode CMap (authoritative for CID fonts), then
 *   2. a /Differences array in the font's /Encoding (glyph-name overrides).
 * Standard-encoded fonts with neither remain absent, and the caller falls back
 * to WinAnsi/Latin-1 decoding for them.
 */
function buildFontCMaps(latin: string): {
  cmaps: Map<string, Map<number, string>>
  singleByte: Set<string>
  mathFonts: Set<string>
  widths: Map<string, Map<number, number>>
  byObjId: Map<number, ResolvedFont>
} {
  const result = new Map<string, Map<number, string>>()
  // Font resource names backed by one of the broken LaTeX math fonts.
  const mathFonts = new Set<string>()
  // Font names whose map is a single-byte /Differences encoding (as opposed to
  // a 2-byte CID ToUnicode CMap).
  const singleByte = new Set<string>()
  // Glyph advance widths (1/1000 em) keyed by font resource name.
  const widths = new Map<string, Map<number, number>>()
  // Per-font-object resolution, for page-scoped resource names.
  const byObjId = new Map<number, ResolvedFont>()
  // Whether each font object uses 1-byte codes (a simple Type1/TrueType font)
  // or 2-byte CIDs (Type0/Identity-H).  This is a property of the font, not of
  // its CMap: a WinAnsiEncoding font has neither /ToUnicode nor /Differences,
  // yet its /Widths are still keyed by single byte.
  const singleByteByFontObjId = new Map<number, boolean>()

  // ── Step 1: Collect every object (top-level and inside object streams) ────
  const objects = buildObjectMap(latin)
  if (objects.size === 0) return { cmaps: result, singleByte, mathFonts, widths, byObjId }

  // ── Step 2: Build objId→CMap for every ToUnicode stream object ───────────
  const cmapByObjId = new Map<number, Map<number, string>>()
  // Source-code width (bytes) for each ToUnicode CMap object.
  const codeBytesByObjId = new Map<number, number>()
  for (const [objId, body] of objects) {
    if (!body.includes("beginbfchar") && !body.includes("beginbfrange")) continue
    const parsed = parseToUnicodeCMap(body)
    if (parsed.cmap.size > 0) {
      cmapByObjId.set(objId, parsed.cmap)
      codeBytesByObjId.set(objId, parsed.codeBytes)
    }
  }

  // ── Step 3: Build objId→ToUnicodeObjId for every font object ─────────────
  const touByFontObjId = new Map<number, number>()
  // Fonts whose /Encoding carries a /Differences array (glyph-name overrides).
  const diffByFontObjId = new Map<number, Map<number, string>>()
  // Glyph advance widths (1/1000 em) for CID fonts, keyed by font object ID.
  const widthsByFontObjId = new Map<number, Map<number, number>>()
  // BaseFont (subset prefix stripped) for each font object, used to share width
  // tables between fonts of the same face.
  const baseFontByObjId = new Map<number, string>()
  for (const [objId, dict] of objects) {
    const tou = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(dict)
    if (tou) touByFontObjId.set(objId, parseInt(tou[1], 10))

    // A Type0 font's widths live on its descendant CIDFont, not the font dict.
    const desc = /\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/.exec(dict)
    if (desc) {
      const descBody = objects.get(parseInt(desc[1], 10))
      if (descBody) {
        const w = parseWidths(descBody)
        if (w.size > 0) widthsByFontObjId.set(objId, w)
      }
    } else {
      const w = parseWidths(dict)
      if (w.size > 0) widthsByFontObjId.set(objId, w)
    }
    // Record the BaseFont so widths can be shared across fonts of the same face
    // (a subset may omit the width table on some of its fonts).
    const bf = /\/BaseFont\/([^\s/]+)/.exec(dict)
    if (bf) baseFontByObjId.set(objId, bf[1].replace(/^[A-Z]{6}\+/, ""))

    // Record 1-byte vs 2-byte codes.  A Type0 font carries /DescendantFonts and
    // uses CIDs; every other font type is a simple font keyed by single byte.
    const subtype = /\/Subtype\s*\/([A-Za-z0-9]+)/.exec(dict)?.[1] ?? ""
    const isType0 = desc !== null || subtype === "Type0"
    // Only objects that actually look like a font, so an unrelated dictionary
    // that happens to carry a /Subtype is not mistaken for one.
    if (isType0 || /\/BaseFont\b/.test(dict) || /\/FirstChar\b/.test(dict)) {
      singleByteByFontObjId.set(objId, !isType0)
    }

    // /Encoding may be an inline dict with /Differences, or an indirect ref.
    let encBody: string | undefined
    const inlineEnc = /\/Encoding\s*<<([\s\S]*?)>>/.exec(dict)
    if (inlineEnc) {
      encBody = inlineEnc[1]
    } else {
      const encRef = /\/Encoding\s+(\d+)\s+\d+\s+R/.exec(dict)
      if (encRef) encBody = objects.get(parseInt(encRef[1], 10))
    }
    if (encBody) {
      const diff = /\/Differences\s*\[([\s\S]*?)\]/.exec(encBody)
      if (diff) {
        const cmap = parseDifferences(diff[1], bf ? bf[1].replace(/^[A-Z]{6}\+/, "") : undefined)
        if (cmap.size > 0) diffByFontObjId.set(objId, cmap)
      }
    }
  }

  // Share width tables between fonts of the same face: a subset may omit the
  // width table on some of its fonts, leaving the pen estimate unusable.
  const widthsByBaseFont = new Map<string, Map<number, number>>()
  for (const [objId, w] of widthsByFontObjId) {
    const bf = baseFontByObjId.get(objId)
    if (bf && !widthsByBaseFont.has(bf)) widthsByBaseFont.set(bf, w)
  }
  for (const [objId, bf] of baseFontByObjId) {
    if (widthsByFontObjId.has(objId)) continue
    const w = widthsByBaseFont.get(bf)
    if (w) widthsByFontObjId.set(objId, w)
  }

  /** Resolve a font object to its code→Unicode map, before any overrides. */
  const resolveFontRaw = (fontObjId: number): { cmap: Map<number, string>; single: boolean } | undefined => {
    const touObjId = touByFontObjId.get(fontObjId)
    const diff = diffByFontObjId.get(fontObjId)
    if (touObjId !== undefined) {
      const cmap = cmapByObjId.get(touObjId)
      if (cmap) {
        // A ToUnicode CMap may use 1-byte codes (simple fonts) or 2-byte codes
        // (Type0/Identity-H CID fonts); decode accordingly.
        const single = (codeBytesByObjId.get(touObjId) ?? 2) === 1
        if (single) {
          // For simple fonts the /Differences array is the font's actual
          // encoding and is authoritative; some generators emit a ToUnicode
          // CMap that disagrees with it.  Prefer /Differences, filling any
          // gaps from the CMap.
          if (diff) {
            const merged = new Map(diff)
            for (const [code, ch] of cmap) if (!merged.has(code)) merged.set(code, ch)
            return { cmap: merged, single: true }
          }
          return { cmap, single: true }
        }
        return { cmap, single: false }
      }
    }
    if (diff) return { cmap: diff, single: true }
    // No CMap at all: a simple font with a standard encoding (WinAnsiEncoding,
    // MacRomanEncoding, ...).  `decodeString` falls back to WinAnsi, but the
    // font is still single-byte and the width model needs to know that.
    const single = singleByteByFontObjId.get(fontObjId)
    if (single === undefined) return undefined
    return { cmap: new Map<number, string>(), single }
  }

  /**
   * Resolve a font object to its code→Unicode map, applying the TeX math-font
   * glyph overrides when the font is one of the broken Computer Modern math
   * faces.  Those PDFs ship a /ToUnicode that is an ASCII identity map, so the
   * CMap decodes the glyphs to U+FFFD or stray Latin-1 letters; the overrides
   * restore the characters the glyphs actually draw (see tex-math-fonts.ts).
   *
   * Results are memoised: the override clones the CMap, and `decodeString`
   * resolves the font for every string token, so without a cache a document
   * full of math glyphs would clone a map millions of times.
   */
  const resolvedCache = new Map<number, ResolvedFont | undefined>()
  const resolveFont = (fontObjId: number): ResolvedFont | undefined => {
    if (resolvedCache.has(fontObjId)) return resolvedCache.get(fontObjId)
    const raw = resolveFontRaw(fontObjId)
    let result: ResolvedFont | undefined = raw
    if (raw) {
      const bf = baseFontByObjId.get(fontObjId)
      const cmap = applyTexMathGlyphs(bf, raw.cmap, diffByFontObjId.has(fontObjId))
      const mathFont = isTexMathFont(bf)
      if (cmap !== raw.cmap || mathFont) result = { cmap, single: raw.single, mathFont }
    }
    resolvedCache.set(fontObjId, result)
    return result
  }

  // ── Space-code consensus across the document ──────────────────────────────
  // Arbortext/PDFlib sometimes emits a subset font whose ToUnicode CMap maps
  // the space glyph to a letter (e.g. code 3 → "t"), while other fonts in the
  // same document map that code to a space.  Collect every code that any font
  // maps to a space, together with the advance width that code has in a font
  // where it really is a space.  A code is then forced to a space only in fonts
  // where its width matches that known space width, so a genuine letter that
  // happens to share the code is left alone.
  const spaceCodes = new Set<number>()
  const spaceWidths = new Map<number, number>()
  for (const [objId] of objects) {
    const r = resolveFont(objId)
    if (!r) continue
    const wmap = widthsByFontObjId.get(objId)
    for (const [code, ch] of r.cmap) {
      if (ch !== " ") continue
      spaceCodes.add(code)
      const w = wmap?.get(code)
      if (w !== undefined && !spaceWidths.has(code)) spaceWidths.set(code, w)
    }
  }
  /** Force consensus space codes to a space in a resolved CMap. */
  const applySpaceConsensus = (fontObjId: number, cmap: Map<number, string>): Map<number, string> => {
    if (spaceCodes.size === 0) return cmap
    const wmap = widthsByFontObjId.get(fontObjId)
    const shouldOverride = (code: number): boolean => {
      const cur = cmap.get(code)
      if (cur === undefined || cur === " ") return false
      const known = spaceWidths.get(code)
      if (known === undefined) return false
      // Only override when this font gives the code the same advance as a font
      // where the code is known to be a space.
      return wmap?.get(code) === known
    }
    let changed = false
    for (const code of spaceCodes) if (shouldOverride(code)) { changed = true; break }
    if (!changed) return cmap
    const fixed = new Map(cmap)
    for (const code of spaceCodes) if (shouldOverride(code)) fixed.set(code, " ")
    return fixed
  }

  /** Register a font resource name → its map, tracking single-byte encodings. */
  const register = (fontName: string, fontObjId: number): void => {
    // A resource name can appear in several /Font dicts (one per page) pointing
    // at different objects.  Keep the first registration so a later, unrelated
    // mapping cannot clobber a correct one.
    if (result.has(fontName)) return
    // Widths are useful even when the font has no CMap (a simple font with a
    // standard encoding), so register them independently of the CMap.
    const w = widthsByFontObjId.get(fontObjId)
    if (w) widths.set(fontName, w)
    const r = resolveFont(fontObjId)
    if (!r) return
    result.set(fontName, applySpaceConsensus(fontObjId, r.cmap))
    if (r.single) singleByte.add(fontName)
    if (r.mathFont) mathFonts.add(fontName)
  }

  // ── Step 4: Expose per-object resolution for per-page font dicts ─────────
  // Resource names are page-scoped: the same name (e.g. "T1_0") can refer to
  // different font objects on different pages.  Callers resolve names against
  // the page's own /Font dict via this map.
  for (const [objId] of objects) {
    const r = resolveFont(objId)
    const w = widthsByFontObjId.get(objId)
    // A font may carry widths but no CMap (a simple font with a standard
    // encoding); keep it so the pen estimate still works.
    if (!r && !w) continue
    byObjId.set(objId, {
      cmap: r ? applySpaceConsensus(objId, r.cmap) : new Map<number, string>(),
      single: r?.single ?? false,
      widths: w,
      mathFont: r?.mathFont,
    })
  }

  // ── Step 5: Scan for /Font resource dicts and link names to CMaps ─────────
  // Pattern A: inline font dict  /Font << /F6 283 0 R /F7 284 0 R ... >>
  // Scan both the raw file and every object body (font resource dicts are often
  // packed inside object streams).
  const scanInlineFontDicts = (src: string): void => {
    for (const m of src.matchAll(/\/Font\s*<<([\s\S]{1,4000}?)>>/g)) {
      for (const em of m[1].matchAll(/\/([A-Za-z][A-Za-z0-9_]*)\s+(\d+)\s+\d+\s+R/g)) {
        register(em[1], parseInt(em[2], 10))
      }
    }
  }
  scanInlineFontDicts(latin)
  for (const body of objects.values()) scanInlineFontDicts(body)

  // Pattern B: indirect font dict  /Font 3 0 R  (the dict is a separate object)
  const scanIndirectFontDicts = (src: string): void => {
    for (const m of src.matchAll(/\/Font\s+(\d+)\s+\d+\s+R\b/g)) {
      const dictBody = objects.get(parseInt(m[1], 10))
      if (!dictBody) continue
      for (const em of dictBody.matchAll(/\/([A-Za-z][A-Za-z0-9_]*)\s+(\d+)\s+\d+\s+R/g)) {
        register(em[1], parseInt(em[2], 10))
      }
    }
  }
  scanIndirectFontDicts(latin)
  for (const body of objects.values()) scanIndirectFontDicts(body)

  return { cmaps: result, singleByte, mathFonts, widths, byObjId }
}

// ─── Layout-aware content-stream parser ──────────────────────────────────────

/**
 * Parse one decompressed PDF content stream into layout-preserving text.
 *
 * Compared to the naïve approach:
 *   - Tracks Tm/Td/TD/T-star/Tf text-state operators.
 *   - Joins consecutive text calls at the same y-position on a single line.
 *   - Decodes hex strings (<AABB>) as raw bytes, then applies the current
 *     font's CID CMap if one is available.
 *   - Falls back to Latin-1 for literal strings from standard-encoded fonts.
 */

/**
 * Parse one decompressed PDF content stream into layout-preserving text, using
 * a caller-supplied resolver to map font resource names to their encodings.
 * This lets each page resolve names against its own /Font dict, since the same
 * name can refer to different fonts on different pages.
 */
function extractTextWithResolver(
  src: string,
  resolveFont: (name: string) => ResolvedFont | undefined,
): TextLine[] {
  const lines: TextLine[] = []

  // Text state
  let inText = false
  let lineY = 0       // device y of the current output line
  let sawPosition = false  // did this text object declare where it draws?
  // Current transformation matrix, and the stack `q`/`Q` maintain for it.
  let ctm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const ctmStack: Array<typeof ctm> = []
  let tmY = 0         // current text-matrix y (local coords within cm context)
  let tmX = 0         // current text-matrix x
  let tlmX = 0        // corrected line-matrix x, reset on BT (geometry only)
  let tlmY = 0        // text line-matrix y
  let tl = 0          // text leading
  let fontSize = 12   // current font size
  let fontName = ""   // current font resource name (from Tf)
  let lineBuf = ""    // pending text for the current line
  let runs: TextRun[] = []  // geometry for the pending line, one entry per run
  // Width (in text-space units) of the glyph run most recently appended, used to
  // tell a word gap from ordinary inter-run kerning.
  let lastRunWidth = 0
  // Character count of the run most recently appended.  A producer that emits a
  // real space glyph for every word gap and positions each remaining glyph with
  // its own `Td` (common in older judgments) leaves single-character runs, and
  // there the `Td` advance is inter-glyph kerning rather than a word space.
  let lastRunChars = 0
  // Pen x-position (in text space) where the last glyph run ended, and the
  // x-position the line matrix currently points at.  A `Td` moves the line
  // matrix; the gap is the new position minus where the pen actually ended.
  let lineOriginX = 0
  // Set by a `Td`/`TD` when the advance looks like a word gap; applied by the
  // next appendText once the following text is known (so punctuation can veto).
  let pendingSpace = false
  // Some producers emit a real space glyph for every word gap and position each
  // remaining glyph with its own `Td` (common in older judgments).  There the
  // `Td` advance is inter-glyph kerning, not a word space, and treating a small
  // one as a space shatters words ("w ere").  A whitespace-only run is the
  // tell-tale; once one is seen, single-character runs need a wider gap before
  // they count as a word space.
  let sawExplicitSpaceGlyph = false
  // y-position of the previous line and the typical line advance, used to tell
  // a paragraph break (a larger vertical gap) from ordinary line wrapping.
  let prevLineY: number | null = null
  let lineAdvance = 0
  // Rightmost x reached by the current line, the previous line, and the widest
  // line seen so far.  A line that stops well short of the text width ends a
  // paragraph.
  let lineRight = 0
  let prevLineRight = 0
  let prevLineText = ""
  let maxLineRight = 0
  // Leftmost x of the current line, and the most common left margin seen so far
  // (the body's left edge).  A line that returns to the body margin after an
  // indented run starts a new paragraph.
  let lineLeft = Infinity
  let prevLineLeft = Infinity
  const leftCounts = new Map<number, number>()
  let bodyLeft = Infinity

  function flushLine() {
    const t = lineBuf.replace(/\s+/g, " ").trim()
    if (t) {
      // A paragraph break is signalled by any of:
      //   - a vertical gap larger than the usual line advance;
      //   - the previous line ending well short of the text width (a "short
      //     line" is the last line of a paragraph);
      //   - a line that returns to the body's left margin after an indented
      //     run (indented sub-clauses are followed by unindented text).
      let brk = false
      if (prevLineY !== null && lineAdvance > 0) {
        const gap = Math.abs(prevLineY - lineY)
        if (gap > lineAdvance * 1.6) brk = true
      }
      // A short line ends a paragraph — but only when it also ends a sentence.
      // In a ragged-right layout most lines stop short of the widest line, so
      // the width test alone fires on ordinary wrapping and shreds the
      // paragraph.  Requiring sentence-ending punctuation (or a closing
      // bracket/quote) keeps the rule to genuine paragraph ends.
      if (
        !brk &&
        maxLineRight > 0 &&
        prevLineRight > 0 &&
        prevLineRight < maxLineRight * 0.9 &&
        /[.:;!?”’)\]]$/.test(prevLineText)
      ) {
        const startsNew = /^([A-Z0-9“"([]|\([0-9A-Za-z]+\)|\([ivxlcdm]+\))/.test(t)
        if (startsNew) brk = true
      }
      // Indentation: a line at the body margin following an indented line
      // starts a new paragraph.
      if (!brk && bodyLeft !== Infinity && prevLineLeft !== Infinity && lineLeft !== Infinity) {
        const atBody = Math.abs(lineLeft - bodyLeft) < fontSize * 0.5
        const prevIndented = prevLineLeft - bodyLeft > fontSize * 0.5
        if (atBody && prevIndented) brk = true
      }
      // A line that opens a citation ("[S 326/2024 ...]") or a numbered
      // sub-clause ("(1A)", "(a)", "(ii)") always starts a new block, even when
      // the preceding line was long or the citation is right-aligned.
      if (!brk && /^(\[|\([0-9A-Za-z]+\)|\([ivxlcdm]+\))/.test(t)) brk = true
      if (brk) lines.push({ y: lineY, runs: [] })
      lines.push({ y: lineY, runs })
      if (prevLineY !== null) {
        const gap = Math.abs(prevLineY - lineY)
        // Only ordinary advances feed the running estimate, so a paragraph gap
        // does not inflate it.  A gap far *smaller* than the estimate is a
        // same-line artifact — a superscript, a footnote marker, a font switch
        // — and must not deflate it either: once the estimate collapses, every
        // real line gap looks like a paragraph break and the text is shredded
        // into one line per paragraph.
        //
        // A standalone page number is the worst offender: it sits alone on its
        // line with a tiny gap, so it is excluded outright.
        const isPageNumber = /^\d{1,4}$/.test(t)
        const ordinary =
          !isPageNumber && gap > 0 && gap <= lineAdvance * 1.6 && gap >= lineAdvance * 0.5
        if (ordinary) lineAdvance = lineAdvance === 0 ? gap : lineAdvance * 0.7 + gap * 0.3
        else if (lineAdvance === 0 && !isPageNumber) lineAdvance = gap
      }
      prevLineY = lineY
      if (lineRight > maxLineRight) maxLineRight = lineRight
      prevLineRight = lineRight
      prevLineText = t
      prevLineLeft = lineLeft
      // Track the most common left position; that is the body margin.
      if (lineLeft !== Infinity) {
        const key = Math.round(lineLeft)
        leftCounts.set(key, (leftCounts.get(key) ?? 0) + 1)
        let best = 0
        for (const [k, v] of leftCounts) if (v > best) { best = v; bodyLeft = k }
      }
    }
    lineBuf = ""
    runs = []
    lastRunWidth = 0
    lastRunChars = 0
    lineRight = 0
    lineLeft = Infinity

    lineOriginX = 0
  }

  /**
   * Sum a raw string's glyph widths, in text-space units.
   *
   * A simple font keys `/Widths` by single byte; a Type0/Identity-H font keys
   * them by 2-byte CID.  Reading a single-byte run as CIDs yields zero for a
   * one-character run — a lone `”`, say — which silently disables the word
   * space test in the `Td` handler, because that test bails when the previous
   * run measured zero width.  So the distinction has to be made here.
   */
  function glyphWidth(raw: string, wmap: Map<number, number>, single: boolean): number {
    let sum = 0
    if (single) {
      for (let i = 0; i < raw.length; i++) sum += wmap.get(raw.charCodeAt(i)) ?? 500
    } else {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const code = (raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1)
        sum += wmap.get(code) ?? 778
      }
    }
    return (sum / 1000) * fontSize
  }

  function appendText(text: string, raw?: string, advance?: number) {
    if (!text) return
    // Some ToUnicode CMaps map a glyph to a control character (commonly TAB for
    // a word space).  Normalise those to a plain space so they don't corrupt
    // the output or trip the garbage detector.
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    if (/^\s+$/.test(text)) sawExplicitSpaceGlyph = true
    // Text drawn far below the legible minimum is a hidden overlay — a
    // duplicate line some producers keep for search or accessibility — and is
    // not part of the printed page.
    if (fontSize * (Math.hypot(ctm.a, ctm.c) || 1) < 1) return
    // The text matrix is in text space; the CTM scales and translates it to
    // device space, which is where line breaks and paragraph gaps are measured.
    const scaleY = Math.hypot(ctm.b, ctm.d) || 1
    const deviceY = ctm.b * tmX + ctm.d * tmY + ctm.f
    const dy = Math.abs(deviceY - lineY)
    const threshold = fontSize > 0 ? fontSize * 0.5 * scaleY : 4
    if (dy > threshold) { flushLine(); lineY = deviceY }
    // Apply a word space queued by the preceding Td/TD, unless the text on
    // either side is punctuation (quotes and brackets are positioned with their
    // own advances, so a gap next to them is not a word space).
    let prefix = ""
    if (pendingSpace) {
      // A gap next to punctuation is usually the punctuation's own advance, not
      // a word space — but a closing quote followed by a word does need one.
      const prevCh = lineBuf.slice(-1)
      const nextCh = text.slice(0, 1)
      const opens = /[“‘"'([]/
      const closes = /[”’"')\]]/
      const veto = opens.test(prevCh) || closes.test(nextCh)
      if (!veto && !lineBuf.endsWith(" ")) prefix = " "
      pendingSpace = false
    }
    lineBuf += prefix + text
    // Advance estimate for the run just emitted, in text-space units.  Prefer
    // the font's real glyph widths; fall back to 0.5 em per character.
    const font = resolveFont(fontName)
    if (advance !== undefined) {
      lastRunWidth = advance
    } else if (font?.widths && raw) {
      lastRunWidth = glyphWidth(raw, font.widths, font.single)
    } else {
      // No width table: approximate at 0.5 em per character.
      lastRunWidth = text.length * fontSize * 0.5
    }
    lastRunChars = text.length
    // Track how far right this line reaches, to detect short (paragraph-final)
    // lines, and where it starts, to detect indented sub-clauses.  tmX is the
    // pen position in text space.
    if (tmX + lastRunWidth > lineRight) lineRight = tmX + lastRunWidth
    if (tmX < lineLeft) lineLeft = tmX
    // Record the run's geometry for the table pass.  x/y are device space
    // (the CTM is applied), because runs positioned by `cm` carry no absolute
    // text-space x of their own; `size` is the font size scaled to device x
    // units so gap thresholds are comparable across documents.
    const scaleX = Math.hypot(ctm.a, ctm.c) || 1
    const deviceX = ctm.a * tlmX + ctm.c * tmY + ctm.e
    runs.push({
      x: deviceX,
      xEnd: deviceX + lastRunWidth * scaleX,
      y: deviceY,
      size: fontSize * scaleX,
      text: prefix + text,
      mathFont: font?.mathFont,
    })
    // The pen now sits at the end of this run.

  }

  /** Decode a raw byte string (from literal or hex token) using the current font. */
  function decodeString(raw: string): string {
    const f = resolveFont(fontName)
    if (f && f.cmap.size > 0) {
      // /Differences encodings map single bytes; ToUnicode CMaps map 2-byte CIDs.
      return f.single ? decodeSingleByteString(raw, f.cmap) : decodeCIDString(raw, f.cmap)
    }
    // No CMap → standard-encoded font.  WinAnsiEncoding is the common case, so
    // map the 0x80–0x9F range to its Unicode punctuation; the rest is Latin-1.
    return applyWinAnsi(raw)
  }

  // Tokeniser covers:
  //   numbers | literal strings | hex strings | [ | ] | /names | operators
  const tokenRe =
    /(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|(\((?:[^()\\]|\\.)*\))|(<[0-9a-fA-F\s]*>)|(\[)|(\])|(\/[^\s/<>[\](){}]*)|([A-Za-z'"][A-Za-z0-9*'"]*)/g

  type StackItem = number | string | Array<number | string>
  const stack: StackItem[] = []
  let inArray = false
  const arrayBuf: Array<number | string> = []

  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(src)) !== null) {
    const tok = m[0]

    // ── Number ──────────────────────────────────────────────────────────────
    if (m[1]) {
      const n = parseFloat(tok)
      if (inArray) arrayBuf.push(n); else stack.push(n)
      continue
    }

    // ── Literal string ───────────────────────────────────────────────────────
    if (m[2]) {
      const raw = decodePdfString(tok)
      if (inArray) arrayBuf.push(raw); else stack.push(raw)
      continue
    }

    // ── Hex string ───────────────────────────────────────────────────────────
    if (m[3]) {
      const raw = decodePdfHexRaw(tok)
      if (inArray) arrayBuf.push(raw); else stack.push(raw)
      continue
    }

    // ── Array delimiters ─────────────────────────────────────────────────────
    if (m[4]) { inArray = true; arrayBuf.length = 0; continue }
    if (m[5]) {
      inArray = false
      stack.push([...arrayBuf])
      arrayBuf.length = 0
      continue
    }

    // ── Name token ───────────────────────────────────────────────────────────
    if (m[6]) { if (inArray) arrayBuf.push(tok); else stack.push(tok); continue }

    // ── Operator ─────────────────────────────────────────────────────────────
    const op = tok
    switch (op) {
      case "BT":
        // A text object is a *positioning* scope, not a line.  Word processors
        // emit one BT/ET per text run — a font switch, a quote in a different
        // font, a colour change — all on the same baseline.  Treating each as a
        // line shreds the text into one fragment per line, so the line break is
        // driven purely by the y-position, which `Tm`/`Td` set absolutely.
        inText = true
        tmY = tlmY = 0
        tlmX = 0
        tl = 0
        sawPosition = false
        stack.length = 0
        break

      case "ET":
        // A block that never declared a position gives us no y to compare, so
        // fall back to treating it as its own line — the pre-existing behaviour
        // for documents that position text with a matrix we do not track.
        if (inText && !sawPosition) flushLine()
        inText = false
        stack.length = 0
        break

      case "Tf": {
        // /FontName size Tf
        const size = stack.pop()
        const name = stack.pop()
        if (typeof size === "number" && size > 0) fontSize = size
        // Name token from stack is like "/F6"
        if (typeof name === "string") fontName = name.startsWith("/") ? name.slice(1) : name
        break
      }

      case "TL": {
        const l = stack.pop()
        if (typeof l === "number") tl = l
        break
      }

      case "Tm": {
        const f = stack.pop(), e = stack.pop()
        const d = stack.pop(), c = stack.pop()
        const b = stack.pop(), a = stack.pop()
        if (typeof e === "number" && typeof f === "number") tmY = tlmY = f
        if (typeof c === "number") { tmX = c; lineOriginX = c; tlmX = c }
        sawPosition = true
        void a; void b; void d
        break
      }

      case "Td": case "TD": {
        const dy = stack.pop(), dx = stack.pop()
        if (typeof dx === "number" && typeof dy === "number") {
          // `Td` moves the line matrix by (dx, dy).  The gap between where the
          // pen actually ended and where the next run starts is a word space if
          // it exceeds ~0.1 em; smaller gaps are ordinary kerning.
          if (inText && dy === 0 && dx > 0 && lineBuf && !lineBuf.endsWith(" ")) {
            // `Td` advances the pen.  Compare the advance against the width of
            // the run just emitted: a clear excess is a word space, a small
            // difference is ordinary kerning.
            const expected = lastRunWidth
            // A word space is ~0.25 em and inter-glyph kerning stays below
            // ~0.13 em, but the two ranges overlap.  A multi-character run is a
            // whole word, so 0.1 em already separates its trailing space from
            // kerning.  A single-character run in a stream that also emits real
            // space glyphs is per-glyph layout, where the `Td` gap is kerning:
            // require a wider 0.13 em so words are not split ("w ere").
            const spaceEm = lastRunChars >= 2 || !sawExplicitSpaceGlyph ? 0.1 : 0.13
            if (expected > 0 && dx - expected > fontSize * spaceEm) pendingSpace = true
          }
          lineOriginX += dx
          tmX = lineOriginX
          tlmX += dx
          tlmY += dy; tmY = tlmY
          sawPosition = true
          if (op === "TD") tl = -dy
        }
        break
      }

      case "T*":
        tlmY -= tl; tmY = tlmY
        break

      case "Tj": {
        const raw = stack.pop()
        if (inText && typeof raw === "string") appendText(decodeString(raw), raw)
        break
      }

      case "TJ": {
        const arr = stack.pop()
        if (inText && Array.isArray(arr)) {
          // Handle both all-at-once (array contains one multi-glyph string)
          // and split forms (multiple single-glyph strings with kern numbers).
          // For CID fonts the common pattern is individual <glyphId> tokens.
          //
          // A negative number is a kerning adjustment in thousandths of an em.
          // Measured across generators the two populations are well separated:
          // intra-word kerning is ≤0.02 em, word gaps ≥0.19 em, with an empty
          // valley between.  0.1 em sits in that valley.
          let combined = ""
          let combinedRaw = ""
          // Total advance of the array in text space: glyph widths plus the
          // kern adjustments (which are in thousandths of an em).
          let advance = 0
          const font = resolveFont(fontName)
          const wmap = font?.widths
          // Set when a kern has just supplied a word space, so the font's own
          // space glyph at the start of the next string is not added on top of
          // it (see below).
          let kernSpace = false
          for (const item of arr) {
            if (typeof item === "string") {
              let s = decodeString(item)
              if (kernSpace && s.startsWith(" ")) s = s.slice(s.length - s.trimStart().length)
              kernSpace = false
              combined += s
              combinedRaw += item
              if (wmap) {
                advance += glyphWidth(item, wmap, font?.single ?? false)
              } else {
                advance += item.length * fontSize * 0.5
              }
            } else if (typeof item === "number") {
              advance += (item / 1000) * fontSize
              // A large negative kern is a word gap — but these word processors
              // often emit the font's space glyph *as well*, with the kern
              // making up the rest of the advance.  Adding a space on top of an
              // explicit one doubles it (`Witness  Tampering`).
              if (item < -100 && !combined.endsWith(" ")) {
                combined += " "
                kernSpace = true
              }
            }
          }
          if (combined) appendText(combined, combinedRaw, advance)
        }
        break
      }

      case "'": {
        tlmY -= tl; tmY = tlmY
        const raw = stack.pop()
        if (inText && typeof raw === "string") appendText(decodeString(raw), raw)
        break
      }

      case '"': {
        const raw = stack.pop()
        stack.pop(); stack.pop()
        tlmY -= tl; tmY = tlmY
        if (inText && typeof raw === "string") appendText(decodeString(raw), raw)
        break
      }

      // Graphics state save/restore.  The CTM matters because word processors
      // position each text run with `cm` and leave the text matrix at the
      // origin, so the raw text-space y is meaningless without it.
      case "q":
        ctmStack.push({ ...ctm })
        break

      case "Q":
        if (ctmStack.length > 0) ctm = ctmStack.pop()!
        break

      case "cm": {
        const f = stack.pop(), e = stack.pop()
        const d = stack.pop(), c = stack.pop()
        const b = stack.pop(), a = stack.pop()
        if (typeof a === "number" && typeof b === "number" && typeof c === "number" &&
            typeof d === "number" && typeof e === "number" && typeof f === "number") {
          // CTM' = M × CTM
          ctm = {
            a: a * ctm.a + b * ctm.c,
            b: a * ctm.b + b * ctm.d,
            c: c * ctm.a + d * ctm.c,
            d: c * ctm.b + d * ctm.d,
            e: e * ctm.a + f * ctm.c + ctm.e,
            f: e * ctm.b + f * ctm.d + ctm.f,
          }
        }
        stack.length = 0
        break
      }

      default:
        break
    }
  }

  // Flush the pending line unconditionally.  A text object that declares its
  // own position (`sawPosition`) is not flushed on `ET` — the flush is deferred
  // until the next run's y-position differs — so a stream whose last text
  // object declares a position and is followed by no further text would lose
  // its final line.  That is the last line of the page, which is real content
  // when the page ends on a body line (the Legislative History's
  // `Date of operation : 25 March 1992`).  `flushLine` is a no-op on an empty
  // buffer, so this cannot emit a spurious blank line.
  flushLine()
  return lines
}

/**
 * Resolve a stream's /Length entry to a byte count.  The value may be a literal
 * integer (`/Length 1234`) or an indirect reference (`/Length 511 0 R`), which
 * is common in PDF 1.5+ files.  Returns -1 when it cannot be determined.
 */
function resolveStreamLength(latin: string, dict: string): number {
  // Indirect reference first: /Length 511 0 R
  const indirect = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dict)
  if (indirect) {
    const objId = indirect[1]
    const om = new RegExp(`(?<![0-9])${objId}\\s+0\\s+obj\\s*(\\d+)`).exec(latin)
    if (om) return parseInt(om[1], 10)
    return -1
  }
  // Literal integer: /Length 1234 (must not be followed by more digits)
  const direct = /\/Length\s+(\d+)(?!\d)/.exec(dict)
  if (direct) return parseInt(direct[1], 10)
  return -1
}

/**
 * Expand a PDF 1.5 object stream (/Type /ObjStm).  The decompressed body starts
 * with N pairs of "objNum offset" integers, followed by the concatenated object
 * bodies.  Returns the concatenated bodies so that content streams packed inside
 * object streams can still be scanned.
 */
function expandObjStm(body: string, first: number, n: number): string {
  const header = body.slice(0, first)
  const nums = [...header.matchAll(/\d+/g)].map((x) => parseInt(x[0], 10))
  let out = ""
  for (let i = 0; i < n && i * 2 + 1 < nums.length; i++) {
    const off = nums[i * 2 + 1]
    const nextOff = i * 2 + 3 < nums.length ? nums[i * 2 + 3] : body.length - first
    out += body.slice(first + off, first + nextOff) + "\n"
  }
  return out
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Extract human-readable text from a PDF file buffer. Returns "" if none. */
export function extractPdfText(buffer: Buffer, opts?: { tables?: boolean }): string {
  const streamLines = extractDocumentLines(buffer)
  if (streamLines.length === 0) return ""
  const rendered = streamLines.map((ls) =>
    opts?.tables ? renderTables(ls) : renderPlainText(ls),
  )
  return rendered.join("\n\n").replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * Structured extraction, exposed for the table pass and tests: one array of
 * lines per content stream, each line carrying its runs' geometry.
 */
export function extractPdfStructured(buffer: Buffer): TextLine[][] {
  return extractDocumentLines(buffer)
}

/** Extract every content stream's structured lines, with headers deduped. */
function extractDocumentLines(buffer: Buffer): TextLine[][] {
  const latin = buffer.toString("latin1")

  // Build font CMap table once for the whole file
  let fontCMaps: Map<string, Map<number, string>>
  let singleByteFonts: Set<string>
  let fontWidths: Map<string, Map<number, number>>
  let mathFontNames: Set<string>
  let fontByObjId: Map<number, ResolvedFont>
  try {
    const built = buildFontCMaps(latin)
    fontCMaps = built.cmaps
    singleByteFonts = built.singleByte
    fontWidths = built.widths
    mathFontNames = built.mathFonts
    fontByObjId = built.byObjId
  } catch {
    fontCMaps = new Map()
    singleByteFonts = new Set()
    fontWidths = new Map()
    mathFontNames = new Set()
    fontByObjId = new Map()
  }

  // Fallback resolver: global name→font map (correct when names are unique).
  const globalResolve = (name: string) => {
    const cmap = fontCMaps.get(name)
    const widths = fontWidths.get(name)
    if (!cmap && !widths) return undefined
    return {
      cmap: cmap ?? new Map<number, string>(),
      single: singleByteFonts.has(name),
      widths,
      mathFont: mathFontNames.has(name),
    }
  }


  /**
   * Build a resolver for one content stream.  Resource names are page-scoped, so
   * prefer the /Font dict of the page that owns this stream; fall back to the
   * global map when no page dict can be found.
   */
  const resolverForStream = (streamIdx: number) => {
    // Look back for the nearest page object's /Resources /Font dict.
    const window = latin.slice(Math.max(0, streamIdx - 8192), streamIdx)
    let fontDict: string | undefined
    for (const fm of window.matchAll(/\/Font\s*<<([\s\S]{1,4000}?)>>/g)) fontDict = fm[1]
    if (!fontDict) return globalResolve
    const local = new Map<string, ResolvedFont>()
    for (const em of fontDict.matchAll(/\/([A-Za-z][A-Za-z0-9_]*)\s+(\d+)\s+\d+\s+R/g)) {
      const f = fontByObjId.get(parseInt(em[2], 10))
      if (f) local.set(em[1], f)
    }
    if (local.size === 0) return globalResolve
    return (name: string) => local.get(name) ?? globalResolve(name)
  }

  const streamLines: TextLine[][] = []
  // Find real stream starts: "stream\r?\n" immediately preceded by the dict's
  // closing ">>".  A bare /stream\r?\n/ also matches the "stream\n" inside the
  // "endstream\n" keyword, which doubles the match count and makes the parser
  // read PDF syntax as if it were compressed stream data.
  const streamRe = />>\s*stream\r?\n/g
  let m: RegExpExecArray | null

  while ((m = streamRe.exec(latin)) !== null) {
    const start = m.index + m[0].length

    // Recover the stream's dictionary by reading forward from its "N G obj"
    // header.  (A non-greedy /<<([\s\S]*?)>>/ can start at a nested "<<" and
    // misread the dict, and a backward bracket walk is confused by binary data
    // in earlier streams.)
    const dict = readStreamDict(latin, m.index)

    // Skip non-content streams.  Content streams carry no /Subtype and no
    // /Length1; font programs and images do:
    //   - /Subtype /CIDFontType2, /TrueType, /Type1C, /Image, ...
    //   - /Length1 (and /Length2, /Length3) mark embedded font programs
    // These are binary and would otherwise be dumped as garbage.
    if (/\/Subtype\s*\//.test(dict) || /\/Length1\b/.test(dict)) continue

    // Prefer the declared /Length (literal or indirect); fall back to the next
    // "endstream" keyword.
    const declared = resolveStreamLength(latin, dict)
    let end: number
    if (declared >= 0) {
      end = start + declared
    } else {
      end = latin.indexOf("endstream", start)
      if (end === -1) break
    }

    // /Length gives the exact byte count, so take the slice verbatim — stripping
    // a trailing newline would corrupt the compressed data.
    const raw = latin.slice(start, end)
    let content: string
    try {
      content = zlib.inflateSync(Buffer.from(raw, "binary")).toString("latin1")
    } catch {
      // Not FlateDecode (or corrupt) — skip rather than emit raw binary.
      continue
    }

    // PDF 1.5 object streams pack other objects (including content streams)
    // into one compressed body.  Expand them and scan the contained objects.
    if (/\/Type\s*\/ObjStm/.test(dict)) {
      const firstM = /\/First\s+(\d+)/.exec(dict)
      const nM = /\/N\s+(\d+)/.exec(dict)
      if (firstM && nM) {
        const expanded = expandObjStm(content, parseInt(firstM[1], 10), parseInt(nM[1], 10))
        if (/\b(BT|Tj|TJ|Tf|Td|TD|Tm|T\*)\b/.test(expanded)) {
          const ls = extractTextWithResolver(expanded, resolverForStream(m.index))
          if (renderPlainText(ls).trim()) streamLines.push(ls)
        }
      }
      continue
    }

    // Guard against non-content streams that slip past the dict checks (e.g.
    // ICC colour profiles, which carry no /Subtype and no /Length1).  A real
    // content stream contains text operators; binary blobs do not.
    if (!/\b(BT|Tj|TJ|Tf|Td|TD|Tm|T\*)\b/.test(content)) continue

    const ls = extractTextWithResolver(content, resolverForStream(m.index))
    if (renderPlainText(ls).trim()) streamLines.push(ls)
  }

  if (streamLines.length === 0) return streamLines

  // ── Deduplicate page headers/footers ──────────────────────────────────────
  // A running head/footer repeats on every page, usually with only the page
  // number changing (e.g. "S 230/20091", "S 230/2009 2", ...).  Count lines by
  // a page-number-normalised form, once per stream, so those variants collapse
  // into a single entry and the frequency reflects how many pages carry it.
  //
  // Only lines near the top or bottom of a stream are eligible: a running
  // head/footer lives in the margin, whereas body content must never be
  // touched even when its shape repeats (a schedule of survey coordinates,
  // for instance, is full of near-identical numeric lines).
  const HEADER_WINDOW = 6
  const isMarginLine = (ls: TextLine[], idx: number): boolean =>
    idx < HEADER_WINDOW || idx >= ls.length - HEADER_WINDOW
  // A running head/footer repeats on every page, so even a two-page document
  // carries it twice.  The floor is 2 rather than 3 so a short instrument's
  // footer is stripped too: the last line of a page is now always flushed (see
  // `extractTextWithResolver`), which surfaced the "Informal Consolidation –
  // version in force from …" footer that had previously been dropped as the
  // final line.  Requiring the line on at least half the pages keeps the test
  // safe for a two-page document (both pages must carry it).
  if (streamLines.length >= 2) {
    // The page number can be appended ("S 230/2009 2"), glued to the head
    // ("S 230/20092") or sandwiched between two fixed numbers, as in the WICA
    // running head "Compensation Act 2019" + page + "2020 Ed." (a 9-digit blob
    // "201932020").  Drop trailing digits/whitespace and fold any remaining run
    // of 5+ digits to "#" so every page collapses to one key; the 5-digit floor
    // leaves ordinary citations ([Act 30 of 2024 wef 01/01/2025], S 694/2025)
    // untouched.
    const normalise = (l: string): string =>
      l.replace(/[\d\s]+$/, "").replace(/\d{5,}/g, "#")
    const streamFreq = new Map<string, number>()
    for (const ls of streamLines) {
      const seen = new Set<string>()
      for (let j = 0; j < ls.length; j++) {
        if (!isMarginLine(ls, j)) continue
        const l = renderPlainLine(ls[j])
        // Running heads can be short ("S 230/20091"), so the length floor is
        // low; the frequency test below is what prevents false positives.
        if (l.length < 6) continue
        const key = normalise(l)
        if (key.length < 4) continue
        if (seen.has(key)) continue
        seen.add(key)
        streamFreq.set(key, (streamFreq.get(key) ?? 0) + 1)
      }
    }
    const absThreshold = Math.max(2, Math.ceil(streamLines.length * 0.30))
    const headerKeys = new Set<string>(
      [...streamFreq.entries()].filter(([, freq]) => freq >= absThreshold).map(([l]) => l)
    )
    if (headerKeys.size > 0) {
      for (let i = 0; i < streamLines.length; i++) {
        const ls = streamLines[i]
        streamLines[i] = ls.filter((line, j) => {
          if (!isMarginLine(ls, j)) return true
          const t = renderPlainLine(line)
          // Never strip structural headings, which also end in a number.
          if (/^(PART|ARTICLE|DIVISION|CHAPTER|SCHEDULE)\b/i.test(t)) return true
          return !headerKeys.has(normalise(t))
        })
      }
    }
  }

  // ── Strip known generator boilerplate ─────────────────────────────────────
  // Singapore Statutes Online stamps a fixed footer on every page it renders:
  // "Informal Consolidation – version in force from <date>".  It is never
  // document content, but the frequency test above cannot catch it on a
  // single-page instrument (one page carries it once) or when only the first
  // page of a multi-page instrument carries it.  Match the exact prefix in the
  // margin and drop it unconditionally.
  const SSO_FOOTER = /^Informal Consolidation\s*[–-]\s*version in force from\b/
  for (let i = 0; i < streamLines.length; i++) {
    const ls = streamLines[i]
    streamLines[i] = ls.filter((line, j) => {
      if (!isMarginLine(ls, j)) return true
      return !SSO_FOOTER.test(renderPlainLine(line))
    })
  }

  return streamLines
}
