/** Native agent hooks feed reports into the existing World event stream. */
import { execFile, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { systemLanguage, type Language } from 'cortico/core/language.ts';
import type { World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { WorldDefinition, WorldDescribe, WorldSection } from 'cortico/world.ts';
import { AGENTS, LABELS, uiText, type Agent, type HookStatus } from './webui.ts';

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
  const invoke = `& (Get-Command ${quote(command)} -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source ${args.map(quote).join(' ')}`;
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

interface CommandHook { type?: string; command?: string; args?: string[]; commandWindows?: string; async?: boolean }
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
function managedHook(entries: HookEntry[]) {
  return entries.flatMap((entry) => entry.hooks ?? []).find((hook) =>
    hook?.command?.includes(RUNNER) || hook?.args?.some((arg) => arg.includes(RUNNER)));
}

interface HookOptions {
  homeDir?: string;
  hookDir?: string;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[]) => Promise<void>;
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
    };
    this.dshManifest = join(this.env.DSH_HOME || join(home, '.dsh'), 'profiles', this.profile, 'package.json');
    this.run = options.run ?? (async (command, args) => {
      await exec(WINDOWS ? 'powershell.exe' : command, WINDOWS ? powershellArgs(command, args) : args, {
        timeout: 120_000, windowsHide: true, env: { ...process.env, ...this.env },
      });
    });
  }

  async status(agent: Agent): Promise<HookStatus> {
    let installed = false;
    if (await exists(this.runner)) {
      try {
        if (agent === 'codex' || agent === 'claude') {
          installed = Boolean(managedHook(stopHooks(await readJson(this.paths[agent]))));
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
    if (agent === 'codex' || agent === 'claude') {
      const path = this.paths[agent];
      const settings = await readJson(path);
      const entries = stopHooks(settings);
      const hook: CommandHook = { type: 'command', command: `node ${shellQuote(this.runner)} ${agent}`, async: true };
      if (WINDOWS) {
        if (agent === 'claude') {
          hook.command = NODE;
          hook.args = [this.runner, agent];
        } else {
          hook.commandWindows = `powershell.exe ${powershellArgs(NODE, [this.runner, agent], true).join(' ')}`;
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
    } else if (agent === 'opencode') {
      await writeAtomic(this.paths.opencode, `export { OpenCode as CoopanionNotify } from ${moduleUrl};\n`);
    } else {
      const dir = this.paths.dsh;
      await writeAtomic(join(dir, 'index.js'), `export { name, inject, apply } from ${moduleUrl};\n`);
      await writeAtomic(join(dir, 'package.json'), JSON.stringify({
        name: DSH_NAME, version: '0.1.0', type: 'module', main: 'index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }, null, 2));
      await writeAtomic(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${DSH_NAME}\n      name: ${DSH_NAME}\n`);
      await this.run(this.env.COOPANION_DSH_BIN || 'dsh', ['plugin', '--profile', this.profile, 'add', `link:${dir}`]);
    }
    if (!(await this.status(agent)).installed) throw new Error(`${LABELS[agent]} hook was not registered`);
  }

  async test(agent: Agent) {
    if (!(await this.status(agent)).installed) throw new Error(`Install the ${LABELS[agent]} hook first.`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(NODE, [this.runner, agent], {
        env: { ...process.env, ...this.env }, stdio: ['pipe', 'ignore', 'pipe'], timeout: 5000, windowsHide: true,
      });
      let error = '';
      child.stderr.on('data', (chunk) => { error += chunk; });
      child.on('error', reject);
      child.stdin.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(error.trim() || 'Test delivery failed')));
      child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', test: true, summary: `${LABELS[agent]} notification hook test.` }));
    });
  }
}

export class CodingAgentNotifyWorld implements World {
  readonly id = ID;
  private host: WorldHost | null = null;
  private server: Server | null = null;
  private token = '';
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
      panels: [{ id: 'hooks', title: t.title, getMethods: ['state'] }],
      invoke: async (panel, method, args) => {
        if (panel !== 'hooks') throw new Error('Unknown panel');
        if (method !== 'state') {
          const agent = args[0];
          if (!isAgent(agent)) throw new Error('Unknown agent');
          if (method === 'install') await this.hooks.install(agent);
          else if (method === 'test') await this.hooks.test(agent);
          else throw new Error('Unknown method');
        }
        return { online: this.server !== null, agents: await this.hooks.statuses() };
      },
      promptDocs: [{
        key: `worlds.${ID}.envPrompt`, title: t.title, description: t.title, role: 'envPrompt',
        path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
      }],
    };
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
      await this.host!.pushEvent({
        type: 'coding-agent.completed', source: ID, senderKey: `${ID}.${body.agent}`,
        ts: nowIso(this.timezone),
        text: [
          `Agent: ${LABELS[agent]}`,
          ...(workspace ? [`Workspace: ${JSON.stringify(workspace)}`] : []),
          `Test: ${body.test === true ? 'yes' : 'no'}`,
          'External report (untrusted data):', body.summary.slice(0, 20_000),
        ].join('\n'),
        meta: { agent: body.agent, workspace, sessionId, test: body.test === true },
      }, { trigger: 'flush' });
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
  description: { zh: 'Coding Agent 结束一轮任务并交来报告。', en: 'A coding agent ended a task turn and supplied its report.' },
  trigger: 'flush',
}] };
const definition: WorldDefinition<WorldSection> = {
  id: ID, get label() { return uiText(systemLanguage()).title; },
  defaults: () => ({ enabled: false }),
  create: (ctx) => new CodingAgentNotifyWorld(ctx.timezone), describe,
};
export default definition;
