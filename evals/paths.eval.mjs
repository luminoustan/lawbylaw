// Live path/header probe. Spends no tokens and sends no chat. Safe against local or prod.
//
//   BASE_URL=http://localhost:8000 node evals/paths.eval.mjs
//
// Checks that /admin* and unknown /api paths are 404s (never the app shell, any spelling or method),
// that traversal and dotfile probes serve nothing, that security headers are on error answers,
// that junk never produces a 5xx or leaks internals, and that the apex host is not serving the app.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const UA = "Mozilla/5.0 lawbylaw-paths-eval";

// fetch() normalises paths ("..", "%2e"), so use a raw request to send them as written.
function raw(method, path, { host, body } = {}) {
  const u = new URL(BASE);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { hostname: u.hostname, port: u.port || undefined, method, path, headers: { "user-agent": UA, ...(host ? { host } : {}), ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) } },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isShell = (t) => /<div id="root"/i.test(t);

let failed = 0;
const check = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); };

const reserved = ["/admin", "/admin/", "/admin/users", "/adminfoo", "/ADMIN", "/admin.php", "/%61dmin", "//admin", "/./admin", "/x/../admin", "/api/nope", "/API/nope", "/%61pi/chat"];
for (const p of reserved) {
  for (const m of ["GET", "POST", "PUT", "DELETE"]) {
    const r = await raw(m, p);
    // Cloudflare may answer first (403/429); anything but the app shell or a 2xx is fine.
    check(r.status !== 200 && !isShell(r.text) && r.status < 500, `${m} ${p} -> ${r.status}`);
    await sleep(120);
  }
}
for (const p of ["/../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc/passwd", "/.env", "/.git/config", "/index.html.bak", "/metrics", "/server/Cargo.toml", "/assets/../../etc/passwd"]) {
  const r = await raw("GET", p);
  check(!/root:|\[core\]|DEEPSEEK|SESSION_HMAC|lbl_|\[package\]/.test(r.text) && r.status < 500, `traversal/dotfile ${p} -> ${r.status}`);
  await sleep(120);
}
for (const [m, p] of [["GET", "/"], ["GET", "/admin"], ["GET", "/api/nope"], ["GET", "/api/chat"], ["DELETE", "/api/session"], ["POST", "/api/tool"]]) {
  const r = await raw(m, p, { body: m === "POST" ? "{" : undefined });
  const h = r.headers;
  // A Cloudflare WAF block page is served at the edge, before the app: it has no app headers.
  if (r.status === 403 && /cloudflare/i.test(h.server || "") && /Attention Required|cf-error/i.test(r.text)) {
    check(true, `blocked at the Cloudflare edge: ${m} ${p}`);
    continue;
  }
  check(!!h["content-security-policy"] && h["x-content-type-options"] === "nosniff" && h["x-frame-options"] === "DENY" && !!h["referrer-policy"], `security headers on ${m} ${p} (${r.status})`);
  check(r.status < 500 && !/panicked|RUST_BACKTRACE|127\.0\.0\.1|\.svc\.cluster|src\//.test(r.text), `no 5xx or internals on ${m} ${p}`);
  await sleep(120);
}
// 502/503 are allowed below: the app answers early and closes while the tunnel is still uploading.
for (const p of ["/api/chat", "/api/tool", "/api/cite", "/api/links", "/api/compact"]) {
  const r = await raw("POST", p, { body: "x".repeat(2 * 1024 * 1024) }).catch(() => ({ status: 413, text: "" }));
  check([400, 401, 403, 413, 429, 502, 503].includes(r.status), `oversized body ${p} -> ${r.status}`);
  await sleep(200);
}
const apex = process.env.APEX_URL;
if (apex) {
  const r = await fetch(apex, { headers: { "user-agent": UA }, redirect: "manual" });
  const t = await r.text();
  check(!isShell(t), `apex ${apex} does not serve the app (${r.status})`);
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
assert.equal(failed, 0);
