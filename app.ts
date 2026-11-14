// Router for the github-core-clone-01 entry: health probe, API root, then dispatch to the four
// surfaces (git smart HTTP, REST v3, GraphQL v4, MCP). main.ts owns the lifecycle; this file owns
// routing only. Each surface module exports one async handler returning true when it answered.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, notFound, pathOf, sendJson } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export function createApp(): Server {
  const store = new Store(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }
        // git smart HTTP: /<owner>/<repo>.git/info/refs, git-upload-pack, git-receive-pack
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          if (await handleGit(req, res, store)) return;
        }
        // GraphQL v4
        if (method === 'POST' && path === '/api/graphql') {
          if (await handleGraphql(req, res, store)) return;
        }
        // MCP over streamable HTTP
        if (path === '/mcp') {
          if (await handleMcp(req, res, store)) return;
        }
        // REST v3
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(req, res, store)) return;
        }
        sendJson(res, 404, notFound());
      } catch (err) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // peer went away
        }
        process.stderr.write(`[entry] ${method} ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  });
}
