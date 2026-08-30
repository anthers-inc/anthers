#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Has this code already been tested?
#
# Every push to `main` and `release` is preceded by a run against the same work. A deploy
# fast-forwards `release` to a SHA `main` has just tested; a squash merge lands a tree a
# pull request has just tested. Both re-run the whole suite against code nothing has
# changed, and that buys nothing while costing something real: checks attach to a SHA
# rather than a branch, so a flake in the duplicate paints a red mark on work that passed.
#
# 🚨 The two cases need different keys, and getting that wrong is how a dedupe starts
# skipping things it should not. A fast-forward preserves the SHA, so `release` asks about
# the commit. A squash merge does not, so `main` asks about the **tree** — the whole of
# what a test run examines, and which differs the moment `main` moves under an open pull
# request. That difference is not an inconvenience: it is exactly the case where re-running
# is the only thing that catches a semantic conflict two green branches produce together.
#
# ⭐ This lives in a script rather than inline in `ci.yml` so it can be tested. Sixty lines
# of shell embedded in YAML is sixty lines nothing can exercise, and the failure it would
# hide is the worst one available here — skipping a run that should have happened.
#
# Reads its inputs from the environment and writes `skip=true|false` to $GITHUB_OUTPUT.
# `GH` overrides the `gh` command, which is what makes the tests possible.
set -euo pipefail

GH="${GH:-gh}"
OUT="${GITHUB_OUTPUT:-/dev/stdout}"

run_in_full() {
	echo "skip=false" >>"$OUT"
	echo "::notice::$1"
	exit 0
}

skip_it() {
	echo "skip=true" >>"$OUT"
	echo "::notice::$1"
	exit 0
}

# A pull request always runs. It is the run everything else defers to.
[ "${EVENT:-}" = "push" ] || run_in_full "Not a push — running in full."

# ── release: the same SHA, fast-forwarded ────────────────────────────────────
if [ "${BRANCH:-}" = "release" ]; then
	passed=$("$GH" api \
		"repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$SHA&branch=main&status=success" \
		--jq '.total_count' 2>/dev/null || echo 0)
	[ "${passed:-0}" -gt 0 ] &&
		skip_it "$SHA already passed ci on main — skipping the duplicate release run."
	run_in_full "No green ci run for $SHA on main — testing this release push in full."
fi

[ "${BRANCH:-}" = "main" ] || run_in_full "Push to ${BRANCH:-?} — running in full."

# ── main: a different SHA carrying an identical tree ─────────────────────────

# GitHub's squash subject ends in "(#123)". No number means a direct push, a rebase merge,
# or a subject somebody rewrote — all of which get a full run.
pr=$(printf '%s' "${HEAD_MESSAGE:-}" | head -1 | sed -n 's/.*(#\([0-9]\{1,\}\))[[:space:]]*$/\1/p')
[ -n "$pr" ] || run_in_full "No pull request number in the subject — running in full."

pr_head=$("$GH" api "repos/$REPO/pulls/$pr" --jq '.head.sha' 2>/dev/null || echo "")
[ -n "$pr_head" ] || run_in_full "Could not resolve #$pr — running in full."

# Asked through the API rather than from a checkout, so precheck stays a job with no
# working tree and finishes in seconds.
pr_tree=$("$GH" api "repos/$REPO/commits/$pr_head" --jq '.commit.tree.sha' 2>/dev/null || echo "")
here_tree=$("$GH" api "repos/$REPO/commits/$SHA" --jq '.commit.tree.sha' 2>/dev/null || echo "")
if [ -z "$pr_tree" ] || [ -z "$here_tree" ] || [ "$pr_tree" != "$here_tree" ]; then
	run_in_full "The tree on main differs from #$pr's — main moved, so this combination is untested."
fi

passed=$("$GH" api \
	"repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$pr_head&status=success" \
	--jq '.total_count' 2>/dev/null || echo 0)
# A run still in progress counts as "not passed", which errs toward running twice rather
# than not at all — the same way the release branch above does.
[ "${passed:-0}" -gt 0 ] &&
	skip_it "#$pr passed ci against this exact tree ($here_tree) — skipping the duplicate run on main."
run_in_full "No green ci run for #$pr — testing this merge in full."
