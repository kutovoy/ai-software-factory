# Design

## Risk-aware routing

`chooseRouting` accepts an optional `riskTier`. If `riskTier === 'high'`, the selected tier is `deep` even
when the score is lower; the reason records `risk=high`. Other tiers keep the existing score-based selection
(so a low-risk docs change can still use cheap). The API passes the work item's classified risk tier into
`resolveRunDefaults`; mission feature work items use the same path where routing is applied.

## Standards guard

`quality.standards` defaults:

- `maxPublicApiChanges`: 5
- `maxSchemaChanges`: 3
- `requireMigrationForSchemaChange`: false

The review packet already counts public API and schema files. The packet adds:

```ts
standards: {
  maxPublicApiChanges: number;
  maxSchemaChanges: number;
  publicApiChanges: number;
  schemaChanges: number;
  status: 'pass' | 'exceeded';
}
```

An exceeded standard records a `standards.exceeded` event and makes an agent review gate resolve
`request_changes` with the exceeded counts. A human gate shows the counts and requires an explicit waiver.
`requireMigrationForSchemaChange` is recorded for future use; the P2 gate uses the counts only.

## Durable economics

A stage run ends before its gate wait, so the runner sandbox is already released while a human decides. The
remaining cost is model/queue idle time, not a held sandbox. Code mode (programmatic tool orchestration) is
harness-dependent; it is documented as a deferred capability rather than a flag that silently does nothing.
