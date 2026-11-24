// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { createWebUi } from 'cortico/web/client/ui/index.ts';
import bundle, { AGENTS, REPLY_MODES, type Agent, type PanelState, type ReplyConfigState } from '../webui.ts';

function mountPanel(panelId: 'hooks' | 'reply', invoke: (method: string, args?: unknown[]) => Promise<PanelState>) {
  const life = new AbortController();
  const root = document.createElement('div');
  document.body.append(root);
  bundle.panels![panelId].mount({
    pageId: 'world:coding-agent-notify', panelId, language: 'zh', root, signal: life.signal,
    ui: createWebUi({ doc: document, overlayHost: document.body, signal: life.signal, memo: { get: (_, fallback) => fallback, set() {} } }),
    invoke: invoke as never, interval: () => ({ dispose() {} }), own: (value: unknown) => value,
    stream: () => ({ dispose() {}, send() {}, open: false }),
  } as unknown as WebUiPanelContext);
  return {
    root,
    cleanup: () => {
      life.abort();
      root.remove();
    },
  };
}

it('exposes exactly two buttons per agent in hooks tab and keeps Test disabled until installed', async () => {
  let installed: Agent | undefined;
  const state = (): PanelState => ({
    online: true,
    agents: AGENTS.map((id) => ({ id, installed: installed === id, detail: id })),
    reply: { enabled: false, agents: [] },
  });
  const invoke = vi.fn(async (method: string, args?: unknown[]) => {
    if (method === 'install') installed = args?.[0] as Agent;
    return state();
  });
  const { root, cleanup } = mountPanel('hooks', invoke);
  try {
    await vi.waitFor(() => expect(root.querySelector('button')?.disabled).toBe(false));
    expect(root.textContent).toContain('Hook 安装与测试');
    expect(root.textContent).toContain('尚未列出的 Agent');
    expect(root.textContent).toContain('作者会尽快处理');
    expect(root.querySelector('a')?.href).toBe('https://github.com/ThermalEng/coopanion-agent-notify-world');
    expect(root.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    const buttons = Array.from(root.querySelectorAll('button'));
    expect(buttons).toHaveLength(14);
    expect(buttons.filter((button) => button.textContent === '测试').every((button) => button.disabled)).toBe(true);
    buttons[0].click();
    await vi.waitFor(() => expect(buttons[1].disabled).toBe(false));
    buttons[1].click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('test', ['codex']));
  } finally {
    cleanup();
  }
});

it('manages the separate reply tab with CLI-only notice, 4-option/yes-no rule, and per-agent resume hints', async () => {
  let reply: ReplyConfigState = { enabled: false, agents: [] };
  const invoke = vi.fn(async (method: string, args?: unknown[]): Promise<PanelState> => {
    if (method === 'setReply') {
      const next = args?.[0] as ReplyConfigState;
      reply = { enabled: Boolean(next.enabled), agents: [...next.agents] };
    }
    return {
      online: true,
      agents: AGENTS.map((id) => ({ id, installed: false, detail: id })),
      reply,
    };
  });
  const { root, cleanup } = mountPanel('reply', invoke);
  try {
    const checkboxes = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(checkboxes).toHaveLength(1 + AGENTS.length);
    const [master, ...agentBoxes] = checkboxes;
    await vi.waitFor(() => expect(master.disabled).toBe(false));

    expect(master.checked).toBe(false);
    expect(agentBoxes.every((box) => box.disabled)).toBe(true);
    expect(root.textContent).toContain('仅支持终端 CLI 会话，不支持桌面客户端或 IDE 插件');
    expect(root.textContent).toContain('4 个选项以内');
    expect(root.textContent).toContain('简单判断题');
    expect(root.textContent).toContain('Codex（CLI 直接入队续接，无需 /resume）');
    expect(root.textContent).toContain('OpenCode（CLI 直接续接当前会话，无需 /resume）');
    expect(root.textContent).toContain('Antigravity (agy)（后台 CLI，需先退出当前 CLI 再 /resume）');
    expect(root.textContent).toContain('Claude Code（后台 CLI，需先退出当前 CLI 再运行 claude --resume，勿在旧窗口内直接 /resume）');

    master.click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('setReply', [{ enabled: true, agents: [] }]));

    for (const [idx, agent] of AGENTS.entries()) {
      expect(agentBoxes[idx].disabled).toBe(REPLY_MODES[agent] === 'unsupported');
    }

    const codexBox = agentBoxes[AGENTS.indexOf('codex')];
    const agyBox = agentBoxes[AGENTS.indexOf('agy')];
    codexBox.click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('setReply', [{ enabled: true, agents: ['codex'] }]));
    agyBox.click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('setReply', [{ enabled: true, agents: ['codex', 'agy'] }]));
  } finally {
    cleanup();
  }
});
