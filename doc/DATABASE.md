# Database

Paperclip uses PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/). There are three ways to run the database, from simplest to most production-ready.

## 1. Embedded PostgreSQL — zero config

If you don't set `DATABASE_URL`, the server automatically starts an embedded PostgreSQL instance and manages a local data directory.

```sh
pnpm dev
```

That's it. On first start the server:

1. Creates a `~/.paperclip/instances/default/db/` directory for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically for empty databases
4. Starts serving requests

Data persists across restarts in `~/.paperclip/instances/default/db/`. To reset local dev data, delete that directory.

If you need to apply pending migrations manually, run:

```sh
pnpm db:migrate
```

When `DATABASE_URL` is unset, this command targets the current embedded PostgreSQL instance for your active Paperclip config/instance.

Issue reference mentions follow the normal migration path: the schema migration creates the tracking table, but it does not backfill historical issue titles, descriptions, comments, or documents automatically.

To backfill existing content manually after migrating, run:

```sh
pnpm issue-references:backfill
# optional: limit to one company
pnpm issue-references:backfill -- --company <company-id>
```

Future issue, comment, and document writes sync references automatically without running the backfill command.

This mode is ideal for local development and one-command installs.

Docker note: the Docker quickstart image also uses embedded PostgreSQL by default. Persist `/paperclip` to keep DB state across container restarts (see `doc/DOCKER.md`).

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally, use the included Docker Compose setup:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Then set the connection string:

```sh
cp .env.example .env
# .env already contains:
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Run migrations:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  pnpm db:migrate
```

Start the server:

```sh
pnpm dev
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted PostgreSQL provider. [Supabase](https://supabase.com/) is a good option with a free tier.

### Setup

1. Create a project at [database.new](https://database.new)
2. Go to **Project Settings > Database > Connection string**
3. Copy the URI and replace the password placeholder with your database password

### Connection string

Supabase offers two connection modes:

**Direct connection** (port 5432) — use for migrations and one-off scripts:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**Connection pooling via Supavisor** (port 6543) — use for the application:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

### Configure

For the application runtime, use a direct PostgreSQL connection unless the database client has explicit prepared-statement configuration for your pooling mode:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

If you later run the app with a pooled runtime URL, set `DATABASE_MIGRATION_URL` to the direct connection URL. Paperclip uses it for startup schema checks/migrations and plugin namespace migrations, while the app continues to use `DATABASE_URL` for runtime queries:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
DATABASE_MIGRATION_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

If your hosted database requires transaction-pooling-only connections (pgbouncer transaction mode, Supavisor port 6543, Neon `-pooler` endpoints), set `DATABASE_PREPARED_STATEMENTS=false` so the client does not rely on session-scoped prepared statements, and keep `DATABASE_MIGRATION_URL` on a direct connection. Do not edit database client source files as part of deployment setup.

### Client tuning (optional)

All of these are optional; when unset, the driver defaults apply and behavior is unchanged — typical self-hosted setups need none of them:

```sh
DATABASE_PREPARED_STATEMENTS=false   # required for transaction-mode poolers; default: enabled
DATABASE_POOL_MAX=25                 # connection pool size; default: 10
DATABASE_IDLE_TIMEOUT_SECONDS=60     # close idle pooled connections; default: 60 (0 = keep open)
DATABASE_CONNECT_TIMEOUT_SECONDS=10  # default: 30
DATABASE_MAX_LIFETIME_SECONDS=1800   # recycle a pooled connection after this long; default: 30-60 min (random)
DATABASE_APPLICATION_NAME=paperclip  # application_name in pg_stat_activity; default: paperclip
```

### Push the schema

```sh
# Use the direct connection (port 5432) for schema changes
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@...5432/postgres \
  pnpm db:migrate
```

### Free tier limits

- 500 MB database storage
- 200 concurrent connections
- Projects pause after 1 week of inactivity

See [Supabase pricing](https://supabase.com/pricing) for current details.

## Connection loss during a transaction

When a database connection closes, its transaction fails. Paperclip does not
replay that transaction. New requests can use a fresh connection from the pool.
Queries from the failed transaction must keep failing, even after the pool
reconnects.

Source builds carry `patches/postgres@3.4.9.patch` for this behavior. It rejects
queued and later queries from a disconnected transaction or reserved connection,
and prevents a released, closed connection from returning to the open pool.
The patch covers both ESM and CommonJS. The regression suite terminates real
PostgreSQL backends and checks rejection, pool recovery, and transaction isolation.
Remove the patch when an upstream release passes these tests. Installs of the
unmodified `postgres` package outside this workspace do not include the patch.

Trusted-header actor synchronization retries transient connection failures,
including `CONNECT_TIMEOUT`, at most twice. This retry applies only to the
idempotent actor synchronization operations, not arbitrary transactions. A
persistent outage still fails the request after the bounded retries; each
connection attempt remains subject to the configured database connect timeout.

## Switching between modes

The database mode is controlled by `DATABASE_URL`:

| `DATABASE_URL` | Mode |
|---|---|
| Not set | Embedded PostgreSQL (`~/.paperclip/instances/default/db/`) |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

Your Drizzle schema (`packages/db/src/schema/`) stays the same regardless of mode.

## Migration authoring checklist

The 0126 issue comment attribution backfill showed the failure mode this checklist is meant to prevent: each batch looked for the next rows with an unindexed predicate, so PostgreSQL repeatedly scanned the same table and the migration became O(n²) as the table grew.

When authoring migrations or one-time backfills:

- Create the supporting index for the batch predicate before the backfill loop runs.
- Bound batches by an indexed key, such as an id range or keyset pagination cursor. Do not use `OFFSET` pagination or a query shape that re-scans already-visited rows each batch.
- Avoid unbounded full-table `UPDATE` or `DELETE` statements. Add a selective predicate and process rows in bounded batches when table size can be large.
- Use `CREATE INDEX CONCURRENTLY` for large existing tables when the migration can run outside a transaction and must avoid long write locks.
- Split schema changes, index creation, and data backfill into separate phases so each step has clear locking and rollback behavior.
- Treat the `check:migrations` CI gate as the enforcement backstop for these rules. If it flags a migration, rewrite the migration or add a suppression comment with the indexed predicate, batch bound, and reason the remaining scan is safe.

## Migration snapshots

`drizzle-kit generate` diffs `packages/db/src/schema/` against the newest snapshot in `packages/db/src/migrations/meta/`. That snapshot must describe the schema that every migration produces when they run in order. A snapshot that drifts from the schema makes the *next* migration wrong, because `generate` folds the drift into it. The drift can add a column that an earlier migration already created, which makes that migration fail on a fresh database. It can also drop a column that the schema still uses.

- Create every migration with `pnpm --filter @paperclipai/db generate`. Do not hand-write a snapshot.
- Do not hand-edit a snapshot to resolve a merge conflict. Renumber your migration and run `generate` again, as `packages/db/.gitattributes` describes.
- The repo keeps only the newest 5 snapshots. `generate` runs `prune:snapshots` afterwards to delete older ones. Drizzle only reads the newest snapshot, and each snapshot is a full copy of the schema (over 1 MB each). Older snapshots are still in git history.
- `packages/db/src/migration-snapshot-drift.test.ts` is the enforcement backstop. It repeats the diff that `generate` performs and fails when the newest snapshot no longer matches `packages/db/src/schema/`.

## Cloud runtime identity singleton

The private `instance_settings` row whose singleton key is
`cloud-runtime-identity/v1` records the immutable Cloud stack id, warm-pool
claim id, previous pool origin, canonical origin, and stack slug accepted from
Cloud's signed pre-activation assertion. It is separate from the normal
`default` settings row and never appears in the settings API. This is
intentionally instance-scoped rather than company-scoped: an instance has one
public identity, and the existing unique singleton-key index makes concurrent
or later attempts to replace it fail closed. The server loads the row before
constructing URL-dependent runtime services on every boot.

## Resource membership tables

Paperclip stores current-user sidebar membership state in:

- `project_memberships`
- `agent_memberships`

These rows are company-scoped and user-scoped. A missing row means the user is joined, so existing users keep seeing projects and agents in the sidebar until they explicitly leave them. Rows only control sidebar visibility; they do not affect project/agent detail access, all-pages, selectors, assignment flows, or existing company permissions.

Both tables use a unique key on `(company_id, user_id, resource_id)` and keep `state` as `joined` or `left`. Join/leave mutations are idempotent board-user `/me` operations and write activity entries when the effective state changes.

## Decision training snapshot retention

`decision_training_examples` stores a point-in-time copy of an issue, its comments, relevant runs, and the selected decision. Each row carries the `scrub_deleted_comments_v1` retention policy marker, and JSONL exports include that marker alongside the snapshot.

- Deleting a captured source comment transactionally replaces that comment in every affected snapshot with a content-free redaction tombstone. The original body, presentation, and metadata are not retained in the training record.
- Deleting an issue deletes its decision-training examples through the `issue_id` foreign-key cascade.
- Deleting a training example deletes only that example and does not mutate the source issue.

This policy makes training exports self-describing while keeping the decision record usable after a comment deletion without retaining content the author removed.

## Decision queues and triage provenance

The decisions desk stores queue membership, decide-by/snooze state, and retention state in `decision_queues`, `decision_queue_items`, `decision_triage`, and `decision_retention`. These sidecars use the stable attention identity `(source_kind, source_id)` so all attention source kinds can participate without copying source titles, bodies, projects, or other visibility-sensitive data.

`decision_triage_events` is append-only history for queue and triage changes. Current rows and history both carry server-derived user/agent, heartbeat run, API-key, and responsible-user attribution where applicable. Queue reads must resolve and authorize their source rows at read time; a sidecar row is never a visibility grant.

Triage writes serialize on the company and attention-source identity so concurrent partial updates preserve both fields and produce monotonic history versions.

`decision_retention` tracks the last observed source `activityAt`, Keep, reversible archive provenance, and monotonic source/archive versions. `decision_archive_notification_outbox` has a unique key over company, source identity, archive version, and immutable origin agent so repeated sweeps cannot enqueue duplicate notifications; delivery claims are retryable and coalesced per agent.

## Native runner persistence

Native runner state is additive to the existing heartbeat tables. Every existing
`heartbeat_runs` row defaults to `runtime_mode = 'legacy'`; adding these columns
does not select the native runtime or start a runner process. Native execution can
record its resolved runtime profile, provider session, driver, completion
contract, durable event cursor, and finalization phase on the run when a later
rollout explicitly selects it.

`completion_contracts`, `native_run_results`, `native_run_finalizations`,
`work_assessments`, `status_decisions`, and `status_decision_effects` form the
append-oriented evidence and status-decision chain. Unique fingerprints,
versions, ordinals, and idempotency keys make retries deterministic. Composite
foreign keys bind every contract, result, assessment, decision, effect, and
finalization to one company, issue, and run. The database rejects mixed-owner
evidence even when every referenced ID exists. Native source identities on
`heartbeat_run_events` are nullable so legacy events remain readable without
rewriting historical rows. Per-run native source identifiers are unique, while
the existing legacy sequence behavior remains unchanged. The hidden native
coordinator serializes on its bound `heartbeat_runs` row, allocates
`next_event_seq`, and commits a validated PRP event before the transport sends
its cumulative ACK. Byte-equivalent source retries return the existing cursor;
gaps and conflicting replays fail closed. Accepted structured results enter the
finalization ledger, whose retry time and owner lease are checked under a row
lock. None of these writes selects a runtime or changes a legacy run's execution
path.

Durable agent session goals are an additive projection on
`agent_task_sessions`, distinct from the business-goal hierarchy. The row stores
the negotiated goal capability, normalized snapshot and status, desired state,
provider source cursor, monotonic projection revision, and observation time.
`agent_session_goal_actions` is the control outbox: `(session_id, request_id)`
is unique, so retries return the original accepted action. Provider source
ordering fences duplicate and stale updates, and a cleared projection retains
its revision/cursor tombstone so an older provider event cannot resurrect it.

Issue `status_version` advances only when `status` changes. The JavaScript backup
path includes user-defined functions and triggers so a restored database keeps
that invariant. Removing or disabling a future native rollout flag must not
delete these records; persisted experimental runs remain available for recovery
and inspection.

`native_run_finalizations` also stores restart ownership and recovery state.
The controller owner is a server boot id, PID, operating-system process-start
timestamp, and monotonically increasing controller generation. Recovery writes
its correlated request id, current state, and a bounded JSON history. A
successor can take the lease immediately only when coordinated handoff or PID
and process-start evidence proves the prior controller is gone, or when the
lease expires. Recovery generation changes do not increment the independent
provider-attempt counter.

## Chat communication snapshots

Chat communication guidance uses two additive columns: endpoint
`communication_instructions` defaults to empty, and conversation
`communication_guidance` holds the immutable initial task snapshot. Existing
conversations retain a null snapshot; there is no backfill that changes an
ongoing conversation. New Slack tasks receive built-in guidance even when the
endpoint has no additional instructions.

## Telegram private draft identities

`chat_telegram_draft_ids` is a content-free, instance-wide PostgreSQL sequence,
not a company-owned record. Telegram's native Stop callback carries a draft ID
but no actor or Paperclip generation. IDs therefore must not be recycled when
a transaction rolls back or an endpoint/company is deleted and its bot is
connected again. The sequence allocates positive 31-bit IDs without cycling;
exhaustion refuses new draft allocation rather than wrapping or falling back to
random IDs. Never reset it as part of chat cleanup.

The matching `chat_actions` entry remains company/endpoint-scoped and binds the
draft to its exact conversation, publication attempt, runtime, credential and
approved text. Stop can suppress that private draft's final publication; it
cannot cancel a task or model run. Logical backups preserve the sequence, but
restoring an older database may roll back its high-water mark: disaster recovery
must not assume stale provider Stop events are safe to reuse. That restore
boundary is not qualified by the rollback/concurrency regression.

## Attachment upload provenance

`issue_attachments.originating_run_id` records server-derived run attribution at
upload time. It is not writable through attachment or work-product update APIs.
Legacy attachments and uploads without a registered run keep a null value; the
migration deliberately does not infer attribution from mutable work products.
Deleting the originating run clears the reference and fails closed for automatic
chat handoff. An agent's external file selection must match the attachment's
company, task, agent, and originating run. Editing or recreating a work-product
record cannot reassign that authority to a later run.

## Question-response delivery receipts

`issue_question_response_deliveries` is the retry-safe, content-free outbox for
answered `ask_user_questions` interactions. Its unique interaction and correlation
indexes enforce one causal delivery per response. It records source and target
run/turn ids, payload digest, attempt/acknowledgement state, and one of `steered`,
`coalesced`, or `wake_fallback`; answer content remains only in
`issue_thread_interactions.result`. Deleting the interaction cascades its receipt,
while deleting a referenced run clears that run pointer without deleting history.

## Plugin database namespaces

The plugin runtime tracks plugin-owned database namespaces and migrations in `plugin_database_namespaces` and `plugin_migrations`. Hosted deployments that separate runtime and migration connections should set `DATABASE_MIGRATION_URL`; plugin namespace migration work uses the migration connection when present.

## Backups

Paperclip supports automatic and manual logical database backups. These dumps include
non-system database schemas such as `public`, the Drizzle migration journal, and
plugin-owned database schemas. See `doc/DEVELOPING.md` for the current
`paperclipai db:backup` / `pnpm db:backup` commands and backup retention
configuration.

Database backups do not include non-database instance files such as local-disk
uploads, workspace files, or the local encrypted secrets master key. Back those paths
up separately when you need full instance disaster recovery.

## Secret storage

Paperclip stores secret metadata and versions in:

- `user_secret_definitions`
- `user_secret_declarations`
- `company_secrets`
- `company_secret_versions`
- `company_secret_bindings`
- `secret_access_events`

Company secrets use `company_secrets.scope = 'company'` and are bound directly
through `company_secret_bindings`. User-specific secrets reuse the same provider
and version storage, but each value is a `company_secrets.scope = 'user'` row
with `owner_user_id` and `user_secret_definition_id` set. Definitions describe
the reusable company-level slot, declarations record where `user_secret_ref`
bindings are required, and the concrete value is selected later for the
responsible user.

Secret-aware env bindings are supported by agents, projects, and routines. Routine env lives in `routines.env`, is captured in `routine_revisions.snapshot`, and routine dispatches store `routine_runs.routine_revision_id` so runtime secret resolution uses the env snapshot that existed when the run was created. Routine secret refs bind with `target_type = 'routine'`, `target_id = routines.id`, and `config_path` values under `env.*`.

For local/default installs, the active provider is `local_encrypted`:

- Secret material is encrypted at rest with a local master key.
- Default key file: `~/.paperclip/instances/default/secrets/master.key` (auto-created if missing).
- CLI config location: `~/.paperclip/instances/default/config.json` under `secrets.localEncrypted.keyFilePath`.
- Backup/restore requires both the database metadata and the local master key file; either artifact alone is insufficient.
- The server best-effort enforces `0600` key file permissions and provider health reports permission warnings.
- User-scoped values use the same local encrypted provider path. Database
  backups preserve definitions, declarations, owner metadata, version metadata,
  and access events, but restored user-scoped values are decryptable only when
  the matching local master key is restored with the database.

Optional overrides:

- `PAPERCLIP_SECRETS_MASTER_KEY` (32-byte key as base64, hex, or raw 32-char string)
- `PAPERCLIP_SECRETS_MASTER_KEY_FILE` (custom key file path)

Strict mode to block new inline sensitive env values:

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

You can set strict mode and provider defaults via:

```sh
pnpm paperclipai configure --section secrets
```

Inline secret migration command:

```sh
npx paperclipai secrets migrate-inline-env --company-id <company-id> --apply

# direct database maintenance fallback
pnpm secrets:migrate-inline-env --apply
```

Hosted AWS provider notes live in [SECRETS-AWS-PROVIDER.md](./SECRETS-AWS-PROVIDER.md).

### Persistent agent conversations

Migration `0274_agent_chat.sql` adds conversation identity/state and session generation/boundary columns to `issues`, plus idempotent client request IDs and processed session-boundary generations to `issue_comments`. The company/agent/user unique index resolves concurrent first writes to one issue. A check constraint preserves the assigned-agent identity and prevents terminal conversation status. Comment request IDs are unique per issue and user. There is no separate chat/message store. Provider sessions continue to use `agent_task_sessions`; `/new` removes only the matching conversation session, and session writers fence stale generations against the issue row.

## Legacy controller ownership

Legacy run claims atomically record `controller_boot_id`, a database-clock
`controller_lease_expires_at`, and `execution_stage` before workspace provisioning.
The lease renews independently of output. A different container must not infer
controller death from its own process map or numeric PIDs. Expiration grants
cleanup authority; it does not prove that remote inference has stopped. Recovery
revokes the previous boot identity with a conditional update. Its own claim also
expires so another sweep can finish cleanup after a restart. Historical rows keep
null ownership fields and follow the previous recovery path.


## DSP7 private managed-session tables

Migration `0286_nice_redwing.sql` adds ten `dsp7_managed_*` tables for sessions, run bindings, stream receipts, events, content projections, parts, quality snapshots, compressed seat-presence spans, immutable task facts and Jira workload snapshots. Every row is company-scoped. Private body access must go through managed-session routes with owner/admin checks; never join bodies into issue-list/search/log responses. UTF-8 parts and manifests are SHA-256 checked before projection; event sequence and payload digest enforce idempotent append. Large body reads paginate and require authorization on every request.

Body purge deletes parts, message projections and content-bearing event copies together. The session tombstone and stream receipts prevent accidental resurrection. Default body retention is 90 days from session start. The background execution-control scheduler expires at most 100 sessions per transaction, using the partial `dsp7_ms_retention_idx` index and locked rows with `SKIP LOCKED`. Full batches drain on later scheduler ticks; an exhausted batch is checked again after one hour. Failures roll back body deletion and tombstones together, are logged by the scheduler, and remain retryable. Expiry also clears `last_observation`; content-free session identities, stream receipts and timeline metadata remain to reject reuploads and preserve diagnostic history. Parent company/task/run/seat deletion cascades as specified in the schema. Back up before applying the additive migration; roll back by disabling collection and retaining new tables, not by deleting captured data.


## DSP7 seat work schedule

Migration `0287_romantic_mephisto.sql` adds `dsp7_managed_seat_report_settings`, keyed by company with a cascading company foreign key. It stores only the organization work schedule (ISO weekdays and same-day time ranges) and update time; heartbeat history remains in `dsp7_managed_seat_samples`. Schedule updates and activity audit rows commit in one transaction. Existing companies use the documented default until configured. Rule changes apply to historical queries; this is a connectivity reference, not an attendance ledger.

### Management follow-up records

`management_follow_ups` stores one coordination record per company and source issue, with a nullable owner, reminder, optimistic version, updater and timestamp. The source issue is locked during updates; audit and state commit together. Releasing ownership clears reminder state. This sidecar does not replace issue assignees or approval records.

## Complete local recovery bundles

Database backups alone do not preserve attachment bodies or the encryption key.
`scripts/instance-recovery-bundle.mjs` combines an existing logical SQL backup,
config, master key, local artifacts and run logs in a private, checksummed directory.
It rejects symlinks, source changes, nested destinations, corruption and existing
restore destinations. It preserves the SQL gzip extension required by the restore
engine. Checksums detect accidental damage; they are not a signature against an
attacker who can rewrite the manifest.

1. Stop application writers, including background schedulers and agents. Leave
   PostgreSQL available for the logical backup. Keep writers stopped through bundling.
2. Run `npx paperclipai db:backup --json`; record its `backupFile`.
3. Create a private spec JSON with actual configured paths (expand `~` yourself):

```json
{
  "quiesced": true,
  "components": {
    "database": "/absolute/path/to/paperclip.sql.gz",
    "config": "/absolute/path/to/config.json",
    "masterKey": "/absolute/path/to/master.key",
    "artifacts": "/absolute/path/to/storage",
    "runLogs": "/absolute/path/to/logs"
  }
}
```

4. Run `node scripts/instance-recovery-bundle.mjs create spec.json /new/backup-dir`.
   Parent directories must already exist. Include extra named components for
   externally configured local workspaces or other required files. S3 bodies and
   external secret providers require their own backup; this tool does not fetch them.
5. Verify with `node scripts/instance-recovery-bundle.mjs verify /new/backup-dir`.
6. Stage recovery into a new directory with
   `node scripts/instance-recovery-bundle.mjs restore /new/backup-dir /new/restore-dir`.
   This never imports into or overwrites a live database. Import the staged
   `database.sql.gz` into a new, isolated PostgreSQL database using
   `runDatabaseRestore` from `@paperclipai/db` (or gunzip and psql with
   `ON_ERROR_STOP=1`). Restore config, key, storage and logs to the corresponding
   new instance paths; update paths and database URL before starting that instance.
7. Check restored database rows, attachment hashes, encrypted-secret decryption
   and login on the isolated instance before planning any production cutover.

`quiesced` is an operator assertion, not an application lock. The tool detects
changes during each component copy but cannot prove cross-system consistency if
writers remain active. Treat bundles as credentials: transport and store them in
an access-controlled location. No production recovery drill is implied by the
fixture-backed database and encrypted-evidence regression tests.
交付流程的 JSON 阶段记录支持可选 `intent`（bugfix、code-review、retest）、绑定失败回执的 `repairFailure` 及最多三轮的 `repairHistory`。修复链将原失败阶段保存到历史，原 issue 保持可访问且不标为成功；新的修复、独立评审、重测各自建立平台 issue。创建链、更新历史、任务及活动审计处于同一事务，工作流行锁和公司级 Jira 任务预留锁防止并发重复创建。回执新增可选 `testResults` 与 `codeReview` 元数据，均绑定已有产物指纹；不增加数据库列，因此不生成空迁移。旧功能测试回执缺少结果时保留但阻断自动验收。


## Instance personnel directory (2026-11-04)

`personnel_sources`, `personnel_people` and `personnel_departments` now represent
an instance directory. Existing rows are reused without reimporting, copying or
merging accounts. Their `company_id` columns remain immutable provenance and the
original encrypted secret/audit context; they no longer define directory visibility
or membership. Do not delete the origin company while a source references its vault.
Migration `0301_romantic_gambit.sql` adds indexes for enterprise and account lookup;
it does not mutate existing directory rows or membership/seat relationships. For a component deployment to an older runtime, apply only these two idempotent `IF NOT EXISTS` index statements and retain the existing migration journal; later full upgrades can apply all intervening migrations normally.

Instance-only management is at `/api/instance/personnel-federation`. Legacy
company-prefixed management routes are instance-admin-only compatibility aliases.
New sources are serialized with an instance advisory lock and duplicate provider /
CorpId creation is rejected across organizations. Existing duplicate sources are
retained and flagged for manual review; account identities and app scopes must not
be merged by email or guessed. Source provider and CorpId are immutable on edit.
New sources retain the selected organization's vault/audit context; existing sources
keep their original context even when edited from another organization.

Sync creates identities but no organization memberships. Explicit assignment at
`POST /api/instance/personnel-federation/people/:id/membership` creates only an
ordinary operator and its normal task permission, together with an activity row.
Active roles are preserved and suspended memberships cannot be reactivated here.
The person row and target membership key are locked for concurrent assignments.
Local password initialization and directory login accept active membership in any
organization, rather than requiring membership in the legacy origin organization.
Notification listing and send-time validation both require actual active membership
in the target organization, enabled DingTalk source, active person and matching CorpId.

### Delivery workflow templates (2026-11-05)

`delivery_workflow_templates` stores immutable company-scoped revisions. `scope_key` is `organization` or the validated project UUID; `(company_id, scope_key, revision)` is unique. Project rows can publish an inheritance marker in the JSON definition; the resolver then follows the current organization template. Revisions are retained for audit. Workflow `config.template` holds a complete snapshot, and stage JSON holds dependency task IDs, review assignment and confirmed-start state. Existing workflow rows need no rewrite and keep legacy serial dependencies. Migration: `0302_parallel_silk_fever.sql`.

阶段内评审顺序仅扩展现有模板／工作流 JSON：`taskSequence`、`reviewSeatId`、`reviewTasks`、阶段 `executionMode`、`reviewWorkKeys` 及设计／用例评审 intent。人工节点使用前置摘要和人工审批证据，不伪造设备 receipt。没有新增列或表，无需 SQL 迁移；旧记录保持原语义。

人工／Agent 执行配置新增模板 JSON 可选 `workExecution`、`reviewExecution`、`workExecutorUserId`、`reviewExecutorUserId`，阶段 JSON 可选 `manualDelivery`，原生回执可选 `domainReview`。仍使用现有 JSON 字段，没有 SQL 迁移，旧模板和运行记录保留原语义。

### 评审返工（2026-11-05）

交付阶段 `reworkHistory` 在既有 stages JSON 中保存旧交付及评审证据；配置 `rejectionHandling` 固定在既有模板 JSON 中，无新表或 SQL 迁移。


### 交付链开始节点准入（2026-11-06）

模板 stages JSON 新增可选 `entryChecks` 检查项数组；只有首个启用阶段的配置参与条目入口核验。已有工作流固定原模板并保留已准入状态。检查结果随 `delivery.workflow.started` 活动记录保存，不增加表或列，无需 SQL 迁移。旧模板可读但不自动补齐入口条件；新模板发布需明确配置开始节点检查项。

交付链席位归属策略存于现有 `delivery_workflows.config` JSON：新流程保存 `seatAssignment: "jira_assignee"`，`workSeats` 保存按工单的显式席位选择，节点中的 `seatId` 固定实际席位。无需数据库迁移；旧流程缺少该标记时沿用原策略。

### 分析轻舟回写（2026-11-10）

迁移 `0303_flawless_stranger` 为 `analysis_executions` 增加可空 `qingzhou_writeback` JSONB，记录保存参数、状态、来源与版本摘要和回读核验时间；旧记录保持空值。冻结的 `delivery` JSON 可附带与 `analysis.md` 文件指纹匹配的正文，供自动保存与失败重试。成功不改写正式 `publication`。正文受分析任务原有组织和负责人访问控制；活动日志仅存版本与结果，不含正文或凭据。

### 席位轻舟账号（2026-11-11）

迁移 `0304_lazy_the_call` 新增 `seat_qingzhou_accounts`，按组织和席位唯一保存用户名、公司加密凭据引用、配置修订及登录检查状态；密码仅进入 `company_secrets` 的加密版本。移除绑定保留修订墓碑并撤销其凭据，避免旧页面恢复已删除的配置。组织或席位删除级联清除绑定；不复制或自动绑定项目来源账号。分析回写回执增加凭据来源、执行席位和账号修订字段，旧回执继续可读。席位账号配置、检查、移除及同席位分析回写共用事务锁；活动日志不记录密码或 token。


### 项目月度来源归集（2026-11-11）

`delivery_connections.sub_product_attribution` 为可空的轻舟子产品归属代码。设置后，月度查询合并本组织排期与该产品期望本月交付的条目；空值保留原组织排期模式。变更沿用来源配置 revision 与公司/项目权限核验，迁移只添加可空列，不自动改变现有项目归集范围。


`delivery_connections.monthly_sync` 为可空 JSONB，按组织项目连接保存每日同步开关、北京时间、下次运行和最近运行结果。空值表示未开启。数据库行锁保证多个服务实例只有一个能领取同一次定时任务，运行 ID 和租约用于确认快照写入权限及识别中断任务。

### 交付实例已有成果（2026-11-16）

现有 `delivery_workflows.config` JSON 新增可选 `priorCompletions`；阶段 JSON 新增可选 `priorCompletion`，保存版本、成果及正式结论引用、功能测试全部通过数量（仅功能测试）、确认人、时间与来源快照 ID。已有节点保留 `done`，设备回执和运行 ID 保持空值。启动、完成态任务及活动审计同事务提交，无新增表或列，无需 SQL 迁移；旧流程语义不变。

自动计划可以在阶段 JSON 中记录 `historicalVerification` 或 `deferredPriorCompletion`。前者复用人工核验状态和正式结论记录，后者在依赖完成后按授权的 Jira 成果版本回读，核验成功才写入 `priorCompletion`。两者在核验之前保持非完成态。条目级实例的配置 JSON 通过可选的 `entryScope.ignoredParentKeys` 保存管理员确认排除的主单。原有实例缺少该字段时继续核对所有主单。无需迁移。

条目范围的 `entryScope.branches[parentKey].skipTestCases` 可记录启动时授权跳过测试用例阶段，分支范围摘要按剩余工单计算。无需迁移。

`delivery_plan_previews` 按组织、项目、来源和条目号保存一份最近生成的自动计划及其输入，记录生成所用的来源快照。重新生成更新同一条记录，生成事件仅审计快照和计划摘要。


### 自动修复持久化（2026-11-16）

自动修复使用既有模板与工作流 JSON，不增加表或列，无 SQL 迁移。模板 `automaticRepair` 保存模块路由和构建观察策略；实例 `automaticRepairAuthorized` 与服务端派生 `automaticRepairGrant` 固定授权和账号身份。失败阶段 `automaticRepair` 保存每次外部建单的 pending／creating／created 意图、稳定标记、领取时间和回读工单号；调用 Jira 前先独立提交 creating，避免事务回滚后盲目重复外部写入。修复历史保留原失败及防重记录，阶段 `automaticRepairGenerated` 标识自动节点，`expectedBuild` 固定重测构建。回执可附带绑定正式附件指纹的 `failureReport`、`build`，独立代码评审支持具名报告中的 rejected 及修改说明。活动日志记录每次编排状态与管理员重新核对操作。旧 JSON 缺省语义不变。

### 条目交付分支

条目实例沿用公司、项目、条目编号唯一约束。现有配置 JSON 的 `entryScope` 保存 Jira 来源、按主单登记的范围摘要和快照、显式前置主单及启动请求授权。节点 JSON 保存分支阻塞、适用环境引用和实际启动授权人。范围调整重用现有任务，并在节点历史及活动记录保留变更和旧证据。无需新增数据库列。
