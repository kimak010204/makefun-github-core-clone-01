// GraphQL v4 surface for the github-core-clone-01 entry: POST /api/graphql.
// No general GraphQL engine and no dependencies: a small parser for the document
// subset gh / github-mcp-server send (operations, variables, fragments, inline
// fragments, aliases, input objects, enums), validated against a fixed schema map
// and executed over the shared Store. Reads and writes the same RepoState the
// REST/git surfaces use, so a mutation here is visible over REST and vice versa.
//
// Global (Relay) ids are base64("Type:payload") — opaque, stable across reads,
// never the plain databaseId/number (checks-graphql's global-id-stability check).
// A GraphQL-level failure (unknown field, bad argument) is HTTP 200 with
// {data, errors}; an unauthenticated request is HTTP 401; a batched JSON array
// of operations is answered by an array in the same order (graphql-client.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isAuthorized,
  nowIso,
  readJsonBody,
  sendJson,
  type Issue,
  type IssueComment,
  type Pull,
  type RepoState,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- global ids

function globalId(type: string, payload: string): string {
  return Buffer.from(`${type}:${payload}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; payload: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), payload: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

const repoGlobalId = (repo: RepoState): string => globalId('Repository', String(repo.id));
const issueGlobalId = (repo: RepoState, issue: Issue): string => globalId('Issue', `${repo.id}:${issue.number}`);
const pullGlobalId = (repo: RepoState, pull: Pull): string => globalId('PullRequest', `${repo.id}:${pull.number}`);
const commentGlobalId = (repo: RepoState, issue: Issue, comment: IssueComment): string =>
  globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);

function findRepoById(store: Store, id: string): RepoState | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Repository') return null;
  for (const repo of store.repos.values()) if (String(repo.id) === decoded.payload) return repo;
  return null;
}

function findIssueById(store: Store, id: string): { repo: RepoState; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const [repoId, num] = decoded.payload.split(':');
  for (const repo of store.repos.values()) {
    if (String(repo.id) !== repoId) continue;
    const issue = repo.issues.find((i) => i.number === Number(num));
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function findPullById(store: Store, id: string): { repo: RepoState; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const [repoId, num] = decoded.payload.split(':');
  for (const repo of store.repos.values()) {
    if (String(repo.id) !== repoId) continue;
    const pull = repo.pulls.find((p) => p.number === Number(num));
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------- mini parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}
interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}
interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}
interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}
type DefinitionNode = OperationNode | FragmentNode;

const PUNCT = new Set(['{', '}', '(', ')', ':', '$', '!', '=', '@', '[', ']', '|']);

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // String (block strings """...""" included: treat as plain string content).
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      if (j < source.length && (source[j] === 'e' || source[j] === 'E')) {
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      const raw = source.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(raw) ? 'float' : 'int', value: raw });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
    return token.value;
  }
  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek() !== undefined) defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword === 'fragment') {
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new Error(`unsupported GraphQL definition "${keyword}"`);
    }
    let name: string | null = null;
    const next = this.peek();
    if (next !== undefined && next.kind === 'name') name = this.next().value;
    const variableDefinitions = this.parseVariableDefinitions();
    this.skipDirectives();
    return { kind: 'operation', operation: keyword, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (!this.matchPunct('(')) return defs;
    while (!(this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue();
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next !== undefined && next.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!this.matchPunct('(')) return args;
    while (!(this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- schema

/** Field names each object type answers (validation + __type introspection). */
const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'labels', 'url', 'createdAt', 'updatedAt',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt',
    'closedAt', 'labels', 'comments', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt',
    'mergeCommit', 'url',
  ],
  User: ['id', 'login', 'name', 'avatarUrl', 'url'],
  Ref: ['id', 'name', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Commit: ['oid'],
  Node: ['id'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: ['COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'READ', 'TRIAGE', 'WRITE'],
  PullRequestMergeMethod: ['MERGE', 'REBASE', 'SQUASH'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeInfo(name: string): Record<string, unknown> | null {
  if (Object.prototype.hasOwnProperty.call(TYPE_FIELDS, name)) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      description: null,
      fields: (TYPE_FIELDS[name] as readonly string[]).map((f) => ({ __typename: '__Field', name: f, description: null })),
      enumValues: null,
    };
  }
  if (Object.prototype.hasOwnProperty.call(ENUM_VALUES, name)) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      description: null,
      fields: null,
      enumValues: (ENUM_VALUES[name] as readonly string[]).map((v) => ({ __typename: '__EnumValue', name: v, description: null })),
    };
  }
  return null;
}

// ---------------------------------------------------------------- wrappers

type AnyObj = Record<string, unknown>;
type RepoWrap = { __typename: 'Repository'; _repo: RepoState };
type IssueWrap = { __typename: 'Issue'; _repo: RepoState; _issue: Issue };
type PullWrap = { __typename: 'PullRequest'; _repo: RepoState; _pull: Pull };
type UserWrap = { __typename: 'User'; login: string; id: number };
type CommentWrap = { __typename: 'IssueComment'; _repo: RepoState; _issue: Issue; _comment: IssueComment };
type ConnectionWrap = {
  __typename: string;
  _nodes: unknown[];
  _pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
};

const userWrap = (store: Store, login: string): UserWrap => ({ __typename: 'User', login, id: login === store.viewerLogin ? store.viewerId : 0 });
const repoWrap = (repo: RepoState): RepoWrap => ({ __typename: 'Repository', _repo: repo });
const issueWrap = (repo: RepoState, issue: Issue): IssueWrap => ({ __typename: 'Issue', _repo: repo, _issue: issue });
const pullWrap = (repo: RepoState, pull: Pull): PullWrap => ({ __typename: 'PullRequest', _repo: repo, _pull: pull });
const commentWrap = (repo: RepoState, issue: Issue, comment: IssueComment): CommentWrap => ({
  __typename: 'IssueComment', _repo: repo, _issue: issue, _comment: comment,
});

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1] as string, 10);
  } catch {
    return -1;
  }
}

/** Relay connection over an already-ordered item list. */
function makeConnection(typename: string, items: unknown[], args: Record<string, unknown>): ConnectionWrap {
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex + 1;
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : items.length;
  const slice = items.slice(start, start + first);
  const end = start + slice.length;
  return {
    __typename: typename,
    _nodes: slice,
    _pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length === 0 ? null : cursorOf(start),
      endCursor: slice.length === 0 ? null : cursorOf(end - 1),
    },
  };
}

function stateOfIssue(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function stateOfPull(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}
function mergeableOfPull(pull: Pull): string {
  if (pull.mergeable === true) return 'MERGEABLE';
  if (pull.mergeable === false) return 'CONFLICTING';
  return 'UNKNOWN';
}

function sortIssues(issues: Issue[], args: Record<string, unknown>): Issue[] {
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  const sorted = [...issues];
  const keyOf = (issue: Issue): number | string => {
    if (field === 'UPDATED_AT') return issue.updated_at;
    if (field === 'COMMENTS') return issue.comments.length;
    return issue.number;
  };
  sorted.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka === kb) return (a.number - b.number) * direction;
    if (typeof ka === 'number' && typeof kb === 'number') return (ka - kb) * direction;
    return String(ka) < String(kb) ? -direction : direction;
  });
  // CREATED_AT default direction in the checks is DESC; without orderBy keep creation order.
  if (orderBy.field === undefined) return [...issues].sort((a, b) => a.number - b.number);
  return sorted;
}

function filterIssues(issues: Issue[], args: Record<string, unknown>): Issue[] {
  const states = args.states;
  if (!Array.isArray(states) || states.length === 0) return issues;
  const wanted = new Set(states.map((s) => String(s)));
  return issues.filter((issue) => wanted.has(stateOfIssue(issue)));
}

/** Changed file paths between a PR's base and head commits (added/modified/deleted). */
function pullRequestFiles(store: Store, repo: RepoState, pull: Pull): Array<{ __typename: 'PullRequestChangedFile'; path: string }> {
  const baseCommit = pull.baseSha === '' ? null : store.peelToCommit(repo, pull.baseSha);
  const headCommit = pull.headSha === '' ? null : store.peelToCommit(repo, pull.headSha);
  if (baseCommit === null || headCommit === null) return [];
  const basePaths = new Map(store.listTreePaths(repo, baseCommit).map((e) => [e.path, e.oid]));
  const headPaths = new Map(store.listTreePaths(repo, headCommit).map((e) => [e.path, e.oid]));
  const changed = new Set<string>();
  for (const [path, oid] of headPaths) if (basePaths.get(path) !== oid) changed.add(path);
  for (const path of basePaths.keys()) if (!headPaths.has(path)) changed.add(path);
  return [...changed].sort().map((path) => ({ __typename: 'PullRequestChangedFile', path }));
}

// ---------------------------------------------------------------- validation

interface Ctx {
  store: Store;
  variables: Readonly<Record<string, unknown>>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function validateSelectionSet(ctx: Ctx, typeName: string, selections: SelectionNode[]): void {
  const allowed = TYPE_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      if (allowed === undefined || !allowed.includes(selection.name)) {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
        continue;
      }
      const childType = childTypeOf(typeName, selection.name);
      if (childType !== null && selection.selectionSet !== null) {
        validateSelectionSet(ctx, childType, selection.selectionSet);
      }
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      validateSelectionSet(ctx, fragment.typeCondition, fragment.selectionSet);
    } else {
      const onType = selection.typeCondition ?? typeName;
      validateSelectionSet(ctx, onType, selection.selectionSet);
    }
  }
}

/** The object type a field's selection set is validated/executed against. */
function childTypeOf(parentType: string, field: string): string | null {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Node' },
    Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
    Repository: {
      owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection',
      pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection', labels: 'Label',
    },
    Issue: { author: 'User', labels: 'Label', comments: 'IssueCommentConnection' },
    PullRequest: { author: 'User', headRef: 'Ref', baseRef: 'Ref', files: 'PullRequestChangedFileConnection', mergeCommit: 'Commit' },
    IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo' },
    IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo' },
    IssueEdge: { node: 'Issue' },
    PullRequestEdge: { node: 'PullRequest' },
    PullRequestChangedFileEdge: { node: 'PullRequestChangedFile' },
    IssueCommentEdge: { node: 'IssueComment' },
    IssueComment: { author: 'User' },
    Ref: { target: 'Commit' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
  };
  return map[parentType]?.[field] ?? null;
}

// Node is an interface: inline fragments carry the concrete type; fields id/name
// are validated loosely (any concrete type the fragment names must allow them).
const NODE_FIELD_TYPES: Record<string, string> = { Repository: 'Repository', Issue: 'Issue', PullRequest: 'PullRequest', User: 'User' };

// ---------------------------------------------------------------- execution

function executeSelectionSet(ctx: Ctx, typeName: string, obj: AnyObj | null, selections: SelectionNode[]): AnyObj | null {
  if (obj === null || obj === undefined) return null;
  const out: AnyObj = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = (obj.__typename as string | undefined) ?? typeName;
        continue;
      }
      const args = argsOf(selection, ctx.variables);
      const value = resolveField(ctx, typeName, obj, selection.name, args);
      out[key] = applySelectionSet(ctx, typeName, selection, value);
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== (obj.__typename as string | undefined) && fragment.typeCondition !== typeName) continue;
      const sub = executeSelectionSet(ctx, fragment.typeCondition, obj, fragment.selectionSet);
      if (sub !== null) Object.assign(out, sub);
    } else {
      const onType = selection.typeCondition ?? typeName;
      if (selection.typeCondition !== null && selection.typeCondition !== (obj.__typename as string | undefined)) continue;
      const sub = executeSelectionSet(ctx, onType, obj, selection.selectionSet);
      if (sub !== null) Object.assign(out, sub);
    }
  }
  return out;
}

function applySelectionSet(ctx: Ctx, parentType: string, field: FieldNode, value: unknown): unknown {
  if (field.selectionSet === null) return value;
  if (value === null || value === undefined) return null;
  const childType = childTypeOf(parentType, field.name);
  if (childType === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => (item !== null && typeof item === 'object' ? executeSelectionSet(ctx, childType, item as AnyObj, field.selectionSet as SelectionNode[]) : item));
  }
  if (typeof value === 'object') return executeSelectionSet(ctx, childType, value as AnyObj, field.selectionSet);
  return value;
}

function resolveField(ctx: Ctx, typeName: string, obj: AnyObj, field: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return userWrap(store, store.viewerLogin);
      if (field === 'repository') {
        const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? store.getRepo(args.owner, args.name) : undefined;
        return repo === undefined ? null : repoWrap(repo);
      }
      if (field === 'node') {
        if (typeof args.id !== 'string') return null;
        const decoded = decodeGlobalId(args.id);
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const repo = findRepoById(store, args.id);
          return repo === null ? null : repoWrap(repo);
        }
        if (decoded.type === 'Issue') {
          const found = findIssueById(store, args.id);
          return found === null ? null : issueWrap(found.repo, found.issue);
        }
        if (decoded.type === 'PullRequest') {
          const found = findPullById(store, args.id);
          return found === null ? null : pullWrap(found.repo, found.pull);
        }
        if (decoded.type === 'User') return userWrap(store, store.viewerLogin);
        return null;
      }
      if (field === '__type') return typeof args.name === 'string' ? typeInfo(args.name) : null;
      return null;
    }
    case 'Mutation': {
      if (field === 'createIssue') return mutationCreateIssue(store, args);
      if (field === 'closeIssue') return mutationCloseIssue(store, args);
      if (field === 'createPullRequest') return mutationCreatePullRequest(store, args);
      if (field === 'mergePullRequest') return mutationMergePullRequest(store, args);
      if (field === 'addComment') return mutationAddComment(store, args);
      return null;
    }
    case 'Repository': {
      const repo = (obj as RepoWrap)._repo;
      switch (field) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return userWrap(store, repo.owner);
        case 'description': return repo.description;
        case 'isPrivate': return repo.private;
        case 'url': return `https://github.com/${repo.owner}/${repo.name}`;
        case 'createdAt': return repo.created_at;
        case 'updatedAt': return repo.updated_at;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'defaultBranchRef': {
          const oid = store.resolveRef(repo, repo.default_branch);
          return oid === null ? null : { __typename: 'Ref', name: repo.default_branch, _oid: oid };
        }
        case 'issue': {
          if (typeof args.number !== 'number') return null;
          const issue = repo.issues.find((i) => i.number === args.number);
          return issue === undefined ? null : issueWrap(repo, issue);
        }
        case 'issues': {
          const items = filterIssues(sortIssues(repo.issues, args), args);
          return makeConnection('IssueConnection', items.map((i) => issueWrap(repo, i)), args);
        }
        case 'pullRequest': {
          if (typeof args.number !== 'number') return null;
          const pull = repo.pulls.find((p) => p.number === args.number);
          return pull === undefined ? null : pullWrap(repo, pull);
        }
        case 'pullRequests': {
          const pulls = [...repo.pulls].sort((a, b) => a.number - b.number);
          return makeConnection('PullRequestConnection', pulls.map((p) => pullWrap(repo, p)), args);
        }
        case 'labels': return repo.labels.map((l) => ({ __typename: 'Label', id: globalId('Label', `${repo.id}:${l.name}`), name: l.name, color: l.color, description: l.description }));
        default: return null;
      }
    }
    case 'Issue': {
      const wrap = obj as IssueWrap;
      const issue = wrap._issue;
      switch (field) {
        case 'id': return issueGlobalId(wrap._repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return stateOfIssue(issue);
        case 'body': return issue.body;
        case 'bodyText': return issue.body;
        case 'author': return userWrap(store, issue.user);
        case 'createdAt': return issue.created_at;
        case 'updatedAt': return issue.updated_at;
        case 'closedAt': return issue.closed_at;
        case 'url': return `https://github.com/${wrap._repo.owner}/${wrap._repo.name}/issues/${issue.number}`;
        case 'labels': return issue.labels.map((name) => ({ __typename: 'Label', id: globalId('Label', `${wrap._repo.id}:${name}`), name, color: '', description: '' }));
        case 'comments': return makeConnection('IssueCommentConnection', issue.comments.map((c) => commentWrap(wrap._repo, issue, c)), args);
        default: return null;
      }
    }
    case 'PullRequest': {
      const wrap = obj as PullWrap;
      const pull = wrap._pull;
      switch (field) {
        case 'id': return pullGlobalId(wrap._repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return stateOfPull(pull);
        case 'merged': return pull.merged;
        case 'mergeable': return mergeableOfPull(pull);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return { __typename: 'Ref', name: pull.headRef, _oid: pull.headSha };
        case 'baseRef': return { __typename: 'Ref', name: pull.baseRef, _oid: pull.baseSha };
        case 'files': return makeConnection('PullRequestChangedFileConnection', pullRequestFiles(store, wrap._repo, pull), args);
        case 'author': return userWrap(store, pull.user);
        case 'createdAt': return pull.created_at;
        case 'updatedAt': return pull.updated_at;
        case 'closedAt': return pull.closed_at;
        case 'mergedAt': return pull.merged_at;
        case 'mergeCommit': return pull.merge_commit_sha === null ? null : { __typename: 'Commit', oid: pull.merge_commit_sha };
        case 'url': return `https://github.com/${wrap._repo.owner}/${wrap._repo.name}/pull/${pull.number}`;
        default: return null;
      }
    }
    case 'User': {
      const user = obj as UserWrap;
      switch (field) {
        case 'id': return globalId('User', String(user.id));
        case 'login': return user.login;
        case 'name': return user.login;
        case 'avatarUrl': return `https://avatars.githubusercontent.com/u/${user.id}?v=4`;
        case 'url': return `https://github.com/${user.login}`;
        default: return null;
      }
    }
    case 'Ref': {
      switch (field) {
        case 'id': return globalId('Ref', String(obj.name ?? ''));
        case 'name': return obj.name ?? null;
        case 'target': return typeof obj._oid === 'string' && obj._oid !== '' ? { __typename: 'Commit', oid: obj._oid } : null;
        default: return null;
      }
    }
    case 'Label': {
      switch (field) {
        case 'id': return typeof obj.id === 'string' ? obj.id : null;
        case 'name': return obj.name ?? null;
        case 'color': return obj.color ?? null;
        case 'description': return obj.description ?? null;
        default: return null;
      }
    }
    case 'IssueComment': {
      const wrap = obj as CommentWrap;
      switch (field) {
        case 'id': return commentGlobalId(wrap._repo, wrap._issue, wrap._comment);
        case 'body': return wrap._comment.body;
        case 'bodyText': return wrap._comment.body;
        case 'author': return userWrap(store, wrap._comment.user);
        case 'createdAt': return wrap._comment.created_at;
        case 'updatedAt': return wrap._comment.updated_at;
        default: return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection': {
      const conn = obj as ConnectionWrap;
      switch (field) {
        case 'nodes': return conn._nodes;
        case 'edges': return conn._nodes.map((node, i) => ({ __typename: `${typeName.replace('Connection', '')}Edge`, node, cursor: cursorOf(i) }));
        case 'pageInfo': return { __typename: 'PageInfo', ...conn._pageInfo };
        case 'totalCount': return conn._nodes.length;
        default: return null;
      }
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
    case 'IssueCommentEdge': {
      if (field === 'node') return obj.node ?? null;
      if (field === 'cursor') return typeof obj.cursor === 'string' ? obj.cursor : null;
      return null;
    }
    case 'PullRequestChangedFile': {
      return field === 'path' ? (obj.path ?? null) : null;
    }
    case 'PageInfo': {
      switch (field) {
        case 'hasNextPage': return obj.hasNextPage ?? false;
        case 'hasPreviousPage': return obj.hasPreviousPage ?? false;
        case 'startCursor': return obj.startCursor ?? null;
        case 'endCursor': return obj.endCursor ?? null;
        default: return null;
      }
    }
    case 'Commit': {
      return field === 'oid' ? (obj.oid ?? null) : null;
    }
    case '__Type': {
      switch (field) {
        case 'name': return obj.name ?? null;
        case 'kind': return obj.kind ?? null;
        case 'description': return obj.description ?? null;
        case 'fields': return Array.isArray(obj.fields) ? obj.fields : null;
        case 'enumValues': return Array.isArray(obj.enumValues) ? obj.enumValues : null;
        default: return null;
      }
    }
    case '__Field':
    case '__EnumValue': {
      if (field === 'name') return obj.name ?? null;
      if (field === 'description') return obj.description ?? null;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      return field === 'issue' ? (obj.issue ?? null) : null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      return field === 'pullRequest' ? (obj.pullRequest ?? null) : null;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return obj.commentEdge ?? null;
      return null;
    }
    case 'Node': {
      // The Relay node interface: `id` resolves from the concrete object.
      if (field === 'id') {
        if (obj.__typename === 'Repository') return repoGlobalId((obj as RepoWrap)._repo);
        if (obj.__typename === 'Issue') return issueGlobalId((obj as IssueWrap)._repo, (obj as IssueWrap)._issue);
        if (obj.__typename === 'PullRequest') return pullGlobalId((obj as PullWrap)._repo, (obj as PullWrap)._pull);
        if (obj.__typename === 'User') return globalId('User', String((obj as UserWrap).id));
        return null;
      }
      return obj[field] ?? null;
    }
    default: {
      // Any other wrapper: read the property straight off.
      return obj[field] ?? null;
    }
  }
}

// ---------------------------------------------------------------- mutations

function mutationCreateIssue(store: Store, args: Record<string, unknown>): AnyObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = typeof input.repositoryId === 'string' ? findRepoById(store, input.repositoryId) : null;
  if (repo === null) throw new Error(`createIssue: unknown repositoryId ${JSON.stringify(input.repositoryId)}`);
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const now = nowIso();
  const issue: Issue = {
    number: repo.nextIssue++,
    title,
    body,
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
  return { __typename: 'CreateIssuePayload', issue: issueWrap(repo, issue) };
}

function mutationCloseIssue(store: Store, args: Record<string, unknown>): AnyObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = typeof input.issueId === 'string' ? findIssueById(store, input.issueId) : null;
  if (found === null) throw new Error(`closeIssue: unknown issueId ${JSON.stringify(input.issueId)}`);
  const now = nowIso();
  found.issue.state = 'closed';
  found.issue.closed_at = now;
  found.issue.updated_at = now;
  found.repo.updated_at = now;
  return { __typename: 'CloseIssuePayload', issue: issueWrap(found.repo, found.issue) };
}

function mutationCreatePullRequest(store: Store, args: Record<string, unknown>): AnyObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = typeof input.repositoryId === 'string' ? findRepoById(store, input.repositoryId) : null;
  if (repo === null) throw new Error(`createPullRequest: unknown repositoryId ${JSON.stringify(input.repositoryId)}`);
  const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
  const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.default_branch;
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  const headResolved = store.resolveRef(repo, headRef);
  const baseResolved = store.resolveRef(repo, baseRef);
  const now = nowIso();
  const pull: Pull = {
    number: repo.nextPull++,
    title,
    body,
    state: 'open',
    headRef,
    headSha: headResolved === null ? '' : (store.peelToCommit(repo, headResolved) ?? headResolved),
    baseRef,
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
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullWrap(repo, pull) };
}

function mutationMergePullRequest(store: Store, args: Record<string, unknown>): AnyObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = typeof input.pullRequestId === 'string' ? findPullById(store, input.pullRequestId) : null;
  if (found === null) throw new Error(`mergePullRequest: unknown pullRequestId ${JSON.stringify(input.pullRequestId)}`);
  const now = nowIso();
  found.pull.merged = true;
  found.pull.state = 'closed';
  found.pull.merged_at = now;
  found.pull.closed_at = now;
  found.pull.updated_at = now;
  found.pull.merge_commit_sha = found.pull.headSha === '' ? null : found.pull.headSha;
  found.repo.updated_at = now;
  return { __typename: 'MergePullRequestPayload', pullRequest: pullWrap(found.repo, found.pull) };
}

function mutationAddComment(store: Store, args: Record<string, unknown>): AnyObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = typeof input.subjectId === 'string' ? findIssueById(store, input.subjectId) : null;
  if (found === null) throw new Error(`addComment: unknown subjectId ${JSON.stringify(input.subjectId)}`);
  const body = typeof input.body === 'string' ? input.body : '';
  const now = nowIso();
  const comment: IssueComment = { id: found.repo.nextCommentId++, body, user: store.viewerLogin, created_at: now, updated_at: now };
  found.issue.comments.push(comment);
  found.issue.updated_at = now;
  found.repo.updated_at = now;
  const node = commentWrap(found.repo, found.issue, comment);
  return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorOf(found.issue.comments.length - 1) } };
}

// ---------------------------------------------------------------- handler

function executeOperation(store: Store, operation: OperationNode, variables: Readonly<Record<string, unknown>>, fragments: Map<string, FragmentNode>): Record<string, unknown> {
  const ctx: Ctx = { store, variables, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  if (operation.operation === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported.' }] };
  }
  validateSelectionSet(ctx, rootType, operation.selectionSet);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  try {
    const data = executeSelectionSet(ctx, rootType, { __typename: rootType } as AnyObj, operation.selectionSet);
    return { data: data ?? {} };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

function runOneOperation(store: Store, body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be a JSON object with a query string.' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL request body must carry a query string.' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
    return { data: null, errors: [{ message: 'GraphQL variables must be a JSON object.' }] };
  }
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL syntax error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const def of definitions) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
    else operations.push(def);
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'GraphQL document carries no operation.' }] };
  }
  let operation: OperationNode | undefined;
  const operationName = record.operationName;
  if (typeof operationName === 'string' && operationName !== '') {
    operation = operations.find((op) => op.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (operations.length === 1) {
    operation = operations[0];
  } else {
    return { data: null, errors: [{ message: 'GraphQL document carries several operations but no operationName was given.' }] };
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const def of operation.variableDefinitions) {
    if (!(def.name in mergedVariables) && def.defaultValue !== null) {
      mergedVariables[def.name] = resolveValue(def.defaultValue, variables);
    }
  }
  return executeOperation(store, operation, mergedVariables, fragments);
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!isAuthorized(req, store)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
    return true;
  }
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((entry) => runOneOperation(store, entry)));
    return true;
  }
  sendJson(res, 200, runOneOperation(store, body));
  return true;
}
