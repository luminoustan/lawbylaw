// Concurrent-user load test: real server binary + mock DeepSeek upstream.
//
//   node load.mjs                 # 300 users, 8 waves, both phases
//   USERS=500 WAVES=3 node load.mjs
//   PHASES=capacity node load.mjs # only the raised-limit phase
//
// Every virtual user has its own client IP (TRUST_PROXY=xff + x-forwarded-for), so the
// per-IP rate limit and one-stream-per-IP rule behave as they would for real visitors.
//
// Phases
//   shed      production defaults (LIMIT_GLOBAL_CONCURRENCY=50): USERS arrive at once. The server
//             should serve what it can and refuse the rest with 503 + Retry-After, never crash or hang.
//   capacity  LIMIT_GLOBAL_CONCURRENCY raised above USERS: every user should be served, concurrently.
//             WAVES waves run back to back; resident memory should level off rather than keep climbing.
//
// The user mix per wave: 60% long streams (~8s, so they overlap), 20% quick answers,
// 10% tool-calling turns (Qdrant is deliberately unreachable: exercises the tool-failure path),
// 10% clients that hang up mid-stream (exercises cancellation / Permit release).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// lib.mjs picks its binary from SERVER_BIN at import time and otherwise falls back to the
// (often stale) debug build, so pin the release binary before importing it.
process.env.SERVER_BIN ||= path.join(HERE, "../server/target/load/lawbylaw-server");
const { startServer, sleep } = await import("./lib.mjs");
const USERS = Number(process.env.USERS || 300);
const WAVES = Number(process.env.WAVES || 8);
const PHASES = (process.env.PHASES || "shed,capacity").split(",");
const MOCK_PORT = Number(process.env.MOCK_PORT || 9100);
const BIN = process.env.SERVER_BIN;
let nextPort = 8301;

const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : NaN);
const ms = (n) => (Number.isFinite(n) ? `${Math.round(n)}ms` : "-");
const mb = (kb) => `${(kb / 1024).toFixed(0)}MB`;

function plan(n) {
  const slow = Math.round(n * 0.6), quick = Math.round(n * 0.2), tool = Math.round(n * 0.1);
  const kinds = [];
  for (let i = 0; i < n; i++) kinds.push(i < slow ? "slow" : i < slow + quick ? "quick" : i < slow + quick + tool ? "tool" : "hangup");
  return kinds;
}
const PROMPT = {
  slow: (i) => `__SLOW__ What are my rights as tenant number ${i}?`,
  quick: (i) => `Explain section ${i} of the Contracts Act please`,
  tool: (i) => `__TOOL__ Find tenancy law for case ${i}`,
  hangup: (i) => `__SLOW__ I will close this tab early ${i}`,
};

/** One virtual user: POST /api/chat and consume the SSE stream. */
async function user(base, i, kind) {
  const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  const t0 = performance.now();
  const r = { i, kind, status: 0, ttfb: NaN, firstToken: NaN, total: NaN, done: false, error: null, retryAfter: null, hungUp: false, err: null };
  const ac = new AbortController();
  try {
    const res = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ messages: [{ role: "user", content: PROMPT[kind](i) }], mode: "legislation" }),
      signal: ac.signal,
    });
    r.status = res.status;
    r.ttfb = performance.now() - t0;
    r.retryAfter = res.headers.get("retry-after");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        const line = block.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === "token" && Number.isNaN(r.firstToken)) {
          r.firstToken = performance.now() - t0;
          if (kind === "hangup") { r.hungUp = true; await sleep(300); ac.abort(); throw Object.assign(new Error("hangup"), { hangup: true }); }
        }
        if (ev.type === "done") r.done = true;
        if (ev.type === "error") r.error = ev.error;
      }
    }
  } catch (e) {
    if (!e.hangup) r.err = String(e?.cause?.code || e?.message || e);
  }
  r.total = performance.now() - t0;
  return r;
}

/** Sample server health (active generations) and process RSS/threads while a wave runs. */
function sampler(base, pid) {
  const s = { peakActive: 0, peakRss: 0, peakThreads: 0, healthMs: [], stop: false };
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
      try {
        const h = await (await fetch(base + "/api/health", { signal: AbortSignal.timeout(5000) })).json();
        s.healthMs.push(performance.now() - t);
        s.peakActive = Math.max(s.peakActive, h.active_generations);
      } catch { s.healthMs.push(5000); }
      await sleep(150);
    }
  })();
  return { s, stop: async () => { s.stop = true; await loop; return s; }, rss };
}

const mockStats = async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__stats`)).json();
const active = async (base) => (await (await fetch(base + "/api/health")).json()).active_generations;

async function drain(base, secs = 20) {
  const t0 = performance.now();
  for (let a = await active(base); a > 0 && performance.now() - t0 < secs * 1000; a = await active(base)) await sleep(200);
  return { left: await active(base), took: performance.now() - t0 };
}

function summarize(results) {
  const by = (f) => results.filter(f);
  const served = by((r) => r.status === 200);
  const streamers = by((r) => r.kind !== "hangup");
  const okStreams = streamers.filter((r) => r.status === 200 && r.done);
  const statusCount = {};
  for (const r of results) statusCount[r.status || r.err || "?"] = (statusCount[r.status || r.err || "?"] || 0) + 1;
  return {
    statusCount, served: served.length,
    completed: okStreams.length, streamers: streamers.length,
    hungUp: by((r) => r.hungUp).length,
    refused503: by((r) => r.status === 503).length,
    refusedWithRetryAfter: by((r) => r.status === 503 && r.retryAfter).length,
    transportErrors: by((r) => r.err).length,
    streamErrors: by((r) => r.error).length,
    ttfb: { p50: pct(served.map((r) => r.ttfb), 50), p95: pct(served.map((r) => r.ttfb), 95), p99: pct(served.map((r) => r.ttfb), 99) },
    firstToken: { p50: pct(served.map((r) => r.firstToken).filter(Number.isFinite), 50), p95: pct(served.map((r) => r.firstToken).filter(Number.isFinite), 95) },
    total: { p50: pct(okStreams.map((r) => r.total), 50), p95: pct(okStreams.map((r) => r.total), 95), max: Math.max(...okStreams.map((r) => r.total), 0) },
    byKind: Object.fromEntries(["slow", "quick", "tool", "hangup"].map((k) => [k, {
      n: by((r) => r.kind === k).length,
      ok: by((r) => r.kind === k && r.status === 200 && (r.done || r.hungUp)).length,
    }])),
  };
}

async function runPhase(name, env, waves, expect) {
  console.log(`\n══ phase: ${name}  (${USERS} users x ${waves} wave${waves > 1 ? "s" : ""}) ══`);
  const server = await startServer({ port: nextPort++, mockPort: MOCK_PORT, env: { TRUST_PROXY: "xff", LIMIT_REQUEST_TIMEOUT_S: "60", RUST_LOG: "warn", ...env, ...(process.env.SERVER_ENV ? JSON.parse(process.env.SERVER_ENV) : {}) }, staticDir: "/nonexistent" });
  const pid = server.child.pid;
  const smp = sampler(server.base, pid);
  const idle = smp.rss();
  console.log(`server up: pid=${pid} idle RSS=${mb(idle.rss)} threads=${idle.threads}`);
  const out = { name, waves: [], idleRss: idle.rss, failures: [] };
  const check = (cond, msg) => { if (!cond) { out.failures.push(msg); console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };

  for (let w = 1; w <= waves; w++) {
    const before = await mockStats();
    const t0 = performance.now();
    const results = await Promise.all(plan(USERS).map((k, i) => user(server.base, (process.env.REUSE_IPS ? 0 : w * 100000) + i, k)));
    const wall = performance.now() - t0;
    const dr = await drain(server.base);
    const after = await mockStats();
    const m = smp.rss();
    const sum = summarize(results);
    const peak = smp.s.peakActive;
    const wave = { wave: w, wallMs: wall, ...sum, peakActive: peak, drainLeft: dr.left, drainMs: dr.took, rssAfter: m.rss, threadsAfter: m.threads,
      upstream: { calls: after.calls - before.calls, gate: (after.gateCalls || 0) - (before.gateCalls || 0), aborted: after.aborted - before.aborted } };
    out.waves.push(wave);
    console.log(`\n wave ${w}: wall=${ms(wall)}  status=${JSON.stringify(sum.statusCount)}  peak active=${peak}`);
    console.log(`  completed ${sum.completed}/${sum.streamers} streams · hung up ${sum.hungUp} · transport errors ${sum.transportErrors} · stream errors ${sum.streamErrors}`);
    console.log(`  TTFB p50/p95/p99 = ${ms(sum.ttfb.p50)}/${ms(sum.ttfb.p95)}/${ms(sum.ttfb.p99)} · first token p50/p95 = ${ms(sum.firstToken.p50)}/${ms(sum.firstToken.p95)} · stream total p50/p95/max = ${ms(sum.total.p50)}/${ms(sum.total.p95)}/${ms(sum.total.max)}`);
    console.log(`  server: RSS after=${mb(m.rss)} threads=${m.threads} · drained to ${dr.left} active in ${ms(dr.took)} · upstream calls=${wave.upstream.calls} gate=${wave.upstream.gate} client-aborted=${wave.upstream.aborted}`);
    if (expect === "all") {
      check(sum.transportErrors === 0, `wave ${w}: no connection errors`);
      check(sum.served === USERS, `wave ${w}: every user admitted (${sum.served}/${USERS})`);
      check(sum.completed === sum.streamers, `wave ${w}: every non-hangup stream finished with a done event (${sum.completed}/${sum.streamers})`);
      check(sum.streamErrors === 0, `wave ${w}: no error events inside streams`);
      check(peak >= USERS * 0.9, `wave ${w}: ≥90% of users truly concurrent (peak active ${peak}/${USERS})`);
    } else {
      check(sum.transportErrors === 0, `wave ${w}: no connection errors while shedding`);
      check(sum.served + sum.refused503 === USERS, `wave ${w}: every request was served or cleanly refused (${sum.served} served + ${sum.refused503} refused)`);
      check(sum.refusedWithRetryAfter === sum.refused503, `wave ${w}: every 503 carries Retry-After`);
      check(peak <= 50, `wave ${w}: concurrency cap held (peak active ${peak} ≤ 50)`);
      check(sum.completed >= sum.streamers - sum.refused503 - sum.byKind.hangup.n, `wave ${w}: every admitted stream completed`);
    }
    check(dr.left === 0, `wave ${w}: all concurrency slots released (active=${dr.left})`);
    check(Math.abs(wave.upstream.aborted - sum.hungUp) <= Math.max(2, sum.hungUp * 0.1), `wave ${w}: upstream saw the client hang-ups (${wave.upstream.aborted} aborted vs ${sum.hungUp} hung up)`);
    await sleep(500);
  }

  const hs = await smp.stop();
  out.peakRss = hs.peakRss; out.peakThreads = hs.peakThreads;
  out.health = { p50: pct(hs.healthMs, 50), p99: pct(hs.healthMs, 99), max: Math.max(...hs.healthMs) };
  console.log(`\n peak RSS=${mb(hs.peakRss)} peak threads=${hs.peakThreads} · /api/health under load p50/p99/max = ${ms(out.health.p50)}/${ms(out.health.p99)}/${ms(out.health.max)}`);
  if (out.waves.length >= 3) {
    // Resident memory legitimately climbs while the allocator warms up to N concurrent streams
    // (a high-water mark of roughly 0.5-1MB per stream), so compare the *last* wave to the one
    // before it: a leak keeps climbing at a steady rate, a high-water mark levels off.
    const r = out.waves.map((x) => x.rssAfter);
    const last = ((r.at(-1) - r.at(-2)) / r.at(-2)) * 100;
    console.log(` RSS after each wave: ${r.map(mb).join(" → ")}`);
    check(last < 10, `memory has levelled off (last wave ${last >= 0 ? "+" : ""}${last.toFixed(1)}%, ${mb(r.at(-2))} → ${mb(r.at(-1))})`);
  }
  check(server.child.exitCode === null, "server process still alive");
  const logs = server.logs();
  check(!/panicked|overflow|abort/i.test(logs), "no panics in server logs");
  out.logTail = logs.slice(-600);
  server.stop();
  return out;
}

// ── main ──
if (!fs.existsSync(BIN)) { console.error(`server binary not found: ${BIN}`); process.exit(2); }
console.log(`server binary: ${BIN} (built ${fs.statSync(BIN).mtime.toISOString()})`);
const mock = spawn("node", [path.join(HERE, "mock-deepseek.mjs")], { env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: "ignore" });
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${MOCK_PORT}/__stats`); break; } catch { await sleep(100); } }

const all = [];
try {
  if (PHASES.includes("shed")) all.push(await runPhase("shed", {}, 1, "shed"));
  if (PHASES.includes("capacity")) all.push(await runPhase("capacity", { LIMIT_GLOBAL_CONCURRENCY: String(USERS * 2) }, WAVES, "all"));
} finally { mock.kill("SIGKILL"); }

fs.writeFileSync(path.join(HERE, "load-results.json"), JSON.stringify({ users: USERS, at: new Date().toISOString(), phases: all }, null, 1));
const failures = all.flatMap((p) => p.failures.map((f) => `[${p.name}] ${f}`));
console.log(`\n${failures.length ? "FAILED" : "PASSED"}: ${failures.length} failed check(s)`);
failures.forEach((f) => console.log("  - " + f));
process.exit(failures.length ? 1 : 0);
