// Prefix-cache evals driven against the real server binary + mock upstream.
//
// Cache-optimisation suite (groups 1-4, 6) and
// its compaction-cache suite (dropped here: nothing summarises a chat on its own any more, so there is no
// summariser request to keep byte-aligned with the routed one). DeepSeek's prefix KV cache only hits when the
// rendered request is a byte-identical prefix of a previously persisted one, so
// these assert the observable properties of what the server actually sends:
//
//   * the system prompt and tool schemas are byte-stable within a mode;
//   * each turn's rendered messages extend the previous turn's as a prefix;
//   * a mode switch (different tools + system prompt) invalidates the prefix.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "./mock-deepseek.mjs";
import { startServer, post, chatBody, events, mockCaptured, mockReset, scenario } from "./lib.mjs";

const S = "cache";
const MOCK = 9100;
let mock;
const servers = [];
let nextPort = 8301;
const spawnServer = async (env = {}) => {
  const s = await startServer({ port: nextPort++, mockPort: MOCK, env });
  servers.push(s);
  return s;
};

before(async () => { mock = await startMock(MOCK); });
after(() => { servers.forEach((s) => s.stop()); mock.close(); });

const mainBodies = (captured) => captured.filter((c) => c.kind === "main").map((c) => c.body);

/** Two sequential legislation turns: [q1] then [q1, a1, q2]. */
async function twoTurns(env = {}) {
  const s = await spawnServer({ LIMIT_RATE_BURST: "20", ...env });
  await mockReset();
  await events(await post(s.base, chatBody("first question")));
  await events(await post(s.base, {
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "Hello! This is a mock answer." },
      { role: "user", content: "second question" },
    ],
    mode: "legislation",
  }));
  return mainBodies(await mockCaptured());
}

test("cache: stable prefix within a mode", async (t) => {
  await scenario(t.test.bind(t), S, "system prompt + tool schemas are byte-identical across turns", async () => {
    const [a, b] = await twoTurns();
    assert.ok(a && b, "two main requests were captured");
    assert.equal(JSON.stringify(a.messages[0]), JSON.stringify(b.messages[0]), "system prompt must not change between turns");
    assert.equal(JSON.stringify(a.tools), JSON.stringify(b.tools), "tool schemas must be byte-identical between turns");
    return `system + ${a.tools.length} tools byte-stable across 2 turns`;
  });

  await scenario(t.test.bind(t), S, "turn 2 begins with turn 1's rendered messages byte-for-byte", async () => {
    const [a, b] = await twoTurns();
    assert.ok(b.messages.length > a.messages.length, "turn 2 carries more messages");
    for (let i = 0; i < a.messages.length; i++) {
      assert.equal(JSON.stringify(b.messages[i]), JSON.stringify(a.messages[i]), `message ${i} must match for a cache prefix hit`);
    }
    return `turn 2 replays ${a.messages.length}/${b.messages.length} messages unchanged`;
  });
});

test("cache: mode switch invalidates the prefix", async (t) => {
  await scenario(t.test.bind(t), S, "legislation vs judiciary differ in system prompt and tools", async () => {
    const s = await spawnServer({ LIMIT_RATE_BURST: "20" });
    await mockReset();
    await events(await post(s.base, chatBody("what is a contract?", "legislation")));
    await events(await post(s.base, chatBody("what is a contract?", "judiciary")));
    const [leg, jud] = mainBodies(await mockCaptured());
    assert.ok(leg && jud, "both modes were captured");
    assert.notEqual(JSON.stringify(leg.messages[0]), JSON.stringify(jud.messages[0]), "the system prompt is mode-specific");
    assert.notEqual(JSON.stringify(leg.tools), JSON.stringify(jud.tools), "the tool array is mode-specific");
    return `legislation tools=${leg.tools.length}, judiciary tools=${jud.tools.length}`;
  });
});

test("cache: cache usage fields are accepted without breaking the turn", async (t) => {
  await scenario(t.test.bind(t), S, "upstream prompt_cache_hit/miss tokens do not error or leak", async () => {
    const s = await spawnServer({ LIMIT_RATE_BURST: "20" });
    await mockReset();
    const { events: ev } = await events(await post(s.base, chatBody("plain question")));
    assert.ok(!ev.some((e) => e.type === "error"), "a cache-annotated usage must not error the turn");
    assert.ok(ev.some((e) => e.type === "context_usage" && e.used > 0), "context usage is still reported");
    assert.ok(ev.some((e) => e.type === "done"));
    return "turn completed with cache-annotated usage";
  });
});
