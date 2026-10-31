# Tasks

## 1. Explorer

- [x] 1.1 Add `swagger-ui-react` + `@types/swagger-ui-react` to `apps/web`; import its CSS once in the root layout
- [x] 1.2 `ApiExplorer` client component: `dynamic(() => import('swagger-ui-react'), { ssr: false })`,
      `url: '/api/openapi.json'`, `tryItOutEnabled: true`, `docExpansion: 'none'`, deep links, persisted auth
- [x] 1.3 Loading and error states that do not render an empty shell

## 2. Same-origin proxy

- [x] 2.1 `apps/web/src/app/api/v1/[...path]/route.ts`: forward GET/POST/PUT/PATCH/DELETE to
      `${API_BASE_URL}/api/v1/<path>` with query, body and headers; return status/headers/body unchanged
- [x] 2.2 Do not forward hop-by-hop headers (`host`, `content-length`, `connection`); stream the response
- [x] 2.3 Test: `/api/v1/health` → 200 through the console origin; unknown path → backend 404 body

## 3. Page

- [x] 3.1 `/help/api`: banner (actions run against this stack; local API has no auth), live explorer first
- [x] 3.2 Keep the static reference below as the no-JS/fallback view
- [x] 3.3 Update the `api` help entry to describe try-it-out and the same-origin proxy

## 4. Tests & wrap-up

- [x] 4.1 Playwright: explorer renders operations; "Try it out" present; execute `GET /api/v1/health` → 200;
      proxy reachable; static fallback present
- [x] 4.2 `bun run ci`, smoke, Playwright, UI audit green
- [x] 4.3 STATUS updated; `openspec validate add-live-api-explorer`
