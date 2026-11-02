# Design

## Decisions

1. **One shape.** Every factory-scoped resource is addressed through
   `/api/v1/factories/:factoryId/...`; no factory query parameter remains.
2. **Path supplies identity.** Create/list/detail all resolve the factory from the path. Work-item
   and run ULIDs stay global but nested under the factory.
3. **Existing IDs.** Benchmark runs, improvement runs, proposals and scores keep their existing IDs
   in the nested path; no new MCP/scorer IDs are needed.
4. **Browser parity.** Factory-scoped pages live at `/factories/<id>/...`; `/factories` list,
   `/inbox` (cross-factory queue), `/secrets`, `/users` and `/help` stay global.
5. **Rewrite in place.** `/api/v1` changes directly; all clients move in the same change (ADR-039).
