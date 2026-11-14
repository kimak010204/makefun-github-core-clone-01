// MCP surface for the github-core-clone-01 entry: POST /mcp, Streamable HTTP
// (JSON-RPC 2.0, plain JSON answers). Speaks both protocol eras the env's
// mcp-client.ts accepts:
//
//   modern 2026-07-28: server/discover returns identity, capabilities and
//           supportedVersions; no handshake, no session.
//   legacy  2025-11-25 and earlier: initialize (echoes a revision the client
//           offers) + notifications/initialized.
//
// Tools read and write the same Store as REST/GraphQL/git, so a repository,
// issue or pull request made over MCP is the same object over REST.
// Auth: Bearer token = store.token (isAuthorized); unauthenticated calls are
// HTTP 401, decided before any tool runs. A body that is not JSON is HTTP 400
// with JSON-RPC -32700; an unknown tool is JSON-RPC -32602; a tools/call with
// missing required arguments is JSON-RPC -32602; a tool that runs but cannot
// do its work answers isError:true. Notifications (no id) are HTTP 202.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isAuthorized,
  nowIso,
  readBody,
  sendJson,
  type Issue,
  type Pull,
  type RepoState,
  type Store,
} from './store.ts';

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The repository owner (defaults to the authenticated user).' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// The suite maps its documented argument names onto a tool's own schema
// property names by synonym, so accept the same synonyms here.
const ARG_SYNONYMS: Record<string, readonly string[]> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
};

function canonicalArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [canonical, synonyms] of Object.entries(ARG_SYNONYMS)) {
    for (const synonym of synonyms) {
      if (raw[synonym] !== undefined) {
        out[canonical] = raw[synonym];
        break;
      }
    }
  }
  // A full_name ("owner/repo") stands in for owner+repo.
  if ((out.owner === undefined || out.repo === undefined) && typeof raw.full_name === 'string') {
    const parts = (raw.full_name as string).split('/');
    if (parts.length === 2) {
      if (out.owner === undefined) out.owner = parts[0];
      if (out.repo === undefined) out.repo = parts[1];
    }
  }
  return out;
}

// ---------------------------------------------------------------- REST-shaped views (what tool results carry)

function repoJson(repo: RepoState): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: RepoState, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user, type: 'User' },
    assignee: issue.assignee,
    labels: issue.labels,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

function pullJson(repo: RepoState, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: pull.user, type: 'User' },
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.merge_commit_sha,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.merged_at,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------- tool execution

class ToolError extends Error {}

function needRepo(store: Store, args: Record<string, unknown>): RepoState {
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : store.viewerLogin;
  const repo = typeof args.repo === 'string' ? store.getRepo(owner, args.repo) : undefined;
  if (repo === undefined) throw new ToolError(`Repository not found: ${owner}/${String(args.repo ?? '')}`);
  return repo;
}

function runTool(store: Store, name: string, rawArgs: Record<string, unknown>): unknown {
  const args = canonicalArgs(rawArgs);
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (typeof repoName !== 'string' || repoName === '') throw new ToolError('create_repo needs a repository name');
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : store.viewerLogin;
      const existing = store.getRepo(owner, repoName);
      if (existing !== undefined) return repoJson(existing);
      const repo = store.createRepo(owner, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return repoJson(repo);
    }
    case 'get_repo': {
      return repoJson(needRepo(store, args));
    }
    case 'create_issue': {
      const repo = needRepo(store, args);
      if (typeof args.title !== 'string' || args.title === '') throw new ToolError('create_issue needs a title');
      const now = nowIso();
      const issue: Issue = {
        number: repo.nextIssue++,
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        user: store.viewerLogin,
        assignee: null,
        created_at: now,
        updated_at: now,
        closed_at: null,
        comments: [],
      };
      repo.issues.push(issue);
      repo.updated_at = now;
      return issueJson(repo, issue);
    }
    case 'list_issues': {
      const repo = needRepo(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return issues.map((issue) => issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = needRepo(store, args);
      if (typeof args.title !== 'string' || args.title === '') throw new ToolError('create_pull_request needs a title');
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : repo.default_branch;
      if (head === '') throw new ToolError('create_pull_request needs a head branch');
      const headResolved = store.resolveRef(repo, head);
      const baseResolved = store.resolveRef(repo, base);
      const now = nowIso();
      const pull: Pull = {
        number: repo.nextPull++,
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        headSha: headResolved === null ? '' : (store.peelToCommit(repo, headResolved) ?? headResolved),
        baseRef: base,
        baseSha: baseResolved === null ? '' : (store.peelToCommit(repo, baseResolved) ?? baseResolved),
        user: store.viewerLogin,
        merged: false,
        mergeable: true,
        merge_commit_sha: null,
        created_at: now,
        updated_at: now,
        closed_at: null,
        merged_at: null,
      };
      repo.pulls.push(pull);
      repo.updated_at = now;
      return pullJson(repo, pull);
    }
    case 'merge_pull_request': {
      const repo = needRepo(store, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (!Number.isInteger(number)) throw new ToolError('merge_pull_request needs a pull request number');
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) throw new ToolError(`Pull request #${number} not found in ${repo.owner}/${repo.name}`);
      if (pull.merged) throw new ToolError(`Pull request #${number} is already merged`);
      const now = nowIso();
      pull.merged = true;
      pull.state = 'closed';
      pull.merged_at = now;
      pull.closed_at = now;
      pull.updated_at = now;
      pull.merge_commit_sha = pull.headSha === '' ? null : pull.headSha;
      repo.updated_at = now;
      return pullJson(repo, pull);
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function discoverResult(): Record<string, unknown> {
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo,
    instructions: 'GitHub-compatible forge: create and read repositories, issues and pull requests.',
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}

function handleRpc(req: IncomingMessage, res: ServerResponse, store: Store, body: unknown): boolean {
  if (!isRecord(body)) {
    rpcError(res, 400, null, -32600, 'Invalid Request: expected a JSON-RPC object');
    return true;
  }
  const id = 'id' in body ? body.id : undefined;
  const method = body.method;
  // A message with no id is a notification: acknowledge, never answer.
  if (id === undefined) {
    try {
      res.writeHead(202);
      res.end();
    } catch {
      // peer went away
    }
    return true;
  }
  if (typeof method !== 'string' || method === '') {
    rpcError(res, 400, id, -32600, 'Invalid Request: missing method');
    return true;
  }
  const params = isRecord(body.params) ? body.params : {};
  switch (method) {
    case 'server/discover': {
      rpcResult(res, id, discoverResult());
      return true;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      rpcResult(res, id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'ping': {
      rpcResult(res, id, {});
      return true;
    }
    case 'tools/list': {
      rpcResult(res, id, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const name = params.name;
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (typeof name !== 'string' || name === '') {
        rpcError(res, 200, id, -32602, 'Invalid params: tools/call needs a tool name');
        return true;
      }
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) {
        rpcError(res, 200, id, -32602, `Unknown tool: ${name}`);
        return true;
      }
      const mapped = canonicalArgs(args);
      const missing = tool.inputSchema.required.filter((key) => mapped[key] === undefined || mapped[key] === null || mapped[key] === '');
      if (missing.length > 0) {
        rpcError(res, 200, id, -32602, `Invalid params: ${name} is missing required argument(s): ${missing.join(', ')}`);
        return true;
      }
      try {
        const value = runTool(store, name, args);
        rpcResult(res, id, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch (err) {
        rpcResult(res, id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
      return true;
    }
    case 'resources/list': {
      rpcResult(res, id, { resources: [] });
      return true;
    }
    case 'prompts/list': {
      rpcResult(res, id, { prompts: [] });
      return true;
    }
    default: {
      rpcError(res, 200, id, -32601, `Method not found: ${method}`);
      return true;
    }
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    // No GET stream is served; the transport is POST-only here.
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (method === 'DELETE') {
    try {
      res.writeHead(204);
      res.end();
    } catch {
      // peer went away
    }
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!isAuthorized(req, store)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error: request body could not be read');
    return true;
  }
  let body: unknown;
  try {
    body = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error: request body is not valid JSON');
    return true;
  }
  if (body === null) {
    rpcError(res, 400, null, -32700, 'Parse error: empty request body');
    return true;
  }
  // Raw-body parsing above (not readJsonBody) is deliberate: the parse-error
  // check needs the raw text so a truncated body answers -32700.
  return handleRpc(req, res, store, body);
}
