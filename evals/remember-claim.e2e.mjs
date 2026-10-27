// Verifies the Settings claim: "Remember on this device (otherwise it is forgotten when you close this tab)".
// Real Chromium with a persistent profile, so "closing the browser" really keeps or drops what the browser keeps.
// Usage: BASE=http://localhost:8000 node remember-claim.e2e.mjs      (dummy keys only; nothing is sent anywhere)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire((process.env.PW_TOOLS || "/root/.local/lib/deepseek-test-tools") + "/");
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:8000";
const MODEL = "sk-claim-model-0123456789abcdef";
const TAVILY = "tvly-claim-search-0123456789abcdef";
const BOX = '[aria-label="Ask a legal question"]';
let failed = 0;
const check = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? "✓" : "✗"} ${msg}`); };

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claim-"));
const launch = () => chromium.launchPersistentContext(profile, { args: ["--no-sandbox"], viewport: { width: 1100, height: 800 } });
const stored = (page) => page.evaluate(() => ({
  local: [localStorage.getItem("lawbylaw.byok.v1") !== null, localStorage.getItem("lawbylaw.tavily.v1") !== null],
  session: [sessionStorage.getItem("lawbylaw.byok.v1") !== null, sessionStorage.getItem("lawbylaw.tavily.v1") !== null],
}));
async function open(ctx) {
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem("lawbylaw.welcome.v3", "seen"); } catch {} });
  await page.goto(BASE + "/");
  await page.waitForSelector(BOX, { timeout: 15000 });
  return page;
}
const settings = async (page) => {
  if (!(await page.locator('[role="dialog"][aria-label="Settings"]').count())) await page.click('button[aria-label="Settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]');
};
const hasSavedModel = (page) => page.locator("text=Using your key").count().then((n) => n > 0);

async function saveBoth(page, remember) {
  await settings(page);
  await page.click('button[aria-pressed]:has-text("Nebius")');
  await page.fill('input[name="provider-api-key"]', MODEL);
  const boxes = page.locator('form input[type="checkbox"]');
  await boxes.nth(0).setChecked(remember);
  await page.click('button:has-text("Save key")');
  await page.fill('input[name="search-api-key"]', TAVILY);
  await page.locator('form input[type="checkbox"]').last().setChecked(remember);
  await page.click('button:has-text("Save Tavily key")');
  await page.waitForSelector('[data-testid="tavily-status"]');
}
const label = async (page) => (await page.locator('[role="dialog"]').textContent()).match(/kept [a-z ]+(device|tab|reload)/g) || [];

// ── A. Box ticked ("Remember on this device") ───────────────────────────────────────────────
let ctx = await launch();
let page = await open(ctx);
await saveBoth(page, true);
let s = await stored(page);
check(s.local[0] && s.local[1] && !s.session[0] && !s.session[1], "ticked: both keys are in localStorage, not sessionStorage");
console.log("   Settings says:", (await label(page)).join(" | "));
await page.reload(); await page.waitForSelector(BOX);
check((await stored(page)).local.every(Boolean), "ticked: survives a reload");
await page.close();
const tab2 = await open(ctx);
check((await stored(tab2)).local.every(Boolean), "ticked: still there after closing the tab and opening a new one");
check((await tab2.locator(".dsm-keybadge").getAttribute("data-key-source")) === "own", "ticked: the chat box still says it is using your own key");
await ctx.close();
ctx = await launch();
page = await open(ctx);
check((await stored(page)).local.every(Boolean), "ticked: still there after closing and reopening the whole browser");
await settings(page);
check(await hasSavedModel(page), "ticked: Settings shows the key as in use after the browser restarts");
// clean up
await page.click('[data-testid="tavily-settings"] button:has-text("Remove key")');
await page.locator('button:has-text("Remove key")').first().click();
s = await stored(page);
check(!s.local.some(Boolean) && !s.session.some(Boolean), "Remove key clears both");
await ctx.close();

// ── B. Box cleared ("otherwise it is forgotten when you close this tab") ────────────────────
ctx = await launch();
page = await open(ctx);
await saveBoth(page, false);
s = await stored(page);
check(s.session[0] && s.session[1] && !s.local[0] && !s.local[1], "unticked: both keys are in sessionStorage only, nothing in localStorage");
console.log("   Settings says:", (await label(page)).join(" | "));
await page.reload(); await page.waitForSelector(BOX);
check((await stored(page)).session.every(Boolean), "unticked: survives a reload of the same tab (the tab is still open)");
const other = await open(ctx);
check(!(await stored(other)).session.some(Boolean) && !(await stored(other)).local.some(Boolean), "unticked: a second tab open at the same time does NOT have it");
check((await other.locator(".dsm-keybadge").getAttribute("data-key-source")) === "shared", "unticked: that second tab says Free shared key");
await other.close();
await page.close();
const fresh = await open(ctx);
check(!(await stored(fresh)).session.some(Boolean) && !(await stored(fresh)).local.some(Boolean), "unticked: gone once the tab is closed (a new tab has nothing)");
check((await fresh.locator(".dsm-keybadge").getAttribute("data-key-source")) === "shared", "unticked: the chat box is back on the Free shared key");
await ctx.close();
ctx = await launch();
page = await open(ctx);
check(!(await stored(page)).session.some(Boolean) && !(await stored(page)).local.some(Boolean), "unticked: gone after closing and reopening the whole browser");
await ctx.close();

// ── C. Switching the choice replaces the earlier copy ───────────────────────────────────────
ctx = await launch();
page = await open(ctx);
await saveBoth(page, true);
await page.click('[data-testid="tavily-settings"] button:has-text("Remove key")');
await page.locator('button:has-text("Remove key")').first().click();
await saveBoth(page, false);
s = await stored(page);
check(s.session[0] && !s.local[0] && s.session[1] && !s.local[1], "re-saving unticked moves the keys out of localStorage (no stale persistent copy)");
await ctx.close();

fs.rmSync(profile, { recursive: true, force: true });
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
