#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# Run the arguments under the verify lane's machine-wide lock.
#
# Two heavyweight verification suites running side by side oversubscribe the machine: the
# suites already share nothing (every run brings its own database, its own AT Protocol
# network, per `scripts/session.ts`), so a red spec that passes in isolation is CPU
# contention, not a data race — and the losing run is a spec that has nothing wrong with
# it. This wrapper makes the heavy lane take turns: the run waits, at full speed, instead
# of running degraded. Editing, planning and scoped `bun test <path>` runs stay lock-free
# on purpose — that is parallel workstreams' cheapness. The TS twin is
# `scripts/heavy-run.ts`, which covers the invocation this cannot see: a bare full
# `bun test`, taken from the test preload. Both use the same lock file.
#
# The lock is one `flock(1)` on a fixed path under the user's cache directory, spanning
# every worktree and session (no `.worktrees/`-relative path, or every worktree would
# bring its own lock and serialize nothing). `ANTHERS_HEAVY_RUN_LOCK` overrides the path
# for tests. Held for the whole lifetime of the tree the command spans — the fd stays
# open across `exec`, so every child inherits it and the kernel releases the lock when
# the last one exits, crashed or not.
#
# `ANTHERS_HEAVY_RUN_HELD=1` is exported into the command: the test preload checks it and
# skips locking, so the full `bun test` inside `make verify` does not deadlock against the
# lock its own parent holds.
#
# `flock(1)` is util-linux. Where it does not exist (macOS, Windows) the run proceeds
# unlocked — degraded to the side-by-side behavior, loud that it did so, because a
# missing lock must never break a dev machine.

: "${ANTHERS_HEAVY_RUN_LOCK:=${HOME}/.cache/anthers/heavy-run.lock}"
[ -n "$1" ] || {
	printf 'usage: heavy-run.sh COMMAND [ARGS...]\n' >&2
	exit 64
}

if ! command -v flock >/dev/null 2>&1; then
	printf '\033[33m→ no flock(1) on this system, so the verify lane runs unlocked — two heavy suites side by side may flake each other\033[0m\n' >&2
	exec "$@"
fi

mkdir -p "$(dirname "$ANTHERS_HEAVY_RUN_LOCK")"
exec 9>>"$ANTHERS_HEAVY_RUN_LOCK"

exec 9>>"$ANTHERS_HEAVY_RUN_LOCK"

# Say "waiting" the moment the lane is found held, then every 15s while still held — a
# watcher reading a silent, queued run as a hang is the same failure the push hook's
# per-step announcements exist to stop. The lock itself is released by the kernel the
# moment its holder dies, so an unbounded wait can never hang on a corpse.
attempt=0
if ! flock -x -n 9; then
	printf '\033[36m→ another heavy run holds the verify lane — waiting (this report repeats every 15s); scoped `bun test <path>` runs and `make dev` never wait\033[0m\n' >&2
	while ! flock -x -w 15 9; do
		attempt=$((attempt + 1))
		printf '\033[36m→ the verify lane still held (%ss of waiting so far)\033[0m\n' "$((attempt * 15))" >&2
	done
fi

export ANTHERS_HEAVY_RUN_HELD=1
export ANTHERS_HEAVY_RUN_LOCK
exec "$@"