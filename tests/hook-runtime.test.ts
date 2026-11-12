import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HookManager } from '../index.ts';
import { LAUNCHERS, runtimeCommand } from '../hook-runtime.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workbuddy '中文 runtime-"));
  roots.push(root);
  const home = join(root, 'home');
  const config = join(home, '.workbuddy');
  const versions = join(config, 'binaries', 'node', 'versions');
  const receipt = join(root, 'receipt.json');
  const runner = join(root, 'coopanion-agent-hook.mjs');
  await mkdir(versions, { recursive: true });
  for (const name of LAUNCHERS) await copyFile(new URL(`../${name}`, import.meta.url), join(root, name));
  await writeFile(runner, `import { writeFileSync } from 'node:fs';
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c);
process.stdin.on('end', () => { writeFileSync(process.env.RECEIPT, JSON.stringify({
  input: JSON.parse(input), args: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE,
})); process.exit(Number(process.env.RETURN_CODE || 0)); });`);
  const bin = join(root, 'empty-path');
  await mkdir(bin);
  if (process.platform !== 'win32') await symlink('/bin/sh', join(bin, 'sh'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, WORKBUDDY_CONFIG_DIR: config,
    CODEBUDDY_CONFIG_DIR: '', CODEBUDDY_NODE_BIN: '', CODEBUDDY_CODE_NODE_PATH: '', WORKBUDDY_RESOURCES_PATH: '',
    COOPANION_HOOK_NODE: '', NODE_BINARY: '', npm_node_execpath: '', NVM_BIN: '', FNM_MULTISHELL_PATH: '', VOLTA_HOME: '', NVM_HOME: '',
    PATH: bin, ELECTRON_RUN_AS_NODE: '1', RECEIPT: receipt };
  return { root, home, config, versions, receipt, runner, env };
}

async function nodeAt(path: string) {
  await mkdir(join(path, '..'), { recursive: true });
  if (process.platform === 'win32') await copyFile(process.execPath, path);
  else await symlink(process.execPath, path);
}

function execute(command: string, env: NodeJS.ProcessEnv, input = { last_assistant_message: '恢复完成 ✅' }) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(command, { shell: true, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', c => stderr += c);
    child.on('error', reject);
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
    child.on('close', code => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

it.each(['codex', 'claude', 'muse', 'agy', 'workbuddy'] as const)('installs %s when host Node discovery fails', async (agent) => {
  const f = await fixture();
  const hooks = new HookManager({ homeDir: f.home, env: { PATH: f.env.PATH, SHELL: '/missing-shell' }, run: async () => {} });
  await hooks.install(agent);
  await hooks.install(agent);
  expect((await hooks.status(agent)).installed).toBe(true);
});

it.each([true, false])('uses WorkBuddy managed Node with no PATH Node (current marker: %s)', async (current) => {
  const f = await fixture();
  const node = process.platform === 'win32' ? 'node.exe' : 'bin/node';
  await nodeAt(join(f.versions, '22.22.2', node));
  if (current) await writeFile(join(f.versions, 'current'), '22.22.2');
  // PowerShell is supplied by Windows even when node.exe is absent from PATH.
  if (process.platform === 'win32') f.env.PATH += `;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`;
  const result = await execute(runtimeCommand(f.runner, 'workbuddy'), f.env);
  expect(result).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(await readFile(f.receipt, 'utf8'))).toEqual({
    input: { last_assistant_message: '恢复完成 ✅' }, args: ['workbuddy'],
  });
});

it.skipIf(process.platform === 'win32')('falls back from unusable managed Node to bundled resources and preserves exit status', async () => {
  const f = await fixture();
  await nodeAt(join(f.root, 'resources/runtime/node/bin/node'));
  const oldNode = join(f.versions, '18.0.0/bin/node');
  await mkdir(join(oldNode, '..'), { recursive: true });
  await writeFile(oldNode, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const result = await execute(runtimeCommand(f.runner, 'workbuddy'), { ...f.env,
    WORKBUDDY_RESOURCES_PATH: join(f.root, 'resources'), RETURN_CODE: '17' });
  expect(result.code).toBe(17);
  expect(JSON.parse(await readFile(f.receipt, 'utf8')).args).toEqual(['workbuddy']);
});

it.skipIf(process.platform === 'win32')('falls back to PATH Node when no managed runtime exists', async () => {
  const f = await fixture();
  await nodeAt(join(f.env.PATH, 'node'));
  expect((await execute(runtimeCommand(f.runner, 'workbuddy'), f.env)).code).toBe(0);
});

it.skipIf(process.platform === 'win32')('reports a missing runtime instead of writing a broken host Node path', async () => {
  const f = await fixture();
  const result = await execute(runtimeCommand(f.runner, 'workbuddy'), f.env);
  expect(result.code).toBe(127);
  expect(result.stderr).toContain('no compatible Node.js 22+');
});

it.skipIf(process.platform === 'win32').each(['codex', 'claude', 'muse', 'agy'] as const)('uses %s desktop-provided Node with no PATH Node or valid host hint', async (agent) => {
  const f = await fixture();
  const bundled = join(f.root, 'desktop-runtime/bin/node');
  await nodeAt(bundled);
  const result = await execute(runtimeCommand(f.runner, agent, join(f.root, 'missing-host-node')), {
    ...f.env, NODE_BINARY: bundled,
  });
  expect(result).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(await readFile(f.receipt, 'utf8')).args).toEqual([agent]);
});

it.skipIf(process.platform === 'win32')('skips old or bogus PATH nodes and tries the next PATH entry', async () => {
  const f = await fixture();
  await writeFile(join(f.env.PATH, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const later = join(f.root, 'later-path');
  await nodeAt(join(later, 'node'));
  expect((await execute(runtimeCommand(f.runner, 'claude'), { ...f.env, PATH: `${f.env.PATH}:${later}` })).code).toBe(0);
});

it.skipIf(process.platform === 'win32')('bounds a hung runtime probe and can fall back without consuming stdin', async () => {
  const f = await fixture();
  const hung = join(f.root, 'hung', 'node');
  await mkdir(join(hung, '..'), { recursive: true });
  await writeFile(hung, '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o700 });
  await nodeAt(join(f.env.PATH, 'node'));
  const before = Date.now();
  const result = await execute(runtimeCommand(f.runner, 'claude'), { ...f.env, NODE_BINARY: hung });
  expect(result.code).toBe(0);
  expect(Date.now() - before).toBeLessThan(3000);
  expect(JSON.parse(await readFile(f.receipt, 'utf8')).input.last_assistant_message).toBe('恢复完成 ✅');
});

it.skipIf(process.platform === 'win32')('uses a still-valid installation hint when the desktop omits PATH Node', async () => {
  const f = await fixture();
  const hint = join(f.root, 'discovered-at-install/node');
  await nodeAt(hint);
  expect((await execute(runtimeCommand(f.runner, 'agy', hint), f.env)).code).toBe(0);
});

it.skipIf(process.platform === 'win32')('does not launch an Electron desktop executable named by NODE_BINARY', async () => {
  const f = await fixture();
  const desktop = join(f.root, 'DesktopApp');
  const launched = join(f.root, 'desktop-launched');
  await writeFile(desktop, '#!/bin/sh\n: > "$LAUNCHED"\n', { mode: 0o700 });
  await nodeAt(join(f.env.PATH, 'node'));
  expect((await execute(runtimeCommand(f.runner, 'muse'), { ...f.env, NODE_BINARY: desktop, LAUNCHED: launched })).code).toBe(0);
  await expect(readFile(launched)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('recognizes an encoded Windows Claude command stored in args and checks launcher assets', async () => {
  const f = await fixture();
  const hooks = new HookManager({ homeDir: f.home, env: { SHELL: '/missing-shell' } });
  await hooks.install('claude');
  const file = (await hooks.status('claude')).detail;
  const settings = JSON.parse(await readFile(file, 'utf8'));
  const command = runtimeCommand(hooks.runner, 'claude', '', true).split(' ');
  settings.hooks.Stop[0].hooks[0] = { type: 'command', command: command[0], args: command.slice(1) };
  await writeFile(file, JSON.stringify(settings));
  expect((await hooks.status('claude')).installed).toBe(true);
  await rm(join(hooks.dir, LAUNCHERS[1]));
  expect((await hooks.status('claude')).installed).toBe(false);
});

it.skipIf(process.platform === 'win32')('finds a Node CLI ancestor when only system utilities are on PATH', async () => {
  const f = await fixture();
  for (const tool of ['readlink', 'ps', 'tr', 'date', 'sleep', 'grep']) {
    for (const prefix of ['/usr/bin', '/bin']) {
      try { await copyFile(join(prefix, tool), join(f.env.PATH, tool)); break; } catch {}
    }
  }
  const result = await execute(runtimeCommand(f.runner, 'muse'), f.env);
  expect(result.code).toBe(0);
  expect(JSON.parse(await readFile(f.receipt, 'utf8')).args).toEqual(['muse']);
});
