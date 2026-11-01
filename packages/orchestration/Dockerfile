# Same image as the API, different entrypoint: one Temporal worker process.
FROM oven/bun:1.4

WORKDIR /app

# git is required to pin `definitionCommit` and to clone workspaces in the docker runner.
# The docker CLI is required by the docker runner backend: the worker leases one sibling
# container per run through the mounted /var/run/docker.sock. Only the CLI is installed —
# never the daemon. The arch comes from `dpkg --print-architecture`, so arm64 and amd64
# both resolve to the right Docker apt package.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts

RUN bun install --frozen-lockfile

ENV NODE_ENV=production

CMD ["bun", "packages/orchestration/src/worker.ts"]
