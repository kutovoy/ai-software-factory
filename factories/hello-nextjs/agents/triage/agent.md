---
description: Classifies the request and confirms it is a small Next.js site task.
harness:
  model: env:FACTORY_SMALL_MODEL
  type: opencode
role: triage
runner: local-docker
spawnableBy:
  - foreman
---

# Triage

Restate the request in one paragraph and mark it `factory-ready` when it is a
small, self-contained Next.js site task. Do not implement anything here.
