# Seat DING escalation — 2026-10-23

## Behavior

Existing ordinary robot reminders continue. At the configured `escalationMinutes` (default 30 minutes from the beginning of the waiting episode), an unresolved wait is escalated once using DingTalk's application DING API. `reminderMinutes` remains the ordinary message interval (default 10 minutes). Existing per-seat timing and robot/recipient configuration is reused.

A DING has a durable reservation keyed by seat, configured robot, recipient and waiting episode, without periodic buckets. A network timeout or uncertain response never causes blind repeated DING. A new waiting episode gets a new reservation. Before sending, the server rechecks task ownership, nonterminal status, matching alert and fresh seat heartbeat. Resolved waits and offline seats are skipped. Notification confirmation does not resolve the task.

Only the configured company-scoped robot and recipient are used. No personal sender fallback. `remindType: 1` fixes delivery to application DING; SMS and telephone are excluded. Audit delivery rows include channel, status, provider code, waiting episode and the returned `openDingId`. Secrets are not logged.

Official contract: https://github.com/alibabacloud-go/dingtalk/blob/master/robot_1_0/client.go — RobotSendDingWithOptions, POST /v1.0/robot/ding/send. Required DING permissions must be granted to the configured application. No live recipient was used for manual smoke testing.

## Verification and release

12 focused service and delivery orchestration tests passed. Server TypeScript compilation passed. UI production build, generated help and token gates passed. No database schema migration or seat-client upgrade required.

Release staged at /home/fg/paperclip/private/seat-ding-stage. The production import check runs before scheduling. Deployment waits for zero running, queued or scheduled-retry runs; it backs up database and changed files, rechecks baseline hashes, verifies health after restart and rolls back on failure. A pending deployment expires after 24 hours. At staging time one production run was active, so the live server was not restarted.
