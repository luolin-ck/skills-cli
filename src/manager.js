import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createSource, validateEntry, versionParts, compareVersions, safePath, sha256, frontmatterName, MAX_FILE, MAX_TOTAL } from './source.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../catalog.json', import.meta.url), 'utf8'));
if (catalog.schema_version !== 1 || !Array.isArray(catalog.skills)) throw new Error('Invalid bundled catalog');
catalog.skills.forEach(validateEntry);
if (new Set(catalog.skills.map(e => e.name)).size !== catalog.skills.length) throw new Error('Duplicate catalog name');

const exists = p => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const plain = (p, kind) => {
  const stat = exists(p);
  if (stat && (stat.isSymbolicLink() || !(kind === 'directory' ? stat.isDirectory() : stat.isFile()))) throw new Error('Expected a regular ' + kind + ': ' + p);
  return stat;
};

function directories(base, parts, create = false) {
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    if (!plain(current, 'directory')) {
      if (!create) return null;
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  return current;
}

export function snapshot(directory) {
  if (!plain(directory, 'directory')) throw new Error('Managed skill directory is missing');
  const files = [];
  let total = 0;
  function walk(folder, prefix) {
    for (const name of fs.readdirSync(folder).sort()) {
      const relative = safePath((prefix ? prefix + '/' : '') + name.normalize('NFC'));
      const item = path.join(folder, name), stat = fs.lstatSync(item);
      if (stat.isSymbolicLink()) throw new Error('A managed skill contains a symbolic link');
      if (stat.isDirectory()) {
        if (!fs.readdirSync(item).length) throw new Error('Unexpected empty directory in managed skill');
        walk(item, relative);
      } else if (stat.isFile()) {
        total += stat.size;
        if (stat.size > MAX_FILE || total > MAX_TOTAL || files.length >= 10000) throw new Error('Managed skill exceeds the file/size limit');
        files.push({ path: relative, bytes: stat.size, sha256: sha256(fs.readFileSync(item)), mode: stat.mode & 0o777 });
      } else throw new Error('A managed skill contains a special file');
    }
  }
  walk(directory, '');
  if (!files.length) throw new Error('Empty managed skill');
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function readJson(file, limit = 8 * 1024 * 1024) {
  const stat = plain(file, 'file');
  if (!stat || stat.size > limit) throw new Error('Missing or oversized metadata: ' + file);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Invalid JSON metadata: ' + file); }
}

function stateRecord(entry, release, files, options) {
  return { schema_version: 1, name: entry.name, agent: options.agent, scope: options.scope,
    repository: entry.repository, version: release.version, commit: release.commit, files };
}

function validateState(record, entry, options) {
  if (!record || record.schema_version !== 1 || record.name !== entry.name || record.agent !== options.agent || record.scope !== options.scope ||
      record.repository !== entry.repository || !/^[0-9a-f]{40}$/.test(record.commit) || !Array.isArray(record.files) || !record.files.length || record.files.length > 10000) throw new Error('Invalid ownership record');
  versionParts(record.version);
  const seen = new Set(); let total = 0;
  for (const item of record.files) {
    safePath(item.path); total += item.bytes;
    if (seen.has(item.path.toLowerCase()) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_FILE ||
        !/^[0-9a-f]{64}$/.test(item.sha256) || ![0o644, 0o755].includes(item.mode)) throw new Error('Invalid ownership file snapshot');
    seen.add(item.path.toLowerCase());
  }
  if (total > MAX_TOTAL) throw new Error('Ownership record exceeds the size limit');
  return record;
}

function readManaged(paths, entry, options, required = true) {
  const target = plain(paths.target, 'directory');
  const recordExists = plain(paths.state, 'file');
  if (!target && !recordExists && !required) return null;
  if (!target || !recordExists) throw new Error('Skill is missing or not owned by ck-skills; existing content is never adopted');
  const record = validateState(readJson(paths.state), entry, options);
  if (JSON.stringify(snapshot(paths.target)) !== JSON.stringify(record.files)) throw new Error('Managed skill was modified; preserve your edits and restore the recorded version before updating/removing/using it');
  const identity = frontmatterName(fs.readFileSync(path.join(paths.target, 'SKILL.md'), 'utf8'));
  if (fs.readFileSync(path.join(paths.target, 'VERSION'), 'utf8').trim() !== record.version || identity.name !== entry.name ||
      (identity.metadataVersion !== undefined && identity.metadataVersion !== record.version)) throw new Error('Ownership version/identity does not match the installed skill');
  return record;
}

function storeRoot(paths, create) {
  if (!directories(paths.base, [paths.hostFolder, 'skills'], create)) return false;
  const rootExists = plain(paths.store, 'directory');
  if (!rootExists) {
    if (!create) return false;
    fs.mkdirSync(paths.store, { mode: 0o700 });
    fs.writeFileSync(path.join(paths.store, 'format.json'), JSON.stringify({ tool: '@luolin-ck/skills-cli', schema_version: 1 }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const marker = readJson(path.join(paths.store, 'format.json'), 1024);
  if (marker.tool !== '@luolin-ck/skills-cli' || marker.schema_version !== 1) throw new Error('Unrecognized manager directory; no files were changed');
  return true;
}

function checkPending(paths) {
  // shortcut: interrupted transactions need manual recovery; add durable recovery before unattended repair.
  if (fs.readdirSync(paths.store).some(n => n === 'journal.json' || n.startsWith('.txn-'))) {
    throw new Error('An unfinished transaction needs manual recovery. Preserve the journal/backups in ' + paths.store + '; see MAINTENANCE.md');
  }
}

async function locked(paths, work) {
  const lock = path.join(paths.store, '.lock'), token = randomUUID();
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (e) {
    if (e.code === 'EEXIST') throw new Error('Manager is locked. Another operation or interrupted process owns ' + lock + '; inspect it before manual recovery');
    throw e;
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
    checkPending(paths);
    return await work();
  } finally {
    if (plain(lock, 'directory') && readJson(path.join(lock, 'owner.json'), 1024).token === token) fs.rmSync(lock, { recursive: true });
  }
}

function atomicState(paths, content, transaction) {
  plain(paths.state, 'file');
  if (content === null) {
    if (exists(paths.state)) fs.unlinkSync(paths.state);
  } else {
    const temporary = path.join(transaction, 'state-' + randomUUID());
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, paths.state);
  }
}

function change(paths, operation, transaction, newRecord, failpoint) {
  const journal = path.join(paths.store, 'journal.json');
  const priorState = plain(paths.state, 'file') ? fs.readFileSync(paths.state) : null;
  const old = path.join(transaction, 'previous'), incoming = path.join(transaction, 'incoming');
  let movedOld = false, movedNew = false, stateChanged = false;
  if (priorState !== null) fs.writeFileSync(path.join(transaction, 'prior-state.json'), priorState, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(transaction, 'journal-new'), JSON.stringify({ schema_version: 1, name: newRecord?.name || path.basename(paths.target), operation, transaction: path.basename(transaction), prior_state: priorState !== null }) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(path.join(transaction, 'journal-new'), journal);
  try {
    if (exists(paths.target)) { fs.renameSync(paths.target, old); movedOld = true; }
    failpoint('after-backup');
    if (operation !== 'uninstall') { fs.renameSync(incoming, paths.target); movedNew = true; }
    failpoint('after-install');
    failpoint('before-state');
    atomicState(paths, newRecord ? Buffer.from(JSON.stringify(newRecord, null, 2) + '\n') : null, transaction);
    stateChanged = true;
    failpoint('after-state');
    fs.unlinkSync(journal);
  } catch (error) {
    try {
      if (movedNew) fs.rmSync(paths.target, { recursive: true });
      if (movedOld) fs.renameSync(old, paths.target);
      if (stateChanged) atomicState(paths, priorState, transaction);
      fs.unlinkSync(journal);
    } catch (recovery) {
      throw new Error(`Operation failed and rollback needs manual recovery; preserve ${transaction} and ${journal}. ${recovery.message}`, { cause: error });
    }
    fs.rmSync(transaction, { recursive: true });
    throw error;
  }
  // The journal removal commits the change; cleanup errors must never roll it back.
  try { failpoint('before-cleanup'); fs.rmSync(transaction, { recursive: true }); } catch {
    const error = new Error('Change completed, but backup cleanup needs manual attention in ' + transaction);
    error.committed = true;
    throw error;
  }
}

function locations(options, context, name) {
  if (!['codex', 'claude'].includes(options.agent) || !['user', 'project'].includes(options.scope)) throw new Error('Choose --agent codex|claude and --scope user|project');
  if (options.scope === 'user' && options.project !== undefined) throw new Error('--project requires --scope project; use cd to select a workspace for user-scope use');
  const base = fs.realpathSync(options.scope === 'project' ? options.project || context.cwd : context.homeDir);
  if (!fs.statSync(base).isDirectory()) throw new Error('The selected base must be an existing directory');
  const hostFolder = options.agent === 'codex' ? '.agents' : '.claude';
  const skills = path.join(base, hostFolder, 'skills'), store = path.join(skills, '.ck-skills');
  return { base, hostFolder, skills, store, target: path.join(skills, name || 'unused'), state: path.join(store, (name || 'unused') + '.json') };
}

function ancestors(cwd) {
  const chain = []; let current = fs.realpathSync(cwd);
  while (true) {
    chain.push(current);
    if (exists(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

export function checkConflicts(paths, entry, options, context) {
  const roots = new Set([fs.realpathSync(context.homeDir), ...ancestors(options.scope === 'project' ? paths.base : context.cwd)]);
  for (const base of roots) {
    const directory = directories(base, [paths.hostFolder, 'skills']);
    if (!directory) continue;
    for (const name of fs.readdirSync(directory).sort()) {
      if (name === '.ck-skills') continue;
      const candidate = path.join(directory, name);
      if (candidate === paths.target) continue;
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
      if (name === entry.name) throw new Error('A same-name skill conflicts with the selected copy: ' + candidate);
      const skill = path.join(candidate, 'SKILL.md');
      const info = exists(skill);
      if (!info) continue;
      if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) throw new Error('Cannot safely inspect a local skill candidate: ' + skill);
      const other = frontmatterName(fs.readFileSync(skill, 'utf8'), { checkMetadata: false, ...(options.agent === 'claude' ? { defaultName: name } : {}) }).name;
      if (other === entry.name) throw new Error('A skill with the same frontmatter name conflicts: ' + candidate);
    }
  }
}

export function launchHost(agent, prompt, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(agent, [prompt], { cwd, env, shell: false, stdio: 'inherit' });
    let terminating = false;
    // Terminal Ctrl-C already reaches the same-group child; forwarding it would interrupt twice.
    const interrupt = () => {};
    const terminate = () => { terminating = true; child.kill('SIGTERM'); };
    const cleanup = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    child.once('error', error => {
      cleanup();
      reject(new Error(error.code === 'ENOENT' ? `${agent} is not installed/on PATH; install and sign in through its official CLI` : `Host could not start: ${error.code || error.message}`));
    });
    child.once('close', (code, signal) => {
      cleanup();
      const exit = code ?? (128 + (os.constants.signals[signal] || 1));
      resolve(terminating && exit === 0 ? 143 : exit);
    });
  });
}

export async function manage(command, name, options = {}, injected = {}) {
  const context = { homeDir: os.homedir(), cwd: process.cwd(), source: createSource(), launch: launchHost, failpoint: () => {}, ...injected };
  options = { agent: 'codex', scope: 'user', ...options };
  const entry = catalog.skills.find(e => e.name === name);
  if (command !== 'list' && !entry) throw new Error('Unknown registered skill: ' + String(name));
  const paths = locations(options, context, name);
  if (command === 'list') {
    const ready = storeRoot(paths, false);
    const busy = ready && fs.readdirSync(paths.store).some(n => n === '.lock' || n === 'journal.json' || n.startsWith('.txn-'));
    return { skills: catalog.skills.map(item => {
      const current = locations(options, context, item.name);
      try {
        if (!ready) {
          if (exists(current.target)) return { name: item.name, status: 'unmanaged' };
          return { name: item.name, status: 'not-installed' };
        }
        const record = readManaged(current, item, options, false);
        return { name: item.name, status: busy ? 'busy-or-recovery' : record ? 'managed' : 'not-installed', ...(record ? { version: record.version, commit: record.commit } : {}) };
      } catch (error) { return { name: item.name, status: 'blocked', reason: error.message }; }
    }) };
  }
  if (!['install', 'update', 'uninstall', 'use'].includes(command)) throw new Error('Unknown command');
  if (!storeRoot(paths, command === 'install')) throw new Error('No managed installation exists in the selected scope');
  return locked(paths, async () => {
    const old = readManaged(paths, entry, options, command !== 'install');
    if (command === 'use') {
      checkConflicts(paths, entry, options, context);
      const marker = options.agent === 'codex' ? '$' : '/';
      const prompt = `${marker}${entry.name}\nUse the installed skill at ${JSON.stringify(path.join(paths.target, 'SKILL.md'))}. If that exact skill cannot be loaded, stop and explain rather than substituting a same-name skill.\n\n${options.prompt || ''}`;
      const exitCode = await context.launch(options.agent, prompt, options.scope === 'project' ? paths.base : context.cwd);
      return { status: 'host-exited', exitCode };
    }
    if (command === 'install' && old) return { status: 'already-installed', version: old.version, commit: old.commit };
    let release;
    if (command !== 'uninstall') {
      release = context.source.latest(entry);
      if (old) {
        const comparison = compareVersions(release.version, old.version);
        if (comparison < 0) throw new Error('Refusing to downgrade the installed skill');
        if (!comparison) {
          if (release.commit !== old.commit) throw new Error('The installed version tag moved to another commit; publish a new version instead');
          return { status: 'up-to-date', version: old.version, commit: old.commit };
        }
      }
    }
    const transaction = fs.mkdtempSync(path.join(paths.store, '.txn-'));
    try {
      let next = null;
      if (command !== 'uninstall') {
        const incoming = path.join(transaction, 'incoming');
        context.source.materialize(entry, release, incoming);
        next = stateRecord(entry, release, snapshot(incoming), options);
        validateState(next, entry, options);
      }
      directories(paths.base, [paths.hostFolder, 'skills']);
      if (old) readManaged(paths, entry, options); else if (exists(paths.target) || exists(paths.state)) throw new Error('Installation target appeared during download; refusing overwrite');
      change(paths, command, transaction, next, context.failpoint);
      return { status: command === 'uninstall' ? 'uninstalled' : command === 'update' ? 'updated' : 'installed', ...(release || { version: old.version, commit: old.commit }) };
    } catch (error) {
      if (!error.committed && !exists(path.join(paths.store, 'journal.json')) && exists(transaction)) fs.rmSync(transaction, { recursive: true });
      throw error;
    }
  });
}
