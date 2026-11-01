# ws runtime dependency

Upstream: https://github.com/websockets/ws
Version: 8.22.0. License: MIT; see LICENSE.

The published JavaScript runtime files are included without changes. Optional
native accelerators are not shipped. This makes the Codex MCP distribution
self-contained for WebSocket observation, including Electron hosts whose DSH
dependencies are inside an ASAR archive. The desktop's dependency directory is
not used as a transport library search path.
