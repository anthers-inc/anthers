# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The CI image for the browser suite's media half — an Ubuntu with the packages that are
# slow and unreliable to fetch on a runner, and nothing else.
#
# 🚨 **The whole point is that `apt-get` runs HERE and never in a job.** The browser job's
# two `apt-get install` lines cost 30 seconds on a good day and blew the 15-minute job
# timeout twice in two days against a stalled `azure.archive.ubuntu.com` — 2026-08-17
# inside `--with-deps` (removed by #34) and 2026-08-18 in `Ensure ffmpeg`, fetching 13.6 MB
# of `libflite1`. #34 closed the instance; the class is *assembling a runner from Ubuntu
# mirrors on every run*, and this closes that.
#
# ⚠️ **What is deliberately NOT in here: Chromium itself, and Bun.** Both are stated by the
# lockfile, and baking either one would make this image a second declaration of a version
# the repo already declares — exactly the drift `ci.yml` refuses when it declines to pin
# the official Playwright container. So the image carries only what a *machine* needs and
# the job still installs the browser from its own lockfile (~11s from Microsoft's CDN, and
# cached). The happy consequence is that a Playwright bump needs no image rebuild at all,
# which is what makes a plain `:latest` tag honest here.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Chromium's shared libraries, taken verbatim from OUR pinned Playwright's own registry
# data rather than typed from a blog post:
#
#   bun -e 'const s = await Bun.file("node_modules/.bun/playwright-core@<ver>/node_modules/playwright-core/lib/coreBundle.js").text();
#           const seg = s.slice(s.indexOf("ubuntu24.04-x64"), s.indexOf("ubuntu24.04-x64") + 4000);
#           console.log(seg.match(/chromium:\s*\[([^\]]*)\]/)[1])'
#
# Regenerate that way if Chromium ever fails to launch after an Ubuntu or Playwright bump.
# The failure is loud — the browser does not start and the job is red on its first spec —
# so this list drifting is a nuisance rather than a silent coverage loss.
#
# Fonts are the SHORT list on purpose. `playwright install-deps` also pulls the CJK/Thai/
# Cyrillic sets, and those were the exact packages stalling on the mirror; our specs assert
# DOM text and visibility and the site serves its own webfonts from `public/fonts`, so what
# those add is glyph coverage for scripts this suite never renders. What is here is enough
# for fontconfig to resolve *something* for every request, which a bare image cannot.
RUN apt-get update && apt-get install -y --no-install-recommends \
	libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 \
	libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 \
	libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
	libxkbcommon0 libxrandr2 \
	libfontconfig1 libfreetype6 fonts-liberation fonts-noto-color-emoji \
	&& rm -rf /var/lib/apt/lists/*

# The two media tools, which are the reason this image exists at all.
#
# ffmpeg makes the gauntlet fixture's bytes actually play, so the walk can assert delivered
# media rather than access reasons; poppler (`pdftoppm`) rasterizes the fixture's PDF into
# the per-page images an ebook is delivered as. Without either, the fixture no-ops and the
# assertions **skip silently** — a quiet coverage loss rather than a red run, which is why
# they are installed rather than detected.
RUN apt-get update && apt-get install -y --no-install-recommends \
	ffmpeg poppler-utils \
	&& rm -rf /var/lib/apt/lists/*

# What the runner itself needs to work inside a container: `actions/checkout` shells out to
# git, `actions/cache` untars, and `setup-bun` curls and unzips a release. A container job
# fails on any of these in a way that reads as an action bug rather than a missing package.
RUN apt-get update && apt-get install -y --no-install-recommends \
	ca-certificates curl git tar unzip xz-utils zstd \
	&& rm -rf /var/lib/apt/lists/*

# Proof the image is what it claims, at build time rather than on a runner at 2am.
RUN ffmpeg -version > /dev/null && pdftoppm -v 2>&1 | head -1 && git --version
