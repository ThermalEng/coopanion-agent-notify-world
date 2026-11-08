<!-- Owner: package.json, index.ts, webui.ts, hook.mjs -->

# Changelog

## 0.1.0

- 为 Codex、Claude Code、OpenCode、DSH 提供独立的安装 hook 和测试按钮；启动 World 不安装 hook。
- 通过本地带令牌接口接收最终报告，由 Coopanion 当前模型总结并通知；不依赖其他插件，不新增运行时 npm 依赖。
- 包含 Windows 原生调用适配，Windows 与真实 Agent 任务回调仍待实机验证；以实验性版本发布。
- 最终报告会进入 Coopanion 的模型上下文与事件历史，可能包含私有项目信息。

- Adds per-agent Install hook and Test buttons without automatic hook installation.
- Delivers final reports over an authenticated loopback endpoint for Coopanion to summarize and announce; no runtime npm or other-plugin dependencies.
- Includes unverified native Windows support. Real-agent callback verification is pending; this is an experimental release.
- Reports enter Coopanion model context and event history and may contain private project information.
