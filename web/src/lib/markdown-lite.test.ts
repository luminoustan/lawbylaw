import { describe, expect, it } from "vitest"
import { renderMarkdown } from "./markdown-lite"

describe("ordered lists keep their own numbers", () => {
  it("does not renumber a statutory section to 1.", () => {
    const html = renderMarkdown("17. Judgment recovered against any person liable.")
    expect(html).toContain('<ol start="17">')
    expect(html).toContain('<li value="17">')
  })

  it("keeps numbering across interrupted lists", () => {
    const html = renderMarkdown("5. first\n\nSome text\n\n6. second")
    expect(html).toContain('<ol start="5">')
    expect(html).toContain('<ol start="6">')
  })

  it("leaves bullet lists alone", () => {
    expect(renderMarkdown("- a\n- b")).toContain("<ul><li>a</li><li>b</li></ul>")
  })
})

describe("table cells", () => {
  const table = (cell: string) => renderMarkdown(`| A | B |\n| --- | --- |\n| x | ${cell} |`)

  it("do not double-escape quotes and apostrophes", () => {
    const html = table(`"relevant person" and Registrar's Circular`)
    expect(html).not.toContain("&amp;quot;")
    expect(html).not.toContain("&amp;#39;")
    expect(html).toContain("&quot;relevant person&quot;")
    expect(html).toContain("Registrar&#39;s Circular")
  })

  it("still escape markup and keep emphasis and links", () => {
    const html = table("<b>x</b> **bold** [s](https://sso.agc.gov.sg/Act/X)")
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;")
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<a ")
  })
})

describe("images and editor-only markers are never turned into elements", () => {
  it("shows an image as its alt text and loads nothing", () => {
    const html = renderMarkdown("See ![the s 5 diagram](https://evil.example/track.png) here")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("evil.example")
    expect(html).toContain("the s 5 diagram")
  })

  it("keeps hostile alt text inert", () => {
    const html = renderMarkdown('![<script>alert(1)</script>](x.png)')
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("leaves [File: ...] and [Video: ...] as plain text", () => {
    const html = renderMarkdown("[File: a/b.ts] and [Video: c.mp4]")
    expect(html).not.toContain("dsm-md-file-pill")
    expect(html).not.toContain("<video")
  })
})

describe("Singapore Statutes Online links", () => {
  const url = "https://sso.agc.gov.sg/Act/EA1893?ProvIds=pr13-"

  it("reads 'link', not 'SSO', and still opens the cited page", () => {
    const html = renderMarkdown(`Section 13 [SSO](${url}) applies.`)
    expect(html).toMatch(/<a [^>]*class="dsm-sso-link"[^>]*>link<\/a>/)
    expect(html).toContain(`data-href="${url}"`)
    expect(html).not.toContain("SSO ")
    expect(html).not.toContain("\u2197")
  })

  it("only gives the pill to the real site; another link keeps its own label", () => {
    expect(renderMarkdown("[SSO](https://example.com/x)")).not.toContain("dsm-sso-link")
    expect(renderMarkdown("[the Act](https://sso.agc.gov.sg/Act/X)")).not.toContain("dsm-sso-link")
  })
})
