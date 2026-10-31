# Tasks

## 1. Help content model

- [ ] 1.1 `apps/web/src/lib/help.ts`: typed registry `{slug, title, section, summary, blocks, related}` with
      sections `quick-start | concepts | menu | factories | troubleshooting`
- [ ] 1.2 One entry per menu item: New Chat, Inbox, Work items, Runs, MCPs and apps, Secrets, Users, and each
      factory page (Dashboard, Agents, Automations, Scorers, Self-improvement, Benchmarks, Definition, Gates,
      Merge queue, Settings)
- [ ] 1.3 Concept entries: definitions as code, work item lifecycle, gates and autonomy, runners and sandboxes,
      scoring and calibration, benchmarks and attestation, self-improvement and canary, merge queue
- [ ] 1.4 How-tos: add a factory (scaffold → validate → commit), connect GitHub, set the model via env,
      register a secret, add an MCP server
- [ ] 1.5 Troubleshooting: run will not start, gate stuck, benchmark refused, canary rollback, secret unresolved
- [ ] 1.6 Every entry names its phase/status honestly (e.g. Users is a Phase 6 stub)

## 2. Help UI

- [ ] 2.1 `/help` index grouped by Diátaxis section with descriptions
- [ ] 2.2 `/help/[slug]` page: title, section, body blocks (prose, steps, code, callout), related links
- [ ] 2.3 Quick start page with diagrams: pipeline (intake → loop → gates → merge → score → improve), factory
      anatomy (files → resources → agents), gate resolution (automation → factory → global). Hand-built SVG/CSS,
      no new dependency
- [ ] 2.4 Quick start commands with expected output per step and a "what success looks like" checklist
- [ ] 2.5 Search/filter over entries (client-side, by title + section)

## 3. Navigation and contextual help

- [ ] 3.1 Sidebar: `Help` entry at the bottom (above account footer)
- [ ] 3.2 `+` next to Factories becomes a link to `/help/factories/add` with accessible name
      "Add a factory (git-backed)"; remove the dead span and its title
- [ ] 3.3 Shared header `?` control (top right) on every page, mapping the current route to a help slug;
      unknown routes → `/help`; accessible name names the page
- [ ] 3.4 Help pages link back to the page they describe

## 4. AGENTS.md

- [ ] 4.1 Add a rule: any feature/page/route change must update the matching help entry, the menu reference and
      the quick start if the first-run flow changes; help updates are part of the same OpenSpec change

## 5. Tests & wrap-up

- [ ] 5.1 Playwright: help nav → index → quick start; `?` on Chat/Gates/Self-improvement resolves to the right
      entry; `+` opens the add-factory how-to; no dead `+` span
- [ ] 5.2 Every menu item has a help entry (unit test over the registry vs `nav.ts`)
- [ ] 5.3 UI audit still clean (33 routes, no overflow/console errors)
- [ ] 5.4 `bun run ci`, smoke, Playwright green
- [ ] 5.5 STATUS updated; `openspec validate add-help-center`
