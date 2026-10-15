# DSP7 external confirmation comments

Only agents opting in with adapterConfig.dsp7ExternalConfirmation=true use this path. Board JCONF approval/rejection comments without attachments retain authenticated identity and normal access checks, are stored and audited, and return 201 without queue interruption, implicit task restart, or model invocation. The bridge still validates actual authorization, confirmation ID and timestamp. Ordinary comments retain upstream behavior.

The bridge accepts the rich editor's single Markdown escape before the leading hash while preserving source_body. Non-local-start wakes produce no_model_invocation.

Deployed equivalent JavaScript in runtime dist/routes/issues.js; backup: /home/fg/paperclip/private/issues-before-dsp7-confirmation.js. Restarted only paperclip.service with zero live runs. Upgrade using the patched fork; official runtime replacements will remove this patch. Rollback by disabling the opt-in flag or restoring the backup with no live runs.

Existing user comment c692bbf5-73e7-47d1-9848-9c3071a5fa28 is now a persisted replay approval. Cancelled run 051de170-b4ae-4058-b6e9-55d09d26dbc5 cannot be revived; its verified process tree and lease were cleaned. One local start restores execution using the saved approval. Syntax and service checks completed; no tests run, complete new approval cycle pending acceptance.


Follow-up: protect all standalone JCONF-prefixed board comments, including invalid wording such as 确认, from native interruption. The external bridge still accepts only 同意 or 拒绝; protecting a comment is not approval. This prevents malformed decision messages from cancelling the waiting session. Run fb808715-61ca-42d3-a804-45bb2b5552e7 was already cancelled by the old narrow matcher and waited until hook timeout; no remaining Claude processes were found. Resume requires one new local start, then a valid user decision.
