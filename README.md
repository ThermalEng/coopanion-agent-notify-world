<!-- Owner: index.ts, webui.ts, hook.mjs, hook-runtime.ts, coopanion-agent-launch.sh, coopanion-agent-launch.ps1 -->

# Coding Agent Notify World

ThermalEng 维护的第三方 Coopanion World 扩展，非 Pal AI Lab 官方扩展。运行时发现由 `hook-runtime.ts` 和两个系统启动脚本负责，`hook.mjs` 是共用发送器。无运行时 npm 依赖，不依赖 Petdex、agent-notify 或其他插件。

## 使用

1. 已发布版本可在 Coopanion 的「World 扩展」中填写 `cortico-world-coding-agent-notify` 安装并启用；市场同步后也可搜索。开发版先构建，再选择本地目录安装。
2. 打开 World 配置页，分别点击对应 Agent 的「安装 hook」和「测试」。安装 World 本身不会修改 Agent 配置。
3. 重启对应 Agent。Codex 如提示信任审核，在 `/hooks` 中确认。

| Agent | 原生接入 |
| --- | --- |
| Codex | 用户目录 `hooks.json` 的 `Stop`，用 `codex features enable hooks` 开启功能；最多 5 秒同步发送 |
| Claude Code | 用户目录 `settings.json` 的 `Stop`；最多 5 秒同步发送，兼容交互会话和单次 CLI |
| OpenCode | 用户 `plugins/` 目录中的本地插件；V2 监听 `session.execution.succeeded`，V1 ≥ 1.18.29 使用 `session.idle` |
| Muse Code | `$XDG_CONFIG_HOME/muse/settings.json`（默认 `~/.config/muse/settings.json`）的原生 `Stop`，直接转交 `last_assistant_message` |
| agy（Antigravity CLI） | `~/.gemini/config/hooks.json` 的具名 `Stop`；仅在成功且完全空闲时，从 `transcriptPath` 流式提取当前轮最后一条模型回复 |
| DSH | `dsh plugin --profile <web/headless> add link:…` 安装本地 Cordis 插件，监听 `session/event` 和 `agent/turn-stopping` |
| WorkBuddy | 用户目录 `.workbuddy/settings.json` 的原生 `Stop`；最多 5 秒同步发送，直接转交 `last_assistant_message` |

Codex、Claude、Muse、agy、WorkBuddy 的命令型 hook 共用运行时发现器，在 Agent 实际执行环境中寻找并验证可调用的 Node.js 22+，可复用桌面应用自带的独立 Node，无需把它链接到系统目录。OpenCode、DSH 正常回调继续直接使用自身运行时。Codex、DSH 的安装分别需要 `codex`、`dsh` CLI。生成的 Agent 插件只是本扩展的入口，不会安装第三方插件。

World 运行时开启带令牌的 `127.0.0.1` 临时接口；hook 将最终报告发来，由 Coopanion 当前连接的模型总结，再使用其内置桌宠能力通知。因此需要 Coopanion 正在运行并已连接模型，模型调用会产生正常用量。**任务结论会进入 Coopanion 当前配置的模型上下文和事件历史**。agy 在本机读取原生 hook 指定的会话日志，但只提取当前轮最后一条已完成的模型正文，不转交日志、用户输入或思考内容。通知只转交最终回复／任务结论及项目路径、会话标识，不转交完整对话，不采集屏幕截图、麦克风音频或前台窗口信息。结论本身仍可能包含项目信息，请按所用模型服务的数据政策使用。

「测试」会在临时空目录调用对应 Agent CLI，用当前模型完成一个只回复随机标识的最小任务（会产生正常模型用量，不开启权限绕过），然后等待该 Agent 的原生 hook 将相同标识交回 Coopanion；命令成功但没有回报仍显示失败。找不到 CLI 时才退回通知发送测试，明确提示“PATH 未检测到对应命令，本次仅测试通知发送，请手动测试 Agent 完成通知”。页面确认的是回报已进入 Coopanion，桌宠是否实际播报仍请用户确认。不提供离线队列；Coopanion 关闭时通知跳过，不影响 Agent 完成任务。重新点击安装不会重复添加 hook。部分 Agent（如 Codex）安装或更新 hook 后，需要重新打开 Agent 并授权 hook，再进行测试。DSH 的安装会同时注册所选 profile（默认 web）和 headless profile；此前仅安装 web hook 的用户需重新点击安装，CLI 测试使用 headless 自身的模型配置。

默认生成目录：`~/.coopanion/agent-hooks`。可通过 `COOPANION_AGENT_HOOK_HOME` 更改；DSH 支持 `COOPANION_DSH_PROFILE`、`DSH_HOME`。也尊重 Agent 自带的 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`WORKBUDDY_CONFIG_DIR` 和 `XDG_CONFIG_HOME`。使用多个配置时，应让 Coopanion 启动环境与对应 Agent 一致。

Codex 的 TOML 配置由自身 CLI 修改。已有 JSON 设置保留其他键；无效 JSON 会报错，不会覆盖。

七个 Agent 均不需要手动填写可执行文件路径。调用 CLI 时，Linux/macOS 使用用户的交互式登录 shell 查找命令，Windows 使用 PowerShell `Get-Command` 查找，兼容 npm 的 `.cmd` 入口。安装命令型 hook 时可从该环境保存一个 Node 候选路径；找不到宿主 Node 也可安装。

运行时发现使用 Hook 当时的环境变量（例如 `NODE_BINARY`、`npm_node_execpath`）、可识别的随包独立 Node、PATH、版本管理器入口和安装时的候选路径。WorkBuddy 的受管版本目录由独立适配规则支持；Windows 同时检查应用注册路径附近的独立运行时。所有候选都先验证版本和运行能力；宿主路径在容器、WSL 或更新后失效时会跳过，多个 PATH Node 中第一个不兼容时继续查找。探测与真实发送保留同一份 stdin，限制探测耗时，发送一旦启动不再重试其他运行时。

外部 Node 不可调用的 Electron 内嵌引擎不作为独立运行时使用，Coopanion 自带的 Electron Node 包装器也被排除。若完全没有可调用的兼容 Node，hook 会报出运行时发现错误；插件不自动安装程序。通知发送测试复用同一发现器。特殊部署可通过 `COOPANION_HOOK_NODE` 指向命名为 `node` / `node.exe` 的独立运行时，这属于可选覆盖。

升级后对已安装的命令型 Agent 重新点击「安装 hook」，即可替换旧绝对 Node 命令；其他 hook 和 Agent 设置保留。配置页的「已安装」表示配置已注册，具体 Agent 的环境和网络可用性仍由原生回调测试确认。

设置页分为“Hook 安装与测试”和“通知总结提示词”。提示词用于指导 Coopanion 总结任务结论，保存后的部署覆盖由框架自动读取。未列出的 Agent 可到 [GitHub](https://github.com/ThermalEng/coopanion-agent-notify-world) 提交 PR 或 Issue，作者会尽快处理。

## Windows

面向 Windows 原生运行的 Agent；WSL 中的 Agent 按 Linux 环境部署，不混用两侧的 hook 路径。默认 hook 目录为 `%USERPROFILE%\.coopanion\agent-hooks`，Agent 配置路径仍尊重上述环境变量。

- 安装 Codex、DSH hook 时，通过 Windows PowerShell 调用原生 CLI，兼容 npm 的 `.cmd` 入口和带空格、中文的路径。
- Claude Code 使用原生 `command` + `args` 形式启动运行时发现器；需使用支持该形式的版本。
- Codex 使用 `commandWindows`，通过编码后的 PowerShell 命令转交 UTF-8 报告；需使用支持该字段的版本。
- OpenCode、DSH 仍直接导入共用发送模块；找不到测试 CLI 时的通知发送测试复用运行时发现器，不弹出额外控制台窗口。

命令型 hook 的 Windows 启动器由系统自带的 `powershell.exe` 执行；CLI 测试还需要对应命令。运行时可来自 Agent 自带 Node、PATH 或其他有效候选，不要求另装一份系统 Node。Windows 分支尚未实机验证；不能将 Linux 测试通过视为 Windows 实测通过。

## 开发

`cortico`、`jsdom` 等仅为开发依赖，不随本扩展安装到运行环境。

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

npm 包名为 `cortico-world-coding-agent-notify`。`pnpm pack` 构建并生成本地安装包；市场通过 npm 收录。

Muse 与 agy 的 hook 配置依据各自官方文档：
- Muse：https://meta-models.github.io/muse-code-sdk/next/guides/extend/hooks/
- Muse 事件字段：https://meta-models.github.io/muse-code-sdk/next/guides/plugins/reference/hook-events/
- agy：https://antigravity.google/docs/hooks?tab=cli

运行时实现依据：
- WorkBuddy：随包代码的 `resolveManagedBinariesDir` 与 vendor Node 布局（`binaries/node/versions/<version>/node.exe` 或 `bin/node`）。
- Electron 运行模式和 fuse：https://www.electronjs.org/docs/latest/tutorial/fuses
- Muse 的 hook 环境变量和字段约定：https://meta-models.github.io/muse-code-sdk/next/guides/extend/hooks/
- nvm / fnm / Volta 的运行时环境：https://github.com/nvm-sh/nvm 、https://github.com/Schniz/fnm 、https://docs.volta.sh/reference/setup
