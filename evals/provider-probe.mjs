// Provider compatibility probe: does an OpenAI-compatible endpoint accept the exact request
// shapes lawbylaw's agent loop sends? Pinned to ONE model; never prints the key.
//
//   NEBIUS_API_KEY=... node provider-probe.mjs          # reads the key from the environment
//
// Mirrors server/src/services/deepseek.rs: streaming chat with `stream_options.include_usage`,
// the DeepSeek-only `thinking` field, tool calls assembled from indexed fragments,
// `tool_choice: "auto"`, `max_tokens: 65536`, temperature 0 / top_p 0.9, and cache-token usage.
const BASE = process.env.PROBE_BASE || "https://api.tokenfactory.nebius.com/v1";
const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash"; // pinned on purpose: do not make this configurable
const KEY = process.env.NEBIUS_API_KEY;
if (!KEY) { console.error("NEBIUS_API_KEY not set"); process.exit(2); }

const results = [];
const redact = (s) => String(s).split(KEY).join("[redacted-key]");
async function step(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Math.round(performance.now() - t0), detail });
    console.log(`✓ ${name} (${Math.round(performance.now() - t0)}ms) ${detail ?? ""}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Math.round(performance.now() - t0), detail: redact(e.message) });
    console.log(`✗ ${name}: ${redact(e.message)}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

// Nebius ignores DeepSeek's `thinking:{type:"disabled"}` and reasons anyway (see step 3b), so
// the app must send this instead. `raw` skips it for the steps that test the other switches.
const THINK_OFF = { reasoning_effort: "none" };
async function call(body, { key = KEY, origin, raw } = {}) {
  return fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...(origin ? { origin } : {}) },
    body: JSON.stringify({ model: MODEL, ...(raw ? {} : THINK_OFF), ...body }),
  });
}
async function json(res) {
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt);
}
/** Parse an SSE body into data frames, the way stream_inner does. */
async function sse(res) {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const frames = []; let firstByte = null, firstToken = null; const t0 = performance.now();
  const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await rd.read(); if (done) break;
    firstByte ??= performance.now() - t0;
    buf += dec.decode(value, { stream: true });
    let k; while ((k = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim(); if (data === "[DONE]") continue;
      try { const f = JSON.parse(data); frames.push(f); if (f.choices?.[0]?.delta?.content && firstToken === null) firstToken = performance.now() - t0; } catch {}
    }
  }
  return { frames, firstByte, firstToken };
}

const TOOL = { type: "function", function: { name: "get_section", description: "Fetch the text of a section of a Singapore Act.",
  parameters: { type: "object", properties: { act: { type: "string" }, section: { type: "string" } }, required: ["act", "section"] } } };

await step("1. models: pinned model is listed", async () => {
  const d = await json(await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${KEY}` } }));
  assert(d.data.some((m) => m.id === MODEL), `${MODEL} not listed`);
  return MODEL;
});

await step("2. plain completion, temperature 0, thinking off (reasoning_effort:none)", async () => {
  const d = await json(await call({ messages: [{ role: "user", content: "Reply with exactly the single word: pong" }], temperature: 0, max_tokens: 20 }));
  const text = d.choices[0].message.content;
  assert(/pong/i.test(text), `unexpected reply: ${JSON.stringify(text)}`);
  assert(!(d.usage?.reasoning_tokens > 0), `still reasoning: ${d.usage?.reasoning_tokens} tokens`);
  assert(d.model?.toLowerCase().includes("v4.1-flash"), `served model is ${d.model}`);
  return `reply=${JSON.stringify(text.trim())} served_model=${d.model} usage=${JSON.stringify(d.usage)}`;
});

await step("3. app payload: DeepSeek-only `thinking:{type:disabled}` accepted", async () => {
  const d = await json(await call({ thinking: { type: "disabled" }, messages: [{ role: "user", content: "Say hi in one word." }], temperature: 0, top_p: 0.9, max_tokens: 20 }, { raw: true }));
  const m = d.choices[0].message;
  return `accepted; content=${JSON.stringify((m.content || "").trim())} reasoning_content=${m.reasoning_content ? "PRESENT" : "absent"}`;
});

// `thinking:{type:"disabled"}` is DeepSeek's own switch. A provider may accept it silently and
// still reason (spending max_tokens and latency on hidden reasoning). Measure each candidate.
const THINKING_OFF = {
  "none (baseline)": {},
  "thinking:{type:disabled}": { thinking: { type: "disabled" } },
  "chat_template_kwargs:{thinking:false}": { chat_template_kwargs: { thinking: false } },
  "chat_template_kwargs:{enable_thinking:false}": { chat_template_kwargs: { enable_thinking: false } },
  "reasoning_effort:none": { reasoning_effort: "none" },
  "reasoning_effort:low": { reasoning_effort: "low" },
  "reasoning:{enabled:false}": { reasoning: { enabled: false } },
};
const thinkingResults = {};
await step("3b. which switch turns thinking OFF (reasoning tokens ~0, answer in content)", async () => {
  const lines = [];
  for (const [label, extra] of Object.entries(THINKING_OFF)) {
    try {
      const res = await call({ ...extra, messages: [{ role: "user", content: "What is 17 times 23? Answer with just the number." }], temperature: 0, max_tokens: 400 }, { raw: true });
      const txt = await res.text();
      if (!res.ok) { thinkingResults[label] = { ok: false }; lines.push(`${label}: HTTP ${res.status} ${txt.slice(0, 80)}`); continue; }
      const d = JSON.parse(txt); const m = d.choices[0].message;
      const rt = d.usage?.completion_tokens_details?.reasoning_tokens ?? d.usage?.reasoning_tokens ?? 0;
      thinkingResults[label] = { ok: true, rt, content: (m.content || "").trim() };
      lines.push(`${label}: reasoning_tokens=${rt} reasoning_content=${m.reasoning_content ? "yes" : "no"} answer=${JSON.stringify((m.content || "").trim().slice(0, 30))}`);
    } catch (e) { lines.push(`${label}: ${redact(e.message)}`); }
  }
  console.log(lines.map((l) => "     " + l).join("\n"));
  const off = Object.entries(thinkingResults).filter(([k, v]) => k !== "none (baseline)" && v.ok && v.rt === 0 && /391/.test(v.content)).map(([k]) => k);
  assert(off.length > 0, "no tested switch disables thinking");
  return `working switch(es): ${off.join(" | ")}`;
});

await step("4. app payload: max_tokens=65536 accepted", async () => {
  const d = await json(await call({ messages: [{ role: "user", content: "Say hi in one word." }], temperature: 0, max_tokens: 65536 }));
  return `accepted; finish=${d.choices[0].finish_reason}`;
});

let streamUsage;
await step("5. streaming + stream_options.include_usage (incremental tokens, final usage)", async () => {
  const { frames, firstByte, firstToken } = await sse(await call({ stream: true, stream_options: { include_usage: true },
    messages: [{ role: "user", content: "Count from 1 to 12 separated by spaces." }], temperature: 0, top_p: 0.9, max_tokens: 100 }));
  const toks = frames.filter((f) => f.choices?.[0]?.delta?.content).length;
  streamUsage = frames.find((f) => f.usage)?.usage;
  assert(toks > 3, `only ${toks} content frames: not streaming incrementally`);
  assert(streamUsage, "no usage frame in stream");
  return `${toks} content frames, first byte ${Math.round(firstByte)}ms, first token ${Math.round(firstToken)}ms, usage=${JSON.stringify(streamUsage)}`;
});

await step("6. usage has the cache-token fields the app parses", async () => {
  const hit = streamUsage?.prompt_cache_hit_tokens, miss = streamUsage?.prompt_cache_miss_tokens;
  const alt = streamUsage?.prompt_tokens_details?.cached_tokens;
  return `prompt_cache_hit_tokens=${hit} prompt_cache_miss_tokens=${miss} prompt_tokens_details.cached_tokens=${alt} (${hit !== undefined ? "DeepSeek-style" : alt !== undefined ? "OpenAI-style" : "NONE: metrics need a fallback"})`;
});

let call1;
await step("7. streaming tool call: indexed fragments assemble into valid JSON args", async () => {
  const msgs = [{ role: "user", content: "What does section 5 of the Contracts Act say? Use the tool." }];
  const { frames } = await sse(await call({ stream: true, stream_options: { include_usage: true }, messages: msgs, tools: [TOOL], tool_choice: "auto", temperature: 0, top_p: 0.9, max_tokens: 200 }));
  const acc = {};
  for (const f of frames) for (const tc of f.choices?.[0]?.delta?.tool_calls || []) {
    const e = (acc[tc.index ?? 0] ||= { id: "", name: "", args: "" });
    if (tc.id) e.id = tc.id; if (tc.function?.name) e.name += tc.function.name; if (tc.function?.arguments) e.args += tc.function.arguments;
  }
  const calls = Object.values(acc);
  assert(calls.length >= 1, "model did not call the tool");
  const c = calls[0]; const args = JSON.parse(c.args);
  assert(c.name === "get_section" && c.id, `bad call ${JSON.stringify(c)}`);
  call1 = { msgs, c };
  return `id=${c.id.slice(0, 12)}… name=${c.name} args=${c.args} (${calls.length} call(s), ${frames.length} frames)`;
});

await step("8. tool result round trip: second round answers using the tool output", async () => {
  assert(call1, "needs step 7");
  const msgs = [...call1.msgs,
    { role: "assistant", content: null, tool_calls: [{ id: call1.c.id, type: "function", function: { name: call1.c.name, arguments: call1.c.args } }] },
    { role: "tool", tool_call_id: call1.c.id, content: "Section 5 (Contracts Act): A contract requires offer, acceptance and consideration. CANARY-TOKEN-7731." }];
  const { frames } = await sse(await call({ stream: true, stream_options: { include_usage: true }, messages: msgs, tools: [TOOL], tool_choice: "auto", temperature: 0, top_p: 0.9, max_tokens: 200 }));
  const text = frames.map((f) => f.choices?.[0]?.delta?.content || "").join("");
  assert(text.length > 10, "empty final answer");
  return `answer=${JSON.stringify(text.slice(0, 90))}… uses_tool_output=${/consideration|offer|acceptance|7731/i.test(text)}`;
});

await step("9. prefix caching: repeating a long prompt yields cache hits", async () => {
  const long = "Singapore contract law background. ".repeat(400);
  const ask = () => call({ messages: [{ role: "system", content: long }, { role: "user", content: "Reply: ok" }], temperature: 0, max_tokens: 5 }).then(json);
  const a = await ask(); const b = await ask();
  const hit = (u) => u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? "n/a";
  return `1st hit=${hit(a.usage)} 2nd hit=${hit(b.usage)} of ${b.usage?.prompt_tokens} prompt tokens`;
});

await step("10. error shape: bad key -> 401, key not echoed", async () => {
  const bogus = "sk-bogus-0000000000000000";
  const res = await call({ messages: [{ role: "user", content: "x" }], max_tokens: 1 }, { key: bogus });
  const body = await res.text();
  assert(res.status === 401 || res.status === 403, `status ${res.status}`);
  assert(!body.includes(bogus), "error body echoes the key");
  return `HTTP ${res.status} body=${body.slice(0, 120)}`;
});

await step("11. browser CORS on the real POST (and on the 401): allow-origin present", async () => {
  const o = "https://lawbylaw.example";
  const ok = await call({ messages: [{ role: "user", content: "x" }], max_tokens: 1 }, { origin: o });
  const bad = await call({ messages: [{ role: "user", content: "x" }], max_tokens: 1 }, { key: "sk-bogus", origin: o });
  const a = ok.headers.get("access-control-allow-origin"), b = bad.headers.get("access-control-allow-origin");
  await ok.text(); await bad.text();
  assert(a && b, `allow-origin on 200=${a} on 401=${b}`);
  return `200 → ${a}; 401 → ${b}`;
});

await step("12. gatekeeper-shaped call (max_tokens 40, JSON mode) x12: the DeepSeek field fails, ours does not", async () => {
  const gate = { messages: [
    { role: "system", content: 'Classify the user message. Reply with only JSON: {"verdict":"allow"} or {"verdict":"off_topic"}.' },
    { role: "user", content: "<user_message>\nCan my landlord keep my deposit?\n</user_message>" }],
    temperature: 0, max_tokens: 40, response_format: { type: "json_object" } };
  const valid = (d) => { try { return ["allow", "off_topic", "low_value", "injection"].includes(JSON.parse(d.choices[0].message.content).verdict); } catch { return false; } };
  const N = 12; const score = {};
  for (const [label, extra] of [["thinking:{type:disabled} (old)", { thinking: { type: "disabled" } }], ["reasoning_effort:none (new)", THINK_OFF]]) {
    const runs = await Promise.all(Array.from({ length: N }, () => call({ ...gate, ...extra }, { raw: true }).then(async (r) => (r.ok ? valid(await r.json()) : false)).catch(() => false)));
    score[label] = runs.filter(Boolean).length;
  }
  console.log(`     valid verdicts out of ${N}: ${JSON.stringify(score)}`);
  assert(score["reasoning_effort:none (new)"] === N, `new switch only got ${score["reasoning_effort:none (new)"]}/${N} valid verdicts`);
  return `old=${score["thinking:{type:disabled} (old)"]}/${N} new=${score["reasoning_effort:none (new)"]}/${N}`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "ISSUES" : "ALL OK"}: ${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length ? 1 : 0);
