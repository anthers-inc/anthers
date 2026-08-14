# Pinned, not `oven/bun:1`. The floating tag means the image App Platform builds is
# whatever Bun shipped that morning, and that is not hypothetical: bun 1.3.9 made
# `bun install --frozen-lockfile` exit 1 on this repo's lockfile (an optional peer,
# better-sqlite3, fails its native postinstall in this image and 1.3.9 counted that as
# fatal; 1.2.23 and 1.3.14 both exit 0). A deploy inside that window would have failed
# to build with no commit to blame — and with a floating tag, a green CI image build
# says nothing about what gets built at deploy time. Bump this deliberately; CI builds
# the image on the PR, so the bump is checked.
FROM oven/bun:1.3.14

WORKDIR /app

# Install FFmpeg for media transcoding (worker) and curl for healthchecks
# ffmpeg transcodes video and audio; poppler-utils (pdftoppm/pdfinfo) renders an
# uploaded ebook PDF to per-page images. Both are the WORKER's dependencies — the
# API and worker share this image, so a missing one fails a job rather than a boot,
# which is the quieter failure and the reason they are pinned here explicitly.
RUN apt-get update && apt-get install -y ffmpeg poppler-utils curl && rm -rf /var/lib/apt/lists/*

# Install dependencies — copy package manifests first for layer caching
COPY package.json bun.lock ./
COPY packages/brand/package.json packages/brand/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/web-shared/package.json packages/web-shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# EVERY workspace listed in bun.lock must have its manifest here, even ones this image
# never builds: `--frozen-lockfile` compares the lockfile against the workspaces it can
# actually see, and a missing package.json reads as "the lockfile changed". The desktop
# Studio is Rust + Tauri and ships nothing to the server, but omitting it fails the
# install outright.
COPY apps/studio-desktop/package.json apps/studio-desktop/
RUN bun install --frozen-lockfile

# Copy source (packages + API — no frontend needed here)
COPY packages/ packages/
COPY apps/api/ apps/api/

# Default command — overridden per component in .do/app.yaml:
#   api:     bun run apps/api/src/server.ts
#   worker:  bun run apps/api/src/jobs/worker.ts
#   migrate: bun run packages/db/src/migrate.ts
CMD ["bun", "run", "apps/api/src/server.ts"]
