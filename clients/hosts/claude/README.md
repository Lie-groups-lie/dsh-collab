# DSH Collab for Claude Code

Delegate work to DeepSeek Harness (DSH), continue project Leads, and inspect task progress, results, policies and usage from Claude Code. The DSH collaboration center displays the task tree and execution history.

## Install

For the Windows GitHub catalog, run in a Claude Code session:

```text
/plugin marketplace add Lie-groups-lie/dsh-collab
/plugin install dsh-collab@dsh-collab-clients
```

Choose the user scope for a personal installation. Run `/mcp` to inspect the `dsh_collab` connection, then ask Claude to call `deepseek_runtime_status` without creating a task.

For macOS/Linux, extract the `clients-posix` archive to a permanent directory, add its absolute `package` directory with `/plugin marketplace add /absolute/path/package`, then use the same install command. This package starts `node` directly; the Windows catalog uses an `.exe` launcher. Native macOS/Linux acceptance is still pending.

## Connect to DSH

Install `dsh-codex-collab@0.4.0-rc.2` through DSH's plugin manager and configure its local connection record. This client connects to that existing backend; it does not install or start DSH.

The packaged launcher targets Windows x64 and requires Node.js 22.19 or later on PATH, or `DSH_MCP_NODE` pointing to a trusted Node executable. By default, the client reads `%APPDATA%/DeepSeek Harness/runtime.json`. Set `DSH_DESKTOP_RUNTIME_FILE` in Claude Code's environment when using a different location. The connection record contains credentials; do not publish it.

The POSIX package requires Node.js 22.19 or later on Claude Code's PATH. Its default record is `~/Library/Application Support/DeepSeek Harness/runtime.json` on macOS, and `${XDG_CONFIG_HOME:-$HOME/.config}/DeepSeek Harness/runtime.json` on Linux. Configure DSH with the expanded absolute path; YAML does not expand shell variables. `DSH_MCP_NODE` is specific to the Windows launcher.

Claude Code running in WSL, a container or on another machine cannot assume access to the Windows connection record or its loopback backend. Those environments need separate connection configuration and validation.

## Use

- Start bounded work with `deepseek_flash` or continue a project with `deepseek_lead`.
- Inspect progress and results with the available status tools; use `deepseek_task_tree` for relationships and receipts.
- Configure permissions for the actual task. Installing this client does not grant unrestricted tool access.

DSH tasks are not native Claude Code subagents. Closing Claude Code stops its observation, while accepted DSH work can continue in the backend. The unfinished research extension is not included.

[English setup guide](https://github.com/Lie-groups-lie/dsh-collab/blob/main/README.en.md) · [中文安装说明](https://github.com/Lie-groups-lie/dsh-collab/blob/main/README.md)

## License

MIT. The icon uses the same original branching mark as the Codex adapter.
