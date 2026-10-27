// Render a list of specific glyph codes from an embedded Type1 font, one per
// row, with a printed decimal label — for reliable visual identification.
//
// This is how the tables in `pdf/tex-math-fonts.ts` were built: the embedded
// LaTeX math fonts carry a broken /ToUnicode (an ASCII identity map), and their
// glyph names were rewritten, so the only way to learn what a code draws is to
// re-embed the font program and render it.  Render the output with `pdftoppm`
// and read the glyphs off the image, then record them in the table.
//
// Usage: node scripts/build-math-glyph-sheet.mjs <pdf> <FontName> <out.pdf> <c1,c2,...>
import fs from "node:fs"
import zlib from "node:zlib"

const [pdfPath, fontName, outPath, codeList] = process.argv.slice(2)
const codes = codeList.split(",").map(Number)
const buf = fs.readFileSync(pdfPath)
const latin = buf.toString("latin1")

let program = null
let pos = 0
while (pos < latin.length) {
  const st = latin.indexOf("stream", pos)
  if (st === -1) break
  const header = latin.slice(Math.max(0, st - 400), st)
  let d0 = st + 6
  if (buf[d0] === 0x0d) d0++
  if (buf[d0] === 0x0a) d0++
  const end = latin.indexOf("endstream", d0)
  if (end === -1) break
  let data = buf.slice(d0, end)
  pos = end + 9
  if (!/FlateDecode/.test(header)) continue
  try { data = zlib.inflateSync(data) } catch { continue }
  const txt = data.toString("latin1")
  if (txt.startsWith("%!PS-AdobeFont") && txt.includes(`/FontName /${fontName} `)) { program = data; break }
}
if (!program) { console.error("font program not found:", fontName); process.exit(1) }
const length1 = program.indexOf("currentfile eexec") + "currentfile eexec\n".length

let content = `BT /F2 12 Tf 40 770 Td (${fontName}) Tj ET\n`
codes.forEach((c, i) => {
  const y = 745 - i * 24
  content += `BT /F2 11 Tf 40 ${y} Td (code ${c}) Tj ET\n`
  content += `BT /F1 20 Tf 160 ${y} Td <${c.toString(16).padStart(2, "0")}> Tj ET\n`
})

const objs = []
const push = (s) => objs.push(Buffer.from(s, "latin1"))
push(`<< /Type /Catalog /Pages 2 0 R >>`)
push(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`)
push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`)
push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
push(`<< /Type /Font /Subtype /Type1 /BaseFont /${fontName} /FirstChar 1 /LastChar 139 /Widths [${Array(139).fill(600).join(" ")}] /FontDescriptor 7 0 R >>`)
push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`)
push(`<< /Type /FontDescriptor /FontName /${fontName} /Flags 4 /FontBBox [-800 -500 1600 1000] /ItalicAngle 0 /Ascent 750 /Descent -250 /CapHeight 700 /StemV 80 /FontFile 8 0 R >>`)
objs.push(Buffer.concat([
  Buffer.from(`<< /Length ${program.length} /Length1 ${length1} >>\nstream\n`, "latin1"),
  program,
  Buffer.from(`\nendstream`, "latin1"),
]))

const header = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")
const chunks = [header]
const offsets = []
let cursor = header.length
objs.forEach((body, i) => {
  offsets.push(cursor)
  const piece = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")])
  chunks.push(piece)
  cursor += piece.length
})
let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`
xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`
chunks.push(Buffer.from(xref, "latin1"))
fs.writeFileSync(outPath, Buffer.concat(chunks))
console.log("wrote", outPath, "for", codes.length, "codes")
