/** Native command hooks resolve their runtime where the agent executes them. */
import { dirname, join } from 'node:path';

const shQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const LAUNCHERS = ['coopanion-agent-launch.sh', 'coopanion-agent-launch.ps1'] as const;

export function runtimeInvocation(runner: string, agent: string, hint = '', windows = process.platform === 'win32') {
  if (!windows) return { command: '/bin/sh', args: [join(dirname(runner), LAUNCHERS[0]), runner, agent, hint] };
  const launcher = join(dirname(runner), LAUNCHERS[1]);
  // Encoding protects paths from both cmd.exe and the agent's own command parser.
  const script = `& ([ScriptBlock]::Create([System.IO.File]::ReadAllText(${psQuote(launcher)}))) -Runner ${psQuote(runner)} -Agent ${psQuote(agent)} -Hint ${psQuote(hint)}`;
  return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}

export function runtimeCommand(runner: string, agent: string, hint = '', windows = process.platform === 'win32') {
  const invocation = runtimeInvocation(runner, agent, hint, windows);
  return windows ? [invocation.command, ...invocation.args].join(' ') : [invocation.command, ...invocation.args].map(shQuote).join(' ');
}
