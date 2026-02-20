# ── Build stage ──
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ── Production stage ──
FROM oven/bun:1-slim
WORKDIR /app
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /app/serve.ts ./
COPY --from=build /app/entrypoint.sh ./
USER bun
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "run", "serve.ts"]
