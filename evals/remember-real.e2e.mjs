// Live check of "Remember on this device" with REAL keys (NEBIUS_API_KEY, TAVILY_API_KEY from the environment),
// in real Chromium with a persistent profile, against a running app. Keys are typed into the real Settings form
// and redacted from all output. Usage (from this folder):
//   podman run --rm --network host -v "$PWD/..":/w -w /w/evals --env-file ../.env -e BASE=http://localhost:8000 \
//     docker.io/library/node:22-bookworm-slim node remember-real.e2e.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire((process.env.PW_TOOLS || "/root/.local/lib/deepseek-test-tools") + "/");
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:8000";
const NEBIUS = process.env.NEBIUS_API_KEY, TAVILY = process.env.TAVILY_API_KEY;
if (!NEBIUS || !TAVILY) { console.error("NEBIUS_API_KEY and TAVILY_API_KEY must be set"); process.exit(2); }
const BOX = '[aria-label="Ask a legal question"]';
const redact = (t) => String(t).split(NEBIUS).join("[nebius-key]").split(TAVILY).join("[tavily-key]");
let failed = 0;
const check = (ok, msg, extra = "") => { if (!ok) failed++; console.log(`${ok ? "✓" : "✗"} ${msg}${extra ? "  " + redact(extra) : ""}`); };
const QUESTION = "Search the web for the current Singapore MOM Employment Pass minimum qualifying salary and tell me the figure, citing the page.";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "real-"));
const launch = () => chromium.launchPersistentContext(profile, { args: ["--no-sandbox"], viewport: { width: 1100, height: 800 } });
const store = (page) => page.evaluate(() => ({
  local: ["lawbylaw.byok.v1", "lawbylaw.tavily.v1"].map((k) => localStorage.getItem(k) !== null),
  session: ["lawbylaw.byok.v1", "lawbylaw.tavily.v1"].map((k) => sessionStorage.getItem(k) !== null),
}));

/** Everything a page sends, so leaks to this site or to a provider can be audited afterwards. */
function watch(page, log) {
  page.on("request", (r) => log.push({ url: r.url(), method: r.method(), headers: JSON.stringify(r.headers()), body: r.postData() ?? "" }));
}
async function open(ctx, log) {
  const page = await ctx.newPage();
  if (log) watch(page, log);
  await page.addInitScript(() => { try { localStorage.setItem("lawbylaw.welcome.v3", "seen"); } catch {} });
  await page.goto(BASE + "/");
  await page.waitForSelector(BOX, { timeout: 15000 });
  return page;
}
async function saveKeys(page, remember) {
  if (!(await page.locator('[role="dialog"][aria-label="Settings"]').count())) await page.click('button[aria-label="Settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]');
  await page.click('button[aria-pressed]:has-text("Nebius")');
  await page.fill('input[name="provider-api-key"]', NEBIUS);
  await page.locator('form input[type="checkbox"]').nth(0).setChecked(remember);
  await page.click('button:has-text("Save key")');
  await page.fill('input[name="search-api-key"]', TAVILY);
  await page.locator('form input[type="checkbox"]').last().setChecked(remember);
  await page.click('button:has-text("Save Tavily key")');
  await page.waitForSelector('[data-testid="tavily-status"]');
  await page.click('[aria-label="Close settings"]');
}
const source = (page) => page.locator(".dsm-keybadge").getAttribute("data-key-source");
const answerText = (page) => page.locator(".dsm-turn").last().innerText();

/** Ask one question; resolves when the turn ends (links scan for own key, SSE end for the shared key). */
async function ask(page, log) {
  const before = log.length;
  await page.click(BOX);
  await page.keyboard.insertText(QUESTION);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop"], [aria-label="Stop generating"]') && document.querySelectorAll(".dsm-turn").length > 0, null, { timeout: 5000 }).catch(() => {});
  const deadline = Date.now() + 200_000;
  let ended = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    const seen = log.slice(before);
    const own = (await source(page)) === "own";
    ended = own ? seen.some((r) => r.url.endsWith("/api/links")) : seen.some((r) => r.url.endsWith("/api/chat"));
    const busy = await page.locator('button[aria-label*="Stop"]').count();
    if (ended && !busy) break;
  }
  await page.waitForTimeout(1500);
  return log.slice(before);
}
const hits = (reqs, host) => reqs.filter((r) => new URL(r.url).host === host);
const leaked = (reqs) => reqs.filter((r) => new URL(r.url).origin === BASE && [NEBIUS, TAVILY].some((k) => r.url.includes(k) || r.headers.includes(k) || r.body.includes(k)));

try {
  // ── 1. Ticked: real chat with real keys, then a full browser restart ────────────────────────
  console.log("— ticked (Remember on this device) —");
  let log = [];
  let ctx = await launch();
  let page = await open(ctx, log);
  await saveKeys(page, true);
  check((await source(page)) === "own", "chat box says it is using your own key");
  let reqs = await ask(page, log);
  check(hits(reqs, "api.tokenfactory.nebius.com").length > 0, "the answer was written by Nebius, called from the browser");
  check(hits(reqs, "api.tavily.com").length > 0, "the web search went from the browser to api.tavily.com", `${hits(reqs, "api.tavily.com").length} search call(s)`);
  check(!reqs.some((r) => r.url.endsWith("/api/chat")), "the site's /api/chat was not used");
  check(!reqs.some((r) => r.url.endsWith("/api/tool") && r.body.includes("web_search_tavily")), "the site was not asked to search");
  check(leaked(reqs).length === 0, "neither real key appears in any request to this site");
  const ans1 = await answerText(page);
  check(ans1.length > 200, "a real answer came back", `${ans1.length} chars`);
  await ctx.close();

  ctx = await launch();
  log = [];
  page = await open(ctx, log);
  check((await store(page)).local.every(Boolean), "after closing and reopening the browser both keys are still stored");
  check((await source(page)) === "own", "…and the chat box still says your own key");
  reqs = await ask(page, log);
  check(hits(reqs, "api.tokenfactory.nebius.com").length > 0, "a new question after the restart is answered with the remembered key, no re-entry");
  check(leaked(reqs).length === 0, "still nothing sent to this site");
  // remove
  await page.click('button[aria-label="Settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]');
  await page.click('[data-testid="tavily-settings"] button:has-text("Remove key")');
  await page.locator('button:has-text("Remove key")').first().click();
  await ctx.close();

  // ── 2. Unticked: works now, gone with the tab ───────────────────────────────────────────────
  console.log("— unticked (forgotten when you close this tab) —");
  ctx = await launch();
  log = [];
  page = await open(ctx, log);
  await saveKeys(page, false);
  check((await store(page)).session.every(Boolean) && !(await store(page)).local.some(Boolean), "kept in sessionStorage only");
  reqs = await ask(page, log);
  check(hits(reqs, "api.tokenfactory.nebius.com").length > 0 && leaked(reqs).length === 0, "chat works with it, and nothing leaks to this site");

  // real-world cases beyond the wording
  const sameTab = await store(page);
  await page.reload(); await page.waitForSelector(BOX);
  check((await source(page)) === "own", "a reload of the same tab keeps it", JSON.stringify(sameTab.session));
  const [popup] = await Promise.all([ctx.waitForEvent("page"), page.evaluate(() => window.open(location.href, "_blank"))]);
  await popup.waitForSelector(BOX);
  const dup = await store(popup);
  console.log(`   note: a tab opened by this one (window.open / link with opener) ${dup.session.every(Boolean) ? "DOES inherit" : "does not inherit"} the unticked keys`);
  await popup.close();
  const plain = await open(ctx, []);
  check(!(await store(plain)).session.some(Boolean) && (await source(plain)) === "shared", "a separate new tab does not have it (Free shared key)");
  await plain.close();
  await page.close();
  const after = await open(ctx, log = []);
  check(!(await store(after)).session.some(Boolean) && !(await store(after)).local.some(Boolean), "after closing the tab, nothing is left");
  reqs = await ask(after, log);
  check(reqs.some((r) => r.url.endsWith("/api/chat")) && hits(reqs, "api.tokenfactory.nebius.com").length === 0, "…and the next question goes through the site's free key instead (/api/chat)");
  check(leaked(reqs).length === 0, "no real key in any request to the site");
  await ctx.close();
} catch (e) {
  failed++;
  console.log("✗ run aborted:", redact(e?.stack || e));
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
