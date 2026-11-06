import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { manage, snapshot, launchHost } from '../src/manager.js';
import { parseArguments } from '../src/cli.js';
import { fixture, write } from './helpers.js';

const name = 'aesthetic-design';
const statePath = f => path.join(f.store, name + '.json');
const installed = async t => { const f = fixture(t); f.publish('1.0.0'); await manage('install', name, f.options, f.context); return f; };

test('both hosts and both scopes use correct directories; repeated install is a content/state no-op', async t => {
  const f = fixture(t); f.publish('1.0.0');
  for (const agent of ['codex', 'claude']) for (const scope of ['user', 'project']) {
    const options = { agent, scope, ...(scope === 'project' ? { project: f.project } : {}) };
    const base = scope === 'user' ? f.homeDir : f.project, folder = agent === 'codex' ? '.agents' : '.claude';
    const target = path.join(base, folder, 'skills', name), record = path.join(base, folder, 'skills/.ck-skills', name + '.json');
    const first = await manage('install', name, options, f.context);
    assert.equal(first.status, 'installed'); assert.equal(first.version, '1.0.0');
    const before = snapshot(target), beforeRecord = fs.readFileSync(record, 'utf8');
    const second = await manage('install', name, options, { ...f.context, source: { latest: () => { throw Error('Repeated install must stay offline'); } } });
    assert.equal(second.status, 'already-installed'); assert.deepEqual(snapshot(target), before);
    assert.equal(fs.readFileSync(record, 'utf8'), beforeRecord);
    assert.equal(fs.readdirSync(target).includes('.ck-skills'), false);
  }
});

test('a newly created stable tag actually updates the installed skill; same tag is no-op', async t => {
  const f = await installed(t); const oldCommit = JSON.parse(fs.readFileSync(statePath(f))).commit;
  const nextCommit = f.publish('1.1.0', { annotated: true });
  const next = await manage('update', name, f.options, f.context);
  assert.equal(next.version, '1.1.0'); assert.equal(next.commit, nextCommit); assert.notEqual(nextCommit, oldCommit);
  assert.equal(fs.readFileSync(path.join(f.target, 'references/detail.md'), 'utf8'), 'Version 1.1.0\n');
  assert.equal((await manage('update', name, f.options, f.context)).status, 'up-to-date');
});

test('retag and downgrade fail while the recorded old install remains intact', async t => {
  const f = await installed(t), before = snapshot(f.target), state = fs.readFileSync(statePath(f), 'utf8');
  f.publish('1.0.0', { force: true, content: 'retag' });
  await assert.rejects(manage('update', name, f.options, f.context), /tag moved/);
  assert.deepEqual(snapshot(f.target), before); assert.equal(fs.readFileSync(statePath(f), 'utf8'), state);
  f.publish('1.1.0'); await manage('update', name, f.options, f.context); const newest = snapshot(f.target);
  f.git(['tag', '-d', 'v1.1.0']);
  await assert.rejects(manage('update', name, f.options, f.context), /downgrade/);
  assert.deepEqual(snapshot(f.target), newest);
});

test('uninstall touches only the selected owned target and preserves another skill', async t => {
  const f = await installed(t);
  write(f.project, '.agents/skills/unrelated/SKILL.md', 'An unrelated skill');
  const result = await manage('uninstall', name, f.options, f.context);
  assert.equal(result.status, 'uninstalled'); assert.equal(fs.existsSync(f.target), false); assert.equal(fs.existsSync(statePath(f)), false);
  assert.equal(fs.readFileSync(path.join(f.project, '.agents/skills/unrelated/SKILL.md'), 'utf8'), 'An unrelated skill');
  assert.equal((await manage('list', undefined, f.options, f.context)).skills[0].status, 'not-installed');
});

test('unowned target, target link, parent link and unknown manager directory are never adopted', async t => {
  for (const scenario of ['unowned', 'target-link', 'parent-link', 'unknown-store']) {
    const f = fixture(t); f.publish('1.0.0'); const sentinel = path.join(f.root, 'sentinel'); fs.mkdirSync(sentinel); write(sentinel, 'keep', 'safe');
    if (scenario === 'unowned') write(f.project, '.agents/skills/aesthetic-design/keep', 'safe');
    if (scenario === 'target-link') { fs.mkdirSync(path.dirname(f.target), { recursive: true }); fs.symlinkSync(sentinel, f.target); }
    if (scenario === 'parent-link') fs.symlinkSync(sentinel, path.join(f.project, '.agents'));
    if (scenario === 'unknown-store') write(f.project, '.agents/skills/.ck-skills/keep', 'safe');
    await assert.rejects(manage('install', name, f.options, f.context));
    assert.equal(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8'), 'safe');
    if (scenario === 'unowned') assert.equal(fs.readFileSync(path.join(f.target, 'keep'), 'utf8'), 'safe');
  }
});

test('modified, added, missing or symlinked content blocks update and uninstall without losing changes', async t => {
  for (const change of ['modified', 'added', 'missing', 'link']) {
    const f = await installed(t);
    if (change === 'modified') write(f.target, 'references/detail.md', 'my edit');
    if (change === 'added') write(f.target, 'my-notes.txt', 'my edit');
    if (change === 'missing') fs.unlinkSync(path.join(f.target, 'VERSION'));
    if (change === 'link') fs.symlinkSync('VERSION', path.join(f.target, 'alias'));
    await assert.rejects(manage('update', name, f.options, f.context));
    await assert.rejects(manage('uninstall', name, f.options, f.context));
    assert.equal(fs.existsSync(f.target), true);
    assert.equal((await manage('list', undefined, f.options, f.context)).skills[0].status, 'blocked');
  }
});

test('state links, damaged state and traversing ownership entries cannot authorize removal', async t => {
  for (const change of ['link', 'bad-json', 'traversal', 'stale-version']) {
    const f = await installed(t); const sentinel = path.join(f.root, 'outside.json'); write(f.root, 'outside.json', 'safe');
    if (change === 'link') { fs.unlinkSync(statePath(f)); fs.symlinkSync(sentinel, statePath(f)); }
    if (change === 'bad-json') write(f.store, name + '.json', '{broken');
    if (change === 'traversal') { const state = JSON.parse(fs.readFileSync(statePath(f))); state.files[0].path = '../outside.json'; write(f.store, name + '.json', JSON.stringify(state)); }
    if (change === 'stale-version') { const state = JSON.parse(fs.readFileSync(statePath(f))); state.version = '2.0.0'; write(f.store, name + '.json', JSON.stringify(state)); }
    await assert.rejects(manage('uninstall', name, f.options, f.context));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'safe'); assert.equal(fs.existsSync(f.target), true);
  }
});

test('fetch and manifest failures keep the old install and ownership bytes unchanged', async t => {
  const f = await installed(t), before = snapshot(f.target), state = fs.readFileSync(statePath(f), 'utf8');
  await assert.rejects(manage('update', name, f.options, { ...f.context, source: { latest: () => { throw Error('network fixture'); } } }), /network fixture/);
  f.publish('1.1.0', { afterManifest: repo => write(repo, 'references/detail.md', 'hash mismatch') });
  await assert.rejects(manage('update', name, f.options, f.context), /hash\/size mismatch/);
  assert.deepEqual(snapshot(f.target), before); assert.equal(fs.readFileSync(statePath(f), 'utf8'), state);
  assert.equal(fs.existsSync(path.join(f.store, 'journal.json')), false);
});

test('failures after directory/state transitions roll back update and uninstall exactly', async t => {
  const f = await installed(t); f.publish('1.1.0');
  for (const operation of ['update', 'uninstall']) for (const point of ['after-backup', 'after-install', 'before-state', 'after-state']) {
    const before = snapshot(f.target), state = fs.readFileSync(statePath(f), 'utf8');
    await assert.rejects(manage(operation, name, f.options, { ...f.context, failpoint: step => { if (step === point) throw Error('injected ' + step); } }), /injected/);
    assert.deepEqual(snapshot(f.target), before); assert.equal(fs.readFileSync(statePath(f), 'utf8'), state);
    assert.deepEqual(fs.readdirSync(f.store).sort(), [name + '.json', 'format.json'].sort());
  }
});

test('journal/staging residues fail closed and preserve recovery evidence', async t => {
  const f = await installed(t);
  write(f.store, 'journal.json', '{"operation":"interrupted"}');
  await assert.rejects(manage('uninstall', name, f.options, f.context), /unfinished transaction/);
  assert.equal(fs.existsSync(f.target), true); assert.equal(fs.existsSync(path.join(f.store, 'journal.json')), true);
  fs.unlinkSync(path.join(f.store, 'journal.json')); fs.mkdirSync(path.join(f.store, '.txn-interrupted'));
  await assert.rejects(manage('update', name, f.options, f.context), /unfinished transaction/);
});

test('initial install failure restores absence, but committed cleanup failure preserves the new version and backup', async t => {
  const f = fixture(t); f.publish('1.0.0');
  await assert.rejects(manage('install', name, f.options, { ...f.context, failpoint: p => { if (p === 'after-state') throw Error('initial fault'); } }), /initial fault/);
  assert.equal(fs.existsSync(f.target), false); assert.equal(fs.existsSync(statePath(f)), false);
  await manage('install', name, f.options, f.context); f.publish('1.1.0');
  await assert.rejects(manage('update', name, f.options, { ...f.context, failpoint: p => { if (p === 'before-cleanup') throw Error('cleanup fault'); } }), /Change completed/);
  assert.equal(fs.readFileSync(path.join(f.target, 'VERSION'), 'utf8').trim(), '1.1.0');
  assert.equal(JSON.parse(fs.readFileSync(statePath(f))).version, '1.1.0');
  assert.equal(fs.existsSync(path.join(f.store, 'journal.json')), false);
  const retained = fs.readdirSync(f.store).find(n => n.startsWith('.txn-'));
  assert.equal(fs.readFileSync(path.join(f.store, retained, 'previous/VERSION'), 'utf8').trim(), '1.0.0');
  await assert.rejects(manage('update', name, f.options, f.context), /unfinished transaction/);
});

test('an actual process exit after state replacement leaves old files and old state recoverable and blocks the next mutation', async t => {
  const f = await installed(t); f.publish('1.1.0');
  const managerURL = new URL('../src/manager.js', import.meta.url).href;
  const sourceURL = new URL('../src/source.js', import.meta.url).href;
  const script = `import {manage} from ${JSON.stringify(managerURL)}; import {git,createSource} from ${JSON.stringify(sourceURL)};
const [repo,homeDir,project]=process.argv.slice(1); const repository='https://github.com/luolin-ck/aesthetic-design.git';
const source=createSource((args,options)=>git(args.map(a=>a===repository?repo:a),{...options,allowLocal:true}));
await manage('update','aesthetic-design',{agent:'codex',scope:'project',project},{homeDir,cwd:project,source,failpoint:p=>{if(p==='after-state')process.exit(91);}});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.repo, f.homeDir, f.project], { shell: false, timeout: 120000 });
  assert.equal(result.status, 91, result.stderr?.toString());
  const journal = JSON.parse(fs.readFileSync(path.join(f.store, 'journal.json')));
  const transaction = path.join(f.store, journal.transaction);
  assert.equal(JSON.parse(fs.readFileSync(path.join(transaction, 'prior-state.json'))).version, '1.0.0');
  assert.equal(fs.readFileSync(path.join(transaction, 'previous/VERSION'), 'utf8').trim(), '1.0.0');
  assert.equal(fs.readFileSync(path.join(f.target, 'VERSION'), 'utf8').trim(), '1.1.0');
  await assert.rejects(manage('uninstall', name, f.options, f.context), /locked/);
  assert.equal((await manage('list', undefined, f.options, f.context)).skills[0].status, 'busy-or-recovery');
});

test('cooperating operations exclude one another while a host session holds the lock', async t => {
  const f = await installed(t); let finish, launched;
  const started = new Promise(resolve => { launched = resolve; });
  const using = manage('use', name, f.options, { ...f.context, launch: () => { launched(); return new Promise(resolve => { finish = resolve; }); } });
  await started;
  await assert.rejects(manage('uninstall', name, f.options, f.context), /locked/);
  finish(0); assert.equal((await using).exitCode, 0);
  assert.equal((await manage('uninstall', name, f.options, f.context)).status, 'uninstalled');
});

test('use rejects user/project/ancestor same-name aliases and SKILL file links before launch', async t => {
  const f = await installed(t); let calls = 0;
  const context = { ...f.context, launch: () => { calls++; return 0; } };
  write(f.homeDir, '.agents/skills/alias/SKILL.md', '---\nname: aesthetic-design\n---\nOther copy');
  await assert.rejects(manage('use', name, f.options, context), /same frontmatter name/); assert.equal(calls, 0);
  fs.rmSync(path.join(f.homeDir, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(f.project, '.git'));
  const nested = path.join(f.project, 'nested'); fs.mkdirSync(nested);
  const userOptions = { agent: 'codex', scope: 'user' };
  await manage('install', name, userOptions, f.context);
  await assert.rejects(manage('use', name, userOptions, { ...context, cwd: nested }), /same-name skill/); assert.equal(calls, 0);
  fs.rmSync(path.join(f.project, '.agents/skills/aesthetic-design'), { recursive: true });
  fs.mkdirSync(path.join(f.project, '.agents/skills/linked-skill'));
  fs.symlinkSync(path.join(f.homeDir, '.agents/skills/aesthetic-design/SKILL.md'), path.join(f.project, '.agents/skills/linked-skill/SKILL.md'));
  await assert.rejects(manage('use', name, userOptions, { ...context, cwd: nested }), /safely inspect/);
});

test('real mock Codex and Claude receive one literal prompt and preserve exits without a shell', async t => {
  const f = fixture(t); f.publish('1.0.0'); const mocks = path.join(f.root, 'mock-bin'); fs.mkdirSync(mocks);
  const capture = path.join(f.root, 'capture.json'), sentinel = path.join(f.root, 'MUST-NOT-EXIST');
  const script = `#!${process.execPath}\nimport('node:fs').then(fs => { fs.writeFileSync(process.env.CK_SKILLS_CAPTURE, JSON.stringify(process.argv.slice(2))); if (process.env.CK_SKILLS_SIGNAL) process.kill(process.pid, process.env.CK_SKILLS_SIGNAL); else process.exit(Number(process.env.CK_SKILLS_EXIT || '0')); });\n`;
  for (const agent of ['codex', 'claude']) { write(mocks, agent, script); fs.chmodSync(path.join(mocks, agent), 0o755); }
  const hostile = `literal $(touch ${sentinel}) \`touch ${sentinel}\`\n--dangerously-bypass-approvals-and-sandbox --help`;
  for (const agent of ['codex', 'claude']) {
    const options = { ...f.options, agent, prompt: hostile };
    await manage('install', name, options, f.context);
    const result = await manage('use', name, options, { ...f.context, launch: (binary, prompt, cwd) => launchHost(binary, prompt, cwd, { ...process.env, PATH: mocks, CK_SKILLS_CAPTURE: capture, CK_SKILLS_EXIT: '17' }) });
    assert.equal(result.exitCode, 17);
    const args = JSON.parse(fs.readFileSync(capture)); assert.equal(args.length, 1);
    assert.ok(args[0].startsWith((agent === 'codex' ? '$' : '/') + name)); assert.ok(args[0].includes(hostile)); assert.ok(args[0].includes('SKILL.md'));
    assert.equal(fs.existsSync(sentinel), false);
  }
  assert.equal(await launchHost('codex', 'literal', f.project, { ...process.env, PATH: mocks, CK_SKILLS_CAPTURE: capture, CK_SKILLS_SIGNAL: 'SIGTERM' }), 143);
  await assert.rejects(launchHost('codex', 'literal', f.project, { ...process.env, PATH: path.join(f.root, 'absent') }), /not installed/);
});

test('a non-Git parent alias or an unreadable candidate blocks use without launching', async t => {
  const f = fixture(t); f.publish('1.0.0'); let calls = 0;
  const options = { agent: 'codex', scope: 'user' };
  await manage('install', name, options, f.context);
  const nested = path.join(f.project, 'nested'); fs.mkdirSync(nested);
  write(f.project, '.agents/skills/alias/SKILL.md', '---\nname: aesthetic-design\n---\nAlias');
  const context = { ...f.context, cwd: nested, launch: () => { calls++; return 0; } };
  await assert.rejects(manage('use', name, options, context), /same frontmatter name/); assert.equal(calls, 0);
  const candidate = path.join(f.project, '.agents/skills/alias/SKILL.md');
  fs.chmodSync(candidate, 0);
  try { if (process.getuid?.() !== 0) await assert.rejects(manage('use', name, options, context), /EACCES/); }
  finally { fs.chmodSync(candidate, 0o644); }
  assert.equal(calls, 0);
});

test('argument parser keeps use text after -- as data, rejects unknown/missing options and invalid scope combinations', async t => {
  assert.equal(parseArguments(['use', name, '--', '--help']).options.prompt, '--help');
  for (const args of [['install'], ['delete', name], ['install', name, '--force'], ['install', name, '--agent'], ['list', name], ['use', name, 'unseparated text']]) assert.throws(() => parseArguments(args));
  const f = fixture(t); f.publish('1.0.0');
  await assert.rejects(manage('install', name, { scope: 'user', project: f.project }, f.context), /requires --scope project/);
  await assert.rejects(manage('install', '../outside', f.options, f.context), /Unknown registered/);
});

test('Claude description-only unrelated skill is allowed but a same-name folder still conflicts', async t => {
  const f = fixture(t); f.publish('1.0.0'); let calls = 0;
  const options = { ...f.options, agent: 'claude' };
  const context = { ...f.context, launch: () => { calls++; return 0; } };
  await manage('install', name, options, f.context);
  write(f.project, '.claude/skills/other-skill/SKILL.md', '---\ndescription: Another valid Claude skill\n---\nOther instructions');
  assert.equal((await manage('use', name, options, context)).exitCode, 0);
  assert.equal(calls, 1);
  write(f.homeDir, '.claude/skills/aesthetic-design/SKILL.md', '---\ndescription: A conflicting Claude skill\n---\nOther instructions');
  await assert.rejects(manage('use', name, options, context), /same-name skill/);
  assert.equal(calls, 1);
});

test('normal process-group SIGINT and parent-only SIGTERM release the use lock without double Ctrl-C forwarding', async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const f = await installed(t), mocks = path.join(f.root, 'mock-bin'); fs.mkdirSync(mocks);
    const capture = path.join(f.root, 'signals.json');
    const mock = `#!${process.execPath}\nconst fs=require('node:fs'); const file=process.env.CK_SKILLS_SIGNALS; const received=[]; fs.writeFileSync(file,JSON.stringify(received)); for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{received.push(signal);fs.writeFileSync(file,JSON.stringify(received));setTimeout(()=>process.exit(signal==='SIGINT'?130:143),40);});setInterval(()=>{},1000);\n`;
    write(mocks, 'codex', mock); fs.chmodSync(path.join(mocks, 'codex'), 0o755);
    const managerURL = new URL('../src/manager.js', import.meta.url).href;
    const script = `import {manage} from ${JSON.stringify(managerURL)}; const [homeDir,project]=process.argv.slice(1); const result=await manage('use','aesthetic-design',{agent:'codex',scope:'project',project},{homeDir,cwd:project}); process.exitCode=result.exitCode;`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.homeDir, f.project], { detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: mocks, CK_SKILLS_SIGNALS: capture } });
    let stderr = ''; child.stderr.on('data', b => { stderr += b; });
    try {
      const exit = once(child, 'exit', { signal: AbortSignal.timeout(30000) });
      for (let i = 0; !fs.existsSync(capture) && child.exitCode === null && child.signalCode === null && i < 1000; i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(fs.existsSync(capture), true, 'Mock host must start before signaling: ' + stderr);
      if (signal === 'SIGINT') process.kill(-child.pid, signal); else child.kill(signal);
      const [code, receivedSignal] = await exit;
      assert.equal(code ?? (128 + ({ SIGINT: 2, SIGTERM: 15 }[receivedSignal] || 1)), signal === 'SIGINT' ? 130 : 143);
      assert.equal(fs.existsSync(path.join(f.store, '.lock')), false, 'normal host interruption must release its manager lock');
      assert.deepEqual(JSON.parse(fs.readFileSync(capture)), [signal]);
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
});
