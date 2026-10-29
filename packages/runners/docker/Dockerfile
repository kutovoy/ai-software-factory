# Runner image: node 22 + git + the opencode harness.
#
# One container per run. The workspace is bind-mounted at /workspace; `opencode serve`
# listens on 4096 inside the container and the docker backend maps it to an ephemeral
# 127.0.0.1 port on the host.
#
# Inference credentials are NOT baked in and must never be passed with `-e`.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install the Linux build of opencode v2 (the adapter targets the v2 `/api` server).
RUN curl -fsSL https://opencode.ai/v2/install | bash \
    && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode

ENV PATH="/root/.opencode/bin:${PATH}"

WORKDIR /workspace

# The harness command is supplied by the runner (`sh -c "<command>"`), so the image
# itself has no fixed entrypoint.
CMD ["sleep", "infinity"]
