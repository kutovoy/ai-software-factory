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

# opencode ships with its own providers (OpenAI, Anthropic, …) and a built-in default model.
# A factory run must never reach a vendor directly: every model call goes through the API's
# per-run inference proxy (ADR-011), whose base URL and token arrive in the harness command's
# environment. This config declares that proxy as the `factory` provider, templated from
# `OPENAI_BASE_URL`/`OPENAI_API_KEY` at startup, and makes `best_llm` the default model.
COPY opencode.json /root/.config/opencode/opencode.json

# QA agent support: Playwright + Chromium baked into the runner so a verify stage can
# open the generated site in a real browser without downloading a browser per run.
# Keep the version in sync with the QA prompt (`@playwright/test@1.64.1`).
RUN npm install -g @playwright/test@1.64.1 \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.opencode/bin:${PATH}"

WORKDIR /workspace

# The harness command is supplied by the runner (`sh -c "<command>"`), so the image
# itself has no fixed entrypoint.
CMD ["sleep", "infinity"]
