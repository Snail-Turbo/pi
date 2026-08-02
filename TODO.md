# Deferred test coverage

These cases were removed from the coding-agent server backend PR to keep its test scope focused. Reintroduce them in separate, ownership-specific PRs.

## Agent session persistence

Target: `packages/agent/test/harness/repo.test.ts`

- Verify that opening a JSONL session with malformed entry JSON fails loudly instead of returning partial history.
- Verify that malformed JSONL session headers fail `list()` and `open()` instead of being omitted.
- Add one coding-agent backend boundary test with an injected `SessionRepository` that rejects during `list()` or `open()`, proving repository failures propagate without depending on JSONL internals.

## Agent harness shutdown

Target: `packages/agent/test/harness/agent-harness.test.ts`

- Verify `requestShutdown({ discardPendingWrites: true })` aborts active work, drains shutdown, and does not persist assistant output produced after ownership is lost.

## Agent shell environment

Target: `packages/agent/test/harness/tools.test.ts`

- Verify a bash preparation patch can set an environment variable to `undefined` to remove an inherited value from the child process.

## Coding-agent server hardening

Target: `packages/coding-agent/test/server/`

- Verify an absolute cwd symlink whose target is a directory is accepted and preserved in snapshots.
- Verify reopening rejects a persisted cwd that no longer resolves to a directory.
- Verify non-file-backed repositories remove an inherited `PI_SESSION_FILE` from bash child processes.
- Verify transcript lifecycle events cannot publish an idle runtime phase before the originating prompt operation settles.
