# Same image as the API, different entrypoint: one Temporal worker process.
FROM oven/bun:1.4

WORKDIR /app

# git is required to pin `definitionCommit` and to clone workspaces in the docker runner.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN bun install --frozen-lockfile

ENV NODE_ENV=production

CMD ["bun", "packages/orchestration/src/worker.ts"]
