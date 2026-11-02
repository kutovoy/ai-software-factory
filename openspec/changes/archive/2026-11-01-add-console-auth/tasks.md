# Tasks

## 1. Persistence
- [x] 1.1 Migration 016: `users`, `sessions`, `work_items.created_by`
- [x] 1.2 Auth repository: create/find/verify, sessions, list/update users
- [x] 1.3 Bootstrap admin on API start

## 2. API
- [x] 2.1 `/auth/login`, `/auth/logout`, `/auth/me`
- [x] 2.2 Session middleware with `AUTH_REQUIRED` and public exemptions
- [x] 2.3 `/users` CRUD (admin only)
- [x] 2.4 Scope work-item/run/inbox reads by owner for members
- [x] 2.5 Forge personal-org provisioning (best effort)

## 3. Console
- [x] 3.1 Login page + logout; middleware redirect
- [x] 3.2 Cookie forwarding on API calls and proxies (`Set-Cookie` included)
- [x] 3.3 Real Users page
- [x] 3.4 Forgejo proxy uses session username
- [x] 3.5 Nav shows the signed-in user

## 4. Verification
- [x] 4.1 Unit + API integration tests for auth and scoping
- [x] 4.2 Playwright login → users → logout
- [x] 4.3 Smoke logs in; compose enables auth with documented dev credentials
- [x] 4.4 Help + SECURITY updated
