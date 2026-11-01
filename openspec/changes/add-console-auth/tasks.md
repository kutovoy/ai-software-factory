# Tasks

## 1. Persistence
- [ ] 1.1 Migration 016: `users`, `sessions`, `work_items.created_by`
- [ ] 1.2 Auth repository: create/find/verify, sessions, list/update users
- [ ] 1.3 Bootstrap admin on API start

## 2. API
- [ ] 2.1 `/auth/login`, `/auth/logout`, `/auth/me`
- [ ] 2.2 Session middleware with `AUTH_REQUIRED` and public exemptions
- [ ] 2.3 `/users` CRUD (admin only)
- [ ] 2.4 Scope work-item/run/inbox reads by owner for members
- [ ] 2.5 Forge personal-org provisioning (best effort)

## 3. Console
- [ ] 3.1 Login page + logout; middleware redirect
- [ ] 3.2 Cookie forwarding on API calls and proxies (`Set-Cookie` included)
- [ ] 3.3 Real Users page
- [ ] 3.4 Forgejo proxy uses session username
- [ ] 3.5 Nav shows the signed-in user

## 4. Verification
- [ ] 4.1 Unit + API integration tests for auth and scoping
- [ ] 4.2 Playwright login → users → logout
- [ ] 4.3 Smoke logs in; compose enables auth with documented dev credentials
- [ ] 4.4 Help + SECURITY updated
