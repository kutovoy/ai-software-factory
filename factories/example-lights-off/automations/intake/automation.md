---
agent: foreman
enabled: true
gates:
  spec: agent
triggers:
  - event: issue_labeled
    filter:
      labels:
        - factory-ready
      repos:
        - acme/api-service
    provider: github
---

A maintainer labeled an issue `factory-ready`. Read the issue, restate the
deliverable, and drive it to a pull request. Post progress as comments on the
issue and stop at any gate that resolves to `human`.
