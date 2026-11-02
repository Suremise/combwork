# Recorded commit streams (#1350)

Real stderr of `git merge --no-ff --no-edit -m "AM-1: x" f`, run with `GIT_TRACE2_EVENT=2`, as the merge queue runs its commits. git's trace2 events are in the same stream as what its hooks and signer write, in order. `tests/workflow/queueCommits.test.ts` reads them with `readCommitStream` and `commitFailed`.

Recorded with Git for Windows 2.45.1 unless the table says otherwise, each in a fresh repository: `main` with one commit, branch `f` with one more, HEAD detached at `main`, no global config. The probe folder is replaced with `<dir>`, and the user's name with `user`.

| File | Hooks and signer | git's exit |
|---|---|---|
| `passing-hook-then-signer.txt` | `commit-msg` prints `passphrase policy validation passed` and exits 0; `commit.gpgsign=true`, and `gpg.program` is a script printing `gpg: signing failed: No secret key` that exits 2. | 128 |
| `passing-hook-then-signer-waits.txt` | `commit-msg` prints `No secret key needed for this message` and exits 0; the signer prints `gpg: signing failed: Inappropriate ioctl for device` and exits 2. | 128 |
| `passing-hook-then-signer-2.56.txt`, `passing-hook-then-signer-waits-2.56.txt` | As the two above, recorded with Git for Windows 2.56.0 (HI-2399). This git runs the signer with `--status-fd=2`, captures its stderr and prints it only after the signer exits, as `error: gpg failed to sign the data:` and the signer's lines. | 128 |
| `failing-hook-no-newline.txt` | `commit-msg` prints `message rejected: passphrase in it`, then `{"event": not one` with no newline, and exits 1. | 1 |
| `nested-git-hook.txt` | `pre-merge-commit` runs `git commit` in another repository whose `commit-msg` hook prints `inner hook rejects` and exits 1, then exits 0; the signer fails with no secret key, as in the first. | 128 |

To record them again: hooks are `#!/bin/sh` scripts in `.git/hooks`, and the signer is a `#!/bin/sh` script named by `-c gpg.program=<its path>`. Capture stderr only, then replace the paths.
