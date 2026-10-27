// Mock DeepSeek (OpenAI-compatible) upstream. Behaviour is keyed on markers in the last user message.
//   __SLOW__    200 tokens, 40ms apart (for concurrency / disconnect tests)
//   __500__     HTTP 500
//   __GARBAGE__ 200 with non-SSE garbage
//   __HANG__    headers then silence
//   __TOOL__    first round asks for a tool call, then answers
//   __LOOP__    always asks for a tool call
//   __LEAK__    echoes system prompt back as the answer
//   __CLASSIFY__ asks for a (local, always-succeeding) classify_issue tool call, then answers
//   __REVISE__  the finalization check is answered with a corrected answer (default: "OK")
//   __INVESTIGATE__ the finalization check is answered with a tool call
//   __SUMFAIL__ the `/compact` summariser returns HTTP 500
// Requests are classified: "calls" = ordinary rounds, "nudgeCalls" = finalization checks,
// "summaries" = `/compact` summarisation.
// GET /__stats -> counters; POST /__reset -> zero them.
import http from "node:http";

// First words of the server's finalization-check prompt (server/src/services/nudge.rs).
// If that prompt is reworded this must follow, or the mock stops recognising checks.
const CHECK_PREFIX = "Check the draft answer above";

function hasToolResultAfterNudge(msgs) {
  const i = msgs.findIndex((m) => m.role === "user" && String(m.content).startsWith(CHECK_PREFIX));
  return i >= 0 && msgs.slice(i).some((m) => m.role === "tool");
}

export function startMock(port = 9100) {
  const fresh = () => ({ calls: 0, nudgeCalls: 0, summaries: 0, toolNudgeSeen: false, aborted: 0, finished: 0, lastBody: null, lastMainBody: null, lastAuth: null, msgCounts: [], bodies: [], captured: [] });
  const stats = fresh();
  const sse = (res, obj) => res.write(`data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`);
  const chunk = (content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
  // Cache-aware usage so the server's prompt_cache_* parsing / metrics are exercised.
  const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 };

  const srv = http.createServer((req, res) => {
    if (req.url === "/__stats") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ...stats, bodies: undefined, captured: undefined }));
    }
    if (req.url === "/__captured") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(stats.captured));
    }
    if (req.url === "/__reset") {
      Object.assign(stats, fresh());
      return res.end("ok");
    }
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      stats.lastBody = raw;
      stats.lastAuth = req.headers.authorization || null;
      const msgs = body.messages || [];
      const users = msgs.filter((m) => m.role === "user");
      const str = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
      const lastUser = users[users.length - 1];
      let text = str(lastUser);
      // `/compact` (POST /api/compact): the summariser's own system prompt, no tools, not streamed.
      const isSummary = body.stream === false && String(msgs[0]?.content || "").startsWith("You write faithful summaries");
      const isCheck = text.startsWith(CHECK_PREFIX);
      const isGate = String(msgs[0]?.content || "").startsWith("You are GATEKEEPER");
      stats.captured.push({ kind: isGate ? "gate" : isSummary ? "summary" : isCheck ? "check" : "main", body });
      if (isGate) {
        stats.gateCalls = (stats.gateCalls || 0) + 1;
        const g = String(msgs[0] && users[0]?.content || "");
        const um = (g.match(/<user_message>\n([\s\S]*?)\n<\/user_message>/) || [])[1] || g;
        if (um.includes("__GATE_FAIL__")) { res.statusCode = 500; return res.end("{}"); }
        if (um.includes("__GATE_BAD__")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { content: "sure, allow" } }] })); }
        const l = um.toLowerCase();
        const verdict = um.includes("__GATE_INJECT__") || l.includes("system prompt") || l.includes("ignore previous") ? "injection"
          : um.includes("__GATE_LOW__") || /^\s*(hi|hello|hey)\b.*(who are you|what can you do)/.test(l) ? "low_value" : "allow";
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict }) } }], usage: { prompt_tokens: 200, completion_tokens: 5, total_tokens: 205 } }));
      }
      if (isCheck) { stats.nudgeCalls++; text = str(users[users.length - 2]); }
      else if (isSummary) stats.summaries++;
      else {
        stats.calls++;
        stats.lastMainBody = raw;
        stats.msgCounts.push(msgs.length);
        if (msgs.some((m) => m.role === "tool" && String(m.content).includes("<system-reminder>"))) stats.toolNudgeSeen = true;
      }
      const hasToolResult = msgs.some((m) => m.role === "tool");
      let closed = false;
      res.on("close", () => {
        if (!res.writableFinished) { closed = true; stats.aborted++; }
        else stats.finished++;
      });

      if (isSummary) {
        if (raw.includes("__SUMFAIL__")) { res.statusCode = 500; return res.end("{}"); }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { content: "SUMMARY-OF-EARLIER-TURNS: user asked about tenancy deposits; Section 5 discussed." } }], usage: { total_tokens: 500 } }));
      }
      if (body.stream === false && (text.includes("__SUBTASK__") || text.includes("__SUBJUD__"))) {
        (stats.subCalls ||= []).push({ max_tokens: body.max_tokens, tools: (body.tools || []).map((t) => t.function?.name), system: String(msgs[0]?.content || "").slice(0, 60) });
        const jud = text.includes("__SUBJUD__");
        res.writeHead(200, { "content-type": "application/json" });
        const msg = hasToolResult
          ? { role: "assistant", content: "[]" }
          : { role: "assistant", content: null, tool_calls: [{ id: "sub_1", type: "function", function: { name: jud ? "search_judiciary" : "search_legislation", arguments: JSON.stringify({ query: "deposit return" }) } }] };
        return res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: hasToolResult ? "stop" : "tool_calls" }], usage: { total_tokens: 100 } }));
      }
      if (text.includes("__RESEARCH__") && !hasToolResult) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_r", type: "function", function: { name: "research_legislation", arguments: JSON.stringify({ prompt: "__SUBTASK__ deposits" }) } }] }, finish_reason: null }] });
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage });
        sse(res, "[DONE]");
        return res.end();
      }
      if (text.includes("__JUDRESEARCH__") && !hasToolResult) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_j", type: "function", function: { name: "research_judiciary", arguments: JSON.stringify({ prompt: "__SUBJUD__ deposits" }) } }] }, finish_reason: null }] });
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage });
        sse(res, "[DONE]");
        return res.end();
      }
      if (text.includes("__500__")) { res.statusCode = 500; return res.end('{"error":"boom at /srv/deepseek-internal key=sk-leak"}'); }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (text.includes("__GARBAGE__")) { res.write("\x00\x01<html>not sse</html>\n\n{{{{"); return res.end(); }
      if (text.includes("__HANG__")) return; // never finish
      const wantClassify = (text.includes("__CLASSIFY__") && !hasToolResult) || (isCheck && text.includes("__INVESTIGATE__") && !hasToolResultAfterNudge(msgs));
      if (wantClassify) {
        sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_c", type: "function", function: { name: "classify_issue", arguments: JSON.stringify({ categories: ["civil"], summary: "deposit dispute" }) } }] }, finish_reason: null }] });
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage });
        sse(res, "[DONE]");
        return res.end();
      }
      if (isCheck && text.includes("__SLOWCHECK__") && !hasToolResultAfterNudge(msgs)) {
        return setTimeout(() => {
          sse(res, chunk("OK"));
          sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
          sse(res, "[DONE]");
          res.end();
        }, 3000);
      }
      if (isCheck) {
        const reply = hasToolResultAfterNudge(msgs) ? "Final answer after investigation." : text.includes("__REVISE__") ? "Revised answer after verification." : "OK";
        sse(res, chunk(reply));
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
        sse(res, "[DONE]");
        return res.end();
      }
      const wantTool = text.includes("__LOOP__") || (text.includes("__TOOL__") && !hasToolResult);
      if (wantTool) {
        sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search_legislation", arguments: JSON.stringify({ query: "tenant rights" }) } }] }, finish_reason: null }] });
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage });
        sse(res, "[DONE]");
        return res.end();
      }
      if (text.includes("__LEAK__")) {
        const sys = msgs.find((m) => m.role === "system")?.content || "";
        sse(res, chunk("SYSTEM_ECHO:" + String(sys).slice(0, 4000)));
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
        sse(res, "[DONE]");
        return res.end();
      }
      if (text.includes("__SLOW__")) {
        let i = 0;
        const t = setInterval(() => {
          if (closed || res.destroyed) return clearInterval(t);
          if (i++ >= 200) {
            clearInterval(t);
            sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
            sse(res, "[DONE]");
            return res.end();
          }
          sse(res, chunk(`tok${i} `));
        }, 40);
        return;
      }
      for (const w of ["Hello! ", "This is a ", "mock answer."]) sse(res, chunk(w));
      sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
      sse(res, "[DONE]");
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve({ srv, stats, port, close: () => srv.close() })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMock(Number(process.env.MOCK_PORT || 9100)).then((m) => console.log("mock deepseek on", m.port));
}
