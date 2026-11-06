---
name: dsh-collab
description: Delegate authorized work to local DeepSeek Harness agents, continue a project Lead, and inspect its progress, results, policies, or recovery receipts.
---

Use the host's registered `dsh_collab` MCP tools. Begin with `deepseek_runtime_status`; a loaded skill is not evidence of a connected runtime. Do not manually launch a substitute MCP, change window/browser settings, or start a second DSH writer to bypass a connection error.

Use `deepseek_flash` for independent work and `deepseek_lead` for persistent coordination. Pass an explicit absolute `cwd`, a self-contained task and a stable `request_key`. Preserve returned session/submission IDs. A new continuation gets a new key; retrying an uncertain submission keeps its original key and payload.

Choose the permission and child policy authorized by the user. Defaults are Flash, read-only, terminal off. `max_tool_calls: 0` means no tools. A mounted third-party tool still requires runtime registration and task admission; use `deepseek_capabilities` to inspect effective capabilities. Never enlarge permissions merely because a child asks.

`max_children` is a ceiling, not a tool grant. A Lead using `allowed_tools` must retain `subagent` or `subagent_fork` to create children. Preserve the requested whitelist; resolve conflicts with the caller rather than silently widening it. Check receipt `warnings`, `delegation.policyAllows`, and actual `exposedTools`; `delegation.enabled: null` means no request was observed yet. The legacy `allowDelegation: false` field is not the Lead's effective spawn status. Use the task tree to confirm actual creation. Child `send_message` remains blocked while child delegation is disabled even if named in its whitelist; request final-answer delivery instead. File delivery also requires write permission and user authorization.

Omit cumulative request/tool/token/time ceilings unless the user asked for a bound. Provider limits still apply. Explicit shared budgets survive continuation and recovery; do not reset them. Inspect both native usage and the shared ledger, and do not present conservative missing-usage reservations as a provider invoice.

For live work use `wait_for_completion: false`, then inspect the same handle with status and `deepseek_tasks_wait`. A timeout or a closed MCP connection ends observation, not the accepted task. Join descendants before calling a task complete unless the user requested background execution. A settled task can have failed; read its result and termination reason.

Use `deepseek_tasks_wait` for completion checks, then read paged results; do not resubmit the original task just to retrieve status. When advertised, prefer `task_session_id` over `session_id` for hosts that reserve the latter name; conflicting IDs are rejected. This alias does not change the underlying session.

Client receipts default to `response_detail: "compact"`: answers, warnings, effective permissions and usage totals remain, while per-request ledger IDs and trace lists are omitted. Resolve `receiptView.refs` as exact references within that receipt, never as permission grants. Use trace for work history or the receipt's read-only `full` query for raw detail. Preserve pagination and source-truncation flags. On repeated status/result reads, supply the prior `responseRevision` as `if_response_revision`; `unchanged: true` means reuse the earlier result, not an empty answer or completion. These options apply only when present in the mounted schema.

Read full visible work with `deepseek_task_trace` and paged `deepseek_task_result`; honor revisions and truncation flags. Leave `return_reasoning` false unless the user explicitly requests DeepSeek's visible reasoning. Never represent it as this host's private reasoning.

After a Host interruption, inspect with `deepseek_task_reconcile`. Continue the same Lead with its existing scope and budget; do not require abandon or rerun completed children. Unknown write effects require verification and explicit resolution evidence. Never change task databases or fabricate receipts. `abandon` is for work the user explicitly no longer wants, not ordinary recovery.

For user-authorized scheduling use the five `deepseek_schedule_*` tools on an existing Lead, with the authorized expiry window. Creation, delivery, admission and execution are different states; never replay an expired occurrence. Do not substitute host reminders. Background report availability does not imply this host can automatically wake a closed chat.

Stop/archive only when requested or required by the authorized workflow; archiving is non-destructive and requires quiescence. Codex and Claude should coordinate ownership before submitting a new turn to the same Lead. They share one runtime and one task history.

An archived ancestor blocks native subagent descendants even when the child is not archived. Read `admission.blockingSessionId` in task results or reconciliation. Restore that exact session with `deepseek_session_archive(action: "restore")` only when authorized; this never submits a prompt or restores other ancestors. Recheck admission afterward. A historical `blocked` turn is retained and is distinct from the current archive gate.
