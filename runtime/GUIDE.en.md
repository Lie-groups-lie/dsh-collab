# DSH Collab: Download, Install and Use

[简体中文](GUIDE.zh-CN.md) · **English**

Send work from Codex or Claude Code (CC) to your local DeepSeek Harness, then check progress and read the results. For longer projects, keep a Lead and continue it later.

Collab is a third-party plugin, not affiliated with DeepSeek, OpenAI or Anthropic. Tasks run in your existing DSH installation. The Research extension is still in development and is not included in this download.

**dsh-collab 0.4.0-rc.2 · Windows x64 · MIT**. The project code and original branching icon use the MIT License. The download includes the license text and the upstream copyright and license for the bundled `ws` dependency.

## Features

| Feature | Behavior and limits |
|---|---|
| Independent tasks | Delegate to DeepSeek Flash from Codex/CC and receive a handle for subsequent observation |
| Persistent Leads | Coordinate DSH child tasks in one project context and continue the same Lead later |
| Progress and results | Read status, wait for completion, and retrieve visible results and traces in pages |
| Task tree | Inspect parent/child relationships, submissions and settlement receipts; DSH provides a collapsible tree |
| Permission controls | Set read/write access, terminal access, child models and allowed tools without bypassing native authorization |
| Usage accounting | Inspect tokens, cache hits, shared budgets and stop reasons; missing cost data is not reported as zero |
| Interruption recovery | Inspect and continue original work while retaining completed children and usage; uncertain writes are not automatically replayed |
| Scheduling and reports | Continue an existing Lead within its authorized time window and read durable reports and delivery outcomes |
| Stop and archive | Explicitly cancel work or archive quiescent tasks; archiving does not delete history |

The DSH collaboration center displays results, activity, traces, relationships, usage and policy. Activity uses native Markdown and tool-call styling. Viewing records does not send messages or continue work. Codex/CC read the same data through MCP; the plugin does not add a native host-specific agent graph page.

## Which download do I need?

The repository is [lie-groups-lie/dsh-collab](https://github.com/lie-groups-lie/dsh-collab). Once published, download the prebuilt product from [Releases](https://github.com/lie-groups-lie/dsh-collab/releases). Open the specific release for a prerelease; do not rely on a latest link.

| File | Required? | Installation destination |
|---|---|---|
| `dsh-collab-runtime-0.4.0-rc.2.tgz` | Required | DSH-side plugin, installed in an existing DSH profile |
| `dsh-collab-clients-0.4.0-rc.2.tgz` | Required | Connection plugin; choose the Codex or CC entry |
| `dsh-collab-windows-0.4.0-rc.2.zip` | Convenient combined download | Both TGZ files, bilingual guides, version manifest and checksums |

Packages contain runtime files and precompiled Windows launchers. **You do not need to clone the source, run npm build or compile C#.** The `.mjs`, `.cjs`, `.js` files and Skills are execution components, not development scaffolding. The public repository includes readable execution code and Windows launcher source, without local experiments, session stores or development captures.

Both packages are version 0.4.0-rc.2; see `PRODUCT.json`. **Runtime means the DSH-side plugin** that manages execution, status and result access. It is not another DSH installation or a replacement desktop. Clients connects Codex/CC to it.

Use PowerShell's `Get-FileHash -Algorithm SHA256 <file-path>` to compare downloads against the same Release's `SHA256SUMS`. Matching hashes establish file consistency, not code signing or security certification.

## Prerequisites

- Windows x64. The current interface baseline is DSH **0.2.1-rc.2**; the host matrix below defines the tested scope. Other DSH versions and operating systems are not implied to be compatible.
- Node.js 22.19 or later, available on the host process's PATH. Alternatively, set `DSH_MCP_NODE` to a trusted Node executable.
- An installed, working Codex or Claude Code. CC connection validation used version 2.1.310, not every available version.
- Your own DeepSeek model account configured in DSH. Model requests are billed to that account; packages contain no API keys, accounts or credits.
- Your own project directory. Multiple clients can share one DSH Runtime and task history. Do not start a second backend against the same data directory.

The product does not bundle a third-party desktop, Node.js, Codex or Claude Code. It is an installable plugin product, not a standalone application containing every prerequisite.

## 1. Install the DSH-side plugin (Runtime)

### Official DeepSeek Harness Desktop

Use the plugin manager in official Desktop **0.2.1-rc.2** to install the Runtime TGZ into its managed `desktop` profile, then complete Connection discovery below. The collaboration center runs inside the official `dsh-app://` window. Codex/CC use a separate authenticated loopback interface; external browser access is not required.

If using the CLI, first use the official desktop's **Manage dsh Command** entry to verify that you are running its bundled command. Do not manage its profile with a separate npm-installed DSH. This is a pinned compatibility baseline, not a claim that the latest prerelease has passed testing.

### Community DSH Desktop

Use the plugin installation entry in Anywhere Labs **DSH Desktop 2.0.18** to install the Runtime TGZ into the profile you use, then configure discovery below. Collab does not require changes to window mode or the browser-access toggle. This does not refer to other projects with similar names.

### DSH Web

With the DSH CLI available, install into your actual Web profile:

```powershell
dsh plugin --profile web add C:/Downloads/dsh-collab-runtime-0.4.0-rc.2.tgz
```

Do not simply replace `web` with the community desktop's `desktop` profile. That profile is managed by the desktop's own process.

### Connection discovery (required)

**Installing the plugin does not register an external connection.** The native plugin publishes a connection record only when `runtimeFile` is configured, avoiding accidental ownership conflicts between hosts. All three hosts need this step.

Merge the following into the active profile's `cordis.patch.yml`; do not overwrite the whole file. Replace the example with a writable absolute path:

```yaml
- id: dsh-collab
  config:
    runtimeFile: "C:/DSH-Connection/runtime.json"
```

Set `DSH_DESKTOP_RUNTIME_FILE` to the same location in the Codex/CC process environment. Alternatively, configure the expanded absolute path of `%APPDATA%/DeepSeek Harness/runtime.json`; Clients use that location by default, so no extra environment variable is needed. YAML does not expand `%APPDATA%` itself.

The default desktop patch is `%USERPROFILE%/.dsh/profiles/desktop/cordis.patch.yml`; Web usually uses `profiles/web/cordis.patch.yml`. A custom `DSH_HOME` changes that root. Never run two backends against the same profile or connection record.

This record contains temporary authentication information. Never upload it or paste it into a public issue. Existing working installations can retain their current discovery configuration.

Before installation or upgrades, let executing work finish, then restart DSH normally if required by the host. An empty task list in a window alone does not establish that the backend is idle.

## 2. Connect Codex

Extract the Clients TGZ to a permanent directory such as `C:/Packages/clients/`. It should contain `package/`. Keep that directory because the plugin marketplace references it.

In a terminal with Codex CLI installed, run:

```powershell
codex plugin marketplace add C:/Packages/clients/package
codex plugin add dsh-codex-collab@dsh-collab-clients
```

Then ask Codex:

> Check the DSH Collab connection using only the runtime status tool. Do not create a task.

`deepseek_runtime_status` should be callable and report a passing compatibility check. The core plugin exposes 27 tools, including `deepseek_flash`, `deepseek_lead` and `deepseek_task_tree`. A visible Skill alone does not establish an MCP connection.

If an existing chat retains an old tool list, reopen the host normally once there is no Codex execution that needs preserving. Do not manually start another MCP server to bypass the plugin.

## 3. Connect Claude Code (CC)

Using the same extracted Clients directory, run these commands inside CC:

```text
/plugin marketplace add C:/Packages/clients/package
/plugin install dsh-collab@dsh-collab-clients
```

Inspect the connection with `/mcp`, then ask CC to call `deepseek_runtime_status`. CC and Codex share the DSH Runtime, but should coordinate submission ownership for the same Lead rather than both starting a new turn simultaneously.

This supports local Claude Code, not access to localhost from a cloud web chat. The packages include both host manifests and precompiled launchers; users do not need to rewrite executable paths in the manifests.

## 4. Your first task

Ask Codex or CC something like the following, replacing the workspace path:

> Use DSH Flash to review this function read-only in C:/Projects/example and identify the single most important issue. Disable terminal access and tool calls. Allow at most two model requests, 4096 cumulative output tokens and 120 seconds. Return the task handle first, then wait and read the result.

A small explicit budget is recommended for the first check. Ordinary tasks do not have small plugin-imposed cumulative token or tool-call caps by default. Provider per-request limits, explicit budgets and stop conditions still apply, and continued work may continue incurring charges.

For longer projects, request a persistent Lead and specify child models, tools, permissions, budgets and deadlines. Continue with the original Lead ID to avoid duplicate tasks. If results are empty or termination is unclear, inspect the actual state and visible partial output. “Settled” does not mean “successful.”

Stopping observation, closing an MCP connection and cancelling work are different operations. Use the plugin's cancellation interface to stop work; archive only quiescent tasks. Deleting session files or locks is not a recovery procedure.

## 5. Using other DSH plugins

You can continue installing and using other DSH plugins alongside Collab. DSH still manages them; Collab does not replace your model providers or the entire plugin configuration.

In an ordinary DSH conversation, plugin access depends on the conversation's preset, configuration and permissions. For a task delegated by Codex/CC to use another plugin:

1. The plugin must expose a DSH tool mounted in the target task. A plugin that only adds UI or settings may have no callable tool.
2. Register the third-party tool's actual parameter schema, scope and read/write effects with Collab.
3. Allow it in the task's `allowed_tools`. A Lead and its children have separate permissions.

Ask Codex/CC to call `deepseek_capabilities` to inspect availability, effective permission and any denial reason. Even an admitted tool may require its own account or online service. Plugins installed only in Codex/CC do not automatically become DSH tools.

The Research extension will be distributed separately once ready. Collab's existing Lead and multi-task delegation features do not depend on Research.

## Upgrade, uninstall and preserve data

- Before upgrading, inspect native running tasks, unresolved submissions and pending notices. Retain the previous package for rollback. The DSH-side plugin and connection plugin should follow the same release manifest.
- Update through the original host plugin entry. Do not register independent packages and a development suite as duplicate MCP servers with the same name.
- Uninstalling a Codex/CC plugin removes its host entry. DSH continues to own tasks and history.
- To stop using Collab entirely, stop or settle work, then uninstall Collab from the DSH profile. Do not delete the DSH data directory; data deletion is a separate action.
- Do not automatically downgrade or rewrite task stores. If native versions are incompatible, read the release notes before choosing a rollback.

## Troubleshooting

| Symptom | What to check first |
|---|---|
| Skill visible, DSH tools missing | Plugin enabled state, MCP connection and whether the chat still has an old tool list |
| fetch failed / backend exited | DSH backend status and connection record; do not resubmit possibly accepted work |
| 403 / authentication failure | Whether client and backend use the same discovery file; do not disclose its credentials |
| Runtime contract mismatch | Actual versus expected versions; use a matching release suite |
| unknown after interruption | Original receipts and tool side effects, then the supported recovery interface; do not start by abandoning or rerunning completed children |
| Scheduled work did not run | Creation, delivery, admission, execution state and the authorized time window separately |
| No proactive reply after closing a chat | Durable reports remain readable, but waking closed host chats requires host integration and is not fully validated |

When reporting an issue, provide versions, error codes, sanitized steps and only necessary task identifiers. Do not upload full runtime.json files, API keys, session stores, memory dumps or personal workspaces.

## Validation status

Host acceptance uses isolated profiles and workspaces with a loopback mock provider, without production model charges. The scenario completes three children, interrupts their Lead, restarts the fixture and resumes synthesis in that same Lead. It checks child identities, files, history, cumulative usage and duplicate receipts, plus actual results, activity, task tree and policies in the host window.

| Host | Pinned baseline | Integration |
|---|---|---|
| Official Desktop | 0.2.1-rc.2, Windows x64 | Native profile; collaboration center inside `dsh-app://` |
| Anywhere Labs community Desktop | 2.0.18, bundled DSH 0.2.1-rc.2 | Native profile; existing window and browser-access settings retained |
| Native Web | DSH 0.2.1-rc.2, Windows x64 | Web profile; collaboration center in the browser |

Other checks cover package hashes and independent imports, Codex/CC MCP initialization and tool lists, permissions and notifications. They do not establish long-running stability with real models. Fresh community 2.0.18 profiles can encounter an intermittent Windows directory-rename `EPERM` before plugin loading. Passing in an initialized installation does not resolve that upstream cold-start issue; modified third-party desktops are not included in the download.

Outstanding checks include installation on a clean Windows machine, other desktops and operating systems, and long-running use with real models. The historical 0xC0000005 crash still needs long-term regression coverage.
