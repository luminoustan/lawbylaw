// Live check of `/compact`, through the same `compactHistory` the browser runs. Not part of `make evals`
// (needs a key or a running server, and the network). TARGET picks whose model writes the summary:
//   TARGET=nebius (default)  the real Nebius endpoint and Nemotron, with NEBIUS_API_KEY
//   TARGET=deepseek          the real DeepSeek endpoint and its own model, with DEEPSEEK_API_KEY
//   TARGET=free              the shared key: POST /api/compact on the running server (BASE_URL, default
//                            http://127.0.0.1:8000), which uses its own model and key
// The prompt texts always come from that server's /api/agent, as they do in the browser.
//
//   podman run --rm --network host -v "$PWD":/w -w /w --env-file .env <node image> sh -c \
//     'web/node_modules/.bin/esbuild evals/compact-live.mjs --bundle --platform=node --format=esm --outfile=/tmp/c.mjs && node /tmp/c.mjs'
//
// (esbuild is only there to resolve the app's extensionless TypeScript imports.) Two conversations:
//   1. one with a real situation: every reference and fact must survive, verbatim
//   2. one of general questions, with NO situation or amounts: the summary must not invent any. A small
//      model asked to "preserve the user's situation" otherwise makes one up (seen live), and the main model
//      would then treat it as the user's facts.
// The invention check is mechanical: every number in a summary must occur in the text it summarises.
// The key is read from the environment and never printed.
import { compactHistory, COMPACT_MODELS } from "../web/src/agent/compact.ts";
import { PROVIDERS } from "../web/src/agent/providers.ts";
import { LlmError } from "../web/src/agent/llm.ts";
import { createServerTools } from "../web/src/agent/server-tools.ts";

const TARGET = process.env.TARGET || "nebius";
const BASE = process.env.BASE_URL || "http://127.0.0.1:8000";
if (!["nebius", "deepseek", "free"].includes(TARGET)) { console.error("TARGET must be nebius, deepseek or free"); process.exit(2); }
const KEY = (TARGET === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.NEBIUS_API_KEY) ?? "";
if (TARGET !== "free" && !KEY) { console.error(`${TARGET === "deepseek" ? "DEEPSEEK" : "NEBIUS"}_API_KEY not set`); process.exit(2); }

const server = createServerTools({ baseUrl: BASE });
const { texts } = await server.agent("legislation", AbortSignal.timeout(20_000));

// Varied padding, so an answer reads like a real one (a repeated sentence is not a realistic thing to summarise).
const PAD = [
  "The court began by identifying the terms that were actually agreed, and asked what a reasonable person in the position of each party would have understood them to mean.",
  "Notice mattered: a party who wished to rely on a defect had to say so within a reasonable time, and silence for too long was treated as acceptance of the goods as they stood.",
  "Evidence of how the parties behaved after the contract was formed was admitted, but only to show what they thought they had agreed and not to rewrite the written terms.",
  "Where the contract allocated risk in writing, the court was reluctant to disturb that allocation unless a statute required it, and it said so in plain terms.",
  "Remedies were treated separately from liability: even where the right to reject was lost, damages for the difference in value could still be claimed on proof of loss.",
  "The judge stressed that each case turns on its own facts, and that the length of any delay is weighed together with the reason for it and the prejudice it caused.",
  "Costs followed the event in the usual way, subject to any offer to settle that had been made and refused before the hearing began.",
  "Finally the court noted that parties dealing at arm's length in a commercial setting are expected to protect their own interests and to read what they sign.",
];
const filler = (s) => `${s} ${PAD.join(" ")}`;
const tail = [
  { role: "user", content: "What about a misrepresentation claim?" },
  { role: "assistant", content: "Section 2(1) of the Misrepresentation Act 1967 may give damages if Acme misstated the moisture level." },
  { role: "user", content: "And can we recover the $12,500 inspection fee?" },
  { role: "assistant", content: "Possibly, as consequential loss, if it was foreseeable." },
];

const SCENARIOS = [
  {
    name: "a conversation with a real situation",
    history: [
      { role: "user", content: "Acme Trading Pte Ltd sold 400 pallets of timber to Harbour Logistics Pte Ltd on 3 March 2024 for $180,000. The timber arrived damp. Can Harbour reject the goods?" },
      { role: "assistant", content: filler("Under section 14 of the Sale of Goods Act 1979 the goods must be of satisfactory quality, and section 35 governs acceptance, so Harbour must act promptly. See Acme Trading Pte Ltd v Harbour Logistics Pte Ltd [2021] SGHC 123 on damp timber.") },
      { role: "user", content: "Harbour kept the timber for six weeks before complaining. Does that matter, and is there a time limit to sue?" },
      { role: "assistant", content: filler("Six weeks may amount to acceptance under section 35. The Limitation Act 1959 section 6 gives six years for contract claims. Compare [2019] SGHC 77 where a 5-week delay barred rejection but not damages.") },
      ...tail,
    ],
    must: ["Acme Trading", "Harbour Logistics", "180,000", "[2021] SGHC 123", "[2019] SGHC 77", "Sale of Goods Act 1979", "Limitation Act 1959"],
  },
  {
    name: "general questions: no situation, no amounts",
    history: [
      { role: "user", content: "In one sentence, what is the minimum age for a binding contract in Singapore?" },
      { role: "assistant", content: filler("There is no single statutory minimum age: a person under 18 is a minor, and under Section 35 of the Civil Law Act 1909 a contract with a minor is generally void unless it is for necessaries or an apprenticeship that benefits the minor.") },
      { role: "user", content: "Search the legislation and tell me what section 13 of the Evidence Act 1893 says about when facts are relevant." },
      { role: "assistant", content: filler("Section 13 of the Evidence Act 1893 makes relevant any transaction by which a right or custom was created, claimed, modified, recognised, asserted or denied, and particular instances in which it was claimed, recognised or exercised.") },
      { role: "user", content: "In about 250 words, explain what makes a contract binding in Singapore." },
      { role: "assistant", content: filler("A binding contract needs offer, acceptance, consideration and an intention to create legal relations, as supplemented by the Civil Law Act 1909 and the Contracts (Rights of Third Parties) Act 2001.") },
      { role: "user", content: "In about 250 words, explain the difference between a condition and a warranty." },
      { role: "assistant", content: filler("A condition goes to the root of the contract and its breach allows termination; a warranty is a subsidiary term whose breach gives damages only.") },
      { role: "user", content: "Reply with just the word: noted." },
      { role: "assistant", content: "noted." },
      { role: "user", content: "Reply with just the word: understood." },
      { role: "assistant", content: "understood." },
    ],
    must: ["Civil Law Act 1909", "Evidence Act 1893", "Contracts (Rights of Third Parties) Act 2001"],
    // anything that looks like an invented fact about the user
    forbid: [/S?\$\s?\d/, /small[- ]business owner/i, /supplier/i, /deposit/i],
  },
];

const numbers = (t) => new Set((t.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.$/, "")));

// RUNS=3 repeats each conversation: a small model is not fully deterministic, so one pass is weak evidence.
const RUNS = Number(process.env.RUNS || 1);
const who = TARGET === "free" ? `the shared key's model, via ${BASE}/api/compact` : TARGET === "deepseek" ? `model: ${PROVIDERS.deepseek.model} (DeepSeek's own)` : `model: ${COMPACT_MODELS.nebius.id}`;
console.log(`${who}; ${RUNS} run(s) per conversation`);
let bad = 0;
for (const sc of SCENARIOS) for (let run = 1; run <= RUNS; run++) {
  console.log(`\n=== ${sc.name} (run ${run}/${RUNS})`);
  const before = sc.history.reduce((n, m) => n + m.content.length, 0);
  const t0 = Date.now();
  let r;
  try {
    r = await compactHistory({ provider: TARGET === "free" ? null : PROVIDERS[TARGET], apiKey: KEY, history: sc.history, summary: null, texts, server, signal: AbortSignal.timeout(90_000) });
  } catch (e) {
    const msg = KEY ? String(e?.message ?? e).split(KEY).join("[redacted-key]") : String(e?.message ?? e);
    console.error(`FAILED (${e instanceof LlmError ? `LlmError ${e.kind} ${e.status ?? ""}` : (e?.name ?? "Error")}): ${msg}`);
    process.exit(1);
  }
  console.log(`took ${Date.now() - t0} ms; summarised ${r.summarised}, kept ${r.kept}; summary ${r.summary.length} chars vs ${before} chars of history\n`);
  if (run === 1) console.log(r.summary, "\n");

  const source = sc.history.slice(0, r.summarised).map((m) => m.content).join("\n");
  const known = numbers(source);
  const invented = [...numbers(r.summary)].filter((n) => !known.has(n));
  const miss = sc.must.filter((x) => !r.summary.includes(x));
  const hits = (sc.forbid ?? []).filter((re) => re.test(r.summary)).map(String);
  const checks = [
    ["summary is not empty", r.summary.length > 100],
    ["no hidden-reasoning markup", !/<think>|<\/think>/i.test(r.summary)],
    ["kept the last four messages", r.kept === 4],
    [`actually shorter: ${r.summary.length} chars from ${source.length} (limit 70%)`, r.summary.length <= source.length * 0.7],
    [`kept every reference${miss.length ? ` (missing: ${miss.join(", ")})` : ""}`, miss.length === 0],
    [`invented no numbers${invented.length ? ` (not in the conversation: ${invented.join(", ")})` : ""}`, invented.length === 0],
    [`invented no situation${hits.length ? ` (matched: ${hits.join(", ")})` : ""}`, hits.length === 0],
  ];
  for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) bad++; }
}
process.exit(bad ? 1 : 0);
