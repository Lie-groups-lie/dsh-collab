# Collab Clients

External host adapters for one DSH Collab Runtime. No task database or model executor is bundled.

Download the prebuilt Clients TGZ from the project's Release assets and extract it to a permanent folder. No build or compilation is required. The archive contains self-contained `hosts/codex` and `hosts/claude` directories and local marketplace catalogs. The bundled `GUIDE.zh-CN.md` explains installation and removal. The runtime must advertise `localControlApi: 2`; old clients remain compatible with the runtime's legacy endpoints.

Windows requires Node.js >=22.19 on PATH, or `DSH_MCP_NODE` pointing to Node. The bundled GUI-subsystem launcher suppresses console windows. `DSH_DESKTOP_RUNTIME_FILE` optionally selects the exact local discovery record. Never publish that file: it contains a per-generation local credential.

Codex: register the extracted package with `codex plugin marketplace add <extracted-package>`, then install `dsh-codex-collab@dsh-collab-clients`. Claude Code: use `/plugin marketplace add <extracted-package>` and `/plugin install dsh-collab@dsh-collab-clients`. This does not configure model credentials or run a paid prompt. Inspect the host's MCP connections, then call `deepseek_runtime_status`. Validation and actual model-driven acceptance are reported separately.

The packaged Windows launchers are not macOS/Linux binaries. For other systems, configure the same `mcp/server.mjs` with a trusted `node` executable through the host's local MCP configuration; those platforms require separate acceptance.

MCP progress notifications forward bounded DSH snapshots. The client does not claim experimental MCP task/channel support or wake closed chats. Cancelling a call or closing the host releases its observer while accepted DSH work continues.

`deepseek_task_tree` returns a readable indented task hierarchy in MCP text, plus unchanged IDs, edges, receipts and provenance in `structuredContent`. Both host adapters use this presentation. It does not register DSH tasks as native Codex or Claude subagents, or install a native host chart UI. The collapsible visual tree and policy/schedule panels live in the DSH collaboration center. Client loading, MCP text, DSH browser UI, and paid model-driven research are separate acceptance levels.
