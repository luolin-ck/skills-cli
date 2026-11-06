#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('ck-skills requires Node.js 22 or later; use a currently supported LTS release.');
  process.exitCode = 1;
} else if (process.platform === 'win32') {
  console.error('Native Windows is not supported in this release.');
  process.exitCode = 1;
} else {
  try {
    const { runCLI } = await import('../src/cli.js');
    process.exitCode = await runCLI(process.argv.slice(2));
  } catch (error) {
    console.error('ck-skills: ' + error.message);
    process.exitCode = 1;
  }
}
