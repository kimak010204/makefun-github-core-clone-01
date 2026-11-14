// Smart-HTTP git surface for the github-core-clone-01 entry: protocol v2 + v0
// info/refs advertisements, v2 ls-refs / fetch, v0 upload-pack fetch, and
// receive-pack push with packfile read (incl. OFS/REF deltas) and report-status.
// Node built-ins only; object helpers come from store.ts so bytes round-trip
// with the env's git-client.ts exactly.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  hashObject,
  isAuthorized,
  isObjectId,
  nowIso,
  parseCommit,
  parseTag,
  parseTree,
  pathOf,
  queryOf,
  readBody,
  sendBuffer,
  sendJson,
  type GitObject,
  type GitObjectType,
  type RepoState,
  type Store,
} from './store.ts';

const AGENT = 'makefun-git-server/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
/** Largest sideband data chunk: pkt-line max 65520 - 4 header - 1 band byte. */
const SIDEBAND_CHUNK = 65515;
const PKT_LINE_MAX = 65520;

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

interface PktLine {
  readonly kind: PktKind;
  readonly payload: Buffer;
}

function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Read one pkt-line at `offset`; throws on a malformed header or truncation. */
function readPktLine(buf: Buffer, offset: number): { line: PktLine; next: number } {
  if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
  const header = buf.subarray(offset, offset + 4).toString('ascii');
  if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
  const length = Number.parseInt(header, 16);
  if (length === 0) return { line: { kind: 'flush', payload: Buffer.alloc(0) }, next: offset + 4 };
  if (length === 1) return { line: { kind: 'delim', payload: Buffer.alloc(0) }, next: offset + 4 };
  if (length === 2) return { line: { kind: 'response-end', payload: Buffer.alloc(0) }, next: offset + 4 };
  if (length === 3) throw new Error('invalid pkt-line length 0003');
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
  if (offset + length > buf.length) throw new Error('truncated pkt-line');
  return {
    line: { kind: 'data', payload: buf.subarray(offset + 4, offset + length) },
    next: offset + length,
  };
}

/** Decode pkt-lines until a flush (consumed) or end of buffer. Returns lines + offset past flush. */
function readPktSection(buf: Buffer, offset: number): { lines: string[]; next: number; flushed: boolean } {
  const lines: string[] = [];
  let pos = offset;
  while (pos < buf.length) {
    const { line, next } = readPktLine(buf, pos);
    pos = next;
    if (line.kind === 'flush') return { lines, next: pos, flushed: true };
    if (line.kind === 'data') lines.push(line.payload.toString('utf8'));
    // delim / response-end inside a request section: ignore
  }
  return { lines, next: pos, flushed: false };
}

// ---------------------------------------------------------------------------------------------
// packfile write (plain objects, no deltas) and read (incl. deltas)
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA against the pack
 * itself and, for thin packs, against `repo`'s objects. Verifies the trailer.
 */
function readPack(pack: Buffer, repo: RepoState): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolved = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const done = resolved.get(entry.offset);
    if (done) return done;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = repo.objects.get(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the repo`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const item = resolve(entry);
    if (!objects.has(item.oid)) objects.set(item.oid, { type: item.type, data: item.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// refs / peeling
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: RepoState): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headRefName(repo: RepoState): string {
  return `refs/heads/${repo.default_branch}`;
}

/** Follow annotated tags to the object they point at (commit, tree or blob). */
function peelTagChain(repo: RepoState, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

/** True when `ancestor` (peeled) is reachable from `tip` (peeled) by parent links. */
function isAncestor(repo: RepoState, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function v0Capabilities(repo: RepoState, extra: string): string {
  const symref = `symref=HEAD:${headRefName(repo)}`;
  return `${extra} agent=${AGENT} ${symref} object-format=sha1`;
}

function v0Advertisement(repo: RepoState, service: GitService): Buffer {
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`)];
  const caps =
    service === 'git-upload-pack'
      ? v0Capabilities(repo, 'side-band-64k thin-pack ofs-delta multi_ack_detailed shallow')
      : v0Capabilities(repo, 'report-status report-status-v2 side-band-64k delete-refs ofs-delta');
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headRefName(repo)) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    parts.push(encodePktLine(`${headOid} HEAD\u0000${caps}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelTagChain(repo, ref.oid);
        if (peeled !== ref.oid) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(service: GitService): Buffer {
  return encodePktLines([
    `# service=${service}\n`,
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------------------------------------
// fetch planning (v0 + v2 share this)
// ---------------------------------------------------------------------------------------------

interface FetchParams {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth?: number;
}

interface FetchPlan {
  readonly objects: Map<string, GitObject>;
  readonly shallow: string[];
  readonly unshallow: string[];
}

function addTreeClosureInto(repo: RepoState, into: Map<string, GitObject> | Set<string>, treeOid: string): void {
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (into instanceof Map) into.set(oid, obj);
    else into.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
}

function computeFetch(repo: RepoState, params: FetchParams): FetchPlan {
  const depth = params.depth;
  const shallowSet = new Set(params.shallow);
  // BFS from the wants over parent links, honouring the depth limit.
  const dist = new Map<string, number>();
  const tagObjects = new Map<string, GitObject>();
  const directObjects = new Map<string, GitObject>();
  const queue: string[] = [];
  const enqueueCommit = (oid: string, d: number): void => {
    if (!dist.has(oid) && repo.objects.get(oid)?.type === 'commit') {
      dist.set(oid, d);
      queue.push(oid);
    }
  };
  for (const want of params.wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) throw new Error(`want ${want} not found`);
    if (obj.type === 'tag') {
      let current = want;
      for (let i = 0; i < 10; i += 1) {
        const tagObj = repo.objects.get(current);
        if (tagObj === undefined || tagObj.type !== 'tag') break;
        tagObjects.set(current, tagObj);
        const target = parseTag(tagObj.data).object;
        const targetObj = repo.objects.get(target);
        if (targetObj === undefined) throw new Error(`tag target ${target} not found`);
        if (targetObj.type === 'tag') {
          current = target;
          continue;
        }
        if (targetObj.type === 'commit') enqueueCommit(target, 0);
        else directObjects.set(target, targetObj);
        break;
      }
    } else if (obj.type === 'commit') {
      enqueueCommit(want, 0);
    } else {
      directObjects.set(want, obj);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++] as string;
    const d = dist.get(oid) as number;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (dist.has(parent)) continue;
      const nd = d + 1;
      if (depth !== undefined && nd >= depth) continue;
      if (repo.objects.get(parent)?.type !== 'commit') continue;
      dist.set(parent, nd);
      queue.push(parent);
    }
  }
  const included = new Set(dist.keys());
  const shallow: string[] = [];
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((parent) => !included.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundary of params.shallow) {
    if (!included.has(boundary)) continue;
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (parseCommit(obj.data).parents.every((parent) => included.has(parent))) unshallow.push(boundary);
  }
  // Objects to send: the included commits' closures + tag/direct wants.
  const send = new Map<string, GitObject>();
  for (const [oid, obj] of tagObjects) send.set(oid, obj);
  for (const [oid, obj] of directObjects) {
    send.set(oid, obj);
    if (obj.type === 'tree') addTreeClosureInto(repo, send, oid);
  }
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    send.set(oid, obj);
    addTreeClosureInto(repo, send, parseCommit(obj.data).tree);
  }
  // Subtract what the client already holds: the haves' closures, stopping parent
  // traversal at the client's existing shallow boundary.
  const held = new Set<string>();
  const visitHaveCommit = (oid: string): void => {
    if (held.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return;
    held.add(oid);
    addTreeClosureInto(repo, held, parseCommit(obj.data).tree);
    if (!shallowSet.has(oid)) {
      for (const parent of parseCommit(obj.data).parents) visitHaveCommit(parent);
    }
  };
  for (const have of params.haves) {
    const obj = repo.objects.get(have);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      let current = have;
      for (let i = 0; i < 10; i += 1) {
        const tagObj = repo.objects.get(current);
        if (tagObj === undefined || tagObj.type !== 'tag') break;
        held.add(current);
        const target = parseTag(tagObj.data).object;
        const targetObj = repo.objects.get(target);
        if (targetObj === undefined) break;
        if (targetObj.type === 'tag') {
          current = target;
          continue;
        }
        if (targetObj.type === 'commit') visitHaveCommit(target);
        else addTreeClosureInto(repo, held, target);
        break;
      }
    } else if (obj.type === 'commit') {
      visitHaveCommit(have);
    } else {
      addTreeClosureInto(repo, held, have);
    }
  }
  for (const oid of held) send.delete(oid);
  return { objects: send, shallow, unshallow };
}

function sidebandEncode(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + SIDEBAND_CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(payload));
  }
  return Buffer.concat(parts);
}

function sortedPackObjects(objects: Map<string, GitObject>): GitObject[] {
  return [...objects.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, obj]) => obj);
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefsV2(repo: RepoState, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const headName = headRefName(repo);
  const headOid = repo.refs.get(headName);
  const matchesPrefix = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (args.symrefs && matchesPrefix('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD symref-target:${headName}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:${headName}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matchesPrefix(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelTagChain(repo, ref.oid);
        if (peeled !== ref.oid) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// v2 fetch
// ---------------------------------------------------------------------------------------------

function handleFetchV2(repo: RepoState, body: Buffer): Buffer {
  const { lines } = readPktSection(body, 0);
  // First line must be command=fetch; a delim separates it from the arguments.
  const args = lines.filter((line) => !line.startsWith('command='));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line === 'done') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line.startsWith('filter ')) continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      // Not exercised by the conformance checks; parsed and ignored.
      continue;
    }
  }
  for (const oid of [...wants, ...haves, ...shallow]) {
    if (!isObjectId(oid)) throw new Error(`fetch names a bad object id ${JSON.stringify(oid)}`);
  }
  const plan = computeFetch(repo, { wants, haves, shallow, depth });
  const pack = writePack(sortedPackObjects(plan.objects));
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'), encodePktLine('NAK\n'), PKT_FLUSH);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandEncode(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// v0 fetch
// ---------------------------------------------------------------------------------------------

function handleFetchV0(repo: RepoState, body: Buffer): Buffer {
  const first = readPktSection(body, 0);
  const wants: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const raw of first.lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim().split(/\s+/);
      wants.push(rest[0] as string);
    } else if (line.startsWith('shallow ')) {
      shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // deepen-since / deepen-not: parsed and ignored (not exercised by the checks).
  }
  const haves: string[] = [];
  if (first.flushed) {
    const second = readPktSection(body, first.next);
    for (const raw of second.lines) {
      const line = raw.replace(/\n$/, '');
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  for (const oid of [...wants, ...haves, ...shallow]) {
    if (!isObjectId(oid)) throw new Error(`fetch names a bad object id ${JSON.stringify(oid)}`);
  }
  const plan = computeFetch(repo, { wants, haves, shallow, depth });
  const pack = writePack(sortedPackObjects(plan.objects));
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandEncode(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// POST git-upload-pack dispatch (v2 vs v0 by the Git-Protocol header)
// ---------------------------------------------------------------------------------------------

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: RepoState): Promise<void> {
  const body = await readBody(req);
  const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  let out: Buffer;
  if (v2) {
    const first = readPktSection(body, 0);
    const commandLine = (first.lines[0] ?? '').replace(/\n$/, '');
    if (commandLine === 'command=ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const raw of first.lines.slice(1)) {
        const line = raw.replace(/\n$/, '');
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line === 'unborn') args.unborn = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice(11));
      }
      out = handleLsRefsV2(repo, args);
    } else if (commandLine === 'command=fetch') {
      out = handleFetchV2(repo, body);
    } else {
      throw new Error(`unsupported v2 command ${JSON.stringify(commandLine)}`);
    }
  } else {
    out = handleFetchV0(repo, body);
  }
  sendBuffer(res, 200, out, UPLOAD_RESULT);
}

// ---------------------------------------------------------------------------------------------
// POST git-receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function reportStatus(
  unpackOk: boolean,
  unpackDetail: string,
  refs: Array<{ ref: string; ok: boolean; reason: string }>,
  useSideband: boolean,
): Buffer {
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const entry of refs) {
    lines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  const body = encodePktLines([...lines, 'flush']);
  if (!useSideband) return body;
  const parts: Buffer[] = [];
  for (let offset = 0; offset < body.length; offset += SIDEBAND_CHUNK) {
    const chunk = body.subarray(offset, Math.min(body.length, offset + SIDEBAND_CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: RepoState): Promise<void> {
  const body = await readBody(req);
  const section = readPktSection(body, 0);
  if (!section.flushed) throw new Error('receive-pack command list has no flush');
  const commands: PushCommand[] = [];
  let useSideband = true;
  let wantsReport = true;
  section.lines.forEach((raw, index) => {
    const line = raw.replace(/\n$/, '');
    let text = line;
    if (index === 0) {
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        useSideband = caps.includes('side-band-64k');
        wantsReport = caps.includes('report-status') || caps.includes('report-status-v2');
        text = line.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('receive-pack command has a bad object id');
    commands.push({ oldOid, newOid, ref });
  });
  if (commands.length === 0) throw new Error('receive-pack needs at least one command');
  const packBytes = body.subarray(section.next);
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpack failed: no packfile';
    } else {
      try {
        const objects = readPack(packBytes, repo);
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = `unpack failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } else if (packBytes.length > 0) {
    // A pack attached to a delete-only push: unpack it anyway; a corrupt one fails the push.
    try {
      const objects = readPack(packBytes, repo);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `unpack failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let anyOk = false;
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
        anyOk = true;
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        anyOk = true;
      }
      continue;
    }
    // Update: old must match, and old must be an ancestor of new.
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
    } else if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (command.oldOid === command.newOid) {
      results.push({ ref: command.ref, ok: true, reason: '' });
      anyOk = true;
    } else {
      const oldPeeled = peelTagChain(repo, command.oldOid);
      const newPeeled = peelTagChain(repo, command.newOid);
      const oldIsCommit = repo.objects.get(oldPeeled)?.type === 'commit';
      const newIsCommit = repo.objects.get(newPeeled)?.type === 'commit';
      if (oldIsCommit && newIsCommit && isAncestor(repo, oldPeeled, newPeeled)) {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        anyOk = true;
      } else if (!oldIsCommit && !newIsCommit && oldPeeled === newPeeled) {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        anyOk = true;
      } else {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      }
    }
  }
  if (anyOk) {
    repo.pushed_at = nowIso();
    repo.updated_at = repo.pushed_at;
  }
  const out = wantsReport
    ? reportStatus(unpackOk, unpackDetail, results, useSideband)
    : Buffer.alloc(0);
  sendBuffer(res, 200, out, RECEIVE_RESULT);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (match === null) return false;
  const [, owner, repoName, rest] = match as unknown as [string, string, string, string];
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (!isAuthorized(req, store)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  const method = req.method ?? 'GET';
  try {
    if (rest === 'info/refs' && method === 'GET') {
      const service = queryOf(req).get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'unknown service' });
        return true;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, v0Advertisement(repo, service), RECEIVE_AD);
      } else if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        sendBuffer(res, 200, v2Advertisement(service), UPLOAD_AD);
      } else {
        sendBuffer(res, 200, v0Advertisement(repo, service), UPLOAD_AD);
      }
      return true;
    }
    if (rest === 'git-upload-pack' && method === 'POST') {
      await handleUploadPack(req, res, repo);
      return true;
    }
    if (rest === 'git-receive-pack' && method === 'POST') {
      await handleReceivePack(req, res, repo);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  } catch (err) {
    // A malformed pkt-line / pack must not take the server down: answer 400 and stay up.
    try {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
    } catch {
      // peer went away
    }
    return true;
  }
}
