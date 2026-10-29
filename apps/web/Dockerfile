# Build context is the repository root: the console needs the Bun workspaces
# (`@factory/adapters` types) and the lockfile.
FROM oven/bun:1.4 AS builder

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN bun install --frozen-lockfile

ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && bun run build

FROM oven/bun:1.4 AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

COPY --from=builder /app ./

WORKDIR /app/apps/web

EXPOSE 3000

CMD ["bun", "run", "start"]
