#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
#
# The one FFmpeg build Anthers' images carry, installed identically by the API/worker image
# and the browser suite's CI image.
#
# 🚨 **The encoder is part of the output, so it cannot be whatever the base image shipped.**
# The ladder's rungs are tuned — CRF 19 under a VBV ceiling, one shared decode feeding the
# tall rungs — and that tuning was measured against a particular x264. The same command on a
# different build is a different file, and nothing in the suites says so: they assert that a
# rung exists, plays and is smaller than its ceiling, never its bytes. Two images built from
# two distro archives were therefore free to drift apart silently, and a rebuild of the API
# image could move production's encoder with no commit to blame.
#
# ⚠️ **Pinning the apt package cannot make them the same build.** `oven/bun:1.4.3` is Debian
# 13 (trixie) and the CI image is Ubuntu 24.04, whose archives are a major version apart
# (7.1.5 against 6.1.1 today), and an exact apt pin is a build that breaks the week the
# archive rotates. A static tarball from one release is the only artifact that is the same
# bytes on both bases — it links nothing from the host, so it cannot be moved by a base image
# bump either.
#
# ⭐ **The source is BtbN's FFmpeg-Builds, on a monthly autobuild tag.** The GPL variant is
# the one that carries libx264 and the AAC encoder, which is what the ladder and the audio
# job need; Debian's own package was GPL-linked for the same reason, so this is the same
# licensing posture as before rather than a new one. Daily autobuilds are pruned after about
# a month, the month-end ones are kept, which is why the pin names one of those.
#
# Bumping it is a deliberate act, and the two images move together because this file is the
# only place the build is written down:
#
#   1. Pick the newest month-end `autobuild-YYYY-MM-DD-...` tag on
#      https://github.com/BtbN/FFmpeg-Builds/releases and copy the `linux64-gpl` asset name
#      (the release-branch ones are `ffmpeg-n<version>-...`; `ffmpeg-master-...` is not one).
#   2. Take its sha256 from that release's `checksums.sha256`.
#   3. Read the version token out of the first line of `ffmpeg -version` after installing it,
#      e.g. `n8.1.3-27-g8dca1586f4-20261031`, and set it below.
#   4. Rebuild both images (`make ffmpeg-verify` builds both locally) and dispatch the
#      `ci-image` workflow, because a pull request builds that image but does not publish it.
#
# 🚨 **If this script fails, the image does not build, and that is the point.** A missing
# release, a changed checksum or a tarball carrying a different FFmpeg all stop the build
# rather than shipping something the other image is not running.
set -eu

FFMPEG_VERSION="n8.1.3-27-g8dca1586f4-20261031"
FFMPEG_TARBALL_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59/ffmpeg-n8.1.3-27-g8dca1586f4-linux64-gpl-8.1.tar.xz"
FFMPEG_TARBALL_SHA256="41e9c565594c390622cf968d82fa4135d9e9a11d06c1515644288cbc844e3380"

# Where the two binaries go, and the record the CI jobs read back: the whole first line of
# `ffmpeg -version`, so a job asserts the build the image was made with rather than the one
# the repository currently pins. (A pull request that moves the pin runs the previously
# published CI image; comparing against the repository's pin there would fail the very
# change that fixes the drift.)
FFMPEG_BIN_DIR="/usr/local/bin"
FFMPEG_RECORD="/usr/local/share/anthers/ffmpeg-version"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

echo "Installing FFmpeg ${FFMPEG_VERSION}"
echo "  from ${FFMPEG_TARBALL_URL}"

curl --fail --location --silent --show-error --retry 3 \
	--output "$work/ffmpeg.tar.xz" "$FFMPEG_TARBALL_URL"

echo "${FFMPEG_TARBALL_SHA256}  $work/ffmpeg.tar.xz" | sha256sum --check --status ||
	{
		echo "install-ffmpeg: the tarball does not match the pinned sha256" >&2
		echo "  expected ${FFMPEG_TARBALL_SHA256}" >&2
		echo "  actual   $(sha256sum "$work/ffmpeg.tar.xz" | cut -d' ' -f1)" >&2
		exit 1
	}

# Only the two binaries: the tarball also carries ffplay, man pages and static libraries,
# none of which either image runs, and together they are larger than what is kept.
tar --extract --xz --file "$work/ffmpeg.tar.xz" --directory "$work" \
	--wildcards --no-anchored '*/bin/ffmpeg' '*/bin/ffprobe'

mkdir -p "$FFMPEG_BIN_DIR" "$(dirname "$FFMPEG_RECORD")"
install -m 0755 "$(find "$work" -type f -name ffmpeg | head -n 1)" "$FFMPEG_BIN_DIR/ffmpeg"
install -m 0755 "$(find "$work" -type f -name ffprobe | head -n 1)" "$FFMPEG_BIN_DIR/ffprobe"

# The assertion the pin exists for. `head -1` is the line the CI jobs print, and its third
# field is the build's identity: the version, the branch it came from and the date BtbN
# built it.
installed_ffmpeg="$("$FFMPEG_BIN_DIR/ffmpeg" -version | head -n 1)"
installed_ffprobe="$("$FFMPEG_BIN_DIR/ffprobe" -version | head -n 1)"

for line in "$installed_ffmpeg" "$installed_ffprobe"; do
	actual="$(echo "$line" | cut -d' ' -f3)"
	[ "$actual" = "$FFMPEG_VERSION" ] ||
		{
			echo "install-ffmpeg: expected FFmpeg ${FFMPEG_VERSION}, got ${actual}" >&2
			echo "  ${line}" >&2
			exit 1
		}
done

# A base image that put another ffmpeg earlier on PATH would leave the worker running
# something other than the build asserted above, which is the whole failure this closes.
resolved="$(command -v ffmpeg || true)"
[ "$resolved" = "$FFMPEG_BIN_DIR/ffmpeg" ] ||
	{
		echo "install-ffmpeg: PATH resolves ffmpeg to ${resolved}, not ${FFMPEG_BIN_DIR}/ffmpeg" >&2
		exit 1
	}

echo "$installed_ffmpeg" >"$FFMPEG_RECORD"
echo "  ${installed_ffmpeg}"
