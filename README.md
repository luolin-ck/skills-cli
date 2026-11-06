# ck-skills

[中文](README.zh-CN.md) · [Maintenance and recovery](MAINTENANCE.md) · [Changelog](CHANGELOG.md)

Install, update, uninstall, and invoke the author's registered skills with local Codex or Claude Code. CLI version **0.1.0** is separate from each skill's version. The initial catalog contains [aesthetic-design](https://github.com/luolin-ck/aesthetic-design); new skills are added through reviewed catalog changes and a new CLI release. It does not discover every repository in the account.

## Install the CLI

Use a currently supported Node.js LTS release, **minimum Node 22**, and Git on PATH. No npm runtime dependencies, install hooks, model keys, or background updater are included.

```sh
npm install -g --ignore-scripts 'git+https://github.com/luolin-ck/skills-cli.git#v0.1.0'
ck-skills --version
ck-skills --help
```

The Git URL installs this public repository; no npm registry package publication is required. To remove the CLI itself, run `npm uninstall -g @luolin-ck/skills-cli`. Removing the CLI leaves installed skills intact. Reinstall the CLI if you want it to remove those skills safely.

The release is tested on macOS arm64 with Node 24. Linux is designed to be compatible but has not been run here. Native Windows is rejected; WSL/Linux has not been verified. Git access needs normal HTTPS connectivity; custom Git configuration is deliberately isolated rather than bypassing TLS verification.

## Manage a skill

Commands default to `--agent codex --scope user`:

```sh
ck-skills list
ck-skills install aesthetic-design
ck-skills update aesthetic-design
ck-skills use aesthetic-design -- 'Compare this design with Bauhaus and Swiss Style.'
ck-skills uninstall aesthetic-design
```

For Claude Code, add `--agent claude`. Install for one existing project instead of your user account with `--scope project --project <directory>`:

```sh
ck-skills install aesthetic-design --agent claude --scope project --project .
ck-skills use aesthetic-design --agent claude --scope project --project . -- 'Explain the visible style and the nearest alternative.'
ck-skills update aesthetic-design --agent claude --scope project --project .
ck-skills uninstall aesthetic-design --agent claude --scope project --project .
```

For project scope, an omitted `--project` means the current directory. `--project` with user scope is rejected. For a user-scope skill, `cd` into the intended workspace before `use`. Each command manages one host and one scope; there is no implicit all-host operation.

| Command | Result |
| --- | --- |
| `list` | Offline registered catalog and selected-scope managed version/commit/status. It does not claim the listed version is the latest remote release. Busy/interrupted roots report `busy-or-recovery`. |
| `install <skill>` | Installs the latest stable tag. A matching existing managed install stays unchanged; use `update` to look for a later release. |
| `update <skill>` | Updates an unchanged managed install to the highest stable version. Same version/commit is a no-op; downgrades and a moved same-version tag are rejected. |
| `uninstall <skill>` | Removes only that unchanged managed copy and its ownership record. Other skills, host settings and credentials stay in place. |
| `use <skill> -- [prompt]` | Starts the local host with a single initial prompt containing the skill invocation, exact installed SKILL path and your text. No implicit install or update. |

Unknown names/options and missing parameters fail. Put prompt text after `--`; quote shell metacharacters at your shell, as in the examples. The CLI does not interpret prompt text as shell code or additional host flags.

## Install locations and protections

| Host | User scope | Project scope |
| --- | --- | --- |
| Codex | `~/.agents/skills/<name>` | `<project>/.agents/skills/<name>` |
| Claude Code | `~/.claude/skills/<name>` | `<project>/.claude/skills/<name>` |

Ownership records and recovery data are next to the skills, under the corresponding `skills/.ck-skills/`, never inside the installed skill. The complete skill layout and bytes are preserved; the Git database is excluded. The aesthetic skill's public edition contains **9 images**, with **28 directions lacking offline visual comparators**. The private full-image collection is never downloaded or redistributed by this CLI. Read that skill's own limits and third-party notices.

- Only bundled, reviewed `luolin-ck` public HTTPS sources are accepted. Latest means the numerically highest stable `vMAJOR.MINOR.PATCH` Git tag, not the main branch or a prerelease. Annotated tags are peeled to a commit, and the fetched commit must match the selected one.
- The CLI reads Git blobs without checkout, checks regular-file modes and paths, and validates the exact public manifest file set, lengths and SHA-256. It never executes a downloaded validator, npm script, filter or hook. The first format contract is schema-3 `public-conservative` manifests; adding another format requires a reviewed CLI release.
- Existing unowned directories, symbolic links, damaged ownership records and locally changed/added/missing files are refused. There is no force/adopt option. Back up edits and resolve the discrepancy before managing that copy.
- Mutations use a cooperative lock, staging, journal and backup. Ordinary pre-commit errors restore the old installation and ownership record. Interrupted processes and retained transactions block further operations pending [manual recovery](MAINTENANCE.md#interrupted-operations). Cleanup failure after commit retains the new version and backup; it does not roll back a committed installation.
- `use` holds the same scope lock until the host exits. It checks known user/project/ancestor same-name copies and readable frontmatter aliases, refusing ambiguity or unsafe inspection. In a Git project it stops at the nearest repository marker; outside Git it conservatively scans ancestors to the filesystem root. It does not edit host settings to resolve conflicts.

Git commands have a 120-second timeout; extracted packages are limited to 10,000 files, 32 MiB per file and 128 MiB total. These limits do not fully bound Git's network/disk resource use. TLS, commit pinning and a self-described manifest do not prove that a publisher is uncompromised or a skill is harmless. The sidecar is a local ownership marker, not a cryptographic credential. Cooperative locks and path checks are not a sandbox against a malicious process running as your user.

## Use and verification limits

Install and sign in to Codex or Claude Code through its own official CLI before using that host. `ck-skills` inherits the host's existing authentication, approval, sandbox and network settings; it does not weaken them. Missing binaries fail clearly. Child nonzero exits are returned; a signal is mapped to `128 + signal number`.

Terminal Ctrl-C reaches the host in the same process group without duplicate forwarding; the wrapper waits for the host to exit before releasing its lock. To terminate only the wrapper programmatically, use SIGTERM, which is forwarded to the host. Forced termination can still require recovery.

Plugin, enterprise, synced and other host-managed sources cannot all be enumerated here. Starting a host with an explicit skill prompt does not prove that its model correctly activated or followed that skill. Host policy can still disable it. This release was tested with real local mock executables, including literal shell-looking text, nonzero exits and signals; it did not run paid model sessions or measure classification accuracy.

Official host references: [Codex skills](https://learn.chatgpt.com/docs/build-skills), [Codex CLI](https://learn.chatgpt.com/docs/developer-commands), [Claude skills](https://code.claude.com/docs/en/skills), [Claude CLI](https://code.claude.com/docs/en/cli-reference). Runtime and installation references: [Node releases](https://nodejs.org/en/about/previous-releases), [npm Git installation](https://docs.npmjs.com/cli/v10/commands/npm-install/).

## Develop

```sh
npm test
npm pack --dry-run
```

Run these development commands from a repository checkout; the runtime package excludes tests. Tests use Node's test runner, real temporary Git repositories/tags, explicit internal test contexts, isolated directories and mock hosts. They do not repurpose HOME or CODEX_HOME, install into your real user skills, call a model, or require remote services. There is no test-specific production argument/environment override for the catalog or home directory; normal OS/Node home resolution still applies. See [maintenance](MAINTENANCE.md) and the [initial change record](changes/0.1.0.md) for version and real Red/Green evidence.

Original CLI code, tests and documentation use [MIT](LICENSE). Installed skills retain their own licenses and third-party conditions; the CLI does not grant rights over them. No affiliation with OpenAI or Anthropic is implied.
