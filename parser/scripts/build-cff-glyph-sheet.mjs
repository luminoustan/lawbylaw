// Render the glyphs of an embedded CFF (FontFile3 / Type1C) subset font, one
// per row, labelled with the glyph name the PDF's /Differences array assigns
// it — for reliable visual identification.
//
// This is the CFF counterpart to build-math-glyph-sheet.mjs.  The Monotype
// `AdvP4C4E*` symbol fonts used by the legislation PDFs are non-Type1 CFF
// subsets with a broken name table, so the only way to learn what a glyph
// actually draws is to re-embed the program and render it.  Render the output
// with `pdftoppm` and read the glyphs off the image.
//
// Usage: node scripts/build-cff-glyph-sheet.mjs <pdf> <FontName> <out.pdf>
import fs from "node:fs"
import zlib from "node:zlib"

const [pdfPath, fontName, outPath] = process.argv.slice(2)
const buf = fs.readFileSync(pdfPath)
const latin = buf.toString("latin1")

const objs = new Map()
for (const m of latin.matchAll(/(\d+)\s+0\s+obj\b/g)) {
  const n = Number(m[1])
  const e = latin.indexOf("endobj", m.index)
  objs.set(n, latin.slice(m.index, e < 0 ? undefined : e))
}

/** Read the raw (inflated) bytes of a stream object. */
function streamBytes(dict) {
  const st = dict.indexOf("stream")
  let d0 = st + 6
  if (dict[d0] === "\r") d0++
  if (dict[d0] === "\n") d0++
  const e = dict.indexOf("endstream", d0)
  let data = Buffer.from(dict.slice(d0, e), "latin1")
  if (/\/FlateDecode/.test(dict)) {
    try {
      data = zlib.inflateSync(data)
    } catch {
      /* leave raw */
    }
  }
  return data
}

// Find the font object and its CFF program + encoding.
let fontDict = null
for (const [, d] of objs) {
  const bf = /\/BaseFont\s*\/([^\s/\]>]+)/.exec(d)
  if (bf && bf[1].includes(fontName) && /\/Subtype\s*\/Type1\b/.test(d)) {
    fontDict = d
    break
  }
}
if (!fontDict) {
  console.error("font not found:", fontName)
  process.exit(1)
}
const baseFont = /\/BaseFont\s*\/([^\s/\]>]+)/.exec(fontDict)[1]

// FontDescriptor -> FontFile3 -> CFF program
const fdRef = /\/FontDescriptor\s+(\d+)\s+0\s+R/.exec(fontDict)
const fd = fdRef ? objs.get(Number(fdRef[1])) : fontDict
const ffRef = /\/FontFile3\s+(\d+)\s+0\s+R/.exec(fd || "")
if (!ffRef) {
  console.error("no FontFile3 for", baseFont)
  process.exit(1)
}
const cff = streamBytes(objs.get(Number(ffRef[1])))

// /Differences -> [code, name] pairs (code and name may be glued: `1/C0`).
let diffs = ""
const encRef = /\/Encoding\s+(\d+)\s+0\s+R/.exec(fontDict)
if (encRef) {
  const eo = objs.get(Number(encRef[1])) || ""
  diffs = (/\/Differences\s*\[([^\]]*)\]/.exec(eo) || [, ""])[1]
} else {
  diffs = (/\/Differences\s*\[([^\]]*)\]/.exec(fontDict) || [, ""])[1]
}
const rows = []
{
  let code = null
  for (const t of diffs.replace(/(\d)(\/)/g, "$1 $2").trim().split(/\s+/)) {
    if (/^\d+$/.test(t)) {
      code = Number(t)
      continue
    }
    if (!t.startsWith("/")) continue
    // A run of names may be glued by slashes (`188/onequarter/onehalf`), each
    // taking the next code.
    for (const name of t.slice(1).split("/")) {
      if (!name) continue
      rows.push({ code, name })
      code++
    }
  }
}
if (!rows.length) {
  // No /Differences: render the font's built-in encoding over the printable
  // range.  Omit /Encoding so the viewer uses the font's own encoding.
  for (let c = 32; c <= 126; c++) rows.push({ code: c, name: `code${c}` })
}

// Build a sheet; page height grows with the row count.
const ROW = 22
const height = Math.max(792, 60 + rows.length * ROW)
let content = `BT /F2 12 Tf 40 ${height - 25} Td (${baseFont}  ${rows.length} glyphs) Tj ET\n`
rows.forEach((r, i) => {
  const y = height - 50 - i * ROW
  content += `BT /F2 10 Tf 40 ${y} Td (${r.name}) Tj ET\n`
  content += `BT /F2 10 Tf 150 ${y} Td (code ${r.code}) Tj ET\n`
  content += `BT /F1 18 Tf 230 ${y} Td <${r.code.toString(16).padStart(2, "0")}> Tj ET\n`
})

const objsOut = []
const push = (s) => objsOut.push(Buffer.from(s, "latin1"))
push(`<< /Type /Catalog /Pages 2 0 R >>`)
push(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`)
push(
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${height}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
)
push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
const enc = rows.some((r) => !r.name.startsWith("code"))
  ? ` /Encoding << /Differences [${rows.map((r) => `${r.code}/${r.name}`).join(" ")}] >>`
  : ""
push(
  `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} /FirstChar 0 /LastChar 255 /Widths [${Array(256).fill(600).join(" ")}]${enc} /FontDescriptor 7 0 R >>`,
)
push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`)
push(
  `<< /Type /FontDescriptor /FontName /${baseFont} /Flags 4 /FontBBox [-1000 -500 2000 1000] /ItalicAngle 0 /Ascent 750 /Descent -250 /CapHeight 700 /StemV 80 /FontFile3 8 0 R >>`,
)
objsOut.push(
  Buffer.concat([
    Buffer.from(`<< /Length ${cff.length} /Subtype /Type1C >>\nstream\n`, "latin1"),
    cff,
    Buffer.from(`\nendstream`, "latin1"),
  ]),
)

const header = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")
const chunks = [header]
const offsets = []
let cursor = header.length
objsOut.forEach((body, i) => {
  offsets.push(cursor)
  const piece = Buffer.concat([
    Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
    body,
    Buffer.from("\nendobj\n", "latin1"),
  ])
  chunks.push(piece)
  cursor += piece.length
})
let xref = `xref\n0 ${objsOut.length + 1}\n0000000000 65535 f \n`
for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`
xref += `trailer\n<< /Size ${objsOut.length + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`
chunks.push(Buffer.from(xref, "latin1"))
fs.writeFileSync(outPath, Buffer.concat(chunks))
console.log(`wrote ${outPath} for ${baseFont} (${rows.length} glyphs)`)
