import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckRun, RepoRef } from '../src/types';
import type { GithubFetch, GithubResponseLike } from '../src/github';

/**
 * Offline GitHub emulator used by the contract suite (spec `code-forge` › offline contract
 * test). It is **not** a network client: it implements exactly the REST surface
 * `GitHubForge` uses, seeded from `test/fixtures/github/seed.json` (recorded responses),
 * and records every response it hands out so a run can be replayed.
 *
 * The suite runs against this stub; a real call is only made with `RUN_GITHUB=1`.
 */

export interface GithubStubSeed {
  recordedAt?: string;
  repos: Record<
    string,
    { defaultBranch: string; files: Record<string, string>; checks: CheckRun[] }
  >;
}

export interface GithubStubRecord {
  method: string;
  path: string;
  status: number;
}

interface PullState {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  createdAt: string;
  headSha: string;
}

interface RepoState {
  defaultBranch: string;
  branches: Map<string, string>;
  commits: Map<string, { treeSha: string; message: string; parents: string[] }>;
  trees: Map<string, Record<string, string>>;
  blobs: Map<string, string>;
  pulls: PullState[];
  comments: { id: number; body: string; createdAt: string }[];
  checks: Map<string, CheckRun[]>;
  defaultChecks: CheckRun[];
}

function sha1(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex');
}

function repoKeyOf(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export function loadGithubSeed(): GithubStubSeed {
  return JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'github', 'seed.json'), 'utf8')) as GithubStubSeed;
}

export interface GithubStub {
  fetch: GithubFetch;
  seedRepo(repo: RepoRef, files?: Record<string, string>, defaultBranch?: string): void;
  markChecksRed(repo: RepoRef, pullRequestNumber: number): void;
  markChecksForRef(repo: RepoRef, ref: string, checks: CheckRun[]): void;
  /** Next call (optionally matching `method path`) answers with this status/headers. */
  failNext(status: number, headers?: Record<string, string>, methodPath?: string): void;
  listPullRequests(repo: RepoRef): { number: number; head: string; state: string; merged: boolean }[];
  defaultBranchOf(repo: RepoRef): string;
  headOf(repo: RepoRef, branch: string): string;
  recorded(): GithubStubRecord[];
}

export function createGithubStub(seed: GithubStubSeed = loadGithubSeed()): GithubStub {
  const repos = new Map<string, RepoState>();
  const records: GithubStubRecord[] = [];
  const failures: { status: number; headers: Record<string, string>; match?: string }[] = [];
  let lastBody: unknown = null;

  function response(status: number, body: unknown, headers: Record<string, string> = {}): GithubResponseLike {
    lastBody = body;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
    };
  }

  function state(repo: RepoRef): RepoState | null {
    return repos.get(repoKeyOf(repo)) ?? null;
  }

  function storeTree(files: Record<string, string>): string {
    const sha = sha1(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
    for (const [path, content] of Object.entries(files)) {
      const blob = sha1(content);
      // trees are per-repo; blob content is global in GitHub but per-repo here is enough.
      void path;
      void blob;
    }
    return sha;
  }

  function seedRepo(repo: RepoRef, files?: Record<string, string>, defaultBranch = 'main'): void {
    const key = repoKeyOf(repo);
    if (repos.has(key) && files === undefined) return;
    const content = files ?? { 'README.md': `# ${repo.name}\n` };
    const treeSha = storeTree(content);
    const rootSha = sha1(key, 'root', treeSha);
    const checks: CheckRun[] = [
      { name: 'ci', conclusion: 'success' },
      { name: 'lint', conclusion: 'success' },
    ];
    repos.set(key, {
      defaultBranch,
      branches: new Map([[defaultBranch, rootSha]]),
      commits: new Map([[rootSha, { treeSha, message: 'initial commit', parents: [] }]]),
      trees: new Map([[treeSha, { ...content }]]),
      blobs: new Map(Object.entries(content).map(([path, body]) => [sha1(body), body])),
      pulls: [],
      comments: [],
      checks: new Map([[rootSha, checks]]),
      defaultChecks: checks,
    });
  }

  for (const [key, entry] of Object.entries(seed.repos)) {
    const [owner, name] = key.split('/');
    seedRepo({ owner: owner as string, name: name as string }, entry.files, entry.defaultBranch);
    const repo = { owner: owner as string, name: name as string };
    const st = state(repo) as RepoState;
    st.defaultChecks = entry.checks;
    for (const sha of st.commits.keys()) st.checks.set(sha, entry.checks);
  }

  function resolve(st: RepoState, ref: string): string | null {
    return st.branches.get(ref) ?? (st.commits.has(ref) ? ref : null);
  }

  function makeCommit(st: RepoState, treeSha: string, message: string, parents: string[]): string {
    const sha = sha1(message, treeSha, parents.join(','));
    st.commits.set(sha, { treeSha, message, parents });
    st.checks.set(sha, st.defaultChecks);
    return sha;
  }

  function pullJson(repo: RepoRef, pull: PullState, repoState: RepoState): Record<string, unknown> {
    return {
      number: pull.number,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      state: pull.state,
      title: pull.title,
      body: pull.body,
      head: { ref: pull.head, sha: pull.headSha },
      base: { ref: pull.base, sha: repoState.branches.get(pull.base) },
      created_at: pull.createdAt,
      merged: pull.merged,
      merged_at: pull.merged ? pull.createdAt : null,
    };
  }

  async function handle(
    method: string,
    url: string,
    body: Record<string, unknown> | null,
    headers: Record<string, string>,
  ): Promise<GithubResponseLike> {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const query = parsed.searchParams;

    const fail = failures[0];
    if (fail && (!fail.match || `${method} ${path}` === fail.match)) {
      failures.shift();
      return response(fail.status, { message: 'stub failure' }, fail.headers);
    }

    const parts = path.split('/').filter(Boolean); // ['repos', owner, name, ...]
    if (parts[0] !== 'repos' || parts.length < 3) return response(404, { message: 'Not Found' });
    const repo: RepoRef = { owner: parts[1] as string, name: parts[2] as string };
    const st = state(repo);
    if (!st) return response(404, { message: 'Not Found' });
    const rest = parts.slice(3);
    const key = repoKeyOf(repo);

    // GET /repos/:o/:n
    if (rest.length === 0 && method === 'GET') {
      return response(200, { full_name: key, default_branch: st.defaultBranch });
    }

    // GET /repos/:o/:n/git/ref/heads/:branch
    if (rest[0] === 'git' && rest[1] === 'ref' && rest[2] === 'heads' && method === 'GET') {
      const branch = decodeURIComponent(rest.slice(3).join('/'));
      const sha = st.branches.get(branch);
      if (!sha) return response(404, { message: 'Not Found' });
      return response(200, { ref: `refs/heads/${branch}`, object: { sha } });
    }

    // POST /repos/:o/:n/git/refs
    if (rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const ref = String(body?.ref ?? '');
      const branch = ref.replace(/^refs\/heads\//, '');
      if (st.branches.has(branch)) return response(422, { message: 'Reference already exists' });
      const sha = String(body?.sha ?? '');
      if (!st.commits.has(sha)) return response(422, { message: 'Object does not exist' });
      st.branches.set(branch, sha);
      return response(201, { ref, object: { sha } });
    }

    // PATCH /repos/:o/:n/git/refs/heads/:branch
    if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && method === 'PATCH') {
      const branch = decodeURIComponent(rest.slice(3).join('/'));
      const sha = String(body?.sha ?? '');
      if (!st.branches.has(branch)) return response(404, { message: 'Not Found' });
      if (!st.commits.has(sha)) return response(422, { message: 'Object does not exist' });
      st.branches.set(branch, sha);
      return response(200, { ref: `refs/heads/${branch}`, object: { sha } });
    }

    // POST /repos/:o/:n/git/blobs
    if (rest[0] === 'git' && rest[1] === 'blobs' && method === 'POST') {
      const content = String(body?.content ?? '');
      const sha = sha1(content);
      st.blobs.set(sha, content);
      return response(201, { sha });
    }

    // GET /repos/:o/:n/git/blobs/:sha
    if (rest[0] === 'git' && rest[1] === 'blobs' && method === 'GET') {
      const content = st.blobs.get(rest[2] as string);
      if (content === undefined) return response(404, { message: 'Not Found' });
      return response(200, { sha: rest[2], content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' });
    }

    // POST /repos/:o/:n/git/trees
    if (rest[0] === 'git' && rest[1] === 'trees' && method === 'POST') {
      const baseSha = String(body?.base_tree ?? '');
      const baseFiles = baseSha ? st.trees.get(baseSha) : {};
      if (!baseFiles) return response(422, { message: 'Tree not found' });
      const files = { ...baseFiles };
      for (const entry of (body?.tree ?? []) as { path: string; sha: string | null }[]) {
        if (entry.sha === null) delete files[entry.path];
        else {
          const content = st.blobs.get(entry.sha);
          if (content === undefined) return response(422, { message: `Blob ${entry.sha} not found` });
          files[entry.path] = content;
        }
      }
      const sha = storeTree(files);
      st.trees.set(sha, files);
      return response(201, { sha, tree: Object.keys(files).map((p) => ({ path: p, type: 'blob', mode: '100644' })) });
    }

    // GET /repos/:o/:n/git/trees/:sha — accepts a tree SHA or a commit SHA (like GitHub).
    if (rest[0] === 'git' && rest[1] === 'trees' && method === 'GET') {
      const requested = rest[2] as string;
      const resolvedTree = st.trees.has(requested) ? requested : st.commits.get(requested)?.treeSha;
      const files = resolvedTree ? st.trees.get(resolvedTree) : undefined;
      if (!files) return response(404, { message: 'Not Found' });
      return response(200, {
        sha: resolvedTree,
        truncated: false,
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          type: 'blob',
          mode: '100644',
          sha: sha1(content),
        })),
      });
    }

    // POST /repos/:o/:n/git/commits
    if (rest[0] === 'git' && rest[1] === 'commits' && method === 'POST') {
      const treeSha = String(body?.tree ?? '');
      if (!st.trees.has(treeSha)) return response(422, { message: 'Tree not found' });
      const parents = (body?.parents ?? []) as string[];
      const sha = makeCommit(st, treeSha, String(body?.message ?? ''), parents);
      return response(201, { sha });
    }

    // GET /repos/:o/:n/commits/:ref
    if (rest[0] === 'commits' && method === 'GET' && rest.length === 2) {
      const sha = resolve(st, decodeURIComponent(rest[1] as string));
      const commit = sha ? st.commits.get(sha) : null;
      if (!sha || !commit) return response(404, { message: 'No commit found' });
      return response(200, { sha, commit: { message: commit.message, tree: { sha: commit.treeSha } } });
    }

    // GET /repos/:o/:n/commits/:sha/check-runs
    if (rest[0] === 'commits' && rest[2] === 'check-runs' && method === 'GET') {
      const sha = resolve(st, decodeURIComponent(rest[1] as string));
      if (!sha) return response(404, { message: 'Not Found' });
      const checks = st.checks.get(sha) ?? st.defaultChecks;
      return response(200, {
        total_count: checks.length,
        check_runs: checks.map((check) => ({
          name: check.name,
          status: 'completed',
          conclusion: check.conclusion,
          details_url: check.url,
        })),
      });
    }

    // GET /repos/:o/:n/pulls
    if (rest[0] === 'pulls' && rest.length === 1 && method === 'GET') {
      const head = query.get('head');
      const wanted = head?.includes(':') ? head.split(':')[1] : head;
      const list = st.pulls.filter(
        (pull) =>
          (!wanted || pull.head === wanted) &&
          (query.get('state') !== 'open' || pull.state === 'open'),
      );
      return response(200, list.map((pull) => pullJson(repo, pull, st)));
    }

    // POST /repos/:o/:n/pulls
    if (rest[0] === 'pulls' && rest.length === 1 && method === 'POST') {
      const head = String(body?.head ?? '');
      const headSha = st.branches.get(head);
      if (!headSha) return response(422, { message: `No commits between ${body?.base} and ${head}` });
      const pull: PullState = {
        number: st.pulls.length + 1,
        head,
        base: String(body?.base ?? st.defaultBranch),
        title: String(body?.title ?? ''),
        body: String(body?.body ?? ''),
        state: 'open',
        merged: false,
        createdAt: new Date(1_700_000_000_000 + st.pulls.length * 1000).toISOString(),
        headSha,
      };
      st.pulls.push(pull);
      st.checks.set(headSha, st.defaultChecks);
      return response(201, pullJson(repo, pull, st));
    }

    // GET /repos/:o/:n/pulls/:number
    if (rest[0] === 'pulls' && rest.length === 2 && method === 'GET') {
      const pull = st.pulls.find((candidate) => candidate.number === Number(rest[1]));
      if (!pull) return response(404, { message: 'Not Found' });
      return response(200, pullJson(repo, pull, st));
    }

    // PUT /repos/:o/:n/pulls/:number/merge
    if (rest[0] === 'pulls' && rest[2] === 'merge' && method === 'PUT') {
      const pull = st.pulls.find((candidate) => candidate.number === Number(rest[1]));
      if (!pull) return response(404, { message: 'Not Found' });
      if (pull.state !== 'open' || pull.merged) return response(405, { message: 'Pull Request is not mergeable' });
      const checks = st.checks.get(pull.headSha) ?? st.defaultChecks;
      const green = checks.every((check) => check.conclusion === 'success' || check.conclusion === 'skipped');
      if (!green) return response(405, { message: 'Pull Request is not mergeable: required checks failed' });

      const headCommit = st.commits.get(pull.headSha);
      const baseSha = st.branches.get(pull.base);
      if (!headCommit || !baseSha) return response(422, { message: 'Unprocessable' });
      if (headCommit.treeSha === st.commits.get(baseSha)?.treeSha) {
        return response(422, { message: 'No commits between base and head' });
      }
      const method = String(body?.merge_method ?? 'merge');
      const sha = makeCommit(
        st,
        headCommit.treeSha,
        `Merge pull request #${pull.number} (${method})`,
        [baseSha],
      );
      st.branches.set(pull.base, sha);
      pull.merged = true;
      pull.state = 'closed';
      return response(200, { merged: true, sha, message: 'Pull Request successfully merged' });
    }

    // POST /repos/:o/:n/issues/:number/comments
    if (rest[0] === 'issues' && rest[2] === 'comments' && method === 'POST') {
      const number = Number(rest[1]);
      if (!st.pulls.some((pull) => pull.number === number)) return response(404, { message: 'Not Found' });
      const comment = {
        id: st.comments.length + 1,
        body: String(body?.body ?? ''),
        createdAt: new Date(1_700_000_000_000 + st.comments.length * 1000).toISOString(),
      };
      st.comments.push(comment);
      return response(201, { ...comment, user: { login: 'factory-agent' } });
    }

    void headers;
    return response(404, { message: `no stub route for ${method} ${path}` });
  }

  const fetchImpl: GithubFetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const requestHeaders = init?.headers ?? {};

    // ETag support: a conditional GET that matches the recorded body answers 304, exactly
    // like the real API, so the client's cache is exercised offline.
    if (method === 'GET') {
      const handleResult = await handle(method, url, body, requestHeaders);
      if (handleResult.status === 200) {
        const etag = `W/"${sha1(JSON.stringify(lastBody))}"`;
        const conditional = requestHeaders['if-none-match'] ?? requestHeaders['If-None-Match'];
        if (conditional === etag) {
          const notModified: GithubResponseLike = {
            ok: false,
            status: 304,
            headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) },
            json: async () => null,
          };
          records.push({ method, path: new URL(url).pathname, status: 304 });
          return notModified;
        }
        const withEtag: GithubResponseLike = {
          ok: handleResult.ok,
          status: handleResult.status,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'etag' ? etag : handleResult.headers.get(name),
          },
          json: handleResult.json,
        };
        records.push({ method, path: new URL(url).pathname, status: handleResult.status });
        return withEtag;
      }
      records.push({ method, path: new URL(url).pathname, status: handleResult.status });
      return handleResult;
    }

    const result = await handle(method, url, body, requestHeaders);
    records.push({ method, path: new URL(url).pathname, status: result.status });
    return result;
  };

  return {
    fetch: fetchImpl,
    seedRepo(repo, files, defaultBranch) {
      seedRepo(repo, files, defaultBranch ?? 'main');
    },
    markChecksRed(repo, pullRequestNumber) {
      const st = state(repo);
      const pull = st?.pulls.find((candidate) => candidate.number === pullRequestNumber);
      if (!st || !pull) throw new Error(`no pull request #${pullRequestNumber} in ${repoKeyOf(repo)}`);
      st.checks.set(pull.headSha, [
        { name: 'ci', conclusion: 'failure' },
        { name: 'lint', conclusion: 'success' },
      ]);
    },
    markChecksForRef(repo, ref, checks) {
      const st = state(repo);
      const sha = st ? resolve(st, ref) : null;
      if (!st || !sha) throw new Error(`unknown ref ${ref}`);
      st.checks.set(sha, checks);
    },
    failNext(status, headers = {}, methodPath) {
      failures.push({ status, headers, ...(methodPath ? { match: methodPath } : {}) });
    },
    listPullRequests(repo) {
      return (state(repo)?.pulls ?? []).map((pull) => ({
        number: pull.number,
        head: pull.head,
        state: pull.state,
        merged: pull.merged,
      }));
    },
    defaultBranchOf(repo) {
      return state(repo)?.defaultBranch ?? 'main';
    },
    headOf(repo, branch) {
      return state(repo)?.branches.get(branch) ?? '';
    },
    recorded() {
      return [...records];
    },
  };
}
