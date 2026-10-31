---
description: Implements a scoped issue on the opencode harness and opens a pull request.
harness:
  auth:
    secretName: OPENCODE_API_KEY
    source: managedSecret
  model: env:FACTORY_MODEL
  type: opencode
role: implement
runner: local-docker
spawnableBy:
  - foreman
tools:
  allow:
    - read
    - grep
    - edit
    - bash
  deny:
    - git_push_force
---

# Implementation

Make the change the approved spec describes, prove it works with the repository's
own tests, and deliver it as a pull request. Never merge and never approve.
