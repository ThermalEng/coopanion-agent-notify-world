<!-- Owner: index.ts, webui.ts, hook.mjs -->

# Coding Agent Notify World

ThermalEng 维护的第三方 Coopanion World 扩展，非 Pal AI Lab 官方扩展。生产代码只有 `index.ts`、`webui.ts`、`hook.mjs`。无运行时 npm 依赖，不依赖 Petdex、agent-notify 或其他插件。

## 使用

1. 已发布版本可在 Coopanion 的「World 扩展」中填写 `cortico-world-coding-agent-notify` 安装并启用；市场同步后也可搜索。开发版先构建，再选择本地目录安装。
2. 打开 World 配置页，分别点击对应 Agent 的「安装 hook」和「测试」。安装 World 本身不会修改 Agent 配置。
3. 重启对应 Agent。Codex 如提示信任审核，在 `/hooks` 中确认。

| Agent | 原生接入 |
| --- | --- |
| Codex | 用户目录 `hooks.json` 的 `Stop`，用 `codex features enable hooks` 开启功能 |
| Claude Code | 用户目录 `settings.json` 的 `Stop` |
| OpenCode | 用户 `plugins/` 目录中的本地插件，监听 `session.idle` |
| DSH | `dsh plugin --profile web add link:…` 安装本地 Cordis 插件，监听 `session/event` 和 `agent/turn-stopping` |

Codex、Claude hook 与配置页的测试需要 `node`（22+）在 PATH 中；Codex、DSH 的安装分别需要 `codex`、`dsh` 在 PATH 中。OpenCode、DSH 插件直接使用自身运行时发送报告。生成的 Agent 插件只是本扩展的入口，不会安装第三方插件。

World 运行时开启带令牌的 `127.0.0.1` 临时接口；hook 将最终报告发来，由 Coopanion 当前连接的模型总结，再使用其内置桌宠能力通知。因此需要 Coopanion 正在运行并已连接模型，模型调用会产生正常用量。**最终报告会进入 Coopanion 的模型上下文和事件历史**，不会发送完整对话。

「测试」验证共用发送器 → World 事件入口，收到后由 Coo 通知；它不替代一次真实 Agent 任务对原生回调的验证。不提供离线队列；Coopanion 关闭时通知跳过，不影响 Agent 完成任务。重新点击安装不会重复添加 hook。

默认生成目录：`~/.coopanion/agent-hooks`。可通过 `COOPANION_AGENT_HOOK_HOME` 更改；DSH 支持 `COOPANION_DSH_PROFILE`、`COOPANION_DSH_BIN`、`DSH_HOME`。也尊重 Agent 自带的 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 和 `XDG_CONFIG_HOME`。使用多个配置时，应让 Coopanion 启动环境与对应 Agent 一致。

Codex 的 TOML 配置由自身 CLI 修改。已有 JSON 设置保留其他键；无效 JSON 会报错，不会覆盖。

## Windows

面向 Windows 原生运行的 Agent；WSL 中的 Agent 按 Linux 环境部署，不混用两侧的 hook 路径。默认 hook 目录为 `%USERPROFILE%\.coopanion\agent-hooks`，Agent 配置路径仍尊重上述环境变量。

- 安装 Codex、DSH hook 时，通过 Windows PowerShell 调用原生 CLI，兼容 npm 的 `.cmd` 入口和带空格、中文的路径。
- Claude Code 使用原生 `command` + `args` 形式直接启动 `node.exe`；需使用支持该形式的版本。
- Codex 使用 `commandWindows`，通过编码后的 PowerShell 命令转交 UTF-8 报告；需使用支持该字段的版本。
- OpenCode、DSH 仍直接导入共用发送模块；配置页的测试直接启动 `node.exe`，不弹出额外控制台窗口。

Windows 需要 PATH 中有 Node.js 22+ 和对应 Agent CLI，以及系统自带的 `powershell.exe`。本次 Windows 适配未运行测试。

## 开发

`cortico`、`jsdom` 等仅为开发依赖，不随本扩展安装到运行环境。

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

npm 包名为 `cortico-world-coding-agent-notify`。`pnpm pack` 构建并生成本地安装包；市场通过 npm 收录。
