// End-to-end check: the real server binary talking to the real Nebius endpoint, pinned to
// ONE model. Not part of `make evals` (needs a key and the network); run it by hand:
//
//   NEBIUS_API_KEY=... SERVER_BIN=/w/server/target/load/lawbylaw-server-musl-provider node nebius-e2e.mjs
//
// The gatekeeper (on by default) makes a `max_tokens: 40` JSON call first. If the provider is still
// reasoning, those 40 tokens go on hidden reasoning, the reply is empty, and the app fails closed with
// "We couldn't check your message", so a clean answer here proves thinking is really off.
// The key is passed to the child only; it is never printed. TAVILY_API_KEY is blanked so a stray
// .env cannot make the test spend web-search credits.
import { startServer, sleep } from "./lib.mjs";

const KEY = process.env.NEBIUS_API_KEY;
if (!KEY) { console.error("NEBIUS_API_KEY not set"); process.exit(2); }
const BASE = "https://api.tokenfactory.nebius.com/v1";
const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash"; // pinned
const bin = process.env.SERVER_BIN;
console.log(`binary: ${bin}`);

const s = await startServer({
  port: 8431,
  env: { NEBIUS_API_KEY: KEY, NEBIUS_BASE_URL: BASE, NEBIUS_MODEL: MODEL, TAVILY_API_KEY: "", RUST_LOG: "warn", LIMIT_REQUEST_TIMEOUT_S: "90" },
  staticDir: "/nonexistent",
});
const redact = (t) => String(t).split(KEY).join("[redacted-key]");

const questions = [
  "What is the minimum age at which a person can make a binding contract in Singapore? Answer in two short sentences.",
  "In one sentence, what does the Singapore Legal Profession Act regulate?",
];
let bad = 0;
for (const q of questions) {
  const t0 = performance.now();
  const res = await fetch(s.base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: q }], mode: "legislation" }) });
  let firstToken = null, text = "", err = null, done = false; const kinds = {};
  const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done: d } = await rd.read(); if (d) break;
    buf += dec.decode(value, { stream: true });
    let k; while ((k = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, k); buf = buf.slice(k + 2);
      const line = block.split("\n").find((l) => l.startsWith("data:")); if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      kinds[ev.type] = (kinds[ev.type] || 0) + 1;
      if (ev.type === "token") { firstToken ??= performance.now() - t0; text += ev.content; }
      if (ev.type === "error") err = ev.error;
      if (ev.type === "done") done = true;
    }
  }
  const ok = res.status === 200 && done && !err && text.trim().length > 20;
  if (!ok) bad++;
  console.log(`${ok ? "✓" : "✗"} HTTP ${res.status} done=${done} first-token=${firstToken ? Math.round(firstToken) + "ms" : "-"} total=${Math.round(performance.now() - t0)}ms events=${JSON.stringify(kinds)}`);
  console.log(`   Q: ${q.slice(0, 70)}…`);
  console.log(`   ${err ? "ERROR: " + redact(err) : "A: " + redact(text.replace(/\s+/g, " ").slice(0, 160))}`);
  await sleep(300);
}
const logs = redact(s.logs());
if (/panicked/.test(logs)) { bad++; console.log("✗ panic in server logs"); }
s.stop();
console.log(bad ? `\nFAILED: ${bad} problem(s)` : "\nPASSED");
process.exit(bad ? 1 : 0);
