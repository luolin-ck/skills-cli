import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const MAX_FILE = 32 * 1024 * 1024;
export const MAX_TOTAL = 128 * 1024 * 1024;
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Expected a stable MAJOR.MINOR.PATCH version');
  }
  if (value.length > 80) throw new Error('Version is too long');
  return value.split('.').map(BigInt);
}

export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

export function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.normalize('NFC') !== value ||
      /[\\\p{Cc}\p{Cf}]/u.test(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) ||
      value.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) {
    throw new Error('Unsafe package path');
  }
  return value;
}

export function validateEntry(entry) {
  if (!entry || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name) || entry.name.length > 64 ||
      !/^https:\/\/github\.com\/luolin-ck\/[A-Za-z0-9][A-Za-z0-9._-]*\.git$/.test(entry.repository)) {
    throw new Error('Invalid registered skill');
  }
  safePath(entry.manifest);
  return entry;
}

export function gitEnvironment(input = process.env) {
  const env = Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
}

export function git(args, { cwd, input, allowLocal = false, env = process.env } = {}) {
  const result = spawnSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=',
    '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always', '-c', `protocol.file.allow=${allowLocal ? 'always' : 'never'}`,
    '-c', 'fetch.recurseSubmodules=false', '-c', 'transfer.fsckObjects=true',
    ...args
  ], { cwd, input, shell: false, env: gitEnvironment(env), timeout: 120000, maxBuffer: MAX_TOTAL + 4 * 1024 * 1024 });
  if (result.error) throw new Error(`Git could not run: ${result.error.code || result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr?.toString('utf8').trim().slice(0, 1200);
    throw new Error(`Git failed${detail ? ': ' + detail : ''}`);
  }
  return result.stdout;
}

export function selectRelease(output) {
  const refs = new Map();
  for (const line of output.toString('utf8').split('\n')) {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)))(\^\{\})?$/.exec(line);
    if (!match) continue;
    versionParts(match[3]);
    const entry = refs.get(match[2]) || { version: match[3], tag: match[2] };
    entry[match[4] ? 'peeled' : 'object'] = match[1];
    refs.set(match[2], entry);
  }
  const candidates = [...refs.values()].filter(r => r.object).sort((a, b) => compareVersions(b.version, a.version));
  if (!candidates.length) throw new Error('No stable vMAJOR.MINOR.PATCH tag is available');
  const winner = candidates[0];
  return { version: winner.version, tag: winner.tag, commit: winner.peeled || winner.object };
}

export function parseTree(output) {
  const entries = [], names = new Map();
  let total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const line of decoder.decode(output).split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([0-9a-f]{40}) +(\d+)\t(.+)$/.exec(line);
    if (!match) throw new Error('Only regular Git blobs are allowed; links and submodules are rejected');
    const file = safePath(match[4]), size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size > MAX_FILE) throw new Error('Package file exceeds the size limit');
    for (const component of [...file.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))]) {
      const key = component.toLowerCase();
      if (names.has(key) && names.get(key) !== component) throw new Error('Case-colliding package paths');
      names.set(key, component);
    }
    if (entries.some(e => e.path === file || e.path.startsWith(file + '/') || file.startsWith(e.path + '/'))) {
      throw new Error('Duplicate or conflicting package paths');
    }
    total += size;
    if (total > MAX_TOTAL || entries.length >= 10000) throw new Error('Package exceeds the total size/file limit');
    entries.push({ path: file, mode: match[1] === '100755' ? 0o755 : 0o644, oid: match[2], bytes: size });
  }
  if (!entries.length) throw new Error('Empty skill package');
  return entries;
}

export function frontmatterName(text, { checkMetadata = true, defaultName } = {}) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('SKILL.md must have frontmatter');
  const lines = match[1].split(/\r?\n/), keys = new Set();
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line)) continue;
    const key = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]|$)/.exec(line)?.[1];
    if (!key || keys.has(key)) throw new Error('Duplicate or unsupported frontmatter key');
    keys.add(key);
  }
  const names = [...match[1].matchAll(/^name:[ \t]*(?:"([^"]+)"|'([^']+)'|([^\s'"#]+))[ \t]*$/gm)];
  if (names.length !== 1 && !(names.length === 0 && defaultName !== undefined && !keys.has('name'))) throw new Error('SKILL.md must have one plain name');
  let metadataVersion;
  if (checkMetadata && keys.has('metadata')) {
    const start = lines.findIndex(line => /^metadata:/.test(line));
    if (lines[start].trim() !== 'metadata:') throw new Error('Unsupported metadata mapping');
    const nestedKeys = new Set();
    for (const line of lines.slice(start + 1)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      if (!/^\s/.test(line)) break;
      const item = /^ {2}([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
      if (!item || nestedKeys.has(item[1])) throw new Error('Duplicate or unsupported metadata key');
      nestedKeys.add(item[1]);
      if (item[1] === 'version') {
        metadataVersion = item[2].replace(/^(['"])([^'"\\]*)\1$/, '$2');
        versionParts(metadataVersion);
      }
    }
  }
  return { name: names.length ? names[0][1] || names[0][2] || names[0][3] : defaultName, header: match[1], metadataVersion };
}

export function verifyPayload(files, entry, release) {
  const map = new Map(files.map(f => [f.path, f]));
  if (!map.has('SKILL.md') || !map.has('VERSION') || !map.has(entry.manifest)) throw new Error('Required skill metadata is missing');
  const version = map.get('VERSION').data.toString('utf8').trim();
  versionParts(version);
  if (version !== release.version) throw new Error('VERSION differs from the selected stable tag');
  const { name, metadataVersion } = frontmatterName(map.get('SKILL.md').data.toString('utf8'));
  if (name !== entry.name) throw new Error('SKILL.md name differs from the registered skill');
  if (metadataVersion !== undefined && metadataVersion !== version) throw new Error('SKILL.md metadata version is inconsistent');
  let manifest;
  try { manifest = JSON.parse(map.get(entry.manifest).data.toString('utf8')); } catch { throw new Error('Invalid integrity manifest'); }
  if (manifest.schema_version !== 3 || manifest.version !== version || manifest.distribution !== 'public-conservative' || !Array.isArray(manifest.files)) {
    throw new Error('Unsupported public skill manifest; register a new format explicitly in a CLI release');
  }
  const expected = new Set();
  for (const item of manifest.files) {
    safePath(item.path);
    if (item.path === entry.manifest || expected.has(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error('Invalid manifest file entry');
    const actual = map.get(item.path);
    if (!actual || actual.data.length !== item.bytes || sha256(actual.data) !== item.sha256) throw new Error('Manifest file hash/size mismatch: ' + item.path);
    expected.add(item.path);
  }
  if (expected.size !== files.length - 1 || files.some(f => f.path !== entry.manifest && !expected.has(f.path))) throw new Error('Manifest file set does not match the complete package');
}

export function createSource(runGit = git) {
  return {
    latest(entry) { validateEntry(entry); return selectRelease(runGit(['ls-remote', '--tags', entry.repository])); },
    materialize(entry, release, destination) {
      validateEntry(entry);
      if (!/^[0-9a-f]{40}$/.test(release.commit) || release.tag !== 'v' + release.version) throw new Error('Invalid release identity');
      versionParts(release.version);
      const store = destination + '.git-store';
      try {
        runGit(['init', '--bare', store]);
        runGit(['fetch', '--depth=1', '--no-tags', entry.repository, 'refs/tags/' + release.tag], { cwd: store });
        const commit = runGit(['rev-parse', 'FETCH_HEAD^{commit}'], { cwd: store }).toString('utf8').trim();
        if (commit !== release.commit) throw new Error('The selected tag changed during fetch; nothing was installed');
        const entries = parseTree(runGit(['ls-tree', '-r', '-z', '-l', commit], { cwd: store }));
        const bytes = runGit(['cat-file', '--batch'], { cwd: store, input: entries.map(f => f.oid + '\n').join('') });
        let offset = 0;
        for (const file of entries) {
          const end = bytes.indexOf(10, offset);
          const head = bytes.subarray(offset, end).toString('ascii');
          if (end < offset || head !== `${file.oid} blob ${file.bytes}`) throw new Error('Unexpected Git blob response');
          offset = end + 1;
          file.data = bytes.subarray(offset, offset + file.bytes);
          if (file.data.length !== file.bytes || bytes[offset + file.bytes] !== 10) throw new Error('Truncated Git blob');
          offset += file.bytes + 1;
        }
        if (offset !== bytes.length) throw new Error('Unexpected trailing Git blob data');
        verifyPayload(entries, entry, release);
        fs.mkdirSync(destination, { mode: 0o700 });
        for (const file of entries) {
          const target = path.join(destination, file.path);
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
          fs.writeFileSync(target, file.data, { flag: 'wx', mode: file.mode });
          fs.chmodSync(target, file.mode);
        }
      } finally {
        fs.rmSync(store, { recursive: true, force: true });
      }
    }
  };
}
