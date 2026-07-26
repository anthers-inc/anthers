FROM oven/bun:1

WORKDIR /app

# Install FFmpeg for media transcoding (worker) and curl for healthchecks
RUN apt-get update && apt-get install -y ffmpeg curl && rm -rf /var/lib/apt/lists/*

# Install dependencies — copy package manifests first for layer caching
COPY package.json bun.lock ./
COPY packages/brand/package.json packages/brand/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/web-shared/package.json packages/web-shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/studio-web/package.json apps/studio-web/
RUN bun install --frozen-lockfile

# Copy source (packages + API — no frontend needed here)
COPY packages/ packages/
COPY apps/api/ apps/api/

# Default command — overridden per component in .do/app.yaml:
#   api:     bun run apps/api/src/index.ts
#   worker:  bun run apps/api/src/jobs/worker.ts
#   migrate: bun run packages/db/src/migrate.ts
CMD ["bun", "run", "apps/api/src/index.ts"]
