// Real-browser evals (Playwright + Chromium) against the real server serving web/dist.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { startMock } from "./mock-deepseek.mjs";
import { startServer, scenario, sleep, mockStats, mockReset, ROOT } from "./lib.mjs";

const require = createRequire((process.env.PW_TOOLS || "/root/.local/lib/deepseek-test-tools") + "/");
const { chromium, devices } = require("playwright");

const S = "browser";
const SHOTS = path.join(ROOT, "evals/screenshots");
fs.mkdirSync(SHOTS, { recursive: true });
let mock, srv, browser;
const BOX = '[aria-label="Ask a legal question"]';

before(async () => {
  mock = await startMock(9100);
  srv = await startServer({ port: 8301, env: { LIMIT_RATE_BURST: "100", LIMIT_RATE_PER_MIN: "600", LIMIT_REPEAT_MAX: "3", LIMIT_IP_CONCURRENCY: "3", LIMIT_FINAL_CHECK: "0" } });
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});
after(async () => { await browser?.close(); srv?.stop(); mock?.close(); });

// The first-visit notice covers the page until dismissed; every test but its own starts with it already seen.
const WELCOME_KEY = "lawbylaw.welcome.v3";
const markSeen = (context) => context.addInitScript((k) => { try { localStorage.setItem(k, "seen"); } catch {} }, WELCOME_KEY);

async function open(ctxOpts = {}, base = srv.base, { welcome = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, ...ctxOpts });
  if (!welcome) await markSeen(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(base + "/");
  await page.waitForSelector(BOX, { timeout: 15000 });
  return { context, page, errors };
}
async function ask(page, text) {
  await page.click(BOX);
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + ".png") });

test("boot, chat, persistence and isolation", async (t) => {
  const T = t.test.bind(t);
  const A = await open();
  await scenario(T, S, "app boots with no console errors", async () => {
    await shot(A.page, "01-boot");
    const real = A.errors.filter((e) => !/favicon/.test(e));
    assert.deepEqual(real, []);
    return "composer visible, 0 errors";
  });
  await scenario(T, S, "ask a question and get a streamed answer", async () => {
    await ask(A.page, "What is a contract?");
    await A.page.waitForSelector("text=mock answer", { timeout: 15000 });
    await shot(A.page, "02-answer");
    return "answer rendered";
  });
  await scenario(T, S, "history persists across reload (IndexedDB)", async () => {
    await A.page.reload(); await A.page.waitForSelector(BOX);
    await A.page.waitForSelector("text=mock answer", { timeout: 10000 }).catch(() => {});
    const txt = await A.page.textContent("body");
    assert.match(txt, /What is a contract/);
    return "message restored after reload";
  });
  await scenario(T, S, "another browser profile sees none of it (no server state)", async () => {
    const B = await open();
    const txt = await B.page.textContent("body");
    assert.doesNotMatch(txt, /What is a contract/);
    await B.context.close();
    return "isolated";
  });
  await scenario(T, S, "no cookies set; nothing sensitive in localStorage", async () => {
    const cookies = await A.context.cookies();
    assert.equal(cookies.length, 0);
    const ls = await A.page.evaluate(() => JSON.stringify(localStorage));
    assert.doesNotMatch(ls, /sk-|token|email/i);
    return `cookies=0, localStorage=${ls.slice(0, 80)}`;
  });
  await scenario(T, S, "text fields have a visible outline in both themes", async () => {
    const { page, context } = await open();
    await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('input[name="provider-api-key"]');
    // The provider picker reads left to right: Nebius, then DeepSeek.
    const order = await page.$$eval('[role="group"][aria-label="Provider"] button', (bs) => bs.map((b) => b.textContent.trim()));
    assert.deepEqual(order, ["Nebius", "DeepSeek"]);
    const at = () => page.evaluate(() => {
      const el = document.querySelector('input[name="provider-api-key"]');
      const cs = getComputedStyle(el);
      return { border: cs.borderTopColor, bg: cs.backgroundColor, w: parseFloat(cs.borderTopWidth) };
    });
    const lum = (rgb) => { const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    for (const mode of ["dark", "light"]) {
      await page.evaluate((m) => localStorage.setItem("lbl-theme", m), mode);
      await page.reload();
      await page.waitForSelector(BOX);
      await page.click('button[aria-label="Settings"]');
      await page.waitForSelector('input[name="provider-api-key"]');
      const f = await at();
      assert.ok(f.w >= 1, `${mode}: border width ${f.w}px`);
      assert.ok(ratio(f.border, f.bg) >= 1.25, `${mode}: border ${f.border} does not stand out from the fill ${f.bg}`);
      await shot(page, `12-field-${mode}`);
    }
    await context.close();
    return "1px outline, >= 1.25:1 against the fill, dark and light";
  });
  await scenario(T, S, "settings shows server limits and clear-data control", async () => {
    await A.page.click('[aria-label="Settings"]');
    await A.page.waitForSelector('[role="dialog"][aria-label="Settings"]');
    const txt = await A.page.textContent('[role="dialog"]');
    assert.match(txt, /200000|200,000/);
    assert.match(txt, /Delete all my chats/i);
    await shot(A.page, "03-settings");
    await A.page.click('[aria-label="Close settings"]');
    return "limits + privacy visible";
  });
  await A.context.close();
});

test("the chat box says whose key is in use", async (t) => {
  const T = t.test.bind(t);
  const DUMMY = "sk-eval-dummy-0123456789abcdef";
  const { page, context } = await open();
  const badge = () => page.locator(".dsm-keybadge");
  const source = () => badge().getAttribute("data-key-source");
  const saveDummy = async () => {
    if (!(await page.locator('[role="dialog"][aria-label="Settings"]').count())) await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]');
    await page.click('button[aria-pressed]:has-text("Nebius")');
    await page.fill('input[name="provider-api-key"]', DUMMY);
    await page.click('button:has-text("Save key")');
  };

  await scenario(T, S, "by default it says the free shared key is used, and a turn really goes through the server", async () => {
    assert.equal(await source(), "shared");
    assert.match(await badge().textContent(), /Free shared key/);
    const chatCalls = [];
    page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/chat") chatCalls.push(r.method()); });
    await ask(page, "What is a contract?");
    await page.waitForSelector("text=mock answer", { timeout: 15000 });
    assert.deepEqual(chatCalls, ["POST"], "the badge said shared, so /api/chat must carry the turn");
    await shot(page, "10-key-shared");
    return "shared; /api/chat used";
  });

  await scenario(T, S, "saving a key flips it to the visitor's own key at once, without exposing the key", async () => {
    await saveDummy();
    await page.waitForSelector('.dsm-keybadge[data-key-source="own"]');
    assert.match(await badge().textContent(), /Your own key · Nebius/);
    const tip = (await badge().getAttribute("title")) || "";
    assert.match(tip, /ends cdef/);
    assert.ok(!tip.includes(DUMMY) && !(await page.content()).includes(DUMMY), "the full key must not be on the page");
    await page.click('[aria-label="Close settings"]');
    await shot(page, "11-key-own");
    return "own, Nebius, last four only";
  });

  await scenario(T, S, "it survives a reload while the key is kept on this device", async () => {
    await page.reload(); await page.waitForSelector(BOX);
    assert.equal(await source(), "own");
    return "still own";
  });

  await scenario(T, S, "another tab removing the key updates this tab", async () => {
    const other = await context.newPage();
    await other.goto(srv.base + "/"); await other.waitForSelector(BOX);
    await other.evaluate(() => localStorage.removeItem("lawbylaw.byok.v1"));
    await page.waitForSelector('.dsm-keybadge[data-key-source="shared"]', { timeout: 5000 });
    await other.close();
    return "shared again";
  });

  await scenario(T, S, "clicking it opens Settings, where the key is managed", async () => {
    await badge().click();
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]');
    await page.click('[aria-label="Close settings"]');
    return "opens Settings";
  });

  await scenario(T, S, "Remove key and Delete everything both return it to the shared key", async () => {
    await saveDummy();
    await page.waitForSelector('.dsm-keybadge[data-key-source="own"]');
    await page.click('button:has-text("Remove key")');
    await page.waitForSelector('.dsm-keybadge[data-key-source="shared"]');
    await saveDummy();
    await page.waitForSelector('.dsm-keybadge[data-key-source="own"]');
    await page.click('button:has-text("Delete all my chats")');
    await page.click('button:has-text("Yes, delete everything")');
    await page.waitForSelector('.dsm-keybadge[data-key-source="shared"]', { timeout: 10000 });
    assert.equal(await page.evaluate(() => localStorage.getItem("lawbylaw.byok.v1")), null);
    return "shared after both";
  });

  await scenario(T, S, "it fits beside the send button on a phone", async () => {
    await page.setViewportSize({ width: 360, height: 700 });
    const fits = await page.evaluate(() => {
      const b = document.querySelector(".dsm-keybadge").getBoundingClientRect();
      const a = document.querySelector(".dsm-composer-actions").getBoundingClientRect();
      return b.right <= a.left && b.left >= 0;
    });
    assert.ok(fits, "badge overlaps the send button");
    await shot(page, "12-key-phone");
    return "no overlap at 360px";
  });
  await context.close();
});

// /compact, typed into the real chat box. The provider is faked at the network layer, so this checks the
// whole browser path (skills menu, host, storage, divider, notice) without a key or the network.
// Shared key: the server's model (POST /api/compact, against the mock upstream). DeepSeek key: DeepSeek's own
// model. Nebius key: Nemotron.
test("/compact shortens a long chat on every kind of key", async (t) => {
  const T = t.test.bind(t);
  const DUMMY = "sk-eval-dummy-0123456789abcdef";
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  const usage = { prompt_tokens: 40, completion_tokens: 5 };
  // Answers are long enough that a short summary is a real saving (a summary that grows the chat is refused).
  const ANSWER = "Answer. " + "The court weighed the contract terms, the notice given and the conduct of both sides. ".repeat(12);
  const turns = (page) => page.locator(".dsm-turn").count();
  const saveKey = async (page) => {
    await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]');
    await page.click('button[aria-pressed]:has-text("Nebius")');
    await page.fill('input[name="provider-api-key"]', DUMMY);
    await page.click('button:has-text("Save key")');
    await page.click('[aria-label="Close settings"]');
  };
  /** Fake Nebius: the compact model writes SUMMARY-Z (one JSON reply), the main model streams an answer. */
  const fakeNebius = async (page) => {
    const seen = [];
    await page.route("https://api.tokenfactory.nebius.com/**", (r) => {
      if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
      const body = JSON.parse(r.request().postData());
      seen.push({ body, auth: r.request().headers()["authorization"] });
      if (String(body.model).startsWith("nvidia/")) {
        return r.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" },
          body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "SUMMARY-Z: tenancy deposit dispute" }, finish_reason: "stop" }], usage }) });
      }
      return r.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n` });
    });
    return seen;
  };

  /** Fake DeepSeek: any call that opens with the summariser's role is the summary, the rest stream an answer. */
  const fakeDeepseek = async (page) => {
    const seen = [];
    await page.route("https://api.deepseek.com/**", (r) => {
      if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
      const body = JSON.parse(r.request().postData());
      seen.push({ body, auth: r.request().headers()["authorization"], summary: String(body.messages?.[0]?.content).startsWith("You write faithful summaries") });
      if (seen.at(-1).summary) {
        return r.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" },
          body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "SUMMARY-D: tenancy deposit dispute" }, finish_reason: "stop" }], usage }) });
      }
      return r.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n` });
    });
    return seen;
  };
  const saveDeepseekKey = async (page) => {
    await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]');
    await page.click('button[aria-pressed]:has-text("DeepSeek")');
    await page.fill('input[name="provider-api-key"]', DUMMY);
    await page.click('button:has-text("Save key")');
    await page.click('[aria-label="Close settings"]');
  };
  const longQuestion = (n) => `question ${n} about my tenancy deposit dispute. ` + "I paid the deposit and the landlord has not returned it although I left the flat clean and on time. ".repeat(3);

  await scenario(T, S, "typing / offers /compact as a skill, with keyboard selection", async () => {
    const { page, context } = await open();
    await page.click(BOX);
    await page.keyboard.insertText("/");
    await page.waitForSelector(".dsm-slash-menu", { timeout: 3000 });
    const menu = await page.locator(".dsm-slash-menu").innerText();
    assert.match(menu, /compact/);
    assert.match(menu, /skill/i); // the badge (CSS uppercases it)
    await shot(page, "16-slash-menu");
    await page.keyboard.press("Tab"); // completes to "/compact "
    assert.equal((await page.locator(BOX).innerText()).trim(), "/compact");
    assert.equal(await page.locator(".dsm-slash-menu").count(), 0, "menu closes once a skill is chosen");
    await page.keyboard.press("Escape");
    // a different word filters the menu away; Escape dismisses it
    await page.locator(BOX).evaluate((el) => { el.textContent = ""; });
    await page.keyboard.insertText("/zzz");
    await sleep(200);
    assert.equal(await page.locator(".dsm-slash-menu .dsm-slash-item").count(), 0);
    await context.close();
    return "menu with Skill badge; Tab completes; unknown word filters it away";
  });

  await scenario(T, S, "Settings says how /compact works for each provider", async () => {
    const { page, context } = await open();
    await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]');
    await page.click('button[aria-pressed]:has-text("Nebius")');
    assert.match(await page.locator('[data-testid="compact-hint"]').textContent(), /\/compact.*NVIDIA Nemotron 3 Nano/s);
    await page.click('button[aria-pressed]:has-text("DeepSeek")');
    assert.match(await page.locator('[data-testid="compact-hint"]').textContent(), /\/compact.*same model that answers/s);
    await page.click('button[aria-pressed]:has-text("Nebius")');
    await page.fill('input[name="provider-api-key"]', DUMMY);
    await page.click('button:has-text("Save key")');
    await page.waitForSelector('[data-testid="compact-hint"]'); // also once the key is saved
    await shot(page, "15-compact-hint");
    await context.close();
    return "hint names Nemotron on Nebius, the answering model on DeepSeek";
  });

  await scenario(T, S, "with nothing to summarise it says so, and sends nothing", async () => {
    const { page, context } = await open();
    const chatCalls = [];
    page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/chat") chatCalls.push(1); });
    await ask(page, "/compact");
    await page.waitForSelector("text=nothing to summarise yet", { timeout: 5000 });
    assert.equal(await turns(page), 0, "/compact must not become a chat message");
    assert.equal(chatCalls.length, 0);
    assert.equal(await page.locator(".dsm-error-banner").count(), 1, "one banner");
    await context.close();
    return "banner shown; no message sent";
  });

  await scenario(T, S, "on the shared key, the server's model summarises and the next question uses the summary", async () => {
    await mockReset();
    const { page, context } = await open();
    const chatBodies = [];
    const compactBodies = [];
    page.on("request", (r) => {
      const p = new URL(r.url()).pathname;
      if (p === "/api/chat") chatBodies.push(JSON.parse(r.postData()));
      if (p === "/api/compact") compactBodies.push(JSON.parse(r.postData()));
    });
    for (let i = 0; i < 4; i++) {
      await ask(page, longQuestion(i));
      await page.waitForFunction((n) => document.body.innerText.split("mock answer").length > n, i + 1, { timeout: 15000 });
      await sleep(400);
    }
    assert.equal(await page.locator(".dsm-compaction-divider").count(), 0);
    await ask(page, "/compact");
    await page.waitForSelector(".dsm-compaction-divider", { timeout: 10000 });
    await page.waitForSelector("text=/Summarised the earlier 4 messages; the latest 4 are kept/", { timeout: 5000 });
    assert.equal(await turns(page), 4, "/compact must not add a bubble");
    assert.equal(chatBodies.length, 4, "/compact must not be sent to the model as a question");
    await shot(page, "13-compact-shared-key");

    // one request, carrying the older messages and nothing else; the server wrote the summary
    assert.equal(compactBodies.length, 1);
    assert.deepEqual(Object.keys(compactBodies[0]), ["history"]);
    assert.equal(compactBodies[0].history.length, 4);
    assert.match(compactBodies[0].history[0].content, /question 0/);
    assert.equal((await mockStats()).summaries, 1);

    // the next question carries the summary instead of the summarised turns
    await sleep(300);
    await ask(page, "question 4 about the stamp duty");
    await page.waitForFunction(() => document.body.innerText.split("mock answer").length > 5, null, { timeout: 15000 });
    const next = chatBodies.at(-1);
    assert.match(next.summary, /SUMMARY-OF-EARLIER-TURNS/);
    const sent = JSON.stringify(next.messages);
    assert.ok(!sent.includes("question 0 about") && !sent.includes("question 1 about"), "summarised turns still sent");
    assert.ok(sent.includes("question 2 about") && sent.includes("question 4 about the stamp duty"));
    await page.reload(); await page.waitForSelector(BOX);
    await page.waitForSelector(".dsm-compaction-divider", { timeout: 8000 });
    await context.close();
    return "server summarised once; summary sent with the next question; divider survives reload";
  });

  await scenario(T, S, "with a DeepSeek key it uses DeepSeek's own model, with thinking off", async () => {
    const { page, context } = await open();
    const seen = await fakeDeepseek(page);
    await saveDeepseekKey(page);
    for (let i = 0; i < 4; i++) {
      await ask(page, longQuestion(i));
      await page.waitForFunction((n) => document.body.innerText.split("Answer.").length > n, i + 1, { timeout: 15000 });
      await sleep(300);
    }
    await ask(page, "/compact");
    await page.waitForSelector(".dsm-compaction-divider", { timeout: 8000 });
    await page.waitForSelector("text=/Summarised the earlier 4 messages; the latest 4 are kept/", { timeout: 5000 });
    const req = seen.filter((x) => x.summary);
    assert.equal(req.length, 1);
    assert.equal(req[0].body.model, "deepseek-flash");
    assert.deepEqual(req[0].body.thinking, { type: "disabled" });
    assert.equal(req[0].body.chat_template_kwargs, undefined);
    assert.equal(req[0].auth, `Bearer ${DUMMY}`);
    assert.ok(!(await page.content()).includes(DUMMY), "the key must not be on the page");
    await shot(page, "17-compact-deepseek");
    await context.close();
    return "one call to DeepSeek's own model, thinking disabled, user's key";
  });

  await scenario(T, S, "with a Nebius key and a short chat it says there is too little to summarise", async () => {
    const { page, context } = await open();
    const seen = await fakeNebius(page);
    await saveKey(page);
    await ask(page, "just one question");
    await page.waitForSelector("text=Answer.", { timeout: 15000 });
    await ask(page, "/compact");
    await page.waitForSelector("text=isn't enough conversation to summarise yet", { timeout: 5000 });
    assert.equal(await page.locator(".dsm-notice").count(), 1, "one notice, not two");
    await sleep(300);
    await ask(page, "/compact"); // again: still one notice, not a copy stacked under the first
    await sleep(800);
    assert.equal(await page.locator(".dsm-notice").count(), 1, "a repeat replaces the notice");
    assert.equal(seen.filter((s) => String(s.body.model).startsWith("nvidia/")).length, 0, "the compact model must not be called");
    await context.close();
    return "notice shown; compact model not called";
  });

  await scenario(T, S, "with a Nebius key it summarises, shows the divider, and the next question uses the summary", async () => {
    const { page, context } = await open();
    const seen = await fakeNebius(page);
    await saveKey(page);
    const qs = ["question one about my deposit", "question two about interest", "question three about costs", "question four about notice"];
    for (const [i, q] of qs.entries()) {
      await ask(page, q);
      await page.waitForFunction((n) => document.body.innerText.split("Answer.").length > n, i + 1, { timeout: 15000 });
      await sleep(300);
    }
    assert.equal(await page.locator(".dsm-compaction-divider").count(), 0);
    await ask(page, "/compact");
    await page.waitForSelector(".dsm-compaction-divider", { timeout: 8000 });
    await page.waitForSelector("text=/Summarised the earlier 4 messages with NVIDIA Nemotron 3 Nano/", { timeout: 5000 });
    assert.equal(await turns(page), 4, "/compact must not add a bubble");
    await shot(page, "14-compact-done");

    const compactReq = seen.filter((s) => String(s.body.model).startsWith("nvidia/"));
    assert.equal(compactReq.length, 1);
    assert.equal(compactReq[0].body.model, "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
    assert.deepEqual(compactReq[0].body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(compactReq[0].body.reasoning_effort, undefined);
    assert.equal(compactReq[0].auth, `Bearer ${DUMMY}`);
    assert.ok(!(await page.content()).includes(DUMMY), "the key must not be on the page");

    // the next question carries the summary instead of the summarised turns
    await sleep(300);
    await ask(page, "question five about costs");
    await page.waitForFunction(() => document.body.innerText.split("Answer.").length > 5, null, { timeout: 15000 });
    const main = seen.filter((s) => !String(s.body.model).startsWith("nvidia/")).at(-1);
    const sent = JSON.stringify(main.body.messages);
    assert.ok(sent.includes("SUMMARY-Z: tenancy deposit dispute"), "summary not sent");
    assert.ok(!sent.includes("question one about my deposit") && !sent.includes("question two about interest"), "summarised turns still sent");
    assert.ok(sent.includes("question three about costs") && sent.includes("question five about costs"));

    // and it survives a reload
    await page.reload(); await page.waitForSelector(BOX);
    await page.waitForSelector(".dsm-compaction-divider", { timeout: 8000 });
    await context.close();
    return "compact model called once with the user's key; summary used next turn; divider survives reload";
  });
});

const sseBody = (evs) => evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

test("legal links, 200k context and no automatic summarising in the UI", async (t) => {
  const T = t.test.bind(t);
  const URL1 = "https://sso.agc.gov.sg/Act/EA1893?ProvIds=pr13-";
  await scenario(T, S, "cited sections get inline SSO links that open Singapore Statutes Online", async () => {
    const { page, context } = await open();
    await page.route("**/api/chat", (route) => route.fulfill({
      status: 200, headers: { "content-type": "text/event-stream" },
      body: sseBody([
        { type: "token", content: "Under Section 13 of the Evidence Act 1893, relevant facts are admissible." },
        { type: "legislation_citations", citations: [
          { act_name: "Evidence Act 1893", section: "13", label: "Evidence Act 1893 s 13", url: URL1 },
          { act_name: "Bad", section: "9", label: "bad", url: "javascript:alert(1)" } ] },
        { type: "context_usage", used: 1200, max: 200000, percent: 0 },
        { type: "done" } ]),
    }));
    await ask(page, "What does the Evidence Act say about relevance?");
    await page.waitForSelector("a.dsm-sso-link", { timeout: 15000 });
    const href = await page.getAttribute("a.dsm-sso-link", "data-href");
    assert.equal(href, URL1);
    assert.equal(await page.locator('a[data-href^="javascript"]').count(), 0);
    assert.equal((await page.locator("a.dsm-sso-link").first().innerText()).trim().toLowerCase(), "link");
    // the pill is drawn from the theme's own colours: readable text on both the dark and the light theme
    for (const scheme of ["dark", "light"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate((m) => document.documentElement.classList.toggle("theme-light", m === "light"), scheme);
      const c = await page.locator("a.dsm-sso-link").first().evaluate((el) => {
        const cs = getComputedStyle(el);
        // computed colours come back as rgb(0-255) or, for a colour-mix, color(srgb 0-1)
        const lum = (rgb) => { const k = rgb.startsWith("color(") ? 1 : 255; const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= k; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const bg = (n) => { for (; n; n = n.parentElement) { const v = getComputedStyle(n).backgroundColor; if (!/rgba?\(.*,\s*0\)|transparent/.test(v)) return v; } return "rgb(255,255,255)"; };
        const own = cs.backgroundColor;
        const under = /rgba/.test(own) ? bg(el.parentElement) : own;
        const L1 = lum(cs.color), L2 = lum(under);
        return { ratio: (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05), fg: cs.color, bg: under };
      });
      assert.ok(c.ratio >= 4.5, `${scheme}: contrast ${c.ratio.toFixed(2)} (${c.fg} on ${c.bg})`);
    }
    await page.evaluate(() => document.documentElement.classList.remove("theme-light"));
    await shot(page, "09-sso-links");
    const popupP = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await page.click("a.dsm-sso-link");
    await page.click('button:has-text("Open link")'); // the app confirms before leaving the site
    const popup = await popupP;
    assert.ok(popup, "link did not open a new tab");
    assert.match(popup.url() + "", /sso\.agc\.gov\.sg|about:blank/);
    await context.close();
    return "pill reads \"link\", readable on dark and light, opens SSO in a new tab, javascript: link dropped";
  });
  await scenario(T, S, "context ring shows the 200k window", async () => {
    const { page, context } = await open();
    const label = await page.getAttribute(".dsm-ctx", "aria-label");
    assert.match(label, /200,000/);
    await context.close();
    return label;
  });
  await scenario(T, S, "nothing summarises on its own: no divider, no summary sent, however many turns", async () => {
    const { page, context } = await open();
    const bodies = [];
    let n = 0;
    await page.route("**/api/chat", (route) => {
      bodies.push(JSON.parse(route.request().postData()));
      n++;
      route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sseBody([{ type: "token", content: `Answer ${n}.` }, { type: "done" }]) });
    });
    for (const [i, q] of ["first question about my deposit", "second question about interest", "third question about costs", "fourth question about notice"].entries()) {
      await ask(page, q);
      await page.waitForSelector(`text=Answer ${i + 1}.`, { timeout: 15000 });
      await sleep(400);
    }
    assert.equal(await page.locator(".dsm-compaction-divider").count(), 0);
    assert.equal(bodies.length, 4);
    assert.ok(bodies.every((b) => b.summary === undefined || b.summary === null), "a summary was sent without /compact");
    assert.equal(bodies[3].messages.length, 7, "all earlier turns are still sent");
    await context.close();
    return "4 turns, 4 requests, whole history each time, no divider";
  });
});

test("the chat list puts the newest chat on top, also after a reload", async (t) => {
  const T = t.test.bind(t);
  await scenario(T, S, "newest first in the Chats sidebar, before and after reloading", async () => {
    const { page, context } = await open();
    const rows = async () => {
      await sleep(800); // the sidebar stays open across a reload; give the chat list time to fill before deciding
      if (!(await page.locator(".dsm-rail-list, .dsm-rail-empty").count())) await page.click('button[aria-label="Chats"]');
      await page.waitForSelector(".dsm-rail-list .dsm-rail-open");
      return (await page.locator(".dsm-rail-list .dsm-rail-open").allInnerTexts()).map((x) => x.trim().split("\n")[0]);
    };
    for (const [i, q] of ["alpha question first", "beta question second", "gamma question third"].entries()) {
      if (i) { await page.click('button[aria-label="New chat"]'); await sleep(200); }
      await ask(page, q);
      await page.waitForSelector("text=mock answer", { timeout: 15000 });
      await sleep(500);
    }
    const order = (list) => ["gamma", "beta", "alpha"].map((w) => list.findIndex((x) => x.includes(w)));
    const live = order(await rows());
    assert.deepEqual(live, [0, 1, 2], `live order ${live}`);
    for (let i = 0; i < 3; i++) { // storage order is arbitrary, so reload a few times
      await page.reload(); await page.waitForSelector(BOX);
      const after = order(await rows());
      assert.deepEqual(after, [0, 1, 2], `after reload ${i + 1}: ${after}`);
    }
    await shot(page, "18-chat-list-order");
    await context.close();
    return "gamma, beta, alpha: newest on top, live and after 3 reloads";
  });
});

test("legal tool cards, follow-up form, ring breakdown, synthesizing", async (t) => {
  const T = t.test.bind(t);
  await scenario(T, S, "legal tool cards show name, phase, result; classify_issue asks follow-ups", async () => {
    const { page, context } = await open();
    const bodies = [];
    let n = 0;
    await page.route("**/api/chat", async (route) => {
      bodies.push(JSON.parse(route.request().postData()));
      n++;
      const evs = n === 1 ? [
        { type: "tool_call", id: "c1", name: "research_legislation", arguments: { prompt: "tenant deposit return rules" } },
        { type: "subagent_start", task_id: "c1", tool: "research_legislation", description: "Legislation research", subagent_type: "legislation", prompt: "tenant deposit return rules" },
        { type: "subagent_tool_call", task_id: "c1", id: "s0", name: "search_legislation", arguments: { query: "security deposit tenancy" } },
        { type: "subagent_tool_result", task_id: "c1", id: "s0", name: "search_legislation", result: "[s5 | Residential Tenancy Act | 91%] deposit text", is_error: false },
        { type: "tool_progress", name: "research_legislation", searches: 3, phase: "synthesising" },
        { type: "subagent_end", task_id: "c1", is_error: false, output: "Verbatim: Section 5 deposit provisions (full text)" },
        { type: "tool_result", name: "research_legislation", result: "Found: Section 5 deposit provisions" },
        { type: "tool_call", id: "c2", name: "research_subsidiary_legislation", arguments: { prompt: "regulations on deposits", parent_act_names: ["X"] } },
        { type: "subagent_start", task_id: "c2", tool: "research_subsidiary_legislation", description: "Subsidiary legislation research", subagent_type: "subsidiary-legislation", prompt: "regulations on deposits" },
        { type: "subagent_end", task_id: "c2", is_error: true, output: "[ERROR] This search is unavailable right now." },
        { type: "tool_result", name: "research_subsidiary_legislation", result: "[ERROR] This search is unavailable right now." },
        { type: "tool_call", id: "c3", name: "classify_issue", arguments: { categories: ["civil"], summary: "Deposit dispute", missing_details: ["How much is the deposit?", "Do you have a written lease?"] } },
        { type: "tool_result", name: "classify_issue", result: "Classification: civil" },
        { type: "breakdown", system: 900, tools: 600, summary: 0 },
        { type: "context_usage", used: 5000, max: 200000, percent: 2 },
        { type: "token", content: "This looks like a civil matter." }, { type: "done" } ]
        : [{ type: "token", content: "Thanks." }, { type: "done" }];
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sseBody(evs) });
    });
    await ask(page, "My landlord keeps my deposit");
    await page.waitForSelector("text=This looks like a civil matter.", { timeout: 15000 });
    const txt = await page.textContent("body");
    for (const label of ["Legislation research", "Subsidiary legislation research", "Classify issue"]) assert.ok(txt.includes(label), label + " card missing");
    assert.equal(await page.locator(".dsm-tool-group-head").count(), 0, "legal tools must not collapse into 'Explored N searches'");
    assert.equal(await page.locator(".dsm-tool--task").count(), 2, "research tools must render as subagent task rows");
    await shot(page, "11-legal-cards");
    await page.waitForSelector('form[aria-label="Follow-up questions"]');
    const inputs = page.locator('form[aria-label="Follow-up questions"] input[type=text]');
    await inputs.nth(0).fill("EUR 2000");
    await page.click('form[aria-label="Follow-up questions"] >> text=Skip >> nth=1');
    await shot(page, "12-followup-form");
    await page.click('text=Send answers');
    await page.waitForSelector("text=Thanks.", { timeout: 15000 });
    const last = bodies[1].messages[bodies[1].messages.length - 1].content;
    assert.match(last, /How much is the deposit\?\*\*\nEUR 2000/);
    assert.ok(!last.includes("written lease"), "skipped question must be omitted");
    assert.equal(await page.locator('form[aria-label="Follow-up questions"]').count(), 0, "form should disappear once answered");
    // Open the sub-agent transcript: prompt, its own search, its synthesis; read-only.
    const openRow = async () => {
      await page.click('button.dsm-task-row:has-text("Legislation research")');
      await page.waitForSelector("text=Subagent transcript", { timeout: 8000 });
      await page.waitForSelector("text=Section 5 deposit provisions (full text)", { timeout: 8000 });
      const body = await page.textContent("body");
      assert.ok(body.includes("tenant deposit return rules"), "sub-agent prompt missing");
      assert.ok(/security deposit tenancy/i.test(body), "sub-agent's own search missing");
    };
    await openRow();
    assert.equal(await page.locator('[contenteditable="true"]:visible').count(), 0, "transcript must be read-only");
    await shot(page, "14-subagent-transcript");
    // Persists across a reload.
    await page.unroute("**/api/chat");
    await page.reload(); await page.waitForSelector(BOX);
    await page.waitForSelector("text=Thanks.", { timeout: 8000 }).catch(() => {});
    await page.waitForSelector('button.dsm-task-row:has-text("Legislation research")', { timeout: 8000 });
    await openRow();
    await context.close();
    return "task rows (no flat cards), error row for failed tool, transcript opens read-only with prompt + search + result, survives reload; form answers sent";
  });
  await scenario(T, S, "context ring breaks usage into system / tools / conversation", async () => {
    const { page, context } = await open();
    await page.route("**/api/chat", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sseBody([
      { type: "breakdown", system: 900, tools: 600, summary: 300 },
      { type: "context_usage", used: 5000, max: 200000, percent: 2 },
      { type: "token", content: "Answer." }, { type: "done" }]) }));
    await ask(page, "hello there friend");
    await page.waitForSelector("text=Answer.");
    await page.click(".dsm-ctx");
    await page.waitForSelector("text=/System prompt/i", { timeout: 5000 });
    const txt = await page.textContent("body");
    assert.match(txt, /Tool definitions/i);
    assert.match(txt, /Summarised conversation/i);
    assert.match(txt, /Conversation/);
    await shot(page, "13-context-breakdown");
    await context.close();
    return "legend lists system prompt, tool definitions, summary, conversation";
  });
  await scenario(T, S, "verification pass shows 'Synthesizing', not 'Planning next moves'", async () => {
    const s2 = await startServer({ port: 8302, env: { LIMIT_RATE_BURST: "100", LIMIT_RATE_PER_MIN: "600", LIMIT_FINAL_CHECK: "1" } });
    try {
      const { page, context } = await open({}, s2.base);
      await ask(page, "__CLASSIFY__ __SLOWCHECK__ deposit question");
      await page.waitForSelector("text=Synthesizing", { timeout: 20000 });
      await shot(page, "14-synthesizing");
      assert.equal(await page.locator("text=Planning next moves").count(), 0);
      await page.waitForSelector("text=mock answer", { timeout: 20000 });
      await context.close();
    } finally { s2.stop(); }
    return "label shown while the draft is being verified";
  });
});

test("abuse from the UI", async (t) => {
  const T = t.test.bind(t);
  await scenario(T, S, "huge paste is capped, page stays responsive", async () => {
    const { page, context } = await open();
    const t0 = Date.now();
    await page.evaluate((sel) => {
      const el = document.querySelector(sel); el.focus();
      const dt = new DataTransfer(); dt.setData("text/plain", "x".repeat(2_000_000));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, BOX);
    await sleep(300);
    const len = await page.evaluate((sel) => document.querySelector(sel).innerText.length, BOX);
    const dt = Date.now() - t0;
    assert.ok(len <= 200001, `composer holds ${len} chars`);
    assert.ok(dt < 3000, `paste took ${dt}ms`);
    await shot(page, "04-huge-paste");
    await context.close();
    return `2,000,000 chars pasted -> ${len} kept in ${dt}ms`;
  });
  await scenario(T, S, "repeated identical message shows a friendly cooldown error", async () => {
    const { page, context } = await open();
    for (let i = 0; i < 5; i++) { await ask(page, "hi"); await sleep(900); }
    await page.waitForSelector("text=/same message|repeat|slow down/i", { timeout: 8000 });
    await shot(page, "05-repeat-cooldown");
    await context.close();
    return "cooldown message visible";
  });
});

test("network failure", async (t) => {
  const T = t.test.bind(t);
  await scenario(T, S, "offline before send: banner, clear error, recovers", async () => {
    const { page, context } = await open();
    await context.setOffline(true);
    await page.waitForSelector(".dsm-offline-banner", { timeout: 5000 });
    await ask(page, "offline question");
    await sleep(1500);
    await shot(page, "06-offline");
    await context.setOffline(false);
    await page.waitForSelector(".dsm-offline-banner", { state: "detached", timeout: 5000 });
    await ask(page, "back online question");
    await page.waitForSelector("text=mock answer", { timeout: 15000 });
    await context.close();
    return "banner shown offline, next send succeeds";
  });
  await scenario(T, S, "offline mid-stream: turn ends, UI not stuck", async () => {
    const { page, context } = await open();
    await ask(page, "__SLOW__ going offline");
    await page.waitForSelector("text=tok3", { timeout: 15000 });
    await context.setOffline(true);
    await page.waitForSelector('[aria-label="Send"]', { timeout: 45000 });
    await shot(page, "07-offline-midstream");
    await context.setOffline(false);
    await context.close();
    return "send button restored (no infinite spinner)";
  });
  await scenario(T, S, "stop button ends generation", async () => {
    const { page, context } = await open();
    await ask(page, "__SLOW__ stop me");
    await page.waitForSelector("text=tok3", { timeout: 15000 });
    await page.click('[aria-label="Stop generation"]');
    await page.waitForSelector('[aria-label="Send"]', { timeout: 8000 });
    await context.close();
    return "stopped";
  });
});

test("old phone and lockdown", async (t) => {
  const T = t.test.bind(t);
  await scenario(T, S, "3-year-old phone: 4x CPU + slow 3G loads and works", async () => {
    const context = await browser.newContext({ ...devices["Pixel 5"] });
    await markSeen(context);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 300, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 });
    const t0 = Date.now();
    await page.goto(srv.base + "/");
    await page.waitForSelector(BOX, { timeout: 60000 });
    const ttI = Date.now() - t0;
    await shot(page, "08-mobile-throttled");
    const small = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    assert.ok(small, "horizontal overflow on mobile");
    assert.ok(ttI < 30000, `interactive after ${ttI}ms`);
    await ask(page, "mobile question");
    await page.waitForSelector("text=mock answer", { timeout: 30000 });
    await context.close();
    return `interactive in ${(ttI / 1000).toFixed(1)}s at 4x CPU / 400kbps / 300ms`;
  });
  await scenario(T, S, "touch targets >= 40px and composer labelled on mobile", async () => {
    const context = await browser.newContext({ ...devices["Pixel 5"] });
    await markSeen(context);
    const page = await context.newPage();
    await page.goto(srv.base + "/"); await page.waitForSelector(BOX);
    const sizes = await page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => b.offsetParent).map((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height)));
    const tiny = sizes.filter((s) => s < 40).length;
    assert.ok(tiny === 0, `${tiny} of ${sizes.length} buttons < 40px`);
    await context.close();
    return `${sizes.length} buttons, min ${Math.min(...sizes).toFixed(0)}px`;
  });
  await scenario(T, S, "/admin in a browser is a 404, not the app", async () => {
    const { page, context } = await open();
    for (const path of ["/admin", "/adminfoo", "/administrator", "/ADMIN"]) {
      const resp = await page.goto(srv.base + path);
      assert.equal(resp.status(), 404, path);
      assert.equal(await page.locator(BOX).count(), 0, path);
    }
    await context.close();
    return "404, no UI for 4 admin paths";
  });
}
);

test("first-visit notice", async (t) => {
  const T = t.test.bind(t);
  const NOTICE = '[data-testid="welcome-notice"]';
  const luminance = (rgb) => { const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  await scenario(T, S, "a first visit shows the six points in the middle of the screen", async () => {
    const { page, context } = await open({}, srv.base, { welcome: true });
    await page.waitForSelector(NOTICE, { timeout: 5000 });
    const text = await page.locator(NOTICE).innerText();
    for (const re of [
      /Nebius x NVIDIA Global AI Hackathon/,
      /homelab.*Singapore.*Embeddings and reranking are done with a single Nvidia RTX 3060/s,
      /copyright of the Singapore Government.*permission of the Attorney-General's Chambers \(AGC\)/s,
      /Singapore Statutes Online \(SSO\).*latest version/s,
      /taken down after the judging period.*December 2 to December 16, 2026/s,
      /Nebius Token Factory.*DeepSeek.*retention and training terms.*sensitive personal information/s,
    ]) assert.match(text, re);
    assert.equal(await page.locator(`${NOTICE} li`).count(), 6);
    const box = await page.locator(NOTICE).boundingBox();
    const vp = page.viewportSize();
    assert.ok(Math.abs(box.x + box.width / 2 - vp.width / 2) < 4 && Math.abs(box.y + box.height / 2 - vp.height / 2) < 4, `not centred: ${JSON.stringify(box)}`);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "I understand", "focus starts on the button");
    await shot(page, "20-welcome-dark");
    await context.close();
    return "6 points, centred, button focused";
  });

  await scenario(T, S, "it is readable in both themes", async () => {
    for (const mode of ["dark", "light"]) {
      const { page, context } = await open({}, srv.base, { welcome: true });
      await page.evaluate((m) => localStorage.setItem("lbl-theme", m), mode);
      await page.reload();
      await page.waitForSelector(NOTICE);
      const c = await page.evaluate((sel) => { const box = document.querySelector(sel); const li = box.querySelector("li"); return { fg: getComputedStyle(li).color, bg: getComputedStyle(box).backgroundColor, lead: getComputedStyle(box.querySelector(".dsm-welcome-lead")).color }; }, NOTICE);
      assert.ok(contrast(c.fg, c.bg) >= 7, `${mode}: text contrast ${contrast(c.fg, c.bg).toFixed(1)}`);
      assert.ok(contrast(c.lead, c.bg) >= 4.5, `${mode}: lead contrast ${contrast(c.lead, c.bg).toFixed(1)}`);
      await shot(page, `21-welcome-${mode}`);
      await context.close();
    }
    return "text contrast >= 7:1 and the lead line >= 4.5:1, dark and light";
  });

  await scenario(T, S, "the button dismisses it for good: not after a reload, not in a new tab", async () => {
    const { page, context } = await open({}, srv.base, { welcome: true });
    await page.waitForSelector(NOTICE);
    await page.click(`${NOTICE} button`);
    await page.waitForSelector(NOTICE, { state: "detached" });
    await page.click(BOX); // the app behind is usable at once
    await page.reload();
    await page.waitForSelector(BOX);
    assert.equal(await page.locator(NOTICE).count(), 0, "back after reload");
    const other = await context.newPage();
    await other.goto(srv.base + "/");
    await other.waitForSelector(BOX);
    assert.equal(await other.locator(NOTICE).count(), 0, "back in a new tab");
    await context.close();
    return "gone for good";
  });

  await scenario(T, S, "Escape also closes it, a click behind it does not, and it comes back for a new visitor", async () => {
    const { page, context } = await open({}, srv.base, { welcome: true });
    await page.waitForSelector(NOTICE);
    await page.mouse.click(5, 5);
    assert.equal(await page.locator(NOTICE).count(), 1, "a stray click must not skip it");
    await page.keyboard.press("Escape");
    await page.waitForSelector(NOTICE, { state: "detached" });
    await context.close();
    const fresh = await open({}, srv.base, { welcome: true });
    await fresh.page.waitForSelector(NOTICE);
    await fresh.context.close();
    return "Escape closes; backdrop does not; a fresh browser sees it";
  });

  await scenario(T, S, "on a phone it fits the screen and the button is large enough to tap", async () => {
    const context = await browser.newContext({ ...devices["Pixel 5"] });
    const page = await context.newPage();
    await page.goto(srv.base + "/");
    await page.waitForSelector(NOTICE);
    const r = await page.evaluate((sel) => { const b = document.querySelector(sel).getBoundingClientRect(); const btn = document.querySelector(sel + " button").getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, bt: b.bottom, w: innerWidth, h: innerHeight, btn: Math.min(btn.width, btn.height), btnBottom: btn.bottom }; }, NOTICE);
    assert.ok(r.l >= 0 && r.r <= r.w && r.t >= 0 && r.bt <= r.h, `outside the screen: ${JSON.stringify(r)}`);
    assert.ok(r.btn >= 40, `button ${r.btn}px`);
    await shot(page, "22-welcome-mobile");
    await page.tap(`${NOTICE} button`);
    await page.waitForSelector(NOTICE, { state: "detached" });
    await context.close();
    return "inside the screen; button >= 40px";
  });
});

// A visitor's own Tavily key: kept in this browser, used from the browser, never sent to this site.
test("your own Tavily key", async (t) => {
  const T = t.test.bind(t);
  const MODEL_KEY = "sk-eval-dummy-0123456789abcdef";
  const TKEY = "tvly-eval-canary-0123456789abcdef";
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  const usage = { prompt_tokens: 40, completion_tokens: 5 };
  const openSettings = async (page) => {
    if (!(await page.locator('[role="dialog"][aria-label="Settings"]').count())) await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]');
  };
  const saveTavily = async (page, key = TKEY) => {
    await openSettings(page);
    await page.fill('input[name="search-api-key"]', key);
    await page.click('button:has-text("Save Tavily key")');
  };
  const saveModelKey = async (page) => {
    await openSettings(page);
    await page.click('button[aria-pressed]:has-text("Nebius")');
    await page.fill('input[name="provider-api-key"]', MODEL_KEY);
    await page.click('button:has-text("Save key")');
  };
  /** Fake Nebius: the first main-model call asks for a Tavily search, the next one answers. Fake Tavily: one hit. */
  const fakes = async (page) => {
    const nebius = [];
    const tavily = [];
    await page.route("https://api.tokenfactory.nebius.com/**", (r) => {
      if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
      const body = JSON.parse(r.request().postData());
      nebius.push(body);
      const sse = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
      const asked = body.messages.some((m) => m.role === "tool");
      const delta = asked ? { content: "The fee is on the MOM page." } : { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search_tavily", arguments: JSON.stringify({ query: "work pass fee" }) } }] };
      return r.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: sse(delta) });
    });
    await page.route("https://api.tavily.com/**", (r) => {
      if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
      tavily.push({ auth: r.request().headers()["authorization"], body: JSON.parse(r.request().postData()) });
      return r.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ results: [{ url: "https://www.mom.gov.sg/passes", title: "Passes", content: "Fee details" }] }) });
    });
    return { nebius, tavily };
  };

  await scenario(T, S, "Settings keeps the key in this browser only, and does not show it again", async () => {
    const { page, context } = await open();
    await saveTavily(page);
    await page.waitForSelector('[data-testid="tavily-status"]');
    const dialog = await page.textContent('[role="dialog"]');
    assert.match(dialog, /Saved, ending in cdef, kept on this device/);
    assert.ok(!(await page.content()).includes(TKEY), "the full key must not be on the page");
    assert.equal(await page.locator('input[name="search-api-key"]').count(), 0, "no input left to copy from");
    assert.equal(await page.evaluate(() => localStorage.getItem("lawbylaw.tavily.v1")), TKEY);
    assert.match(await page.locator('[data-testid="tavily-status"]').textContent(), /Not in use yet.*free shared key/s, "on the shared model key it is not used, and says so");
    await shot(page, "23-tavily-saved");
    await page.reload();
    await openSettings(page);
    await page.waitForSelector('[data-testid="tavily-status"]');
    await page.click('[data-testid="tavily-settings"] button:has-text("Remove key")');
    assert.equal(await page.evaluate(() => localStorage.getItem("lawbylaw.tavily.v1")), null);
    assert.equal(await page.locator('input[name="search-api-key"]').count(), 1, "back to the empty form");
    await context.close();
    return "stored once, never shown, removable";
  });

  await scenario(T, S, "it rejects what is not a key, without saving", async () => {
    const { page, context } = await open();
    await saveTavily(page, "not a key");
    await page.waitForSelector('[role="alert"]');
    assert.equal(await page.evaluate(() => localStorage.getItem("lawbylaw.tavily.v1")), null);
    await context.close();
    return "refused";
  });

  await scenario(T, S, "with your own model key, the search goes from the browser to Tavily and never through this site", async () => {
    const { page, context } = await open();
    const { nebius, tavily } = await fakes(page);
    const toSite = [];
    page.on("request", (r) => { if (r.url().startsWith(srv.base)) toSite.push({ url: r.url(), headers: JSON.stringify(r.headers()), body: r.postData() ?? "" }); });
    await saveModelKey(page);
    await saveTavily(page);
    await page.waitForSelector('[data-testid="tavily-status"]');
    assert.match(await page.locator('[data-testid="tavily-status"]').textContent(), /Web searches use your Tavily key/);
    await page.click('[aria-label="Close settings"]');
    await ask(page, "What is the work pass fee?");
    await page.waitForSelector("text=The fee is on the MOM page.", { timeout: 20000 });
    assert.equal(tavily.length, 1, "exactly one search");
    assert.equal(tavily[0].auth, `Bearer ${TKEY}`);
    assert.equal(tavily[0].body.query, "work pass fee");
    assert.ok(nebius[0].tools.some((t) => t.function.name === "web_search_tavily"), "the model was offered the search");
    const toolMsg = nebius.at(-1).messages.find((m) => m.role === "tool");
    assert.match(toolMsg.content, /UNTRUSTED.*https:\/\/www\.mom\.gov\.sg\/passes/s);
    assert.ok(!JSON.stringify(nebius).includes(TKEY), "the Tavily key must not reach the model provider");
    assert.ok(!toSite.some((q) => q.url.includes("/api/tool") && q.body.includes("web_search_tavily")), "this site must not be asked to search");
    assert.ok(!toSite.some((q) => q.headers.includes(TKEY) || q.body.includes(TKEY) || q.url.includes(TKEY)), "the key must never be sent to this site");
    await shot(page, "24-tavily-used");
    await context.close();
    return "browser -> api.tavily.com; the site saw no key";
  });

  await scenario(T, S, "Delete all my data removes it too", async () => {
    const { page, context } = await open();
    await saveTavily(page);
    await page.click('button:has-text("Delete all my chats")');
    await page.click('button:has-text("Yes, delete everything")');
    await page.waitForSelector(BOX);
    assert.equal(await page.evaluate(() => localStorage.getItem("lawbylaw.tavily.v1")), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem("lawbylaw.tavily.v1")), null);
    await context.close();
    return "gone";
  });
});
