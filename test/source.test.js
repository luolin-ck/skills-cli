import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { selectRelease, parseTree, safePath, frontmatterName, gitEnvironment, git, createSource, validateEntry, MAX_FILE } from '../src/source.js';
import { fixture, repository, write } from './helpers.js';

const hash = n => n.repeat(40);
test('numeric stable tags and annotated peeling select the immutable commit', () => {
  const result = selectRelease(`${hash('a')}\trefs/tags/v1.9.0\n${hash('b')}\trefs/tags/v1.10.0\n${hash('c')}\trefs/tags/v1.10.0^{}\n${hash('d')}\trefs/tags/v2.0.0-rc.1\n`);
  assert.deepEqual(result, { version: '1.10.0', tag: 'v1.10.0', commit: hash('c') });
  assert.throws(() => selectRelease(`${hash('a')}\trefs/tags/v2.0.0-rc.1\n`), /No stable/);
});

test('unsafe tree paths, duplicate/case paths, links, submodules and excessive sizes are rejected', () => {
  for (const value of ['../outside', '/outside', 'a/../b', '.git/config', 'a\\b', 'a\nb', 'a\u202Efile', 'C:/file', 'a//b']) assert.throws(() => safePath(value));
  const row = (file, mode = '100644', size = 1) => `${mode} blob ${hash('a')} ${size}\t${file}\0`;
  for (const input of [row('../outside'), row('link', '120000'), `160000 commit ${hash('a')} -\tmodule\0`, row('x') + row('x'), row('A') + row('a'), row('a') + row('a/b'), row('huge', '100644', MAX_FILE + 1)]) assert.throws(() => parseTree(Buffer.from(input)));
  assert.equal(parseTree(Buffer.from(row('references/readme.md')))[0].path, 'references/readme.md');
});

test('duplicate/comment-hidden frontmatter identities and metadata cannot mask another value', () => {
  const header = lines => `---\n${lines}\n---\nBody`;
  for (const body of [
    'description: Registered sources still require a name',
    'name: aesthetic-design\nname: other # comment',
    'name: aesthetic-design\n"name": other',
    'name: aesthetic-design\nname : other',
    'name: aesthetic-design\nmetadata:\n  version: 1.0.0\nmetadata:\n  version: 2.0.0',
    'name: aesthetic-design\nmetadata:\n  version: 1.0.0\n  version: 2.0.0 # comment',
    'name: aesthetic-design\nmetadata:\n  "version": 2.0.0',
    'name: aesthetic-design\nmetadata: {version: 2.0.0}'
  ]) assert.throws(() => frontmatterName(header(body)));
  assert.equal(frontmatterName(header('name: aesthetic-design\nmetadata:\n  version: "1.0.0"')).metadataVersion, '1.0.0');
});

test('Git child ignores repository/config/TLS bypass environment but preserves normal proxy and home', t => {
  const f = fixture(t);
  const input = { ...process.env, GIT_DIR: '/not-the-fixture', GIT_WORK_TREE: '/outside', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/outside', GIT_SSL_NO_VERIFY: '1', HTTPS_PROXY: 'https://proxy.invalid' };
  const clean = gitEnvironment(input);
  assert.equal(clean.GIT_DIR, undefined); assert.equal(clean.GIT_SSL_NO_VERIFY, undefined);
  assert.equal(clean.GIT_CONFIG_COUNT, undefined); assert.equal(clean.HOME, process.env.HOME);
  assert.equal(clean.HTTPS_PROXY, input.HTTPS_PROXY);
  const actual = git(['rev-parse', '--git-dir'], { cwd: f.repo, env: input }).toString().trim();
  assert.equal(actual, '.git');
});

test('actual Git annotated release materializes the entire verified payload without repository metadata', t => {
  const f = fixture(t); const commit = f.publish('1.0.0', { annotated: true });
  const release = f.source.latest({ name: 'aesthetic-design', repository, manifest: 'materials/manifest.json' });
  assert.equal(release.commit, commit);
  const destination = path.join(f.root, 'materialized');
  f.source.materialize({ name: 'aesthetic-design', repository, manifest: 'materials/manifest.json' }, release, destination);
  assert.equal(fs.readFileSync(path.join(destination, 'references/detail.md'), 'utf8'), 'Version 1.0.0\n');
  assert.equal(fs.existsSync(path.join(destination, '.git')), false);
});

test('actual Git symlink and gitlink payloads fail before files are materialized', t => {
  const f = fixture(t); f.publish('1.0.0');
  f.publish('1.1.0', { afterManifest: repo => fs.symlinkSync('VERSION', path.join(repo, 'link')) });
  const entry = { name: 'aesthetic-design', repository, manifest: 'materials/manifest.json' };
  assert.throws(() => f.source.materialize(entry, f.source.latest(entry), path.join(f.root, 'link-result')), /regular Git blobs/);
  fs.unlinkSync(path.join(f.repo, 'link')); f.git(['add', '--all']);
  const commit = f.git(['rev-parse', 'HEAD']).toString().trim();
  f.git(['update-index', '--add', '--cacheinfo', `160000,${commit},module`]); f.git(['commit', '-m', 'Gitlink fixture']); f.git(['tag', 'v1.2.0']);
  assert.throws(() => f.source.materialize(entry, f.source.latest(entry), path.join(f.root, 'module-result')), /regular Git blobs/);
});

test('tag fetch race and corrupt manifest are rejected without destination creation', t => {
  const f = fixture(t); f.publish('1.0.0');
  const entry = { name: 'aesthetic-design', repository, manifest: 'materials/manifest.json' };
  const selected = f.source.latest(entry);
  f.publish('1.0.0', { force: true, content: 'retagged' });
  assert.throws(() => f.source.materialize(entry, selected, path.join(f.root, 'race')), /tag changed/);
  f.publish('1.1.0', { afterManifest: repo => write(repo, 'references/detail.md', 'tampered') });
  assert.throws(() => f.source.materialize(entry, f.source.latest(entry), path.join(f.root, 'bad-hash')), /hash\/size mismatch/);
  assert.equal(fs.existsSync(path.join(f.root, 'race')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'bad-hash')), false);
});

test('production catalog validation rejects unknown protocols, owner and manifest traversal', () => {
  for (const entry of [
    { name: '../outside', repository, manifest: 'manifest.json' },
    { name: 'aesthetic-design', repository: 'file:///tmp/source', manifest: 'manifest.json' },
    { name: 'aesthetic-design', repository: 'https://github.com/other/source.git', manifest: 'manifest.json' },
    { name: 'aesthetic-design', repository, manifest: '../manifest.json' }
  ]) assert.throws(() => validateEntry(entry));
});
