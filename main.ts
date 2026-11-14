// Entrypoint lifecycle for the github-core-clone-01 entry.
//
// Binds an ephemeral port, registers it with the harness env, then polls
// /done until the suite finishes. Exits 0 only after done=true, and exits 1
// on any unrecoverable error (missing env URL, fatal register status).

import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextDelay(delay: number): number {
  return Math.min(delay * 2, BACKOFF_MAX_MS);
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function register(envUrl: string, port: number): Promise<void> {
  let delay = BACKOFF_START_MS;
  for (;;) {
    let result: { status: number; body: unknown } | null = null;
    try {
      result = await fetchJson(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
    } catch {
      result = null;
    }
    if (result !== null) {
      if (result.status === 200 || result.status === 409) return;
      if (result.status === 400 || result.status === 405) {
        throw new Error(`register failed with status ${result.status}`);
      }
    }
    await sleep(delay);
    delay = nextDelay(delay);
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  let delay = BACKOFF_START_MS;
  for (;;) {
    let done = false;
    try {
      const result = await fetchJson(`${envUrl}/done`);
      if (result.status === 200 && typeof result.body === 'object' && result.body !== null) {
        done = (result.body as { done?: unknown }).done === true;
      }
    } catch {
      done = false;
    }
    if (done) return;
    await sleep(delay);
    delay = nextDelay(delay);
  }
}

async function closeServer(server: ReturnType<typeof createApp>): Promise<void> {
  if (typeof (server as { closeAllConnections?: unknown }).closeAllConnections === 'function') {
    (server as { closeAllConnections: () => void }).closeAllConnections();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function main(): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (!envUrl) {
    process.stderr.write('MAKEFUN_ENV_URL is not set\n');
    process.exit(1);
  }
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (!port) throw new Error('could not determine bound port');
  try {
    await register(envUrl, port);
    await waitForDone(envUrl);
  } finally {
    await closeServer(server);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
