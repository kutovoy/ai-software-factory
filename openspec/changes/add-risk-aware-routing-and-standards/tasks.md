# Tasks

## 1. Risk-aware routing

- [x] 1.1 Add `riskTier` to `chooseRouting`; high risk forces the deep tier.
- [x] 1.2 Pass risk tier from work-item creation and mission features into routing.
- [x] 1.3 Tests: high risk deep, low risk score-based, no routing honest.

## 2. Standards guard

- [x] 2.1 Add `quality.standards` schema/resolver and `ReviewPacket.standards`.
- [x] 2.2 Evaluate standards in the review packet; record `standards.exceeded`.
- [x] 2.3 Agent review gate resolves `request_changes` on standards overage; human gate shows a waiver path.
- [x] 2.4 UI shows standards in the packet and Inbox summary.
- [x] 2.5 Tests: schema, evaluation, packet, gate, UI.

## 3. Durable economics note

- [x] 3.1 Document that gate waits release the sandbox; code mode remains deferred.
- [x] 3.2 Update architecture/roadmap.

## 4. Verification

- [x] 4.1 `bun run ci`, `openspec validate --all`, `bash scripts/smoke.sh`, Playwright.
- [x] 4.2 Re-run the hello-world factory cycle after the stage.
