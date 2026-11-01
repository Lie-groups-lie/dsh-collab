# DSH Collab：让codex和cloude code 操控dsh

**简体中文** · [English](README.en.md)

在 Codex 或 Claude Code（CC）里把任务交给 DeepSeek Harness，再查看进度、读取结果。较长的项目可以保留一个 Lead，之后接着做。

Collab 是第三方插件，与 DeepSeek、OpenAI、Anthropic 无隶属关系。任务在你已有的 DSH 中运行。数学研究扩展 Research 还在开发，本次下载不包含它。

**dsh-collab 0.4.0-rc.2 · Windows x64 · MIT**。项目代码和原创分支图标采用 MIT 许可证。下载包附有完整许可文本，随包的 `ws` 另附上游版权和许可证。

## 可以做什么

| 功能 | 用法与边界 |
|---|---|
| 独立子任务 | 由 Codex/CC 调用 DeepSeek Flash，返回可继续读取的任务句柄 |
| 持久 Lead | 在同一项目上下文中协调 DSH 子任务，后续继续同一个 Lead |
| 进度与结果 | 查询状态、等待、分段读取完整可见结果和执行轨迹 |
| 任务树 | 查看父子关系、每轮提交及结算回执；DSH 中提供可折叠树 |
| 权限控制 | 指定只读或写入、终端开关、子模型及允许工具；不能绕过原生授权 |
| 用量管理 | 显示 token、缓存命中、共享预算与终止原因；缺失费用不显示为零 |
| 中断恢复 | 核验原任务并续接，保留已完成子任务与费用；不自动重放未知写操作 |
| 定时与汇报 | 在有效授权窗口内推进已有 Lead，查询持久汇报及投递结果 |
| 归档和停止 | 主动停止任务，或归档已静止的任务；归档不等于删除历史 |

DSH 协作中心提供结果、过程、轨迹、关系、用量和策略。过程沿用原生 Markdown 与工具调用样式，查看内容默认不发送消息、不续跑任务。Codex/CC 通过 MCP 读取同一份数据，不会自动增加宿主专属 Agent 图表页面。

## 下载哪个包

仓库为 [lie-groups-lie/dsh-collab](https://github.com/lie-groups-lie/dsh-collab)。发布后从 [Releases](https://github.com/lie-groups-lie/dsh-collab/releases) 下载预构建产品；候选版本请打开对应版本，不依赖 latest 链接。

| 文件 | 是否需要 | 安装位置 |
|---|---|---|
| `dsh-collab-runtime-0.4.0-rc.2.tgz` | 必需 | DSH 端插件，装进已有 DSH profile |
| `dsh-collab-clients-0.4.0-rc.2.tgz` | 必需 | 连接插件，选择 Codex 或 CC 入口安装 |
| `dsh-collab-windows-0.4.0-rc.2.zip` | 方便一次下载 | 含上述两个 TGZ、中英文说明、版本清单和校验和 |

产品包包含运行文件和预编译 Windows 启动器。**用户无需克隆源码、运行 npm build 或编译 C#。** `.mjs`、`.cjs`、`.js` 和 Skill 是实际执行组件，不是开发脚手架。公开仓库包含可阅读的执行源码和 Windows 启动器源码，不携带本地实验、会话库或开发现场。

两个包的版本均为 0.4.0-rc.2，以 `PRODUCT.json` 为准。文件名中的 **Runtime 就是 DSH 端插件**：负责执行管理、状态和结果接口，不是另一个 DSH，也不是需要替换桌面的新运行环境。Clients 是连接 Codex/CC 的一端。

下载后可在 PowerShell 使用 `Get-FileHash -Algorithm SHA256 <文件路径>`，与同一 Release 的 `SHA256SUMS` 比较。哈希用于检查下载是否一致，不等于代码签名或安全认证。

## 使用前提

- Windows x64。当前接口基线是 DSH **0.2.1-rc.2**；官方桌面、社区桌面和 Web 的具体范围见下表。不要据此推定其他 DSH 版本或操作系统兼容。
- Node.js 22.19 或更高版本，在宿主进程的 PATH 中可用；也可将 `DSH_MCP_NODE` 指向可信的 Node 可执行文件。
- 已安装并能正常运行的 Codex 或 Claude Code。CC 入口连接验收使用 2.1.310；没有因此证明所有版本均兼容。
- 在 DSH 自行配置 DeepSeek 模型账号。模型调用由该账号计费；产品不包含 API Key、账号或额度。
- 选择你自己的项目目录。多个客户端连接同一个 DSH Runtime，共用同一份任务记录；不要为同一数据目录再启动第二个后台。

产品包不会捆绑第三方桌面、Node.js、Codex 或 Claude Code。它是可安装的插件产品，不是包含所有前置软件的独立应用。

## 1. 安装 DSH 端插件（Runtime）

### 官方 DeepSeek Harness Desktop

使用官方桌面 **0.2.1-rc.2** 的插件管理入口，将 Runtime TGZ 安装到该桌面管理的 `desktop` profile，然后完成下面的“连接发现”配置。官方窗口使用 `dsh-app://` 页面协议，Collab 的协作中心仍在窗口内显示；Codex/CC 使用独立的本机认证接口，不需要开启外部浏览器访问。

如果需要使用命令行，先在官方桌面的“管理 dsh 命令 / Manage dsh Command”中确认使用的是该桌面自带的命令。不要用另一个 npm 安装的 DSH 去操作官方桌面的 profile。这里验证的是固定版本，不代表最新预发布版已验收。

### 社区 DSH Desktop

使用 Anywhere Labs **DSH Desktop 2.0.18** 的 DSH 插件安装入口，选择 Runtime TGZ，安装到当前使用的 profile，再完成下面的连接配置。窗口模式和“允许浏览器访问”开关无需为 Collab 改动。此处不指其他同名桌面项目。

### DSH Web

在具备 DSH CLI 的环境中，安装到实际使用的 Web profile：

```powershell
dsh plugin --profile web add C:/Downloads/dsh-collab-runtime-0.4.0-rc.2.tgz
```

不要把此命令中的 `web` 直接换成社区桌面的 `desktop`；社区桌面由自身进程管理该 profile。

### 连接发现（必需）

**安装插件不等于已登记外部连接。** 原生插件只有配置了 `runtimeFile`，才会向 Clients 发布连接记录，避免多个桌面抢占同一连接。三种宿主都需要做这一步。

在所用 profile 的 `cordis.patch.yml` 中合并以下配置，不要覆盖整个文件。路径换成你有写权限的绝对路径：

```yaml
- id: dsh-collab
  config:
    runtimeFile: "C:/DSH-Connection/runtime.json"
```

然后在 Codex/CC 进程环境中设置同一个 `DSH_DESKTOP_RUNTIME_FILE`。如果选择 `%APPDATA%/DeepSeek Harness/runtime.json` 作为默认位置，请在 YAML 中填入展开后的完整路径，Clients 就无需额外设置此环境变量；YAML 不会自动展开 `%APPDATA%`。

官方和社区桌面的默认 profile 文件位于 `%USERPROFILE%/.dsh/profiles/desktop/cordis.patch.yml`，Web 通常为 `profiles/web/cordis.patch.yml`；设置过 `DSH_HOME` 时以实际目录为准。不要同时让两个后台写同一个 profile 或同一份连接记录。

连接记录包含临时认证信息，不能上传到 GitHub 或粘贴到公开问题中。已有正常连接的安装保留原来的配置即可。

安装/升级时先让正在执行的任务结束，再按宿主要求正常重启 DSH。不要仅用窗口中未显示任务来判断后台已经空闲。

## 2. 接入 Codex

将 Clients TGZ 解压到例如 `C:/Packages/clients/`，其中应出现 `package/`。保留解包目录，插件 marketplace 会引用它。

在已经安装 Codex CLI 的终端执行：

```powershell
codex plugin marketplace add C:/Packages/clients/package
codex plugin add dsh-codex-collab@dsh-collab-clients
```

在 Codex 中发送：

> 检查 DSH Collab 连接，只调用运行状态检查，不创建任务。

应能调用 `deepseek_runtime_status` 并看到兼容检查通过。核心插件提供 27 个工具，包括 `deepseek_flash`、`deepseek_lead`、`deepseek_task_tree`。只看到 Skill 不代表 MCP 已连接。

若旧聊天仍使用旧工具表，在没有需要保留的 Codex 执行时正常重开宿主；不要另外手动启动 MCP 服务器绕过插件。

## 3. 接入 Claude Code（CC）

使用同一个 Clients 解包目录，在 CC 中执行：

```text
/plugin marketplace add C:/Packages/clients/package
/plugin install dsh-collab@dsh-collab-clients
```

通过 `/mcp` 检查连接，再要求 CC 调用 `deepseek_runtime_status`。CC 和 Codex 使用同一个 DSH Runtime，但仍应协调同一 Lead 的提交权，避免双方同时发起新回合。

这适用于本机 Claude Code，不代表云端网页可以访问你的 localhost。两种客户端的正式清单与预编译启动器都在包内，不需要用户改写配置里的程序路径。

## 4. 第一次使用

向 Codex 或 CC 发送类似请求，并替换工作区路径：

> 使用 DSH Flash，在 C:/Projects/example 只读检查这段函数，指出一个最重要的问题。禁止终端和工具调用；本次最多两次模型请求、累计输出 4096 token，120 秒截止。先返回任务句柄，再等待并读取结果。

首次检查建议主动给小预算。常规任务默认没有插件侧的小额累计 token/工具调用上限，仍受模型单次输出限制、显式任务预算和停止条件约束，可能持续计费。

长项目可请求创建持久 Lead，并明确子 Agent 可用模型、工具、权限、预算与截止时间。续接时提供原 Lead ID，避免重新创建重复任务。查询结果为空或终止状态不明时，先读取真实状态和可见 partial，不把“已结算”当作“成功”。

停止观察、关闭 MCP 连接和取消任务是三件不同的事。停止任务使用插件的取消接口；归档需要任务静止。不要用删会话文件或删锁来解决恢复问题。

## 5. 和其他 DSH 插件一起使用

安装 Collab 后，可以继续安装和使用其他 DSH 插件。它们仍由 DSH 管理；Collab 不会替换模型供应商或整个插件配置。

在普通 DSH 对话中，能用哪些插件取决于该对话的预设、插件配置和权限。让 Codex/CC 委派的任务使用某个插件，则还需要：

1. 该插件向 DSH 提供了工具，并已挂载到目标任务。只有界面或设置页的插件不一定有可调用工具。
2. 在 Collab 中登记第三方工具的真实参数格式、作用范围和读写类型。
3. 在任务的 `allowed_tools` 中允许它；Lead 与子任务的权限分别设置。

可先让 Codex/CC 调用 `deepseek_capabilities`，检查工具是否存在、当前任务能否调用，以及被拒绝的原因。工具被允许后，仍可能需要插件自身的账号或服务在线。仅在 Codex/CC 中安装的插件，不会自动出现在 DSH 中。

Research 数学研究扩展暂不随本次产品分发，后续完成后再单独提供。基础 Collab 的 Lead 和多子任务协作不依赖 Research。

## 升级、卸载与保留数据

- 升级前检查原生运行任务、未结算提交和待处理通知；保留当前包以便回退。DSH 端插件和连接插件使用同一发行版本清单。
- 通过原先的宿主插件入口更新。不要同时将独立包和开发 suite 注册成两套同名 MCP。
- 卸载 Codex/CC 插件，仅移除其宿主入口；DSH 任务和历史仍由 DSH 保存。
- 完全停用时，先停止/结算任务，再从 DSH profile 卸载 Collab。不要删除 DSH 数据目录；删除任务数据属于另一项操作。
- 不自动降级或改写任务库。若新旧原生版本不兼容，先检查发行说明，再决定是否回退。

## 常见问题

| 现象 | 先检查什么 |
|---|---|
| Skill 可见但没有 DSH 工具 | 宿主插件是否启用，MCP 是否连接，当前聊天是否仍使用旧工具表 |
| fetch failed / 后台退出 | DSH 后台状态和连接记录；不要重新提交可能已经受理的任务 |
| 403 / 认证错误 | 客户端与后台是否指向同一发现文件；不要公开里面的认证信息 |
| Runtime contract mismatch | 比对返回的实际版本和期望版本，使用同一发行套件 |
| 中断后状态 unknown | 检查原回执和工具副作用，再用正式恢复接口续接；不先 abandon 或重跑已完成子任务 |
| 定时计划没执行 | 分别检查计划创建、投递、准入、执行状态及授权窗口 |
| 关闭聊天后没主动回复 | 持久汇报可以补读，但自动唤醒关闭聊天依赖宿主接入，尚未完整验收 |

报告问题时只提供版本、错误代码、脱敏步骤与必要的任务标识。不要上传完整 runtime.json、API Key、原始会话库、内存转储或个人工作区。

## 已验证与尚未验证

宿主验收使用独立 profile、测试工作区和本机模拟 provider，不使用生产模型额度。检查同一 Lead 在三个子任务完成后中断、重启、继续汇总；核对原子任务、文件、历史、累计用量和重复提交回执，并检查窗口中的实际结果、过程、任务树和策略。

| 宿主 | 固定基线 | 接入方式 |
|---|---|---|
| 官方 Desktop | 0.2.1-rc.2，Windows x64 | 原生 profile；`dsh-app://` 内的协作中心 |
| Anywhere Labs 社区 Desktop | 2.0.18，内置 DSH 0.2.1-rc.2 | 原生 profile；保留社区窗口及浏览器访问设置 |
| 原生 Web | DSH 0.2.1-rc.2，Windows x64 | Web profile；浏览器内的协作中心 |

另已完成包哈希及独立导入、Codex/CC 的 MCP 初始化与工具列表，以及权限、通知等专项回归。接口验收不等于真实模型长期稳定性保证。社区 2.0.18 的全新 profile 偶发 Windows 目录重命名 `EPERM`，发生在插件加载前；不把已安装环境通过当成冷启动问题已修复，下载包也不包含修改过的第三方桌面。

尚待验证的范围包括全新 Windows 机器安装、其他桌面和系统，以及真实模型的长期运行。历史 0xC0000005 尚待长期回归。

## 从仓库目录安装

下载仓库源码 ZIP 并解压到固定目录后，根目录可作为 DSH bundle 和 Codex/Claude 插件市场。运行 `dsh plugin --profile web add C:/Packages/dsh-collab` 安装 DSH 端；桌面版请使用其插件管理器。Codex 使用 `codex plugin marketplace add C:/Packages/dsh-collab`，Claude Code 使用 `/plugin marketplace add C:/Packages/dsh-collab`，随后按上文安装对应插件。连接发现配置仍然必需。已配置同名市场时更新原来源，不重复注册。

## npm 安装入口

DSH 端已发布为 `dsh-codex-collab@0.4.0-rc.2`，可在桌面“添加插件”的 npm 源中填写这个完整名称。Web profile 使用 `dsh plugin --profile web add dsh-codex-collab@0.4.0-rc.2`。`dsh-collab` 是其他账号的 npm 包，不是本项目。

npm 包只包含 DSH 端服务。Codex 和 Claude Code 各自的连接入口位于 Clients 下载包中，按上文选择安装。二者共享连接代码，但各自运行独立 MCP 进程，连接同一个 DSH 服务；同一 Lead 的推进仍需协调。

### 从本地开发安装迁移到 npm

同一包名从本地 link/path 切换到 npm 时，运行中的宿主可能继续缓存旧模块路径。卸载后安装成功，不代表热加载已经切换。若错误仍引用旧目录，且 npm 安装日志与现有 package.json 正常，先检查任务状态，再完整正常退出 DSH 桌面并重新打开；只刷新页面可能无效。不要删除会话、任务库或锁文件，也不要为消除报错重建旧目录。不要在仍使用旧包的进程退出前清理旧构建目录。

发布前已验证干净安装；2026-11-01 另补测了社区 Desktop 2.0.18 的本地链接安装、正常退出、卸载、npm 重装、重新打开与连接检查，零模型调用。运行中直接换源的无重启热迁移不在通过范围内。
