/** Native agent hooks feed reports into the existing World event stream. */
import { execFile, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { systemLanguage, type Language } from 'cortico/core/language.ts';
import type { World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { WorldDefinition, WorldDescribe, WorldSection } from 'cortico/world.ts';
import { AGENTS, LABELS, uiText, type Agent, type HookStatus, type TestResult } from './webui.ts';

const ID = 'coding-agent-notify';
const RUNNER = 'coopanion-agent-hook.mjs';
const DSH_NAME = 'coopanion-agent-notify-dsh';
const WINDOWS = process.platform === 'win32';
const NODE = WINDOWS ? 'node.exe' : 'node';
const exec = promisify(execFile);
const isAgent = (value: unknown): value is Agent => AGENTS.includes(value as Agent);
const shellQuote = (path: string) => WINDOWS
  ? `"${path.replaceAll('\\', '/')}"`
  : `'${path.replaceAll("'", "'\\''")}'`;

// Encode once so native Windows shells do not reinterpret paths or CLI arguments.
function powershellArgs(command: string, args: string[], forwardInput = false) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const isPath = command.includes('/') || command.includes('\\');
  const target = isPath
    ? quote(command)
    : `(Get-Command ${quote(command)} -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source`;
  const invoke = `& ${target} ${args.map(quote).join(' ')}`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    ...(forwardInput ? [
      '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      `([System.IO.StreamReader]::new([Console]::OpenStandardInput(), $OutputEncoding)).ReadToEnd() | ${invoke}`,
    ] : [invoke]),
    'exit $LASTEXITCODE',
  ].join('; ');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

// Let the OS shell resolve CLI paths, including those added by shell startup files.
function nativeCommand(command: string, args: string[], env: NodeJS.ProcessEnv, timeout = 120_000, cwd?: string) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const task = exec(WINDOWS ? 'powershell.exe' : env.SHELL || userInfo().shell || '/bin/sh',
    WINDOWS ? powershellArgs(command, args) : ['-ilc', `command -v ${shellQuote(command)} >/dev/null || { printf '%s\\n' '__COOPANION_COMMAND_NOT_FOUND__' >&2; exit 127; }; exec ${[command, ...args].map(shellQuote).join(' ')}`],
    { timeout, cwd, windowsHide: true, env: childEnv });
  // Prompts are passed as arguments. Signal EOF so Codex does not wait for stdin.
  task.child.stdin?.end();
  return task.catch((error) => {
    const failure = error as Error & { code?: string | number; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    const output = [failure.stdout, failure.stderr].filter(Boolean).join('\n')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim().slice(-3000);
    failure.message = `${command}: ${failure.killed ? `timed out after ${timeout / 1000}s` : `exited with ${failure.code ?? failure.signal ?? 'an error'}`}${output ? `\n${output}` : ''}`;
    throw failure;
  });
}

async function exists(file: string) {
  try { await access(file); return true; } catch { return false; }
}
async function writeAtomic(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600 });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
async function readJson(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file}: expected a JSON object`);
  return value as Record<string, unknown>;
}

interface CommandHook { type?: string; command?: string; args?: string[]; commandWindows?: string; async?: boolean; timeout?: number }
interface HookEntry { hooks?: CommandHook[] }
function stopHooks(settings: Record<string, unknown>): HookEntry[] {
  const hooks = settings.hooks;
  if (hooks === undefined) return [];
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('hooks must be an object');
  const entries = (hooks as Record<string, unknown>).Stop;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new Error('hooks.Stop must be an array');
  if (entries.some((entry) => !entry || !Array.isArray(entry.hooks))) throw new Error('Invalid Stop hook entry');
  return entries;
}
function hookMatchesRunner(hook: CommandHook | undefined): boolean {
  if (!hook) return false;
  if (hook.command?.includes(RUNNER) || hook.commandWindows?.includes(RUNNER)) return true;
  if (hook.args?.some((arg) => arg.includes(RUNNER))) return true;
  for (const cmd of [hook.command, hook.commandWindows]) {
    if (!cmd || !cmd.includes('-EncodedCommand')) continue;
    const match = cmd.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/);
    if (match) {
      try {
        const decoded = Buffer.from(match[1], 'base64').toString('utf16le');
        if (decoded.includes(RUNNER)) return true;
      } catch {}
    }
  }
  return false;
}

function managedHook(entries: HookEntry[]) {
  return entries.flatMap((entry) => entry.hooks ?? []).find(hookMatchesRunner);
}

interface HookOptions {
  homeDir?: string;
  hookDir?: string;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[], cwd?: string) => Promise<void>;
}
export class HookManager {
  readonly dir: string;
  readonly runner: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly paths: Record<Agent, string>;
  private readonly dshManifest: string;
  private readonly profile: string;
  private readonly run: NonNullable<HookOptions['run']>;

  constructor(options: HookOptions = {}) {
    const home = options.homeDir ?? homedir();
    const env = options.env ?? process.env;
    this.env = { ...env, CODEX_HOME: env.CODEX_HOME || join(home, '.codex'), DSH_HOME: env.DSH_HOME || join(home, '.dsh') };
    this.dir = options.hookDir ?? this.env.COOPANION_AGENT_HOOK_HOME ?? join(home, '.coopanion', 'agent-hooks');
    this.runner = join(this.dir, RUNNER);
    this.profile = this.env.COOPANION_DSH_PROFILE || 'web';
    const codex = this.env.CODEX_HOME || join(home, '.codex');
    this.paths = {
      codex: join(codex, 'hooks.json'),
      claude: join(this.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'),
      opencode: join(this.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'plugins', `${ID}.js`),
      dsh: join(this.dir, 'dsh-plugin'),
      muse: join(this.env.XDG_CONFIG_HOME || join(home, '.config'), 'muse', 'settings.json'),
      agy: join(home, '.gemini', 'config', 'hooks.json'),
      workbuddy: join(this.env.WORKBUDDY_CONFIG_DIR || join(home, '.workbuddy'), 'settings.json'),
    };
    this.dshManifest = join(this.env.DSH_HOME || join(home, '.dsh'), 'profiles', this.profile, 'package.json');
    this.run = options.run ?? (async (command, args, cwd) => { await nativeCommand(command, args, await this.runtimeEnv(), 120_000, cwd); });
  }

  private async runtimeEnv() {
    const env = { ...process.env, ...this.env };
    // Coopanion prepends a Node shim backed by Electron; external agents cannot use it.
    const paths = await Promise.all((env.PATH ?? '').split(delimiter).map(async (dir) => {
      if (!/(^|[/\\])shims[/\\]?$/.test(dir)) return dir;
      const shim = await readFile(join(dir, WINDOWS ? 'node.cmd' : 'node'), 'utf8').catch(() => '');
      return shim.includes('CORTICO_NODE_EXE') ? null : dir;
    }));
    env.PATH = paths.filter((dir) => dir !== null).join(delimiter);
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  private async nodePath() {
    const marker = '__COOPANION_NODE__';
    const env = await this.runtimeEnv();
    // Base64 keeps non-ASCII Windows paths intact across PowerShell output encodings.
    const probe = `if (process.versions.electron || Number(process.versions.node.split('.')[0]) < 22) throw new Error('A standalone Node.js 22+ is required'); ${JSON.stringify(marker)} + Buffer.from(process.execPath).toString('base64')`;
    const { stdout } = await nativeCommand(NODE, ['-p', probe], env, 10_000);
    const line = stdout.split(/\r?\n/).reverse().find((value) => value.startsWith(marker));
    if (!line) throw new Error('Cannot locate Node.js. Install Node.js 22+ before installing or testing hooks.');
    return Buffer.from(line.slice(marker.length), 'base64').toString('utf8');
  }

  async status(agent: Agent): Promise<HookStatus> {
    let installed = false;
    if (await exists(this.runner)) {
      try {
        if (agent === 'codex' || agent === 'claude' || agent === 'muse' || agent === 'workbuddy') {
          installed = Boolean(managedHook(stopHooks(await readJson(this.paths[agent]))));
        } else if (agent === 'agy') {
          const entry = (await readJson(this.paths.agy))[ID] as { enabled?: boolean; Stop?: CommandHook[] } | undefined;
          installed = entry?.enabled !== false && Boolean(entry?.Stop?.some(hookMatchesRunner));
        } else if (agent === 'opencode') {
          installed = await exists(this.paths.opencode);
        } else {
          const manifest = await readJson(this.dshManifest) as { dsh?: { profile?: { bundles?: string[] } } };
          installed = Boolean(manifest.dsh?.profile?.bundles?.includes(DSH_NAME))
            && await exists(join(this.paths.dsh, 'index.js'));
        }
      } catch { /* A missing or invalid agent configuration is not installed. */ }
    }
    return { id: agent, installed, detail: this.paths[agent] };
  }
  statuses() { return Promise.all(AGENTS.map((agent) => this.status(agent))); }

  async install(agent: Agent) {
    await writeAtomic(this.runner, await readFile(new URL('./hook.mjs', import.meta.url), 'utf8'));
    const moduleUrl = JSON.stringify(pathToFileURL(this.runner).href);
    if (agent === 'codex' || agent === 'claude' || agent === 'muse' || agent === 'workbuddy') {
      const path = this.paths[agent];
      const settings = await readJson(path);
      const entries = stopHooks(settings);
      const node = await this.nodePath();
      const hook: CommandHook = { type: 'command', command: `${shellQuote(node)} ${shellQuote(this.runner)} ${agent}`, async: agent === 'muse', ...(agent !== 'muse' ? { timeout: 5 } : {}) };
      if (WINDOWS) {
        if (agent === 'claude') {
          hook.command = node;
          hook.args = [this.runner, agent];
        } else if (agent === 'workbuddy') {
          hook.command = `powershell.exe ${powershellArgs(node, [this.runner, agent], true).join(' ')}`;
        } else {
          hook.commandWindows = `powershell.exe ${powershellArgs(node, [this.runner, agent], true).join(' ')}`;
        }
      }
      const existing = managedHook(entries);
      if (existing) {
        delete existing.args;
        delete existing.commandWindows;
        Object.assign(existing, hook);
      } else entries.push({ hooks: [hook] });
      if (agent === 'codex') await this.run('codex', ['features', 'enable', 'hooks']);
      await writeAtomic(path, JSON.stringify({ ...settings, hooks: { ...settings.hooks as object, Stop: entries } }, null, 2) + '\n');
    } else if (agent === 'agy') {
      const settings = await readJson(this.paths.agy);
      const node = await this.nodePath();
      const command = WINDOWS
        ? `powershell.exe ${powershellArgs(node, [this.runner, agent], true).join(' ')}`
        : `${shellQuote(node)} ${shellQuote(this.runner)} ${agent}`;
      // agy uses named definitions with a flat Stop handler array. Replace only ours.
      await writeAtomic(this.paths.agy, JSON.stringify({
        ...settings, [ID]: { Stop: [{ type: 'command', command, timeout: 5 }] },
      }, null, 2) + '\n');
    } else if (agent === 'opencode') {
      await writeAtomic(this.paths.opencode, `export { OpenCodePlugin as default } from ${moduleUrl};\n`);
    } else {
      const dir = this.paths.dsh;
      await writeAtomic(join(dir, 'index.js'), `export { name, inject, apply } from ${moduleUrl};\n`);
      await writeAtomic(join(dir, 'package.json'), JSON.stringify({
        name: DSH_NAME, version: '0.1.0', type: 'module', main: 'index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }, null, 2));
      await writeAtomic(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${DSH_NAME}\n      name: ${DSH_NAME}\n`);
      for (const profile of new Set([this.profile, 'headless'])) {
        await this.run('dsh', ['plugin', '--profile', profile, 'add', `link:${dir}`]);
      }
    }
    if (!(await this.status(agent)).installed) throw new Error(`${LABELS[agent]} hook was not registered`);
  }

  async test(agent: Agent, marker: string, cwd = this.dir): Promise<TestResult> {
    if (!(await this.status(agent)).installed) throw new Error(`Install the ${LABELS[agent]} hook first.`);
    const prompt = `This is a completion-hook delivery test. Do not use tools, read files or change anything. Reply with exactly: ${marker}`;
    const args: Record<Agent, string[]> = {
      codex: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', prompt],
      claude: ['--print', prompt, '--tools', ''],
      opencode: ['run', prompt],
      dsh: ['--profile', 'headless', prompt],
      muse: ['exec', prompt],
      agy: ['--print', prompt],
      workbuddy: ['--print', prompt],
    };
    try {
      await this.run(agent, args[agent], cwd);
      return { coverage: 'full' };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (!failure.stderr?.includes('__COOPANION_COMMAND_NOT_FOUND__')
        && !failure.stderr?.includes('CommandNotFoundException')) throw error;
      // Only a missing CLI falls back. Auth/model/permission failures stay failures.
      await this.notifyTest(agent, marker);
      return { coverage: 'notification-only' };
    }
  }

  private async notifyTest(agent: Agent, marker: string) {
    const node = await this.nodePath();
    const env = { ...process.env, ...this.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(node, [this.runner, agent], {
        env, stdio: ['pipe', 'ignore', 'pipe'], timeout: 5000, windowsHide: true,
      });
      let error = '';
      child.stderr.on('data', (chunk) => { error += chunk; });
      child.on('error', reject);
      child.stdin.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(error.trim() || 'Test delivery failed')));
      child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', test: true, summary: marker }));
    });
  }
}

export class CodingAgentNotifyWorld implements World {
  readonly id = ID;
  private host: WorldHost | null = null;
  private server: Server | null = null;
  private token = '';
  private readonly testReports = new Map<Agent, { marker: string; received: () => void }>();
  constructor(private readonly timezone: string, private readonly hooks = new HookManager()) {}
  tools() { return []; }
  envPromptVars() { return {}; }

  async start(host: WorldHost) {
    this.host = host;
    this.token = randomBytes(32).toString('hex');
    this.server = createServer((req, res) => { void this.receive(req, res); });
    this.server.requestTimeout = 5000;
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(0, '127.0.0.1', () => resolve());
      });
      const address = this.server.address();
      if (!address || typeof address === 'string') throw new Error('No receiver port');
      await writeAtomic(join(this.hooks.dir, 'endpoint.json'), JSON.stringify({
        url: `http://127.0.0.1:${address.port}/v1/completions`, token: this.token,
      }));
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const endpoint = join(this.hooks.dir, 'endpoint.json');
    try { if ((await readJson(endpoint)).token === this.token) await rm(endpoint); } catch {}
    this.host = null;
  }

  webUi(language: Language = systemLanguage()): WorldWebUiDecl {
    const t = uiText(language);
    return {
      label: t.title,
      lamps: [{ label: t.title, state: this.server ? 'online' : 'offline' }],
      panels: [{ id: 'hooks', title: t.hooksTitle, getMethods: ['state'] }],
      invoke: async (panel, method, args) => {
        if (panel !== 'hooks') throw new Error('Unknown panel');
        let testResult: TestResult | undefined;
        if (method !== 'state') {
          const agent = args[0];
          if (!isAgent(agent)) throw new Error('Unknown agent');
          if (method === 'install') await this.hooks.install(agent);
          else if (method === 'test') testResult = await this.testAgent(agent);
          else throw new Error('Unknown method');
        }
        return { online: this.server !== null, agents: await this.hooks.statuses(), ...(testResult ? { testResult } : {}) };
      },
      promptDocs: [{
        key: `worlds.${ID}.envPrompt`, title: t.promptTitle, description: t.promptDescription, role: 'envPrompt',
        path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
      }],
    };
  }

  private async testAgent(agent: Agent): Promise<TestResult> {
    if (!this.server) throw new Error('Start the World before testing.');
    if (this.testReports.has(agent)) throw new Error(`${LABELS[agent]} test is already running.`);
    const cwd = await mkdtemp(join(tmpdir(), 'coopanion-hook-test-'));
    const marker = `COOPANION_HOOK_TEST_${randomBytes(12).toString('hex')}`;
    const reported = new Promise<void>((received) => { this.testReports.set(agent, { marker, received }); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await this.hooks.test(agent, marker, cwd);
      await Promise.race([reported, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${LABELS[agent]} CLI finished, but no matching hook report reached Coopanion. Check hook approval and agent configuration.`)), 10_000);
      })]);
      return result;
    } finally {
      clearTimeout(timer);
      this.testReports.delete(agent);
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private async receive(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, value: object) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'POST' || req.url !== '/v1/completions') return reply(404, { error: 'not found' });
      const auth = req.headers.authorization ?? '';
      const expected = Buffer.from(`Bearer ${this.token}`);
      const received = Buffer.from(auth);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) return reply(401, { error: 'unauthorized' });
      let text = '';
      req.setEncoding('utf8');
      for await (const chunk of req) {
        text += chunk;
        if (Buffer.byteLength(text) > 128 * 1024) return reply(413, { error: 'report too large' });
      }
      const body = JSON.parse(text);
      if (!body || !isAgent(body.agent) || typeof body.summary !== 'string' || !body.summary.trim()) {
        return reply(400, { error: 'invalid completion' });
      }
      const agent: Agent = body.agent;
      const workspace = typeof body.workspace === 'string' ? body.workspace.slice(0, 2000) : '';
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 256) : '';
      const check = this.testReports.get(agent);
      const matched = check && body.summary.includes(check.marker);
      const test = body.test === true || Boolean(matched);
      const coverage = body.test === true ? 'notification-only' : 'full';
      await this.host!.pushEvent({
        type: 'coding-agent.completed', source: ID, senderKey: `${ID}.${body.agent}`,
        ts: nowIso(this.timezone),
        text: [
          test
            ? coverage === 'notification-only'
              ? `PATH 未检测到 ${agent} 命令，本次仅测试通知发送，请用 pet_say 告知用户已收到，并请用户手动测试 Agent 完成通知。`
              : `${LABELS[agent]} CLI 测试的原生 hook 回报已到达 Coopanion，请用 pet_say 简短通知用户已收到。`
            : `${LABELS[agent]} 已完成一轮任务。请将它的最终结论总结成一两句话，并用 pet_say 通知用户。`,
          ...(workspace ? [`项目：${JSON.stringify(workspace)}`] : []),
          ...(test ? [] : ['最终结论：', body.summary.slice(0, 20_000)]),
        ].join('\n'),
        meta: { agent: body.agent, workspace, sessionId, test, ...(test ? { testCoverage: coverage } : {}) },
      }, { trigger: 'flush' });
      if (matched) check.received();
      reply(202, { accepted: true });
    } catch (error) {
      if (error instanceof SyntaxError) return reply(400, { error: 'invalid JSON' });
      this.host?.log.warn('Coding-agent report delivery failed', error);
      if (!res.headersSent) reply(500, { error: 'delivery failed' });
    }
  }
}

const describe: WorldDescribe = { tools: [], events: [{
  type: 'coding-agent.completed',
  description: { zh: 'Coding Agent 完成一轮任务并发来最终结论，请简要总结并通知用户。', en: 'A coding agent completed a task turn and sent its final conclusion. Summarize it briefly and notify the user.' },
  trigger: 'flush',
}] };
const definition: WorldDefinition<WorldSection> = {
  id: ID, get label() { return uiText(systemLanguage()).title; },
  defaults: () => ({ enabled: false }),
  create: (ctx) => new CodingAgentNotifyWorld(ctx.timezone), describe,
};
export default definition;
