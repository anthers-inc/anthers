#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# The raw changelist of a release — every change between this tag and the previous
# one, one line per squash commit, unedited — published as the GitHub release on
# the tag the deploy job just applied.
#
# ⭐ This lives in a script rather than inline in `ci.yml` so it can be tested. The
# deploy job calls it with a working tree the tag step already fully fetched; the
# test below stubs `git` and `gh` and drives every branch through it — including the
# two that a green deploy can never reach (empty changelist, missing base) and the
# re-run path, where the tag step no-opped and the release already exists.
#
# The changelist's home is the GitHub release, deliberately: created by the same job
# that applies the tag, so capture is exactly as guaranteed as the tag itself; the
# repo is public and every subject line is already public on /commits, so the
# release exposes nothing new. The `/changelog` page reads releases through the
# GitHub API, and the public-pass skill edits upward from this record — it is the
# audit trail, never replaced.
#
# 🚨 `--no-merges` is load-bearing, not cosmetic. Two commits in the first batch
# were true two-parent merges from before the repo settled on squash merges; their
# subject lines are "Merge pull request #N from branch", which carries no change
# information. `--no-merges` drops exactly those — the change each merged in is a
# commit of its own, still in the list.
#
# The range's base: the previous calver tag, or — for the first versioned release,
# which has no previous tag — `$BEFORE`, the tip `release` pointed at before this
# promote. That is the honest boundary for a first release: everything production
# was already running before it is not part of what this deploy changed, and an
# unbounded `git log HEAD` would claim otherwise.
#
# A re-run finds the release already existing (the tag step above no-opped);
# regenerating the notes converges on the same content, so edit is correct and
# idempotent rather than an error.
#
# Inputs (environment):
#   GH_TOKEN   the token `gh` authenticates with (and the only input CI must pass)
#   BEFORE     github.event.before — release's tip before this promote; used only
#              when no previous calver tag exists
#
# Everything else the script reads itself: VERSION from the committed constant the
# checkout carries (the same awk the tag step uses — an Actions `env:` value is a
# literal string, so a `$(...)` there would pass the command's text, not its
# output), SHA and REPO from the GITHUB_SHA and GITHUB_REPOSITORY that every
# Actions run provides.

set -uo pipefail

fail() {
	echo "::error::$1"
	exit 1
}

VERSION=$(awk -F'"' '/export const APP_VERSION/ {print $2}' packages/shared/src/version.ts)
if [ -z "$VERSION" ] || ! printf '%s' "$VERSION" | grep -Eq '^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$'; then
	fail "APP_VERSION is missing or not calver (got \"${VERSION:-none}\")."
fi
SHA="${GITHUB_SHA:?GITHUB_SHA is not set — this script runs in the deploy job}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set — this script runs in the deploy job}"

# The previous calver tag: newest by version that is reachable from HEAD and is
# not the release being made. `--sort=-version:refname` sorts tags the way calver
# orders releases, so the first line is the immediately previous release.
PREV=$(git tag --merged HEAD --list "v*" --sort=-version:refname | grep -v "^v${VERSION}$" | head -1)
BASE="${PREV:-$BEFORE}"

if [ -z "$BASE" ] || ! git rev-parse -q --verify "${BASE}^{commit}" >/dev/null; then
	fail "No previous calver tag and no usable before-SHA (${BASE:-none}) — cannot say what this release changed without a range to diff."
fi

git log "${BASE}..${SHA}" --no-merges --format="- %s" >changelist.md
if [ ! -s changelist.md ]; then
	fail "The changelist between ${BASE} and ${SHA} is empty — a release with no changes is a promote of an already-released commit."
fi

{
	echo "## What shipped in ${VERSION}"
	echo ""
	cat changelist.md
} >release-body.md

if gh release view "v${VERSION}" --repo "$REPO" >/dev/null 2>&1; then
	gh release edit "v${VERSION}" --repo "$REPO" --notes-file release-body.md --latest
	ACTION=updated
else
	gh release create "v${VERSION}" --repo "$REPO" --target "$SHA" --title "Anthers ${VERSION}" --notes-file release-body.md --latest
	ACTION=created
fi

echo "::notice::${ACTION} the changelist for v${VERSION} (${BASE}..${SHA}, $(wc -l <changelist.md | tr -d ' ') entries)"