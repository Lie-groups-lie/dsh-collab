# 0.4.0-rc.2 — Task lineage, build provenance and pending inbox preservation

- Reuse native DSH MarkdownText and theme tokens in the read-only process/result view. Show user bubbles, per-turn conversation rows, paired tool calls/results and a lazy trajectory outline; keep the task tree and metrics/child-policy sidebar. No native composer, retry, fork or submit action is mounted. Older windows with missing call results are labelled as incomplete evidence, never inferred to be running or successful.

- Replace default raw policy and schedule JSON with permission/budget cards and delivery/execution timelines. Tool inputs use named fields; exact data stays in collapsed audit details. Missing values remain unknown, and interrupted alone never implies recovery is verified.
- Show human task titles, roles and separate execution/settlement states in the tree. Codex and Claude Clients receive the same readable textual hierarchy alongside unchanged structured data; no native host agent chart is claimed.

- Include an explicit, hash-gated `bin/repair-native-disposal.mjs` maintenance command for two DSH 0.2.1-rc.2 cleanup callbacks. Cordis repeat disposal can return undefined; normalize with Promise.resolve while retaining cleanup timing and diagnostics. Never auto-applied, never changes task data, and does not fix the separate V8 access violation.
- Report native archive ancestry in task results, lists, trees and recovery inspection. Refuse blocked submissions before creating turns; preserve idempotent receipts and native archive enforcement.
- Extend deepseek_session_archive with explicit action: restore. Restore only the named native session, without model execution, replay or ancestry changes; offer restoration in the context menu and an ancestor-specific detail banner.
- Normalize native object-shaped turn/end reasons to stable receipt outcomes. Historical blocked status remains separate from current admission.

- Add read-only deepseek_task_tree (27 core tools). Keep durable parent links separate from native ownership and budget roots; include archived and missing nodes without waking cold Agents.
- Add collapsible tree UI, per-turn receipts and execution build/instance identities; preserve current-session metrics and continuous process/result reading.
- Retain previous execution receipts atomically without resetting cumulative accounting or inventing legacy identities.
- Stamp all three assets and each host installation with source/build/file provenance; verify actual Runtime files once at startup.
- Preserve the native pending inbox during DSH 0.2.1-rc.2 lifecycle disposal, prevent shutdown wakeups, and leave explicit user cancellation unchanged.
- Bound Windows atomic rename sharing-conflict retries; permanent failures remain errors, with no model replay.
- Candidate only. Matching symbols identify two historical native crashes in a V8 optimization thread, but the initiating cause and elimination are not yet established. No production Electron replacement is bundled.

# 0.4.0-rc.1 — Runtime / Clients / Research

- Split one repository into three immutable assets; preserve the native package identity and existing task storage.
- Thin Codex and Claude Code adapters share schemas and authenticated streaming control API 2. No local task writer, runtime auto-start or uncertain-submission replay in Clients.
- Research uses native Extension API 1 plus four pure SDK files, replacing whole-core vendoring.
- Clear previous completion reasons when a new turn starts; normalize running readouts without rewriting historical receipts.
- Explicit Lead terminal permission is now accepted by its public schema; child policy remains independent. Asynchronous Lead replies honor return_reasoning=false and retain replay/recovery receipts.
- Preserve structured compatibility/runtime diagnostics through the new endpoint, without discovery credentials.
- Three community window modes passed isolated same-Lead recovery with three completed children and browser access off. Claude Code formal plugin loading passed. No paid model used for these tests.
- This is not a root-cause fix for historical native access violations or a claim of mathematical effectiveness. Public release still awaits owner license/branding and broader validation.

# 0.3.1-rc.14 — 独立原生控制通道

- 协作中心通过公共原生 Gateway 调用，不再 HTTP 请求自身。
- Codex 使用独立本机鉴权端点，与窗口模式和浏览器访问开关解耦。
- 保留 rc.12/rc.13 MCP 线协议，已有 Codex 聊天无需重启。
- 同一任务库、权限、预算和恢复规则；不迁移或重跑已有任务。
- 此更新不代表 0xC0000005 已解决；验证与限制见宿主接入说明。

# rc.12 local hotfix — runtime-launch-recovery-20261023.2

- Fix restart blocked when Windows reuses a previous DSH PID for an inaccessible system service. The one-shot GUI-subsystem helper requests only query-limited rights. If direct access is denied and a saved birth identity exists, bounded public WMI creation metadata may prove that it is a different process; rounded metadata never grants ownership. Unavailable or near-matching metadata remains unknown and fails closed. No elevation, ACL changes, terminal window, service termination, or constant WMI polling.
- Carry the expected birth identity through runtime connection, launch coordination and writer acquisition. Replace only a positively disproven stale owner, never a genuinely live owner or a legacy PID-only lock. Existing task records, results, usage and unknown-side-effect protections remain in place.

# rc.12 local hotfix — runtime-launch-recovery-20261023.1

- Separate runtime launch coordination from session-operation locks. A crash-released kernel lease and durable launch journal prevent a dead desktop launcher from permanently blocking an already-ready detached backend.
- Validate process birth identity, original launcher, handshake, loopback authentication, installed version and state directory before adopting an interrupted launch. Keep the handshake until connection publication. Unknown/live owners are not evicted; task locks and unknown-side-effect protections are unchanged.
- Add explicit `runtime-recover` CLI: attach-only; never spawns a replacement backend or submits a task. No MCP schema, native bridge, budget or provider changes. Current desktop can load these manager files without restarting its existing backend or Codex.
- Verified 29 launch/lifecycle/connection tests and isolated real-DSH interrupted-publication, legacy-lock and concurrent-recovery scenarios with zero model requests. This does not diagnose the separate historical native process access violation.

# 0.3.1-rc.12 — live-client compatible recovery (2026-10-21)

- Keep the existing `reconciliationApi: 1` inspect/abandon contract and advertise the additive same-Lead recovery as `recoveryApi: 1`. rc.10 clients enforce an exact reconciliation version; increasing it broke their inspection calls despite a compatible backend. Ordinary same-Lead continuation uses the new native recovery without a Codex restart; old tool schemas do not acquire the new manual `recover` enum until host reload.
- Carry the recovery capability through standalone/desktop publication and attach. Add acceptance with the unchanged rc.10 client against the newly packaged backend. No change to recovery journals, task data, tool permissions or budgets.
- Reference desktop 0.4.1-rc.12. rc.11 is superseded by this backward-compatible build.

# 0.3.1-rc.11 — same-Lead interruption recovery (2026-10-21)

- Explicit continuation now prepares the original interrupted Lead automatically instead of requiring abandonment. Native history, completed children, their files/results and cumulative budgets are preserved. Old request keys return old receipts without execution.
- Add `reconciliationApi: 2`, `deepseek_task_reconcile(action: recover)` and verified tool resolutions. Durable recovery journals tolerate interruption during recovery itself. Unknown side effects are not silently repeated; targeted holds remain until evidence is supplied. Active work and unrelated queued input still prevent conflicts.
- Preserve completed-child inbox notices and block reactivation of those children during the recovery summary. No automatic background task replay, deadline renewal, quota reset, permission expansion or extra runtime process. Missing usage is conservatively accounted with the original ledger retained, not presented as a provider billing claim.
- Collaboration context menu prepares recovery without abandon; status and policy details expose recovery evidence. Skill instructions no longer ask users to abandon ordinary interrupted work. Reference desktop 0.4.1-rc.11; pinned upstream and bridge contract unchanged.

# 0.3.1-rc.10 — runtime lifetime evidence and controlled recovery (2026-10-20)

- Persist bounded per-instance process evidence independently of desktop/MCP pipes: startup, native ready identity, official fail-loud markers, exception stack locations, natural exit and owner-observed exit. No raw stderr, task text, credentials, timers or exception suppression. Retain the newest 20 closed process records; each record has at most 32 events.
- Classify exited/replaced backend, timeout and authentication failures. Structured MCP diagnostics preserve process identity and uncertainty. Read-only operations may follow a changed authenticated connection record once; writes are never automatically replayed.
- Desktop and explicit standalone startup share a publication lock. An unreachable live/unverified process refuses a second backend. A verified dead instance can be recovered only by explicit startup/recovery; no restart loop and no task resubmission. Connection records are published atomically with stable instance and process-birth identity.
- Desktop retains prior observer results and offers an offline recovery action. Exit observation is event-driven. No quota, model, permission, provider dependency or scheduler change. DSH and task bridge remain pinned; tool count remains 26.
- Add real desktop-owned cold-start acceptance, parent-exit and official fatal-exit/recovery tests. The old prestarted-backend desktop test is retained as a separate attach test, not described as ownership coverage. A historical process exit with discarded stderr and no exit record still has an unproven original cause; fault injection is not historical reproduction.

# 0.3.1-rc.9 — projection binding, interrupted-tree reconciliation, scheduling windows (2026-10-20)

- Bind native projection `cellFor`/`advanceCell`/`drive` internals to their registry owner for the plugin lifetime, without changing upstream files or prototypes. Installation rejects an unsupported registry shape. Capture bounded stack-frame locations and registry/module identity on future native agent errors. The historical missing-method error had no retained stack; the original receiver's provenance remains unproven. The regression covers controlled receiver faults plus actual DSH continuation → write/edit → projection → next-step completion, not a claim to reconstruct the historical object.
- Correct `turn/end` error flags in native traces. Expose shared-root/scheduled deadlines and diagnostic metadata. Unknown descendant/finalizer states now block handoff even when native running is false.
- Add `deepseek_task_reconcile` (26 tools total), with read-only inspection, evidence digest, explicit abandonment, durable idempotency receipt, quiescence checks, conservative missing-usage accounting and preserved native history. No automatic replay, budget reset or conversion of failure into success.
- `schedulingApi: 2` adds `expires_at`, configurable admission lateness (default 300 seconds), consumed expired occurrences and clearer delivery/execution states. Execution windows apply to model requests, tools, children and automatic continuation. This does not impose a five-minute execution budget. Old overdue occurrences are not replayed.
- Collaboration UI adds explicit interrupted-task reconciliation in the context menu, a Lead scheduling receipt tab, and the effective shared deadline. No extra timer, runtime or model-polling process.
- Reference desktop `0.4.1-rc.9`; pinned upstream DSH remains `0.2.1-rc.2`, task bridge contract remains `2026.10.19.3` (additive capability gates). Codex native tool discovery and native runtime loading are verified separately.

# 0.3.1-rc.8 — PID-reuse-safe writer ownership (2026-10-20)

- Writer locks now store OS process birth identity as well as PID. A recycled PID no longer prevents restart; the original live writer still excludes a second runtime. Unknown identities and live legacy PID-only locks fail closed, with actionable diagnostics rather than killing a process by saved PID.
- Windows uses a read-only GUI-subsystem helper built from the included C# source with the installed .NET Framework compiler. It runs only during writer acquisition, without PowerShell, a console window, or periodic polling. Linux uses procfs; macOS uses a bounded `ps` query (not end-to-end certified).
- Durable startup reports writer failures to the desktop through a bounded per-launch diagnostic file. Session data, policies, cumulative budgets, scheduling deduplication and the 25-tool API are unchanged. Reference desktop `0.4.1-rc.8`; DSH `0.2.1-rc.2`, bridge `2026.10.19.3`.
- This fixes a confirmed restart blocker, not an established cause of every prior exit or system-wide lag. Legacy live-PID locks require verified operator recovery; never delete all state or terminate an unrelated reused PID.

# 0.3.1-rc.7 — native scheduling and execution history (2026-10-20)

- Add five `deepseek_schedule_*` management tools using the official DSH scheduler, not a Codex timer or a second polling scheduler. Existing managed root Leads only; create/update/delete/list/history with stable request keys, revision checks and native delivery receipts.
- Native inbox admission shares Lead lease/policy enforcement; policy drift is denied until explicitly re-authorized. Child routing restrictions, terminal guards, model locks and cumulative budgets remain unchanged. No task is scheduled by updating the plugin.
- Durable occurrence watermark rejects duplicate delivery. Native overdue delivery resumes after backend restart; already-admitted uncertain executions remain unknown without blind replay. Delete suppresses queued unadmitted work but does not interrupt a running Lead. Delivery is not execution completion.
- Add read-only `deepseek_task_trace` (25 MCP tools total). The collaboration detail opens on native execution history, with visible intermediate output, tool arguments/results, child links and older-record scrolling. Long records have explicit continuation; private reasoning is excluded. Latest-result and 128-event summary views remain available separately.
- Add `schedulingApi: 1` discovery through runtime/desktop/standalone paths. Bridge task contract remains `2026.10.19.3`; reference desktop is `0.4.1-rc.7`. This candidate does not certify arbitrary plugins, UI-only integrations or Codex-chat wakeup.

# 0.3.1-rc.6 — plugin discovery and child grants (2026-10-20)

- Add read-only `deepseek_capabilities` (19 tools total): bounded host inventory before task creation, effective loaded-session admission, real schema export/hash and denial reasons. Cold agents are never resolved or awakened. The additive endpoint requires native `capabilitiesApi: 1`; the task protocol remains compatible with bridge `2026.10.19.3`.
- Expose `child_policy.allowed_tools` and `child_policy.allow_external_writes` through the public Lead schema. The existing policy normalizer and native guard enforce reviewed third-party grants independently for Lead and future children. No implicit permission widening or credential transfer; original plugin approval and native schedule restrictions remain.
- Parse current DSH attempt/turn-end provider failures and persist bounded public error facts. Failed tasks no longer return an empty error; absent detail is explicit UNKNOWN. Current-turn partials and completed sibling results remain intact. No automatic quota retry or replay of old work.
- No dependency, timer, background process, model default or budget change. Reference desktop `0.4.1-rc.6`; DSH remains `0.2.1-rc.2`. Local candidate, not a claim of compatibility with every external plugin.

# 0.3.1-rc.5 — Lead identity and actionable compatibility diagnostics (2026-10-19)

- Lead names are Unicode display labels, not identity checks. MCP, desktop grouping and native coordination guards use persisted roles first; only metadata-free legacy roots fall back to old titles. Renaming a managed Lead does not detach it. Observation never migrates roles, renames sessions or writes control messages.
- Contract errors report actual/expected values and the older side per component. A stale client no longer receives an incorrect instruction to restart a newer backend. Missing or unorderable versions remain explicitly unknown. MCP errors, runtime status and CLI doctor share the diagnostic implementation; admission remains strict.
- No new protocol, model request, permission, output/tool budget or transcript format. Bridge contract remains `2026.10.19.3`; DSH stays `0.2.1-rc.2`. Reference desktop candidate `0.4.1-rc.5`. Packaging does not mutate installed caches, restart Codex or replace live sessions.

# 0.3.1-rc.4 — answer-oriented execution (2026-10-19)

- Omitted tool-count, request-count, cumulative token and duration limits now mean no plugin limit. `-1` is an explicit unlimited counter value; `max_tool_calls: 0` still removes all tools. Explicit finite budgets remain enforced and accounted across continuations; old finite budgets are not silently erased.
- Per-response output defaults to the provider ceiling (393,216), and transcript management defaults to native DSH compaction. Concurrency, child-count, filesystem, terminal and model-routing protections remain independent and unchanged. Uncapped work can incur substantial provider charges; cancellation remains available.
- Native automatic continuation keeps the same task/session after truncation or a recognizable preamble. It waits for the native driver boundary, preserves full task instructions and parent delivery, and journals pending work before observers can certify completion. No fixed three-round cap; errors, cancellation, explicit budgets and identical no-progress stop rather than silently loop.
- Fix commentary suppressing empty-final recovery, status/result disagreement due to short history windows, and internal conclusion tasks appearing as unrelated research jobs. Trace views show bounded execution events and explicit legacy/no-tools states instead of `[]`.
- Bridge contract `2026.10.19.3`; matched runtime and MCP deployment required. This candidate does not alter existing running task policies or reopen completed tasks.

# 0.3.1-rc.3 — continuous collaboration workspace (2026-10-19)

- All three native collaboration views use continuous reading: task inventory, revision-pinned result text, and report timelines. Transport remains bounded (50 tasks / 12,000 result characters / 20 reports per request).
- Neutral, theme-inheriting workspace rows, compact status labels, contextual batch actions, and right-click / keyboard / ellipsis menus. The original DSH conversation UI is untouched.
- Scroll reads are single-flight and user-driven; collapsed folders do not automatically drain history. Refresh retains the loaded task tail when its anchor is still present; changed inventories restart their cursor safely. Failures retain readable content, and navigation cancels obsolete reads.
- Reports keep at most 256 events in the open view; raw JSON renders only when expanded. Hidden list polling remains paused. No new model calls, background service, dependency, permission, prompt, or budget changes.
- Reference desktop source: 0.4.1-rc.3. DSH 0.2.1-rc.2 and bridge 2026.10.19.2 are unchanged. Packaging does not automatically replace a running installation. Prior lag/crash investigations remain open; this is not a universal performance-fix claim.

# 0.3.1-rc.2 — bounded observation workload (2026-10-19)

- Task lists revalidate compact cached metadata by atomic file identity; ordinary sessions no longer trigger missing policy-file reads or repeated budget-root parsing.
- Concurrent waits share short-lived observation snapshots in each host process. Writes invalidate the cache; completion is confirmed with a fresh authoritative read. Policy and budget admission do not use this cache.
- Progress reads reuse session summaries. Header/final-message extraction no longer expands packed reasoning unnecessarily.
- Web lists refresh at 8 seconds while active and 30 seconds while idle; hidden pages and detail/report views stop automatic list reads. Details use one result request instead of overlapping status/result requests.
- Reports reuse per-tick previews and budgets, and only read visible result previews for the bounded displayed task set. Native session events unrelated to results skip redundant task-file reads.
- Reference desktop 0.4.1-rc.2 pauses hidden/minimized observation, loads card details only on demand, bounds history caches, and caches missing headers. Workspace identity remains independent of heavy history reads.
- Bridge contract `2026.10.19.2`; DSH remains `0.2.1-rc.2`. No model, prompt, output budget, permission or retention reduction. No dependency download or new background process is required by these optimizations. Existing installations require a controlled matched upgrade.

# 0.3.1-rc.1 — shared service and durable reports (2026-10-19)

- MCP is now a protocol adapter over `service/index.mjs`; the web API and optional Research client use that same facade. The pure core remains independent of host transports and Research.
- Added `deepseek_watch`, `deepseek_notifications`, `deepseek_notifications_ack` (18 tools total). The existing native DSH process owns persistent watches, bounded report storage, replay and per-consumer acknowledgements. No new background executable or model polling.
- Idempotent watch creation, restart reconciliation, expiry, retention-gap reporting and corrupt-channel isolation. Idle ticks use a metadata index rather than parsing every historical report.
- Native collaboration UI adds background reports, watch actions and explicit detail refresh. Slow list reads are no longer repeatedly aborted by the polling timer; failed refreshes retain prior data.
- Stop receipts now say cancellation requested, not falsely that execution has stopped. Existing explicit task-tree cancellation and quiescence checks remain available.
- A finished Codex chat still needs an explicitly enabled host heartbeat. The Skill documents the official host workflow; the plugin does not start Codex, bypass MCP registration or write control messages into Lead conversations.
- Bridge contract is `2026.10.19.1`, with DSH still pinned to `0.2.1-rc.2`. Use matching runtime/client builds. This is a local candidate, not a public stable release or a mathematical effectiveness claim.

# 0.3.1-alpha.3 — managed collaboration candidate (2026-10-18)

- Unified LLM-stream admission covers compaction/auxiliary calls; shared input/output, request, concurrency and configured-price ceilings. Cooperative deadline cancellation and conservative missing-usage charges.
- Administrator-pinned third-party tool schemas, workspace scopes, side-effect classes and argument constraints; explicit task grants still required. No external tool is installed or granted automatically.
- Direct, continuation and Lead submission receipts are idempotent. Workspace creation uses cross-process locks and durable intents; uncertain outcomes fail closed. Lead lease admission and delivery are one native operation.
- Added batch start, paged task list and self/tree cancellation (15 MCP tools). ResultStore keeps bounded per-turn visible results with revision-checked pagination. Partial text survives empty failed attempts.
- Shared RemoteMux connections and coalesced concurrent read requests; no claims of full incremental subscriptions or standard MCP Tasks support.
- Windows background launch hardening now covers spawn, fork, exec, execFile, synchronous overloads and promisified calls; caller Node options are restored rather than deleted wholesale. Visual acceptance still needs a user-host trial.
- Added Agent Plugins 1.0 portable manifests alongside the Windows compatibility configuration. Updated delegation Skill, architecture and usage documentation. Existing runtime, sessions and plugin cache are not migrated.
- A separate 0.4.1-alpha.3 desktop candidate can be built without deleting 0.4.0. Real-host/real-model trials, third-party integrations, clean-install recovery and public release audit remain acceptance gates.

# 0.3.1-alpha.2 — durable delegation preview (2026-10-18)

- Runtime management is inside the plugin; explicit `runtime-start` provisions an authenticated background runtime without Electron. No auto-install, no automatic process replacement.
- Native single-writer task records retain original tasks, policy, dispatch state, budget reservations and finalization receipts across restart. Unknown in-flight outcomes are not blindly replayed.
- Shared model-step/output/tool/child admission budgets cover descendants and conclusion passes. Continuation cannot implicitly enlarge total limits. These are not total-input or monetary caps.
- Unknown tools are denied. An explicit `allowed_tools` list narrows known capabilities in request schemas and execution guards.
- Empty max-token results have a once-per-turn, bounded, no-tool conclusion pass owned by the runtime; status is read-only. Partial text and original termination reasons are preserved.
- Queued/failed new turns cannot reuse old successful answers. New Direct requests accept a durable idempotency key. Lead/continuation idempotency is not yet complete.
- Added `deepseek_tasks_wait` and `deepseek_task_result` (12 tools total), strict input validation, protocol negotiation, ping, cancellation of waits and tool annotations. Not full MCP conformance or the standard Tasks protocol.
- MCP and desktop share result/policy presentation. Child cards read their own effective policy; missing usage is not displayed as zero, and unloaded results are not guessed successful.
- Added architecture, restart, budget, finalization, transport and independent-runtime tests. Production models, other hosts and a new packaged EXE were not exercised in this release.

Preview only: third-party capability registration, hard input/cost limits, cross-host full task idempotency, full artifact storage and performance/clean-install certification remain release gates. Research workflows stay optional.

# 0.3.1-alpha.1 — packaging foundation

- Native Cordis bridge now lives in `native/index.mjs` inside the plugin. The desktop's old path is a re-export, not a second implementation.
- Added a Node package whitelist, a read-only `doctor`, native overlay output, and MCP configuration output for Codex / Claude Code / OpenCode v1.
- Windows configurations keep the existing no-console launcher; non-Windows configuration uses Node. Non-Windows runtime behavior and other host applications are **not yet end-to-end certified**.
- MCP server identity and plugin manifest use the same package version.
- No model/prompt/policy changes in this foundation release; no automatic installation, host configuration edits, runtime restart or session migration.

This preview still requires an already provisioned compatible local DSH runtime. The desktop provisions one; independent native overlay loading does not yet provision its authenticated discovery file. `patch` is for integrators, not a one-command standalone runtime installer.

Private preview only. Public release requires a project license decision, branding/provenance review, secret/history audit and the security/durability gates described in the repository refactor plan. `private: true` intentionally prevents accidental npm publication. A local archive is not a public release or a claim of full MCP conformance.
# 0.3.1-rc.13 — 社区桌面宿主接入

- 从宿主公开 Profile 上下文解析实际 DSH 版本、入口及数据目录，原生插件可登记供 Codex 使用的连接。
- 连接登记复用进程身份和启动租约，拒绝覆盖仍存活或身份不明的后台；旧启动器不会重建由社区桌面管理的后台。
- MCP 自带 MIT 许可的 ws 运行库，避免借用宿主内部依赖；包含 ASAR 入口识别，但官方桌面实机验收仍待完成。
- AnywhereLabs v2.0.18 要求开启仅本机浏览器访问，保留原生认证。未修改桌面包或模型权限。
- 新增原版社区 EXE 隔离恢复验收：三个子任务完成后中断主 Lead、重启并继续同一 Lead 汇总，检查子任务、文件、历史和累计预算保留；使用本机模型存根。
- 原生访问冲突 0xC0000005 尚无根因消除证据；本版本不宣称已解决该崩溃。

