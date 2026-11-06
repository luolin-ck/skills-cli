import fs from 'node:fs';
import { manage } from './manager.js';

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const help = `ck-skills ${version}
Manage registered skills for local Codex and Claude Code.

Usage:
  ck-skills list [options]
  ck-skills install <skill> [options]
  ck-skills update <skill> [options]
  ck-skills uninstall <skill> [options]
  ck-skills use <skill> [options] -- [prompt]

Options:
  --agent codex|claude    Local host (default: codex)
  --scope user|project    Installation scope (default: user)
  --project <directory>  Existing project directory; requires project scope
  --help                 Show help
  --version              Show the CLI version

No arbitrary sources, forced overwrites, host login, or model keys.
Use holds this manager's lock until the host exits. See README.md.
`;

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--version') return { version: true };
  const delimiter = args.indexOf('--');
  const control = delimiter < 0 ? args : args.slice(0, delimiter);
  if (!args.length || control.includes('--help')) return { help: true };
  const [command, ...rest] = args;
  if (!['list', 'install', 'update', 'uninstall', 'use'].includes(command)) throw new Error('Unknown command; run ck-skills --help');
  const options = {}, positional = []; let prompt = [];
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (value === '--') {
      if (command !== 'use') throw new Error('Only use accepts a prompt after --');
      prompt = rest.slice(i + 1); break;
    }
    if (value.startsWith('-')) {
      const key = { '--agent': 'agent', '--scope': 'scope', '--project': 'project' }[value];
      if (!key || options[key] !== undefined || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error('Unknown, duplicate or incomplete option: ' + value);
      options[key] = rest[++i];
    } else positional.push(value);
  }
  if (positional.length !== (command === 'list' ? 0 : 1)) throw new Error('Provide exactly one registered skill (no skill argument for list); put use prompt after --');
  if (command === 'use') options.prompt = prompt.join(' ');
  return { command, name: positional[0], options };
}

export async function runCLI(args, context) {
  const parsed = parseArguments(args);
  if (parsed.help) { console.log(help); return 0; }
  if (parsed.version) { console.log(version); return 0; }
  const result = await manage(parsed.command, parsed.name, parsed.options, context);
  if (result.skills) {
    for (const item of result.skills) console.log([item.name, item.status, item.version || '-', item.commit || '-', item.reason || ''].join('\t'));
  } else if (result.status !== 'host-exited') {
    console.log([result.status, parsed.name, result.version, result.commit].filter(Boolean).join(' '));
  }
  return result.exitCode || 0;
}
