import { describe, expect, it } from "vitest"
import { enrichWithCitations, sanitizeCitations } from "./citations"

const ITA = "https://sso.agc.gov.sg/Act/ITA1947?ProvIds=pr13-"
const SL_URL = "https://sso.agc.gov.sg/SL/CONS1963-S23-2023?DocDate=20260130&ProvIds=pr19-"
const SL_NAME = "Public Service (Disciplinary Proceedings) Regulations 2023"

const cits = sanitizeCitations([
  { act_name: "Income Tax Act 1947", section: "13", label: "s.13", url: ITA, doc_type: "act" },
  { act_name: SL_NAME, section: "19", label: "x", url: SL_URL, doc_type: "subsidiary_legislation" },
])

describe("range references get one link after the whole reference", () => {
  it("does not split 'Section 13(7A)–(8)'", () => {
    const out = enrichWithCitations("(b) Foreign-sourced income — Section 13(7A)–(8)", cits)
    expect(out).toBe(`(b) Foreign-sourced income — Section 13(7A)–(8) [SSO](${ITA})`)
  })

  it("covers hyphen ranges and comma/and lists of subsections", () => {
    expect(enrichWithCitations("See Section 13(7A)-(8).", cits)).toBe(`See Section 13(7A)-(8) [SSO](${ITA}).`)
    expect(enrichWithCitations("Under s. 13(1), (2) and (3) of the Act", cits)).toBe(
      `Under s. 13(1), (2) and (3) [SSO](${ITA}) of the Act`,
    )
  })

  it("does not swallow a following section reference", () => {
    const two = [...cits, { act_name: "Income Tax Act 1947", section: "14", label: "s.14", url: "https://sso.agc.gov.sg/Act/ITA1947?ProvIds=pr14-" }]
    const out = enrichWithCitations("Section 13 and Section 14 apply.", two)
    expect(out).toContain(`Section 13 [SSO](${ITA}) and Section 14 [SSO](`)
  })

  it("is stable when run twice", () => {
    const once = enrichWithCitations("Section 13(7A)–(8) applies.", cits)
    expect(enrichWithCitations(once, cits)).toBe(once)
  })
})

describe("subsidiary legislation links", () => {
  it("links 'regulation 19' when the document is named after it", () => {
    const out = enrichWithCitations(`Regulation 19 of the ${SL_NAME} requires an oral hearing.`, cits)
    expect(out).toContain(`Regulation 19 [SSO](${SL_URL}) of the ${SL_NAME}`)
  })

  it("links 'regulation 19' when the document is named before it", () => {
    const out = enrichWithCitations(`Under the ${SL_NAME}, regulation 19 applies.`, cits)
    expect(out).toContain(`regulation 19 [SSO](${SL_URL})`)
  })

  it("does not link subsidiary legislation without its name nearby", () => {
    const text = "Regulation 19 applies."
    expect(enrichWithCitations(text, cits)).toBe(text)
  })

  it("prefers the Act for 'section' and the SL for 'regulation' on a shared number", () => {
    const shared = sanitizeCitations([
      { act_name: "Income Tax Act 1947", section: "19", label: "a", url: "https://sso.agc.gov.sg/Act/ITA1947?ProvIds=pr19-", doc_type: "act" },
      { act_name: SL_NAME, section: "19", label: "b", url: SL_URL, doc_type: "subsidiary_legislation" },
    ])
    const text = `Section 19 of the Income Tax Act 1947 and regulation 19 of the ${SL_NAME}.`
    const out = enrichWithCitations(text, shared)
    expect(out).toContain("Section 19 [SSO](https://sso.agc.gov.sg/Act/ITA1947?ProvIds=pr19-)")
    expect(out).toContain(`regulation 19 [SSO](${SL_URL})`)
  })

  it("accepts the & joined provision URL", () => {
    expect(cits.some((c) => c.url === SL_URL)).toBe(true)
  })
})

describe("bare 's' abbreviation", () => {
  it("links 's 13', 's13' and 'ss 13' (no dot)", () => {
    expect(enrichWithCitations("Under s 13(1) of the Act", cits)).toBe(`Under s 13(1) [SSO](${ITA}) of the Act`)
    expect(enrichWithCitations("See s13.", cits)).toBe(`See s13 [SSO](${ITA}).`)
    expect(enrichWithCitations("Under ss 13 and 14", cits)).toContain(`ss 13 [SSO](${ITA})`)
  })

  it("does not link a possessive followed by a number", () => {
    const text = "Lina's 13 vans and Lina\u2019s 13 cars."
    expect(enrichWithCitations(text, cits)).toBe(text)
  })

  it("links a section cited from memory (server-built citation) next to its Act name", () => {
    const coa = sanitizeCitations([
      { act_name: "Companies Act 1967", section: "19", label: "s.19", url: "https://sso.agc.gov.sg/Act/CoA1967?ProvIds=pr19-", doc_type: "act" },
    ])
    const out = enrichWithCitations("Companies Act 1967, s 19(5) says so.", coa)
    expect(out).toBe("Companies Act 1967, s 19(5) [SSO](https://sso.agc.gov.sg/Act/CoA1967?ProvIds=pr19-) says so.")
  })
})

describe("schedules and number ranges", () => {
  const MC = "Companies (Model Constitutions) Regulations 2015"
  const MC_URL = "https://sso.agc.gov.sg/SL/CoA1967-S833-2015?DocDate=20241206&ProvIds=Sc1-"
  const sched = sanitizeCitations([
    { act_name: MC, section: "schedule1", label: "x", url: MC_URL, doc_type: "subsidiary_legislation" },
    { act_name: "Companies Act 1967", section: "schedule2", label: "x", url: "https://sso.agc.gov.sg/Act/CoA1967?ProvIds=Sc2-", doc_type: "act" },
    { act_name: SL_NAME, section: "19", label: "x", url: SL_URL, doc_type: "subsidiary_legislation" },
  ])

  it("links 'First Schedule' next to the regulations' name", () => {
    const out = enrichWithCitations(`${MC}, First Schedule, regulations 24\u201327 — transfer of shares.`, sched)
    expect(out).toContain(`First Schedule [SSO](${MC_URL}), regulations`)
  })

  it("links 'Schedule 2' of an Act only when its name is near", () => {
    expect(enrichWithCitations("Schedule 2 applies.", sched)).toBe("Schedule 2 applies.")
    expect(enrichWithCitations("The Companies Act 1967, Schedule 2 applies.", sched)).toContain(
      "Schedule 2 [SSO](https://sso.agc.gov.sg/Act/CoA1967?ProvIds=Sc2-)",
    )
  })

  it("does not link a schedule that has no citation, and is stable on a second run", () => {
    expect(enrichWithCitations(`${MC}, Third Schedule`, sched)).toBe(`${MC}, Third Schedule`)
    const once = enrichWithCitations(`${MC}, First Schedule.`, sched)
    expect(enrichWithCitations(once, sched)).toBe(once)
  })

  it("puts one link after a whole 'regulations 19\u201321' range", () => {
    const out = enrichWithCitations(`Regulations 19\u201321 of the ${SL_NAME} apply.`, sched)
    expect(out).toContain(`Regulations 19\u201321 [SSO](${SL_URL}) of the`)
  })
})

describe("false positives", () => {
  it("does not treat the end of a word as a section prefix", () => {
    const text = "This is a nuisance. 13 people came."
    expect(enrichWithCitations(text, cits)).toBe(text)
  })
})
