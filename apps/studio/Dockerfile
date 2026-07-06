# SPDX-License-Identifier: AGPL-3.0-or-later
# Creator Studio web service — serves the built Studio SPA with cross-origin-isolation
# headers (COOP+COEP). A SERVICE (not a static site) because DO App Platform static
# sites can't set custom response headers. See epic E50 - Creator Studio.
FROM oven/bun:1

WORKDIR /app

# Install deps — copy workspace manifests first for layer caching.
COPY package.json bun.lock ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/web-shared/package.json packages/web-shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/studio/package.json apps/studio/
RUN bun install --frozen-lockfile

# Copy source. The Studio SPA imports @anthers/web-shared (the shared authoring stack +
# theme.css), so the packages/ source must be present for the bundler and Tailwind's
# @source scan. The type-only `AppType` import from apps/api is erased at build, so the
# API source isn't needed here.
COPY packages/ packages/
COPY apps/studio/ apps/studio/
RUN cd apps/studio && bun run build

CMD ["bun", "run", "apps/studio/serve.ts"]
