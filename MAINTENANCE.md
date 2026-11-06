# Maintenance and recovery

[中文](MAINTENANCE.zh-CN.md) · [Usage](README.md)

## Versions and tests

`package.json` is the CLI version source. Skill versions come from their own stable Git tags and VERSION files. Do not change a published tag to point at new content. Every logical CLI/catalog change needs a new SemVer release, both changelogs, and `changes/<version>.md`, `.zh-CN.md` and shared `.json`. Keep previous records. Use patch for compatible corrections, minor for compatible capability additions and major for incompatible published commands/state formats. Earlier work has no invented version history.

Before implementation, state observable acceptance and write/run a meaningful failing check. Preserve the actual command, timestamp, expected/actual result and exit. An import failure alone is not evidence of an installer defect. Implement the smallest correction, then rerun relevant tests and record real results and limits. For a code change, exercise relevant rejection/failure paths as well as success. Do not claim a model activated a skill merely because a process started.

```sh
npm test
npm pack --dry-run
```

Use a supported Node LTS and Git. The test suite uses temporary real Git fixtures and explicit internal `homeDir`/source/launcher/fault contexts. It does not replace HOME or CODEX_HOME or expose production test flags/environment variables. The published CLI always uses its bundled catalog and real host home discovery. Keep raw audit outputs and downloaded runtimes outside the source/package; public change records contain truthful sanitized summaries.

Before release, inspect the full diff for unlogged changes, package file allowlist, executable modes, license scope and secret/private-path patterns. Run an actual temporary-prefix installation of the packed package. Any new catalog entry must use a reviewed public `luolin-ck` HTTPS repository, correct skill name, stable VERSION and supported schema-3 public manifest. A new packaging format requires explicit validation and tests, not silent fallback. Never package a private image archive. Publish only the exact independently reviewed Git tree, with a new version tag and no unrelated history or personal email. Verify the remote tag/files and actual Git-URL npm installation after publication.

## Ownership and ordinary failures

Each host/scope has `skills/.ck-skills/format.json`, one `<name>.json` ownership record and temporary transaction/lock data. Records contain relative file paths, sizes, SHA-256 and executable modes, version and commit. Targets are derived from known catalog names and the selected host/scope; a state file cannot select an arbitrary deletion directory.

An unowned, edited, missing or unsafe copy is refused. Preserve your own changes outside the host's skill search directories, and restore the expected installation/record pair before using manager operations. Do not fabricate a record to adopt unknown files. There is no force or adopt command. Successful uninstall removes only that verified skill and record; the manager directory/format marker may remain.

Write operations hold a cooperative lock. `use` holds it until its host exits, so another use/update/uninstall in the same host/scope fails busy rather than changing a live managed copy. Different host/scope roots are independent. Normal errors before the journal is removed restore prior target and state. If rollback itself fails, the journal/backups are kept and the CLI reports failure. Journal removal is the commit point: later backup-cleanup failure reports that the new change completed and preserves the remaining transaction directory; it must not restore an old half-deleted backup.

## Interrupted operations

This release does **not** provide automatic recovery after SIGKILL, power loss or disk corruption. It keeps recovery evidence and refuses further operations. Do not delete a lock simply because its PID looks old: confirm no corresponding CLI/host operation remains, and that the PID has not been reused.

1. Stop related operations, inspect `.lock/owner.json` and preserve a backup of the entire manager directory plus any live selected skill outside skill search paths. Do not follow an unexpected symlink or trust arbitrary paths from damaged JSON.
2. A `journal.json` refers only to a transaction basename such as `.txn-…` inside the same manager directory. The transaction can contain `incoming/`, `previous/` and `prior-state.json`. `previous/` is the old skill and `prior-state.json` is its old record; both are written/preserved before state replacement. Inspect the complete pair, including relative paths, hashes and version, before choosing recovery.
3. With a pending journal, choose a verified complete old target/record pair to restore, preserving any current target first. If no old installation existed, preserve any new target and restore absence only after confirming that fact. If a complete pair cannot be identified, stop and recover from an independent backup; do not delete the only good copy.
4. With no journal but a retained transaction directory, the change may already be committed. Verify the live target against the live record first. Preserve backups until that new pair is confirmed; do not infer rollback from the mere existence of `previous/`.
5. Only after target/state are consistent and all operations have stopped, remove the reviewed stale transaction/journal/lock artifacts. Retain your independent backup, then run `list` and a normal operation again. No automatic routine deletes unknown or damaged recovery data.

Installed npm packages include this document and its Chinese translation. Find the package under the directory printed by `npm root -g`, in `@luolin-ck/skills-cli/`; the repository also carries the same instructions. Source tests demonstrate ordinary rollback and an actual child process exiting after state replacement, not real power-failure durability. File writes/renames are not a guarantee against all hardware/filesystem failures.

## Boundaries

The manager assumes a trusted local user account and cooperative callers. Node path checks are not an openat-style sandbox against malicious same-user path replacement. Ownership JSON is not a signed credential. Git HTTPS and exact commit/hash checks are integrity controls, not publisher identity signatures or proof a skill is safe. Resource limits do not fully bound network pack downloads.

Known local conflict checks do not enumerate every host plugin, enterprise/admin/synced source or policy. Claude's valid omitted `name` defaults to its directory during conflict inspection; registered downloaded packages still require explicit matching `name`. Host permissions and authentication remain the user's own. macOS/Node24 and mock launch behavior were tested; Linux/native Windows behavior, paid model sessions, classification accuracy and universal legal clearance were not established.
