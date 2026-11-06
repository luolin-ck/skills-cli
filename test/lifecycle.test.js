import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { manage } from '../src/manager.js';

test('install creates the requested project skill with its complete content', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-skills-install-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  await manage('install', 'aesthetic-design', { agent: 'codex', scope: 'project', project }, {
    source: {
      latest: () => ({ version: '1.0.0', tag: 'v1.0.0', commit: 'a'.repeat(40) }),
      materialize: (entry, release, destination) => {
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, 'SKILL.md'), '---\nname: aesthetic-design\n---\nInstructions\n');
        fs.writeFileSync(path.join(destination, 'VERSION'), '1.0.0\n');
      }
    }
  });
  const destination = path.join(project, '.agents/skills/aesthetic-design');
  assert.equal(fs.existsSync(path.join(destination, 'SKILL.md')), true,
    'install must create the selected skill, not merely return successfully');
  assert.equal(fs.readFileSync(path.join(destination, 'VERSION'), 'utf8'), '1.0.0\n');
});
