<!-- Owner: package.json, index.ts, webui.ts, hook.mjs, hook-runtime.ts, coopanion-agent-launch.sh, coopanion-agent-launch.ps1 -->

# Changelog

## 1.3.3 — 2026-11-28

- 增加 `detectDecisionPrompt` 结论决策识别门控：仅当已勾选 Agent 的最终结论确实向用户提出了 4 个选项以内的选择题或“是否同意/继续”等判断题时，才分配 `targetId` 并允许选项交互；对于纯审查报告（如 `REQUEST_CHANGES` / `APPROVE`）、进度汇报或礼貌问候，不分配 `targetId` 并明确禁止 Coopanion 自行生成决策建议、调用 `pet_ask` 或调用 `reply_coding_agent`。

## 1.3.2 — 2026-11-28

- 加固指令回传代码级门控（保持单步交互，无需二次弹窗确认）：`reply_coding_agent` 强制校验事件库中在对应通知之后、最近一次已授权游标之后是否存在真实用户输入事件（`desktop-pet.answer` 有效选择或回答、`desktop-pet.message`、`desktop-pet.speech`、`console.message`），过滤 `dismissed`、戳桌宠、自言自语与内部系统事件，彻底阻断未经用户交互的自动回复与循环。
- 回传目标（`ReplyTarget`）与授权游标采用一次性消费并设 30 分钟过期，同一会话新通知覆盖旧目标，修改回传设置即时清空旧目标，并为 `reply_coding_agent` 启用 `barrierAfter: true`。

## 1.3.1 — 2026-11-24

- 将「指令回传」拆分为独立设置选项卡，明确声明仅支持终端 CLI 会话（不支持桌面客户端或 IDE 插件），触发条件扩展为「4 个选项以内的简单选择题」或「是否同意/继续等简单判断题」。
- 修复 Codex 指令回传：改用 `codex queue --thread <id> --message <msg> --resume` 直接入队续接当前 CLI 会话，不再提示 `/resume`；并将后台命令启动探针窗口延长至 1500ms 且记录详细错误文本。
- 细化 `agy` 与 Claude Code 回传说明：明确提示需先退出当前 CLI 再恢复对话（`agy` 使用 `/resume`，Claude Code 退出后运行 `claude --resume`，勿在未退出的旧终端内直接输入 `/resume`）。

## 1.3.0 — 2026-11-24

- 新增可选的「指令回传（2 选 1 / 3 选 1）」功能：设置页增加主开关与按 Agent 勾选（默认关闭），仅当已勾选 Agent 在结论中提出简单的 2 选 1 或 3 选 1 问题并由用户明确选择后，才异步向原会话发送后续指令；未开启或未勾选时提示 Coopanion 不提供可执行操作选项。
- 暴露 `reply_coding_agent` 工具与非阻塞原生命令派发：支持 Codex、Claude Code、Antigravity (`agy`) 后台续跑（提示用户需 `/resume` 回到对话）以及 OpenCode 直接续接当前会话，防止自动回复死循环并阻止同会话并发重入。

## 1.2.5 — 2026-11-16

- 改进 DSH Cordis 钩子：改用带 `{ global: true }` 的 `session/event` (`turn/end`) 判断回合是否真正完成，过滤 `aborted` / `blocked` / `interrupted` / `error` / `max-tokens`；改用 `header.origin` 与 `delegationDepth` 过滤子代理并保留普通 fork 对话；修复 `assistant/message` 空内容覆盖已有正文与 `sessionId` 缓存清理；在带 `webServer` 的长驻宿主加入 1.5 秒 `workspace/session-activity` 活动门防团队/后台子任务误报并随卸载清理定时器。
- 安装与状态检测自动兼容已初始化的 DSH `desktop` profile。

## 1.2.4 — 2026-11-15

- 将 `package.json` 顶层 `description` 更新为中文说明，使扩展市场未同步或查看已装包详情时也能正常显示中文简介；同时扩展 `cortico.locales.zh.description` 与 `cortico.locales.en.description`，保持中英文简介同等详细（涵盖 7 个 Agent 的按需 hook 安装、回调测试与本机临时接口回报流程）。

## 1.2.3 — 2026-11-15

- 移除扩展简介中「Windows 适配待验证」说明（中英文简介同步更新）。

## 1.2.2 — 2026-11-15

- 修复 Windows 安装 Codex 时 `powershell.exe -EncodedCommand` 未设置 `-OutputFormat Text` 与 UTF-8 输出导致的 CLIXML 乱码，并补充注册表 `PATH`、常见包管理器目录与 IDE 插件内置 `codex.exe` 查找、PowerShell 5.1 空参数与 stderr 警告处理及单引号 `nodePath` 探针修复。
- 安装 Codex hook 优先调用 `codex features enable hooks`；仅在未检测到 `codex` CLI 时直接向 `$CODEX_HOME/config.toml` 安全启用 `[features].hooks = true` 并写入 `hooks.json`，兼顾 Codex 桌面端与 IDE 插件用户且不影响原生 Codex CLI 链路。

## 1.2.1 — 2026-11-14

- 扩展图标在同一个 SVG 内提供深浅两套配色，跟随 Coopanion 当前主题自动切换；保留原有图形和浅色配色。

## 1.2.0 — 2026-11-12

- 五种命令型 Agent 共用运行时发现器：优先使用执行环境提供的独立 Node，结合随包运行时、PATH、版本管理器和可选安装提示；OpenCode、DSH 正常回调保留自身运行时。
- 安装时缺少宿主 Node 不再阻止注册；运行时跳过失效提示、旧版本和 Coopanion Electron 包装器，限制探测耗时并保留 UTF-8 stdin。
- 保留各 Agent 的 Windows 原生配置格式；重装只升级受管 hook，不改其他 hook 和设置。新增多 Agent 实际命令、无系统 Node、探测挂起、路径转义和升级回归测试。Windows 尚未实机验证。

## 1.1.1 — 2026-11-12

- 设置页分别命名为“Hook 安装与测试”和“通知总结提示词”，新增未列出 Agent 可到 GitHub 提 PR / Issue 的提示。
- 修复 agy 安装测试对 Windows 编码 PowerShell 命令的断言，解码后核对调用内容。
- 验证通知提示词参与框架环境前缀渲染，支持部署覆盖及恢复默认；同步提示词描述元数据。

## 1.1.0 — 2026-11-12

- 增加 WorkBuddy 原生 Hook 扩展支持（Agent 增至 7 个），支持标准 `~/.workbuddy/settings.json` 与 `WORKBUDDY_CONFIG_DIR`。
- 修复全量 Windows 钩子规则与 PowerShell 编码命令识别（修复 agy 与 Muse 在 Windows 下的命令处理与状态误判）。
- 集成 World 扩展矢量图标 `icon.svg`（终端视窗与通知徽章），符合 Cortico 设计规范并在 `package.json` 声明。

## 1.0.0 — 2026-11-10

- 移除 `experimental`（实验型）标签，保留 `apps`。

- OpenCode CLI 最小真实任务已以退出码 0 正常结束，用户已确认收到回复；保留 stdin EOF 与回报等待期间保留工作目录的修复，不额外修改 OpenCode 模型或后台服务。
- Codex / Claude Stop 改为最多 5 秒的同步发送，避免单次 CLI 结束时异步 hook 尚未完成；测试临时目录改为收到回报或等待结束后清理。CLI 失败显示退出码/超时及 stdout、stderr，避免隐藏 OpenCode 的实际错误。
- 修复 CLI 测试未关闭标准输入导致 Codex 等待 stdin 并超时；启动后立即发送 EOF，提示词仍仅通过命令行参数传递。
- 配置页测试改为调用对应 Agent CLI，再等待本轮唯一标识的原生 hook 回报；CLI 成功但没有回报仍报失败。找不到命令时仅测试通知并提示 PATH 未检测到命令、请手动测试。DSH 安装同时注册 headless profile 以支持 CLI 测试。
- 修复 agy CLI 正常完成的 `NO_TOOL_CALL` 被过滤；同时兼容文档中的 `model_stop`，继续跳过后台未结束、出错或取消。
- 本地开发版使用独立版本号，避免沿用 0.1.3 的长期前端缓存；配置页忽略不存在的 Agent 行。
- 增加 Muse Code、agy（Antigravity CLI）的安装 hook / 测试按钮；复用原生 Stop 与共用发送器，无新增生产文件或运行时依赖。
- agy 只在成功且完全空闲时提取当前轮最终模型正文；重复安装更新本插件具名配置，保留其他 hook。
- 用户已确认 Codex 重新授权后测试成功；测试页新增安装或更新 hook 后需重新打开 Agent 并授权的提示。已构建并同步本机；本次未运行自动化测试或类型检查，Windows 仍待验证。

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
