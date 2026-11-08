import type { Language } from 'cortico/core/language.ts';
import type { WebUiClientBundle, WebUiPanel } from 'cortico/web/shared/client-panel.ts';

export type Agent = 'codex' | 'claude' | 'opencode' | 'dsh';
export const AGENTS: Agent[] = ['codex', 'claude', 'opencode', 'dsh'];
export const LABELS: Record<Agent, string> = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', dsh: 'DeepSeek Harness' };
export interface HookStatus { id: Agent; installed: boolean; detail: string }
export interface PanelState { online: boolean; agents: HookStatus[] }

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
  return { title, install, test, installed, missing, online, offline, done };
}

const panel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    const t = uiText(ctx.language);
    const sheet = ui.sheet({ title: t.title });
    const endpoint = ui.pill(t.offline, 'off');
    sheet.body.append(endpoint);
    ctx.root.append(sheet.el);
    const rows = new Map<Agent, { state: HTMLSpanElement; install: HTMLButtonElement; test: HTMLButtonElement }>();
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
      row.append(label, state, install, test);
      sheet.body.append(row);
      rows.set(agent, { state, install, test });
      install.addEventListener('click', () => void act(agent, 'install'), { signal: ctx.signal });
      test.addEventListener('click', () => void act(agent, 'test'), { signal: ctx.signal });
    }

    function render(value: PanelState) {
      if (ctx.signal.aborted) return;
      current = value;
      endpoint.textContent = value.online ? t.online : t.offline;
      endpoint.className = `pill ${value.online ? 'on' : 'off'}`;
      for (const status of value.agents) {
        const row = rows.get(status.id)!;
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
      render(current);
      try {
        render(await ctx.invoke<PanelState>(method, [agent]));
        if (!ctx.signal.aborted) ui.toast(`${LABELS[agent]} · ${t.done}`, 'ok');
      } catch (error) {
        if (!ctx.signal.aborted) ui.toast(error instanceof Error ? error.message : String(error), 'bad');
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
