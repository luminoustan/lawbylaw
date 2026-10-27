// Cyber-checklist controls: route table, /admin lockdown, PII/data-leak scan, headers, bundle budget.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startMock } from "./mock-deepseek.mjs";
import { startServer, post, chatBody, events, scenario, ROOT, CANARY_KEY } from "./lib.mjs";

const S = "checklist";
let mock, srv;
before(async () => {
  mock = await startMock(9100);
  srv = await startServer({ port: 8201, env: { LIMIT_RATE_BURST: "50", LIMIT_RATE_PER_MIN: "600" } });
});
after(() => { srv.stop(); mock.close(); });

const isSpa = (txt) => /<div id="root"|<script type="module"/.test(txt);

test("route table is exactly the public surface", async (t) => {
  const T = t.test.bind(t);
  await scenario(T, S, "GET /api/limits + /api/health only public GETs", async () => {
    for (const p of ["/api/limits", "/api/health"]) {
      const r = await fetch(srv.base + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get("content-type") || "", /json/);
      await r.json();
    }
    return "both 200 JSON";
  });
  const blocked = [
    ["GET", "/admin"], ["GET", "/admin/"], ["GET", "/admin/users"], ["POST", "/admin/login"],
    ["GET", "/adminfoo"], ["GET", "/administrator"], ["GET", "/ADMIN"],
    ["GET", "/api/admin/stats"], ["POST", "/api/rag/upload"], ["DELETE", "/api/rag/collection"],
    ["GET", "/api/settings"], ["PUT", "/api/settings"], ["GET", "/api/chat/sessions"],
    ["GET", "/api/chat/sessions/abc"], ["DELETE", "/api/chat/sessions/abc"], ["POST", "/api/auth/google"],
    ["GET", "/api/auth/me"], ["POST", "/api/stripe/webhook"], ["GET", "/api/debug"], ["GET", "/api/v1/chat"],
    ["PATCH", "/api/chat/sessions"], ["GET", "/api/openapi.json"], ["GET", "/api/docs"],
  ];
  for (const [m, p] of blocked) {
    await scenario(T, S, `anonymous ${m} ${p} -> 404`, async () => {
      const r = await fetch(srv.base + p, { method: m, body: m === "GET" || m === "DELETE" ? undefined : "{}" });
      const txt = await r.text();
      assert.equal(r.status, 404, `got ${r.status}`);
      assert.ok(!isSpa(txt), "must not serve the app shell");
      return "404";
    });
  }
  await scenario(T, S, "/metrics is not exposed publicly", async () => {
    const r = await fetch(srv.base + "/metrics"); const txt = await r.text();
    assert.doesNotMatch(txt, /# HELP|_total\b/);
    return `${r.status}, no prometheus text`;
  });
  await scenario(T, S, "no duplicate chat routes (trailing slash / case / version)", async () => {
    for (const p of ["/api/chat/", "/API/chat", "/api/chat/stream", "/api/v2/chat"]) {
      const r = await fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chatBody("route probe " + p)) }); await r.text();
      assert.notEqual(r.status, 200, `${p} answered 200`);
    }
    return "only POST /api/chat answers";
  });
  await scenario(T, S, "POST /api/tool and /api/cite are the extra routes: JSON in, JSON out, no LLM key needed", async () => {
    const call = (body, method = "POST") => fetch(srv.base + "/api/tool", { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined });
    const ok = await call({ tool: "get_section", args: { source_file: "x.json", section_id: "1" } });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.ok(typeof j.result === "string" && Array.isArray(j.citations) && Array.isArray(j.sections), "response shape");
    for (const body of [{ tool: "research_legislation", args: { prompt: "x" } }, { tool: "get_section", context: "nope" }, { nope: 1 }]) {
      const r = await call(body); await r.text();
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const g = await call(undefined, "GET"); await g.text();
    assert.notEqual(g.status, 200, "GET must not answer");
    assert.ok(!isSpa(await (await call({ tool: "x" })).text()), "never the app shell");
    const cite = (body) => fetch(srv.base + "/api/cite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const none = await (await cite({ kind: "legislation", output: "[]", sections: [] })).json();
    assert.equal(none.result, "No relevant provisions found.");
    for (const body of [{ kind: "tax", output: "[]" }, { kind: "legislation" }, { kind: "legislation", output: "[]", sections: [{ text: 1 }] }]) {
      const r = await cite(body); await r.text();
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const bundle = await (await fetch(srv.base + "/api/agent?mode=legislation")).json();
    assert.ok(bundle.system_prompt.length > 1000 && Array.isArray(bundle.tools) && bundle.params.max_web_searches > 0, "agent bundle shape");
    assert.ok(Object.keys(bundle.agent_tools).every((t) => bundle.tools.some((x) => x.function.name === t)), "routed tools are offered");
    assert.ok(!JSON.stringify(bundle).includes(CANARY_KEY), "bundle must not carry the provider key");
    assert.equal((await fetch(srv.base + "/api/agent?mode=nope")).status, 400);
    return "shape ok, LLM-calling tools refused, GET refused, /api/cite validates, /api/agent bundle is key-free";
  });
  await scenario(T, S, "path traversal on static files is refused", async () => {
    for (const p of ["/../server/Cargo.toml", "/%2e%2e/server/Cargo.toml", "/assets/../../.env", "/..%2f..%2f.env"]) {
      const r = await fetch(srv.base + p); const txt = await r.text();
      assert.doesNotMatch(txt, /\[package\]|DEEPSEEK_API_KEY/, p);
    }
    return "no file escape";
  });
});

test("data leakage (what dev tools / network tab would reveal)", async (t) => {
  const T = t.test.bind(t);
  await scenario(T, S, "no PII, secrets or cookies in any API response", async () => {
    const parts = [];
    let setCookie = false;
    for (const p of ["/api/limits", "/api/health"]) {
      const r = await fetch(srv.base + p); parts.push(await r.text()); if (r.headers.get("set-cookie")) setCookie = true;
    }
    const r = await post(srv.base, chatBody("what is a contract?")); if (r.headers.get("set-cookie")) setCookie = true;
    parts.push((await events(r)).text);
    const all = parts.join("\n");
    assert.ok(!setCookie, "Set-Cookie present");
    assert.doesNotMatch(all, /[\w.+-]+@[\w-]+\.[\w.]+/, "email-like string");
    assert.doesNotMatch(all, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, "IP address");
    assert.doesNotMatch(all, /user_id|email|password|api[_-]?key|secret|bearer|session_id/i);
    assert.ok(!all.includes(CANARY_KEY));
    return "clean";
  });
  await scenario(T, S, "/api/limits does not expose internal budgets", async () => {
    const j = await (await fetch(srv.base + "/api/limits")).json();
    for (const k of ["global_concurrency", "daily_token_budget", "model_window", "assistant_chars"]) assert.ok(!(k in j), k);
    return "keys: " + Object.keys(j).join(",");
  });
  await scenario(T, S, "/api/health leaks no infra detail", async () => {
    const txt = await (await fetch(srv.base + "/api/health")).text();
    assert.doesNotMatch(txt, /127\.0\.0\.1|qdrant_host|http:\/\//);
    return txt.slice(0, 160);
  });
  await scenario(T, S, "error pages reveal no stack traces / paths", async () => {
    const bad = await post(srv.base, "{oops"); const t1 = await bad.text();
    const nf = await fetch(srv.base + "/api/nope"); const t2 = await nf.text();
    assert.doesNotMatch(t1 + t2, /panicked|\/app\/|src\/|\.rs:|axum|hyper/i);
    return "generic bodies";
  });
  await scenario(T, S, "built bundle contains no secrets", async () => {
    const dist = path.join(ROOT, "web/dist");
    const files = fs.readdirSync(path.join(dist, "assets")).map((f) => path.join(dist, "assets", f));
    files.push(path.join(dist, "index.html"));
    for (const f of files) {
      const txt = fs.readFileSync(f, "utf8");
      assert.doesNotMatch(txt, /sk-[A-Za-z0-9]{20,}|DEEPSEEK_API_KEY|BEGIN (RSA )?PRIVATE KEY/, f);
    }
    return `${files.length} files scanned`;
  });
});

test("hardening headers", async (t) => {
  await scenario(t.test.bind(t), S, "CSP / framing / sniffing headers", async () => {
    const r = await fetch(srv.base + "/"); await r.text();
    const csp = r.headers.get("content-security-policy") || "";
    assert.match(csp, /frame-ancestors 'none'/);
    // The browser may reach this site and the two LLM providers a user can bring a key for, nothing else.
    assert.match(csp, /connect-src 'self' https:\/\/api\.deepseek\.com https:\/\/api\.tokenfactory\.nebius\.com https:\/\/api\.tavily\.com(;|$)/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.ok(r.headers.get("cross-origin-opener-policy"));
    return csp.slice(0, 200);
  });
  await scenario(t.test.bind(t), S, "chat responses are not cacheable", async () => {
    const r = await post(srv.base, chatBody("cache probe")); await r.text();
    assert.match(r.headers.get("cache-control") || "", /no-store/);
    return "no-store";
  });
});

test("old-phone budget: bundle size", async (t) => {
  await scenario(t.test.bind(t), S, "JS/CSS gzip budget", async () => {
    const zlib = await import("node:zlib");
    const dir = path.join(ROOT, "web/dist/assets");
    let js = 0, css = 0, jsRaw = 0;
    for (const f of fs.readdirSync(dir)) {
      const buf = fs.readFileSync(path.join(dir, f));
      const gz = zlib.gzipSync(buf).length;
      if (f.endsWith(".js")) { js += gz; jsRaw += buf.length; }
      if (f.endsWith(".css")) css += gz;
    }
    const kb = (n) => (n / 1024).toFixed(0);
    assert.ok(js < 450 * 1024, `js gzip ${kb(js)}KB over 450KB budget`);
    assert.ok(css < 60 * 1024, `css gzip ${kb(css)}KB over 60KB budget`);
    return `js ${kb(js)}KB gz (${kb(jsRaw)}KB raw), css ${kb(css)}KB gz`;
  });
});
