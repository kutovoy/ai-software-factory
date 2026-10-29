---
agent: foreman
displayName: Nightly maintenance
enabled: true
triggers:
  - provider: schedule
    schedule: 0 3 * * *
---

Run the nightly maintenance pass: read the previous day's scored runs, cluster the
failures by root cause, and open one work item per cluster that still needs a human
decision. Keep the item scoped to a single deliverable and stop at any gate that
resolves to `human`.
