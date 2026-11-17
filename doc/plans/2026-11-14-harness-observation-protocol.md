# Harness V2 private observation protocol

Candidate implementation on `harnessV2`, based on committed Paperclip `d2f11ed1d` in a separate worktree. The original Paperclip checkout has independent uncommitted changes, including managed-session contracts; those changes were not copied, overwritten or represented as integrated.

## Contract

`harness.observation` is a new closed metadata event in the existing managed-session batch protocol. Its payload is `harness.v2.observation-summary/1`, exported as `HarnessObservation`. It contains run/company/task/stream identifiers, version digests and bounded observation counts. It never contains prompts, tool arguments/results, paths, durations or execution authority. Source/resource digests remain producer assertions, not verified deployment signatures; host session identity remains explicitly unconfirmed.

The server validates the payload's company, task, run and stream against the authenticated registered managed session. Existing device identity, owner transfer/backfill, upload pause, stream sequence, digest deduplication and batch transaction checks apply. The event does not update lifecycle, phase, execution timing or delivery state. No database migration: `managedEvents.eventType` is text and payload is JSONB.

## Negotiation and reads

- Default: `DSP7_HARNESS_OBSERVATION_ENABLED` unset/false. New writes return 409.
- Explicit candidate opt-in: set it to `true`. Authenticated receipts include `capabilities: ["harness.observation/1"]`.
- Bridge checks each fresh receipt; absent capability holds only the new stream, while legacy streams keep uploading. Unacknowledged events prevent premature finalization.
- Read: `GET /api/companies/:companyId/managed-sessions/:sessionId/harness-observations?stream=harness:STREAM&after=0`.
- Existing board company/owner/manager authorization applies on every page. Agent callers cannot read the private board endpoint. Deleted sessions return no data. `Cache-Control: no-store`; maximum 50 rows per page, `next` is a stream sequence.
- UI API client exposes `managedSessionsApi.harnessObservations`; no new page or navigation is claimed.

Disabling the feature stops new ingestion but leaves authorized reads and queued client data intact. This is private managed-session storage, not first-party telemetry, OTLP or heartbeat run logs.

## Bridge and Harness producer

Harness `observation-query.mjs <trusted-binding.json> --transport` validates its bounded snapshot and emits the closed summary. `integrations/dsp7-bridge/harness_observation.py --config <seat-config> --run <registered-run>` accepts that JSON on stdin, verifies the locally registered run/task/company and queues it without network access. An empty, truncated, foreign or malformed payload fails before enqueue. Use only a launcher-provided binding; the binding file is not an authentication mechanism.

`enqueue_summary` uses the existing Collector SQLite WAL. `BEGIN IMMEDIATE` serializes writers; snapshot cursor and event append commit together. Identical repeats are ignored, conflicting snapshots/version changes/regressions fail, and failed enqueue restores the memory queue byte counter. Existing Collector upload reconciles receipt ACKs after response loss. This does not provision a real run or automatically enable a Mod: launcher binding/session verification and automatic polling remain subsequent work. The Mod snapshot itself remains bounded and non-atomic; outbox durability cannot reconstruct observations lost before enqueue.

## Verification

```sh
# From this worktree; existing installed dependencies reused without installation.
node_modules/.bin/vitest run --config harness-v2.vitest.config.ts
(cd packages/shared && ../../node_modules/.bin/vitest run src/harness-observation.test.ts)
HARNESS_V2_ROOT=/path/to/base-harness-infrastructure/harness/v2 python3 -m unittest discover -s integrations/dsp7-bridge/tests -p test_harness_observation.py
node_modules/.bin/tsc --noEmit -p packages/shared/tsconfig.json
```

Route tests use an in-memory DB double with the actual Express route, middleware and shared schemas. Bridge tests use real temporary SQLite and a fake authenticated transport, including response loss after acceptance. The cross-repository test invokes the actual Node query CLI and passes its output through the actual Bridge queue/upload path. These are local contract tests, not live PostgreSQL/platform acceptance or production permission evidence.

The committed generated API catalog has unrelated drift from its generator. This change adds only the new query contract; it does not absorb unrelated regenerated entries. A whole-repository typecheck/build and generator drift cleanup are not claimed complete. No production installation, migration, activation, ticket write-back, push or merge was performed.

Results: 3 shared protocol tests, 6 Express route tests, 8 Bridge tests (including cross-repository producer) passed; shared package typecheck passed. Server cross-package typecheck remains blocked by a linked main-checkout dependency: `../paperclip/packages/db/src/schema/analysis_executions.ts:51` references `qingzhouWriteback`, absent from this committed baseline's `AnalysisExecution`. Isolate the full dependency graph before claiming server build readiness; do not patch the unrelated concurrent feature to silence this diagnostic. The isolated config maps shared/db entry points to this worktree, but transitive relative imports can still reach linked source packages.

New summary appends emit `dsp7.session.harness_observation.appended` in the existing activity log transaction, containing only task attribution. Exact duplicate retries do not append another activity entry; no observation payload is copied to activity logs.

## Launcher and polling follow-up

The earlier automatic-launcher/polling gap is now implemented, off by default. `interactive.py` calls `harness_observation_runtime.prepare` after existing run authorization/registration. An enabled `cfg.harness_v2_observation` must contain exactly `enabled`, `packageRoot`, `packageDigest`, `resourceDigest`. Package root must be canonical POSIX; `package_digest(root)` hashes the four fixed package files (manifest, hooks manifest, observe.ts, query CLI). Resource digest remains an operator-declared lock, not an attested L4 release. No real seat config has been changed.

Preparation checks the native CLI session ID against the registered run, rejects resume and repeat binding, creates a 0700 dedicated run folder and 0600 binding, and returns the plugin argument and child-only environment. Failure leaves domain arguments intact. Inherited stale observation bindings are removed from the child environment. Windows is intentionally unsupported by this candidate; existing domain execution continues.

Collector `scan()` now invokes `poll`, including existing watch/final-scan/recovery paths. Poll verifies the package and stored binding, invokes the real Node query with a 5-second timeout, and queues the strict transport summary. Truncation, tampering or timeout records an unavailable status, without changing permits or domain execution. Collection pause permanently suspends this observation stream for the run because bounded snapshots cannot exclude the paused interval. Existing upload-pause semantics remain unchanged.

Updated results: 14 observer tests and 14 existing permit/explicit-stop/managed-intake tests passed. `tsc -p harness-v2.tsconfig.json` now passes after adding the missing `@paperclipai/db/*` mapping. The prior qingzhouWriteback diagnostic came from transitive DB subpath resolution; no unrelated business type was changed. Full build and live platform/model acceptance remain outstanding.

```sh
node_modules/.bin/tsc -p harness-v2.tsconfig.json
HARNESS_V2_ROOT=/path/to/base-harness-infrastructure/harness/v2 python3 -m unittest discover -s integrations/dsp7-bridge/tests -p test_harness_observation.py
PYTHONPATH=integrations/dsp7-bridge:integrations/dsp7-bridge/tests python3 -m unittest test_execution_permit test_explicit_stop test_harness_managed_intake
```

Distribution must include both new Python modules with the Collector. There is no live activation, model launch, global plugin install, push or deployment in this change.

## Pinned bundle launcher follow-up

The optional observer configuration also accepts exactly `{enabled:true,bundleRoot,bundleDigest,project}`. New `harness_bundle.py` checks the configured canonical lock digest, manifests and all files before invoking the pinned package verifier under Python isolated mode. It rejects workspace/ancestor legacy skill conflicts and preexisting CLI plugin-dir overrides. Preparation supplies both plugin roots and child-only HARNESS_RUNTIME_ROOT/HARNESS_RESOURCE_ROOT/HARNESS_BUNDLE_ROOT/HARNESS_BUNDLE_DIGEST; source/resource digests come from actual manifests. Collector metadata freezes this config for the run, and polling revalidates it before the packaged Node query.

This remains an optional candidate attached to the existing legacy execution route. Invalid candidates fall back to the unchanged old route with an explicit diagnostic; they are not marked loaded. A future platform-required bundle route must reject incompatible dispatch instead. Global installed plugin conflicts and actual model use of L4 skills still require live acceptance. Include `harness_bundle.py` in the Bridge candidate distribution along with the previous two modules.

The cross-repository suite now includes `test_harness_bundle`: local build to launcher parameters/environment to packaged Node query to real temporary SQLite. The Harness `scripts/check-bundle.py` validates both artifacts and runs 12 Mods engine tests on a separate runtime test copy. No live config or plugin installation changes occur.

## Platform candidate bundle registry follow-up

Shared `harness-bundles.ts`, routes `harness-bundles.ts`, UI API client and Bridge `harness_bundle_registry.py` add explicit local-inspection discovery. GET/POST `/agents/:id/dsp7-harness-bundles` use the standard seat key and device binding; board GET `/companies/:companyId/dsp7-seats/:id/harness-bundles` requires company and seat-owner/manager access. POST defaults off unless `DSP7_HARNESS_BUNDLES_ENABLED=true`. It uses seat advisory/row locks, revision CAS, busy protection, immutable digest descriptors, a 16-item cap and minimal activity audit. Exact duplicate retries do not mutate state. Legacy execution capability/routing objects are unchanged.

Stored evidence is explicitly seat-reported-local-files with loadState unconfirmed and executionReady false. The server does not attest package content, project authorization or actual host loading. The new registry is not an execution route. Bridge CLI bundle-register validates locally before networking and negotiates support, without modifying local configuration; stale revisions are returned rather than silently overwritten.

Verification: 19 route tests, 7 shared schema tests and 37 Bridge/regression tests passed; server cross-package typecheck passed. Two existing PostgreSQL tests were skipped because local support probing failed with `uv_os_get_passwd ENOENT`; database concurrency and production acceptance are not claimed. OpenAPI includes three new routes, retaining unrelated generated-catalog drift outside the scope.


Harness V2 单席位试点现要求服务端 `DSP7_HARNESS_V2_SEATS` 精确白名单和 Bridge `harness_v2_pilot` 公司/席位/任务范围。仅开启旧功能开关不再放行。配置、发布前置条件与回滚见 [试点准备](2026-11-14-harness-v2-seat-pilot.md)。
