import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = process.env.SERVER_BIN || path.join(ROOT, "server/target/debug/lawbylaw-server");
export const CANARY_KEY = "sk-CANARY-do-not-leak-0123456789abcdef";
export const RESULTS = path.join(ROOT, "evals/results.json");

/** Start the real server binary against the mock upstream. */
export async function startServer({ port, mockPort = 9100, env = {}, staticDir = path.join(ROOT, "web/dist") }) {
  const child = spawn(BIN, [], {
    cwd: path.join(ROOT, "server"),
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      BIND_ADDR: `127.0.0.1:${port}`,
      // Blank, not absent: the server also reads a parent .env, and a NEBIUS_API_KEY there would
      // win over DEEPSEEK_* and send these tests to the real provider.
      NEBIUS_API_KEY: "",
      DEEPSEEK_API_KEY: CANARY_KEY,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}`,
      DEEPSEEK_MODEL: "mock-model",
      QDRANT_HOST: "127.0.0.1",
      QDRANT_PORT: "1",
      VLLM_BASE_URL: "http://127.0.0.1:1",
      STATIC_DIR: staticDir,
      TRUST_PROXY: "none",
      METRICS_PORT: "0", // ephemeral, so parallel eval servers do not fight over the default port
      LIMIT_REQUEST_TIMEOUT_S: "20",
      RUST_LOG: "warn",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
    await sleep(100);
    if (child.exitCode !== null) throw new Error("server exited: " + logs.slice(-2000));
  }
  return { base, child, logs: () => logs, stop: () => { child.kill("SIGKILL"); } };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function post(base, body, headers = {}) {
  return fetch(base + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const chatBody = (text, mode = "legislation") => ({ messages: [{ role: "user", content: text }], mode });

/** Read an SSE response fully; returns parsed events. */
export async function events(res) {
  const txt = await res.text();
  const out = [];
  for (const block of txt.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    try { out.push(JSON.parse(line.slice(5).trim())); } catch {}
  }
  return { events: out, text: txt };
}

export async function mockStats(mockPort = 9100) {
  return (await fetch(`http://127.0.0.1:${mockPort}/__stats`)).json();
}
/** Every request body the mock has seen, tagged with its kind (main/summary/check/gate). */
export async function mockCaptured(mockPort = 9100) {
  return (await fetch(`http://127.0.0.1:${mockPort}/__captured`)).json();
}
export const mockReset = (mockPort = 9100) => fetch(`http://127.0.0.1:${mockPort}/__reset`, { method: "POST" });

// ---- result recording (consumed by report.mjs) ----
export function record(suite, name, pass, detail = "") {
  let all = [];
  try { all = JSON.parse(fs.readFileSync(RESULTS, "utf8")); } catch {}
  all = all.filter((r) => !(r.suite === suite && r.name === name));
  all.push({ suite, name, pass: !!pass, detail: String(detail).slice(0, 400) });
  fs.writeFileSync(RESULTS, JSON.stringify(all, null, 1));
}

/** node:test wrapper that records pass/fail with a measured detail string. */
export function scenario(t, suite, name, fn) {
  return t(name, async () => {
    try {
      const detail = await fn();
      record(suite, name, true, detail ?? "");
    } catch (e) {
      record(suite, name, false, e?.message ?? e);
      throw e;
    }
  });
}
