<!-- Owner: package.json, index.ts, webui.ts, hook.mjs -->

# Changelog

## 0.1.3 — 2026-11-08

- 移除 `external-setup`（需额外安装）标签：不依赖其他 World 插件，Agent hook 由本插件配置页按需配置；既有 Agent 与 Node.js 运行要求仍见 README。
- Remove the `external-setup` tag; native agent hooks are configured from this World without other World plugins. Existing agent and Node.js requirements remain documented in the README.

## 0.1.2 — 2026-11-08

- 修复 OpenCode 多项目重复通知：全局完成事件缺少 location 时，仍按会话实际所属目录过滤，仅由对应项目实例转发。
- Filter OpenCode global completion events by the session’s own directory to prevent cross-project duplicate notifications.

- 修复 Codex / Claude hook 误用 Coopanion Electron 程序：查找 Node.js 时排除应用自带包装脚本并校验独立 Node.js 22+；测试移除 Electron Node 模式环境，避免“测试能发、真实 hook 不运行”。
- Exclude Coopanion’s Electron-backed Node shim from runtime discovery, require standalone Node.js 22+, and remove Electron Node mode from delivery tests.

- 修复 OpenCode 2.x 插件加载失败：默认导出 `id` / `setup` 定义，订阅原生 `session.execution.succeeded` 完成事件（不再等待旧的 `session.idle`），通过会话上下文读取结论，卸载时取消订阅；保留 V1 ≥ 1.18.29 的 `server` 接口，无新增依赖。
- Fix OpenCode V2 loading and completion delivery using a default plugin definition, the native `session.execution.succeeded` event and session context; retain the V1 ≥ 1.18.29 server entrypoint without adding dependencies.

- 通知文案直接说明 Agent 已完成一轮任务、提交的是最终结论，请总结后用 `pet_say` 通知用户；测试消息单独说明，替换 `Agent / Test / Report` 标签。
- State which agent completed a task turn, label its final conclusion, and request a brief `pet_say` notification; identify delivery tests separately instead of using terse report tags.

- 用户已实测确认通知正常；本次未重新运行自动化测试或类型检查，Windows 兼容性仍待验证。
- Notification delivery was verified by the user; automated tests and type checks were not rerun for this release. Windows compatibility remains unverified.

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
