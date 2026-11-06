# DSH Collab

[中文安装与使用](GUIDE.zh-CN.md) · [English guide](GUIDE.en.md)

Continue DeepSeek Harness tasks from Codex and Claude Code, with persistent Leads, task trees, policy and usage inspection, and supported interruption recovery.

Install this DSH-side package through your desktop plugin manager as `dsh-codex-collab@0.4.0-rc.4`, or in DSH Web:

```sh
dsh plugin --profile web add dsh-codex-collab@0.4.0-rc.4
```

Then download the matching Clients asset from [GitHub Releases](https://github.com/lie-groups-lie/dsh-collab/releases/tag/v0.4.0-rc.4), extract it to a permanent directory and run `node setup.mjs install codex` or `node setup.mjs install claude` from its package folder. The preview explains connection discovery; add `--apply` for host installation. Verify with `node setup.mjs doctor --live`, then the runtime status tool in the host.

Requires compatible DSH 0.2.1-rc.2 and Node 22.19+. The npm package name remains dsh-codex-collab for profile compatibility. It contains no user sessions, model credentials, desktop executable or Research extension. The explicit hash-gated native repair utility is never run automatically.
