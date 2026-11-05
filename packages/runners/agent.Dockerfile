# Remote runner agent image (Linux MVP).
#
# Build from the repository root:
#   docker build -t factory-runner-agent:local -f packages/runners/agent.Dockerfile .
#
# The agent talks to the central API over outbound HTTPS, creates one sandbox container per
# run through the mounted Docker socket, and never receives Temporal/Postgres credentials.
FROM oven/bun:1.4

WORKDIR /app

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

RUN bun install --frozen-lockfile

ENV RUNNER_STATE_FILE=/data/runner-agent.json
VOLUME ["/data"]

CMD ["bun", "packages/runners/src/agent.ts"]
