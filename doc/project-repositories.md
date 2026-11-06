# Project source repositories

The Create project dialog accepts a name and optional GitHub repository selections.
It uses the same `RepositoryEditor` as project Configuration. Description remains
editable in Configuration. Status, goal links, and target dates remain supported by
the API but are omitted from creation; Status and Goals are omitted from Configuration.
Old Overview URLs and saved Overview preferences redirect to Configuration.

## API and persistence

- `GET /api/companies/:companyId/project-repositories` returns `repositories`,
  `connectionCount`, and `failedConnectionCount`. Repository IDs are GitHub's stable
  numeric IDs represented as strings. Results are deduplicated across accessible
  grants and sorted by full name. Connection labels are display provenance only.
- `POST /api/companies/:companyId/projects` accepts optional `repositoryIds`.
  The server resolves new selections through the caller's authorized GitHub grants
  before creating the project and all repository workspaces in a transaction.
  The existing `workspace` input remains supported; it cannot be combined with
  `repositoryIds`.
- `PUT /api/projects/:id/repositories` accepts the selected `repositoryIds` array.
  Accessible retained IDs refresh their canonical name and URL after renames or
  transfers; unavailable retained IDs keep their saved metadata.
  Replacement is transactional. Existing selections may be retained or removed even
  if their GitHub connection becomes unavailable. New identities require current
  access. Legacy URL workspaces are preserved, and matching legacy URLs are adopted
  without creating a duplicate workspace. Local/remote workspace locations survive
  detaching their repository.

No schema migration is required. Selected repositories are normal project workspaces
with `metadata.githubRepositoryId`. Existing manual `repoUrl` workspaces remain
editable through Configuration and the workspace API. One workspace remains primary.
Tasks materialize the other distinct repositories as editable checkouts inside their
workspace, including when no local folders are configured. Local execution and sandbox
staging use the same layout; sandbox restore preserves each repository's Git history.
See [Project Repository Checkouts](DEVELOPING.md#project-repository-checkouts) for paths,
ignore rules, and reuse behavior. Responsible-user credential rules still apply.
A repository selection never delegates credentials.

## Discovery and setup

The server checks company membership, grant ownership/status, and organization-grant
audiences before loading provider metadata. Connection managers receive no bypass to
another person's personal repositories. Managed GitHub grants refresh installation
access; PAT connections use paginated `/user/repos`. Provider failures are reported
without exposing provider error bodies or credential material. Successful connections
remain selectable when another connection fails.

`ConnectionSetupFlow` owns provider setup in both Apps and project dialogs. Task
intents retain their existing callback protocol. Standalone dialogs verify the saved
connection through the API after the sign-in popup returns to the instance. Project
name and repository drafts stay mounted across setup and cancellation.

## UI review and verification

`Proposals/Project repos` contains the reviewed states, including loading, failure,
empty search, disconnected GitHub, multiple repos, legacy URLs, forty selections,
mobile, and short viewports. The configuration story composes the production page
properties through an explicit repositories slot. Story setup and saves use fixtures.

- Shared visual control: `ui/src/components/RepositoryEditor.tsx`.
- Data and error handling: `ProjectRepositoryInput.tsx`.
- Configuration persistence and legacy editing: `ProjectRepositories.tsx` and
  `LegacyProjectRepository.tsx`.
- Production dialog: `NewProjectDialog.tsx`.
- Server tests: `project-repositories.test.ts` and
  `project-repositories-persistence.test.ts`.
- Browser acceptance: `tests/e2e/project-repositories.spec.ts`.

The browser suite uses a real temporary server and database. It verifies creation,
forty persisted repos, mobile scrolling, removal/save/reload, legacy URL editing,
and rejection without a partial project. Provider discovery is simulated in the
picker rejection test. GitHub network and popup behavior use deterministic fixtures
in integration/component tests; the suite does not authorize a real GitHub account.

## Existing Harness checkouts and repository-free testing

Project source repositories remain optional. A QA Harness can use its own test
assets and a target environment without a separate business repository or a
`harness repo bind` mapping. Native QA admission, environment/build checks and
formal delivery evidence still apply; absence of a business repository does not
skip those gates. Coding intake still requires a project source URL, an existing
local checkout and a locally resolvable baseline.

The seat bridge reports credential-free business repository URLs and current
branches with its authenticated machine heartbeat. Discovery first reads `permissions.additionalDirectories` from each registered
Harness `.claude/settings.local.json`, treating entries as candidates rather than
assuming they are Git repositories. Nonempty native lists are authoritative:
stale, foreign-machine or non-Git entries do not cause substitution of unrelated
sibling repos. Credentials, hooks and commands are not used. All candidates
must still be within the seat source allowlist. Legacy suites without native
directory references can fall back to the
configured `intake_repository_roots`, explicit local mappings, and at most two
levels beneath the allowlisted roots. It excludes registered Harness roots,
skips directory symlinks and build directories, and is bounded by count/time.
Paths remain local. This is local checkout discovery, not a remote repository
crawler; deeper layouts can use the existing explicit mapping. No clone, fetch,
branch switch or source modification occurs during discovery.

The existing repository-options endpoint places these checkouts before GitHub
options for board users who own or manage the reporting company seat. Reports
must have a heartbeat within 90 seconds; terminated seats are excluded. IDs have
`harness:<sha256(URL, branch)>` format. Selection revalidates availability, saves
`metadata.harnessRepositoryId` and initializes `repoRef` for a new workspace.
Matching manual workspaces are adopted while preserving their configured paths
and baseline. Existing selections can remain when their seat goes offline.
GitHub grants and manual URL configuration continue to work independently.

Coding intake first honors an explicit `harness repo bind`. Without one, it can
reuse a unique allowlisted checkout matching the project's origin and baseline.
Ambiguous matches require explicit binding. Execution rechecks origin and root
containment; existing per-ticket worktree isolation and baseline commit recording
remain in force. This does not imply that a different seat has the same checkout.

Deploy the server before upgrading seat bridges: older bridges omit the optional
heartbeat inventory and remain supported; inventory requires the new bridge.
