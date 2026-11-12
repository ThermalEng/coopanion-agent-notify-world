import type { Language } from 'cortico/core/language.ts';
import type { WebUiClientBundle, WebUiPanel } from 'cortico/web/shared/client-panel.ts';

export type Agent = 'codex' | 'claude' | 'opencode' | 'dsh' | 'muse' | 'agy' | 'workbuddy';
export const AGENTS: Agent[] = ['codex', 'claude', 'opencode', 'dsh', 'muse', 'agy', 'workbuddy'];
export const LABELS: Record<Agent, string> = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', dsh: 'DeepSeek Harness', muse: 'Muse Code', agy: 'Antigravity (agy)', workbuddy: 'WorkBuddy' };
export interface HookStatus { id: Agent; installed: boolean; detail: string }
export interface TestResult { coverage: 'full' | 'notification-only' }
export interface PanelState { online: boolean; agents: HookStatus[]; testResult?: TestResult }

// Text shared with the World declaration; importing this module does not mount the panel.
const COPY: Record<Language, readonly [string, string, string, string, string, string, string, string]> = {
  zh: ['Agent 通知', '安装 hook', '测试', '已安装', '未安装', '接收接口已就绪', '接收接口未启动', '已完成'],
  'zh-Hant': ['Agent 通知', '安裝 hook', '測試', '已安裝', '未安裝', '接收介面已就緒', '接收介面未啟動', '已完成'],
  en: ['Agent notifications', 'Install hook', 'Test', 'Installed', 'Not installed', 'Receiver ready', 'Receiver offline', 'Done'],
  ja: ['Agent 通知', 'hook をインストール', 'テスト', 'インストール済み', '未インストール', '受信準備完了', '受信停止中', '完了'],
  ko: ['Agent 알림', 'hook 설치', '테스트', '설치됨', '미설치', '수신 준비됨', '수신 중지됨', '완료'],
  fr: ['Notifications des agents', 'Installer le hook', 'Tester', 'Installé', 'Non installé', 'Récepteur prêt', 'Récepteur hors ligne', 'Terminé'],
  de: ['Agent-Benachrichtigungen', 'Hook installieren', 'Testen', 'Installiert', 'Nicht installiert', 'Empfänger bereit', 'Empfänger offline', 'Fertig'],
  'es-419': ['Notificaciones de agentes', 'Instalar hook', 'Probar', 'Instalado', 'No instalado', 'Receptor listo', 'Receptor desconectado', 'Listo'],
  'pt-BR': ['Notificações de agentes', 'Instalar hook', 'Testar', 'Instalado', 'Não instalado', 'Receptor pronto', 'Receptor offline', 'Concluído'],
  it: ['Notifiche degli agenti', 'Installa hook', 'Prova', 'Installato', 'Non installato', 'Ricevitore pronto', 'Ricevitore offline', 'Completato'],
  ru: ['Уведомления агентов', 'Установить hook', 'Проверить', 'Установлен', 'Не установлен', 'Приёмник готов', 'Приёмник отключён', 'Готово'],
};
export function uiText(language: Language) {
  const [title, install, test, installed, missing, online, offline, done] = COPY[language];
  const zh = language === 'zh' || language === 'zh-Hant';
  return { title, install, test, installed, missing, online, offline, done,
    hooksTitle: zh ? 'Hook 安装与测试' : 'Hook installation and testing',
    promptTitle: zh ? '通知总结提示词' : 'Notification summary prompt',
    promptDescription: zh ? '指导 Coopanion 总结 Agent 最终结论并通知用户。' : 'Guides Coopanion to summarize agent final reports and notify the user.',
    supportHint: zh ? '如需支持尚未列出的 Agent，请到 GitHub 提交 PR 或 Issue，作者会尽快处理。' : 'For agents not listed here, submit a PR or issue on GitHub; the author will respond promptly.',
    testHint: zh ? '测试会调用 Agent CLI 和已配置的模型，可能产生费用，最多等待约两分钟；请确认桌宠播报。部分 Agent（如 Codex）安装或更新 hook 后，需要重新打开 Agent 并授权 hook，再进行测试。'
      : 'Tests invoke the agent CLI and its configured model, may incur usage costs, and take up to about two minutes. Confirm the pet notification. Some agents (such as Codex) require reopening the agent and authorizing the hook after installation or updates, before testing.',
    full: zh ? 'CLI → 原生 hook → Coopanion 回报已收到，请确认桌宠播报。'
      : 'CLI → native hook → Coopanion report received. Confirm the pet notification.',
    partial: (agent: Agent) => zh ? `PATH 未检测到 ${agent} 命令，本次仅测试通知发送，请手动测试 Agent 完成通知。`
      : `Command ${agent} was not found on PATH. Only notification delivery was tested; manually test agent completion notifications.`,
  };
}

const panel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    const t = uiText(ctx.language);
    const sheet = ui.sheet({ title: t.hooksTitle });
    const endpoint = ui.pill(t.offline, 'off');
    const support = ui.h('p', '', t.supportHint);
    const github = ui.h('a', '', 'GitHub');
    github.href = 'https://github.com/ThermalEng/coopanion-agent-notify-world';
    github.target = '_blank';
    github.rel = 'noopener noreferrer';
    support.append(' ', github);
    sheet.body.append(endpoint, ui.h('p', '', t.testHint), support);
    ctx.root.append(sheet.el);
    const rows = new Map<Agent, { state: HTMLSpanElement; install: HTMLButtonElement; test: HTMLButtonElement; result: HTMLElement }>();
    const pending = new Set<Agent>();
    let current: PanelState = { online: false, agents: [] };

    for (const agent of AGENTS) {
      const row = ui.h('div');
      row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:12px 0';
      const label = ui.h('strong', '', LABELS[agent]);
      label.style.cssText = 'min-width:140px';
      const state = ui.pill(t.missing, 'off');
      const install = ui.button(t.install, { size: 'sm', variant: 'primary' });
      const test = ui.button(t.test, { size: 'sm' });
      // Prevent a click before the initial state request completes.
      install.disabled = test.disabled = true;
      const result = ui.h('small');
      result.style.cssText = 'flex-basis:100%;white-space:pre-wrap';
      row.append(label, state, install, test, result);
      sheet.body.append(row);
      rows.set(agent, { state, install, test, result });
      install.addEventListener('click', () => void act(agent, 'install'), { signal: ctx.signal });
      test.addEventListener('click', () => void act(agent, 'test'), { signal: ctx.signal });
    }

    function render(value: PanelState) {
      if (ctx.signal.aborted) return;
      current = value;
      endpoint.textContent = value.online ? t.online : t.offline;
      endpoint.className = `pill ${value.online ? 'on' : 'off'}`;
      for (const status of value.agents) {
        const row = rows.get(status.id);
        if (!row) continue;
        row.state.textContent = status.installed ? t.installed : t.missing;
        row.state.className = `pill ${status.installed ? 'on' : 'off'}`;
        row.state.title = status.detail;
        row.install.disabled = pending.has(status.id);
        row.test.disabled = pending.has(status.id) || !status.installed || !value.online;
      }
    }

    async function act(agent: Agent, method: 'install' | 'test') {
      if (pending.has(agent)) return;
      pending.add(agent);
      if (method === 'test') rows.get(agent)!.result.textContent = '';
      render(current);
      try {
        const value = await ctx.invoke<PanelState>(method, [agent]);
        render(value);
        if (!ctx.signal.aborted) {
          const message = value.testResult
            ? value.testResult.coverage === 'full' ? t.full : t.partial(agent)
            : `${LABELS[agent]} · ${t.done}`;
          if (method === 'test') rows.get(agent)!.result.textContent = message;
          ui.toast(message, value.testResult?.coverage === 'notification-only' ? 'bad' : 'ok');
        }
      } catch (error) {
        if (!ctx.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          if (method === 'test') rows.get(agent)!.result.textContent = message;
          ui.toast(message, 'bad');
        }
      } finally {
        pending.delete(agent);
        render(current);
      }
    }

    void ctx.invoke<PanelState>('state').then(render).catch((error) => {
      if (!ctx.signal.aborted) ui.toast(String(error), 'bad');
    });
  },
};

export default { panels: { hooks: panel } } satisfies WebUiClientBundle;
