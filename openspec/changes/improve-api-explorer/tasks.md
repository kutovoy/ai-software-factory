# Tasks

## 1. Spec metadata (`apps/api`)

- [ ] 1.1 Add a top-level `tags` array with one description per resource (18 tags)
- [ ] 1.2 Extend `info.description` with versioning, the direct base URL and the no-auth caveat
- [ ] 1.3 OpenAPI contract test still passes (tags do not change paths/operations)

## 2. Console-targeted spec (`apps/web`)

- [ ] 2.1 `GET /api/openapi.json?servers=console` rewrites `servers` to `[{url: '/', description: 'Console origin (same-origin proxy)'}]`
- [ ] 2.2 Default `/api/openapi.json` keeps the direct server unchanged
- [ ] 2.3 Explorer loads the console-targeted document; interceptor stays as a safety net

## 3. Explorer presentation (`apps/web`)

- [ ] 3.1 Full-width layout on `/help/api`; prose remains `max-w-prose`
- [ ] 3.2 Swagger UI props: `filter`, `tagsSorter: 'alpha'`, `operationsSorter: 'alpha'`,
      `displayRequestDuration`, `showExtensions`, `showCommonExtensions`, `docExpansion: 'list'`,
      `defaultModelsExpandDepth: -1`, `deepLinking`, `tryItOutEnabled`, `persistAuthorization`
- [ ] 3.3 Toolbar above the explorer: API version, console-proxied base URL, no-auth warning
- [ ] 3.4 Update the `api` help entry to describe filter, tags and the server selector

## 4. Tests & wrap-up

- [ ] 4.1 Playwright: filter box present; tag descriptions visible; Servers shows the console origin;
      `GET /api/v1/health` through the explorer returns 200; raw spec still lists the direct server
- [ ] 4.2 `bun run ci`, smoke, Playwright, UI audit green
- [ ] 4.3 STATUS updated; `openspec validate improve-api-explorer`
