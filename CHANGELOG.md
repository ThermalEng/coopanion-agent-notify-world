<!-- Owner: package.json, index.ts, webui.ts, hook.mjs -->

# Changelog

## 0.1.1

- 修复桌面环境 `spawn codex ENOENT`：四个 Agent 的接入无需手动指定命令路径，CLI 由用户 shell / PowerShell 自动查找；需要外部 Node.js 的 hook 和所有测试按钮使用自动找到的 Node.js 绝对路径。无新增依赖。
- Resolve CLIs through the user shell or PowerShell and use the discovered absolute Node.js path for command hooks and delivery tests; no manual executable-path settings or new dependencies.
- 纠正隐私说明并移除误声明的 `sensitive-data` 标签：只转交任务结论及定位信息，不采集截图、麦克风或窗口数据；市场历史警示标签另行申请撤销。
- Correct the data disclosure and remove the mistakenly declared `sensitive-data` tag. Only final reports and workspace/session metadata are forwarded; no screen, microphone or foreground-window capture. Existing market warnings require a separate withdrawal request.
- 本次按用户要求未运行测试或类型检查，Windows 兼容性仍待验证。
- Tests and type checks were not run for this release, as requested; Windows compatibility remains unverified.

## 0.1.0

- 为 Codex、Claude Code、OpenCode、DSH 提供独立的安装 hook 和测试按钮；启动 World 不安装 hook。
- 通过本地带令牌接口接收最终报告，由 Coopanion 当前模型总结并通知；不依赖其他插件，不新增运行时 npm 依赖。
- 包含 Windows 原生调用适配，Windows 与真实 Agent 任务回调仍待实机验证；以实验性版本发布。
- 最终报告会进入 Coopanion 的模型上下文与事件历史，可能包含私有项目信息。

- Adds per-agent Install hook and Test buttons without automatic hook installation.
- Delivers final reports over an authenticated loopback endpoint for Coopanion to summarize and announce; no runtime npm or other-plugin dependencies.
- Includes unverified native Windows support. Real-agent callback verification is pending; this is an experimental release.
- Reports enter Coopanion model context and event history and may contain private project information.
