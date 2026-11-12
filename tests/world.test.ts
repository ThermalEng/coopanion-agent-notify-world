import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorldHost } from 'cortico/core/types.ts';
import { collectWorldContexts, renderWorldEnvPrompt } from 'cortico/core/prefix.ts';
import { checkDescribe } from 'cortico/extensions/describe-export.ts';
import definition, { CodingAgentNotifyWorld, HookManager } from '../index.ts';
import { AGENTS, type Agent, type PanelState } from '../webui.ts';

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const exec = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coopanion hooks '空格-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const run = vi.fn(async (command: string, args: string[], _cwd?: string) => {
    if (command === 'dsh' && args[0] === 'plugin') {
      const profile = args[args.indexOf('--profile') + 1];
      const file = join(home, '.dsh', 'profiles', profile, 'package.json');
      await mkdir(join(home, '.dsh', 'profiles', profile), { recursive: true });
      await writeFile(file, JSON.stringify({ dsh: { profile: { bundles: ['coopanion-agent-notify-dsh'] } } }));
    }
  });
  const hooks = new HookManager({ homeDir: home, hookDir: join(root, 'hooks'), env: {}, run });
  return { root, home, hooks, run };
}

async function mounted() {
  const f = await fixture();
  const pushEvent = vi.fn(async (event: unknown) => event);
  const world = new CodingAgentNotifyWorld('Asia/Shanghai', f.hooks);
  const host = { pushEvent, log: { warn: vi.fn() } } as unknown as WorldHost;
  cleanups.push(() => world.stop());
  await world.start(host);
  const ui = world.webUi('zh');
  const invoke = async (method: string, agent?: Agent) => await ui.invoke!('hooks', method, agent ? [agent] : []) as PanelState;
  return { ...f, world, pushEvent, invoke };
}

async function runner(command: string, args: string[], input: object, shell = false) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(command, args, { shell, stdio: ['pipe', 'ignore', 'pipe'] });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(input));
  });
}
async function probe(modulePath: string, script: string) {
  await exec('node', ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const plugin = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    ${script}
  `]);
}

describe('agent hook installation', () => {
  it('constructing, starting and viewing the World never installs agent hooks', async () => {
    const f = await mounted();
    expect((await f.invoke('state')).agents.every((agent) => !agent.installed)).toBe(true);
    expect(await readFile(join(f.hooks.dir, 'endpoint.json'), 'utf8')).toContain('127.0.0.1');
    await expect(stat(f.home)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(AGENTS)('installs only %s and remains idempotent', async (agent) => {
    const f = await fixture();
    await f.hooks.install(agent);
    await f.hooks.install(agent);
    const statuses = await f.hooks.statuses();
    expect(statuses.filter((value) => value.installed).map((value) => value.id)).toEqual([agent]);
    const path = statuses.find((value) => value.id === agent)!.detail;
    if (agent === 'codex' || agent === 'claude' || agent === 'muse' || agent === 'workbuddy') {
      const settings = JSON.parse(await readFile(path, 'utf8'));
      expect(settings.hooks.Stop).toHaveLength(1);
      expect(settings.hooks.Stop[0].hooks[0].async).toBe(agent === 'muse');
      if (agent !== 'muse') expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(5);
    }
    if (agent === 'agy') {
      const settings = JSON.parse(await readFile(path, 'utf8'));
      expect(settings['coding-agent-notify'].Stop).toHaveLength(1);
      const command = settings['coding-agent-notify'].Stop[0].command as string;
      const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/);
      const script = encoded ? Buffer.from(encoded[1], 'base64').toString('utf16le') : command;
      expect(script).toContain('coopanion-agent-hook.mjs');
      expect(script).toContain(encoded ? "'agy'" : ' agy');
    }
    if (agent === 'codex') expect(f.run).toHaveBeenCalledWith('codex', ['features', 'enable', 'hooks']);
    if (agent === 'dsh') expect(f.run).toHaveBeenCalledWith('dsh', ['plugin', '--profile', 'web', 'add', `link:${path}`]);
    if (agent === 'opencode') expect(await readFile(path, 'utf8')).toContain('export { OpenCodePlugin as default }');
  });

  it('preserves unrelated settings and refuses invalid JSON', async () => {
    const f = await fixture();
    const file = join(f.home, '.claude', 'settings.json');
    await mkdir(join(f.home, '.claude'), { recursive: true });
    const kept = { hooks: [{ type: 'command', command: 'echo kept' }] };
    await writeFile(file, JSON.stringify({ theme: 'dark', hooks: { Stop: [kept], SessionStart: [kept] } }));
    await f.hooks.install('claude');
    const value = JSON.parse(await readFile(file, 'utf8'));
    expect(value.theme).toBe('dark');
    expect(value.hooks.Stop[0]).toEqual(kept);
    expect(value.hooks.SessionStart).toEqual([kept]);
    await writeFile(file, '[]');
    await expect(f.hooks.install('claude')).rejects.toThrow('JSON object');
    expect(await readFile(file, 'utf8')).toBe('[]');
  });

  it('preserves other agy definitions when reinstalling its managed hook', async () => {
    const f = await fixture();
    const file = join(f.home, '.gemini', 'config', 'hooks.json');
    await mkdir(join(f.home, '.gemini', 'config'), { recursive: true });
    const other = { Stop: [{ command: 'echo kept' }] };
    await writeFile(file, JSON.stringify({ other }));
    await f.hooks.install('agy');
    await f.hooks.install('agy');
    const settings = JSON.parse(await readFile(file, 'utf8'));
    expect(settings.other).toEqual(other);
    expect(settings['coding-agent-notify'].Stop).toHaveLength(1);
  });

  it('does not register a Codex hook when its native CLI fails', async () => {
    const f = await fixture();
    f.run.mockRejectedValueOnce(new Error('Native feature unavailable'));
    await expect(f.hooks.install('codex')).rejects.toThrow('Native feature unavailable');
    await expect(stat(join(f.home, '.codex', 'hooks.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('report delivery', () => {
  it.each(AGENTS)('%s Test invokes its CLI and requires a matching native report', async (agent) => {
    const f = await mounted();
    await f.invoke('install', agent);
    f.run.mockImplementation(async (command, args) => {
      expect(command).toBe(agent);
      const prompt = args.find((arg) => arg.includes('COOPANION_HOOK_TEST_'))!;
      expect(prompt).toContain('Do not use tools');
      const endpoint = JSON.parse(await readFile(join(f.hooks.dir, 'endpoint.json'), 'utf8'));
      await fetch(endpoint.url, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ agent, summary: prompt.match(/COOPANION_HOOK_TEST_[a-f0-9]+/)![0] }),
      });
    });
    expect((await f.invoke('test', agent)).testResult?.coverage).toBe('full');
    expect(f.pushEvent).toHaveBeenCalledOnce();
    expect(f.pushEvent).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('原生 hook 回报已到达 Coopanion'),
      meta: expect.objectContaining({ agent, test: true, testCoverage: 'full' }),
    }), { trigger: 'flush' });
  });

  it.skipIf(process.platform === 'win32')('closes CLI stdin without invoking a model', async () => {
    const f = await fixture();
    await f.hooks.install('codex');
    const bin = join(f.root, 'bin');
    const receipt = join(f.root, 'stdin-closed.json');
    const shell = join(f.root, 'test-shell');
    await mkdir(bin);
    await writeFile(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n', { mode: 0o700 });
    await writeFile(join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => fs.writeFileSync(process.env.COOPANION_TEST_RECEIPT, JSON.stringify(process.argv.slice(2))));
`, { mode: 0o700 });
    const hooks = new HookManager({ homeDir: f.home, hookDir: f.hooks.dir, env: {
      SHELL: shell, PATH: `${bin}:${process.env.PATH}`, COOPANION_TEST_RECEIPT: receipt,
    } });
    expect((await hooks.test('codex', 'EOF_TEST_MARKER')).coverage).toBe('full');
    const args = JSON.parse(await readFile(receipt, 'utf8')) as string[];
    expect(args[0]).toBe('exec');
    expect(args.at(-1)).toContain('EOF_TEST_MARKER');
  });

  it('keeps the test workspace until a delayed hook report arrives', async () => {
    const f = await mounted();
    await f.invoke('install', 'claude');
    let workspace = '';
    let delivery: Promise<void> | undefined;
    f.run.mockImplementation(async (_command, args, cwd) => {
      workspace = cwd!;
      const marker = args.find((arg) => arg.includes('COOPANION_HOOK_TEST_'))!.match(/COOPANION_HOOK_TEST_[a-f0-9]+/)![0];
      delivery = new Promise<void>((resolve) => setTimeout(resolve, 25)).then(async () => {
        expect((await stat(workspace)).isDirectory()).toBe(true);
        const endpoint = JSON.parse(await readFile(join(f.hooks.dir, 'endpoint.json'), 'utf8'));
        await fetch(endpoint.url, { method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` },
          body: JSON.stringify({ agent: 'claude', summary: marker }),
        });
      });
    });
    expect((await f.invoke('test', 'claude')).testResult?.coverage).toBe('full');
    await delivery;
    await expect(stat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports missing CLI as notification-only and requests manual testing', async () => {
    const f = await mounted();
    await f.invoke('install', 'agy');
    f.run.mockRejectedValueOnce(Object.assign(new Error('missing CLI'), { stderr: '__COOPANION_COMMAND_NOT_FOUND__' }));
    expect((await f.invoke('test', 'agy')).testResult?.coverage).toBe('notification-only');
    expect(f.pushEvent).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('PATH 未检测到 agy 命令'),
      meta: expect.objectContaining({ test: true, testCoverage: 'notification-only' }),
    }), { trigger: 'flush' });
  });

  it('does not treat model or authentication failures as a missing CLI', async () => {
    const f = await mounted();
    await f.invoke('install', 'agy');
    f.run.mockRejectedValueOnce(new Error('Authentication failed'));
    await expect(f.invoke('test', 'agy')).rejects.toThrow('Authentication failed');
    expect(f.pushEvent).not.toHaveBeenCalled();
  });

  it('fails if the CLI exits successfully without a matching native report', async () => {
    const f = await mounted();
    await f.invoke('install', 'agy');
    const pending = f.invoke('test', 'agy');
    const check = expect(pending).rejects.toThrow('no matching hook report');
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledWith('agy', expect.arrayContaining(['--print']), expect.any(String)));
    // Use the real report timeout; the CLI fixture never starts an actual agent.
    await check;
  }, 15_000);

  it('forwards the Muse Stop final answer', async () => {
    const f = await mounted();
    await f.hooks.install('muse');
    await runner('node', [f.hooks.runner, 'muse'], {
      hook_event_name: 'Stop', last_assistant_message: 'Muse final answer', cwd: '/project', session_id: 'muse-1',
    });
    expect(f.pushEvent).toHaveBeenCalledOnce();
    expect(f.pushEvent).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Muse final answer'), meta: expect.objectContaining({ agent: 'muse' }),
    }), { trigger: 'flush' });
  });

  it('forwards the WorkBuddy Stop final answer', async () => {
    const f = await mounted();
    await f.hooks.install('workbuddy');
    await runner('node', [f.hooks.runner, 'workbuddy'], {
      hook_event_name: 'Stop', last_assistant_message: 'WorkBuddy final answer', cwd: '/project', session_id: 'wb-1',
    });
    expect(f.pushEvent).toHaveBeenCalledOnce();
    expect(f.pushEvent).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('WorkBuddy final answer'), meta: expect.objectContaining({ agent: 'workbuddy' }),
    }), { trigger: 'flush' });
  });

  it.each(['NO_TOOL_CALL', 'model_stop'])('forwards only the last agy answer on a successful fully idle Stop (%s)', async (terminationReason) => {
    const f = await mounted();
    await f.hooks.install('agy');
    const transcriptPath = join(f.root, 'transcript.jsonl');
    await writeFile(transcriptPath, [
      { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Old answer' },
      { source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'New task' },
      { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Intermediate answer' },
      { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'agy final answer', thinking: 'Private reasoning' },
    ].map((step) => JSON.stringify(step)).join('\n'));
    const input = { transcriptPath, conversationId: 'agy-1', workspacePaths: ['/project'], terminationReason, fullyIdle: true };
    for (const override of [{ fullyIdle: false }, { terminationReason: 'ERROR' }, { terminationReason: 'USER_CANCELED' }, { terminationReason: 'MAX_INVOCATIONS' }, { error: 'failed' }]) {
      await runner('node', [f.hooks.runner, 'agy'], { ...input, ...override });
    }
    expect(f.pushEvent).not.toHaveBeenCalled();
    await runner('node', [f.hooks.runner, 'agy'], input);
    expect(f.pushEvent).toHaveBeenCalledOnce();
    const event = f.pushEvent.mock.calls[0][0] as { text: string; meta: object };
    expect(event.text).toContain('agy final answer');
    expect(event.text).not.toContain('Old answer');
    expect(event.text).not.toContain('Private reasoning');
    expect(event.meta).toMatchObject({ agent: 'agy', workspace: '/project', sessionId: 'agy-1' });
  });

  it('rejects tests before installation, but normal hooks do not fail the task', async () => {
    const f = await fixture();
    await expect(f.hooks.test('claude', 'TEST_MARKER')).rejects.toThrow('Install');
    await f.hooks.install('claude');
    expect(await runner('node', [f.hooks.runner, 'claude'], { hook_event_name: 'Stop', last_assistant_message: 'Done' })).toBe(0);
  });

  it('runs the actual configured command safely with spaces and quotes in the path', async () => {
    const f = await mounted();
    await f.invoke('install', 'claude');
    const value = JSON.parse(await readFile(join(f.home, '.claude', 'settings.json'), 'utf8'));
    const hook = value.hooks.Stop[0].hooks[0];
    expect(await runner(hook.command, hook.args ?? [], { hook_event_name: 'Stop', last_assistant_message: '修复完成 ✅', cwd: '/test/workspace' }, !hook.args)).toBe(0);
    expect(f.pushEvent.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining('修复完成 ✅') });
  });

  it('authenticates the receiver, validates reports and removes its endpoint on stop', async () => {
    const f = await mounted();
    const path = join(f.hooks.dir, 'endpoint.json');
    const endpoint = JSON.parse(await readFile(path, 'utf8'));
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await fetch(endpoint.url, { method: 'POST', body: '{}' })).status).toBe(401);
    for (const body of ['invalid', 'null', '{"agent":"unknown","summary":"x"}']) {
      expect((await fetch(endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` }, body })).status).toBe(400);
    }
    expect(f.pushEvent).not.toHaveBeenCalled();
    await f.world.stop();
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('OpenCode reads the final visible message and ignores child sessions', async () => {
    const f = await mounted();
    await f.invoke('install', 'opencode');
    const modulePath = (await f.hooks.status('opencode')).detail;
    await probe(modulePath, `
      const ctx = { directory:'/test/project', client:{ session:{
        get: async ({path}) => { return {data:{parentID:path.id==='child'?'root':undefined}}; },
        messages: async () => ({data:[{info:{role:'assistant'},parts:[{type:'reasoning',text:'private'},{type:'text',text:'Final result'}]}]})
      }}};
      const hooks = await plugin.default.server(ctx);
      assert.equal(hooks.event({event:{type:'session.idle',properties:{sessionID:'s1'}}}), undefined);
      hooks.event({event:{type:'session.idle',properties:{sessionID:'child'}}});
    `);
    await vi.waitFor(() => expect(f.pushEvent).toHaveBeenCalledOnce());
    expect(f.pushEvent.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining('Final result') });
    expect(JSON.stringify(f.pushEvent.mock.calls)).not.toContain('private');
  });

  it('OpenCode V2 scopes global completion events to its project and cleans up subscriptions', async () => {
    const f = await mounted();
    await f.invoke('install', 'opencode');
    await probe((await f.hooks.status('opencode')).detail, `
      let signal;
      const ctx = {
        location: {directory:'/test/project'},
        event: {async *subscribe(options) {
          assert.deepEqual(options.types, ['session.execution.succeeded']);
          signal = options.signal;
          yield {type:'session.execution.succeeded',data:{sessionID:'s1'}};
          yield {type:'session.execution.succeeded',data:{sessionID:'foreign'}};
          yield {type:'session.execution.succeeded',data:{sessionID:'child'},location:{directory:'/test/project'}};
          yield {type:'session.execution.succeeded',data:{sessionID:'other'},location:{directory:'/other'}};
        }},
        session: {
          get: async ({sessionID}) => {
            assert.notEqual(sessionID, 'other');
            return {parentID:sessionID==='child'?'root':undefined,
              location:{directory:sessionID==='foreign'?'/other':'/test/project'}};
          },
          context: async ({sessionID}) => {
            assert.equal(sessionID, 's1');
            return [{type:'assistant',content:[{type:'reasoning',text:'private'},{type:'text',text:'V2 final result'}]}];
          }
        }
      };
      assert.equal(plugin.default.id, 'coding-agent-notify');
      const cleanup = plugin.default.setup(ctx);
      await new Promise(resolve => setTimeout(resolve, 100));
      cleanup();
      assert.equal(signal.aborted, true);
    `);
    await vi.waitFor(() => expect(f.pushEvent).toHaveBeenCalledOnce());
    expect(f.pushEvent.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining('V2 final result') });
    expect(JSON.stringify(f.pushEvent.mock.calls)).not.toContain('private');
  });

  it('DSH consumes native session events, filters subagents and skips interrupted turns', async () => {
    const f = await mounted();
    await f.invoke('install', 'dsh');
    await probe(join((await f.hooks.status('dsh')).detail, 'index.js'), `
      const handlers = new Map();
      const root = {session:{header:{id:'root',cwd:'/test/project'}}};
      const child = {session:{header:{id:'child'}}};
      plugin.apply({on:(event,fn)=>handlers.set(event,fn),get:()=>({roots:()=>[root]})});
      const message = (agent,turn,interrupted=false) => handlers.get('session/event')(agent.session,{type:'assistant/message',data:{turn,message:{content:[{type:'reasoning',text:'private'},{type:'text',text:'DSH result'}]},interrupted}});
      message(child,1); handlers.get('agent/turn-stopping')({agent:child,turn:1});
      message(root,1); handlers.get('agent/turn-stopping')({agent:root,turn:1});
      message(root,2,true); handlers.get('agent/turn-stopping')({agent:root,turn:2});
    `);
    await vi.waitFor(() => expect(f.pushEvent).toHaveBeenCalledOnce());
    expect(f.pushEvent.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining('DSH result') });
    expect(JSON.stringify(f.pushEvent.mock.calls)).not.toContain('private');
  });
});

it('matches Cortico metadata and has no runtime npm dependencies', async () => {
  const packageDir = fileURLToPath(new URL('..', import.meta.url));
  const report = await checkDescribe('world', definition, 'describe.json', { packageDir, scratchDir: (await fixture()).root });
  expect(report.failures).toEqual([]);
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
});

it('uses distinct settings titles and renders the configured notification prompt', async () => {
  const f = await fixture();
  const world = new CodingAgentNotifyWorld('Asia/Shanghai', f.hooks);
  const ui = world.webUi('zh');
  expect(ui.panels?.[0].title).toBe('Hook 安装与测试');
  const doc = ui.promptDocs![0];
  expect(doc.title).toBe('通知总结提示词');
  expect(doc.role).toBe('envPrompt');
  const original = (await readFile(doc.path, 'utf8')).trim();
  expect(original).toContain('pet_say');
  expect(await renderWorldEnvPrompt(world)).toEqual({ text: original, sourceKey: doc.key });
  const deploymentDir = join(f.root, 'deployment');
  const overrideDir = join(deploymentDir, 'worlds', world.id);
  await mkdir(overrideDir, { recursive: true });
  const override = '请只用一句话总结本轮结论，再调用 pet_say 通知用户。';
  await writeFile(join(overrideDir, 'ENV_PROMPT.md'), override);
  const result = await collectWorldContexts([world], { deploymentDir });
  expect(result.failed).toEqual([]);
  expect(result.contexts).toEqual([{ id: world.id, envPrompt: override, sourceKey: doc.key }]);
  await rm(join(overrideDir, 'ENV_PROMPT.md'));
  expect((await renderWorldEnvPrompt(world, { deploymentDir })).text).toBe(original);
});
