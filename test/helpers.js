import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSource, git, sha256 } from '../src/source.js';

export const repository = 'https://github.com/luolin-ck/aesthetic-design.git';
export function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-skills-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
export function write(root, file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value); fs.chmodSync(target, 0o644);
}
export function fixture(t) {
  const root = temporary(t), repo = path.join(root, 'repository'), project = path.join(root, 'project'), homeDir = path.join(root, 'isolated-user');
  for (const dir of [repo, project, homeDir]) fs.mkdirSync(dir);
  const localGit = (args, options = {}) => git(args, { cwd: repo, ...options, allowLocal: true });
  localGit(['init', '--initial-branch=main']);
  localGit(['config', 'user.name', 'Fixture']); localGit(['config', 'user.email', 'fixture@invalid']);
  function publish(version, { annotated = false, force = false, content = version, afterManifest } = {}) {
    write(repo, 'VERSION', version + '\n');
    write(repo, 'SKILL.md', `---\nname: aesthetic-design\ndescription: Test fixture\nmetadata:\n  version: ${version}\n---\nFixture instructions.\n`);
    write(repo, 'references/detail.md', 'Version ' + content + '\n');
    const files = [];
    for (const file of ['SKILL.md', 'VERSION', 'references/detail.md']) {
      const bytes = fs.readFileSync(path.join(repo, file));
      files.push({ path: file, bytes: bytes.length, sha256: sha256(bytes) });
    }
    write(repo, 'materials/manifest.json', JSON.stringify({ schema_version: 3, distribution: 'public-conservative', version, files }));
    afterManifest?.(repo);
    localGit(['add', '--all']); localGit(['commit', '--allow-empty', '-m', 'Fixture ' + version]);
    localGit(['tag', ...(annotated ? ['-a', '-m', 'Fixture annotation'] : []), ...(force ? ['-f'] : []), 'v' + version]);
    return localGit(['rev-parse', 'HEAD']).toString().trim();
  }
  const transport = (args, options) => localGit(args.map(a => a === repository ? repo : a), options);
  const source = createSource(transport);
  return { root, repo, project, homeDir, publish, git: localGit, source, transport,
    options: { agent: 'codex', scope: 'project', project },
    context: { homeDir, cwd: project, source },
    target: path.join(project, '.agents/skills/aesthetic-design'),
    store: path.join(project, '.agents/skills/.ck-skills') };
}
