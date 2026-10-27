// Live end-to-end check of "bring your own key", in a real browser, against the real server and the
// real Nebius endpoint. Not part of `make evals` (needs a key and the network); run by hand:
//
//   podman run --rm --network host -v "$PWD":/w -w /w/evals --env-file ../.env \
//     -e SERVER_BIN=/w/server/target/x86_64-unknown-linux-musl/release/lawbylaw-server \
//     docker.io/library/node:22-bookworm-slim node byok-browser.e2e.mjs
//
// It proves what unit tests cannot: that the browser is actually allowed to call the provider (CSP and
// CORS), that the key travels only to the provider, that it is not left in the chat database or the
// server's logs, and that a provider error reaches the user in the provider's own words.
// The key is read from the environment, typed into the real Settings form, and redacted from output.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { startServer, sleep, ROOT } from "./lib.mjs";

const require = createRequire((process.env.PW_TOOLS || "/root/.local/lib/deepseek-test-tools") + "/");
const { chromium } = require("playwright");

const KEY = process.env.NEBIUS_API_KEY;
if (!KEY) { console.error("NEBIUS_API_KEY not set"); process.exit(2); }
const BAD_KEY = "sk-this-is-not-a-real-key-0123456789";
const PROVIDER_HOST = "api.tokenfactory.nebius.com";
const BOX = '[aria-label="Ask a legal question"]';
const SHOTS = path.join(ROOT, "evals/screenshots");
fs.mkdirSync(SHOTS, { recursive: true });
const redact = (t) => String(t).split(KEY).join("[redacted-key]");

let failed = 0;
const check = (ok, msg, extra = "") => { if (!ok) failed++; console.log(`${ok ? "✓" : "✗"} ${msg}${extra ? "  " + redact(extra) : ""}`); };

const env = { TAVILY_API_KEY: "", RUST_LOG: "warn", LIMIT_REQUEST_TIMEOUT_S: "120", LIMIT_RATE_BURST: "100", LIMIT_RATE_PER_MIN: "600" };
for (const k of ["QDRANT_HOST", "QDRANT_PORT", "VLLM_BASE_URL", "VLLM_EMBED_MODEL"]) if (process.env[k]) env[k] = process.env[k];
const srv = await startServer({ port: 8441, env });
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
await context.addInitScript(() => { try { localStorage.setItem("lawbylaw.welcome.v3", "seen"); } catch {} }); // first-visit notice already dismissed
const page = await context.newPage();

const requests = []; // everything the page sent, with headers
const pending = [];
page.on("request", (r) => pending.push(r.allHeaders().then((headers) => requests.push({ url: r.url(), method: r.method(), headers, body: r.postData() ?? "" })).catch(() => {})));
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

const readChats = () => page.evaluate(() => new Promise((res) => {
  const o = indexedDB.open("lawbylaw");
  o.onerror = () => res([]);
  o.onsuccess = () => { const r = o.result.transaction("chats").objectStore("chats").getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); };
}));
const assistantText = (c) => (c.messages || []).filter((m) => m.role === "assistant").flatMap((m) => m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");
async function waitForReply(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const chats = await readChats();
    const done = chats.flatMap((c) => c.messages || []).find((m) => m.role === "assistant" && m.finish);
    if (done) return { finish: done.finish, text: chats.map(assistantText).join("") };
    if (await page.locator(".dsm-error-banner").count()) return { finish: "banner", text: "" };
    await sleep(500);
  }
  return { finish: "timeout", text: "" };
}
async function ask(text) {
  await page.click(BOX);
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}
const openSettings = async () => { await page.click('[aria-label="Settings"]'); await page.waitForSelector('[role="dialog"][aria-label="Settings"]'); };
const closeSettings = () => page.click('[aria-label="Close settings"]');
async function saveKey(key, remember = true) {
  await openSettings();
  await page.click('button[aria-pressed]:has-text("Nebius")');
  await page.fill('input[name="provider-api-key"]', key);
  if (!remember) await page.uncheck('input[type="checkbox"]');
  await page.click('button:has-text("Save key")');
}

try {
  await page.goto(srv.base + "/");
  await page.waitForSelector(BOX, { timeout: 15000 });

  // ── CSP lets the browser reach exactly the providers ──────────────────────────────────────────
  const csp = (await fetch(srv.base + "/")).headers.get("content-security-policy") || "";
  check(/connect-src 'self' https:\/\/api\.deepseek\.com https:\/\/api\.tokenfactory\.nebius\.com https:\/\/api\.tavily\.com;/.test(csp), "CSP connect-src allows this site, the two providers and Tavily only");

  // ── The chat box says whose key is in use ─────────────────────────────────────────────────────
  const keySource = () => page.locator(".dsm-keybadge").getAttribute("data-key-source");
  check((await keySource()) === "shared" && /Free shared key/.test(await page.locator(".dsm-keybadge").textContent()), "before a key is saved the chat box says the free shared key is used");

  // ── Settings: save the key ────────────────────────────────────────────────────────────────────
  await saveKey(KEY);
  await page.waitForSelector("text=Using your key");
  const dialogText = await page.textContent('[role="dialog"]');
  check(/ending in/.test(dialogText) && /kept on this device/.test(dialogText), "Settings confirms the key is in use, kept on this device", dialogText.match(/Using your key[^.]*?device/)?.[0] ?? "");
  check(!(await page.content()).includes(KEY), "the full key is not on the page after saving");
  check((await page.locator('input[name="provider-api-key"]').count()) === 0, "the key input is gone (nothing left to copy)");
  check(((await page.evaluate(() => localStorage.getItem("lawbylaw.byok.v1"))) || "").includes(KEY), "the key is stored in this browser");
  await page.screenshot({ path: path.join(SHOTS, "byok-1-saved.png") });
  await closeSettings();
  const ownText = (await page.locator(".dsm-keybadge").textContent()) || "";
  check((await keySource()) === "own" && /Your own key · Nebius/.test(ownText), "after saving, the chat box says it is the visitor's own Nebius key", ownText);
  check(!(await page.locator(".dsm-keybadge").getAttribute("title")).includes(KEY) && !ownText.includes(KEY), "…without showing the key");

  // ── A real answer, browser to provider ────────────────────────────────────────────────────────
  requests.length = 0;
  await ask("In one sentence, what is the minimum age for a binding contract in Singapore? Keep it short.");
  const reply = await waitForReply(170000);
  await Promise.all(pending);
  await page.screenshot({ path: path.join(SHOTS, "byok-2-answer.png") });
  check(reply.finish === "stop" && reply.text.trim().length > 20, "a real answer arrived from the provider", `finish=${reply.finish} text="${reply.text.replace(/\s+/g, " ").slice(0, 140)}"`);
  check((await page.locator(".dsm-error-banner").count()) === 0, "no error banner");

  const own = requests.filter((r) => r.url.startsWith(srv.base));
  const prov = requests.filter((r) => new URL(r.url).host === PROVIDER_HOST);
  check(prov.some((r) => r.method === "POST" && /chat\/completions/.test(r.url)), `the browser called the provider directly (${prov.filter((r) => r.method === "POST").length} POST)`);
  check((await keySource()) === "own" && prov.length > 0, "the badge said own and the turn did go to the provider: what it says is what happens");
  check(!own.some((r) => /\/api\/chat$/.test(new URL(r.url).pathname)), "the app's /api/chat was not used");
  check(own.some((r) => r.url.includes("/api/agent")), "the loop took its prompts and tools from /api/agent");
  const leaks = own.filter((r) => JSON.stringify(r).includes(KEY));
  check(leaks.length === 0, `no request to this site carries the key (${own.length} requests checked)`);
  const bearer = prov.filter((r) => r.method === "POST").every((r) => r.headers.authorization === `Bearer ${KEY}`);
  check(bearer, "the provider calls carry the key in Authorization");
  check(prov.every((r) => !r.headers.cookie && !r.headers.referer), "provider calls carry no cookies and no referrer");
  const toolCalls = own.filter((r) => /\/api\/(tool|cite|links)$/.test(new URL(r.url).pathname)).map((r) => new URL(r.url).pathname);
  console.log(`  · server tool calls during the turn: ${toolCalls.length ? [...new Set(toolCalls)].join(", ") : "none"}`);

  // ── A turn that needs the legal database: tools, sub-agents and citations through the server ──
  requests.length = 0;
  const before = (await readChats()).flatMap((c) => c.messages || []).filter((m) => m.role === "assistant" && m.finish).length;
  await ask("Search the Singapore legislation database and tell me what section 13 of the Evidence Act 1893 says about when facts are relevant. Quote the key words and cite the section.");
  let second = { finish: "timeout", text: "" };
  for (const t0 = Date.now(); Date.now() - t0 < 240000;) {
    const msgs = (await readChats()).flatMap((c) => c.messages || []).filter((m) => m.role === "assistant" && m.finish);
    if (msgs.length > before) { const last = msgs[msgs.length - 1]; second = { finish: last.finish, text: (last.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("") }; break; }
    await sleep(700);
  }
  await Promise.all(pending);
  await page.screenshot({ path: path.join(SHOTS, "byok-2b-tools.png") });
  const used = requests.filter((r) => r.url.startsWith(srv.base)).map((r) => new URL(r.url).pathname);
  const count = (p) => used.filter((u) => u === p).length;
  console.log(`  · server calls: tool×${count("/api/tool")} cite×${count("/api/cite")} links×${count("/api/links")}; provider POSTs: ${requests.filter((r) => new URL(r.url).host === PROVIDER_HOST && r.method === "POST").length}`);
  check(second.finish === "stop" && second.text.trim().length > 40, "a legal-research turn completes through tools", `finish=${second.finish} text="${second.text.replace(/\s+/g, " ").slice(0, 200)}"`);
  check(count("/api/tool") > 0, "the model's searches ran on the server's stateless tool endpoint");
  check(!requests.some((r) => r.url.startsWith(srv.base) && JSON.stringify(r).includes(KEY)), "…and still no request to this site carries the key");
  const withLinks = /sso\.agc\.gov\.sg/.test(await page.content());
  console.log(`  · answer has SSO links: ${withLinks}`);

  // ── /compact: the Nemotron compact model, through the same Nebius key ─────────────────────────
  const COMPACT_MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
  const doneCount = async () => (await readChats()).flatMap((c) => c.messages || []).filter((m) => m.role === "assistant" && m.finish).length;
  // /compact keeps the latest four messages and summarises the rest, and it refuses a summary that would not be
  // shorter than what it replaces. So the chat must be long enough to be worth compacting: two long answers first.
  const qs = [
    "In about 250 words, explain what makes a contract binding in Singapore: offer, acceptance, consideration and intention. No searching needed.",
    "In about 250 words, explain the difference between a condition and a warranty in a contract. No searching needed.",
    "Reply with just the word: noted.",
    "Reply with just the word: understood.",
  ];
  for (const q of qs) {
    const n = await doneCount();
    await ask(q);
    for (const t0 = Date.now(); Date.now() - t0 < 170000 && (await doneCount()) <= n;) await sleep(500);
    await sleep(400);
  }
  check((await doneCount()) === 6, "six real turns are in the chat before /compact", `turns=${await doneCount()}`);
  requests.length = 0;
  const noticeCount = () => page.locator(".dsm-notice").count();
  const noticesBefore = await noticeCount();
  await ask("/compact");
  for (const t0 = Date.now(); Date.now() - t0 < 120000 && (await noticeCount()) === noticesBefore && !(await page.locator(".dsm-error-banner").count());) await sleep(500);
  await Promise.all(pending);
  await page.screenshot({ path: path.join(SHOTS, "byok-4-compact.png") });
  const notice = ((await page.locator(".dsm-notice").last().textContent().catch(() => "")) || "").trim();
  console.log(`  · notice: ${redact(notice)}`);
  check((await page.locator(".dsm-error-banner").count()) === 0, "/compact raised no error banner");
  check(/Summarised the earlier \d+ messages with NVIDIA Nemotron 3 Nano/.test(notice), "the chat says what was summarised and by which model", notice);
  check((await page.locator(".dsm-compaction-divider").count()) === 1, "the 'Summarised conversation' divider is shown");
  const cprov = requests.filter((r) => new URL(r.url).host === PROVIDER_HOST && r.method === "POST");
  check(cprov.length === 1 && JSON.parse(cprov[0].body).model === COMPACT_MODEL, "exactly one provider call, to the compact model", cprov.map((r) => JSON.parse(r.body).model).join(","));
  check(cprov.every((r) => r.headers.authorization === `Bearer ${KEY}`), "…carrying the user's key");
  check(!requests.some((r) => r.url.startsWith(srv.base) && JSON.stringify(r).includes(KEY)), "…and no request to this site carries the key");
  check(!requests.some((r) => /\/api\/chat$/.test(new URL(r.url).pathname)), "/compact was not sent to the assistant as a question");
  const stored = (await readChats()).find((c) => c.compaction);
  check(!!stored && stored.compaction.summary.length > 100, "a summary is stored with the chat", `chars=${stored?.compaction?.summary?.length}`);
  check(!/[\u00a0\u202f\u2011]/.test(stored?.compaction?.summary || ""), "…with plain spaces and hyphens (no typographic ones)");
  console.log(`  · summary: ${redact((stored?.compaction?.summary || "").replace(/\s+/g, " ").slice(0, 300))}`);
  if (process.env.SHOW_COMPACT) {
    // Quality review: the whole summary next to what it replaced.
    for (const m of stored?.messages || []) console.log(`  [${m.role}] ${(m.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("").replace(/\s+/g, " ").slice(0, 700)}`);
    console.log(`  SUMMARY:\n${redact(stored?.compaction?.summary || "")}`);
  }
  check(!JSON.stringify(await readChats()).includes(KEY), "the key is still not in the chat database");
  requests.length = 0;
  const n5 = await doneCount();
  await ask("Reply with just the word: finished.");
  for (const t0 = Date.now(); Date.now() - t0 < 170000 && (await doneCount()) <= n5;) await sleep(500);
  await Promise.all(pending);
  const next = requests.filter((r) => new URL(r.url).host === PROVIDER_HOST && r.method === "POST").map((r) => JSON.parse(r.body));
  check(next.length > 0 && next.every((b) => b.model !== COMPACT_MODEL), "the next question goes to the main model again");
  check(next.some((b) => JSON.stringify(b.messages).includes("[Summary of the earlier part of this conversation]")), "…and carries the summary instead of the older turns");
  check((await page.locator(".dsm-error-banner").count()) === 0, "…without an error");

  // ── Where the key is not ──────────────────────────────────────────────────────────────────────
  check(!JSON.stringify(await readChats()).includes(KEY), "the key is not in the chat database");
  check(!srv.logs().includes(KEY), "the server's logs never saw the key");

  // ── A provider error reaches the user in the provider's own words ─────────────────────────────
  await openSettings();
  await page.click('button:has-text("Remove key")');
  await closeSettings();
  await saveKey(BAD_KEY);
  await closeSettings();
  await ask("hello");
  await page.waitForSelector(".dsm-error-banner", { timeout: 60000 }).catch(() => {});
  const banner = (await page.locator(".dsm-error-banner").first().textContent().catch(() => "")) || "";
  await page.screenshot({ path: path.join(SHOTS, "byok-3-provider-error.png") });
  check(banner.length > 0, "a rejected key shows an error to the user", banner);
  check(/rejected your API key/.test(banner) && /Nebius said: "/.test(banner), "…with the provider's own message after ours");
  check(!banner.includes(BAD_KEY) && !banner.includes(KEY), "…and never the key");

  // ── Remove ────────────────────────────────────────────────────────────────────────────────────
  await openSettings();
  await page.click('button:has-text("Remove key")');
  check((await page.evaluate(() => localStorage.getItem("lawbylaw.byok.v1"))) === null, "Remove key deletes it from this browser");
  check((await page.locator('input[name="provider-api-key"]').count()) === 1, "the paste form is back");
  check((await keySource()) === "shared", "the chat box is back to the free shared key");
  await closeSettings();

  const csps = consoleErrors.filter((e) => /Content Security Policy|CORS|blocked by/i.test(e));
  check(csps.length === 0, "no CSP or CORS errors in the console", csps.join(" | "));
} catch (e) {
  failed++;
  console.log("✗ script error:", redact(e?.stack || e));
} finally {
  await browser.close();
  srv.stop();
}
console.log(failed ? `\nFAILED: ${failed} problem(s)` : "\nPASSED");
process.exit(failed ? 1 : 0);
