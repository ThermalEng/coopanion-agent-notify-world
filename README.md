<!-- Owner: index.ts, webui.ts, hook.mjs -->

# Coding Agent Notify World

ThermalEng 维护的第三方 Coopanion World 扩展，非 Pal AI Lab 官方扩展。生产代码只有 `index.ts`、`webui.ts`、`hook.mjs`。无运行时 npm 依赖，不依赖 Petdex、agent-notify 或其他插件。

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

Codex、Claude、Muse、agy、WorkBuddy hook 与配置页的测试需要 `node`（22+）在 PATH 中；Codex、DSH 的安装分别需要 `codex`、`dsh` 在 PATH 中。OpenCode、DSH 插件直接使用自身运行时发送报告。生成的 Agent 插件只是本扩展的入口，不会安装第三方插件。

World 运行时开启带令牌的 `127.0.0.1` 临时接口；hook 将最终报告发来，由 Coopanion 当前连接的模型总结，再使用其内置桌宠能力通知。因此需要 Coopanion 正在运行并已连接模型，模型调用会产生正常用量。**任务结论会进入 Coopanion 当前配置的模型上下文和事件历史**。agy 在本机读取原生 hook 指定的会话日志，但只提取当前轮最后一条已完成的模型正文，不转交日志、用户输入或思考内容。通知只转交最终回复／任务结论及项目路径、会话标识，不转交完整对话，不采集屏幕截图、麦克风音频或前台窗口信息。结论本身仍可能包含项目信息，请按所用模型服务的数据政策使用。

「测试」会在临时空目录调用对应 Agent CLI，用当前模型完成一个只回复随机标识的最小任务（会产生正常模型用量，不开启权限绕过），然后等待该 Agent 的原生 hook 将相同标识交回 Coopanion；命令成功但没有回报仍显示失败。找不到 CLI 时才退回通知发送测试，明确提示“PATH 未检测到对应命令，本次仅测试通知发送，请手动测试 Agent 完成通知”。页面确认的是回报已进入 Coopanion，桌宠是否实际播报仍请用户确认。不提供离线队列；Coopanion 关闭时通知跳过，不影响 Agent 完成任务。重新点击安装不会重复添加 hook。部分 Agent（如 Codex）安装或更新 hook 后，需要重新打开 Agent 并授权 hook，再进行测试。DSH 的安装会同时注册所选 profile（默认 web）和 headless profile；此前仅安装 web hook 的用户需重新点击安装，CLI 测试使用 headless 自身的模型配置。

默认生成目录：`~/.coopanion/agent-hooks`。可通过 `COOPANION_AGENT_HOOK_HOME` 更改；DSH 支持 `COOPANION_DSH_PROFILE`、`DSH_HOME`。也尊重 Agent 自带的 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`WORKBUDDY_CONFIG_DIR` 和 `XDG_CONFIG_HOME`。使用多个配置时，应让 Coopanion 启动环境与对应 Agent 一致。

Codex 的 TOML 配置由自身 CLI 修改。已有 JSON 设置保留其他键；无效 JSON 会报错，不会覆盖。

七个 Agent 均不需要手动填写可执行文件路径。需要调用 CLI 时，Linux/macOS 使用用户的交互式登录 shell 查找命令，Windows 使用 PowerShell `Get-Command` 查找，兼容 npm 的 `.cmd` 入口。Codex、DSH 的安装通过各自 CLI 完成；Claude Code、Muse Code、agy、WorkBuddy、OpenCode 直接使用原生配置或插件目录，不额外启动其 CLI。需要外部 Node.js 的 hook 与七个 Agent 的「测试」按钮共用自动查找，并使用找到的 Node.js 绝对路径，避免桌面进程 PATH 不完整导致 `ENOENT`；查找时排除 Coopanion 自带的 Electron Node 包装脚本，只接受独立 Node.js 22+，测试也不继承 Electron 的 Node 模式；OpenCode、DSH 的正常回调继续使用自身运行时。未安装所需程序时会报错，不自动安装程序。

设置页分为“Hook 安装与测试”和“通知总结提示词”。提示词用于指导 Coopanion 总结任务结论，保存后的部署覆盖由框架自动读取。未列出的 Agent 可到 [GitHub](https://github.com/ThermalEng/coopanion-agent-notify-world) 提交 PR 或 Issue，作者会尽快处理。

## Windows

面向 Windows 原生运行的 Agent；WSL 中的 Agent 按 Linux 环境部署，不混用两侧的 hook 路径。默认 hook 目录为 `%USERPROFILE%\.coopanion\agent-hooks`，Agent 配置路径仍尊重上述环境变量。

- 安装 Codex、DSH hook 时，通过 Windows PowerShell 调用原生 CLI，兼容 npm 的 `.cmd` 入口和带空格、中文的路径。
- Claude Code 使用原生 `command` + `args` 形式直接启动自动找到的 `node.exe`；需使用支持该形式的版本。
- Codex 使用 `commandWindows`，通过编码后的 PowerShell 命令转交 UTF-8 报告；需使用支持该字段的版本。
- OpenCode、DSH 仍直接导入共用发送模块；配置页的测试直接启动自动找到的 `node.exe`，不弹出额外控制台窗口。

Windows 需要 PATH 中有 Node.js 22+ 和对应 Agent CLI，以及系统自带的 `powershell.exe`。本次 Windows 适配未运行测试；Muse、agy 的真实 hook 也尚待用户验证。

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
