# @factory/core

The single source of truth for the factory definition format: Zod schemas, a loader,
a canonical serializer, a content hash, the gates resolver, a semantic diff engine and
version pinning.

```ts
import { loadDefinition, serializeDefinition, contentHash, diffDefinitions } from '@factory/core';

const { definition, errors } = loadDefinition('factories/example');
```

## Definition layout

Path is identity — a resource's name is its path and is never duplicated in frontmatter.

```
factory.yaml
agents/<name>/agent.md (or agents/<name>.md)
agents/<name>/skills/<skill>/SKILL.md
automations/<name>/automation.md (or automations/<name>.md)
scorers/<name>/scorer.md (or scorers/<name>.md)
skills/<skill>/SKILL.md (or skills/<skill>.md)
benchmarks/<suite>/suite.yaml + tasks/<task>.yaml
runners/<name>.yaml
routing.yaml
packs.lock
```

Any other file is a validation error (`unknown_file`) listing the allowed locations.

## Validation errors

Every failure is `{ code, file, pointer, message }` — `pointer` is a JSON pointer into
the document (`/` for the root). Codes are stable and listed in `src/errors.ts`.

## DB index (`migrations/001_factory_index.sql`)

`factory_definitions`, `factory_versions` and `resources` are a **derived index only**.
Git is the truth: rows are rebuilt from a definition tree at a pinned `commit_sha`, and
the UI/API must never write definitions into these tables. A row carries
`(factory, commit_sha, path, kind, name, hash, doc)` so the UI can answer "what did
version X contain" without walking the repository.
