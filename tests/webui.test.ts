// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { createWebUi } from 'cortico/web/client/ui/index.ts';
import bundle, { AGENTS, type Agent, type PanelState } from '../webui.ts';

it('exposes exactly two buttons per agent and keeps Test disabled until installed', async () => {
  const life = new AbortController();
  const root = document.createElement('div');
  document.body.append(root);
  let installed: Agent | undefined;
  const state = (): PanelState => ({ online: true, agents: AGENTS.map((id) => ({ id, installed: installed === id, detail: id })) });
  const invoke = vi.fn(async (method: string, args?: unknown[]) => {
    if (method === 'install') installed = args?.[0] as Agent;
    return state();
  });
  bundle.panels!.hooks.mount({
    pageId: 'world:coding-agent-notify', panelId: 'hooks', language: 'zh', root, signal: life.signal,
    ui: createWebUi({ doc: document, overlayHost: document.body, signal: life.signal, memo: { get: (_, fallback) => fallback, set() {} } }),
    invoke: invoke as never, interval: () => ({ dispose() {} }), own: (value: unknown) => value,
    stream: () => ({ dispose() {}, send() {}, open: false }),
  } as unknown as WebUiPanelContext);
  await vi.waitFor(() => expect(root.querySelector('button')?.disabled).toBe(false));
  expect(root.textContent).toContain('Hook 安装与测试');
  expect(root.textContent).toContain('尚未列出的 Agent');
  expect(root.textContent).toContain('作者会尽快处理');
  expect(root.querySelector('a')?.href).toBe('https://github.com/ThermalEng/coopanion-agent-notify-world');
  const buttons = Array.from(root.querySelectorAll('button'));
  expect(buttons).toHaveLength(14);
  expect(buttons.filter((button) => button.textContent === '测试').every((button) => button.disabled)).toBe(true);
  buttons[0].click();
  await vi.waitFor(() => expect(buttons[1].disabled).toBe(false));
  buttons[1].click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('test', ['codex']));
  life.abort();
  root.remove();
});
