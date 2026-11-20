#!/usr/bin/env node
// Runs only isolated Vitest fixtures. No production URL or credentials are accepted.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: pnpm delivery:simulate [--output-dir <directory>]\nUses disposable local PostgreSQL, virtual seats and mock Jira; no production changes.");
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== "--output-dir")) throw Error("Expected --output-dir <directory>");
const output = resolve(root, args[1] ?? `data/delivery-simulations/${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const scenarioFile = resolve(output, "scenarios.json"), testFile = resolve(output, "vitest.json"), reportFile = resolve(output, "report.json");
const startedAt = new Date().toISOString();
const files = [
  "server/src/routes/delivery-workflow-simulation.test.ts",
  "server/src/routes/delivery-workflows.test.ts",
  "server/src/routes/analysis-executions.test.ts",
];
const expected = ["offline-before-dispatch", "offline-live-run", "offline-terminated-run", "mixed", "agent-reviews", "code-review-automatic_rework", "code-review-pause", "qa-repair"];
const sourceFiles = [
  ...files, "scripts/simulate-delivery-chain.mjs",
  "server/src/routes/delivery-workflows.ts",
  "server/src/services/delivery-workflows.ts",
  "server/src/services/delivery-workflow-actions.ts",
  "server/src/services/delivery-automatic-plan.ts",
  "server/src/services/delivery-work-plan.ts",
  "server/src/services/delivery-rework.ts",
  "server/src/services/delivery-automatic-repair.ts",
  "server/src/services/delivery-seat-assignment.ts",
  "server/src/services/delivery-repair-jira.ts",
  "integrations/dsp7-bridge/delivery_execution.py",
  "integrations/dsp7-bridge/seat_control.py",
  "packages/shared/src/delivery-workflows.ts",
  "packages/shared/src/delivery-templates.ts",
];
const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, createHash("sha256").update(await readFile(resolve(root, path))).digest("hex")])));
const env = { ...process.env, PAPERCLIP_DELIVERY_SIMULATION_REPORT: scenarioFile };
// The helpers always supply an isolated DB connection; also remove inherited live contexts.
for (const key of Object.keys(env)) if (key === "DATABASE_URL" || key.startsWith("PAPERCLIP_API_") || ["PAPERCLIP_TASK_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_COMPANY_ID"].includes(key)) delete env[key];
let timedOut = false;
const exitCode = await new Promise((done, reject) => {
  const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "vitest", "run", ...files, "-t", "delivery chain mock rehearsal|runs the complete serial chain|runs questions, exact-version review delivery", "--reporter=default", "--reporter=json", "--outputFile=" + testFile], { cwd: root, env, stdio: "inherit" });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 120000);
  child.on("error", error => { clearTimeout(timer); reject(error); });
  child.on("exit", code => { clearTimeout(timer); done(code ?? 1); });
});
async function json(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
const scenarios = await json(scenarioFile), tests = await json(testFile);
const selected = tests?.testResults?.flatMap(file => file.assertionResults.filter(test => test.status !== "pending" && test.status !== "skipped")) ?? [];
const passed = exitCode === 0 && !timedOut && tests?.success === true && selected.length === expected.length + 2 && selected.every(test => test.status === "passed") && scenarios?.scenarios?.length === expected.length && expected.every(name => scenarios.scenarios.some(s => s.name === name && s.status === "passed"));
const report = { schemaVersion: 1, status: passed ? "passed" : "failed", startedAt, completedAt: new Date().toISOString(), timedOut, exitCode, productionModified: false, scope: "isolated API/scheduler simulation; real remote seats and UI transport are not exercised", sourceSha256, selectedTests: selected.map(t => ({ name: t.fullName, status: t.status, durationMs: t.duration, failureMessages: t.failureMessages })), rehearsal: scenarios, evidence: { scenarios: scenarioFile, vitest: testFile } };
await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
console.log(`\nDelivery simulation ${report.status}: ${selected.filter(t => t.status === "passed").length}/${expected.length + 2} selected tests\nReport: ${reportFile}`);
if (!passed) process.exitCode = 1;
