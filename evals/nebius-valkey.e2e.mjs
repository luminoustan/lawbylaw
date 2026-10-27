// End-to-end check of the shared daily token budget with the real Nebius endpoint and a real
// Valkey/Redis. Not part of `make evals` (needs a key, the network and Valkey). Run by hand:
//
//   valkey-server on 127.0.0.1:6379, then
//   NEBIUS_API_KEY=... REDIS_URL=redis://127.0.0.1:6379 node nebius-valkey.e2e.mjs
//
// Two server "replicas" share one counter. Chat turns are sent to both; we compare
//   (a) the sum of `total_tokens` in the replicas' `turn_complete` log lines (the provider-reported
//       usage; the SSE stream does not carry it to the browser),
//   (b) the Valkey counter `lbl:tokens:<budget day>` and its TTL,
//   (c) each replica's `lawbylaw_daily_tokens_used` gauge.
// Valkey must be at least (a) (the gatekeeper's calls are charged too), and both gauges must
// converge on (b). Finally Valkey is stopped (VALKEY_STOP_CMD, optional) to check it fails open.
// The key goes to the children only and is redacted from output.
import net from "node:net";
import { execSync } from "node:child_process";
import { startServer, sleep } from "./lib.mjs";

const KEY = process.env.NEBIUS_API_KEY;
if (!KEY) { console.error("NEBIUS_API_KEY not set"); process.exit(2); }
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const { hostname: RH, port: RP } = new URL(REDIS_URL);
const redact = (t) => String(t).split(KEY).join("[redacted-key]");

const day = () => Math.floor((Date.now() / 1000 + 2 * 3600) / 86400); // resets 06:00 SGT, see limits.rs
const keyName = () => `lbl:tokens:${day()}`;

function redis(...args) {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(RP || 6379), RH);
    const cmd = `*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join("");
    s.on("error", reject);
    s.setTimeout(3000, () => { s.destroy(); reject(new Error("redis timeout")); });
    s.once("data", (d) => { s.end(); const t = d.toString(); resolve(t.startsWith("$-1") ? null : t.startsWith(":") ? Number(t.slice(1)) : t.split("\r\n")[1]); });
    s.write(cmd);
  });
}

async function gauge(metricsPort) {
  const t = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();
  const m = t.match(/^lawbylaw_daily_tokens_used\s+([0-9.e+]+)/m);
  return m ? Math.round(Number(m[1])) : null;
}

/** Sum of every provider-reported token the replica counted in its LLM metric (all call types). */
async function llmTokens(metricsPort) {
  const t = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();
  let n = 0, providers = new Set();
  for (const l of t.split("\n")) {
    const m = l.match(/^lawbylaw_llm_tokens_total\{([^}]*)\}\s+([0-9.e+]+)/);
    if (!m) continue;
    n += Number(m[2]);
    providers.add((m[1].match(/provider="([^"]*)"/) || [])[1]);
  }
  return { n: Math.round(n), providers: [...providers] };
}

async function turn(base, q) {
  const res = await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: q }], mode: "legislation" }) });
  const txt = await res.text();
  let answer = "", err = null;
  for (const block of txt.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
    if (ev.type === "token") answer += ev.content;
    if (ev.type === "error") err = ev.error;
  }
  return { status: res.status, ok: res.status === 200 && !err && answer.trim().length > 20, err };
}

const env = (metrics) => ({
  NEBIUS_API_KEY: KEY, DEEPSEEK_API_KEY: "", TAVILY_API_KEY: "", RUST_LOG: "warn,lawbylaw_server::routers::chat=info",
  REDIS_URL, METRICS_PORT: String(metrics), LIMIT_REQUEST_TIMEOUT_S: "90",
  LIMIT_RATE_PER_MIN: "60", LIMIT_RATE_BURST: "20",
});
// startServer's default env points DEEPSEEK_* at a mock; NEBIUS_API_KEY wins, and we pin the real URL/model.
// Start from an empty counter BEFORE the replicas start: within a day a replica only ever raises
// its view of the total, so deleting the key under a running replica would leave it stale.
await redis("DEL", keyName());
const a = await startServer({ port: 8441, env: { ...env(9441) }, staticDir: "/nonexistent" });
const b = await startServer({ port: 8442, env: { ...env(9442) }, staticDir: "/nonexistent" });

let bad = 0;
const check = (ok, msg) => { console.log(`${ok ? "✓" : "✗"} ${msg}`); if (!ok) bad++; };

try {
  const before = await redis("GET", keyName());
  check(before === null, "counter starts empty");

  const qs = [
    [a.base, "What is the minimum age to make a binding contract in Singapore? Two short sentences."],
    [b.base, "In one sentence, what does the Singapore Legal Profession Act regulate?"],
    [a.base, "In one sentence, what is the Personal Data Protection Act 2012 about?"],
  ];
  for (const [base, q] of qs) {
    const r = await turn(base, q);
    check(r.ok, `turn via ${base.slice(-4)}: HTTP ${r.status}${r.err ? " ERROR " + redact(r.err) : ""}`);
  }
  await sleep(3500);
  const logged = (l) => [...l.matchAll(/turn_complete.*?total_tokens\W+(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
  const seen = logged(a.logs()) + logged(b.logs()); // replicas re-read the shared total every 2 s
  const shared = await redis("GET", keyName());
  const ttl = await redis("TTL", keyName());
  const [ga, gb] = [await gauge(9441), await gauge(9442)];
  console.log(`   provider-reported (logs) total=${seen}  valkey=${shared}  ttl=${ttl}s  gauge A=${ga} B=${gb}`);
  check(shared !== null && Number(shared) >= seen && seen > 0, "valkey counter >= tokens the turns report (gatekeeper calls are charged on top)");
  check(ttl > 86400 && ttl <= 2 * 86400, "counter expires in about two days");
  check(ga === Number(shared) && gb === Number(shared), "both replicas report the same app-wide total as valkey");
  const [la, lb] = [await llmTokens(9441), await llmTokens(9442)];
  const metered = la.n + lb.n;
  console.log(`   llm metric (all call types, both replicas)=${metered} providers=${[...new Set([...la.providers, ...lb.providers])]}`);
  check(la.providers.concat(lb.providers).every((p) => p === "nebius"), "every call is labelled provider=nebius");
  check(Math.abs(metered - Number(shared)) <= Math.max(200, Number(shared) * 0.02), "valkey matches the provider-reported usage of every call type (turns, gatekeeper, sub-agents) within 2%");
  check(Number(shared) < seen * 3 + 5000, "no double counting (valkey is within a sane multiple of reported usage)");

  if (process.env.VALKEY_STOP_CMD) {
    execSync(process.env.VALKEY_STOP_CMD, { stdio: "ignore" });
    await sleep(500);
    const r = await turn(a.base, "In one sentence, what is the age of majority in Singapore?");
    check(r.ok, "valkey stopped: chat still answers (fails open)");
    await sleep(1000);
    const g = await gauge(9441);
    check(g !== null && g >= Number(shared), `valkey stopped: replica keeps counting locally (gauge=${g})`);
  }
  const logs = redact(a.logs() + b.logs());
  check(!/panicked/.test(logs), "no panics in server logs");
} finally {
  a.stop(); b.stop();
}
console.log(bad ? `\nFAILED: ${bad} problem(s)` : "\nPASSED");
process.exit(bad ? 1 : 0);
