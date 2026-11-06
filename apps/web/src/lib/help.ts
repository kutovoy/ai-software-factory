import { FACTORY_NAV, FOOTER_NAV, TOP_NAV } from './nav';

/**
 * In-product help centre (`web-console` spec: "Help centre", "Contextual help",
 * "No dead controls", "Help stays current").
 *
 * Content is typed data, not JSX: the registry is the single source of truth for the
 * `/help` index, the `/help/[...slug]` pages and the contextual `?` control. Every claim
 * here is checked against `docs/STATUS.md` — a page that is a stub says so, and the
 * compose stack's fake forge/harness is stated wherever it changes the observable result.
 *
 * Adding a page/route means adding an entry here (enforced by `help.test.ts` against
 * `nav.ts`, and by the AGENTS.md "Help stays current" rule).
 */

export type HelpSection = 'quick-start' | 'concepts' | 'menu' | 'factories' | 'troubleshooting';

export interface HelpSectionMeta {
  id: HelpSection;
  title: string;
  description: string;
}

/** Diátaxis ordering: tutorial → explanation → reference → how-to → troubleshooting. */
export const HELP_SECTIONS: HelpSectionMeta[] = [
  {
    id: 'quick-start',
    title: 'Quick start',
    description:
      'A tutorial: from docker compose up to a work item that passed its gates, with the diagrams that explain what you are looking at.',
  },
  {
    id: 'concepts',
    title: 'Concepts',
    description:
      'Explanation: definitions as code, the work-item lifecycle, gates and autonomy, runners, scoring, benchmarks, self-improvement and the merge queue.',
  },
  {
    id: 'menu',
    title: 'Menu reference',
    description:
      'Reference: one entry per sidebar item — what the page is for, what it shows and which actions it offers.',
  },
  {
    id: 'factories',
    title: 'Factory how-tos',
    description:
      'How-to guides: start with what the factory can build (supported projects), then add a factory, connect GitHub, choose the model through the environment, register a secret, add an MCP server.',
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    description:
      'Symptom → check: a run that will not start, a gate that looks stuck, a refused benchmark, a canary rollback, an unresolved secret.',
  },
];

export type HelpCalloutTone = 'info' | 'warning' | 'success';

export type HelpDiagramName = 'pipeline' | 'anatomy' | 'gates' | 'stack';

export interface HelpStep {
  title: string;
  detail?: string;
  /** A copy-paste command; rendered in a `<pre>` block. */
  command?: string;
  /** The observable result that proves the step worked. */
  expected?: string;
}

export type HelpBlock =
  | { kind: 'prose'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'steps'; items: HelpStep[] }
  | { kind: 'code'; label?: string; text: string }
  | { kind: 'callout'; tone: HelpCalloutTone; title: string; text: string }
  | { kind: 'diagram'; name: HelpDiagramName; caption: string }
  | { kind: 'checklist'; title: string; items: string[] };

export interface HelpLink {
  label: string;
  href: string;
}

export interface HelpEntry {
  /** Registry id; the URL is `/help/<slug>` (slugs may contain `/`). */
  slug: string;
  title: string;
  section: HelpSection;
  /** Honest phase/status, rendered as a badge. Never claim more than STATUS.md does. */
  status: string;
  summary: string;
  /** The page this entry describes, so the help page can link back to it. */
  pageHref?: string;
  /** Override for the "open the page" label (factory pages name the example factory). */
  pageHrefLabel?: string;
  /**
   * Extra renderer for entries that are generated rather than typed: the API reference is
   * rendered from the served OpenAPI document, so it cannot drift from the routes.
   */
  renderer?: 'api-reference';
  blocks: HelpBlock[];
  related: HelpLink[];
}

const EXAMPLE = '/factories/example';

/**
 * Help links are typed against an illustrative factory path (`/factories/example/...`).
 * Factory URLs carry an opaque `fac_<ulid>` id now (change `add-factory-identity`), so the
 * help pages rewrite that prefix to the factory the reader is actually looking at.
 */
const FACTORY_PREFIX_RE = /^\/factories\/[^/]+\//;

export function rewriteFactoryHref(href: string, factoryId: string | null | undefined): string {
  if (!factoryId) return href;
  const match = FACTORY_PREFIX_RE.exec(href);
  if (!match) return href;
  return `/factories/${encodeURIComponent(factoryId)}/${href.slice(match[0].length)}`;
}

function factoryPageHref(segment: string): string {
  return `${EXAMPLE}/${segment}`;
}

export const HELP_ENTRIES: HelpEntry[] = [
  // ---------------------------------------------------------------- quick start
  {
    slug: 'quick-start',
    title: 'Quick start',
    section: 'quick-start',
    status: 'Verified against the compose stack (fake harness + fake forge)',
    summary:
      'Bring the stack up, prove it with the smoke test, then take one work item from intake through its gates to a merge.',
    blocks: [
      {
        kind: 'callout',
        tone: 'info',
        title: 'What this walkthrough uses',
        text:
          'The compose stack runs with the fake harness, the fake forge and the stub judge, so it needs no model credentials and no network. Every command below works on a fresh checkout. A real GitHub connection and a real model are configuration, not code: see "Connect GitHub" and "Choose the model".',
      },
      {
        kind: 'prose',
        text:
          'A work item is the unit of work. It enters at intake, runs the loop stage by stage (triage → spec → plan → implement → review → verify → ship), and every stage that resolves to a human gate parks on a durable workflow wait until someone decides. Only the ship stage merges a pull request. Scores and benchmarks feed the self-improvement loop, which proposes definition changes instead of editing them. The unit of work is a repository diff verified by checks — see "Supported projects" for what that includes and what it will only propose.',
      },
      { kind: 'diagram', name: 'pipeline', caption: 'The pipeline: intake → loop → gates → merge → score → improve.' },
      {
        kind: 'steps',
        items: [
          {
            title: 'Create your environment file',
            detail:
              'Copy the example file. `FACTORY_MODEL`, `FACTORY_SMALL_MODEL` and `FACTORY_REVIEW_MODEL` are the model names the definitions resolve; point them at a model your OpenAI-compatible endpoint serves.',
            command: 'cp .env.example .env',
            expected: '`.env` exists and stays git-ignored. An unset model reference is reported as `model_env_unresolved` and run creation refuses it with `model_unresolved`.',
          },
          {
            title: 'Start the stack',
            command: 'docker compose up -d --build',
            expected:
              '`docker compose ps` lists `postgres`, `temporal`, `api`, `worker` and `web`. The web console is on http://localhost:3000 and the API on http://localhost:8080.',
          },
          {
            title: 'Check the API health',
            command: 'curl -s http://localhost:8080/health',
            expected: 'JSON with `"status":"ok"` and a Temporal check carrying the task queue address.',
          },
          {
            title: 'Open the console',
            command: 'open http://localhost:3000',
            expected:
              'The console redirects to `/login`. Sign in with the compose bootstrap admin `admin@factory.local` / `factory-admin` (override `FACTORY_ADMIN_EMAIL` / `FACTORY_ADMIN_PASSWORD`; see SECURITY.md). New Chat then loads with the sidebar, the factory switcher on `example`, your account block and a composer. `?` in the top right opens the help entry for the page you are on.',
          },
          {
            title: 'Get a session cookie for API calls',
            detail:
              'Compose sets `AUTH_REQUIRED=1`, so the direct API commands below need the same session the browser has. This logs in once and stores the HttpOnly cookie in a jar.',
            command:
              'curl -sS -c /tmp/factory-cookies.txt -X POST http://localhost:8080/api/v1/auth/login \\\n  -H \'content-type: application/json\' \\\n  -d \'{"email":"admin@factory.local","password":"factory-admin"}\'',
            expected:
              'The response contains `"user"` and the jar holds `factory_session`. Every API call below passes `-b /tmp/factory-cookies.txt`.',
          },
          {
            title: 'Prove the whole pipeline',
            detail:
              'The smoke script migrates the database, creates a fake-harness chat run, approves a permission, drives a one-stage loop through its gate, scores it, runs a benchmark and exercises the merge queue. It cleans up the rows it creates.',
            command: 'bash scripts/smoke.sh',
            expected: 'The script prints `SMOKE PASSED` as its last line.',
          },
          {
            title: 'Create a work item',
            command:
              'curl -sS -b /tmp/factory-cookies.txt -X POST http://localhost:8080/api/v1/factories/<factory-id>/work-items \\\n  -H \'content-type: application/json\' \\\n  -d \'{"title":"Fix the README link","type":"task","source":"manual","harness":"fake","prompt":"fix the broken readme link"}\'',
            expected:
              'The response contains `workItem.id`, `"stage":"triage"` and the pinned `definitionCommit`. The item appears on the Work items board.',
          },
          {
            title: 'Approve the triage gate',
            detail:
              'Use the id from the previous step. The same decision is available in Inbox, where each gate shows its SLA countdown.',
            command:
              'curl -sS -b /tmp/factory-cookies.txt -X POST http://localhost:8080/api/v1/factories/<factory-id>/work-items/<work-item-id>/gates/triage \\\n  -H \'content-type: application/json\' \\\n  -d \'{"decision":"approve","actor":"you","reason":"scope looks right"}\'',
            expected:
              'The response reports `"decision":"approve"` and `"delivery":"update"`; the item advances past triage and the next stage starts.',
          },
          {
            title: 'Follow it to the merge',
            detail:
              'Keep approving gates in Inbox. The ship stage is the only place a PR merges; when the factory\'s GitHub integration sets `mergeQueue`, ship enqueues instead and the Merge queue page shows the batch. With the compose fake forge, the "merge commit" is a content hash, not a git commit.',
            expected:
              'The item reaches `done`, a `merge.merged` event exists on the run/merge evidence, and the run shows events, cost and its `definitionCommit` under Runs.',
          },
        ],
      },
      {
        kind: 'checklist',
        title: 'What success looks like',
        items: [
          '`docker compose ps` shows every service up, and `curl /health` returns `status: ok`.',
          'The console loads at http://localhost:3000 after signing in with the bootstrap admin, with the sidebar, the factory switcher and New Chat.',
          '`bash scripts/smoke.sh` ends with `SMOKE PASSED`.',
          'A work item you created moves from `triage` to a later stage after one approval.',
          'The run behind that item lists its events, cost and pinned `definitionCommit`.',
          'The gate you approved shows the actor and reason in the inbox history / work-item events.',
        ],
      },
      {
        kind: 'diagram',
        name: 'anatomy',
        caption:
          'Factory anatomy: files in git are the source of truth; loading resolves them into resources; agents bind resources to a harness, runner, model and tools.',
      },
      {
        kind: 'prose',
        text:
          'Nothing in the console edits a definition. The API reads the git-backed factory, validates it, and every page is a projection of that resolved config. To change behaviour you edit the files, run `bun run factory validate factories/<name>`, and commit — the next run pins the new commit.',
      },
      {
        kind: 'diagram',
        name: 'gates',
        caption:
          'Gate resolution is first-match-wins: an automation override, then the factory gate, then the global default. A gate is `human`, `agent` or `policy:<name>`.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'The compose stack is not production',
        text:
          'Unless configured, compose runs the fake harness, the fake forge and the stub judge: merges are content hashes, checks are simulated and judge scores are uncalibrated. A real GitHub connection needs a PAT in the secret store plus a webhook secret, and a real model needs `OPENAI_BASE_URL`/`OPENAI_API_KEY` and the `FACTORY_*_MODEL` variables.',
      },
    ],
    related: [
      { label: 'What the factory can build', href: '/help/factories/supported-projects' },
      { label: 'Add a factory', href: '/help/factories/add' },
      { label: 'Work-item lifecycle', href: '/help/concepts/work-item-lifecycle' },
      { label: 'Gates and autonomy', href: '/help/concepts/gates-and-autonomy' },
      { label: 'Troubleshooting: a run will not start', href: '/help/troubleshooting/run-wont-start' },
    ],
  },

  // -------------------------------------------------------------------- concepts
  {
    slug: 'concepts/definitions-as-code',
    title: 'Definitions as code',
    section: 'concepts',
    status: 'Shipped — Phase 1 (ADR-003/ADR-012)',
    summary:
      'A factory is a directory of Markdown + YAML in git. The database indexes it; every run pins the commit it ran with.',
    blocks: [
      {
        kind: 'prose',
        text:
          'Path-is-identity: the directory name under `factories/` is the factory name; the manifest `name` is a label, not an address. `factory.yaml` declares repositories, agent defaults, gates, merge policy, improvement authority and MCP servers; sibling directories hold agents (`agents/<name>/agent.md`), automations, scorers, benchmarks, skills, runners and `routing.yaml`.',
      },
      {
        kind: 'list',
        items: [
          '`factory.yaml` — schemaVersion, agentDefaults, gates, mergePolicy, improvement, mcp.servers.',
          '`agents/<name>/agent.md` — role, model (may be `env:NAME`), harness, runner, tools, gates, MCP allow list.',
          '`automations/<name>/automation.md` — cron or webhook trigger plus the work it starts.',
          '`scorers/<name>/scorer.md` — labels, passing score, sampling rate, judge model and rubric.',
          '`benchmarks/<suite>/suite.yaml` + `tasks/*.yaml` — the configuration matrix and pinned tasks.',
          '`skills/<skill>/SKILL.md`, `runners/<name>.yaml`, `routing.yaml` — capability, execution and routing.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Read-only by design',
        text:
          'Every definition-backed page carries a "Definitions are edited in git" banner. The console and API never edit definitions directly (ADR-012): proposals, canary promotion and authority changes open PRs. After a canary merge, promotion rewrites the local checkout when the worktree is clean and commits it (ADR-049); otherwise it records `promotion_pending_deploy` and the on-disk definition updates on the next checkout/deploy.',
      },
      {
        kind: 'code',
        label: 'Validate, export, diff',
        text: 'bun run factory validate factories/example\nbun run factory export factories/example --check\nbun run factory diff factories/example <other>',
      },
      {
        kind: 'prose',
        text:
          'Validation returns stable codes (`invalid_value`, `missing_field`, `unknown_mcp_server`, `secret_inline_rejected`, …) and prints resolved models, gates and improvement settings. `export --check` proves the canonical export still round-trips byte-for-byte.',
      },
    ],
    related: [
      { label: 'Definition page', href: '/help/factories/definition' },
      { label: 'Add a factory', href: '/help/factories/add' },
      { label: 'Choose the model through the environment', href: '/help/factories/model-env' },
    ],
  },
  {
    slug: 'concepts/signing-in',
    title: 'Signing in',
    section: 'concepts',
    status: 'Shipped — change `add-console-auth`',
    summary:
      'Email + password creates an opaque session cookie; the console redirects signed-out visitors to /login and forwards the cookie to the API.',
    pageHref: '/login',
    pageHrefLabel: 'Open the sign-in page',
    blocks: [
      {
        kind: 'prose',
        text:
          'The console and API share one identity. `POST /api/v1/auth/login` verifies the password (argon2id) and sets an opaque `factory_session` cookie: HttpOnly, SameSite=Lax, Path=/, 7-day sliding expiry. Only the token’s SHA-256 hash is stored, so the database never holds a usable credential.',
      },
      {
        kind: 'list',
        items: [
          'Signed-out page requests redirect to `/login?next=<path>`; `/login`, `/help/api`, Next assets, the favicon, `/api/*` and the forge proxy stay reachable.',
          'A protected API route without a session answers `401 auth_required` when `AUTH_REQUIRED=1`.',
          'Sign out revokes the session server-side and clears the cookie; the console returns to `/login`.',
          'The account block links to the project’s GitHub repository with the GitHub mark, next to Sign out.',
          'With `AUTH_REQUIRED=0` (local development/unit tests) there is no redirect: the console and API behave as the implicit local user.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Bootstrap admin',
        text:
          'If no user exists, the API creates the admin from `FACTORY_ADMIN_EMAIL` / `FACTORY_ADMIN_PASSWORD` on start. If the password is unset it generates one and logs it once — that log line is the only disclosure. Compose supplies local-development defaults; override them on any reachable host.',
      },
    ],
    related: [
      { label: 'Users page', href: '/help/users' },
      { label: 'Roles and scope', href: '/help/concepts/roles-and-scope' },
      { label: 'API', href: '/help/api' },
    ],
  },
  {
    slug: 'concepts/roles-and-scope',
    title: 'Roles and scope',
    section: 'concepts',
    status: 'Shipped — changes `add-console-auth`, `add-factory-identity`',
    summary:
      'Admins manage users and see all factories and work; members see only the factories they own and the work items/runs they created. The forge sees the signed-in username.',
    pageHref: '/users',
    blocks: [
      {
        kind: 'prose',
        text:
          'Every user has one of two roles. `admin` can manage accounts (`GET/POST /users`, `PATCH /users/:id`) and reads every factory, work item and run. `member` gets `403 forbidden` from user management, only sees factories they own and only lists rows whose `created_by` is their own id; rows created before auth (null owner) are admin-only.',
      },
      {
        kind: 'list',
        items: [
          'Work items and runs record the creator; the inbox follows the same owner filter.',
          'Factories are owned too: a factory lives at `factories/<owner>/<name>` (or a legacy top-level `factories/<name>`, admin-owned) and carries a committed `fac_<ulid>` id. The console and the API address a factory only by that id; a member who asks for an id they do not own gets `404 factory_not_found`, so existence is never leaked.',
          'Gate approvals are still attributed to the actor string supplied with the decision, and the audit trail records it.',
          'The Forgejo proxy resolves `/auth/me` and asserts the session username as `X-WebAuth-User`, so the forge sees the real user instead of a shared admin. With auth off it falls back to `FORGEJO_ADMIN_USER`.',
          'Each user gets a best-effort personal organization `u-<username>` on first sign-in.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'OIDC is deferred',
        text:
          '`FORGEJO_OIDC_GROUP_MAP` reserves group→organization mappings for a later IdP phase; no external identity provider is required for console auth.',
      },
    ],
    related: [
      { label: 'Users page', href: '/help/users' },
      { label: 'Signing in', href: '/help/concepts/signing-in' },
      { label: 'Forgejo', href: '/help/forgejo' },
    ],
  },
  {
    slug: 'concepts/work-item-lifecycle',
    title: 'Work-item lifecycle',
    section: 'concepts',
    status: 'Shipped — Phase 2b / 3c',
    summary:
      'Intake → triage → spec → plan → implement → review → verify → ship, with durable gates between stages and one terminal state.',
    blocks: [
      {
        kind: 'prose',
        text:
          'A work item is a durable Temporal workflow. Each stage is a child run of the harness; the workflow waits on a gate between stages. Gates are workflow-level waits (Temporal `condition()`), so a parked gate holds no activity slot — a hundred waiting items do not starve the worker.',
      },
      {
        kind: 'list',
        items: [
          'Intake: manual, webhook or automation creates the item and pins the `definitionCommit`.',
          'Stages: triage (intake judgement), spec (scope + acceptance criteria), plan, implement (branch + PR), review (two reviewers + advisory judge), verify (forge checks), ship (the only merge point).',
          'Gates: a human gate waits for `{decision, actor, reason}`; an agent gate lets the loop continue; `policy:<name>` delegates to a named policy.',
          'Terminal states: `done`, `cancelled`, `rejected`, `failed`. Cancel is idempotent, records actor/reason and emits exactly one `work_item.cancelled` event.',
        ],
      },
      {
        kind: 'prose',
        text:
          'Every transition is an append-only event in the run/work-item log. The read models (`/factories/:factoryId/work-items`, `/factories/:factoryId/runs`) are projections that can be rebuilt from `runs/<id>/events.jsonl` with `factory rebuild --dry-run`, which refuses a corrupt log (`event_log_corrupt`) instead of inventing rows.',
      },
    ],
    related: [
      { label: 'Work items page', href: '/help/work-items' },
      { label: 'Inbox', href: '/help/inbox' },
      { label: 'Gates and autonomy', href: '/help/concepts/gates-and-autonomy' },
    ],
  },
  {
    slug: 'concepts/gates-and-autonomy',
    title: 'Gates and autonomy',
    section: 'concepts',
    status: 'Shipped — Phase 2b / 3c (ADR-013, ADR-018)',
    summary:
      'Gates resolve automation → factory → global. "Lights on" keeps a human on every stage; "lights off" makes every stage agent-driven and requires a benchmark attestation.',
    blocks: [
      {
        kind: 'prose',
        text:
          'A gate is `human`, `agent` or `policy:<name>`. Resolution is first-match-wins: an automation may raise or lower a stage gate for the work it starts; otherwise the factory gate applies; otherwise the global default. The Gates page shows the resolved table with the source of each row.',
      },
      {
        kind: 'list',
        items: [
          'Lights on (default): the factory is not fully autonomous, so human gates remain and a benchmark attestation is not required to merge.',
          'Lights off: every stage resolves to `agent` and the merge policy is automatic. Enabling it is refused with `benchmark_attestation_missing` unless a passing, calibrated, non-partial attestation matches the current commit + configuration hash — or an explicit `{actor, reason}` override is confirmed.',
          'Kill switch: pausing always works. It pauses new stage dispatch and forces every gate back to `human`; the autonomy read model reports enabled/paused, actor, reason, timestamp and the newest `autonomy.*` event.',
          'Gate decisions are durable: an approval is delivered as a Temporal Update (Signal fallback) and survives a worker restart.',
          'Agent gates decide from a verdict, not from a successful run: the stage prompt asks for a final fenced JSON block `{"verdict":"approve|request_changes|reject","summary":"...","findings":[...]}`, and `VERDICT: PASS` / `VERDICT: FAIL` lines are the textual fallback. A `request_changes` verdict feeds the normal loop and escalation path; `factory.yaml` › `agentVerdict: required` turns a missing verdict into `request_changes` (the default `advisory` approves, preserving older factories). The work-item gate history shows the verdict badge, its source and summary.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'No silent downgrade',
        text:
          'A scheduled automation resolves autonomy through the same attestation check a manual item uses. When the gate cannot be satisfied it records `autonomy.attestation_missing` and only human gates apply.',
      },
    ],
    related: [
      { label: 'Gates page', href: '/help/factories/gates' },
      { label: 'Benchmarks and attestation', href: '/help/concepts/benchmarks-and-attestation' },
      { label: 'Troubleshooting: gate stuck', href: '/help/troubleshooting/gate-stuck' },
    ],
  },
  {
    slug: 'concepts/runners-and-sandboxes',
    title: 'Runners and sandboxes',
    section: 'concepts',
    status: 'Shipped — Phase 2a / 3c; compose runs the fake harness',
    summary:
      'Tool execution never happens in the web or API process: a runner leases, executes, heartbeats, collects artifacts and kills the sandbox.',
    blocks: [
      {
        kind: 'prose',
        text:
          'The runner protocol is `lease → exec → heartbeat → artifacts → kill`. The local backend runs the harness in a host process; the Docker backend runs it in a per-run container. Secrets reach the runner by an explicit allowlist; inference credentials are refused, and the harness reaches the model through a per-run proxy token instead of `OPENAI_*` variables.',
      },
      {
        kind: 'list',
        items: [
          '`RUNNER_SANDBOX=exec` (macOS only) wraps the harness in a generated SBPL profile: reads of system paths + workspace, writes only to workspace/run dir/tmp, outbound network denied unless the stage grants `networkPolicy: allowed`.',
          '`RUNNER_SANDBOX=bwrap` (Linux) runs the harness in a bubblewrap jail: read-only `/`, private `/tmp`, a writable bind of the workspace, `--chdir` into it, and `--unshare-net` when the policy denies network. On Linux an unset value auto-selects `bwrap` when the binary is installed.',
          'A requested profile the host cannot honour is never a silent fallback: `RUNNER_SANDBOX=bwrap` without `bwrap` fails the run with `runner.sandbox_unavailable`, recorded on the sandbox step. `exec` on a non-macOS host keeps the older behaviour (unconfined, with the same record). The default is `none`.',
          'Artifacts are captured by path + sha256 into `runs/<runId>/artifacts/`; remote runs upload them to RustFS through short-lived presigned grants and the run detail serves an authenticated download. A missing artifact makes deterministic scoring an `error` score without failing the run.',
          'The compose worker ships the docker CLI (not the daemon) and leases sandboxes through the mounted `/var/run/docker.sock`; `docker compose exec worker docker version` must print a server version.',
          'Because the worker is itself a container, sandboxes join the dedicated `factory-runners` network (`RUNNER_NETWORK`) instead of publishing a host port, and the workspace travels with `docker cp` (`RUNNER_WORKSPACE_MODE=copy`) — the daemon cannot see the worker filesystem. A host worker keeps the bind mount and the 127.0.0.1 port.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Harness credentials',
        text:
          'The harness command carries `OPENAI_BASE_URL`, the per-run proxy token and a per-run derived `OPENCODE_SERVER_PASSWORD`; opencode `serve` generates a random password otherwise and answers 401. The runner image ships an opencode config that declares the `factory` proxy provider, so a bare model name (`best_llm`) resolves to `factory/best_llm` rather than opencode’s built-in default.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Compose caveat',
        text:
          'The compose smoke and benchmark flows still run the fake harness (`HARNESS=fake`, `BENCHMARK_HARNESS=fake`) so CI needs no model credentials; a chat run can use the real opencode path by asking for `harness: "opencode"` (see New Chat), which leases a docker sandbox and calls the configured proxy model. The macOS `sandbox-exec` flag is not exercised in Linux containers.',
      },
    ],
    related: [
      { label: 'Runs page', href: '/help/runs' },
      { label: 'Secrets', href: '/help/secrets' },
      { label: 'Register a secret', href: '/help/secrets/register' },
      { label: 'Remote runners', href: '/help/concepts/runners' },
    ],
  },
  {
    slug: 'concepts/runners',
    title: 'Remote runners',
    section: 'concepts',
    status: 'Shipped — Linux Docker, Windows native, macOS native (`add-runner-platforms-and-artifacts`)',
    summary:
      'Enrollment → preflight → install → heartbeat: a host executes runs locally and polls the API outbound, with no Temporal worker and no database access on the host.',
    blocks: [
      {
        kind: 'prose',
        text:
          'A remote runner moves compute out of the central process. The host runs `factory-runner-agent`, which polls the API over outbound HTTP(S) with a bearer token, leases a sandbox locally, starts the harness adapter, pumps the canonical events back and cleans up. The central worker still owns the durable workflow: it writes commands to a database-backed queue, waits for the result, appends the events to the single-writer event log and records permissions. The host needs no inbound port, no Temporal worker and no Postgres client.',
      },
      {
        kind: 'steps',
        items: [
          {
            title: 'Create the enrollment',
            detail:
              'Name, platform, arch, pool, labels and capacity. The response carries a one-time token, an expiry, a preflight command and an install command.',
            command:
              'curl -sS -b /tmp/factory-cookies.txt -X POST http://localhost:8080/api/v1/runners/enrollments \\\n  -H \'content-type: application/json\' \\\n  -d \'{"name":"build-01","platform":"linux","arch":"x64","pool":"default","labels":{"zone":"eu"},"maxConcurrent":2}\'',
            expected:
              '`enrollment.token`, `enrollment.expiresAt`, `enrollment.preflightCommand` and `enrollment.installCommand`. Only the token hash is stored, so the token cannot be shown again.',
          },
          {
            title: 'Run the preflight on the host',
            detail:
              'The preflight script posts platform checks for the enrollment token, so a missing runtime or an unsupported host fails before installation. The Runners page reads them back with `GET /api/v1/runners/enrollments/:id`.',
            expected: 'Each check is stored on the enrollment and rendered pass/fail on the page.',
          },
          {
            title: 'Install and enroll the agent',
            detail:
              'The install command starts the agent with the token. It exchanges the token for a per-host agent token (returned once), marks the enrollment used and creates a `ready` host row.',
            expected:
              'A host appears in the list with its platform, pool and a fresh heartbeat. A reused or expired token is refused with `enrollment_invalid`.',
          },
          {
            title: 'Watch the heartbeat',
            expected:
              'CPU, RAM, disk/inode usage, load, uptime and lease count are stored per sample; the host detail page charts them. A host that stops heartbeating becomes `unreachable` and raises a heartbeat-age alert.',
          },
        ],
      },
      {
        kind: 'list',
        items: [
          'Scheduling: the worker picks a `ready`, non-draining host matching platform, pool, labels and free capacity (`maxConcurrent` minus active leases), then reserves a lease before sending work. No match fails the run with `no_matching_runner`.',
          'Platforms: Linux hosts run the agent in Docker containers; Windows hosts run it natively with PowerShell (`RUNNER_BACKEND=local` by default) and macOS hosts run it natively under `sandbox-exec` (`RUNNER_SANDBOX=exec`). The wizard generates a bash preflight/install for Linux and macOS and PowerShell for Windows.',
          'Leases: a lease holds one concurrency slot and moves `active → released | expired | error`; an expired command fails the activity with `runner_unavailable` and the workflow records it.',
          'Alert rules: evaluated on heartbeat ingest (threshold + duration) and by a worker loop for stale heartbeats. The default global set covers CPU (85/95%), memory (85/95%), disk (80/90%), disk free bytes, inode usage, heartbeat age (60/150s) and queue wait.',
          'Artifacts: after collection the agent requests run-scoped presigned PUT grants, uploads logs/screenshots/test reports directly to RustFS, and returns object keys/hashes; the central run keeps the metadata and the run detail downloads the blob through an authenticated presigned GET. No long-lived object-store credential reaches the host.',
          'Provider-key boundary: the agent receives the proxy base URL and a per-run inference token only; `OPENAI_*` provider keys never leave the API/worker. Execution secrets travel as names and are resolved on the agent from its own environment.',
          'Revocation: deleting the host invalidates its agent token and cascades its leases and alert history.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'What this does not do',
        text:
          'Windows and macOS runners are native host processes: weaker isolation than the Linux per-run container, so use a dedicated VM or user for untrusted code (a Windows service wrapper and a launchd plist are documented follow-ups). Transport security is a bearer token with TLS expected at the edge; `cert_fingerprint` is reserved for mTLS follow-up, not enforced. There is no console editor for alert rules yet — the rules are shown and edited through `PUT /api/v1/runner-alert-rules`.',
      },
    ],
    related: [
      { label: 'Runners page', href: '/help/runners' },
      { label: 'Runners and sandboxes', href: '/help/concepts/runners-and-sandboxes' },
      { label: 'Troubleshooting: runner alerts', href: '/help/troubleshooting/runner-alerts' },
    ],
  },
  {
    slug: 'concepts/scoring-and-calibration',
    title: 'Scoring and calibration',
    section: 'concepts',
    status: 'Shipped — Phase 4a (ADR-016/ADR-017)',
    summary:
      'Deterministic checks and LLM judges score runs with full provenance; calibration decides whether a judge may be trusted for a gate.',
    blocks: [
      {
        kind: 'prose',
        text:
          'Scorers live in the definition. A scorer whose rubric body declares a `checks:` block is deterministic (tests/build/lint from `artifacts/checks.json` or tool-call events); otherwise it is an LLM judge. Every score records the scorer, label, value, rationale, evidence links, `rubricHash`, `promptHash`, judge model + version, tokens and cost.',
      },
      {
        kind: 'list',
        items: [
          'Sampling is deterministic (`sha256(runId)`), so the same run is scored or skipped consistently.',
          'A per-factory daily budget yields `budget_exhausted` for judge scoring; deterministic scoring still runs.',
          'Calibration compares judge labels with a golden set (exact + within-tolerance agreement, confusion matrix, pass/fail verdict); below the minimum size it reports `insufficient_data`.',
          'An uncalibrated judge blocks self-improvement eligibility and cannot satisfy the benchmark gate.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Stub judge in compose',
        text:
          'Compose sets `SCORING_JUDGE_MODE=stub`; the OpenAI judge path exists but needs `OPENAI_BASE_URL`/`OPENAI_API_KEY`. Judge scores stay `uncalibrated` until a calibration passes for the current rubric hash + model.',
      },
    ],
    related: [
      { label: 'Scorers page', href: '/help/factories/scorers' },
      { label: 'Benchmarks and attestation', href: '/help/concepts/benchmarks-and-attestation' },
    ],
  },
  {
    slug: 'concepts/benchmarks-and-attestation',
    title: 'Benchmarks and attestation',
    section: 'concepts',
    status: 'Shipped — Phase 4b (ADR-018/ADR-019)',
    summary:
      'A benchmark runs a pinned task × configuration matrix; a passing, calibrated, non-partial attestation is what unlocks fully autonomous gates.',
    blocks: [
      {
        kind: 'prose',
        text:
          'A suite declares tasks and a configuration matrix. The `configHash` is `sha256(matrix + definitionCommit)`, so changing either invalidates prior attestations. Trials run as child runs with a fresh fake-forge repo, a pinned full SHA, `hermetic: true` and `networkPolicy: denied`; tasks tagged `requires-network` fail with `network_denied` and are recorded, not hidden.',
      },
      {
        kind: 'list',
        items: [
          'Cost is estimated before the run (trials × median comparable run cost); a confirmation threshold returns `cost_confirmation_required`, and a hard cap skips the rest with `budget_exhausted` (partial results).',
          'Aggregation reports passRate, weightedScore, sampleSize, cost, errors, skipped and uncalibrated counts; the Pareto frontier labels highest_performance / most_efficient / lowest_cost, and a single recommendation appears only on dominance.',
          'An attestation binds factory + commit + configHash. A partial matrix records a reporting-only attestation marked `partial`; the autonomy gate ignores it.',
        ],
      },
    ],
    related: [
      { label: 'Benchmarks page', href: '/help/factories/benchmarks' },
      { label: 'Troubleshooting: benchmark refused', href: '/help/troubleshooting/benchmark-refused' },
      { label: 'Gates and autonomy', href: '/help/concepts/gates-and-autonomy' },
    ],
  },
  {
    slug: 'concepts/self-improvement-and-canary',
    title: 'Self-improvement and canary',
    section: 'concepts',
    status: 'Shipped — Phase 5a / 5b (ADR-020/ADR-021)',
    summary:
      'Eligible factories get proposals from observed failures; the improvement authority decides propose-only, PR, or a canary rollout that is promoted or rolled back on evidence.',
    blocks: [
      {
        kind: 'prose',
        text:
          'The loop is eligibility → observe → dedupe → probe → compose → decide. Eligibility needs enough scored runs and calibrated judges. The observer turns failure evidence into edits (invariant edits to `agents/*/agent.md`, domain edits to `scorers/*` or `skills/*`); a blast-radius guard refuses `factory.yaml`, `runners/*`, `benchmarks/*`, source and anything outside the allowed paths with `edit_out_of_scope`. A contrastive probe replays the same work item + prompt + scorer + rubric; a positive delta wins.',
      },
      {
        kind: 'list',
        items: [
          'Authority `propose_only`: proposals are recorded and can be accepted/rejected; no definition is changed.',
          'Authority `pr`: an accepted proposal opens a PR on the definition repo (the console never writes the worktree).',
          'Authority `canary`: a rollout publishes the candidate as a version (tree + branch + draft PR), routes new items by `sha256(workItemId) % 100 < canaryPercent`, and compares pass rate / failure rate per pinned commit over the observation window.',
          'Promotion merges the candidate PR; a regression beyond `rollbackThreshold` rolls it back automatically. Manual promote/rollback work regardless of the window and are audited with actor + reason.',
          'One rollout per factory may be in flight; a second start is refused with `canary_active`.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Lessons library',
        text:
          'Lessons (`{cue, lesson, evidence, confidence}`) are written per factory under `runs/experience/<factory>/` and can be promoted to a shared library. Promotion is opt-in.',
      },
    ],
    related: [
      { label: 'Self-improvement page', href: '/help/factories/self-improvement' },
      { label: 'Troubleshooting: canary rollback', href: '/help/troubleshooting/canary-rollback' },
      { label: 'Scoring and calibration', href: '/help/concepts/scoring-and-calibration' },
    ],
  },
  {
    slug: 'concepts/merge-queue',
    title: 'Merge queue',
    section: 'concepts',
    status: 'Shipped — Phase 3b (ADR-022/ADR-023)',
    summary:
      'When the integration sets `mergeQueue`, ship enqueues instead of merging; a deterministic merge train gates the merged stack and reverts only the offender.',
    blocks: [
      {
        kind: 'prose',
        text:
          'The queue is one durable workflow per factory (`USE_EXISTING`) and a unique partial index allows at most one batch in flight. A batch merges its PRs in order, gates the merged stack at the new head, and keeps it if green. If a stack goes red it bisects: the clean subset lands, the offending PR is reverted with a single commit and marked `needs_human` with its failing checks.',
      },
      {
        kind: 'list',
        items: [
          'A stack that never reports within `MERGE_CHECKS_TIMEOUT_MS` fails `checks_timeout` and the whole batch is reverted — nothing merges.',
          'The queue key is the branch (`factory/<workItemId>`), so a reset forge cannot dedupe a fresh PR against a stale row.',
          'A human revert is a one-shot `MergeRevertWorkflow`, audited with actor + reason; it reverts, never force-pushes.',
          'Webhook deliveries are HMAC-verified before parsing, deduped by delivery id, filtered, and framed as untrusted input.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Fake forge in compose',
        text:
          'The compose stack uses the fake forge: merges apply a branch diff and produce a content-hash SHA, and check results are simulated. A real GitHub connection needs a PAT and webhook secret; the GitHub REST path is wired but exercised offline.',
      },
    ],
    related: [
      { label: 'Merge queue page', href: '/help/factories/merge-queue' },
      { label: 'Connect GitHub', href: '/help/factories/connect-github' },
    ],
  },

  {
    slug: 'concepts/factory-stack',
    title: 'Factory stack',
    section: 'concepts',
    status: 'Shipped — factory engineering',
    summary:
      'The seven layers a software factory is made of, from factories-as-code at 00 to access at 06 — and which of them this console actually shows.',
    blocks: [
      {
        kind: 'prose',
        text:
          'A software factory is a stack, not a single agent. Layer 00 is the definition: factories, agents, gates, scorers and benchmarks as files in git. Layer 01 is data and context — what an agent may read, how much of it, and which sources are trusted. Layer 02 is compute: the runner, sandbox and workspace a stage executes in. Layer 03 is inference: the model and harness the agent calls. Layer 04 is improvement: scoring, calibration, benchmarks, proposals and the canary loop. Layer 05 is orchestration: the durable SDLC workflow, gates, retries and the merge queue. Layer 06 is access: identity, roles, secrets and MCP servers.',
      },
      {
        kind: 'diagram',
        name: 'stack',
        caption:
          '00 factories-as-code → 01 data/context → 02 compute → 03 inference → 04 improvement → 05 orchestration → 06 access.',
      },
      {
        kind: 'list',
        items: [
          '00 factories-as-code: `factory.yaml`, `agents/`, `automations/`, `scorers/`, `benchmarks/`, `skills/`, `runners/` and `routing.yaml` — git is the source of truth.',
          '01 data/context: the repositories, artifacts, event logs and lessons a stage may use; secrets are allowlisted by name.',
          '02 compute: the runner protocol (`lease → exec → heartbeat → artifacts → kill`) and the sandbox the harness runs in.',
          '03 inference: the harness + model an agent binds to; model references resolve through `env:` so no vendor is hardcoded.',
          '04 improvement: deterministic checks and LLM judges, calibration, benchmarks, proposals and canary rollouts.',
          '05 orchestration: the durable work-item workflow (triage → ship), gate resolution, retries and the merge train.',
          '06 access: console identity, roles and scope, the secrets registry and MCP server bindings.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'The console is a projection',
        text:
          'Every page here renders a layer of the stack from the API — it never edits a definition or executes a tool. Dashboard shows the orchestration state and outcome metrics, Readiness scores layers 00 and 02 against the checkout, and Definitions as code explains where layer 00 lives. A number you see is a projection of recorded events; missing data is shown as missing, never invented.',
      },
    ],
    related: [
      { label: 'Dashboard', href: '/help/factories/dashboard' },
      { label: 'Readiness', href: '/help/factories/readiness' },
      { label: 'Definitions as code', href: '/help/concepts/definitions-as-code' },
      { label: 'Gates and autonomy', href: '/help/concepts/gates-and-autonomy' },
    ],
  },

  // --------------------------------------------------------------- menu reference
  {
    slug: 'chat',
    title: 'New Chat',
    section: 'menu',
    status: 'Shipped — Phase 2b; compose runs the fake harness by default',
    summary:
      'Talk to the factory through the same adapter + runner pipeline its runs use, with the event stream rendered live.',
    pageHref: '/chat',
    blocks: [
      {
        kind: 'prose',
        text:
          'New Chat is the harness front-end: a prompt becomes a run (`POST /chat`), and the response is the canonical `FactoryEvent` stream the runner produces — the same events Runs shows. The composer defaults to the factory\'s resolved harness and model; the model default comes from the API, so an unresolved `env:` reference is never shown as a literal.',
      },
      {
        kind: 'list',
        items: [
          'Factory: the switcher in the sidebar selects the factory by its `fac_<ulid>` id; factory pages carry it in the path (`/factories/<id>/...`), and New Chat remembers the selected factory.',
          'Composer: sends the prompt and starts streaming; tool calls, messages and terminal events render in order.',
          'Permissions: when the harness asks for approval, the prompt is inline — approve or deny with feedback.',
          'Cancel: stops the run; the terminal event closes the stream.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Which harness runs',
        text:
          'The smoke script and benchmark trials use the fake harness, so CI needs no credentials. Choosing `opencode` in New Chat leases a docker sandbox, starts `opencode serve` inside it and streams a real model answer through the per-run inference proxy; the fake adapter records MCP wiring as capability flags instead of enforcing it.',
      },
    ],
    related: [
      { label: 'Runs', href: '/help/runs' },
      { label: 'Choose the model through the environment', href: '/help/factories/model-env' },
      { label: 'Troubleshooting: a run will not start', href: '/help/troubleshooting/run-wont-start' },
    ],
  },
  {
    slug: 'forgejo',
    title: 'Forgejo (local forge)',
    section: 'menu',
    status: 'Shipped — console identity + SSH; OIDC group mapping is deferred',
    summary:
      'The git forge behind every PR link: served under /extras/forgejo with proxy auto-login, git over SSH on port 2222, and an optional websocket proxy mode.',
    pageHref: '/extras/forgejo/',
    blocks: [
      {
        kind: 'prose',
        text:
          'The factory ships its own Forgejo instance, enabled by default and reachable at `/extras/forgejo/`. Pull requests opened by the loop live there, so the PR link on a work item resolves from your machine. It is internal to the compose network; the console proxy resolves the `factory_session` cookie through `/auth/me` and asserts that username as `X-WebAuth-User`, so the forge sees the signed-in user without a second login.',
      },
      {
        kind: 'list',
        items: [
          'Signed in: the proxy asserts your username and Forgejo auto-registers the reverse-proxy identity; each user gets a best-effort personal organization `u-<username>`.',
          'Signed out with `AUTH_REQUIRED=1`: forge GETs redirect to `/login?next=…`; other verbs (including git push) answer `401 auth_required`.',
          'Auth off: the proxy falls back to `FORGEJO_ADMIN_USER` — the old single-user behaviour for local development.',
          'Git over SSH: the built-in server is published on `localhost:2222`, so `git clone ssh://git@localhost:2222/<org>/<repo>.git` works. Host keys persist in the `forgejo-data` volume; add your key in Forgejo → Settings → SSH keys (no key is seeded).',
          'Websockets: a route handler cannot upgrade them, so the default mode is HTTP through the console. The opt-in `docker compose -f compose.yaml -f compose.proxy.yaml up -d` adds Caddy on `http://localhost:3001` and reverse-proxies everything, including upgrades; it asks `GET /api/v1/auth/forge-identity` (200 + `X-WebAuth-User`, 401 when signed out) so the forge keeps auto-login.',
          'OIDC group→organization mapping (`FORGEJO_OIDC_GROUP_MAP`) is a documented config contract for a later IdP phase, not built yet.',
        ],
      },
    ],
    related: [{ label: 'Settings: local forge', href: '/factories/hello-nextjs/settings' }],
  },
  {
    slug: 'inbox',
    title: 'Inbox',
    section: 'menu',
    status: 'Shipped — Phase 2b / 3c',
    summary:
      'Everything waiting on a human: gate approvals, pending permissions and failed runs.',
    pageHref: '/inbox',
    blocks: [
      {
        kind: 'prose',
        text:
          'The inbox is the queue of durable waits. A gate approval shows the stage, the gate and the SLA countdown; approving continues the work item, requesting changes requires feedback and routes the item back. Pending permissions are agent-level requests that block a run until decided. Failed runs resolve automatically when a retry succeeds.',
      },
      {
        kind: 'list',
        items: [
          'Gate approvals — approve or request changes with a reason; the decision is attributed to the actor.',
          'Pending permissions — allow or deny; denial ends the run with the feedback attached.',
          'Failed runs — deep links to the run; a successful retry removes the row.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'No slot cost',
        text:
          'A parked gate or permission holds no worker activity slot. The permission SLA (`PERMISSION_TIMEOUT_MS`, default 30 minutes) auto-denies so a forgotten prompt cannot block forever; gates wait until decided.',
      },
    ],
    related: [
      { label: 'Work-item lifecycle', href: '/help/concepts/work-item-lifecycle' },
      { label: 'Gates page', href: '/help/factories/gates' },
      { label: 'Troubleshooting: gate stuck', href: '/help/troubleshooting/gate-stuck' },
    ],
  },
  {
    slug: 'work-items',
    title: 'Work items',
    section: 'menu',
    status: 'Shipped — Phase 2b / 3c',
    summary:
      'The board of work items by stage, with status filters, created/updated timestamps, create, cancel, retry and per-item gate state.',
    pageHref: '/factories/example/work-items',
    blocks: [
      {
        kind: 'prose',
        text:
          'The board is factory-scoped: it lives at `/factories/<id>/work-items` and groups the newest visible items of that factory by stage (triage → ship). Cancelled items are hidden by default so the board reflects live work; the status chips (all / active / escalated / done / failed / cancelled) toggle exactly the statuses you select, and an empty board says that the filters excluded everything instead of pretending there is no work. Each card carries the stage hint, the pending gate, the SLA countdown, links to the item\'s runs, and when the item was created and last updated (the exact timestamp is in the tooltip). The create form starts an item at triage and pins the current `definitionCommit`.',
      },
      {
        kind: 'list',
        items: [
          'Filters: status chips; the factory is the one whose page you are on. Cancelled is off until you turn it on.',
          'Timestamps: created and last updated, relative with the absolute time in the `title`.',
          'Create: title, type, source, harness and prompt; the response returns the item id and stage.',
          'Open: the detail page lists runs, gate history, events and retries for the item.',
          'Cancel: takes an actor + reason, is idempotent and emits exactly one `work_item.cancelled`; a terminal item is refused with `invalid_state`.',
          'Retry: an `escalated`, `failed`, `blocked` or `cancelled` item can be re-opened with an actor + optional reason. It returns to `active` at its current stage, the cancellation flags are cleared, `work_item.retried` records the previous status and the stage is dispatched again under a new attempt (`factory-<itemId>-a<n>`). `active` and `done` items are refused with `work_item_not_retryable`; a double submit within 60 seconds returns the existing dispatch.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Retry lives on the work item',
        text:
          'A factory stage run cannot be retried on its own (`run_not_retryable`) — it belongs to its work item. The run page links to the work item, where the retry control re-dispatches the current stage; the attempt badge and the Retries list show what happened.',
      },
    ],
    related: [
      { label: 'Work-item lifecycle', href: '/help/concepts/work-item-lifecycle' },
      { label: 'Inbox', href: '/help/inbox' },
      { label: 'Runs', href: '/help/runs' },
    ],
  },
  {
    slug: 'runs',
    title: 'Runs',
    section: 'menu',
    status: 'Shipped — Phase 2a',
    summary:
      'Every harness run: status, factory, harness, duration, cost, pinned definition commit and a drill-down to its event stream.',
    pageHref: '/factories/example/runs',
    blocks: [
      {
        kind: 'prose',
        text:
          'Runs lives at `/factories/<id>/runs` and lists that factory\'s newest runs, filterable by status. A run detail replays the event stream from `Last-Event-ID`, shows per-stage cost, artifacts, permissions and the scores attached to it. The `definitionCommit` on a run is the exact definition it executed.',
      },
      {
        kind: 'list',
        items: [
          'Auto-refresh: the header control (Off / 15s / 30s / 60s, default 15s, remembered per browser) re-runs the server projection on that interval while the tab is visible; it pauses when the tab is hidden and shows when the data was last refreshed.',
          'Filter: status (`running`, `pending`, `ok`, `error`, `cancelled`); the factory comes from the URL.',
          'Detail: events, steps, artifacts (`runs/<runId>/artifacts/`, or RustFS-backed download links for remote runs), permissions, scores and cost.',
          'Score detail: label, value, rationale, evidence links, provenance (`rubricHash`, judge model/version), calibration state.',
          'Cancel is offered only while the run is `pending`, `running` or `cancelling`; a terminal run shows its end state instead of a dead button.',
          'Manual GC: the Runs header control removes terminal runs older than `days` and beyond the newest `keep` per factory, with their rows, run directories, artifact blobs and terminal canary trees. `dryRun` reports the plan without deleting anything; active runs are always protected.',
          'A chat run that failed or was cancelled can be retried as a new run. A factory stage run cannot: the page links to the work item, where retry re-dispatches the current stage under a new attempt.',
        ],
      },
      {
        kind: 'prose',
        text:
          'A failed run shows a failure panel: the cause recorded by the failing activity (`code: message`, not Temporal’s `Activity task failed` wrapper), the code, every failed step, the workflow id and a link into the Temporal UI at `http://localhost:8233/namespaces/default/workflows/<workflowId>`. Known codes (`docker_unavailable`, `model_unresolved`, `runner_unavailable`, `permission_timeout`) carry a remediation hint; anything else points at the workflow history. A cancelled run shows the cancellation reason and actor; a healthy run shows no panel.',
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Long identifiers stay inside their cell',
        text:
          'The pinned commit shows a 12-character short SHA with the full 40-character value in the cell’s `title` and behind its copy button, so the metadata grid never overlaps the harness/model cell on narrow viewports.',
      },
    ],
    related: [
      { label: 'Runners and sandboxes', href: '/help/concepts/runners-and-sandboxes' },
      { label: 'Scoring and calibration', href: '/help/concepts/scoring-and-calibration' },
    ],
  },
  {
    slug: 'runners',
    title: 'Runners',
    section: 'menu',
    status: 'Shipped — Linux Docker, Windows native, macOS native (`add-runner-platforms-and-artifacts`)',
    summary:
      'Enroll remote hosts, read their heartbeat load, leases and alerts, drain a host or delete it. Tool execution stays on the runner, never in the console.',
    pageHref: '/runners',
    blocks: [
      {
        kind: 'prose',
        text:
          'Runners is the operator surface for remote hosts. A host runs the harness and its sandbox itself; the console and the API only enroll it, read what it reports and send it work. The summary counts ready hosts, active leases, active alerts and pools, and the host table shows name, platform/arch, pool and labels, status, the last heartbeat, CPU/RAM/disk load from the newest sample, leases in use against capacity, and the active alert count. A host detail page adds sparklines over the stored samples, the raw heartbeat payload, its leases and its alerts.',
      },
      {
        kind: 'list',
        items: [
          'Add runner: name, platform (Linux, Windows or macOS), arch, pool, `key=value` labels and max concurrency. The API returns a one-time token plus a platform-appropriate preflight command (bash for Linux/macOS, PowerShell for Windows) and an install command; the token is shown once and only its hash is stored.',
          'Preflight: run the preflight command on the host, then “check status” reads `GET /api/v1/runners/enrollments/:id` and lists the reported checks pass/fail before installation.',
          'Drain: stops new leases on the host while running leases finish; Resume clears the flag. The status badge shows `draining` alongside the lifecycle status.',
          'Delete: removes the host row and, by cascade, its leases and alert history. There is no undo — the agent token stops working immediately.',
          'Alerts: firing, acknowledged, silenced and resolved rows with severity, metric value, rule id, message and last-seen time; Acknowledge and Silence 1h call the alert endpoints and refresh the list. Resolved history is collapsed under a summary.',
          'Alert rules: shown read-only. The API seeds the default global thresholds; editing them is `PUT /api/v1/runner-alert-rules` until the console grows an editor.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Platform isolation',
        text:
          'Linux hosts run the agent in Docker containers. Windows hosts run it natively with PowerShell (`RUNNER_BACKEND=local`, PowerShell preflight/install); macOS hosts run it natively under `sandbox-exec` (`RUNNER_BACKEND=local`, `RUNNER_SANDBOX=exec`). Native runners are weaker isolation than a per-run container — use a dedicated VM or user for untrusted code. The agent authenticates with a bearer token over outbound HTTPS — TLS termination is expected at the central edge, and mTLS is reserved, not built. The agent receives only the per-run inference proxy token and secret names, never provider credentials.',
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Empty is not zero',
        text:
          'A gauge with no value means the agent has not reported that metric yet, not that usage is 0%. “No runners enrolled” and “no firing alerts” are the healthy empty states; deleting a host removes its history rather than archiving it.',
      },
    ],
    related: [
      { label: 'Remote runners', href: '/help/concepts/runners' },
      { label: 'Runners and sandboxes', href: '/help/concepts/runners-and-sandboxes' },
      { label: 'Troubleshooting: runner alerts', href: '/help/troubleshooting/runner-alerts' },
    ],
  },
  {
    slug: 'factories/mcps',
    title: 'MCPs and apps',
    section: 'menu',
    status: 'Shipped — Phase 6a (ADR-027)',
    summary:
      'The MCP registry: servers declared in `factory.yaml`, their transport, health, bound agents, tool globs and credential names.',
    pageHref: '/factories/example/mcps',
    blocks: [
      {
        kind: 'prose',
        text:
          'Servers are declared in `factory.yaml` (`mcp.servers`) and bound per agent (`agents[].mcp`). This page registers a declared server in the index, shows which agents bind it and which tool globs each receives, and runs a transport-level probe in the runner. The legacy `mcpServers` map still validates and is normalised into the same declaration.',
      },
      {
        kind: 'list',
        items: [
          'Add server: choose a server that is already declared in git and register it in the index — the page does not write the definition.',
          'Test: runs in the worker/runner, resolves credentials by name and records transport/latency/error; a failure marks the server `unhealthy` while bound agents still validate.',
          'Bindings: allowed/denied globs are opencode-specific; other harnesses record them as capability flags (best effort, no enforcement).',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Probe depth',
        text:
          'The stdio success criterion is transport-level ("exited 0" or "still alive at the timeout"), not a full MCP JSON-RPC handshake.',
      },
    ],
    related: [
      { label: 'Add an MCP server', href: '/help/mcps/add' },
      { label: 'Agents page', href: '/help/factories/agents' },
      { label: 'Register a secret', href: '/help/secrets/register' },
    ],
  },
  {
    slug: 'secrets',
    title: 'Secrets',
    section: 'menu',
    status: 'Shipped — Phase 6a (ADR-026)',
    summary:
      'A name-only registry with presence checks and a usage audit. Values never enter the database, events, logs, API responses or definitions.',
    pageHref: '/secrets',
    blocks: [
      {
        kind: 'prose',
        text:
          'A secret is a name + provider + scope + description + rotation metadata. Presence is a boolean reported at read time as `resolved`/`unresolved`; the value itself lives in the environment (or a managed provider behind the same registry). Definitions reference names only, e.g. `env: { GITHUB_TOKEN: "GITHUB_TOKEN" }`.',
      },
      {
        kind: 'list',
        items: [
          'Register: name, provider, scope, description; a `value` is refused with `secret_value_rejected` before any query.',
          'Rotate: metadata only; the value is replaced in the environment/provider.',
          'Delete: refused with `secret_in_use` while a definition still references the name, naming the referencing resources.',
          'Usage: count, last run, per-run rows and the resources that reference the name; run leases record the names resolved, never values.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Presence, not correctness',
        text:
          'The registry verifies that a name resolves, not that the credential is valid. The first real call is the real test — the page says so too.',
      },
    ],
    related: [
      { label: 'Register a secret', href: '/help/secrets/register' },
      { label: 'Troubleshooting: secret unresolved', href: '/help/troubleshooting/secret-unresolved' },
    ],
  },
  {
    slug: 'users',
    title: 'Users',
    section: 'menu',
    status: 'Shipped — change `add-console-auth`',
    summary:
      'Admins list accounts, create users, change roles, disable/enable and delete accounts; members see only the work they created.',
    pageHref: '/users',
    blocks: [
      {
        kind: 'prose',
        text:
          'The page is admin-only. It lists each account’s email, username, name, role, active/disabled status and personal forge organization (`u-<username>`, created best-effort on first sign-in). A member who opens `/users` sees an “Admin only” message instead of the table.',
      },
      {
        kind: 'list',
        items: [
          'Create: email, username, optional name, role and a password of at least 8 characters. The account can sign in immediately.',
          'Change role: `admin` manages users and sees all work; `member` sees only work items and runs they created.',
          'Disable/enable: a disabled account cannot sign in; its sessions are refused by the API.',
          'Delete: removes the account and cascades its sessions; work it created becomes admin-only. You cannot delete the account you are signed in as, and the last active admin cannot be deleted.',
          'Every mutation goes through the console’s same-origin `/api/v1` proxy with the session cookie.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Compose credentials are local development only',
        text:
          'Compose bootstraps `FACTORY_ADMIN_EMAIL` / `FACTORY_ADMIN_PASSWORD` (defaults `admin@factory.local` / `factory-admin`). They are checked into git for the demo; override both and set `AUTH_COOKIE_SECURE=1` before exposing the console. With `AUTH_REQUIRED=0` the console and API run as the implicit local user and this page is reachable without a session.',
      },
    ],
    related: [
      { label: 'Signing in', href: '/help/concepts/signing-in' },
      { label: 'Roles and scope', href: '/help/concepts/roles-and-scope' },
      { label: 'Gates and autonomy', href: '/help/concepts/gates-and-autonomy' },
    ],
  },
  {
    slug: 'api',
    title: 'API',
    section: 'menu',
    status: 'Shipped — path-versioned `/api/v1` (ADR-030)',
    summary:
      'Every endpoint in one place, rendered from the served OpenAPI document: read it here, or execute it with “Try it out” through the console’s same-origin /api/v1 proxy.',
    renderer: 'api-reference',
    blocks: [
      {
        kind: 'prose',
        text:
          'Every public resource lives under `/api/v1` — factories, the batch `/inbox`, scoring, benchmarks, self-improvement, secrets, integrations and webhooks. Every factory-scoped resource is nested and addressed by the factory id: `/api/v1/factories/<factoryId>/work-items`, `/runs`, `/gates`, `/autonomy`, `/governance`, `/budget`, `/mcp`, `/capabilities`, `/intake`, `/scores`, `/calibration`, `/scoring`, `/benchmarks`, `/canary`, `/improvement`, `/proposals`, `/lessons`, `/merge-queue` and `/automations`. `GET /api/v1/inbox` is the one cross-factory read: it returns pending gates, permissions and failed runs in one owner-scoped projection. There is no global `/work-items`, `/runs`, `/scores` or `/proposals` route, and factory-scoped requests carry the factory in the path — never `?factory=`. `GET /health` stays unversioned for probes, and `GET /api/v1/health` serves the same check to versioned clients. The document below is `GET /api/v1/openapi.json`; the API contract test fails when a served route is missing from it (or the document lists a route that is not served), so this page lists exactly what is live.',
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Versioning rule',
        text:
          'The prefix is the version. An additive change (a new endpoint, a new optional field) stays in `/api/v1`; a breaking change — a removed or renamed field, an incompatible response shape, a changed required parameter — introduces a new prefix, and the old one keeps serving until it is removed deliberately. Clients should pin the prefix rather than follow `/api/latest`.',
      },
      {
        kind: 'prose',
        text:
          'The raw document is a standard OpenAPI 3.1 file: point Swagger UI at it, or import it in Postman (Import → Link) to get a request collection. The live explorer at the top of this page is Swagger UI itself, loaded from that document: open an operation, press “Try it out”, edit the parameters and execute it — the status and response body come back inline. Requests go to this console’s origin (`/api/v1/…`) and are proxied server-side to the API, so the browser never talks to the API host and CORS never applies. Console auth adds a session cookie: with `AUTH_REQUIRED=1`, sign in first and the same-origin proxy forwards `factory_session`; `/auth/login`, `/health` and the OpenAPI document stay public.',
      },
      {
        kind: 'list',
        items: [
          'Filter: the box above the operations narrows the list by path, method or summary as you type — useful with 61 paths on one page.',
          'Tags: groups are alphabetical and each carries a one-line description of the resource it covers, so `runs` and `work-items` are not just labels.',
          'Servers: the selector shows the console origin (`/`), which is where “Try it out” really sends requests. The raw document still advertises the direct API host (`http://localhost:8080`) for Postman and other Swagger UI imports — add `?servers=console` to `/api/openapi.json` to get the console-targeted copy.',
          'Request duration: every executed request reports how long it took, and expanded operations show their extensions and common extensions.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'When the API is down',
        text:
          'The explorer and the reference are both fetched at page load. If the API is unreachable the explorer says so with the error and a retry control instead of rendering an empty shell, and the static reference below stays readable (or explains why it cannot be read); `/health` tells you whether the API and Temporal are up.',
      },
    ],
    related: [
      { label: 'Raw OpenAPI document', href: '/api/openapi.json' },
      { label: 'Quick start', href: '/help/quick-start' },
      { label: 'Definitions as code', href: '/help/concepts/definitions-as-code' },
    ],
  },
  {
    slug: 'factories/dashboard',
    title: 'Dashboard',
    section: 'menu',
    status: 'Shipped — Phase 2b / 4a / console-ops',
    summary:
      'An operations view: autonomy and canary state, last activity, recent work items and runs, deliverables (PRs, merged items, latest patch) and factory metrics over a window.',
    pageHref: factoryPageHref('dashboard'),
    pageHrefLabel: 'Open Dashboard (example factory)',
    blocks: [
      {
        kind: 'prose',
        text:
          'The dashboard answers "what is this factory doing and what did it produce", not only "how are the numbers". It shows the autonomy state in force (enabled/paused, the declaration and any override), the canary rollout (active or last), the newest recorded activity, the newest work items with their stage/status, the newest runs with harness/model/cost, and the deliverables: pull request links, the count of items that reached `done`, and the latest captured artifact. Metric cards are computed from runs, scores and forge events over a selectable window; missing data is `null` with a reason (`no_runs_in_bucket`, `no_scores_in_bucket`) rather than a fabricated zero. Budget and quotas: the budget panel shows lifetime, day and month spend against `budget.maxCostUsdPerFactory`, `maxCostUsdPerDay` and `maxCostUsdPerMonth`, plus pending/running runs against `maxConcurrentRuns`. An unconfigured cap says "no cap" instead of pretending it is zero; an exhausted cap is marked. Admission refuses new work with `factory_budget_exhausted` or `factory_quota_exhausted`.',
      },
      {
        kind: 'list',
        items: [
          'State: autonomy (enabled/paused/override), canary (active or last), last activity.',
          'Readiness: the deterministic score, its status, the top failing check labels and a link to the Readiness page.',
          'Factory stack: a link to the 00–06 stack concept, so the dashboard sits in the larger picture rather than floating alone.',
          'Work items: status counts plus the newest items, each linking to its detail page.',
          'Runs: newest runs with status, harness/model, cost and start time, linking to the run detail.',
          'Deliverables: PR links from items, the `done` (merged) count and the latest patch/artifact from the newest run that captured one.',
          'Where results live: the PR carries the diff and checks; the run detail carries the patch, the event stream and the captured files. PR links open on the factory\'s own forge — Forgejo, served by this console at `/extras/forgejo/` — so they resolve from your machine instead of pointing at a placeholder host.',
          'Window switch: changes the aggregation window for the metric cards.',
          'Metric cards: throughput, cost per PR (total + per stage + unattributed), cycle time, time to first human review, touchpoints per PR, automation %, defect rate — plus the outcome metrics: human interactions per PR, autonomy ratio, cost per accepted change, signal-to-production cycle time, incident MTT and merged-code age.',
          'Runs / status split / spend: newest 100 runs for the factory.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'The local forge follows your session',
        text:
          'Pull request links point at the local Forgejo instance, proxied by the console under /extras/forgejo/. The proxy resolves the session and asserts the signed-in username with a trusted header, so opening a PR never asks for a second password. Signed out with auth required, forge pages redirect to `/login`; with auth off the proxy falls back to the seeded admin. Multi-user isolation beyond the personal `u-<username>` organization is the documented OIDC path, not built yet.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Empty means empty',
        text:
          'Each section has its own honest empty state: no runs, no work items, no PRs and no artifact are reported as such, never as a zero or an empty shell.',
      },
    ],
    related: [
      { label: 'Open the local forge', href: '/extras/forgejo/' },
      { label: 'Scoring and calibration', href: '/help/concepts/scoring-and-calibration' },
      { label: 'Runs', href: '/help/runs' },
    ],
  },
  {
    slug: 'factories/readiness',
    title: 'Readiness',
    section: 'menu',
    status: 'Shipped — factory engineering',
    summary:
      'A deterministic agent-readiness score for the checkout and the factory definition: sections, weighted checks, evidence, remediation and the guard-hook configuration.',
    pageHref: factoryPageHref('readiness'),
    pageHrefLabel: 'Open Readiness (example factory)',
    blocks: [
      {
        kind: 'prose',
        text:
          'Readiness answers "is this repository ready for an agent to work autonomously?" It reads the local checkout (`REPO_ROOT`) and the loaded definition — no model call, no shell — and returns a score 0–100 with a status: `ready` at or above the ready threshold (default 80), `warn` at or above the warn threshold (default 60), otherwise `not_ready`. The report names the root it scanned and when it was generated, so a scan of the wrong checkout is visible rather than hidden.',
      },
      {
        kind: 'list',
        items: [
          'Score and status: a 0–100 score, the thresholds in force and the summary the scanner wrote.',
          'Repository section: style, build, tests, typecheck, docs, dev environment, observability, security and task discovery.',
          'Factory section: QA agent, two reviewers, gates, merge policy, required verdicts, scorers/benchmarks and secrets/MCP.',
          'Every check carries its weight, concrete evidence (or an explicit "not found") and a remediation hint; a failing check is `fail`, never blank.',
          'Guard hooks: the declared `guard` config, the defaults applied to every unset field and the newest `guard.checked` / `guard.failed` events, each linking to its work item.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Advisory unless the factory opts in',
        text:
          'Readiness is advisory by default. A factory that sets `readiness.enforceAutonomy: true` is refused autonomy with `readiness_not_ready` unless the score reaches the ready threshold — and only an explicit `{actor, reason}` override bypasses that check. The scan targets the local checkout; a target-repo checkout is a later runner/forge concern.',
      },
    ],
    related: [
      { label: 'Dashboard', href: '/help/factories/dashboard' },
      { label: 'Factory stack', href: '/help/concepts/factory-stack' },
      { label: 'Gates and autonomy', href: '/help/concepts/gates-and-autonomy' },
    ],
  },
  {
    slug: 'factories/agents',
    title: 'Agents',
    section: 'menu',
    status: 'Shipped — Phase 2b / 6a',
    summary:
      'The agents declared in `agents/<name>/agent.md`: role, model, harness, runner, tools, gates, MCP bindings and tool globs.',
    pageHref: factoryPageHref('agents'),
    pageHrefLabel: 'Open Agents (example factory)',
    blocks: [
      {
        kind: 'prose',
        text:
          'Each card is one agent. Model references are resolved by the API (`env:NAME` → concrete model + source), so the page never shows an unresolved literal as if it were a model. MCP bindings show which servers the agent may use and the allow/deny globs it receives.',
      },
      {
        kind: 'list',
        items: [
          'Role and prompt source: the Markdown body of `agent.md`.',
          'Model/harness/runner: resolved values, with `env:` references shown as resolved.',
          'Tools and gates: the per-agent tool list and gate overrides.',
          'MCP: bound servers, allowed globs, denied globs (opencode-specific).',
        ],
      },
    ],
    related: [
      { label: 'Add an MCP server', href: '/help/mcps/add' },
      { label: 'Definitions as code', href: '/help/concepts/definitions-as-code' },
    ],
  },
  {
    slug: 'factories/automations',
    title: 'Automations',
    section: 'menu',
    status: 'Shipped — Phase 3b',
    summary:
      'Declared automations with their trigger, cron schedule status, last fire, webhook URL/secret ref and delivery counts.',
    pageHref: factoryPageHref('automations'),
    pageHrefLabel: 'Open Automations (example factory)',
    blocks: [
      {
        kind: 'prose',
        text:
          'An automation is declared in `automations/<name>/automation.md` with a cron or webhook trigger and the work it starts. Cron automations sync into Temporal schedules; firing is idempotent by `(scheduleId, fireAt)` into a derived work-item id. Webhook deliveries are HMAC-verified, deduped and filtered before they become work items.',
      },
      {
        kind: 'list',
        items: [
          'Sync: creates/updates Temporal schedules from the definition (`POST /factories/:factoryId/automations/sync`).',
          'Pause: pauses the schedule (operator pause) without editing git.',
          'Webhook: shows the URL and the secret reference; delivery counts are recorded per accepted/ignored/rejected with a reason.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Attestation parity',
        text:
          'A scheduled fire resolves autonomy through the same benchmark-attestation check as a manual item; when it cannot be satisfied it records `autonomy.attestation_missing` and only human gates apply.',
      },
    ],
    related: [
      { label: 'Gates and autonomy', href: '/help/concepts/gates-and-autonomy' },
      { label: 'Connect GitHub', href: '/help/factories/connect-github' },
    ],
  },
  {
    slug: 'factories/scorers',
    title: 'Scorers',
    section: 'menu',
    status: 'Shipped — Phase 4a',
    summary:
      'The scorer registry with class (deterministic/judge), labels, passing score, sampling, judge model and calibration state.',
    pageHref: factoryPageHref('scorers'),
    pageHrefLabel: 'Open Scorers (example factory)',
    blocks: [
      {
        kind: 'prose',
        text:
          'Scorers come from `scorers/<name>/scorer.md`. The page shows class inference, the label table, the passing score, sampling rate and the judge model. The calibration panel shows agreement, the confusion matrix, the verdict and the `rubricHash`; below the minimum size it reports `insufficient_data`.',
      },
      {
        kind: 'list',
        items: [
          'Registry: class, labels, passing score, sampling, judge model, calibration badge.',
          'Calibration: run a golden-set calibration and read agreement/confusion/verdict.',
          'Uncalibrated judges block self-improvement eligibility and cannot satisfy the benchmark gate.',
        ],
      },
    ],
    related: [
      { label: 'Scoring and calibration', href: '/help/concepts/scoring-and-calibration' },
      { label: 'Benchmarks and attestation', href: '/help/concepts/benchmarks-and-attestation' },
    ],
  },
  {
    slug: 'factories/self-improvement',
    title: 'Self-improvement',
    section: 'menu',
    status: 'Shipped — Phase 5a / 5b',
    summary:
      'Authority selector, eligibility, ranked proposals with probe evidence and diffs, the lessons library, and the canary rollout panel.',
    pageHref: factoryPageHref('self-improvement'),
    pageHrefLabel: 'Open Self-improvement (example factory)',
    blocks: [
      {
        kind: 'prose',
        text:
          'The page drives the improvement loop: run it, read eligibility, review ranked proposals (impact, evidence, probe results, before/after diff), accept/reject/apply, and change the authority. Applying a `canary` proposal starts a real rollout; the canary panel shows candidate vs stable, the traffic split, the window countdown and promote/rollback controls.',
      },
      {
        kind: 'list',
        items: [
          'Authority: `propose_only`, `pr` or `canary`; a preview diff is required before confirming, and confirmation opens a PR — never a worktree write.',
          'Proposals: ranked by impact (failed runs × (1 + cost)), clustered by files + failure signature.',
          'Canary: publish → durable observation window → promote or rollback; manual decisions are audited with actor + reason.',
          'Lessons: per-factory library with promote-to-shared (opt-in).',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'What a rollout changes',
        text:
          'A candidate is materialised under `runs/canary/<rolloutId>/definition`, committed on a `canary/<rolloutId>` branch and opened as a draft PR. Promotion merges that PR; the local checkout updates on the next checkout/deploy.',
      },
    ],
    related: [
      { label: 'Self-improvement and canary', href: '/help/concepts/self-improvement-and-canary' },
      { label: 'Troubleshooting: canary rollback', href: '/help/troubleshooting/canary-rollback' },
    ],
  },
  {
    slug: 'factories/benchmarks',
    title: 'Benchmarks',
    section: 'menu',
    status: 'Shipped — Phase 4b',
    summary:
      'Suites, the configuration matrix and `configHash`, the run dialog with estimate/confirmation/cap, results, the Pareto frontier and attestations.',
    pageHref: factoryPageHref('benchmarks'),
    pageHrefLabel: 'Open Benchmarks (example factory)',
    blocks: [
      {
        kind: 'prose',
        text:
          'Each suite shows its configurations, pinned tasks and `configHash` (`sha256(matrix + definitionCommit)`), plus the latest run and attestation badge. Running a benchmark estimates cost first; above the confirmation threshold it asks, and a hard cap skips remaining trials with `budget_exhausted`.',
      },
      {
        kind: 'list',
        items: [
          'Run dialog: configuration/task selection, estimate, confirmation, hard cap.',
          'Replay tasks: a task with `replayFrom: run_…` re-emits that run’s recorded `events.jsonl` and applies its `patch.diff` to a fresh workspace, so the trial is scored deterministically without a model call. A missing recording fails the trial with `replay_missing`.',
          'Results: matrix with pass rate, weighted score, sample size, cost, errors/skips; per-trial drill-down to the child run.',
          'Frontier: pass rate vs cost with labels and a recommendation only on dominance.',
          'Attestation: binds commit + configHash; partial runs are marked `partial` and are not gate-eligible.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Fake benchmark stack in compose',
        text:
          'Compose runs `BENCHMARK_HARNESS=fake` + `BENCHMARK_RUNNER=fake` with the stub judge, so trials are simulated. A real benchmark needs the factory\'s harness/model and a passing calibration.',
      },
    ],
    related: [
      { label: 'Benchmarks and attestation', href: '/help/concepts/benchmarks-and-attestation' },
      { label: 'Troubleshooting: benchmark refused', href: '/help/troubleshooting/benchmark-refused' },
    ],
  },
  {
    slug: 'factories/definition',
    title: 'Definition',
    section: 'menu',
    status: 'Shipped — Phase 1 / 2b',
    summary:
      'A read-only projection of the git-backed definition: manifest, resolved config, file list, diff and version history.',
    pageHref: factoryPageHref('definition'),
    pageHrefLabel: 'Open Definition (example factory)',
    blocks: [
      {
        kind: 'prose',
        text:
          'The Definition page is the honest view of what the factory is: the manifest, the resolved config (models, gates, improvement, MCP), the canonical file set and the version/diff history. It is read-only — the banner names the source path and says nothing is written back (ADR-012).',
      },
      {
        kind: 'list',
        items: [
          'Manifest: `factory.yaml` fields as declared.',
          'Resolved config: models with `{ref, value, source}`, gates, merge policy, improvement authority, MCP servers.',
          'Files: the canonical export list; long values wrap so the page fits a 1280px viewport.',
        ],
      },
    ],
    related: [
      { label: 'Definitions as code', href: '/help/concepts/definitions-as-code' },
      { label: 'Add a factory', href: '/help/factories/add' },
    ],
  },
  {
    slug: 'factories/gates',
    title: 'Gates',
    section: 'menu',
    status: 'Shipped — Phase 2b / 3c / 4b',
    summary:
      'The resolved gate table with its source, the autonomy policy and kill switch, the benchmark-attestation card and the canary state.',
    pageHref: factoryPageHref('gates'),
    pageHrefLabel: 'Open Gates (example factory)',
    blocks: [
      {
        kind: 'prose',
        text:
          'Gates shows, per stage, the resolved gate (`human`, `agent` or `policy:<name>`) and where it came from (automation → factory → global). The autonomy card enables/pauses the kill switch: enabling a fully autonomous factory is refused while no passing, calibrated, non-partial attestation matches the current commit + configHash, unless an explicit `{actor, reason}` override is confirmed. Pausing always works.',
      },
      {
        kind: 'list',
        items: [
          'Stage table: gate, resolution source and meaning; merge policy with its note.',
          'Automation overrides: which automation raises/lowers which stage.',
          'Attestation card: required/not required, current/missing, suite rows with config hash and pass rate.',
          'Canary card: active/last rollout and a link to the canary panel.',
          'Kill switch: enable/pause with an audit event (`autonomy.*`).',
        ],
      },
    ],
    related: [
      { label: 'Gates and autonomy', href: '/help/concepts/gates-and-autonomy' },
      { label: 'Inbox', href: '/help/inbox' },
      { label: 'Troubleshooting: gate stuck', href: '/help/troubleshooting/gate-stuck' },
    ],
  },
  {
    slug: 'factories/merge-queue',
    title: 'Merge queue',
    section: 'menu',
    status: 'Shipped — Phase 3b',
    summary:
      'Batch size, checks timeout, the in-flight batch, the waiting queue and batch evidence (PRs, checks, bisect) with a manual revert.',
    pageHref: factoryPageHref('merge-queue'),
    pageHrefLabel: 'Open Merge queue (example factory)',
    blocks: [
      {
        kind: 'prose',
        text:
          'The page shows the merge train: the in-flight batch, the waiting queue and finished batches with their PRs, check results, bisect evidence and events. A human revert reverts a merge with one commit (never a force-push) and is audited with actor + reason.',
      },
      {
        kind: 'list',
        items: [
          'In-flight batch: PRs merged in order, the merged-stack gate result and the checks timeout.',
          'Batches: PR/check/bisect evidence and events; the offender is marked `needs_human` with failing checks.',
          'Revert: one-shot workflow, requires actor + reason.',
        ],
      },
    ],
    related: [
      { label: 'Merge queue concept', href: '/help/concepts/merge-queue' },
      { label: 'Connect GitHub', href: '/help/factories/connect-github' },
    ],
  },
  {
    slug: 'factories/settings',
    title: 'Settings',
    section: 'menu',
    status: 'Shipped — Phase 3b / 6a',
    summary:
      'The manifest summary, repositories, secret references and the GitHub connection form (repos, webhook, dry run, merge ownership).',
    pageHref: factoryPageHref('settings'),
    pageHrefLabel: 'Open Settings (example factory)',
    blocks: [
      {
        kind: 'prose',
        text:
          'Settings is the factory\'s wiring: declared repositories, secret references, MCP servers and the GitHub connection. The GitHub form saves an integration by secret reference (never a token value), with repositories, webhook URL + secret refs, event/label/branch filters, a dry-run switch and merge ownership.',
      },
      {
        kind: 'list',
        items: [
          'GitHub connection: token secret ref, webhook secret ref, webhook URL, filters, dry-run and merge-queue ownership.',
          'Repositories: the code forges the factory works on; no repos means the webhook route ignores every delivery.',
          'Secrets / MCP: names only; values never leave the store.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Dry run',
        text:
          'With `GITHUB_DRY_RUN=1` every mutation is a no-op that returns a synthetic result and emits `github.intended_action`; nothing leaves the process.',
      },
    ],
    related: [
      { label: 'Connect GitHub', href: '/help/factories/connect-github' },
      { label: 'Register a secret', href: '/help/secrets/register' },
    ],
  },

  // ------------------------------------------------------------------ how-tos
  {
    slug: 'factories/supported-projects',
    title: 'Supported projects',
    section: 'factories',
    status: 'Current behaviour — branch → PR → checks → merge queue (Phase 3b)',
    summary:
      'What the factory can build: anything expressible as a repository diff that checks can verify — and the honest list of what it will only propose.',
    blocks: [
      {
        kind: 'prose',
        text:
          'The unit of work is a repository diff verified by checks. A work item names a repository and a change; the loop turns it into a branch, a pull request, and a set of checks that either pass or fail. If no check can tell whether the change is right, the factory has nothing to gate on — that is the boundary of what it can build, not a limitation of a particular harness.',
      },
      {
        kind: 'list',
        items: [
          'Application code — features, fixes and refactors in the repositories the factory declares.',
          'Tests — new or repaired unit/integration/e2e coverage, including the test that proves a fix.',
          'Documentation — READMEs, guides, API references and changelogs.',
          'Configuration — CI workflows, linters, formatters, build and runtime config files.',
          'Database migrations — schema and data migrations reviewed like any other diff.',
          'Terraform modules and plans — module code, variables and the reviewed `terraform plan` output; the change is a diff, the plan is the evidence.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'The mechanism',
        text:
          'Agents produce a branch + PR; the forge checks (CI, tests, review verdicts) gate it; when the factory owns merges, the merge queue lands it — it merges the batch in order and gates the merged stack at the new head, reverting only the offending PR. Infrastructure-as-code changes are proposed as a diff and a plan, never applied: no cloud credentials are handed to a run, and the merge lands the code, not the infrastructure.',
      },
      {
        kind: 'list',
        items: [
          'Out of scope — applying infrastructure: `terraform apply`, `kubectl apply`, cloud console changes, DNS or IAM edits. The factory opens a PR; your pipeline applies it after the merge.',
          'Out of scope — physical actions: deploying hardware, shipping, signing, calling, printing, anything that is not a file in a repository.',
          'Out of scope — artefacts no check can verify: a binary, dataset, model weight or screenshot with no automated check attached. The factory can add it to the repo, but nothing gates it, so it cannot claim the result is correct.',
          'Out of scope — anything needing credentials the runner does not hold. Secrets reach a run only by explicit allowlist; inference credentials are refused outright.',
        ],
      },
      {
        kind: 'prose',
        text:
          'If a request lands in the out-of-scope list, the honest outcome is a proposal at most: a PR that a human reviews and a pipeline applies, or a written plan. The console never claims the factory performed the action. When a request is ambiguous, phrase it as the diff you want ("add a migration that backfills `owner_id`", "raise the timeout in the CI workflow") — the checks then define done.',
      },
    ],
    related: [
      { label: 'Merge queue', href: '/help/concepts/merge-queue' },
      { label: 'Connect GitHub', href: '/help/factories/connect-github' },
      { label: 'Add a factory', href: '/help/factories/add' },
      { label: 'Quick start', href: '/help/quick-start' },
    ],
  },
  {
    slug: 'factories/delete',
    title: 'Delete a factory',
    section: 'factories',
    status: 'Current behaviour — definitions are git-backed files',
    summary:
      'Remove a factory directory, pause its automations and purge its read-model rows with a script; commit the removal.',
    blocks: [
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Deletion is a git change, not a button',
        text:
          'The console has no delete button and does not edit definitions (ADR-012); a canary promotion is the one write-back, after a successful merge (ADR-049). Removing `factories/<name>/` deletes the definition; the script below also pauses automations and clears the read-model rows so old runs and items do not linger in lists. Git history keeps the definition if you need it back.',
      },
      {
        kind: 'steps',
        items: [
          {
            title: 'Check for live work',
            detail:
              'The script refuses while the factory has active work items or pending/running runs. Cancel or retry them first, or pass `--force` if you accept losing in-flight work.',
            command: 'curl -s "localhost:8080/api/v1/factories/<factory-id>/work-items"',
            expected: 'No `active` items and no `pending`/`running` runs.',
          },
          {
            title: 'Run the delete script',
            detail:
              'It pauses the factory automations, purges rows with a `factory` column, and removes the directory. Add `--keep-db` to keep history.',
            command: 'bun scripts/delete-factory.ts <name> --yes',
            expected: 'Automations paused, rows reported, directory removed.',
          },
          {
            title: 'Commit the removal',
            detail:
              'The definition lives in git; commit so every checkout agrees the factory is gone.',
            command: 'git add -A && git commit -m "chore: remove factory <name>"',
            expected: 'The factory disappears from the switcher after the API reloads.',
          },
        ],
      },
      {
        kind: 'list',
        items: [
          'Deleted: the definition directory, automation schedules, and read-model rows (runs, items, scores, benchmarks, proposals, integrations, MCP rows).',
          'Kept: git history, run directories under `runs/` (unless you remove them), and any artifact you exported.',
          'Irreversible from the console; re-adding means restoring the directory from git and committing again.',
        ],
      },
    ],
    related: [
      { label: 'Add a factory', href: '/help/factories/add' },
      { label: 'Settings', href: '/factories/hello-nextjs/settings' },
    ],
  },
  {
    slug: 'factories/add',
    title: 'Add a factory',
    section: 'factories',
    status: 'Current behaviour — definitions are git-backed files',
    summary:
      'Scaffold a factory directory, validate it, commit it, then select it in the console. The console never writes the worktree.',
    blocks: [
      {
        kind: 'callout',
        tone: 'info',
        title: 'The console does not create factories',
        text:
          'Factories are files in git. This page is a how-to, not a form: the `+` next to Factories opens it. Scaffolding happens in your editor and CLI, and the change becomes visible after it is committed — the console does not edit definitions (ADR-012), except the local-checkout write-back after a canary promotion (ADR-049).',
      },
      {
        kind: 'steps',
        items: [
          {
            title: 'Create the directory',
            detail:
              'The directory name under `FACTORY_ROOT` (default `./factories`) is the factory identity. `name` and `alias` are labels.',
            command: 'mkdir -p factories/acme-core/agents/foreman',
            expected: 'The directory exists next to `factories/example`.',
          },
          {
            title: 'Write the manifest',
            detail:
              'Start from `factories/example/factory.yaml`. At minimum: `schemaVersion`, `name`, `repositories`, `agentDefaults`, `gates` and `mergePolicy`.',
            command: 'cp factories/example/factory.yaml factories/acme-core/factory.yaml',
            expected: '`factory.yaml` is present and parses as YAML.',
          },
          {
            title: 'Add one agent',
            detail:
              'Each agent is `agents/<name>/agent.md` with frontmatter (`role`, `model`, `harness`, `runner`, `tools`) and a Markdown body that is the prompt. Reference models by `env:NAME` so the model stays configuration.',
            command: 'cp -R factories/example/agents/foreman factories/acme-core/agents/',
            expected: '`agents/foreman/agent.md` exists with frontmatter and a non-empty body.',
          },
          {
            title: 'Validate',
            command: 'bun run factory validate factories/acme-core',
            expected:
              'The command prints the resolved models, gates and improvement settings and exits 0. A failure prints stable codes (`missing_field`, `invalid_value`, …) naming the file.',
          },
          {
            title: 'Check the canonical export',
            command: 'bun run factory export factories/acme-core --check',
            expected: 'Exit 0 with no diff: export → import round-trips byte-identically.',
          },
          {
            title: 'Commit',
            command: 'git add factories/acme-core && git commit -m "feat: add acme-core factory"',
            expected: 'The definition is in git; the next run pins its commit.',
          },
          {
            title: 'Select it in the console',
            detail:
              'Reload the console and pick the factory in the sidebar switcher; the per-factory nav pages then project the new definition.',
            expected:
              'The switcher lists the factory (alias + directory name) and Dashboard loads without errors.',
          },
        ],
      },
      {
        kind: 'checklist',
        title: 'Done when',
        items: [
          '`bun run factory validate <path>` exits 0.',
          '`bun run factory export <path> --check` reports no diff.',
          'The factory appears in the sidebar switcher after a reload.',
          'The Definition page shows the manifest and resolved config.',
          'The change is committed — uncommitted edits are not what runs pin.',
        ],
      },
    ],
    related: [
      { label: 'Definitions as code', href: '/help/concepts/definitions-as-code' },
      { label: 'What the factory can build', href: '/help/factories/supported-projects' },
      { label: 'Choose the model through the environment', href: '/help/factories/model-env' },
      { label: 'Definition page', href: '/help/factories/definition' },
    ],
  },
  {
    slug: 'factories/connect-github',
    title: 'Connect GitHub',
    section: 'factories',
    status: 'Shipped — Phase 3b; compose uses the fake forge unless configured',
    summary:
      'Register the token by secret name, point the integration at repositories, wire the webhook, and choose whether the merge queue owns merges.',
    blocks: [
      {
        kind: 'callout',
        tone: 'info',
        title: 'Token by reference, never by value',
        text:
          'The integration stores a secret reference (`GITHUB_TOKEN` by default), not the token. The value lives in the environment and is resolved at call time; `GITHUB_DRY_RUN=1` makes every mutation a no-op that emits `github.intended_action`.',
      },
      {
        kind: 'steps',
        items: [
          {
            title: 'Put the token in the environment',
            detail:
              'Add the PAT to `.env` (it is git-ignored) and restart the API/worker so the process sees it.',
            command: 'GITHUB_TOKEN=ghp_… # in .env, then docker compose up -d api worker',
            expected: 'The Settings page shows the token secret ref as "resolved".',
          },
          {
            title: 'Register the secret name',
            detail:
              'The registry tracks names and presence only; register `GITHUB_TOKEN` (and `GITHUB_WEBHOOK_SECRET`) in Secrets so usage and rotation are audited.',
            command:
              'curl -sS -X POST http://localhost:8080/api/v1/secrets -H \'content-type: application/json\' \\\n  -d \'{"name":"GITHUB_TOKEN","provider":"env","scope":"factory:example"}\'',
            expected: 'The response has no value field; presence is reported as `resolved`.',
          },
          {
            title: 'Save the integration',
            detail:
              'On the factory\'s Settings page, fill the GitHub connection form: token secret ref, repositories, webhook secret ref, event/label/branch filters, dry run and merge ownership.',
            command:
              'curl -sS -X POST http://localhost:8080/api/v1/integrations/github -H \'content-type: application/json\' \\\n  -d \'{"factory":"example","secretRef":"GITHUB_TOKEN","repos":[{"owner":"acme","name":"api-service"}],"mergeQueue":true}\'',
            expected: 'The card shows "connected" (or "dry run"); a missing secret shows "secret missing".',
          },
          {
            title: 'Wire the webhook',
            detail:
              'Point the repository webhook at the URL Settings shows (`/api/v1/webhooks/github`), with the same secret as `GITHUB_WEBHOOK_SECRET`. Deliveries are HMAC-verified before parsing, deduped by delivery id, filtered and recorded.',
            expected: 'A signed test delivery creates a work item with `sourceRef.untrusted`; an unsigned one is rejected with no item.',
          },
          {
            title: 'Choose merge ownership',
            expected:
              'With `mergeQueue` on, ship enqueues into the merge train; off, the loop merges on a green ship gate.',
          },
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Compose is not GitHub',
        text:
          'The compose stack runs the fake forge (content-hash merges, simulated checks) and a dummy token. The GitHub REST path is wired and contract-tested against a recorded stub, but real network calls are opt-in (`RUN_GITHUB=1`).',
      },
    ],
    related: [
      { label: 'Settings page', href: '/help/factories/settings' },
      { label: 'Merge queue', href: '/help/concepts/merge-queue' },
      { label: 'Register a secret', href: '/help/secrets/register' },
    ],
  },
  {
    slug: 'factories/model-env',
    title: 'Choose the model through the environment',
    section: 'factories',
    status: 'Shipped — ADR-028',
    summary:
      'Definitions declare `env:FACTORY_*` references; the concrete model name is configuration in `.env`, never a value baked into git.',
    blocks: [
      {
        kind: 'prose',
        text:
          'A model field accepts either a literal or `env:[A-Z_][A-Z0-9_]*`. The example factories declare `env:FACTORY_MODEL` (foreman/spec/implement), `env:FACTORY_SMALL_MODEL` (triage/verify) and `env:FACTORY_REVIEW_MODEL` (review). The API resolves each reference to `{ref, value, source}`; `factory validate` prints the resolved models.',
      },
      {
        kind: 'steps',
        items: [
          {
            title: 'Set the variables',
            command:
              '# .env\nFACTORY_MODEL=your-model\nFACTORY_SMALL_MODEL=your-small-model\nFACTORY_REVIEW_MODEL=your-review-model\nOPENAI_BASE_URL=https://your-endpoint/v1\nOPENAI_API_KEY=…',
            expected: 'The API and worker containers read the values from `.env` (compose substitutes them).',
          },
          {
            title: 'Check the resolution',
            command: 'bun run factory validate factories/example',
            expected: 'Each model prints as resolved from `env:FACTORY_*`; a malformed reference fails with `invalid_value`.',
          },
          {
            title: 'Restart the stack',
            command: 'docker compose up -d api worker web',
            expected:
              'New Chat\'s composer default shows the resolved model; run creation succeeds instead of returning `model_unresolved`.',
          },
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Unset variables',
        text:
          'An unset variable is the non-fatal warning `model_env_unresolved` during validation, and run creation refuses with `model_unresolved` instead of forwarding the literal `env:…`.',
      },
    ],
    related: [
      { label: 'New Chat', href: '/help/chat' },
      { label: 'Troubleshooting: a run will not start', href: '/help/troubleshooting/run-wont-start' },
    ],
  },
  {
    slug: 'secrets/register',
    title: 'Register a secret',
    section: 'factories',
    status: 'Shipped — Phase 6a',
    summary:
      'Add a name to the registry, confirm it resolves, and let definitions reference it — the value never leaves the environment.',
    blocks: [
      {
        kind: 'steps',
        items: [
          {
            title: 'Put the value in the environment',
            detail:
              'The registry stores metadata only. The value lives in the API/worker environment (or a managed provider behind the same registry).',
            command: 'MY_SERVICE_TOKEN=… # in .env, then restart api + worker',
            expected: 'The variable is visible to the API/worker processes, not to the console.',
          },
          {
            title: 'Register the name',
            command:
              'curl -sS -X POST http://localhost:8080/api/v1/secrets -H \'content-type: application/json\' \\\n  -d \'{"name":"MY_SERVICE_TOKEN","provider":"env","scope":"factory:example","description":"deploy token"}\'',
            expected:
              'A row appears on Secrets with presence `resolved`. Sending a `value` is refused with `secret_value_rejected` before any query.',
          },
          {
            title: 'Reference it from the definition',
            command:
              '# factory.yaml (excerpt)\nmcp:\n  servers:\n    - name: github\n      transport: stdio\n      command: gh-mcp\n      env:\n        GITHUB_TOKEN: GITHUB_TOKEN',
            expected:
              'The reference is a name, not a value. Inline credential-looking literals are refused with `secret_inline_rejected`; an unknown name is a `secret_unregistered` warning.',
          },
          {
            title: 'Confirm usage',
            expected:
              'The Secrets page shows last use and per-run rows; a run lease records the names resolved (never values). Deleting an in-use name is refused with `secret_in_use`, naming the referencing resources.',
          },
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Presence ≠ correctness',
        text:
          'The registry proves a name resolves. It cannot prove the credential works — the first real call is the real test. Values never enter the database, events, logs, API responses or definitions.',
      },
    ],
    related: [
      { label: 'Secrets page', href: '/help/secrets' },
      { label: 'Troubleshooting: secret unresolved', href: '/help/troubleshooting/secret-unresolved' },
    ],
  },
  {
    slug: 'mcps/add',
    title: 'Add an MCP server',
    section: 'factories',
    status: 'Shipped — Phase 6a',
    summary:
      'Declare the server in `factory.yaml`, bind it to agents, register it in the index and run the runner-side probe.',
    blocks: [
      {
        kind: 'steps',
        items: [
          {
            title: 'Declare the server',
            detail:
              'stdio needs `command` (+ `args`, `env`); http needs `url` (+ `headers`). Credentials are secret names in `env`/`headers`.',
            command:
              '# factory.yaml (excerpt)\nmcp:\n  servers:\n    - name: github\n      transport: stdio\n      command: gh-mcp\n      env:\n        GITHUB_TOKEN: GITHUB_TOKEN',
            expected: 'Validation accepts it; a stdio server with a `url` (or http with a `command`) fails `invalid_value`.',
          },
          {
            title: 'Bind it to an agent',
            command: '# agents/implement/agent.md (frontmatter)\nmcp: [github]',
            expected:
              'The agent may use the server. Binding an undeclared server fails `unknown_mcp_server` and names both.',
          },
          {
            title: 'Validate and commit',
            command: 'bun run factory validate factories/example && git add factories/example && git commit -m "feat: bind github MCP"',
            expected: 'Exit 0; the definition commit is what the next run pins.',
          },
          {
            title: 'Register it in the index',
            detail:
              'On MCPs and apps, choose the declared server and register it — the page writes the index, not the definition.',
            command:
              'curl -sS -X POST http://localhost:8080/api/v1/factories/<factory-id>/mcp -H \'content-type: application/json\' \\\n  -d \'{"servers":[{"name":"github"}]}\'',
            expected: 'The server appears with its transport, bound/denied agents and tool globs.',
          },
          {
            title: 'Probe it',
            detail:
              'The Test button runs in the worker/runner, resolves credentials locally by name and records transport/latency/error. A failure marks the server `unhealthy`; bound agents still validate.',
            command: 'curl -sS -X POST http://localhost:8080/api/v1/factories/<factory-id>/mcp/github/test',
            expected:
              'A result with transport, latency and status. A stdio "pass" means it exited 0 or was still alive at the timeout — not a full JSON-RPC handshake.',
          },
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Harness support',
        text:
          'Tool globs and the allow/deny permission map are rendered for opencode. Other harnesses record the wiring as capability flags (`supported: false, mode: recorded`) — best effort, no enforcement.',
      },
    ],
    related: [
      { label: 'MCPs and apps', href: '/help/factories/mcps' },
      { label: 'Register a secret', href: '/help/secrets/register' },
      { label: 'Agents page', href: '/help/factories/agents' },
    ],
  },

  // ------------------------------------------------------------- troubleshooting
  {
    slug: 'troubleshooting/run-wont-start',
    title: 'A run will not start',
    section: 'troubleshooting',
    status: 'Symptom → check',
    summary:
      'Unresolved model reference, invalid definition, missing runner/harness, or a worker that cannot reach Temporal.',
    blocks: [
      {
        kind: 'list',
        items: [
          '`model_unresolved` — an `env:` model reference has no value. Set `FACTORY_MODEL`/`FACTORY_SMALL_MODEL`/`FACTORY_REVIEW_MODEL` in `.env`, restart api + worker, and re-check `factory validate`.',
          '`model_env_unresolved` warning — validation still passes, but run creation refuses. Same fix; do not commit a literal model to work around it.',
          'Invalid definition — `bun run factory validate factories/<name>` prints the code and file; fix in git, then reload.',
          'No run appears at all — check `curl localhost:8080/health` (Temporal reachable?), `docker compose ps` (worker up?), and the worker logs.',
          '`docker_unavailable` — the worker cannot reach the docker CLI or daemon. `docker compose exec worker docker version` must print a server version; rebuild the worker after changing its Dockerfile and confirm `/var/run/docker.sock` is mounted.',
          '`runner_unavailable` — the sandbox could not start. Check `docker image inspect factory-runner:local`, then `docker logs <container>` for the harness; opencode needs `OPENAI_BASE_URL`, a proxy token and the derived `OPENCODE_SERVER_PASSWORD`, all injected by the worker.',
          'Harness/runner unavailable — compose defaults to the fake harness; choosing `opencode` leases a docker sandbox. `RUNNER_SANDBOX=exec` is macOS-only (else `runner.sandbox_unavailable`).',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Read the events, not the page',
        text:
          'A refused creation returns a stable code in the API response. A started run that dies leaves `run.*` / `runner.*` events in `runs/<runId>/events.jsonl`; the Runs detail shows the same stream.',
      },
    ],
    related: [
      { label: 'Choose the model through the environment', href: '/help/factories/model-env' },
      { label: 'Runners and sandboxes', href: '/help/concepts/runners-and-sandboxes' },
      { label: 'Remote runners', href: '/help/concepts/runners' },
    ],
  },
  {
    slug: 'troubleshooting/runner-alerts',
    title: 'A runner alert fires or a host disappears',
    section: 'troubleshooting',
    status: 'Symptom → check',
    summary:
      'A threshold crossed, a heartbeat went stale, or a run cannot find a host — and what acknowledge, silence and drain actually change.',
    blocks: [
      {
        kind: 'list',
        items: [
          '`no_matching_runner` — no `ready`, non-draining host matches the run\'s platform, pool and labels, or every matching host is at capacity. Check the host table: status, pool, labels and `activeLeases / maxConcurrent`. Drain explains a host that looks healthy but takes no work.',
          'A host stays `pending` or `provisioning` — the enrollment was never exchanged. Run the preflight and install commands from the enrollment panel; an expired or reused token is refused with `enrollment_invalid`, so create a new enrollment.',
          'A host is `unreachable` — its last heartbeat is older than the threshold. The agent polls outbound: check the host process, its network path to the API and its bearer token. The last reported metrics stay visible; they are stale, not deleted.',
          '`heartbeat-warning` / `heartbeat-critical` — heartbeat age crossed 60s / 150s. Same check; the alert resolves on its own once heartbeats resume.',
          'A CPU/memory/disk alert keeps firing after Acknowledge — acknowledging records the actor and moves the state to `acknowledged`; it does not clear the threshold. The alert resolves when the metric returns below the threshold for the rule window.',
          'Silence did not hide the alert — a silenced alert stays in the list by design (it is excluded from firing notifications until `until`). The console silences for one hour; the API takes any `until`.',
          'A gauge is empty — the agent did not report that metric. It is `—`, not 0%. Check the raw heartbeat payload on the host detail page; a metric the agent never sends cannot be charted.',
          'The agent answers `401` — its bearer token was revoked (host deleted) or rotated. Re-enroll the host; deleting a host also removes its leases and alert history.',
        ],
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'Alerts are evidence, not the fix',
        text:
          'Rules are evaluated centrally from the stored heartbeat samples — the console only displays and acknowledges them. A rule change goes through `PUT /api/v1/runner-alert-rules`; the default global thresholds are seeded by migration `022_remote_runners.sql`.',
      },
    ],
    related: [
      { label: 'Remote runners', href: '/help/concepts/runners' },
      { label: 'Runners page', href: '/help/runners' },
      { label: 'Troubleshooting: a run will not start', href: '/help/troubleshooting/run-wont-start' },
    ],
  },
  {
    slug: 'troubleshooting/gate-stuck',
    title: 'A gate looks stuck',
    section: 'troubleshooting',
    status: 'Symptom → check',
    summary:
      'A gate is a durable wait by design. Check whether it is waiting for you, paused by the kill switch, or blocked by an automation override.',
    blocks: [
      {
        kind: 'list',
        items: [
          'Nothing is broken if the item sits at a stage with a `human` gate: the workflow is parked on a durable wait and costs no activity slot. Decide it in Inbox or via `POST /factories/:factoryId/work-items/:id/gates/:stage`.',
          'The gate is not the one you expected: read the Gates page. Automation overrides win over the factory gate (automation → factory → global).',
          'The kill switch is on: pausing autonomy forces every gate back to `human` and pauses new dispatch. The Gates page shows the newest `autonomy.*` event with actor/reason.',
          'A decision did not take effect: decisions are delivered as a Temporal Update (Signal fallback); if Temporal is unreachable the decision is recorded but not delivered. Check `/health` and retry.',
          'A permission prompt, not a gate: the permission SLA (`PERMISSION_TIMEOUT_MS`, default 30 min) auto-denies; approve sooner if the agent should continue.',
          'You want to abandon it: cancel the work item with actor + reason. Cancel is idempotent and emits exactly one `work_item.cancelled`; a terminal item returns `invalid_state`.',
        ],
      },
    ],
    related: [
      { label: 'Gates and autonomy', href: '/help/concepts/gates-and-autonomy' },
      { label: 'Gates page', href: '/help/factories/gates' },
      { label: 'Inbox', href: '/help/inbox' },
    ],
  },
  {
    slug: 'troubleshooting/benchmark-refused',
    title: 'A benchmark is refused',
    section: 'troubleshooting',
    status: 'Symptom → check',
    summary:
      'Cost confirmation, hard cap, invalid suite, or an attestation that is stale, partial or uncalibrated.',
    blocks: [
      {
        kind: 'list',
        items: [
          '`cost_confirmation_required` — the estimate is above the confirmation threshold. Confirm explicitly (the dialog does this) or raise the threshold.',
          '`budget_exhausted` — the hard cap was reached; remaining trials are skipped and the run completes with partial results.',
          '`invalid_sha` / `duplicate_tasks` / `duplicate_configurations` / `too_many_configurations` / `benchmark_task_mismatch` — the suite is invalid; fix `suite.yaml` + `tasks/*.yaml` and re-validate.',
          '`benchmark_attestation_missing` when enabling autonomy — no passing, calibrated, non-partial attestation matches the current commit + configHash. Re-run the suite, or confirm the explicit `{actor, reason}` override.',
          'A stale attestation — the `configHash` is `sha256(matrix + definitionCommit)`, so any definition or matrix change invalidates it. Re-run after the change.',
          'A partial attestation — a task/config subset is reporting-only and the autonomy gate ignores it; run the full matrix.',
          '`network_denied` on a trial — tasks tagged `requires-network` fail under `networkPolicy: denied`; that trial is recorded and excluded, not hidden.',
        ],
      },
    ],
    related: [
      { label: 'Benchmarks and attestation', href: '/help/concepts/benchmarks-and-attestation' },
      { label: 'Benchmarks page', href: '/help/factories/benchmarks' },
      { label: 'Gates page', href: '/help/factories/gates' },
    ],
  },
  {
    slug: 'troubleshooting/canary-rollback',
    title: 'A canary rolled back',
    section: 'troubleshooting',
    status: 'Symptom → check',
    summary:
      'A regression beyond the threshold, a manual rollback, or an observation window with insufficient data.',
    blocks: [
      {
        kind: 'list',
        items: [
          'Automatic rollback — pass rate dropped or the incident/failure rate rose beyond `rollbackThreshold` over the window. The Self-improvement canary panel shows candidate vs stable deltas and the evidence.',
          '`insufficientData` — too few scored runs in the window; the rollout is not promoted on noise. Wait for more items or widen the window.',
          'A manual rollback — audited with actor + reason; the candidate PR is left open with an audit comment.',
          'Promotion did not change the local checkout — promotion merges the candidate PR and then rewrites the local factory tree only when the worktree is clean (ADR-049). A dirty checkout or a non-git mount records `promotion_pending_deploy` with the reason; a deploy hook result is recorded as deployed / promoted_pending_deploy / promotion_pending_deploy.',
          'A second start is refused — `canary_active`: one rollout per factory may be in flight. Promote, roll back, or wait for the window.',
          'Candidate trees — terminal rollouts keep the newest `CANARY_KEEP_TREES` (default 3); older trees are pruned with `canary.gc`. An in-flight tree is never removed.',
        ],
      },
    ],
    related: [
      { label: 'Self-improvement and canary', href: '/help/concepts/self-improvement-and-canary' },
      { label: 'Self-improvement page', href: '/help/factories/self-improvement' },
    ],
  },
  {
    slug: 'troubleshooting/secret-unresolved',
    title: 'A secret is unresolved',
    section: 'troubleshooting',
    status: 'Symptom → check',
    summary:
      'The name is registered but the environment does not resolve it, or the name is referenced but never registered.',
    blocks: [
      {
        kind: 'list',
        items: [
          'Presence is `unresolved` — the variable is not in the API/worker environment. Add it to `.env` and restart both services; the registry never stores the value.',
          '`secret_unregistered` warning — a definition references a name that is not in the registry. Register it (or fix the reference); validation stays a warning so a fresh checkout still validates.',
          '`secret_in_use` on delete — a definition still references the name; remove the reference in git first, then delete.',
          '`secret_value_rejected` — you tried to send a value to the registry. Values belong in the environment/provider; the registry takes metadata only.',
          '`secret_inline_rejected` — a credential-looking literal (`sk-…`, `ghp_…`, `xoxb-…`) is in `command`/`args`/`url`/`env`/`headers`. Replace it with a name reference.',
          'The probe failed — the runner resolves credentials locally by name; a missing variable makes the MCP server `unhealthy`. Bound agents still validate.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Never log a value',
        text:
          'The lease records the names a run resolved; events, logs and API responses carry names only. If a value ever appears in a log, treat it as a leak and rotate it.',
      },
    ],
    related: [
      { label: 'Register a secret', href: '/help/secrets/register' },
      { label: 'Secrets page', href: '/help/secrets' },
    ],
  },
];

const BY_SLUG = new Map(HELP_ENTRIES.map((entry) => [entry.slug, entry]));

export function getHelpEntry(slug: string): HelpEntry | undefined {
  return BY_SLUG.get(slug);
}

export function helpEntriesBySection(section: HelpSection): HelpEntry[] {
  return HELP_ENTRIES.filter((entry) => entry.section === section);
}

export interface HelpContext {
  /** Where the contextual `?` control points; unknown routes fall back to the index. */
  href: string;
  slug: string | null;
  /** Accessible name target: the page the user is on. */
  pageName: string;
}

const TOP_LEVEL_ROUTES: Record<string, string> = {
  '/chat': 'chat',
  '/inbox': 'inbox',
  '/runners': 'runners',
  '/secrets': 'secrets',
  '/users': 'users',
};

/**
 * Factory pages: the sidebar group plus the nested work-item, run and score pages. A
 * score detail belongs to the run it scored, so it reuses the `runs` entry.
 */
const FACTORY_SEGMENTS = new Set([
  ...FACTORY_NAV.map((item) => item.segment),
  'work-items',
  'runs',
  'scores',
]);

/**
 * Route → help slug. Pure and total: `/help` and unknown routes return `null`, which the
 * control renders as a link to the help index (the spec's "Unknown page" scenario).
 */
export function helpSlugForPath(pathname: string): string | null {
  const clean = pathname.split('?')[0]?.split('#')[0] ?? pathname;
  const segments = clean.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const first = segments[0] ?? '';
  if (first === 'help') return null;

  const topLevel = TOP_LEVEL_ROUTES[`/${first}`];
  if (topLevel) return topLevel;

  if (first === 'factories') {
    const segment = segments[2] ?? 'dashboard';
    // Work items, runs and score detail are their own help entries even though they live
    // under a factory. A score detail points at the run it scored.
    if (segment === 'work-items' || segment === 'runs') return segment;
    if (segment === 'scores') return 'runs';
    if (!FACTORY_SEGMENTS.has(segment)) return null;
    return `factories/${segment}`;
  }

  return null;
}

/** The contextual control's target: slug + accessible page name. */
export function helpContextForPath(pathname: string): HelpContext {
  const slug = helpSlugForPath(pathname);
  const entry = slug ? getHelpEntry(slug) : undefined;
  return {
    href: slug ? `/help/${slug}` : '/help',
    slug: slug ?? null,
    pageName: entry?.title ?? 'this page',
  };
}

/** Menu-reference coverage check used by the unit test and (indirectly) the index. */
export function menuEntryForHref(href: string): HelpEntry | undefined {
  return HELP_ENTRIES.find((entry) => entry.section === 'menu' && entry.pageHref === href);
}

export function menuEntryForFactorySegment(segment: string): HelpEntry | undefined {
  return getHelpEntry(`factories/${segment}`);
}

/** Every nav label the menu reference must cover; kept exported so tests can assert it. */
export const NAV_LABELS: string[] = [
  ...TOP_NAV.map((item) => item.label),
  ...FACTORY_NAV.map((item) => item.label),
  ...FOOTER_NAV.map((item) => item.label),
];
