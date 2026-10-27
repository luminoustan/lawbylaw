// Load test for the "bring your own key" half of the server: GET /api/agent, POST /api/tool,
// POST /api/cite, POST /api/links. No LLM is involved (that runs in the user's browser), so this is
// what the server carries when every user brings their own key.
//
//   node load-byok.mjs                    # 300 users, 5 waves, all phases
//   USERS=500 WAVES=3 node load-byok.mjs
//   PHASES=honest,mixed node load-byok.mjs
//
// Every virtual user has its own client IP (TRUST_PROXY=xff + x-forwarded-for). Qdrant is deliberately
// unreachable, so tool calls take the (fast) failure path: this measures the server's own capacity,
// limiter and cleanup, not the database.
//
// Phases
//   honest   USERS honest users at once, WAVES times. One turn = agent bundle, 3 parallel tool calls,
//            cite, links (what the browser loop does), made with the browser's real client, which
//            retries a busy answer. At least 99% of turns must be fully served.
//   mixed    the same honest users, plus abusers that hammer /api/tool from their own IP and clients
//            that send malformed or oversized bodies. Abusers must be refused cleanly (429/503 with
//            Retry-After, never a 500 or a hang); the honest users' success rate is reported.
//   rotate   a flood of requests, each from a new IP, to show the limiter's tracking table stays
//            bounded (memory must not grow with the number of distinct IPs).
// After every phase a probe checks no in-flight permit was leaked, and the server must still be up.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.SERVER_BIN ||= path.join(HERE, "../server/target/x86_64-unknown-linux-musl/release/lawbylaw-server");
const { startServer, sleep } = await import("./lib.mjs");
// The honest users run the browser's own client code (retries and all), so this measures what a real
// user experiences. It is plain TypeScript with no imports; Node strips the types.
const { createServerTools } = await import("../web/src/agent/server-tools.ts");
const USERS = Number(process.env.USERS || 300);
const WAVES = Number(process.env.WAVES || 5);
const ROTATE_IPS = Number(process.env.ROTATE_IPS || 30000);
const PHASES = (process.env.PHASES || "honest,mixed,rotate").split(",");
const BIN = process.env.SERVER_BIN;
let nextPort = 8501;

const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : NaN);
const ms = (n) => (Number.isFinite(n) ? `${Math.round(n)}ms` : "-");
const mb = (kb) => `${(kb / 1024).toFixed(0)}MB`;
const ipOf = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

/** One request; records status, latency and the headers that matter. Never throws. */
async function call(base, ip, method, url, body, stats, label) {
  const t0 = performance.now();
  const r = { label, status: 0, ms: NaN, retryAfter: null, err: null, json: null };
  try {
    const res = await fetch(base + url, {
      method,
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    r.status = res.status;
    r.retryAfter = res.headers.get("retry-after");
    const text = await res.text();
    r.bytes = text.length;
    try { r.json = JSON.parse(text); } catch { /* not JSON */ }
  } catch (e) {
    r.err = String(e?.cause?.code || e?.name || e);
  }
  r.ms = performance.now() - t0;
  stats.push(r);
  return r;
}

const TOOL = (i) => ({ tool: i % 2 ? "search_legislation" : "get_section", args: i % 2 ? { query: `tenancy deposit ${i}` } : { source_file: "x.json", section_id: String(i) }, context: "orchestrator" });
const REFS = JSON.stringify([{ act_name: "Evidence Act 1893", section_id: "1", relevance: "load" }]);
const ANSWER = "Under section 13 of the Evidence Act 1893 relevant facts are admissible. ".repeat(30);

/** `fetch` for one virtual user: its own IP, and every HTTP attempt (retries included) recorded. */
const userFetch = (ip, stats) => async (url, init) => {
  const t0 = performance.now();
  const path = new URL(url, "http://x").pathname;
  const label = path.replace("/api/", "");
  try {
    const res = await fetch(url, { ...init, headers: { ...init.headers, "x-forwarded-for": ip } });
    stats.push({ label, status: res.status, ms: performance.now() - t0, retryAfter: res.headers.get("retry-after"), bytes: Number(res.headers.get("content-length")) || undefined });
    return res;
  } catch (e) {
    stats.push({ label, status: 0, err: String(e?.cause?.code || e?.name || e), ms: performance.now() - t0 });
    throw e;
  }
};

/** An honest user's turn, run through the browser's real client. Resolves {ok, ms, retried}. */
async function honestTurn(base, ip, stats) {
  const t0 = performance.now();
  const before = stats.length;
  const tools = createServerTools({ baseUrl: base, fetchImpl: userFetch(ip, stats) });
  const sig = AbortSignal.timeout(60000);
  let ok = true, status = 0;
  try {
    await tools.agent("legislation", sig);
    await Promise.all([1, 2, 3].map((n) => tools.tool(TOOL(n), sig)));
    await tools.cite({ kind: "legislation", output: REFS, sections: [] }, sig);
    await tools.links(ANSWER, sig);
  } catch (e) {
    ok = false; status = e?.status ?? 0;
  }
  const mine = stats.slice(before);
  return { ok, status, ms: performance.now() - t0, attempts: mine.length, refusedAttempts: mine.filter((r) => r.status === 429 || r.status === 503).length };
}
/** A client that hammers the tool endpoint from one IP. */
async function hammer(base, ip, stats) {
  for (let b = 0; b < 5; b++) await Promise.all(Array.from({ length: 30 }, (_, n) => call(base, ip, "POST", "/api/tool", TOOL(n), stats, "hammer")));
}
/** A client sending garbage. */
async function garbage(base, ip, stats) {
  const bad = [
    ["/api/tool", "not json"], ["/api/tool", { tool: "rm -rf" }], ["/api/tool", { tool: "get_section", args: [1] }],
    ["/api/tool", { tool: "get_section", args: { pad: "x".repeat(70000) } }],
    ["/api/cite", { kind: "tax", output: "[]" }], ["/api/links", { text: "x".repeat(60000) }], ["/api/links", "{"],
  ];
  for (const [u, b] of bad) await call(base, ip, "POST", u, b, stats, "garbage");
}

function sampler(base, pid) {
  const s = { peakRss: 0, peakThreads: 0, healthMs: [], stop: false };
  const rss = () => {
    try {
      const st = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      return { rss: Number(/VmRSS:\s+(\d+)/.exec(st)[1]), threads: Number(/Threads:\s+(\d+)/.exec(st)[1]) };
    } catch { return { rss: 0, threads: 0 }; }
  };
  const loop = (async () => {
    while (!s.stop) {
      const m = rss(); s.peakRss = Math.max(s.peakRss, m.rss); s.peakThreads = Math.max(s.peakThreads, m.threads);
      const t = performance.now();
      try { await (await fetch(base + "/api/health", { signal: AbortSignal.timeout(5000) })).json(); s.healthMs.push(performance.now() - t); } catch { s.healthMs.push(5000); }
      await sleep(100);
    }
  })();
  return { s, rss, stop: async () => { s.stop = true; await loop; return s; } };
}

const byLabel = (stats) => {
  const out = {};
  for (const l of [...new Set(stats.map((r) => r.label))]) {
    const rs = stats.filter((r) => r.label === l);
    const codes = {};
    for (const r of rs) codes[r.status || r.err] = (codes[r.status || r.err] || 0) + 1;
    out[l] = { n: rs.length, codes, p50: pct(rs.map((r) => r.ms), 50), p95: pct(rs.map((r) => r.ms), 95), p99: pct(rs.map((r) => r.ms), 99), max: Math.max(...rs.map((r) => r.ms)) };
  }
  return out;
};

/** The same sanity checks after every phase. */
async function afterChecks(server, smp, check, label) {
  // No leaked in-flight permits: a burst from fresh IPs, well inside every cap, must all be served.
  await sleep(500);
  const probe = [];
  await Promise.all(Array.from({ length: 150 }, (_, i) => call(server.base, ipOf(9_000_000 + i), "POST", "/api/links", { text: "probe" }, probe, "probe")));
  const ok = probe.filter((r) => r.status === 200).length;
  check(ok === probe.length, `${label}: no leaked in-flight slots (probe ${ok}/${probe.length} served)`);
  check(server.child.exitCode === null, `${label}: server process still alive`);
  check(!/panicked|overflow|abort/i.test(server.logs()), `${label}: no panics in server logs`);
}

// Any LIMIT_* variable given to this script reaches the server, so a limit can be tuned without a rebuild.
const serverEnv = { TRUST_PROXY: "xff", RUST_LOG: "warn", ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("LIMIT_"))) };

async function runPhase(name, mix, waves) {
  console.log(`\n══ phase: ${name}  (${USERS} honest users x ${waves} wave${waves > 1 ? "s" : ""}${mix.hammer ? `, +${mix.hammer} hammering, +${mix.garbage} garbage clients` : ""}) ══`);
  const server = await startServer({ port: nextPort++, env: serverEnv, staticDir: "/nonexistent" });
  const smp = sampler(server.base, server.child.pid);
  const idle = smp.rss();
  console.log(`server up: pid=${server.child.pid} idle RSS=${mb(idle.rss)} threads=${idle.threads}`);
  const out = { name, waves: [], idleRss: idle.rss, failures: [] };
  const check = (cond, msg) => { if (!cond) { out.failures.push(msg); console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };

  for (let w = 1; w <= waves; w++) {
    const stats = [];
    const honestStats = [];
    const t0 = performance.now();
    const base = w * 100000;
    const honest = Array.from({ length: USERS }, (_, i) => honestTurn(server.base, ipOf(base + i), honestStats));
    const others = [
      ...Array.from({ length: mix.hammer || 0 }, (_, i) => hammer(server.base, ipOf(base + 50000 + i), stats)),
      ...Array.from({ length: mix.garbage || 0 }, (_, i) => garbage(server.base, ipOf(base + 60000 + i), stats)),
    ];
    const results = await Promise.all(honest);
    await Promise.all(others);
    const wall = performance.now() - t0;
    const okTurns = results.filter((r) => r.ok).length;
    const turnMs = results.map((r) => r.ms);
    const retriedTurns = results.filter((r) => r.refusedAttempts > 0).length;
    const m = smp.rss();
    const hs = byLabel(honestStats);
    const all = [...honestStats, ...stats];
    const transport = all.filter((r) => r.err).length;
    const failedStatuses = {};
    for (const r of results.filter((x) => !x.ok)) failedStatuses[r.status] = (failedStatuses[r.status] || 0) + 1;
    const fiveHundreds = all.filter((r) => r.status >= 500 && r.status !== 503).length;
    // Refusals the server sent. Honest users retry, so count every attempt that was refused.
    const refusals = all.filter((r) => r.status === 429 || r.status === 503);
    const refusalsWithRetry = refusals.filter((r) => r.retryAfter).length;
    const wave = { wave: w, wallMs: wall, okTurns, retriedTurns, turnMs: { p50: pct(turnMs, 50), p95: pct(turnMs, 95), max: Math.max(...turnMs) }, failedStatuses, honest: hs, abusers: byLabel(stats), transport, fiveHundreds, refusals: refusals.length, rssAfter: m.rss, threadsAfter: m.threads };
    out.waves.push(wave);
    console.log(`\n wave ${w}: wall=${ms(wall)}  honest turns fully served ${okTurns}/${USERS} (${retriedTurns} needed a retry)  refused attempts=${refusals.length}  RSS=${mb(m.rss)} threads=${m.threads}`);
    console.log(`   whole turn (incl. retry waits) p50/p95/max = ${ms(wave.turnMs.p50)}/${ms(wave.turnMs.p95)}/${ms(wave.turnMs.max)}${okTurns < USERS ? `  failed with ${JSON.stringify(failedStatuses)}` : ""}`);
    for (const [l, v] of Object.entries(hs)) console.log(`   ${l.padEnd(6)} n=${String(v.n).padStart(5)} ${JSON.stringify(v.codes)}  p50/p95/p99/max = ${ms(v.p50)}/${ms(v.p95)}/${ms(v.p99)}/${ms(v.max)}`);
    for (const [l, v] of Object.entries(wave.abusers)) console.log(`   ${l.padEnd(7)} n=${String(v.n).padStart(5)} ${JSON.stringify(v.codes)}  p50/p99 = ${ms(v.p50)}/${ms(v.p99)}`);
    const agentBytes = honestStats.find((r) => r.label === "agent" && r.bytes)?.bytes;
    if (w === 1 && agentBytes) console.log(`   (the /api/agent bundle is ${(agentBytes / 1024).toFixed(0)} KB per fetch)`);

    check(transport === 0, `wave ${w}: no connection errors or timeouts`);
    check(fiveHundreds === 0, `wave ${w}: no 5xx other than a clean 503 (found ${fiveHundreds})`);
    check(refusalsWithRetry === refusals.length, `wave ${w}: every 429/503 carries Retry-After (${refusalsWithRetry}/${refusals.length})`);
    if (!mix.hammer) check(okTurns >= USERS * 0.99, `wave ${w}: ≥99% of honest turns fully served, retries included (${okTurns}/${USERS})`);
    if (mix.garbage) {
      const g = stats.filter((r) => r.label === "garbage");
      check(g.every((r) => r.status === 400 || r.status === 413 || r.status === 429 || r.status === 503), `wave ${w}: malformed requests are refused with 4xx (${JSON.stringify(byLabel(g).garbage.codes)})`);
    }
    if (mix.hammer) {
      // A floor, not a goal. Wave 1 is the worst case (360 clients fire in the same instant, cold).
      // With the old 200-slot cap this was 19-48%; with 500 it is 83-100%.
      check(okTurns >= USERS * 0.75, `wave ${w}: honest users still served while abusers flood (${okTurns}/${USERS} fully served)`);
      const h = stats.filter((r) => r.label === "hammer");
      check(h.some((r) => r.status === 429), `wave ${w}: hammering is rate-limited (${h.filter((r) => r.status === 429).length} of ${h.length} refused)`);
      console.log(`   fairness: honest turns fully served despite abusers: ${okTurns}/${USERS} (${((okTurns / USERS) * 100).toFixed(0)}%)`);
    }
    await sleep(300);
  }

  const hs = await smp.stop();
  out.peakRss = hs.peakRss; out.peakThreads = hs.peakThreads;
  out.health = { p50: pct(hs.healthMs, 50), p99: pct(hs.healthMs, 99), max: Math.max(...hs.healthMs) };
  console.log(`\n peak RSS=${mb(hs.peakRss)} peak threads=${hs.peakThreads} · /api/health under load p50/p99/max = ${ms(out.health.p50)}/${ms(out.health.p99)}/${ms(out.health.max)}`);
  if (out.waves.length >= 3) {
    const r = out.waves.map((x) => x.rssAfter);
    const last = ((r.at(-1) - r.at(-2)) / r.at(-2)) * 100;
    console.log(` RSS after each wave: ${r.map(mb).join(" → ")}`);
    check(last < 10, `memory has levelled off (last wave ${last >= 0 ? "+" : ""}${last.toFixed(1)}%)`);
  }
  await afterChecks(server, smp, check, name);
  out.logTail = server.logs().slice(-400);
  server.stop();
  return out;
}

/** Many distinct IPs: the limiter must not remember them all. */
async function runRotate() {
  console.log(`\n══ phase: rotate  (${ROTATE_IPS} requests, each from a new IP) ══`);
  const server = await startServer({ port: nextPort++, env: serverEnv, staticDir: "/nonexistent" });
  const smp = sampler(server.base, server.child.pid);
  const out = { name: "rotate", failures: [] };
  const check = (cond, msg) => { if (!cond) { out.failures.push(msg); console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };
  const idle = smp.rss();
  const stats = [];
  let next = 0;
  const t0 = performance.now();
  const rssAt = {};
  await Promise.all(Array.from({ length: 200 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= ROTATE_IPS) return;
      await call(server.base, ipOf(1_000_000 + i), "POST", "/api/links", { text: "Companies Act 1967 s 19" }, stats, "rotate");
      if (i === Math.floor(ROTATE_IPS / 3) || i === Math.floor((2 * ROTATE_IPS) / 3)) rssAt[i] = smp.rss().rss;
    }
  }));
  const wall = performance.now() - t0;
  const m = smp.rss();
  const s = byLabel(stats).rotate;
  console.log(` ${ROTATE_IPS} requests in ${ms(wall)} (${Math.round(ROTATE_IPS / (wall / 1000))} req/s)  ${JSON.stringify(s.codes)}  p50/p99 = ${ms(s.p50)}/${ms(s.p99)}`);
  const marks = [idle.rss, ...Object.values(rssAt), m.rss];
  console.log(` RSS: idle ${mb(idle.rss)} → 1/3 ${mb(rssAt[Math.floor(ROTATE_IPS / 3)] ?? 0)} → 2/3 ${mb(rssAt[Math.floor((2 * ROTATE_IPS) / 3)] ?? 0)} → end ${mb(m.rss)}`);
  check(stats.every((r) => !r.err), "no connection errors or timeouts");
  check(stats.every((r) => r.status === 200 || ((r.status === 429 || r.status === 503) && r.retryAfter)), `every request served or cleanly refused (${JSON.stringify(s.codes)})`);
  // The table is bounded, so memory must not scale with the number of distinct IPs. Growth between the
  // 2/3 mark and the end (a third of the flood) should be small next to the growth to the 1/3 mark.
  const two3 = rssAt[Math.floor((2 * ROTATE_IPS) / 3)];
  check(m.rss - two3 < 30 * 1024, `memory is not growing with distinct IPs (+${mb(Math.max(0, m.rss - two3))} over the last third)`);
  await smp.stop();
  await afterChecks(server, smp, check, "rotate");
  server.stop();
  return out;
}

// ── main ──
if (!fs.existsSync(BIN)) { console.error(`server binary not found: ${BIN}`); process.exit(2); }
console.log(`server binary: ${BIN} (built ${fs.statSync(BIN).mtime.toISOString()})`);
const all = [];
if (PHASES.includes("honest")) all.push(await runPhase("honest", {}, WAVES));
if (PHASES.includes("mixed")) all.push(await runPhase("mixed", { hammer: Math.round(USERS / 10), garbage: Math.round(USERS / 10) }, Math.min(WAVES, 3)));
if (PHASES.includes("rotate")) all.push(await runRotate());

fs.writeFileSync(path.join(HERE, "load-byok-results.json"), JSON.stringify({ users: USERS, at: new Date().toISOString(), phases: all }, null, 1));
const failures = all.flatMap((p) => p.failures.map((f) => `[${p.name}] ${f}`));
console.log(`\n${failures.length ? "FAILED" : "PASSED"}: ${failures.length} failed check(s)`);
failures.forEach((f) => console.log("  - " + f));
process.exit(failures.length ? 1 : 0);
