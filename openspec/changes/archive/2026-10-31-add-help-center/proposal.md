# Proposal

## Why

The sidebar `+` next to Factories is a dead `<span title="Creating factories is not wired yet">` — it looks
like an action and does nothing. More broadly, the console has no documentation: every page is discoverable
only by clicking, and the only explanation of gates, autonomy, canary or merge queues lives in `docs/` outside
the product.

## What Changes

- **Help centre** at `/help`, structured with Diátaxis (<https://diataxis.fr/>): a Quick start tutorial, concept
  explanations, per-menu-item reference, factory how-tos, and troubleshooting.
- **Quick start page** with diagrams (pipeline, factory anatomy, gate flow) and copy-paste commands that take a
  new operator from `docker compose up` to a merged work item.
- **Contextual help**: a `?` in the top-right of every page links to that page's help entry; unknown routes fall
  back to the help index. This is the documented pattern that reduces support load
  (<https://userpilot.com/blog/help-center-examples/>).
- **`+` becomes honest**: it links to the "Add a factory" how-to. Factories are git-backed files, so the page
  explains scaffold → validate → commit and states that the console never writes the worktree.
- **AGENTS.md rule**: any feature change must update the matching help page and the menu reference in the same
  change.

## Capabilities

### Modified Capabilities
- `web-console`: in-product help, contextual help links, no dead controls.

## Impact

- New routes under `/help`, a nav entry, a shared header help control, help content as typed data.
- No backend change; help is static content rendered by the console.
- Adds a maintenance obligation, enforced by the AGENTS.md rule.
