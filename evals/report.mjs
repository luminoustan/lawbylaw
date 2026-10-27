// Turns results.json into report.md
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8"));
const titles = { limits: "Abuse limits & boundaries", checklist: "Security checklist controls", browser: "Browser / device behaviour" };
let md = `# lawbylaw eval report\n\nGenerated: ${new Date().toISOString()}\n\n`;
const pass = rows.filter((r) => r.pass).length;
md += `**${pass}/${rows.length} scenarios passed**${pass === rows.length ? "" : " — see FAIL rows"}\n\n`;
for (const [k, title] of Object.entries(titles)) {
  const rs = rows.filter((r) => r.suite === k);
  if (!rs.length) continue;
  md += `## ${title} (${rs.filter((r) => r.pass).length}/${rs.length})\n\n| Result | Scenario | Measured |\n|---|---|---|\n`;
  for (const r of rs) md += `| ${r.pass ? "PASS" : "**FAIL**"} | ${r.name} | ${String(r.detail).replace(/\|/g, "\\|").replace(/\n/g, " ")} |\n`;
  md += "\n";
}
md += `## Checklist mapping\n
| Item | Control | Evidence |
|---|---|---|
| Data visible in dev tools | Stateless API, no PII/cookies/usage events, \`/api/limits\` trimmed | checklist: PII scan, limits keys |
| Ownership via URL | No ids in URLs; history only in the browser's own IndexedDB | browser: isolation between contexts |
| Stripe refunds/webhooks | N/A (no payments); \`/api/stripe/*\` is 404 | checklist route table |
| Wi-Fi dropped mid-action | Idle watchdog, offline banner, abort on disconnect | browser: offline scenarios, limits: disconnect |
| Secrets in AI chats | Key only in Authorization header; scanned in bundle/responses; gitleaks config | limits: canary, checklist: bundle scan |
| 3-year-old phone | Size budget, 100dvh, 44px targets, CPU/3G throttle | checklist: budget, browser: throttled load |
| Duplicate routes | Exact route table, trailing-slash/case/version probes 404 | checklist |
| Lock down /admin | \`/admin*\` and \`/api/admin/*\` hard 404 | checklist |
`;
fs.writeFileSync(path.join(dir, "report.md"), md);
console.log(`report.md: ${pass}/${rows.length} passed`);
