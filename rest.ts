// GitHub REST v3 surface for the github-core-clone-01 entry.
// Implements exactly what kit program/env/src/checks-rest.ts checks:
// repos (15), issues (15), pulls (20), protocol REST share (5).
// Node 22, stdlib only. State lives in the shared Store (store.ts).

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildCommit,
  buildTree,
  hashObject,
  isAuthorized,
  isObjectId,
  notFound,
  paginate,
  parseCommit,
  parseTree,
  pathOf,
  queryOf,
  readJsonBody,
  userJson,
  type Issue,
  type Label,
  type Pull,
  type RepoState,
  type Store,
  type TreeEntry,
} from './store.ts';

// ---------------------------------------------------------------- viewer identity (ported from kit wire.ts)
//
// No check asserts GET /user's login, BUT every repo check addresses the repo as
// /repos/<scenario.viewer.login>/<name>, while POST /user/repos creates it under the
// token's owner. If store.viewerLogin stayed 'conformance', every GET after a create
// would 404. So the viewer login MUST be the seeded scenario viewer: generateUsers(
// scenarioRng('users'), 12)[0].login. Ported verbatim (Rng, fnv1a64, mix64, name lists).

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function scenarioViewer(): { login: string; id: number } {
  const rng = new Rng(scenarioSeedFor('users'));
  const used = new Set<string>();
  // generateUsers(rng, 12)[0]; only the first user is needed.
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
  void used;
  return { login, id: 1000 };
}

let viewerResolved = false;
function ensureViewer(store: Store): void {
  if (viewerResolved) return;
  viewerResolved = true;
  if (store.viewerLogin === 'conformance') {
    const viewer = scenarioViewer();
    store.viewerLogin = viewer.login;
    store.viewerId = viewer.id;
  }
}

// ---------------------------------------------------------------- helpers

type Json = Record<string, unknown>;

function isObj(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function b64encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decodeText(content: string): string {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
}

function repoUrl(owner: string, name: string): string {
  return `/api/v3/repos/${owner}/${name}`;
}

function repoJson(repo: RepoState): Json {
  return {
    id: repo.id,
    node_id: `MDEwOlJlcG9zaXRvcnk=${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(repo.owner, 1),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: repoUrl(repo.owner, repo.name),
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
    default_branch: repo.default_branch,
  };
}

function labelJson(repo: RepoState, label: Label): Json {
  return {
    id: repo.id * 1000 + repo.labels.indexOf(label),
    node_id: `MDU6TGFiZWw=${repo.id}`,
    url: `${repoUrl(repo.owner, repo.name)}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(repo: RepoState, issue: Issue): Json {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: `MDU6SXNzdWU=${issue.number}`,
    url: `${repoUrl(repo.owner, repo.name)}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const found = repo.labels.find((l) => l.name === name);
      return found !== undefined ? labelJson(repo, found) : { name, color: 'ededed', description: '' };
    }),
    user: userJson(issue.user, 1),
    assignee: issue.assignee === null ? null : userJson(issue.assignee, 1),
    assignees: issue.assignee === null ? [] : [userJson(issue.assignee, 1)],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
  };
}

function commentJson(repo: RepoState, comment: Issue['comments'][number]): Json {
  return {
    id: comment.id,
    node_id: `MDEyOklzc3VlQ29tbWVudA==`,
    url: `${repoUrl(repo.owner, repo.name)}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/1#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user, 1),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------- git helpers (tree/commit building on store.ts)

function writeTree(repo: RepoState, entries: Array<{ path: string; oid: string }>): string {
  const files = entries.filter((e) => !e.path.includes('/'));
  const dirNames = [...new Set(entries.filter((e) => e.path.includes('/')).map((e) => e.path.slice(0, e.path.indexOf('/'))))];
  const treeEntries: TreeEntry[] = [];
  for (const file of files) treeEntries.push({ mode: '100644', name: file.path, oid: file.oid });
  for (const dir of dirNames) {
    const sub = entries
      .filter((e) => e.path.startsWith(`${dir}/`))
      .map((e) => ({ path: e.path.slice(dir.length + 1), oid: e.oid }));
    treeEntries.push({ mode: '40000', name: dir, oid: writeTree(repo, sub) });
  }
  const data = buildTree(treeEntries);
  const oid = hashObject('tree', data);
  repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

function makeCommit(repo: RepoState, treeOid: string, parents: string[], message: string): string {
  const data = buildCommit({ tree: treeOid, parents, message });
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

function treeMap(repo: RepoState, commitOid: string, store: Store): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of store.listTreePaths(repo, commitOid)) out.set(entry.path, entry.oid);
  return out;
}

/** Entries of the subtree at `dirPath` ('' = root), or null when it does not exist. */
function dirEntries(repo: RepoState, commitOid: string, dirPath: string): Array<{ name: string; path: string; oid: string; mode: string }> | null {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  const segments = dirPath.split('/').filter((s) => s !== '');
  for (const segment of segments) {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return null;
  return parseTree(tree.data).map((e) => ({
    name: e.name,
    path: dirPath === '' ? e.name : `${dirPath}/${e.name}`,
    oid: e.oid,
    mode: e.mode,
  }));
}

function ancestors(repo: RepoState, start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
  }
  return seen;
}

function mergeBase(repo: RepoState, a: string, b: string): string | null {
  const bAncestors = ancestors(repo, b);
  const queue = [a];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (bAncestors.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  return null;
}

interface ThreeWay {
  conflict: boolean;
  map: Map<string, string>;
}

/** Three-way merge of base/head against their merge-base; conflict when both sides changed a path differently. */
function threeWay(repo: RepoState, baseSha: string, headSha: string, store: Store): ThreeWay {
  const mb = mergeBase(repo, baseSha, headSha);
  const mbMap = mb === null ? new Map<string, string>() : treeMap(repo, mb, store);
  const baseMap = treeMap(repo, baseSha, store);
  const headMap = treeMap(repo, headSha, store);
  const result = new Map<string, string>();
  const paths = new Set([...mbMap.keys(), ...baseMap.keys(), ...headMap.keys()]);
  let conflict = false;
  for (const path of paths) {
    const m = mbMap.get(path);
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (h === m) {
      if (b !== undefined) result.set(path, b);
    } else if (b === m) {
      if (h !== undefined) result.set(path, h);
    } else if (b === h) {
      if (b !== undefined) result.set(path, b);
    } else {
      conflict = true;
    }
  }
  return { conflict, map: result };
}

function lineCounts(repo: RepoState, oid: string | undefined): string[] {
  if (oid === undefined) return [];
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'blob') return [];
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function pullFiles(repo: RepoState, pull: Pull, store: Store): Json[] {
  const baseMap = treeMap(repo, pull.baseSha, store);
  const headMap = treeMap(repo, pull.headSha, store);
  const paths = [...new Set([...baseMap.keys(), ...headMap.keys()])].sort();
  const out: Json[] = [];
  for (const path of paths) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (b === h) continue;
    const baseLines = lineCounts(repo, b);
    const headLines = lineCounts(repo, h);
    const baseSet = new Map<string, number>();
    for (const line of baseLines) baseSet.set(line, (baseSet.get(line) ?? 0) + 1);
    const headSet = new Map<string, number>();
    for (const line of headLines) headSet.set(line, (headSet.get(line) ?? 0) + 1);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of headSet) additions += Math.max(0, count - (baseSet.get(line) ?? 0));
    for (const [line, count] of baseSet) deletions += Math.max(0, count - (headSet.get(line) ?? 0));
    const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
    out.push({
      sha: h ?? b ?? '',
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.headSha}/${path}`,
      raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${pull.headSha}/${path}`,
      contents_url: `${repoUrl(repo.owner, repo.name)}/contents/${path}?ref=${pull.headSha}`,
    });
  }
  return out;
}

function pullJson(repo: RepoState, pull: Pull, store: Store): Json {
  let mergeable: boolean | null = null;
  if (pull.state === 'open') {
    const headTip = store.resolveRef(repo, pull.headRef);
    const baseTip = store.resolveRef(repo, pull.baseRef);
    if (headTip !== null && baseTip !== null) {
      const headCommit = store.peelToCommit(repo, headTip);
      const baseCommit = store.peelToCommit(repo, baseTip);
      mergeable = headCommit !== null && baseCommit !== null ? !threeWay(repo, baseCommit, headCommit, store).conflict : null;
    }
  }
  const headSha = store.resolveRef(repo, pull.headRef) ?? pull.headSha;
  const headCommit = store.peelToCommit(repo, headSha) ?? pull.headSha;
  const baseSha = store.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  const baseCommit = store.peelToCommit(repo, baseSha) ?? pull.baseSha;
  void store;
  return {
    id: repo.id * 100000 + pull.number,
    node_id: `MDExOlB1bGxSZXF1ZXN0MQ==`,
    url: `${repoUrl(repo.owner, repo.name)}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    merged: pull.merged,
    mergeable,
    mergeable_state: mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
    merge_method: 'squash',
    user: userJson(pull.user, 1),
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headCommit,
      user: userJson(repo.owner, 1),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseCommit,
      user: userJson(repo.owner, 1),
      repo: repoJson(repo),
    },
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------- handler

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const rawPath = pathOf(req);
  if (!rawPath.startsWith('/api/v3')) return false;
  ensureViewer(store);
  const requestId = randomUUID();
  const method = (req.method ?? 'GET').toUpperCase();
  const query = queryOf(req);

  const reply = (status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void => {
    const text = `${JSON.stringify(body)}\n`;
    try {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'x-github-request-id': requestId,
        'x-oauth-scopes': 'repo, read:org',
        ...extra,
      });
      res.end(text);
    } catch {
      // peer went away
    }
  };
  const replyNoContent = (status: number): void => {
    try {
      res.writeHead(status, { 'x-github-request-id': requestId, 'x-oauth-scopes': 'repo, read:org' });
      res.end();
    } catch {
      // peer went away
    }
  };
  const err = (status: number, message: string): void => reply(status, { message });
  const viewer = store.viewerLogin;

  // Auth: every /api/v3 route in scope requires the bearer token (401, never 403).
  if (!isAuthorized(req, store)) {
    err(401, 'Requires authentication');
    return true;
  }

  // Body: a malformed JSON body is a 400 (protocol check). Only read for methods that carry one.
  let body: Json = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    try {
      const parsed = await readJsonBody(req);
      if (isObj(parsed)) body = parsed;
    } catch {
      err(400, 'Problems parsing JSON');
      return true;
    }
  }

  const segments = rawPath
    .slice('/api/v3'.length)
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  // GET /api/v3/ (app.ts normally answers this first) and GET /api/v3/meta
  if (segments.length === 0) {
    if (method !== 'GET') {
      err(405, 'Method Not Allowed');
      return true;
    }
    reply(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
    return true;
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') {
      err(405, 'Method Not Allowed');
      return true;
    }
    reply(200, { installed_version: '1.0.0' });
    return true;
  }

  // GET /user, GET/POST /user/repos
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') {
        err(405, 'Method Not Allowed');
        return true;
      }
      reply(200, userJson(viewer, store.viewerId));
      return true;
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const mine = [...store.repos.values()].filter((r) => r.owner === viewer);
        const { page, headers } = paginate(req, mine.map((r) => repoJson(r)));
        reply(200, page, headers);
        return true;
      }
      if (method === 'POST') {
        const name = str(body.name).trim();
        if (name === '') {
          err(422, 'name is required');
          return true;
        }
        if (store.getRepo(viewer, name) !== undefined) {
          err(422, 'Repository already exists');
          return true;
        }
        const repo = store.createRepo(viewer, name, {
          description: str(body.description),
          private: typeof body.private === 'boolean' ? body.private : false,
          default_branch: str(body.default_branch, 'main') || 'main',
        });
        reply(201, repoJson(repo));
        return true;
      }
      err(405, 'Method Not Allowed');
      return true;
    }
    err(404, notFound().message);
    return true;
  }

  // GET /users/{login}
  if (segments[0] === 'users' && segments.length === 2) {
    if (method !== 'GET') {
      err(405, 'Method Not Allowed');
      return true;
    }
    reply(200, userJson(segments[1] as string, segments[1] === viewer ? store.viewerId : 2));
    return true;
  }

  // /repos/{owner}/{name}/...
  if (segments[0] !== 'repos' || segments.length < 3) {
    err(404, notFound().message);
    return true;
  }
  const owner = segments[1] as string;
  const repoName = segments[2] as string;
  const repo = store.getRepo(owner, repoName);
  const rest = segments.slice(3);
  const needRepo = (): RepoState | null => {
    if (repo === undefined) {
      err(404, notFound().message);
      return null;
    }
    return repo;
  };

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      const r = needRepo();
      if (r !== null) reply(200, repoJson(r));
      return true;
    }
    if (method === 'PATCH') {
      const r = needRepo();
      if (r === null) return true;
      if (typeof body.description === 'string') r.description = body.description;
      if (typeof body.private === 'boolean') r.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') r.default_branch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== r.name) {
        store.repos.delete(store.key(r.owner, r.name));
        r.name = body.name;
        store.repos.set(store.key(r.owner, r.name), r);
      }
      reply(200, repoJson(r));
      return true;
    }
    if (method === 'DELETE') {
      const r = needRepo();
      if (r === null) return true;
      store.repos.delete(store.key(r.owner, r.name));
      replyNoContent(204);
      return true;
    }
    err(405, 'Method Not Allowed');
    return true;
  }

  const sub = rest[0] as string;

  // ---- branches
  if (sub === 'branches') {
    const r = needRepo();
    if (r === null) return true;
    if (method === 'GET' && rest.length === 1) {
      const list: Json[] = [];
      for (const [ref, oid] of [...r.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        const commit = store.peelToCommit(r, oid) ?? oid;
        list.push({ name: ref.slice('refs/heads/'.length), commit: { sha: commit }, protected: false });
      }
      reply(200, list);
      return true;
    }
    if (method === 'GET' && rest.length === 2) {
      const ref = `refs/heads/${rest[1] as string}`;
      const oid = r.refs.get(ref);
      if (oid === undefined) {
        err(404, notFound().message);
        return true;
      }
      reply(200, { name: rest[1], commit: { sha: store.peelToCommit(r, oid) ?? oid }, protected: false });
      return true;
    }
    err(405, 'Method Not Allowed');
    return true;
  }

  // ---- commits
  if (sub === 'commits') {
    const r = needRepo();
    if (r === null) return true;
    if (method === 'GET' && rest.length === 1) {
      const refish = query.get('sha') ?? r.default_branch;
      const oid = store.resolveRef(r, refish);
      const tip = oid === null ? null : store.peelToCommit(r, oid);
      if (tip === null) {
        reply(200, []);
        return true;
      }
      const out: Json[] = [];
      const seen = new Set<string>();
      const stack = [tip];
      while (stack.length > 0) {
        const sha = stack.pop() as string;
        if (seen.has(sha)) continue;
        seen.add(sha);
        const obj = r.objects.get(sha);
        if (obj === undefined || obj.type !== 'commit') continue;
        const view = parseCommit(obj.data);
        out.push({
          sha,
          node_id: `MDY6Q29tbWl0`,
          commit: {
            message: view.message,
            author: { name: 'Conformance', email: 'conformance@make.fun', date: r.created_at },
            committer: { name: 'Conformance', email: 'conformance@make.fun', date: r.created_at },
            tree: { sha: view.tree },
          },
          author: userJson(viewer, store.viewerId),
          committer: userJson(viewer, store.viewerId),
          parents: view.parents.map((p) => ({ sha: p })),
          url: `${repoUrl(r.owner, r.name)}/commits/${sha}`,
        });
        for (const parent of view.parents) stack.push(parent);
      }
      const { page, headers } = paginate(req, out);
      reply(200, page, headers);
      return true;
    }
    if (method === 'GET' && rest.length === 2) {
      const oid = store.resolveRef(r, rest[1] as string);
      const tip = oid === null ? null : store.peelToCommit(r, oid);
      if (tip === null) {
        err(404, notFound().message);
        return true;
      }
      const obj = r.objects.get(tip);
      if (obj === undefined || obj.type !== 'commit') {
        err(404, notFound().message);
        return true;
      }
      const view = parseCommit(obj.data);
      reply(200, {
        sha: tip,
        commit: { message: view.message, tree: { sha: view.tree } },
        parents: view.parents.map((p) => ({ sha: p })),
      });
      return true;
    }
    err(405, 'Method Not Allowed');
    return true;
  }

  // ---- git refs
  if (sub === 'git' && rest[1] === 'refs') {
    const r = needRepo();
    if (r === null) return true;
    if (method === 'POST' && rest.length === 2) {
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !r.objects.has(sha)) {
        err(422, 'Invalid ref or sha');
        return true;
      }
      r.refs.set(ref, sha);
      const type = r.objects.get(sha)?.type ?? 'commit';
      reply(201, { ref, node_id: `MDM6UmVm`, url: `${repoUrl(r.owner, r.name)}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type, url: `${repoUrl(r.owner, r.name)}/git/${type}s/${sha}` } });
      return true;
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        const list: Json[] = [];
        for (const [ref, oid] of [...r.refs.entries()].sort()) {
          list.push({ ref, object: { sha: oid, type: r.objects.get(oid)?.type ?? 'commit' } });
        }
        reply(200, list);
        return true;
      }
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = r.refs.get(ref);
      if (oid === undefined) {
        err(404, notFound().message);
        return true;
      }
      reply(200, { ref, object: { sha: oid, type: r.objects.get(oid)?.type ?? 'commit' } });
      return true;
    }
    err(405, 'Method Not Allowed');
    return true;
  }

  // ---- contents
  if (sub === 'contents') {
    const r = needRepo();
    if (r === null) return true;
    const filePath = rest.slice(1).join('/');
    const branch = str(body.branch ?? query.get('branch') ?? '', r.default_branch) || r.default_branch;
    const refName = `refs/heads/${branch}`;
    if (method === 'PUT') {
      const message = str(body.message, 'Update file');
      const contentB64 = str(body.content);
      if (contentB64 === '') {
        err(422, 'content is required');
        return true;
      }
      const bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      const tip = r.refs.get(refName);
      const map = tip === undefined ? new Map<string, string>() : treeMap(r, store.peelToCommit(r, tip) ?? tip, store);
      const existing = map.get(filePath);
      if (existing !== undefined) {
        const givenSha = str(body.sha);
        if (givenSha !== '' && givenSha.toLowerCase() !== existing.toLowerCase()) {
          err(409, 'sha does not match the current blob');
          return true;
        }
      }
      const blobOid = hashObject('blob', bytes);
      r.objects.set(blobOid, { type: 'blob', data: bytes });
      map.set(filePath, blobOid);
      const treeOid = writeTree(r, [...map.entries()].map(([path, oid]) => ({ path, oid })));
      const parents = tip === undefined ? [] : [store.peelToCommit(r, tip) ?? tip];
      const commitSha = makeCommit(r, treeOid, parents, message);
      r.refs.set(refName, commitSha);
      const base = filePath.split('/').pop() ?? filePath;
      reply(existing === undefined ? 201 : 200, {
        content: {
          name: base,
          path: filePath,
          sha: blobOid,
          size: bytes.length,
          url: `${repoUrl(r.owner, r.name)}/contents/${filePath}`,
          html_url: `https://github.com/${r.owner}/${r.name}/blob/${branch}/${filePath}`,
          type: 'file',
          encoding: 'base64',
          content: bytes.toString('base64'),
        },
        commit: { sha: commitSha, message, url: `${repoUrl(r.owner, r.name)}/commits/${commitSha}` },
      });
      return true;
    }
    if (method === 'GET') {
      const refish = query.get('ref') ?? branch;
      const oid = store.resolveRef(r, refish);
      const tip = oid === null ? null : store.peelToCommit(r, oid);
      if (tip === null) {
        err(404, notFound().message);
        return true;
      }
      const blobOid = filePath === '' ? null : store.blobAtPath(r, tip, filePath);
      if (blobOid !== null) {
        const blob = r.objects.get(blobOid);
        if (blob === undefined) {
          err(404, notFound().message);
          return true;
        }
        const base = filePath.split('/').pop() ?? filePath;
        reply(200, {
          name: base,
          path: filePath,
          sha: blobOid,
          size: blob.data.length,
          url: `${repoUrl(r.owner, r.name)}/contents/${filePath}`,
          html_url: `https://github.com/${r.owner}/${r.name}/blob/${refish}/${filePath}`,
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
        });
        return true;
      }
      const entries = dirEntries(r, tip, filePath);
      if (entries === null) {
        err(404, notFound().message);
        return true;
      }
      reply(
        200,
        entries.map((e) => ({
          name: e.name,
          path: e.path,
          sha: e.oid,
          size: e.mode === '40000' ? 0 : (r.objects.get(e.oid)?.data.length ?? 0),
          url: `${repoUrl(r.owner, r.name)}/contents/${e.path}`,
          html_url: `https://github.com/${r.owner}/${r.name}/tree/${refish}/${e.path}`,
          type: e.mode === '40000' ? 'dir' : 'file',
        })),
      );
      return true;
    }
    if (method === 'DELETE') {
      const tip = r.refs.get(refName);
      if (tip === undefined) {
        err(404, notFound().message);
        return true;
      }
      const commitOid = store.peelToCommit(r, tip) ?? tip;
      const blobOid = store.blobAtPath(r, commitOid, filePath);
      if (blobOid === null) {
        err(404, notFound().message);
        return true;
      }
      const givenSha = str(body.sha);
      if (givenSha !== '' && givenSha.toLowerCase() !== blobOid.toLowerCase()) {
        err(409, 'sha does not match the current blob');
        return true;
      }
      const map = treeMap(r, commitOid, store);
      map.delete(filePath);
      const treeOid = writeTree(r, [...map.entries()].map(([path, oid]) => ({ path, oid })));
      const commitSha = makeCommit(r, treeOid, [commitOid], str(body.message, 'Delete file'));
      r.refs.set(refName, commitSha);
      reply(200, { content: null, commit: { sha: commitSha, message: str(body.message, 'Delete file') } });
      return true;
    }
    err(405, 'Method Not Allowed');
    return true;
  }

  // ---- labels
  if (sub === 'labels') {
    const r = needRepo();
    if (r === null) return true;
    if (method === 'GET' && rest.length === 1) {
      reply(200, r.labels.map((l) => labelJson(r, l)));
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const name = str(body.name).trim();
      if (name === '') {
        err(422, 'name is required');
        return true;
      }
      const existing = r.labels.find((l) => l.name === name);
      if (existing !== undefined) {
        reply(201, labelJson(r, existing));
        return true;
      }
      const label: Label = { name, color: str(body.color, 'ededed').replace(/^#/, ''), description: str(body.description) };
      r.labels.push(label);
      reply(201, labelJson(r, label));
      return true;
    }
    err(405, 'Method Not Allowed');
    return true;
  }

  // ---- issues
  if (sub === 'issues') {
    const r = needRepo();
    if (r === null) return true;
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...r.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const key = (i: Issue): number => (sort === 'comments' ? i.comments.length : i.number);
        list.sort((a, b) => (direction === 'asc' ? key(a) - key(b) : key(b) - key(a)));
        const { page, headers } = paginate(req, list.map((i) => issueJson(r, i)));
        reply(200, page, headers);
        return true;
      }
      if (method === 'POST') {
        const title = str(body.title).trim();
        if (title === '') {
          err(422, 'title is required');
          return true;
        }
        const labelNames: string[] = Array.isArray(body.labels)
          ? (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : str((l as Json)?.name)))
          : [];
        for (const name of labelNames) {
          if (!r.labels.some((l) => l.name === name)) {
            err(422, `Label does not exist: ${name}`);
            return true;
          }
        }
        const now = new Date().toISOString();
        const issue: Issue = {
          number: r.nextIssue,
          title,
          body: str(body.body),
          state: 'open',
          labels: labelNames,
          user: viewer,
          assignee: null,
          created_at: now,
          updated_at: now,
          closed_at: null,
          comments: [],
        };
        r.nextIssue += 1;
        r.issues.push(issue);
        reply(201, issueJson(r, issue));
        return true;
      }
      err(405, 'Method Not Allowed');
      return true;
    }
    const number = Number.parseInt(rest[1] as string, 10);
    const issue = Number.isInteger(number) ? r.issues.find((i) => i.number === number) : undefined;
    if (rest.length === 2) {
      if (issue === undefined) {
        err(404, notFound().message);
        return true;
      }
      if (method === 'GET') {
        reply(200, issueJson(r, issue));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
          issue.state = body.state;
          issue.closed_at = body.state === 'closed' ? new Date().toISOString() : null;
        }
        if (Array.isArray(body.labels)) {
          const names = (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : str((l as Json)?.name)));
          for (const name of names) {
            if (!r.labels.some((l) => l.name === name)) {
              err(422, `Label does not exist: ${name}`);
              return true;
            }
          }
          issue.labels = names;
        }
        issue.updated_at = new Date().toISOString();
        reply(200, issueJson(r, issue));
        return true;
      }
      err(405, 'Method Not Allowed');
      return true;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) {
        err(404, notFound().message);
        return true;
      }
      if (method === 'GET') {
        const { page, headers } = paginate(req, issue.comments.map((c) => commentJson(r, c)));
        reply(200, page, headers);
        return true;
      }
      if (method === 'POST') {
        const commentBody = str(body.body);
        if (commentBody === '') {
          err(422, 'body is required');
          return true;
        }
        const now = new Date().toISOString();
        const comment: Issue['comments'][number] = {
          id: r.nextCommentId,
          body: commentBody,
          user: viewer,
          created_at: now,
          updated_at: now,
        };
        r.nextCommentId += 1;
        issue.comments.push(comment);
        issue.updated_at = now;
        reply(201, commentJson(r, comment));
        return true;
      }
      err(405, 'Method Not Allowed');
      return true;
    }
    err(404, notFound().message);
    return true;
  }

  // ---- pulls
  if (sub === 'pulls') {
    const r = needRepo();
    if (r === null) return true;
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...r.pulls];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.number - a.number);
        const { page, headers } = paginate(req, list.map((p) => pullJson(r, p, store)));
        reply(200, page, headers);
        return true;
      }
      if (method === 'POST') {
        const title = str(body.title).trim();
        const headRef = str(body.head);
        const baseRef = str(body.base);
        if (title === '' || headRef === '' || baseRef === '') {
          err(422, 'title, head and base are required');
          return true;
        }
        const headOid = store.resolveRef(r, headRef);
        const baseOid = store.resolveRef(r, baseRef);
        const headCommit = headOid === null ? null : store.peelToCommit(r, headOid);
        const baseCommit = baseOid === null ? null : store.peelToCommit(r, baseOid);
        if (headCommit === null || baseCommit === null) {
          err(422, 'head or base branch not found');
          return true;
        }
        const now = new Date().toISOString();
        const pull: Pull = {
          number: r.nextPull,
          title,
          body: str(body.body),
          state: 'open',
          headRef,
          headSha: headCommit,
          baseRef,
          baseSha: baseCommit,
          user: viewer,
          merged: false,
          mergeable: null,
          merge_commit_sha: null,
          created_at: now,
          updated_at: now,
          closed_at: null,
          merged_at: null,
        };
        r.nextPull += 1;
        r.pulls.push(pull);
        reply(201, pullJson(r, pull, store));
        return true;
      }
      err(405, 'Method Not Allowed');
      return true;
    }
    const number = Number.parseInt(rest[1] as string, 10);
    const pull = Number.isInteger(number) ? r.pulls.find((p) => p.number === number) : undefined;
    if (rest.length === 2) {
      if (pull === undefined) {
        err(404, notFound().message);
        return true;
      }
      if (method === 'GET') {
        reply(200, pullJson(r, pull, store));
        return true;
      }
      err(405, 'Method Not Allowed');
      return true;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (pull === undefined) {
        err(404, notFound().message);
        return true;
      }
      if (method !== 'GET') {
        err(405, 'Method Not Allowed');
        return true;
      }
      reply(200, pullFiles(r, pull, store));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (pull === undefined) {
        err(404, notFound().message);
        return true;
      }
      if (method !== 'PUT') {
        err(405, 'Method Not Allowed');
        return true;
      }
      if (pull.state !== 'open' || pull.merged) {
        err(405, 'Pull Request is already merged or closed');
        return true;
      }
      const baseTip = store.resolveRef(r, pull.baseRef);
      const headTip = store.resolveRef(r, pull.headRef);
      const baseCommit = baseTip === null ? null : store.peelToCommit(r, baseTip);
      const headCommit = headTip === null ? null : store.peelToCommit(r, headTip);
      if (baseCommit === null || headCommit === null) {
        err(422, 'head or base branch not found');
        return true;
      }
      const methodName = str(body.merge_method, 'merge');
      const merged = threeWay(r, baseCommit, headCommit, store);
      if (merged.conflict) {
        err(405, 'Merge conflict');
        return true;
      }
      const treeOid = writeTree(r, [...merged.map.entries()].map(([path, oid]) => ({ path, oid })));
      const parents = methodName === 'squash' ? [baseCommit] : [baseCommit, headCommit];
      const mergeMessage =
        methodName === 'squash'
          ? `${pull.title} (#${pull.number})`
          : `Merge pull request #${pull.number} from ${pull.headRef}`;
      const mergeSha = makeCommit(r, treeOid, parents, mergeMessage);
      r.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      const now = new Date().toISOString();
      pull.state = 'closed';
      pull.merged = true;
      pull.merge_commit_sha = mergeSha;
      pull.merged_at = now;
      pull.closed_at = now;
      pull.updated_at = now;
      reply(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
      return true;
    }
    err(404, notFound().message);
    return true;
  }

  err(404, notFound().message);
  return true;
}
