# Harness V2 validation native dispatch and fixed Bridge entry

## 2026-11-16 Phase 1 closeout

Phase 1 is complete for the token-only observation vertical prototype. Frozen live normal/fault/rollback evidence is preserved. New closeout evidence in the paired Harness tree: `harness/v2/artifacts/phase1-closeout-20261116/{README.md,report.json}`. Host, canonical ledger and authenticated HTTP usage agree (input 13,466 / output 4,843 / cache read 15,936); interrupted runs remain unknown/null. Four concurrent production final-usage replays return one event ID with unchanged ledger/runtime totals and no execution grant. Actual disposable PostgreSQL tests cover concurrent dispatch reservations, permit claims, seat capacity and tenant rejection; this is not a production multi-seat stress claim.

Source and actual frozen service r4 overlay pass the same 94 cases (not 188); original timing/report/identity/review regressions pass 204, observer off/on paired comparisons 3, native state 6 and JS observer/query 21. External identity/Zhiyan/Tracker use existing offline fixtures; production customer workflow takeover is Phase 3 work. Bridge r6 rejects missing modelUsage counters instead of fabricating zero, passes 109 extracted-package tests and retained actual-host-result replay. SHA256 `6b6d3f46660c197adde0a990d22641dcb1264598697648c7eda4e2ce1317746c`; not installed. Existing live proof remains r5.

Current service matches all 22 captured original baseline entries and is healthy with no pilot drop-in. The seat has a later Bridge cf5a58d29584d8a1 since the verified historical rollback; identity/runtime remain preserved. No downgrade or global release was performed. Registry stays candidate/unconfirmed/executionReady=false. Phase 2/3/4, full-repository regression, production customer acceptance, commit/push and release are not claimed. Earlier incomplete/pending statements below are historical; this section is authoritative for current Phase 1 status.


## 2026-11-16 scope amendment: token usage only for this Harness iteration

Per user decision, token usage accounting is required; price integration, monetary billing and real priced-budget exhaustion acceptance are deferred and no longer block this iteration or Phase 1. Existing platform budget/pause controls remain enforced; this document change disables no runtime policy. Preserve historical tests and frozen acceptance artifacts.

Reuse canonical run usage/cost_events and original idempotency: attribute host-reported inputTokens/outputTokens/cachedInputTokens to the same company/task/run/seat. Keep unavailable values unknown with provenance/completeness; do not infer zero, prices or tokens. Do not sum cache and input fields until provider inclusion semantics are established. Verify host-to-platform field parity, replay without duplicate usage, and explicit incomplete usage for interrupted runs. Existing normal-run snapshot records input 13,466, output 4,843 and cached input 15,936 in one canonical row; this is sample evidence, not complete token acceptance. These Phase 1 checks have now passed as documented in the closeout section above.


## 2026-11-16 controlled platform acceptance update

The production 基础平台 / 李巍 pilot on CMP-2 exercised native dispatch and permits, fixed Bridge entry, actual host session and L4 report checks, original outbox ACK and replay rejection, cancellation, natural authorization expiry, targeted network errors, supervisor death and accepted-response loss recovery. All managed trees were verified empty. Final tested service overlay r4 and Bridge r5 were rolled back to the original service bytes and seat configuration; all twelve test grants were revoked. Registry remains candidate / executionReady=false / unconfirmed. CMP-2 is done; Phase 1 as a whole remains incomplete.

The frozen service source and compiled candidate covered the same 81 distinct cases; Bridge r5 extraction passed 108 tests. A later source-only test covers disposable PostgreSQL synthetic billing, original budget pause and permit revocation with actual Python process-tree stop/exit evidence. It uses service calls and stdin, not full HTTP/auth/native dispatch. New validation domains already reject billed-cents hard policies because real prices are unavailable. Production costs remain unknown/unpriced; no fabricated production costs or token-derived prices were used. Priced budget exhaustion was unaccepted under the historical scope and is now deferred, not a Phase 1 blocker; production concurrency and business timing/delivery equivalence remain unaccepted. Detailed immutable inputs and run/permit links: paired Harness `harness/v2/artifacts/validation-platform-acceptance-20261116/{README.md,report.json}`. No global release, commit or push.

Earlier pending/not-deployed statements below describe the preparation baseline, not current platform state.


Status: implemented and locally verified candidate; not deployed or accepted on the live platform.

The authorization-only candidate could not start an isolated synthetic-history task. Validation now has an explicit dispatch operation using the original heartbeat scheduler, and a fixed Bridge execution branch under the original execution permit. It does not masquerade as requirements analysis or use the Jira-development pilot mapping.

## Contract

POST `/api/companies/:companyId/dsp7-seats/:id/harness-validation/:taskId/:dispatchId/dispatch` is manager-only and accepts an empty body. Authorization remains a separate operation. The server rechecks the short-lived grant, owner, task assignment/readiness, machine, registry revision, bundle, budget and pause state under the original seat-command transaction lock. It appends `harness.validation.dispatch-requested` to the existing activity log before calling native `heartbeat.wakeup`, with no run coalescing and with a fresh session. An uncertain wakeup response retains the reservation and is not automatically replayed. The response returns the native run ID and `executionStarted=false`.

Outbound uses a distinct validation packet, excludes issue text execution and dynamic skills/MCP, and rejects malformed validation context without falling back to legacy development. Claim requires permit protocol 1, supervision protocol 2, observer protocol 1 and validation protocol 1 before the job can be claimed. The existing permit service binds the single authorized run and retains renewal, cancellation, expiry, budget and process-tree fencing.

The POSIX Bridge validates the exact observer/validation scope and frozen bundle. It loads the verified fixed helper without creating pycache in the bundle, builds a private three-commit Git fixture, invokes the explicit L4 history skill through the registered Claude runtime and checks the actual session, resource operations, report semantics and unchanged bundle. It reuses the managed-session collector and original outbox. A successful local report does not set platformAccepted.

The direct child session has a parent-death fence. After a supervisor crash, restart recovery only observes matching durable journals/anchors and writes an original exit receipt after two empty-tree observations. It does not kill arbitrary PIDs, restart work, or release an unknown tree. Missing anchors, scope changes, live supervisors/members and process-inspection failures retain the fence. The service row/table model is unchanged.

## Evidence and release boundary

The paired Harness tree contains the frozen report at `harness/v2/artifacts/validation-dispatch-20261116/report.json` and the exact controlled release/rollback plan at `harness/v2/docs/phase1-controlled-release.md`.

- Same 77 targeted cases passed against source and the actual 17-file compiled overlay; they are 77 distinct cases, not 154. Runtime dependencies in this test use the local workspace.
- Final Bridge overlay: 56 files, 12 changed; archive SHA-256 `83844db2699f51ae54c9e92e8494524fb52d238b6ffc9e287aabc3f246a08fc8`. All bytes verified after extraction; 107 targeted tests passed.
- Scoped server/UI API typechecks and generated route drift checks passed. The live Node runtime resolved 214 direct import edges without executing candidate modules.
- The fixed entry passed a real local Claude synthetic run. Fault tests use real local OS processes with fixture transport responses. Neither is live platform acceptance.
- Dedicated project and task CMP-2 were created normally in 基础平台. Task `0e92ab76-ce9b-4a41-b34b-e789e30edbe7` remains unassigned backlog. No real run/permit was created. Only 李巍 (`a8d57a91-cfcc-4642-a2d1-964bdf3c9e9b`) is selected for subsequent rollout.

Production restart and single-seat activation remain pending, followed by live normal/duplicate/identity/cancel/expiry/network/crash-restart/no-double-write/rollback scenarios. Phase 1 is not complete. No commit, push, global installer publication, schema migration or existing business-ledger mutation is claimed. Historical failed import/configuration and intermediate helper/recovery attempts remain archived with passing retests.
