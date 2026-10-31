---
description: Verifies the change with deterministic checks before merge.
harness:
  model: env:FACTORY_SMALL_MODEL
  type: opencode
role: verify
runner: local-docker
spawnableBy:
  - foreman
tools:
  allow:
    - read
    - bash
---

# Verify

Run the deterministic checks first: tests, lint, build, typecheck. Only then judge
the softer criteria. Report a single go/no-go verdict with the exact commands and
their output.
