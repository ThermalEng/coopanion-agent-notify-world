#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
// Shared sender: command hook CLI, OpenCode plugin and DSH plugin.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const agents = ['codex', 'claude', 'opencode', 'dsh', 'muse', 'agy', 'workbuddy'];
export const labels = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', dsh: 'DeepSeek Harness', muse: 'Muse Code', agy: 'Antigravity (agy)', workbuddy: 'WorkBuddy' };

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && !part.synthetic && !part.ignored)
    .map((part) => part.text ?? '').join('\n');
}

async function send(agent, input) {
  const summary = String(input.summary ?? input.last_assistant_message ?? '').trim()
    || `${labels[agent]} ended the turn without a final report.`;
  const endpoint = JSON.parse(await readFile(new URL('./endpoint.json', import.meta.url), 'utf8'));
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
    body: JSON.stringify({
      agent, summary: summary.slice(0, 20_000), test: input.test === true,
      sessionId: String(input.session_id ?? '').slice(0, 256),
      workspace: String(input.cwd ?? '').slice(0, 2000),
    }),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Receiver returned HTTP ${response.status}`);
}

export async function OpenCode({ client, directory }) {
  return {
    event({ event }) {
      if (event?.type !== 'session.idle') return;
      const id = event.properties.sessionID;
      // Keep notification IO outside the awaited agent lifecycle.
      void (async () => {
        const session = await client.session.get({ path: { id } });
        if (session.data?.parentID) return;
        const result = await client.session.messages({ path: { id } });
        const last = result.data?.findLast((item) => item.info.role === 'assistant');
        await send('opencode', { summary: textOf(last?.parts), session_id: id, cwd: directory });
      })().catch(() => {});
    },
  };
}

// Plain definitions are the native Plugin.define result; no SDK dependency needed.
export const OpenCodePlugin = {
  id: 'coding-agent-notify',
  server: OpenCode,
  setup(ctx) {
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ['session.execution.succeeded'], signal: controller.signal })) {
        if (event.location && (event.location.directory !== ctx.location.directory
          || event.location.workspaceID !== ctx.location.workspaceID)) continue;
        try {
          const id = event.data.sessionID;
          const session = await ctx.session.get({ sessionID: id });
          // Completion events can omit location on the server-wide bus.
          if (session.parentID || session.location.directory !== ctx.location.directory) continue;
          const messages = await ctx.session.context({ sessionID: id });
          const last = messages.findLast((item) => item.type === 'assistant');
          await send('opencode', {
            summary: textOf(last?.content), session_id: id, cwd: session.location.directory,
          });
        } catch (error) { console.warn('[coding-agent-notify]', error.message); }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.warn('[coding-agent-notify]', error.message);
    });
    return () => controller.abort();
  },
};

export const name = 'coopanion-agent-notify-dsh';
export const inject = [];
function dshShouldNotify(session) {
  const header = session?.header;
  if (!header || typeof header !== 'object') return true;
  if (header.origin === 'subagent') return false;
  if (typeof header.delegationDepth === 'number' && Number.isFinite(header.delegationDepth) && header.delegationDepth > 0) return false;
  return true;
}
function dshSessionId(session) {
  const id = session?.header?.id ?? session?.id;
  return typeof id === 'string' ? id : id != null ? String(id) : '';
}
function dshTurnEndKind(event) {
  const reason = event?.data?.reason;
  return typeof reason === 'string' ? reason : reason?.kind;
}
export function apply(ctx) {
  const reports = new Map();
  const activityTimers = new Map();
  const hasService = (service) => {
    try { return typeof ctx.get === 'function' && ctx.get(service) !== undefined; }
    catch { return false; }
  };
  const clearTimer = (key) => {
    const timer = activityTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      activityTimers.delete(key);
    }
  };
  const sendCompletion = (sessionId, cwd, summary) => {
    void send('dsh', { summary, session_id: sessionId, cwd }).catch(() => {});
  };
  const hasBlockingActivity = async (sessionId) => {
    if (!sessionId || typeof ctx.waterfall !== 'function') return false;
    try {
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
      return Array.isArray(activity) && activity.some((item) => {
        const kind = item?.kind;
        return kind === 'job' || kind === 'subagent' || kind === 'schedule';
      });
    } catch { return false; }
  };
  const onSessionEvent = (session, event) => {
    try {
      if (!event || typeof event !== 'object') return;
      if (!dshShouldNotify(session)) return;
      const sessionId = dshSessionId(session);
      const key = sessionId || 'unknown';
      if (event.type === 'turn/start') {
        clearTimer(key);
        reports.delete(key);
        return;
      }
      if (event.type === 'assistant/message') {
        if (event.data?.interrupted) return;
        const summary = textOf(event.data?.message?.content);
        if (summary.trim()) reports.set(key, { turn: event.data?.turn, summary });
        return;
      }
      if (event.type === 'turn/end') {
        const report = reports.get(key);
        reports.delete(key);
        if (dshTurnEndKind(event) !== 'completed') {
          clearTimer(key);
          return;
        }
        const turn = event.data?.turn;
        const summary = (report && (turn === undefined || report.turn === undefined || report.turn === turn))
          ? report.summary : '';
        const cwd = session?.header?.cwd ?? session?.cwd ?? '';
        if (typeof ctx.waterfall === 'function' && hasService('webServer')) {
          clearTimer(key);
          const timer = setTimeout(() => {
            activityTimers.delete(key);
            void (async () => {
              if (await hasBlockingActivity(sessionId)) return;
              sendCompletion(sessionId, cwd, summary);
            })().catch(() => {});
          }, 1500);
          activityTimers.set(key, timer);
        } else {
          sendCompletion(sessionId, cwd, summary);
        }
      }
    } catch { /* A notification must never interrupt an agent. */ }
  };
  const disposeEvent = ctx.on('session/event', onSessionEvent, { global: true });
  const disposeSession = ctx.on('session/disposed', (session) => {
    const key = dshSessionId(session) || 'unknown';
    clearTimer(key);
    reports.delete(key);
  }, { global: true });
  const cleanup = () => {
    for (const timer of activityTimers.values()) clearTimeout(timer);
    activityTimers.clear();
    reports.clear();
    if (typeof disposeEvent === 'function') disposeEvent();
    if (typeof disposeSession === 'function') disposeSession();
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup, name);
}

async function main() {
  const agent = process.argv[2];
  if (!agents.includes(agent)) return;
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1024 * 1024) return;
  }
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  if (!input || typeof input !== 'object') return;
  if (['codex', 'claude', 'muse', 'workbuddy'].includes(agent) && input.hook_event_name !== 'Stop') return;
  try {
    if (agent === 'muse' && input.test !== true && process.env.MUSE_THREAD_ID && process.env.MUSE_SESSION_ID
      && process.env.MUSE_THREAD_ID !== process.env.MUSE_SESSION_ID) return;
    if (agent === 'agy' && input.test !== true) {
      // Stop also fires while background work continues or execution fails.
      // CLI uses NO_TOOL_CALL; the web documentation also describes model_stop.
      if (input.fullyIdle !== true || !['NO_TOOL_CALL', 'model_stop'].includes(input.terminationReason) || input.error) return;
      let summary = '';
      const rawPath = input.transcriptPath ?? '';
      const path = (rawPath.startsWith('~/') || rawPath.startsWith('~\\'))
        ? resolve(homedir(), rawPath.slice(2)) : rawPath;
      const stream = createReadStream(path, { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let step;
          try { step = JSON.parse(line); } catch { continue; }
          // Do not reuse a previous turn's answer if this turn has none.
          if (step.type === 'USER_INPUT') summary = '';
          if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE' && step.status === 'DONE') {
            summary = textOf(step.content).slice(0, 20_000);
          }
        }
      } finally { lines.close(); stream.destroy(); }
      if (!summary.trim()) return;
      input = { summary, session_id: input.conversationId, cwd: input.workspacePaths?.[0] };
    }
    await send(agent, input);
  }
  catch (error) {
    if (input.test === true) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
const own = fileURLToPath(import.meta.url);
if (entry && (process.platform === 'win32' ? entry.toLowerCase() === own.toLowerCase() : entry === own)) await main();
