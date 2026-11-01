# Proposal

## Why

Three operator problems: pages showing live state go stale unless you reload; the factory dashboard reports
metrics but not *what the factory produced* (PRs, patches, runs, work items) or what state it is in; and the
sidebar silently resets the selected factory whenever you click a top-level item such as Runs. The work-items
board also drowns in cancelled items.

## What Changes

- **Auto-refresh:** a top-right control (Off / 15s / 30s / 60s, default 15s, persisted) refreshes server data
  while the tab is visible. Hidden on documentation routes (`/help*`) where nothing changes.
- **Dashboard as an operations view:** factory state (autonomy, canary, last activity), recent work items and
  runs, deliverables (PRs, merged items, latest patch/artifact) and where to find results — alongside the
  existing metrics.
- **Stable factory selection:** the selected factory is persisted (cookie) and only the `/factories/:name/*`
  routes override it; clicking Runs/Inbox/etc. no longer switches factory.
- **Work-items board:** cancelled items hidden by default, status filter chips, and created/last-updated
  timestamps on each card.

## Capabilities

### Modified Capabilities
- `web-console`: auto-refresh, operational dashboard, persistent factory selection, board filters.

## Impact

- No API change (existing projections suffice; work-item timestamps already exist).
- One cookie, one client control, dashboard sections, board filters.
