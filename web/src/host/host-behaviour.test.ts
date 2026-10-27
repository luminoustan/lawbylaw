import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_LIMITS, WebHost } from "./web-host"
import { openStorage } from "./storage"

/**
 * Turn lifecycle under real user behaviour: stopping a reply, deleting a chat
 * mid-reply, sending from a second chat while the first is still generating,
 * and answering an askquestion form. Each of these used to leave state behind
 * (an error banner, a resurrected chat, a dock pointing at another session).
 */

type Emitted = Record<string, any>

const enc = new TextEncoder()
const streamOf = (chunks: string[], hang = false) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((x) => c.enqueue(enc.encode(x)))
      if (!hang) c.close()
    },
  })

const sse = (frames: unknown[], hang = false) =>
  new Response(streamOf(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`), hang), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const limits = () =>
  new Response(JSON.stringify(DEFAULT_LIMITS), { status: 200, headers: { "content-type": "application/json" } })

const rejected = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), { status })

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition never became true")
    await new Promise((r) => setTimeout(r, 5))
  }
}

function harness(chat: (call: number) => Response) {
  const events: Emitted[] = []
  const bodies: any[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/limits")) return limits()
    bodies.push(JSON.parse(String(init?.body ?? "{}")))
    return chat(bodies.length)
  }) as unknown as typeof fetch
  const host = new WebHost((m) => events.push(m as Emitted), { fetchImpl })
  const of = (t: string) => events.filter((e) => e.type === t)
  const sessions = () => of("sessionCreated").map((e) => e.session.id as string)
  return { host, events, bodies, of, sessions }
}

beforeEach(async () => {
  await (await openStorage()).clear()
})

describe("stopping a reply", () => {
  it("closes the turn as interrupted instead of reporting a failure", async () => {
    const { host, of, sessions } = harness(() => sse([], true))
    const turn = host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })
    await until(() => sessions().length === 1)

    await host.handle({ type: "abort", sessionID: sessions()[0]! })
    await turn

    expect(of("sendMessageFailed")).toEqual([])
    expect(of("sessionTurnClosed").map((e) => e.reason)).toEqual(["interrupted"])
  })

  it("honours a stop that arrives while the prompt is still being saved", async () => {
    const { host, of } = harness(() => sse([], true))
    await (host as any).ready
    const storage = (host as any).storage
    const save = storage.save.bind(storage)
    let stopped = false
    storage.save = async (chat: { id: string; messages: unknown[] }) => {
      // The user presses Stop after sending, before the reply has started.
      if (!stopped && chat.messages.length > 0) {
        stopped = true
        await host.handle({ type: "abort", sessionID: chat.id })
      }
      return save(chat)
    }
    const started = Date.now()
    await host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })

    expect(stopped).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000) // not the idle watchdog's 35 s
    expect(of("sendMessageFailed")).toEqual([])
    expect(of("sessionTurnClosed").map((e) => e.reason)).toEqual(["interrupted"])
  })

  it("drops an error event that races the stop", async () => {
    // The server reports a problem and the user hits Stop in the same tick.
    const { host, of, sessions } = harness(() => sse([{ type: "error", error: "The assistant ran into a problem." }], true))
    const turn = host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })
    await until(() => of("messageCreated").length === 1)

    await host.handle({ type: "abort", sessionID: sessions()[0]! })
    await turn

    expect(of("sendMessageFailed")).toEqual([])
    expect(of("sessionTurnClosed").map((e) => e.reason)).toEqual(["interrupted"])
  })
})

describe("SSO links on a stopped reply", () => {
  const cit = (section: string) => ({
    act_name: "Companies Act 1967",
    section,
    label: `s.${section}`,
    url: `https://sso.agc.gov.sg/Act/CoA1967?ProvIds=pr${section}-`,
    doc_type: "act",
  })

  async function stopAfter(frames: unknown[]) {
    const { host, of, sessions } = harness(() => sse(frames, true))
    const turn = host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })
    await until(() => of("messageCreated").length === 1)
    await new Promise((r) => setTimeout(r, 50)) // let the frames be read
    await host.handle({ type: "abort", sessionID: sessions()[0]! })
    await turn
    const msg = of("messageCreated").slice(-1)[0]!.message
    expect(msg.finish).toBe("aborted")
    return msg.parts.filter((p: any) => p.type === "text").map((p: any) => p.text as string).join("")
  }

  it("still links the references written before the stop", async () => {
    const text = await stopAfter([
      { type: "legislation_citations", citations: [cit("19"), cit("1")] },
      { type: "token", content: "Under Section 19(5) of the Companies Act 1967 the company is a body corporate. See also s 1" },
    ])
    expect(text).toContain("Section 19(5) [SSO](https://sso.agc.gov.sg/Act/CoA1967?ProvIds=pr19-) of the")
  })

  it("does not link a reference that the stop cut in half", async () => {
    // "s 1" is the start of "s 19(5)": linking it would point at section 1.
    const text = await stopAfter([
      { type: "legislation_citations", citations: [cit("19"), cit("1")] },
      { type: "token", content: "Companies Act 1967, s 1" },
    ])
    expect(text).toBe("Companies Act 1967, s 1")
  })

  it("links citations that arrive after the text has started streaming", async () => {
    const text = await stopAfter([
      { type: "token", content: "Companies Act 1967, s 19(5) says so." },
      { type: "legislation_citations", citations: [cit("19")] },
    ])
    expect(text).toContain("s 19(5) [SSO](https://sso.agc.gov.sg/Act/CoA1967?ProvIds=pr19-)")
  })
})

describe("deleting a chat mid-reply", () => {
  it("stops quietly and is not resurrected by the finishing turn", async () => {
    const { host, of, sessions } = harness(() => sse([], true))
    const turn = host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })
    await until(() => sessions().length === 1)
    const doomed = sessions()[0]!

    await host.handle({ type: "deleteSession", sessionID: doomed })
    await turn

    expect(of("sendMessageFailed")).toEqual([])
    expect(of("sessionTurnClosed")).toEqual([])

    await host.handle({ type: "loadSessions" })
    const listed = of("sessionsLoaded").slice(-1)[0]!.sessions.map((s: any) => s.id)
    expect(listed).not.toContain(doomed)
  })
})

describe("sending from a second chat while the first is generating", () => {
  it("blames the session that sent, not the one that is running", async () => {
    const { host, of, sessions } = harness((call) =>
      call === 1
        ? sse([], true)
        : rejected(429, "too_many_streams", "A reply is already being generated. Please wait for it to finish."),
    )
    const running = host.handle({ type: "sendMessage", text: "one", messageID: "m1" })
    await until(() => sessions().length === 1)
    const first = sessions()[0]!

    await host.handle({ type: "createSession" })
    const second = sessions()[1]!

    await host.handle({ type: "sendMessage", sessionID: second, text: "two", messageID: "m2" })
    const failures = of("sendMessageFailed")
    expect(failures).toHaveLength(1)
    expect(failures[0]!.sessionID).toBe(second)
    expect(String(failures[0]!.error)).toContain("already being generated")

    await host.handle({ type: "abort", sessionID: first })
    await running
  })
})

describe("answering an askquestion form", () => {
  it("tags the request with its session and sends the answers as the next turn", async () => {
    const questions = [{ id: "amount", prompt: "How much is owed?", options: [] }]
    const { host, bodies, of, sessions } = harness(() =>
      sse([
        { type: "questionRequest", requestId: "q1", questions },
        { type: "done" },
      ]),
    )

    await host.handle({ type: "sendMessage", text: "Someone owes me money.", messageID: "m1" })
    const asked = of("questionRequest")[0]!
    expect(asked.sessionID).toBe(sessions()[0]!)

    await host.handle({ type: "questionReply", requestId: "q1", answers: [["$5,000"]] })
    expect(bodies).toHaveLength(2)
    const messages = bodies[1]!.messages as { role: string; content: string }[]
    const last = messages[messages.length - 1]!
    expect(last.content).toContain("[Answers to your questions]")
    expect(last.content).toContain("$5,000")
  })

  it("queues the answer until the asking turn closes", async () => {
    const questions = [{ id: "amount", prompt: "How much is owed?", options: [] }]
    const { host, bodies, of, sessions } = harness((call) =>
      call === 1
        ? sse([{ type: "questionRequest", requestId: "q1", questions }], true)
        : sse([{ type: "done" }]),
    )

    const turn = host.handle({ type: "sendMessage", text: "Someone owes me money.", messageID: "m1" })
    await until(() => of("questionRequest").length === 1)

    // The form appears before the asking turn has finished streaming.
    await host.handle({ type: "questionReply", requestId: "q1", answers: [["$5,000"]] })
    expect(bodies).toHaveLength(1)

    await host.handle({ type: "abort", sessionID: sessions()[0]! })
    await turn

    expect(bodies).toHaveLength(2)
    const messages = bodies[1]!.messages as { role: string; content: string }[]
    expect(messages[messages.length - 1]!.content).toContain("[Answers to your questions]")
  })

  it("ignores a reply for a question that is no longer pending", async () => {
    const { host, bodies } = harness(() => sse([{ type: "done" }]))
    await host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })
    await host.handle({ type: "questionReply", requestId: "stale", answers: [["x"]] })
    expect(bodies).toHaveLength(1)
  })
})

describe("prompts the client refuses before reaching the server", () => {
  it("rejects an over-long message", async () => {
    const { host, bodies, of } = harness(() => sse([{ type: "done" }]))
    await host.handle({ type: "sendMessage", text: "z".repeat(DEFAULT_LIMITS.message_chars + 1), messageID: "m1" })
    expect(bodies).toEqual([])
    expect(String(of("sendMessageFailed")[0]!.error)).toContain("too long")
  })

  it("rejects a send while offline", async () => {
    const { host, bodies, of } = harness(() => sse([{ type: "done" }]))
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true })
    try {
      await host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })
    } finally {
      delete (navigator as unknown as Record<string, unknown>).onLine
    }
    expect(bodies).toEqual([])
    expect(String(of("sendMessageFailed")[0]!.error)).toContain("offline")
  })

  it("never runs two turns for the same session at once", async () => {
    const { host, bodies, sessions } = harness(() => sse([], true))
    const first = host.handle({ type: "sendMessage", text: "one", messageID: "m1" })
    await until(() => sessions().length === 1)
    const sid = sessions()[0]!

    await host.handle({ type: "sendMessage", sessionID: sid, text: "two", messageID: "m2" })
    expect(bodies).toHaveLength(1)

    await host.handle({ type: "abort", sessionID: sid })
    await first
  })
})

describe("reloading while a reply is generating", () => {
  it("keeps the prompt the user already sent", async () => {
    const before = harness(() => sse([], true))
    const turn = before.host.handle({ type: "sendMessage", text: "What does the Employment Act say?", messageID: "m1" })
    await until(() => before.of("sessionStatus").length === 1)
    const sid = before.sessions()[0]!

    // A reload is a brand-new host reading the same IndexedDB.
    const after = harness(() => sse([{ type: "done" }]))
    await after.host.handle({ type: "loadMessages", sessionID: sid })
    const loaded = after.of("messagesLoaded").slice(-1)[0]!.messages as { role: string; parts: { text?: string }[] }[]
    expect(loaded.map((m) => m.role)).toEqual(["user"])
    expect(loaded[0]!.parts[0]!.text).toContain("Employment Act")

    await before.host.handle({ type: "abort", sessionID: sid })
    await turn
  })
})

describe("subagent transcripts", () => {
  it("keeps the final report whole instead of cutting it off", async () => {
    const output = `## Findings\n\n${"section text ".repeat(1400)}END-OF-REPORT`
    const { host, of } = harness(() =>
      sse([
        { type: "tool_call", id: "c1", name: "research_legislation", arguments: { prompt: "deposit" } },
        {
          type: "subagent_start",
          task_id: "c1",
          tool: "research_legislation",
          description: "Legislation research",
          subagent_type: "legislation",
          prompt: "deposit",
        },
        { type: "subagent_end", task_id: "c1", is_error: false, output },
        { type: "tool_result", name: "research_legislation", result: "found" },
        { type: "token", content: "ok" },
        { type: "done" },
      ]),
    )
    await host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })

    const textPart = of("partUpdated")
      .map((e) => e.part as { type?: string; text?: string })
      .find((p) => p?.type === "text" && p.text?.includes("END-OF-REPORT"))
    expect(textPart?.text).toBe(output)
  })
})

describe("reranker queue notices", () => {
  const taskTitles = (of: (t: string) => any[]) =>
    of("partUpdated")
      .map((e) => e.part as { tool?: string; state?: { title?: string } })
      .filter((p) => p?.tool === "task")
      .map((p) => p.state?.title)

  it("shows the wait on the research row and clears it afterwards", async () => {
    const { host, of } = harness(() =>
      sse([
        { type: "tool_call", id: "c1", name: "research_legislation", arguments: { prompt: "deposit" } },
        { type: "queue", task_id: "c1", waiting: 3, eta_s: 5 },
        { type: "queue", task_id: "c1", waiting: 0, eta_s: 0 },
        { type: "token", content: "ok" },
        { type: "done" },
      ]),
    )
    await host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })
    const titles = taskTitles(of)
    const busy = titles.indexOf("Legislation research — busy, 3 searches waiting (~5s)")
    expect(busy).toBeGreaterThanOrEqual(0)
    expect(titles[busy + 1]).toBe("Legislation research")
  })

  it("shows a database timeout on the research row and clears it on the next success", async () => {
    const { host, of } = harness(() =>
      sse([
        { type: "tool_call", id: "c1", name: "research_judiciary", arguments: { prompt: "case" } },
        { type: "db_slow", task_id: "c1", timeout_s: 8 },
        { type: "db_slow", task_id: "c1", timeout_s: 0 },
        { type: "token", content: "ok" },
        { type: "done" },
      ]),
    )
    await host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })
    const titles = taskTitles(of)
    const slow = titles.indexOf("Judiciary research — database busy, no answer within 8s; retrying")
    expect(slow).toBeGreaterThanOrEqual(0)
    expect(titles[slow + 1]).toBe("Judiciary research")
  })

  it("ignores database timeout events for tasks that are not running", async () => {
    const { host, of } = harness(() => sse([{ type: "db_slow", task_id: "nope", timeout_s: 8 }, { type: "done" }]))
    await host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })
    expect(taskTitles(of)).toEqual([])
  })

  it("ignores queue events for tasks that are not running", async () => {
    const { host, of } = harness(() => sse([{ type: "queue", task_id: "nope", waiting: 2, eta_s: 3 }, { type: "done" }]))
    await host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })
    expect(taskTitles(of)).toEqual([])
  })
})

describe("answer streaming and retraction", () => {
  it("streams the answer token by token, then retracts it when the check rewrites it", async () => {
    const { host, of } = harness(() =>
      sse([
        { type: "token", content: "Draft " },
        { type: "token", content: "answer." },
        { type: "answer_reset" },
        { type: "token", content: "Corrected answer." },
        { type: "done" },
      ]),
    )
    await host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })

    const deltas = of("partUpdated").filter((e) => e.delta?.type === "text-delta")
    expect(deltas.map((e) => e.delta.textDelta)).toEqual(["Draft ", "answer.", "Corrected answer."])
    const removed = of("partRemoved")
    expect(removed).toHaveLength(1)
    expect(removed[0]!.partID).toBe(deltas[0]!.part.id)
    expect(deltas[2]!.part.id).not.toBe(deltas[0]!.part.id)
  })

  it("can retract a draft that is followed by verification tool calls", async () => {
    const { host, of } = harness(() =>
      sse([
        { type: "token", content: "Draft answer." },
        { type: "tool_call", id: "c1", name: "get_section", arguments: {} },
        { type: "tool_result", id: "c1", name: "get_section", result: "text" },
        { type: "answer_reset" },
        { type: "token", content: "Revised." },
        { type: "done" },
      ]),
    )
    await host.handle({ type: "sendMessage", text: "hello", messageID: "m1" })
    const first = of("partUpdated").find((e) => e.delta?.textDelta === "Draft answer.")!
    expect(of("partRemoved").map((e) => e.partID)).toEqual([first.part.id])
  })
})

describe("the UI/host protocol", () => {
  it("answers uiReady with one `ready` and requestConfig with the server limits", async () => {
    const { host, events, of } = harness(() => sse([]))
    await host.handle({ type: "uiReady" })
    await host.handle({ type: "requestConfig" })
    expect(of("ready")).toHaveLength(1)
    const cfg = of("configLoaded")[0]!
    expect(cfg.config.limits.message_chars).toBe(DEFAULT_LIMITS.message_chars)
    // Nothing left over from the editor-extension protocol is announced any more.
    for (const legacy of ["connectionState", "extensionDataReady", "agentsLoaded", "providersLoaded", "commandsLoaded", "configUpdated"]) {
      expect(events.some((e) => e.type === legacy), legacy).toBe(false)
    }
  })

  it("ignores messages that are no longer part of the protocol", async () => {
    const { host, events } = harness(() => sse([]))
    await host.handle({ type: "uiReady" })
    const before = events.length
    for (const type of ["requestAgents", "requestProviders", "requestCommands", "updateConfig", "copyToClipboard", "readClipboard", "sendCommand"]) {
      await host.handle({ type })
    }
    expect(events.length).toBe(before)
  })
})
