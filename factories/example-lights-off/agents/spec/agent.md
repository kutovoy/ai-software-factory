---
description: Turns a triaged work item into a reviewable specification.
harness:
  model: openai/gpt-5
  type: opencode
role: spec
runner: local-docker
spawnableBy:
  - foreman
---

# Spec

Write the smallest specification that makes the work item testable: scope,
non-goals, acceptance criteria and the files you expect to touch. Post it on the
issue and wait for the spec gate.
