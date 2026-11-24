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
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { WorldDefinition, WorldDescribe, WorldSection } from 'cortico/world.ts';
import { AGENTS, LABELS, REPLY_MODES, uiText, type Agent, type HookStatus, type ReplyConfigState, type TestResult } from './webui.ts';
import { LAUNCHERS, runtimeCommand, runtimeInvocation } from './hook-runtime.ts';

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
export function powershellArgs(command: string, args: string[], forwardInput = false) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  // Windows PowerShell 5.1 drops bare empty strings passed to native commands via `&`.
  const nativeArg = (value: string) => (value === '' ? quote('""') : quote(value));
  const isPath = command.includes('/') || command.includes('\\');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$utf8 = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = $utf8',
    '$OutputEncoding = $utf8',
    "$extraDirs = @()",
    "foreach ($scope in @('User', 'Machine')) { $regPath = [Environment]::GetEnvironmentVariable('Path', $scope); if ($regPath) { $extraDirs += ($regPath -split ';') } }",
    "if ($env:APPDATA) { $extraDirs += (Join-Path $env:APPDATA 'npm') }",
    "if ($env:LOCALAPPDATA) { $extraDirs += (Join-Path $env:LOCALAPPDATA 'pnpm'); $extraDirs += (Join-Path $env:LOCALAPPDATA 'Volta\\bin'); $extraDirs += (Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps') }",
    "if ($env:USERPROFILE) { $extraDirs += (Join-Path $env:USERPROFILE '.local\\bin'); $extraDirs += (Join-Path $env:USERPROFILE '.bun\\bin'); $extraDirs += (Join-Path $env:USERPROFILE 'scoop\\shims'); $extraDirs += (Join-Path $env:USERPROFILE '.cargo\\bin') }",
    "if ($env:VOLTA_HOME) { $extraDirs += (Join-Path $env:VOLTA_HOME 'bin') }",
    "if ($env:NVM_SYMLINK) { $extraDirs += $env:NVM_SYMLINK }",
    "if ($env:FNM_MULTISHELL_PATH) { $extraDirs += $env:FNM_MULTISHELL_PATH }",
    "$seen = @{}; $merged = [System.Collections.Generic.List[string]]::new()",
    "foreach ($dir in @(($env:PATH -split ';') + $extraDirs)) { $trimmed = if ($dir) { $dir.Trim() } else { '' }; if (-not $trimmed -or $seen.ContainsKey($trimmed.ToLowerInvariant())) { continue }; if ($trimmed -match '(^|[/\\\\])shims[/\\\\]?$' -and (Test-Path -LiteralPath (Join-Path $trimmed 'node.cmd') -PathType Leaf)) { $shim = Get-Content -LiteralPath (Join-Path $trimmed 'node.cmd') -Raw -ErrorAction SilentlyContinue; if ($shim -and $shim.Contains('CORTICO_NODE_EXE')) { continue } }; $seen[$trimmed.ToLowerInvariant()] = $true; $merged.Add($trimmed) }",
    "$env:PATH = $merged -join ';'",
    ...(isPath ? [
      `$target = ${quote(command)}`,
      "if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { [Console]::Error.WriteLine('__COOPANION_COMMAND_NOT_FOUND__'); exit 127 }",
    ] : [
      `$name = ${quote(command)}`,
      '$cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
      'if (-not $cmd) { $cmd = Get-Command $name -CommandType ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1 }',
      '$target = if ($cmd) { $cmd.Source } else { $null }',
      ...(command === 'codex' ? [
        "if (-not $target -and $env:USERPROFILE) { foreach ($rel in @('.vscode\\extensions', '.cursor\\extensions', '.windsurf\\extensions')) { $extDir = Join-Path $env:USERPROFILE $rel; if (Test-Path -LiteralPath $extDir -PathType Container) { $hit = Get-ChildItem -LiteralPath $extDir -Directory -Filter 'openai.chatgpt-*' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object { foreach ($arch in @('windows-x86_64', 'windows-arm64', 'win32-x64', 'win32-arm64')) { $exe = Join-Path $_.FullName \"bin\\$arch\\codex.exe\"; if (Test-Path -LiteralPath $exe -PathType Leaf) { $exe; break } } } | Select-Object -First 1; if ($hit) { $target = $hit; break } } } }",
      ] : []),
      "if (-not $target) { [Console]::Error.WriteLine('__COOPANION_COMMAND_NOT_FOUND__'); exit 127 }",
    ]),
    "$ErrorActionPreference = 'Continue'",
    ...(forwardInput
      ? [`([System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)).ReadToEnd() | & $target ${args.map(nativeArg).join(' ')}`]
      : [`& $target ${args.map(nativeArg).join(' ')}`]),
    'if ($null -eq $LASTEXITCODE) { exit 0 } else { exit $LASTEXITCODE }',
  ].join('; ');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function isMissingCommandError(error: unknown) {
  const failure = error as NodeJS.ErrnoException & { stderr?: string; message?: string };
  return failure.code === 'ENOENT'
    || Boolean(failure.stderr?.includes('__COOPANION_COMMAND_NOT_FOUND__'))
    || Boolean(failure.stderr?.includes('CommandNotFoundException'))
    || Boolean(failure.message?.includes('__COOPANION_COMMAND_NOT_FOUND__'));
}

export function enableCodexHooksToml(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (!text.trim()) return `[features]${eol}hooks = true${eol}`;
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((line) => /^[ \t]*\[features\][ \t]*(?:#.*)?$/.test(line));
  if (headerIdx !== -1) {
    let endIdx = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (/^[ \t]*\[/.test(lines[i])) { endIdx = i; break; }
    }
    for (let i = headerIdx + 1; i < endIdx; i++) {
      const match = lines[i].match(/^([ \t]*hooks[ \t]*=[ \t]*)(true|false)([ \t]*(?:#.*)?)$/);
      if (match) {
        if (match[2] === 'true') return text;
        lines[i] = `${match[1]}true${match[3]}`;
        return lines.join(eol);
      }
    }
    lines.splice(headerIdx + 1, 0, 'hooks = true');
    return lines.join(eol);
  }
  const inlineIdx = lines.findIndex((line) => /^[ \t]*features[ \t]*=[ \t]*\{/.test(line));
  if (inlineIdx !== -1) {
    const line = lines[inlineIdx];
    if (/\bhooks\s*=\s*true\b/.test(line)) return text;
    if (/\bhooks\s*=\s*false\b/.test(line)) {
      lines[inlineIdx] = line.replace(/\bhooks(\s*=\s*)false\b/, 'hooks$1true');
      return lines.join(eol);
    }
    const inlineMatch = line.match(/^([ \t]*features[ \t]*=[ \t]*\{)([^\r\n}]*)(\}[ \t]*(?:#.*)?)$/);
    if (inlineMatch) {
      const inner = inlineMatch[2].trim();
      lines[inlineIdx] = `${inlineMatch[1]}${inner ? ` ${inner}, hooks = true ` : ' hooks = true '}${inlineMatch[3]}`;
      return lines.join(eol);
    }
  }
  const trimmed = text.replace(/(?:\r?\n)+$/, '');
  return `${trimmed}${eol}${eol}[features]${eol}hooks = true${eol}`;
}

export interface CodingAgentNotifySection extends WorldSection {
  replyEnabled?: boolean;
  replyAgents?: Agent[];
}

export function replyCommandSpec(agent: Agent, sessionId: string, instruction: string): { command: string; args: string[] } | null {
  switch (agent) {
    case 'codex': return { command: 'codex', args: ['queue', '--thread', sessionId, '--message', instruction, '--resume'] };
    case 'claude': return { command: 'claude', args: ['--resume', sessionId, '--print', instruction] };
    case 'opencode': return { command: 'opencode', args: ['run', '--session', sessionId, instruction] };
    case 'agy': return { command: 'agy', args: ['--conversation', sessionId, '--print', instruction] };
    default: return null;
  }
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

function spawnNativeCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
  onExit?: (error?: Error) => void,
): Promise<void> {
  const childEnv = { ...process.env, ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const shell = WINDOWS ? 'powershell.exe' : env.SHELL || userInfo().shell || '/bin/sh';
  const shellArgs = WINDOWS
    ? powershellArgs(command, args)
    : ['-ilc', `command -v ${shellQuote(command)} >/dev/null || { printf '%s\\n' '__COOPANION_COMMAND_NOT_FOUND__' >&2; exit 127; }; exec ${[command, ...args].map(shellQuote).join(' ')}`];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(shell, shellArgs, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.stdin?.end();
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk).slice(-6000);
    });
    let settled = false;
    let exited = false;
    const finishExit = (error?: Error) => {
      if (exited) return;
      exited = true;
      onExit?.(error);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 1500);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
      finishExit(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const output = stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim().slice(-3000);
      const failure = code === 0
        ? undefined
        : new Error(`${command}: exited with ${code ?? signal ?? 'an error'}${output ? `\n${output}` : ''}`);
      if (!settled) {
        settled = true;
        if (failure) reject(failure);
        else resolve();
      }
      finishExit(failure);
    });
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
function hookTexts(hook: CommandHook | undefined): string[] {
  if (!hook) return [];
  const commands = [hook.command, hook.commandWindows, hook.args?.join(' ')].filter((value): value is string => Boolean(value));
  return commands.flatMap((command) => {
    const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/);
    return encoded ? [command, Buffer.from(encoded[1], 'base64').toString('utf16le')] : [command];
  });
}
function hookMatchesRunner(hook: CommandHook | undefined): boolean {
  return hookTexts(hook).some((text) => text.includes(RUNNER));
}

function managedHook(entries: HookEntry[]) {
  return entries.flatMap((entry) => entry.hooks ?? []).find(hookMatchesRunner);
}

interface HookOptions {
  homeDir?: string;
  hookDir?: string;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[], cwd?: string) => Promise<void>;
  dispatch?: (command: string, args: string[], cwd?: string, onExit?: (error?: Error) => void) => Promise<void>;
}
export class HookManager {
  readonly dir: string;
  readonly runner: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly paths: Record<Agent, string>;
  private readonly dshHome: string;
  private readonly profile: string;
  private readonly run: NonNullable<HookOptions['run']>;
  private readonly dispatch: NonNullable<HookOptions['dispatch']>;

  constructor(options: HookOptions = {}) {
    const home = options.homeDir ?? homedir();
    const env = options.env ?? process.env;
    const dshHome = env.DSH_HOME || join(home, '.dsh');
    this.env = { ...env, CODEX_HOME: env.CODEX_HOME || join(home, '.codex'), DSH_HOME: dshHome };
    this.dir = options.hookDir ?? this.env.COOPANION_AGENT_HOOK_HOME ?? join(home, '.coopanion', 'agent-hooks');
    this.runner = join(this.dir, RUNNER);
    this.dshHome = dshHome;
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
    this.run = options.run ?? (async (command, args, cwd) => { await nativeCommand(command, args, await this.runtimeEnv(), 120_000, cwd); });
    this.dispatch = options.dispatch ?? (async (command, args, cwd, onExit) => { await spawnNativeCommand(command, args, await this.runtimeEnv(), cwd, onExit); });
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

  private hint: Promise<string> | undefined;
  private runtimeHint() {
    return this.hint ??= this.nodePath().catch(() => '');
  }

  private async nodePath() {
    const marker = '__COOPANION_NODE__';
    const env = await this.runtimeEnv();
    // Single quotes avoid PowerShell 5.1 stripping double quotes when invoking node.exe; base64 keeps paths intact.
    const probe = `if (process.versions.electron || Number(process.versions.node.split('.')[0]) < 22) throw new Error('A standalone Node.js 22+ is required'); '${marker}' + Buffer.from(process.execPath).toString('base64')`;
    const { stdout } = await nativeCommand(NODE, ['-p', probe], env, 10_000);
    const line = stdout.split(/\r?\n/).reverse().find((value) => value.startsWith(marker));
    if (!line) throw new Error('No standalone Node.js 22+ found in the installation environment.');
    return Buffer.from(line.slice(marker.length), 'base64').toString('utf8');
  }

  private async enableCodexHooksConfig(codexDir: string) {
    const configPath = join(codexDir, 'config.toml');
    let current = '';
    try { current = await readFile(configPath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const updated = enableCodexHooksToml(current);
    if (updated !== current) await writeAtomic(configPath, updated);
  }

  private async hasHookAssets(hook: CommandHook | undefined) {
    if (!hook) return false;
    const usesLauncher = hookTexts(hook).some((text) => LAUNCHERS.some((name) => text.includes(name)));
    return !usesLauncher || (await Promise.all(LAUNCHERS.map((name) => exists(join(this.dir, name))))).every(Boolean);
  }

  private async dshProfileInstalled(profile: string): Promise<boolean> {
    try {
      const manifest = await readJson(join(this.dshHome, 'profiles', profile, 'package.json')) as { dsh?: { profile?: { bundles?: string[] } } };
      return Boolean(manifest.dsh?.profile?.bundles?.includes(DSH_NAME));
    } catch {
      return false;
    }
  }

  async status(agent: Agent): Promise<HookStatus> {
    let installed = false;
    if (await exists(this.runner)) {
      try {
        if (agent === 'codex' || agent === 'claude' || agent === 'muse' || agent === 'workbuddy') {
          installed = await this.hasHookAssets(managedHook(stopHooks(await readJson(this.paths[agent]))));
        } else if (agent === 'agy') {
          const entry = (await readJson(this.paths.agy))[ID] as { enabled?: boolean; Stop?: CommandHook[] } | undefined;
          installed = entry?.enabled !== false && await this.hasHookAssets(entry?.Stop?.find(hookMatchesRunner));
        } else if (agent === 'opencode') {
          installed = await exists(this.paths.opencode);
        } else if (await exists(join(this.paths.dsh, 'index.js'))) {
          installed = await this.dshProfileInstalled(this.profile)
            || (!this.env.COOPANION_DSH_PROFILE && await this.dshProfileInstalled('desktop'));
        }
      } catch { /* A missing or invalid agent configuration is not installed. */ }
    }
    return { id: agent, installed, detail: this.paths[agent] };
  }
  statuses() { return Promise.all(AGENTS.map((agent) => this.status(agent))); }

  async install(agent: Agent) {
    await writeAtomic(this.runner, await readFile(new URL('./hook.mjs', import.meta.url), 'utf8'));
    for (const name of LAUNCHERS) await writeAtomic(join(this.dir, name), await readFile(new URL(`./${name}`, import.meta.url), 'utf8'));
    const moduleUrl = JSON.stringify(pathToFileURL(this.runner).href);
    if (agent === 'codex' || agent === 'claude' || agent === 'muse' || agent === 'workbuddy') {
      const path = this.paths[agent];
      const settings = await readJson(path);
      const entries = stopHooks(settings);
      const hint = await this.runtimeHint();
      const hook: CommandHook = { type: 'command', command: runtimeCommand(this.runner, agent, hint, false), async: agent === 'muse', ...(agent !== 'muse' ? { timeout: 5 } : {}) };
      if (WINDOWS) {
        const invocation = runtimeInvocation(this.runner, agent, hint);
        if (agent === 'claude') {
          hook.command = invocation.command;
          hook.args = invocation.args;
        } else if (agent === 'workbuddy') {
          hook.command = runtimeCommand(this.runner, agent, hint);
        } else {
          hook.commandWindows = runtimeCommand(this.runner, agent, hint);
        }
      }
      const existing = managedHook(entries);
      if (existing) {
        delete existing.args;
        delete existing.commandWindows;
        Object.assign(existing, hook);
      } else entries.push({ hooks: [hook] });
      if (agent === 'codex') {
        try {
          await this.run('codex', ['features', 'enable', 'hooks']);
        } catch (error) {
          if (!isMissingCommandError(error)) throw error;
          await this.enableCodexHooksConfig(dirname(path));
        }
      }
      await writeAtomic(path, JSON.stringify({ ...settings, hooks: { ...settings.hooks as object, Stop: entries } }, null, 2) + '\n');
    } else if (agent === 'agy') {
      const settings = await readJson(this.paths.agy);
      const command = runtimeCommand(this.runner, agent, await this.runtimeHint());
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
      const profiles = new Set([this.profile, 'headless']);
      if (!this.env.COOPANION_DSH_PROFILE && await exists(join(this.dshHome, 'profiles', 'desktop', 'package.json'))) {
        profiles.add('desktop');
      }
      for (const profile of profiles) {
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
      if (!isMissingCommandError(error)) throw error;
      // Only a missing CLI falls back. Auth/model/permission failures stay failures.
      await this.notifyTest(agent, marker);
      return { coverage: 'notification-only' };
    }
  }

  async dispatchReply(agent: Agent, sessionId: string, instruction: string, workspace?: string, onExit?: (error?: Error) => void) {
    const spec = replyCommandSpec(agent, sessionId, instruction);
    if (!spec) throw new Error(`${LABELS[agent]} does not support follow-up replies.`);
    const cwd = workspace && await exists(workspace) ? workspace : undefined;
    if (this.dispatch.length >= 4) {
      await this.dispatch(spec.command, spec.args, cwd, onExit);
      return;
    }
    try {
      await this.dispatch(spec.command, spec.args, cwd);
      onExit?.();
    } catch (error) {
      onExit?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async notifyTest(agent: Agent, marker: string) {
    const invocation = runtimeInvocation(this.runner, agent, await this.runtimeHint());
    const env = { ...process.env, ...this.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
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

interface ReplyTarget {
  id: string;
  agent: Agent;
  sessionId: string;
  workspace: string;
}

const MAX_REPLY_TARGETS = 50;
const REPLY_TOOL_SCHEMA = {
  name: 'reply_coding_agent',
  tags: ['act'] as const,
  description: 'Send a user-confirmed choice or reply to an enabled Coding Agent session (up to 4 choices or yes/no confirmation only; never call automatically).',
  parameters: {
    type: 'object',
    properties: {
      targetId: { type: 'string', description: 'Reply target ID from the coding-agent.completed event (for example, "r1").' },
      instruction: { type: 'string', description: 'The user-confirmed choice or concise instruction to send to the agent session.' },
    },
    required: ['targetId', 'instruction'],
    additionalProperties: false,
  },
};

function normalizeReplyAgents(value: unknown): Agent[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set(value.filter((item): item is Agent => isAgent(item) && REPLY_MODES[item] !== 'unsupported'));
  return AGENTS.filter((agent) => selected.has(agent));
}

export class CodingAgentNotifyWorld implements World {
  readonly id = ID;
  private host: WorldHost | null = null;
  private server: Server | null = null;
  private token = '';
  private nextReplySeq = 0;
  private readonly testReports = new Map<Agent, { marker: string; received: () => void }>();
  private readonly replyTargets = new Map<string, ReplyTarget>();
  private readonly inFlightSessions = new Set<string>();
  private readonly defaultCfg: CodingAgentNotifySection = { enabled: true, replyEnabled: false, replyAgents: [] };
  private readonly configStore: { get(): CodingAgentNotifySection; persist(patch: Partial<CodingAgentNotifySection>): void };

  constructor(
    private readonly timezone: string,
    private readonly hooks = new HookManager(),
    configStore?: { get(): CodingAgentNotifySection; persist(patch: Partial<CodingAgentNotifySection>): void },
  ) {
    this.configStore = configStore ?? {
      get: () => this.defaultCfg,
      persist: (patch) => Object.assign(this.defaultCfg, patch),
    };
  }

  private replyState(): ReplyConfigState {
    const cfg = this.configStore.get();
    return { enabled: Boolean(cfg.replyEnabled), agents: normalizeReplyAgents(cfg.replyAgents) };
  }

  private isReplyEnabledFor(agent: Agent): boolean {
    if (REPLY_MODES[agent] === 'unsupported') return false;
    const state = this.replyState();
    return state.enabled && state.agents.includes(agent);
  }

  private registerReplyTarget(agent: Agent, sessionId: string, workspace: string): string {
    const id = `r${++this.nextReplySeq}`;
    this.replyTargets.set(id, { id, agent, sessionId, workspace });
    if (this.replyTargets.size > MAX_REPLY_TARGETS) {
      const oldest = this.replyTargets.keys().next().value;
      if (oldest) this.replyTargets.delete(oldest);
    }
    return id;
  }

  private replyTool(): ToolDef {
    return {
      ...REPLY_TOOL_SCHEMA,
      handler: async (args) => {
        const targetId = typeof args.targetId === 'string' ? args.targetId.trim() : '';
        const instruction = typeof args.instruction === 'string' ? args.instruction.trim() : '';
        if (!targetId || !instruction) {
          return { failed: true, text: 'targetId and instruction are required.' };
        }
        if (instruction.length > 4000) {
          return { failed: true, text: 'instruction must be 4000 characters or fewer.' };
        }
        const target = this.replyTargets.get(targetId);
        if (!target) {
          return { failed: true, text: `Unknown or expired reply target: ${targetId}.` };
        }
        if (!this.isReplyEnabledFor(target.agent)) {
          return { failed: true, text: `Follow-up replies are disabled for ${LABELS[target.agent]}.` };
        }
        const sessionKey = `${target.agent}:${target.sessionId}`;
        if (this.inFlightSessions.has(sessionKey)) {
          return { failed: true, text: `${LABELS[target.agent]} session ${target.sessionId} already has a follow-up instruction in flight.` };
        }
        this.inFlightSessions.add(sessionKey);
        try {
          await this.hooks.dispatchReply(target.agent, target.sessionId, instruction, target.workspace, (error) => {
            this.inFlightSessions.delete(sessionKey);
            if (error) this.host?.log.warn('Coding-agent follow-up command failed', { err: error.message });
          });
        } catch (error) {
          this.inFlightSessions.delete(sessionKey);
          const message = error instanceof Error ? error.message : String(error);
          return { failed: true, text: `Failed to dispatch instruction to ${LABELS[target.agent]}: ${message}` };
        }
        return REPLY_MODES[target.agent] === 'background-resume'
          ? `已向 ${LABELS[target.agent]} 会话（${target.sessionId}）后台发送指令，完成后会再次通知，可在命令行 /resume 查看。`
          : `已向 ${LABELS[target.agent]} 会话（${target.sessionId}）发送指令，完成后会再次通知。`;
      },
    };
  }

  tools(): ToolDef[] {
    return [this.replyTool()];
  }
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
    this.replyTargets.clear();
    this.inFlightSessions.clear();
    this.host = null;
  }

  webUi(language: Language = systemLanguage()): WorldWebUiDecl {
    const t = uiText(language);
    return {
      label: t.title,
      lamps: [{ label: t.title, state: this.server ? 'online' : 'offline' }],
      panels: [
        { id: 'hooks', title: t.hooksTitle, getMethods: ['state'] },
        { id: 'reply', title: t.replyTitle, getMethods: ['state'] },
      ],
      invoke: async (panel, method, args) => {
        if (panel !== 'hooks' && panel !== 'reply') throw new Error('Unknown panel');
        let testResult: TestResult | undefined;
        if (panel === 'reply') {
          if (method === 'setReply') {
            const payload = args[0];
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid reply settings');
            const current = this.replyState();
            const record = payload as { enabled?: unknown; agents?: unknown };
            if (record.enabled !== undefined && typeof record.enabled !== 'boolean') throw new Error('Invalid reply enabled flag');
            if (record.agents !== undefined && !Array.isArray(record.agents)) throw new Error('Invalid reply agents list');
            const nextEnabled = record.enabled ?? current.enabled;
            const nextAgents = record.agents !== undefined ? normalizeReplyAgents(record.agents) : current.agents;
            this.configStore.persist({ replyEnabled: nextEnabled, replyAgents: nextAgents });
          } else if (method !== 'state') {
            throw new Error('Unknown method');
          }
        } else if (method !== 'state') {
          const agent = args[0];
          if (!isAgent(agent)) throw new Error('Unknown agent');
          if (method === 'install') await this.hooks.install(agent);
          else if (method === 'test') testResult = await this.testAgent(agent);
          else throw new Error('Unknown method');
        }
        return {
          online: this.server !== null,
          agents: await this.hooks.statuses(),
          reply: this.replyState(),
          ...(testResult ? { testResult } : {}),
        };
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
      const replyTargetId = !test && sessionId && this.isReplyEnabledFor(agent)
        ? this.registerReplyTarget(agent, sessionId, workspace)
        : undefined;
      const replyGuide = replyTargetId
        ? REPLY_MODES[agent] === 'background-resume'
          ? `仅当结论提出 4 个选项以内的简单选择题或“是否同意/继续”这类简单判断题时，才通过 pet_ask 或 pet_say 询问用户；确认后调用 reply_coding_agent（targetId: ${replyTargetId}），禁止自动回复。后台续跑，可在命令行 /resume 查看。`
          : `仅当结论提出 4 个选项以内的简单选择题或“是否同意/继续”这类简单判断题时，才通过 pet_ask 或 pet_say 询问用户；确认后调用 reply_coding_agent（targetId: ${replyTargetId}），禁止自动回复。`
        : '当前未启用指令回传，不要提供可代为执行的操作选项。';
      await this.host!.pushEvent({
        type: 'coding-agent.completed', source: ID, senderKey: `${ID}.${body.agent}`,
        ts: nowIso(this.timezone),
        text: [
          test
            ? coverage === 'notification-only'
              ? `PATH 未检测到 ${agent} 命令，本次仅测试通知发送，请用 pet_say 告知用户已收到，并请用户手动测试 Agent 完成通知。`
              : `${LABELS[agent]} CLI 测试的原生 hook 回报已到达 Coopanion，请用 pet_say 简短通知用户已收到。`
            : `${LABELS[agent]} 已完成一轮任务。请将它的最终结论总结成一两句话，并用 pet_say 通知用户。${replyGuide}`,
          ...(workspace ? [`项目：${JSON.stringify(workspace)}`] : []),
          ...(test ? [] : ['最终结论：', body.summary.slice(0, 20_000)]),
        ].join('\n'),
        meta: {
          agent: body.agent,
          workspace,
          sessionId,
          test,
          ...(test ? { testCoverage: coverage } : {}),
          ...(replyTargetId ? { replyTargetId, replyMode: REPLY_MODES[agent] } : {}),
        },
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

const describe: WorldDescribe = {
  tools: [{
    ...REPLY_TOOL_SCHEMA,
    summary: {
      zh: '在用户明确确认后，向已勾选的 Coding Agent CLI 会话发送后续指令（仅用于 4 个选项以内的简单选择题或“是否同意/继续”这类简单判断题）。',
      en: 'Send a user-confirmed follow-up instruction to an enabled Coding Agent CLI session (simple multiple-choice up to 4 options or yes/no confirmation only).',
    },
  }],
  events: [{
    type: 'coding-agent.completed',
    description: { zh: 'Coding Agent 完成一轮任务并发来最终结论，请简要总结并通知用户。', en: 'A coding agent completed a task turn and sent its final conclusion. Summarize it briefly and notify the user.' },
    trigger: 'flush',
  }],
};
const definition: WorldDefinition<CodingAgentNotifySection> = {
  id: ID, get label() { return uiText(systemLanguage()).title; },
  defaults: () => ({ enabled: false, replyEnabled: false, replyAgents: [] }),
  create: (ctx) => new CodingAgentNotifyWorld(ctx.timezone, undefined, {
    get: () => ctx.cfg,
    persist: (patch) => ctx.persist(patch),
  }),
  describe,
};
export default definition;
