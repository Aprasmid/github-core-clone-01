// A GitHub-compatible git forge in a single file: git smart HTTP (protocol v0 + v2), the REST v3
// resources, GraphQL v4 and an MCP endpoint, all over one in-memory store. Node stdlib only.
//
// Determinism: nothing here reads the wall clock or a random source. Timestamps come from a logical
// counter seeded at a fixed epoch, ids from counters, and every map iteration that reaches a
// response is sorted first — so the same request sequence always produces the same bytes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ZERO_OID = '0'.repeat(40);
const BASE_EPOCH = 1_735_689_600; // 2025-01-01T00:00:00Z; every timestamp is this + a logical tick.
const AGENT = 'makefun-forge/1.0.0';

const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };

// --------------------------------------------------------------------------- state

interface GitObject {
  type: string; // commit | tree | blob | tag
  data: Buffer;
}

interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string;
}

interface CommentRec {
  id: number;
  body: string;
  tick: number;
}

interface IssueRec {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  isPR: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: CommentRec[];
  tick: number;
}

interface RepoRec {
  dbId: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  nextNumber: number;
  tick: number;
  gen: number; // bumped on any object/ref change; keys the fetch pack cache
}

const repos = new Map<string, RepoRec>(); // key: repo name (the owner is always the token owner)
const issueIndex = new Map<number, { repo: RepoRec; rec: IssueRec }>(); // dbId -> issue/PR, for node(id:)
let repoSeq = 0;
let issueSeq = 0;
let commentSeq = 0;
let labelSeq = 0;
let tickSeq = 0;
let requestSeq = 0;

/** The next deterministic timestamp tick. */
function nextTick(): number {
  tickSeq += 1;
  return tickSeq;
}
function isoOf(tick: number): string {
  return new Date((BASE_EPOCH + tick) * 1000).toISOString().replace('.000Z', 'Z');
}
function gitStamp(tick: number): string {
  return `${BASE_EPOCH + tick} +0000`;
}

// --------------------------------------------------------------------------- http helpers

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}` || header === `token ${TOKEN}`;
}

/** Every REST answer carries a request id, GitHub-style; a counter keeps it deterministic. */
function restJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  requestSeq += 1;
  sendJson(res, status, body, { 'x-github-request-id': `req-${requestSeq}`, ...headers });
}

function restError(res: ServerResponse, status: number, message: string): void {
  restJson(res, status, { message });
}

/** Parse a JSON request body; on failure answer 400 and return undefined. */
function jsonBody(res: ServerResponse, raw: Buffer): Record<string, unknown> | undefined {
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    restError(res, 400, 'Problems parsing JSON');
    return undefined;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function optStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function bool(value: unknown): boolean {
  return value === true;
}

/** GitHub-style global id: base64 of "Type:key", opaque but stable and round-trippable. */
function gid(type: string, key: number | string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}
function decodeGid(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { type: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

interface Page {
  perPage: number;
  page: number;
}
function pageOf(url: URL): Page {
  const per = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
  const page = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(per) && per > 0 ? Math.min(per, 100) : 30,
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}
function paginate<T>(items: T[], page: Page): T[] {
  const start = (page.page - 1) * page.perPage;
  return items.slice(start, start + page.perPage);
}

// --------------------------------------------------------------------------- git object core

function oidOf(type: string, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

function storeObject(repo: RepoRec, type: string, data: Buffer): string {
  const oid = oidOf(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    repo.gen += 1;
  }
  return oid;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

function buildCommitData(tree: string, parents: string[], message: string, tick: number): Buffer {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${gitStamp(tick)}`;
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${ident}\ncommitter ${ident}\n\n`;
  return Buffer.from(head + message, 'utf8');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: entries sort by name, directories as if the name ended in '/'. */
function treeSort(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function buildTreeData(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of treeSort(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface FileEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree into path -> blob (recursive; gitlinks are kept as opaque entries). */
function flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, FileEntry>()): Map<string, FileEntry> {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Rebuild nested trees from a flat path -> blob map; returns the root tree oid. */
function buildTreeFromFiles(repo: RepoRec, files: Map<string, FileEntry>): string {
  interface Node {
    dirs: Map<string, Node>;
    files: Map<string, FileEntry>;
  }
  const root: Node = { dirs: new Map(), files: new Map() };
  for (const path of [...files.keys()].sort()) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (next === undefined) {
        next = { dirs: new Map(), files: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], files.get(path)!);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: write(dir) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return write(root);
}

/** Peel an object to the commit it ultimately points at (through annotated tags), or null. */
function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match === null) return null;
      current = match[1];
      continue;
    }
    return null;
  }
  return null;
}

/** All commits reachable from the tips (inclusive), as oid -> generation distance (BFS, shortest). */
function commitDistances(repo: RepoRec, tips: string[], maxDepth = Number.POSITIVE_INFINITY): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(repo, tip);
    if (commit !== null && !dist.has(commit)) {
      dist.set(commit, 0);
      queue.push(commit);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = dist.get(current)!;
    if (depth >= maxDepth) continue;
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    const next = depth + 1;
    for (const parent of parseCommit(obj.data).parents) {
      if (!dist.has(parent)) {
        dist.set(parent, next);
        queue.push(parent);
      }
    }
  }
  return dist;
}

function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  // BFS from the descendant, stopping the moment the ancestor turns up (a fast-forward's old tip
  // is almost always the new tip's parent, so this is nearly free on the push path).
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** A merge base of two commits: the first commit on b's BFS that is also an ancestor of a. */
function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = commitDistances(repo, [a]);
  const seen = new Set<string>();
  const queue = [b];
  seen.add(b);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (ancestorsOfA.has(current)) return current;
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

/** Add a tree and everything under it to a set of object ids. */
function addTreeClosure(repo: RepoRec, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') addTreeClosure(repo, entry.oid, into);
    else into.add(entry.oid);
  }
}

// --------------------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };
const TYPE_NUMBERS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function writePack(objects: { oid: string; type: string; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of objects) {
    let size = obj.data.length;
    const first = ((TYPE_NUMBERS[obj.type] ?? 3) << 4) | (size & 0x0f);
    size >>= 4;
    const varint: number[] = [];
    let byte = first;
    while (size > 0) {
      varint.push(byte | 0x80);
      byte = size & 0x7f;
      size >>= 7;
    }
    varint.push(byte);
    parts.push(Buffer.from(varint));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git binary delta to a base buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[offset]; offset += 1; }
      if (op & 0x02) { copyOffset |= delta[offset] << 8; offset += 1; }
      if (op & 0x04) { copyOffset |= delta[offset] << 16; offset += 1; }
      if (op & 0x08) { copyOffset |= delta[offset] << 24; offset += 1; }
      if (op & 0x10) { copySize = delta[offset]; offset += 1; }
      if (op & 0x20) { copySize |= delta[offset] << 8; offset += 1; }
      if (op & 0x40) { copySize |= delta[offset] << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  type: string;
  data: Buffer;
  oid: string;
}

/**
 * Parse a pack, resolving deltas against `lookup` (objects already in the store) and the pack
 * itself. Returns the fully materialized objects.
 */
function parsePack(bytes: Buffer, lookup: (oid: string) => GitObject | undefined): PackEntry[] {
  if (bytes.length < 12 + 20 || bytes.toString('utf8', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = bytes.readUInt32BE(8);
  interface Raw {
    type: string;
    data: Buffer;
    baseOid?: string;
    baseIndex?: number;
  }
  const raw: Raw[] = [];
  const indexByOffset = new Map<number, number>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    indexByOffset.set(start, i);
    let byte = bytes[offset];
    offset += 1;
    const typeNumber = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = bytes[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = PACK_TYPES[typeNumber];
    if (type === undefined) throw new Error(`unknown pack type ${typeNumber}`);
    let baseOid: string | undefined;
    let baseIndex: number | undefined;
    if (type === 'ofs-delta') {
      let b = bytes[offset];
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = bytes[offset];
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseIndex = indexByOffset.get(start - back);
      if (baseIndex === undefined) throw new Error('ofs-delta base outside pack');
    } else if (type === 'ref-delta') {
      baseOid = bytes.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateSync(bytes.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    offset += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch');
    raw.push({ type, data: inflated.buffer, baseOid, baseIndex });
  }
  const resolved: (PackEntry | undefined)[] = new Array(raw.length).fill(undefined);
  const resolve = (index: number): PackEntry => {
    const memo = resolved[index];
    if (memo !== undefined) return memo;
    const entry = raw[index];
    let out: PackEntry;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: GitObject;
      if (entry.baseIndex !== undefined) {
        const resolvedBase = resolve(entry.baseIndex);
        base = { type: resolvedBase.type, data: resolvedBase.data };
      } else {
        const found = lookup(entry.baseOid!);
        if (found === undefined) throw new Error('ref-delta base missing');
        base = found;
      }
      const data = applyDelta(base.data, entry.data);
      out = { type: base.type, data, oid: oidOf(base.type, data) };
    } else {
      out = { type: entry.type, data: entry.data, oid: oidOf(entry.type, entry.data) };
    }
    resolved[index] = out;
    return out;
  };
  const entries: PackEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) entries.push(resolve(i));
  return entries;
}

// --------------------------------------------------------------------------- pkt-lines

function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface PktRead {
  lines: Buffer[];
  rest: Buffer;
}

/** Read pkt-lines until a flush packet; `rest` is whatever follows (a pack, usually). Throws on garbage. */
function readPktLines(bytes: Buffer): PktRead {
  const lines: Buffer[] = [];
  let offset = 0;
  for (;;) {
    if (offset === bytes.length) return { lines, rest: bytes.subarray(offset) }; // EOF ends the block too
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line');
    const head = bytes.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) throw new Error('malformed pkt-line');
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      return { lines, rest: bytes.subarray(offset) };
    }
    if (length === 1) {
      offset += 4;
      return { lines, rest: bytes.subarray(offset) };
    }
    if (length < 4 || offset + length > bytes.length) throw new Error('bad pkt-line length');
    lines.push(bytes.subarray(offset + 4, offset + length));
    offset += length;
  }
}

/** Split a pkt-line stream into a first block and a second block (separated by a delim packet). */
function splitPktBlocks(bytes: Buffer): { first: Buffer[]; second: Buffer[]; rest: Buffer } {
  let offset = 0;
  const readOne = (): { payload: Buffer; kind: 'line' | 'flush' | 'delim' } => {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line');
    const head = bytes.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) throw new Error('malformed pkt-line');
    const length = Number.parseInt(head, 16);
    if (length === 0) { offset += 4; return { payload: Buffer.alloc(0), kind: 'flush' }; }
    if (length === 1) { offset += 4; return { payload: Buffer.alloc(0), kind: 'delim' }; }
    if (length < 4 || offset + length > bytes.length) throw new Error('bad pkt-line length');
    const payload = bytes.subarray(offset + 4, offset + length);
    offset += length;
    return { payload, kind: 'line' };
  };
  const first: Buffer[] = [];
  const second: Buffer[] = [];
  let current = first;
  for (;;) {
    const item = readOne();
    if (item.kind === 'flush') break;
    if (item.kind === 'delim') {
      current = second;
      continue;
    }
    current.push(item.payload);
  }
  return { first, second, rest: bytes.subarray(offset) };
}

function lineText(line: Buffer): string {
  const text = line.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

// --------------------------------------------------------------------------- store operations

function findRepo(owner: string, name: string): RepoRec | undefined {
  if (owner !== VIEWER.login) return undefined;
  return repos.get(name);
}

function createRepoRec(name: string, description: string, isPrivate: boolean): RepoRec {
  repoSeq += 1;
  const repo: RepoRec = {
    dbId: 100_000 + repoSeq,
    name,
    owner: VIEWER.login,
    isPrivate,
    description,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    nextNumber: 1,
    tick: nextTick(),
    gen: 0,
  };
  repos.set(name, repo);
  return repo;
}

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: gid('Repository', repo.dbId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.tick),
    updated_at: isoOf(repo.tick),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    has_issues: true,
  };
}

function labelJson(label: LabelRec): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

function issueJson(repo: RepoRec, rec: IssueRec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: rec.dbId,
    node_id: gid(rec.isPR ? 'PullRequest' : 'Issue', rec.dbId),
    number: rec.number,
    title: rec.title,
    body: rec.body,
    state: rec.state,
    labels: rec.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { id: 0, name, color: 'ededed', description: '' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: rec.comments.length,
    created_at: isoOf(rec.tick),
    updated_at: isoOf(rec.tick),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${rec.number}`,
  };
  if (rec.isPR) out.pull_request = { url: `https://forge.invalid/repos/${repo.owner}/${repo.name}/pulls/${rec.number}` };
  return out;
}

function headShaOf(repo: RepoRec, rec: IssueRec): string {
  return repo.refs.get(`refs/heads/${rec.headRef}`) ?? rec.headSha;
}
function baseShaOf(repo: RepoRec, rec: IssueRec): string {
  return repo.refs.get(`refs/heads/${rec.baseRef}`) ?? rec.baseSha;
}

function pullJson(repo: RepoRec, rec: IssueRec): Record<string, unknown> {
  return {
    id: rec.dbId,
    node_id: gid('PullRequest', rec.dbId),
    number: rec.number,
    state: rec.state,
    title: rec.title,
    body: rec.body,
    head: { ref: rec.headRef, sha: headShaOf(repo, rec), label: `${repo.owner}:${rec.headRef}` },
    base: { ref: rec.baseRef, sha: baseShaOf(repo, rec), label: `${repo.owner}:${rec.baseRef}` },
    merged: rec.merged,
    merged_at: rec.mergedAt,
    merge_commit_sha: rec.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoOf(rec.tick),
    updated_at: isoOf(rec.tick),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${rec.number}`,
  };
}

function commentJson(rec: CommentRec): Record<string, unknown> {
  return {
    id: rec.id,
    body: rec.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoOf(rec.tick),
    updated_at: isoOf(rec.tick),
  };
}

function newIssueRec(repo: RepoRec, init: Partial<IssueRec> & { title: string }): IssueRec {
  issueSeq += 1;
  const rec: IssueRec = {
    dbId: 200_000 + issueSeq,
    number: repo.nextNumber,
    title: init.title,
    body: init.body ?? '',
    state: 'open',
    labels: init.labels ?? [],
    isPR: init.isPR ?? false,
    headRef: init.headRef ?? '',
    baseRef: init.baseRef ?? '',
    headSha: init.headSha ?? '',
    baseSha: init.baseSha ?? '',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
    tick: nextTick(),
  };
  repo.nextNumber += 1;
  repo.issues.set(rec.number, rec);
  issueIndex.set(rec.dbId, { repo, rec });
  return rec;
}

/** Resolve a ref-ish string (branch name, full ref, tag name, or commit oid) to a commit oid. */
function resolveCommit(repo: RepoRec, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return tip === undefined ? null : peelToCommit(repo, tip);
  }
  const candidates = [
    repo.refs.get(ref),
    repo.refs.get(`refs/heads/${ref}`),
    repo.refs.get(`refs/tags/${ref}`),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) return peelToCommit(repo, candidate);
  }
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return peelToCommit(repo, ref);
  return null;
}

/** Commit a set of file changes (path -> content, or null to delete) on a branch. Returns the commit oid. */
function commitFiles(repo: RepoRec, branch: string, changes: Map<string, Buffer | null>, message: string): string {
  const branchRef = `refs/heads/${branch}`;
  let startTip = repo.refs.get(branchRef);
  if (startTip === undefined && branch !== repo.defaultBranch) {
    startTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  let files = new Map<string, FileEntry>();
  if (startTip !== undefined) {
    const commit = repo.objects.get(startTip);
    if (commit !== undefined && commit.type === 'commit') files = flattenTree(repo, parseCommit(commit.data).tree);
  }
  for (const [path, content] of changes) {
    if (content === null) files.delete(path);
    else files.set(path, { oid: storeObject(repo, 'blob', content), mode: '100644' });
  }
  const tree = buildTreeFromFiles(repo, files);
  const tick = nextTick();
  const parents = startTip === undefined ? [] : [startTip];
  const commitOid = storeObject(repo, 'commit', buildCommitData(tree, parents, message, tick));
  repo.refs.set(branchRef, commitOid);
  return commitOid;
}

interface MergeOutcome {
  conflicts: string[];
  mergedFiles: Map<string, FileEntry> | null;
  base: string | null;
}

/** Three-way tree merge of head into base; reports conflicting paths instead of guessing. */
function computeMerge(repo: RepoRec, baseTip: string, headTip: string): MergeOutcome {
  const base = mergeBase(repo, baseTip, headTip);
  const baseFiles = base === null ? new Map<string, FileEntry>() : flattenTree(repo, parseCommit(repo.objects.get(base)!.data).tree);
  const oursFiles = flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const theirsFiles = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const paths = new Set<string>([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  const merged = new Map<string, FileEntry>();
  const conflicts: string[] = [];
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path)?.oid;
    const o = oursFiles.get(path)?.oid;
    const t = theirsFiles.get(path)?.oid;
    if (o === t) {
      const keep = oursFiles.get(path) ?? theirsFiles.get(path);
      if (keep !== undefined) merged.set(path, keep);
    } else if (b === o) {
      const keep = theirsFiles.get(path);
      if (keep !== undefined) merged.set(path, keep);
    } else if (b === t) {
      const keep = oursFiles.get(path);
      if (keep !== undefined) merged.set(path, keep);
    } else {
      conflicts.push(path);
    }
  }
  return { conflicts, mergedFiles: conflicts.length === 0 ? merged : null, base };
}

/** Merge a pull request into its base branch. Returns the merge commit oid, or null on conflict. */
function mergePullRequest(repo: RepoRec, rec: IssueRec, method: string): string | null {
  const baseTip = repo.refs.get(`refs/heads/${rec.baseRef}`) ?? rec.baseSha;
  const headTip = repo.refs.get(`refs/heads/${rec.headRef}`) ?? rec.headSha;
  const outcome = computeMerge(repo, baseTip, headTip);
  if (outcome.mergedFiles === null) return null;
  const tree = buildTreeFromFiles(repo, outcome.mergedFiles);
  const tick = nextTick();
  let parents: string[];
  let message: string;
  if (method === 'merge') {
    parents = [baseTip, headTip];
    message = `Merge pull request #${rec.number} from ${rec.headRef}\n`;
  } else {
    parents = [baseTip];
    message = `${rec.title} (#${rec.number})\n`;
  }
  const sha = storeObject(repo, 'commit', buildCommitData(tree, parents, message, tick));
  repo.refs.set(`refs/heads/${rec.baseRef}`, sha);
  rec.state = 'closed';
  rec.merged = true;
  rec.mergedAt = isoOf(tick);
  rec.mergeCommitSha = sha;
  rec.tick = tick;
  return sha;
}

/** Whether an open pull request would merge cleanly right now. */
function pullMergeable(repo: RepoRec, rec: IssueRec): boolean {
  if (rec.merged || rec.state !== 'open') return false;
  const baseTip = repo.refs.get(`refs/heads/${rec.baseRef}`) ?? rec.baseSha;
  const headTip = repo.refs.get(`refs/heads/${rec.headRef}`) ?? rec.headSha;
  if (baseTip === '' || headTip === '') return false;
  return computeMerge(repo, baseTip, headTip).conflicts.length === 0;
}

interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
}

function countLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-diff counts via a small LCS; big files fall back to whole-file counts. */
function diffCounts(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const a = countLines(oldData);
  const b = countLines(newData);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const keep = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = keep;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

/** The changed files of a pull request: merge-base tree versus head tree. */
function pullFiles(repo: RepoRec, rec: IssueRec): FileDiff[] {
  const baseTip = baseShaOf(repo, rec);
  const headTip = headShaOf(repo, rec);
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const baseFiles = flattenTree(repo, parseCommit(repo.objects.get(base)!.data).tree);
  const headFiles = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before?.oid === after?.oid) continue;
    if (before === undefined && after !== undefined) {
      const lines = countLines(repo.objects.get(after.oid)?.data ?? Buffer.alloc(0)).length;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines, sha: after.oid });
    } else if (after === undefined && before !== undefined) {
      const lines = countLines(repo.objects.get(before.oid)?.data ?? Buffer.alloc(0)).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines, sha: null });
    } else if (before !== undefined && after !== undefined) {
      const counts = diffCounts(repo.objects.get(before.oid)?.data ?? Buffer.alloc(0), repo.objects.get(after.oid)?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions, sha: after.oid });
    }
  }
  return out;
}

// --------------------------------------------------------------------------- fetch selection

interface FetchSelection {
  objects: { oid: string; type: string; data: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Choose the objects a fetch delivers: reachable from the wants, minus what the haves prove the
 * client holds (a shallow boundary cuts the parent walk), cut again by the requested depth.
 * `depth` is absolute (generations from the wants) unless `deepenRelative` is set, in which case
 * it counts generations below the client's current shallow boundary commits.
 */
function selectFetch(repo: RepoRec, wants: string[], haves: string[], clientShallow: Set<string>, depth: number | null, deepenRelative = false): FetchSelection {
  // What the client already holds: full closure of the haves, with parents cut at shallow commits.
  const held = new Set<string>();
  const heldCommits = new Set<string>();
  const addClosure = (oid: string, cutParents: boolean): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || held.has(oid)) return;
    held.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) addClosure(entry.oid, false);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match !== null) addClosure(match[1], false);
    } else if (obj.type === 'commit') {
      heldCommits.add(oid);
      const info = parseCommit(obj.data);
      addClosure(info.tree, false);
      if (!cutParents) for (const parent of info.parents) addClosure(parent, clientShallow.has(parent));
    }
  };
  for (const have of haves) addClosure(have, clientShallow.has(have));

  // Generations from the wants (commits only), then the delivery set. A depth cut caps the walk:
  // nothing beyond the boundary generation can be delivered or reported.
  const dist = commitDistances(repo, wants, depth === null || deepenRelative ? Number.POSITIVE_INFINITY : depth - 1);

  // For a relative deepen: generations below each client shallow commit (0 = the boundary itself).
  // Commits deeper than `depth` below every boundary are cut; the boundary moves down by `depth`.
  const belowDepth = new Map<string, number>();
  if (deepenRelative && depth !== null) {
    const queue: string[] = [];
    for (const seed of clientShallow) {
      const commit = peelToCommit(repo, seed);
      if (commit !== null && !belowDepth.has(commit)) {
        belowDepth.set(commit, 0);
        queue.push(commit);
      }
    }
    while (queue.length > 0) {
      const current = queue.shift()!;
      const generation = belowDepth.get(current)!;
      if (generation > depth) continue;
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!belowDepth.has(parent)) {
          belowDepth.set(parent, generation + 1);
          queue.push(parent);
        }
      }
    }
  }
  const cutByDepth = (commit: string): boolean => {
    if (depth === null) return false;
    if (deepenRelative) {
      const below = belowDepth.get(commit);
      return below !== undefined && below > depth;
    }
    const generation = dist.get(commit);
    return generation === undefined || generation > depth - 1;
  };
  const deliver = new Map<string, GitObject>();
  const deliverObj = (oid: string): void => {
    if (held.has(oid) || deliver.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    deliver.set(oid, obj);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) deliverObj(entry.oid);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match !== null) deliverObj(match[1]);
    }
  };
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj !== undefined && obj.type !== 'commit') deliverObj(want);
  }
  const deliveredCommits = new Set<string>();
  const deliverCommit = (commit: string): void => {
    if (held.has(commit) || deliveredCommits.has(commit)) return;
    const obj = repo.objects.get(commit);
    if (obj === undefined) return;
    deliver.set(commit, obj);
    deliveredCommits.add(commit);
    const treeSet = new Set<string>();
    addTreeClosure(repo, parseCommit(obj.data).tree, treeSet);
    for (const oid of treeSet) {
      if (!held.has(oid) && !deliver.has(oid)) {
        const treeObj = repo.objects.get(oid);
        if (treeObj !== undefined) deliver.set(oid, treeObj);
      }
    }
  };
  for (const commit of dist.keys()) {
    if (cutByDepth(commit)) continue;
    deliverCommit(commit);
  }
  if (deepenRelative && depth !== null) {
    // Boundary commits on branches the wants do not touch still deepen.
    for (const [commit, below] of belowDepth) {
      if (below >= 1 && below <= depth) deliverCommit(commit);
    }
  }

  // Shallow bookkeeping: boundary = held-after commits at the depth cut with a parent left behind.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    const heldAfter = new Set<string>([...heldCommits, ...deliveredCommits]);
    for (const commit of heldAfter) {
      const atCut = deepenRelative ? belowDepth.get(commit) === depth : dist.get(commit) === depth - 1;
      if (!atCut) continue;
      const obj = repo.objects.get(commit);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((parent) => repo.objects.has(parent) && !heldAfter.has(parent))) shallow.push(commit);
    }
    for (const commit of clientShallow) {
      if (!heldAfter.has(commit) || shallow.includes(commit)) continue;
      const obj = repo.objects.get(commit);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length > 0 && parents.every((parent) => heldAfter.has(parent))) unshallow.push(commit);
    }
  }
  shallow.sort();
  unshallow.sort();
  const objects = [...deliver.entries()].map(([oid, obj]) => ({ oid, type: obj.type, data: obj.data }));
  objects.sort((a, b) => (a.oid < b.oid ? -1 : 1));
  return { objects, shallow, unshallow };
}

// --------------------------------------------------------------------------- REST v3

function sortedIssues(repo: RepoRec, onlyPR: boolean | null): IssueRec[] {
  const all = [...repo.issues.values()].filter((rec) => onlyPR === null || rec.isPR === onlyPR);
  all.sort((a, b) => a.number - b.number);
  return all;
}

function labelNamesOf(repo: RepoRec, raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : optStr((entry as Record<string, unknown>)?.name);
    if (name === undefined || !repo.labels.has(name)) return null;
    names.push(name);
  }
  return names;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname.replace(/^\/api\/v3/, '') || '/';
  const seg = path.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));

  if (method === 'GET' && path === '/') {
    restJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/meta') {
    restJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }
  if (method === 'GET' && path === '/user') {
    restJson(res, 200, userJson());
    return;
  }
  if (method === 'GET' && path === '/rate_limit') {
    restJson(res, 200, { rate: { limit: 5000, remaining: 4999, reset: BASE_EPOCH + 3600 } });
    return;
  }

  if (path === '/user/repos') {
    if (method === 'POST') {
      const body = jsonBody(res, raw);
      if (body === undefined) return;
      const name = str(body.name);
      if (name === '') {
        restJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'missing_field', field: 'name' }] });
        return;
      }
      if (repos.has(name)) {
        restJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return;
      }
      const repo = createRepoRec(name, str(body.description), bool(body.private));
      restJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const page = pageOf(url);
      const all = [...repos.values()].sort((a, b) => a.dbId - b.dbId);
      const slice = paginate(all, page);
      const headers: Record<string, string> = {};
      if (page.page * page.perPage < all.length) {
        const host = req.headers.host ?? 'forge.invalid';
        headers.link = `<http://${host}/api/v3/user/repos?per_page=${page.perPage}&page=${page.page + 1}>; rel="next", <http://${host}/api/v3/user/repos?per_page=${page.perPage}&page=${Math.ceil(all.length / page.perPage)}>; rel="last"`;
      }
      restJson(res, 200, slice.map(repoJson), headers);
      return;
    }
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = findRepo(seg[1], seg[2]);
    if (repo === undefined) {
      restError(res, 404, 'Not Found');
      return;
    }
    const rest3 = seg.slice(3);
    await handleRepoRest(req, res, url, raw, repo, rest3);
    return;
  }

  restError(res, 404, 'Not Found');
}

async function handleRepoRest(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, repo: RepoRec, seg: string[]): Promise<void> {
  const method = req.method ?? 'GET';

  if (seg.length === 0) {
    if (method === 'GET') {
      restJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = jsonBody(res, raw);
      if (body === undefined) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        if (repos.has(body.name)) {
          restError(res, 422, 'name already exists on this account');
          return;
        }
        repos.delete(repo.name);
        repo.name = body.name;
        repos.set(repo.name, repo);
      }
      repo.tick = nextTick();
      restJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repo.name);
      res.writeHead(204, { 'x-github-request-id': `req-${++requestSeq}` });
      res.end();
      return;
    }
    restError(res, 404, 'Not Found');
    return;
  }

  if (seg[0] === 'branches') {
    if (seg.length === 1 && method === 'GET') {
      const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice(11)).sort();
      restJson(res, 200, names.map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! }, protected: false })));
      return;
    }
    if (seg.length >= 2 && method === 'GET') {
      const branch = seg.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        restError(res, 404, 'Branch not found');
        return;
      }
      restJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
  }

  if (seg[0] === 'git' && seg[1] === 'refs') {
    if (seg.length === 2 && method === 'POST') {
      const body = jsonBody(res, raw);
      if (body === undefined) return;
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
        restJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', code: 'custom', message: 'sha is not a valid object' }] });
        return;
      }
      if (repo.refs.has(ref)) {
        restJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      repo.refs.set(ref, sha);
      repo.gen += 1;
      restJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
      return;
    }
    if (seg.length >= 4 && seg[2] === 'heads' && method === 'GET') {
      const branch = seg.slice(3).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        restError(res, 404, 'Reference not found');
        return;
      }
      restJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
      return;
    }
  }

  if (seg[0] === 'commits' && seg.length === 1 && method === 'GET') {
    const page = pageOf(url);
    const start = resolveCommit(repo, url.searchParams.get('sha') ?? undefined);
    if (start === null) {
      restJson(res, 200, []);
      return;
    }
    const order: string[] = [];
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'commit') continue;
      order.push(current);
      const parents = parseCommit(obj.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
    }
    const items = paginate(order, page).map((sha) => {
      const info = parseCommit(repo.objects.get(sha)!.data);
      const person = (line: string): Record<string, unknown> => {
        const match = /^(.*) <(.*)> (\d+) /.exec(line);
        return {
          name: match?.[1] ?? VIEWER.name,
          email: match?.[2] ?? VIEWER.email,
          date: new Date(Number(match?.[3] ?? BASE_EPOCH) * 1000).toISOString().replace('.000Z', 'Z'),
        };
      };
      return {
        sha,
        commit: { message: info.message, author: person(info.author), committer: person(info.committer), tree: { sha: info.tree } },
        parents: info.parents.map((parent) => ({ sha: parent })),
      };
    });
    restJson(res, 200, items);
    return;
  }

  if (seg[0] === 'contents') {
    await handleContents(req, res, url, raw, repo, seg.slice(1).join('/'));
    return;
  }

  if (seg[0] === 'labels') {
    if (seg.length === 1 && method === 'POST') {
      const body = jsonBody(res, raw);
      if (body === undefined) return;
      const name = str(body.name);
      if (name === '') {
        restJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'missing_field', field: 'name' }] });
        return;
      }
      if (repo.labels.has(name)) {
        restJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
        return;
      }
      labelSeq += 1;
      const label: LabelRec = { id: 400_000 + labelSeq, name, color: str(body.color) || 'ededed', description: str(body.description) };
      repo.labels.set(name, label);
      restJson(res, 201, labelJson(label));
      return;
    }
    if (seg.length === 1 && method === 'GET') {
      const labels = [...repo.labels.values()].sort((a, b) => a.id - b.id);
      restJson(res, 200, paginate(labels, pageOf(url)).map(labelJson));
      return;
    }
  }

  if (seg[0] === 'issues') {
    await handleIssues(req, res, url, raw, repo, seg.slice(1));
    return;
  }

  if (seg[0] === 'pulls') {
    await handlePulls(req, res, url, raw, repo, seg.slice(1));
    return;
  }

  restError(res, 404, 'Not Found');
}

async function handleContents(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, repo: RepoRec, path: string): Promise<void> {
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const commit = resolveCommit(repo, url.searchParams.get('ref') ?? undefined);
    if (commit === null) {
      restError(res, 404, 'Not Found');
      return;
    }
    const tree = parseCommit(repo.objects.get(commit)!.data).tree;
    if (path === '') {
      const entries = parseTree(repo.objects.get(tree)?.data ?? Buffer.alloc(0));
      restJson(res, 200, entries.map((entry) => contentsEntry(repo, entry, entry.name)));
      return;
    }
    const parts = path.split('/');
    let currentTree = tree;
    for (let i = 0; i < parts.length; i += 1) {
      const treeObj = repo.objects.get(currentTree);
      if (treeObj === undefined || treeObj.type !== 'tree') {
        restError(res, 404, 'Not Found');
        return;
      }
      const entry = parseTree(treeObj.data).find((candidate) => candidate.name === parts[i]);
      if (entry === undefined) {
        restError(res, 404, 'Not Found');
        return;
      }
      if (i === parts.length - 1) {
        if (entry.mode === '40000') {
          const sub = parseTree(repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0));
          restJson(res, 200, sub.map((child) => contentsEntry(repo, child, `${path}/${child.name}`)));
          return;
        }
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined) {
          restError(res, 404, 'Not Found');
          return;
        }
        restJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          name: entry.name,
          path,
          sha: entry.oid,
          size: blob.data.length,
        });
        return;
      }
      if (entry.mode !== '40000') {
        restError(res, 404, 'Not Found');
        return;
      }
      currentTree = entry.oid;
    }
    restError(res, 404, 'Not Found');
    return;
  }

  if (method === 'PUT') {
    const body = jsonBody(res, raw);
    if (body === undefined) return;
    const branch = optStr(body.branch) ?? url.searchParams.get('ref') ?? repo.defaultBranch;
    const content = Buffer.from(str(body.content).replace(/\s+/g, ''), 'base64');
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    let existing: FileEntry | undefined;
    if (tip !== undefined) {
      const files = flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
      existing = files.get(path);
    }
    if (existing !== undefined && typeof body.sha === 'string' && body.sha !== existing.oid) {
      restJson(res, 409, { message: `${path} does not match ${body.sha}` });
      return;
    }
    const sha = commitFiles(repo, branch, new Map([[path, content]]), str(body.message));
    const blobOid = oidOf('blob', content);
    restJson(res, existing !== undefined ? 200 : 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = jsonBody(res, raw);
    if (body === undefined) return;
    const branch = optStr(body.branch) ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) {
      restError(res, 404, 'Not Found');
      return;
    }
    const files = flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
    const existing = files.get(path);
    if (existing === undefined) {
      restError(res, 404, 'Not Found');
      return;
    }
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      restJson(res, 409, { message: `${path} does not match ${body.sha}` });
      return;
    }
    const sha = commitFiles(repo, branch, new Map([[path, null]]), str(body.message));
    restJson(res, 200, { content: null, commit: { sha } });
    return;
  }

  restError(res, 404, 'Not Found');
}

function contentsEntry(repo: RepoRec, entry: TreeEntry, path: string): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  const blob = isDir ? undefined : repo.objects.get(entry.oid);
  return {
    name: entry.name,
    path,
    sha: entry.oid,
    size: blob?.data.length ?? 0,
    type: isDir ? 'dir' : 'file',
  };
}

async function handleIssues(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, repo: RepoRec, seg: string[]): Promise<void> {
  const method = req.method ?? 'GET';

  if (seg.length === 0) {
    if (method === 'POST') {
      const body = jsonBody(res, raw);
      if (body === undefined) return;
      const title = str(body.title);
      if (title === '') {
        restJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'missing_field', field: 'title' }] });
        return;
      }
      let labels: string[] = [];
      if (body.labels !== undefined) {
        const parsed = labelNamesOf(repo, body.labels);
        if (parsed === null) {
          restJson(res, 422, { message: 'Validation Failed: one or more labels do not exist in this repository' });
          return;
        }
        labels = parsed;
      }
      const rec = newIssueRec(repo, { title, body: str(body.body), labels });
      restJson(res, 201, issueJson(repo, rec));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let items = sortedIssues(repo, false);
      if (state === 'open' || state === 'closed') items = items.filter((rec) => rec.state === state);
      if (direction === 'desc') items.reverse();
      restJson(res, 200, paginate(items, pageOf(url)).map((rec) => issueJson(repo, rec)));
      return;
    }
  }

  if (seg.length >= 1) {
    const number = Number.parseInt(seg[0], 10);
    const rec = Number.isFinite(number) ? repo.issues.get(number) : undefined;
    if (rec === undefined) {
      restError(res, 404, 'Not Found');
      return;
    }
    if (seg.length === 1) {
      if (method === 'GET') {
        restJson(res, 200, issueJson(repo, rec));
        return;
      }
      if (method === 'PATCH') {
        if (rec.isPR) {
          restError(res, 404, 'Not Found');
          return;
        }
        const body = jsonBody(res, raw);
        if (body === undefined) return;
        if (typeof body.title === 'string') rec.title = body.title;
        if (typeof body.body === 'string') rec.body = body.body;
        if (body.state === 'open' || body.state === 'closed') rec.state = body.state;
        if (body.labels !== undefined) {
          const parsed = labelNamesOf(repo, body.labels);
          if (parsed === null) {
            restJson(res, 422, { message: 'Validation Failed: one or more labels do not exist in this repository' });
            return;
          }
          rec.labels = parsed;
        }
        rec.tick = nextTick();
        restJson(res, 200, issueJson(repo, rec));
        return;
      }
    }
    if (seg.length === 2 && seg[1] === 'comments') {
      if (rec.isPR) {
        // Pull requests accept issue comments on GitHub too; the suite only comments on issues.
      }
      if (method === 'POST') {
        const body = jsonBody(res, raw);
        if (body === undefined) return;
        commentSeq += 1;
        const comment: CommentRec = { id: 300_000 + commentSeq, body: str(body.body), tick: nextTick() };
        rec.comments.push(comment);
        restJson(res, 201, commentJson(comment));
        return;
      }
      if (method === 'GET') {
        const comments = [...rec.comments].sort((a, b) => a.id - b.id);
        restJson(res, 200, paginate(comments, pageOf(url)).map(commentJson));
        return;
      }
    }
  }

  restError(res, 404, 'Not Found');
}

async function handlePulls(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, repo: RepoRec, seg: string[]): Promise<void> {
  const method = req.method ?? 'GET';

  if (seg.length === 0) {
    if (method === 'POST') {
      const body = jsonBody(res, raw);
      if (body === undefined) return;
      const title = str(body.title);
      const head = str(body.head).split(':').pop() ?? '';
      const base = str(body.base).split(':').pop() ?? '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (title === '' || head === '' || base === '') {
        restJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'missing_field' }] });
        return;
      }
      if (headSha === undefined) {
        restJson(res, 422, { message: `Validation Failed: head ref ${head} does not exist` });
        return;
      }
      if (baseSha === undefined) {
        restJson(res, 422, { message: `Validation Failed: base ref ${base} does not exist` });
        return;
      }
      if (head === base || headSha === baseSha) {
        restJson(res, 422, { message: `Validation Failed: no commits between ${base} and ${head}` });
        return;
      }
      const duplicate = sortedIssues(repo, true).find((rec) => rec.state === 'open' && rec.headRef === head && rec.baseRef === base);
      if (duplicate !== undefined) {
        restJson(res, 422, { message: `A pull request already exists for ${head} into ${base}` });
        return;
      }
      const rec = newIssueRec(repo, { title, body: str(body.body), isPR: true, headRef: head, baseRef: base, headSha, baseSha });
      restJson(res, 201, pullJson(repo, rec));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let items = sortedIssues(repo, true);
      if (state === 'open' || state === 'closed') items = items.filter((rec) => rec.state === state);
      restJson(res, 200, paginate(items, pageOf(url)).map((rec) => pullJson(repo, rec)));
      return;
    }
  }

  if (seg.length >= 1) {
    const number = Number.parseInt(seg[0], 10);
    const rec = Number.isFinite(number) ? repo.issues.get(number) : undefined;
    if (rec === undefined || !rec.isPR) {
      restError(res, 404, 'Not Found');
      return;
    }
    if (seg.length === 1 && method === 'GET') {
      restJson(res, 200, pullJson(repo, rec));
      return;
    }
    if (seg.length === 2 && seg[1] === 'files' && method === 'GET') {
      const files = pullFiles(repo, rec).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        sha: file.sha,
      }));
      restJson(res, 200, paginate(files, pageOf(url)));
      return;
    }
    if (seg.length === 2 && seg[1] === 'merge' && method === 'PUT') {
      const body = jsonBody(res, raw);
      if (body === undefined) return;
      if (rec.state !== 'open') {
        restJson(res, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest/pulls/pulls#merge-a-pull-request' });
        return;
      }
      const method2 = optStr(body.merge_method) ?? 'merge';
      const sha = mergePullRequest(repo, rec, method2 === 'rebase' ? 'squash' : method2);
      if (sha === null) {
        restJson(res, 405, { message: 'Pull Request is not mergeable' });
        return;
      }
      restJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
  }

  restError(res, 404, 'Not Found');
}

// --------------------------------------------------------------------------- git smart HTTP

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not allow-tip-sha1-in-want allow-reachable-sha1-in-want object-format=sha1';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta atomic quiet object-format=sha1';

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Sorted ref lines for an advertisement, with peeled lines after annotated tags. */
function advertisementRefs(repo: RepoRec): { name: string; oid: string; peeled?: string }[] {
  const out: { name: string; oid: string; peeled?: string }[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function handleInfoRefs(res: ServerResponse, repo: RepoRec, url: URL, req: IncomingMessage): void {
  const service = url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendBuffer(res, 403, Buffer.from('only smart HTTP is supported\n'), 'text/plain');
    return;
  }
  const protocol = req.headers['git-protocol'] ?? '';
  const wantsV2 = service === 'git-upload-pack' && /(^|:)version=2/.test(protocol);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (wantsV2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow wait-for-done\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
    return;
  }
  const refs = advertisementRefs(repo);
  const headOid = repo.refs.get(headTarget(repo));
  const caps = service === 'git-upload-pack'
    ? `${UPLOAD_CAPS_V0} symref=HEAD:${headTarget(repo)} agent=${AGENT}`
    : `${RECEIVE_CAPS} agent=${AGENT}`;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

function handleLsRefs(res: ServerResponse, repo: RepoRec, raw: Buffer): void {
  const { second } = splitPktBlocks(raw);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of second) {
    const text = lineText(line);
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice(11));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(headTarget(repo));
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    }
  }
  for (const ref of advertisementRefs(repo)) {
    if (!matches(ref.name)) continue;
    let text = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) text += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${text}\n`));
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: Set<string>;
  depth: number | null;
  deepenRelative: boolean;
  done: boolean;
}

function parseFetchArgs(lines: Buffer[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: new Set(), depth: null, deepenRelative: false, done: false };
  for (const line of lines) {
    const text = lineText(line);
    const space = text.indexOf(' ');
    const key = space === -1 ? text : text.slice(0, space);
    const value = space === -1 ? '' : text.slice(space + 1).trim();
    if (key === 'want') args.wants.push(value.split(' ')[0]);
    else if (key === 'have') args.haves.push(value.split(' ')[0]);
    else if (key === 'shallow') args.shallow.add(value.split(' ')[0]);
    else if (key === 'deepen' || key === 'depth') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) args.depth = parsed;
    } else if (key === 'deepen-relative') args.deepenRelative = true;
    else if (key === 'done') args.done = true;
  }
  return args;
}

/** Chunk a pack into sideband packets (band 1 = data). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515; // 1 band byte + chunk + 4 header bytes must stay within the 65520 pkt-line max
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  return out;
}

interface BuiltFetch {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

/** Built packs are cached per repo generation: the clone workload asks for the same pack 50 times. */
const packCache = new Map<string, BuiltFetch>();

function buildFetch(repo: RepoRec, args: FetchArgs): BuiltFetch {
  const key = `${repo.dbId}:${repo.gen}:${args.wants.join(',')}|${args.haves.join(',')}|${[...args.shallow].sort().join(',')}|${args.depth ?? ''}|${args.deepenRelative ? 'rel' : 'abs'}`;
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const selection = selectFetch(repo, args.wants, args.haves, args.shallow, args.depth, args.deepenRelative);
  const built: BuiltFetch = { pack: writePack(selection.objects), shallow: selection.shallow, unshallow: selection.unshallow };
  if (packCache.size > 128) packCache.clear();
  packCache.set(key, built);
  return built;
}

function handleFetchV2(res: ServerResponse, repo: RepoRec, raw: Buffer): void {
  const { second } = splitPktBlocks(raw);
  const args = parseFetchArgs(second);
  const parts: Buffer[] = [];
  if (!args.done) {
    // Negotiation round: acknowledge the common haves only; no packfile may follow yet.
    const common = args.haves.filter((have) => repo.objects.has(have));
    parts.push(pktLine('acknowledgments\n'));
    if (common.length > 0) for (const have of common) parts.push(pktLine(`ACK ${have}\n`));
    else parts.push(pktLine('NAK\n'));
    parts.push(PKT_FLUSH); // no delim: a delim would promise another section, which is illegal here
    sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  // Final round: shallow-info (when a depth cut is in play), then the packfile. No acknowledgments
  // section here — a client that said "done" is waiting for the pack.
  const built = buildFetch(repo, args);
  const pack = built.pack;
  const selection = built;
  if (args.depth !== null || selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(res: ServerResponse, repo: RepoRec, raw: Buffer): void {
  // v0: want lines (the first carries capabilities) up to a flush, then have lines, then "done".
  const first = readPktLines(raw);
  const wants: string[] = [];
  const shallow = new Set<string>();
  let depth: number | null = null;
  let deepenRelative = false;
  let caps = '';
  for (const line of first.lines) {
    const text = lineText(line);
    if (text.startsWith('want ')) {
      const rest = text.slice(5);
      const nul = rest.indexOf('\0');
      const head = nul === -1 ? rest : rest.slice(0, nul);
      const fields = head.trim().split(/\s+/);
      wants.push(fields[0]);
      // v0 want-line capabilities ride after the oid, space-separated (or after a NUL).
      const capText = nul === -1 ? fields.slice(1).join(' ') : rest.slice(nul + 1);
      if (capText !== '' && caps === '') caps = capText;
    } else if (text.startsWith('shallow ')) shallow.add(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const parsed = Number.parseInt(text.slice(7), 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    } else if (text === 'deepen-relative') deepenRelative = true;
  }
  const haves: string[] = [];
  let sawDone = false;
  let rest = first.rest;
  // Have lines arrive as their own pkt-lines terminated by a flush, with "done" among them.
  try {
    const second = readPktLines(rest);
    for (const line of second.lines) {
      const text = lineText(line);
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text === 'done') sawDone = true;
    }
    rest = second.rest;
  } catch {
    // No have block: a plain "done" line may follow instead.
    const text = rest.toString('utf8');
    for (const match of text.matchAll(/have ([0-9a-f]{40})/g)) haves.push(match[1]);
    if (/\bdone\b/.test(text)) sawDone = true;
  }
  const built = buildFetch(repo, { wants, haves, shallow, depth, deepenRelative, done: true });
  const selection = built;
  const pack = built.pack;
  const parts: Buffer[] = [];
  const common = haves.filter((have) => repo.objects.has(have));
  const ackLine = (): Buffer => {
    if (common.length === 0) return pktLine('NAK\n');
    return pktLine(caps.includes('multi_ack_detailed') ? `ACK ${common[common.length - 1]} ready\n` : `ACK ${common[common.length - 1]}\n`);
  };
  if (depth !== null) {
    // Stateless deepen (real git over HTTP): the shallow list is re-sent in every response,
    // flush-terminated; a request without "done" is a negotiation probe and gets no pack.
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
    if (!sawDone) {
      if (haves.length > 0) {
        parts.push(common.length > 0 ? pktLine(`ACK ${common[0]} ready\n`) : pktLine('NAK\n'));
      }
      sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    parts.push(ackLine());
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(PKT_FLUSH); // v0 terminates the shallow block with a flush before the ACK/NAK line
  }
  if (!sawDone) {
    // Negotiation probe (no "done" yet): acknowledge readiness only; the pack belongs to the
    // final request, the one that carries "done".
    parts.push(common.length > 0 ? pktLine(`ACK ${common[common.length - 1]} ready\n`) : pktLine('NAK\n'));
    sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  // Final answer: in multi_ack_detailed the closing ack is a plain ACK (a "ready" here would make
  // the client read another ack and trip over the pack).
  parts.push(common.length > 0 ? pktLine(`ACK ${common[common.length - 1]}\n`) : pktLine('NAK\n'));
  if (caps.includes('side-band-64k') || caps.includes('side-band')) {
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(pack);
  }
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleUploadPack(res: ServerResponse, repo: RepoRec, raw: Buffer, req: IncomingMessage): void {
  try {
    const protocol = req.headers['git-protocol'] ?? '';
    if (/(^|:)version=2/.test(protocol)) {
      const { first } = splitPktBlocks(raw);
      const command = first.length > 0 ? lineText(first[0]) : '';
      if (command === 'command=ls-refs') {
        handleLsRefs(res, repo, raw);
        return;
      }
      if (command === 'command=fetch') {
        handleFetchV2(res, repo, raw);
        return;
      }
      sendBuffer(res, 400, Buffer.from('unknown command\n'), 'text/plain');
      return;
    }
    handleFetchV0(res, repo, raw);
  } catch {
    sendBuffer(res, 400, Buffer.from('bad request\n'), 'text/plain');
  }
}

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(res: ServerResponse, repo: RepoRec, raw: Buffer): void {
  let commands: RefCommand[] = [];
  let packBytes: Buffer = Buffer.alloc(0);
  let caps = '';
  try {
    const parsed = readPktLines(raw);
    commands = parsed.lines.map((line, index) => {
      let text = lineText(line);
      if (index === 0) {
        const nul = text.indexOf('\0');
        if (nul !== -1) {
          caps = text.slice(nul + 1);
          text = text.slice(0, nul);
        }
      }
      const fields = text.trim().split(/\s+/);
      return { oldOid: fields[0] ?? ZERO_OID, newOid: fields[1] ?? ZERO_OID, ref: fields[2] ?? '' };
    });
    packBytes = parsed.rest;
  } catch {
    sendBuffer(res, 400, Buffer.from('bad request\n'), 'text/plain');
    return;
  }

  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const entries = parsePack(packBytes, (oid) => repo.objects.get(oid));
      for (const entry of entries) {
        if (!repo.objects.has(entry.oid)) {
          repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
          repo.gen += 1;
        }
      }
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (command.ref === '' || !command.ref.startsWith('refs/')) {
      fail('funny refname');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (unpackError !== null) {
      fail('unpack failed');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        fail('reference does not exist');
        continue;
      }
      if (current !== command.oldOid) {
        fail('stale info');
        continue;
      }
      repo.refs.delete(command.ref);
      repo.gen += 1;
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      fail('missing object');
      continue;
    }
    if (current !== command.oldOid) {
      fail('stale info');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (target.type !== 'commit') {
        fail('not a commit');
        continue;
      }
      if (command.oldOid !== ZERO_OID && !isAncestor(repo, command.oldOid, command.newOid)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    repo.gen += 1;
    results.push({ ref: command.ref, ok: true });
  }

  if (!caps.includes('report-status')) {
    sendBuffer(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  const report: Buffer[] = [pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  report.push(PKT_FLUSH);
  if (caps.includes('side-band-64k') || caps.includes('side-band')) {
    const wrapped = report.map((packet) => pktLine(Buffer.concat([Buffer.from([1]), packet])));
    wrapped.push(PKT_FLUSH);
    sendBuffer(res, 200, Buffer.concat(wrapped), 'application/x-git-receive-pack-result');
    return;
  }
  sendBuffer(res, 200, Buffer.concat(report), 'application/x-git-receive-pack-result');
}

// --------------------------------------------------------------------------- GraphQL v4

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'obj'; fields: { name: string; value: GqlValue }[] };

interface GqlField {
  kind: 'field';
  name: string;
  alias?: string;
  args: { name: string; value: GqlValue }[];
  selection?: GqlSelection[];
}
interface GqlInline {
  kind: 'inline';
  typeCondition?: string;
  selection: GqlSelection[];
}
interface GqlSpread {
  kind: 'spread';
  name: string;
}
type GqlSelection = GqlField | GqlInline | GqlSpread;

interface GqlOperation {
  type: 'query' | 'mutation';
  name?: string;
  varDefs: { name: string; defaultValue?: GqlValue }[];
  selection: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string; selection: GqlSelection[] }>;
}

function lexGraphQL(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&='.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push(JSON.stringify(source.slice(i + 3, end)));
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lexGraphQL(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }
  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }
  private isName(token: string | undefined): boolean {
    return token !== undefined && /^[_A-Za-z]/.test(token);
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: GqlSelection[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === '{') {
        operations.push({ type: 'query', varDefs: [], selection: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | undefined;
        if (this.isName(this.peek())) name = this.next();
        const varDefs: { name: string; defaultValue?: GqlValue }[] = [];
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.next();
            this.expect(':');
            this.parseType();
            let defaultValue: GqlValue | undefined;
            if (this.peek() === '=') {
              this.next();
              defaultValue = this.parseValue();
            }
            this.skipDirectives();
            varDefs.push({ name: varName, defaultValue });
          }
          this.next();
        }
        this.skipDirectives();
        operations.push({ type: type === 'subscription' ? 'query' : type, name, varDefs, selection: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.parseArgs();
    }
  }

  private parseArgs(): { name: string; value: GqlValue }[] {
    this.expect('(');
    const args: { name: string; value: GqlValue }[] = [];
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.next();
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token.startsWith('"')) return { kind: 'str', value: JSON.parse(token) as string };
    if (token === 'true' || token === 'false') return { kind: 'bool', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (token === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'obj', fields };
    }
    if (/^-?\d/.test(token)) return { kind: 'num', value: Number(token) };
    return { kind: 'enum', value: token };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (this.peek() === '{') {
          selections.push({ kind: 'inline', selection: this.parseSelectionSet() });
        } else {
          const name = this.next();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = this.peek() === '(' ? this.parseArgs() : [];
      this.skipDirectives();
      const selection = this.peek() === '{' ? this.parseSelectionSet() : undefined;
      selections.push({ kind: 'field', name, alias, args, selection });
    }
    this.next();
    return selections;
  }
}

function resolveGqlValue(value: GqlValue, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return vars[value.name];
    case 'str':
      return value.value;
    case 'num':
      return value.value;
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveGqlValue(item, vars));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveGqlValue(field.value, vars);
      return out;
    }
  }
}

// --- the object graph the executor walks: wrappers carry a __typename and a payload.

interface GqlObj {
  __typename: string;
  [key: string]: unknown;
}

function repoObj(repo: RepoRec): GqlObj {
  return { __typename: 'Repository', repo };
}
function issueObj(repo: RepoRec, rec: IssueRec): GqlObj {
  return { __typename: 'Issue', repo, rec };
}
function pullObj(repo: RepoRec, rec: IssueRec): GqlObj {
  return { __typename: 'PullRequest', repo, rec };
}
function userObj(): GqlObj {
  return { __typename: 'User' };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'url',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'labels', 'refs',
    'stargazerCount', 'forkCount', 'isFork', 'isArchived', 'primaryLanguage',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'author', 'repository',
    'labels', 'comments', 'assignees', 'participants', 'createdAt', 'updatedAt', 'closedAt',
    'closed', 'locked', 'milestone', 'reactions',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author',
    'repository', 'labels', 'comments', 'reviews', 'additions', 'deletions', 'changedFiles',
    'createdAt', 'updatedAt', 'mergedAt', 'closedAt', 'mergeCommit', 'url', 'isDraft',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  CommentEdge: ['node', 'cursor'],
};

const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

interface GqlCtx {
  vars: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selection: GqlSelection[] }>;
  errors: { message: string }[];
}

function gqlCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function gqlCursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1], 10);
  } catch {
    return -1;
  }
}

interface ConnectionArgs {
  first: number;
  after?: unknown;
}

function connectionOf(items: GqlObj[], args: ConnectionArgs, connectionType: string): GqlObj {
  const start = args.after === undefined || args.after === null ? 0 : gqlCursorIndex(args.after) + 1;
  const slice = items.slice(start, start + Math.max(0, args.first));
  const hasNext = start + slice.length < items.length;
  return {
    __typename: connectionType,
    nodes: slice,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? gqlCursor(start) : null,
      endCursor: slice.length > 0 ? gqlCursor(start + slice.length - 1) : null,
    } as GqlObj,
    totalCount: items.length,
  };
}

function argsOf(field: GqlField, ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveGqlValue(arg.value, ctx.vars);
  return out;
}

class GqlFail extends Error {}

function repoFromGlobalId(id: unknown): RepoRec {
  if (typeof id !== 'string') throw new GqlFail('a repository id is required');
  const decoded = decodeGid(id);
  if (decoded === null || decoded.type !== 'Repository') throw new GqlFail('unknown repository id');
  const dbId = Number.parseInt(decoded.key, 10);
  for (const repo of repos.values()) if (repo.dbId === dbId) return repo;
  throw new GqlFail('repository not found');
}

function issueFromGlobalId(id: unknown, wantPR: boolean): { repo: RepoRec; rec: IssueRec } {
  if (typeof id !== 'string') throw new GqlFail('an id is required');
  const decoded = decodeGid(id);
  if (decoded === null) throw new GqlFail('unknown id');
  const dbId = Number.parseInt(decoded.key, 10);
  const found = issueIndex.get(dbId);
  if (found === undefined || found.rec.isPR !== wantPR) throw new GqlFail('object not found');
  return found;
}

/** Resolve one field on one object; throws GqlFail for domain errors, returns undefined for unknown fields. */
function resolveField(type: string, source: GqlObj, field: string, args: Record<string, unknown>): unknown {
  switch (type) {
    case 'Query': {
      if (field === 'viewer') return userObj();
      if (field === 'repository') {
        const repo = typeof args.name === 'string' ? findRepo(str(args.owner), args.name) : undefined;
        return repo === undefined ? null : repoObj(repo);
      }
      if (field === 'node') {
        if (typeof args.id !== 'string') return null;
        const decoded = decodeGid(args.id);
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const dbId = Number.parseInt(decoded.key, 10);
          for (const repo of repos.values()) if (repo.dbId === dbId) return repoObj(repo);
          return null;
        }
        if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
          const found = issueIndex.get(Number.parseInt(decoded.key, 10));
          if (found === undefined) return null;
          return found.rec.isPR ? pullObj(found.repo, found.rec) : issueObj(found.repo, found.rec);
        }
        if (decoded.type === 'User') return userObj();
        return null;
      }
      if (field === '__type') {
        const name = str(args.name);
        if (TYPE_FIELDS[name] !== undefined) {
          return { __typename: '__Type', name, kind: 'OBJECT', fieldsList: TYPE_FIELDS[name], enumList: [] } as GqlObj;
        }
        if (ENUM_TYPES[name] !== undefined) {
          return { __typename: '__Type', name, kind: 'ENUM', fieldsList: [], enumList: ENUM_TYPES[name] } as GqlObj;
        }
        return null;
      }
      if (field === '__schema') return { __typename: '__Schema' } as GqlObj;
      return undefined;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromGlobalId(input.repositoryId);
        const title = str(input.title);
        if (title === '') throw new GqlFail('title is required');
        const rec = newIssueRec(repo, { title, body: str(input.body) });
        return { __typename: 'CreateIssuePayload', clientMutationId: (input.clientMutationId as string) ?? null, issue: issueObj(repo, rec) } as GqlObj;
      }
      if (field === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const { repo, rec } = issueFromGlobalId(input.issueId, false);
        rec.state = 'closed';
        rec.tick = nextTick();
        return { __typename: 'CloseIssuePayload', clientMutationId: (input.clientMutationId as string) ?? null, issue: issueObj(repo, rec) } as GqlObj;
      }
      if (field === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromGlobalId(input.repositoryId);
        const head = str(input.headRefName);
        const base = str(input.baseRefName);
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined) throw new GqlFail(`head ref ${head} does not exist`);
        if (baseSha === undefined) throw new GqlFail(`base ref ${base} does not exist`);
        const duplicate = sortedIssues(repo, true).find((rec) => rec.state === 'open' && rec.headRef === head && rec.baseRef === base);
        if (duplicate !== undefined) throw new GqlFail('a pull request already exists for this head and base');
        const rec = newIssueRec(repo, { title: str(input.title), body: str(input.body), isPR: true, headRef: head, baseRef: base, headSha, baseSha });
        return { __typename: 'CreatePullRequestPayload', clientMutationId: (input.clientMutationId as string) ?? null, pullRequest: pullObj(repo, rec) } as GqlObj;
      }
      if (field === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const { repo, rec } = issueFromGlobalId(input.pullRequestId, true);
        if (rec.state !== 'open') throw new GqlFail('pull request is not open');
        const method = str(input.mergeMethod) === 'MERGE' ? 'merge' : 'squash';
        const sha = mergePullRequest(repo, rec, method);
        if (sha === null) throw new GqlFail('pull request is not mergeable');
        return { __typename: 'MergePullRequestPayload', clientMutationId: (input.clientMutationId as string) ?? null, pullRequest: pullObj(repo, rec) } as GqlObj;
      }
      if (field === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        if (typeof input.subjectId !== 'string') throw new GqlFail('subjectId is required');
        const decoded = decodeGid(input.subjectId);
        const found = decoded === null ? undefined : issueIndex.get(Number.parseInt(decoded.key, 10));
        if (found === undefined) throw new GqlFail('subject not found');
        commentSeq += 1;
        const comment: CommentRec = { id: 300_000 + commentSeq, body: str(input.body), tick: nextTick() };
        found.rec.comments.push(comment);
        const node = { __typename: 'IssueComment', id: gid('IssueComment', comment.id), body: comment.body } as GqlObj;
        return {
          __typename: 'AddCommentPayload',
          clientMutationId: (input.clientMutationId as string) ?? null,
          commentEdge: { __typename: 'CommentEdge', node, cursor: gqlCursor(0) } as GqlObj,
        } as GqlObj;
      }
      return undefined;
    }
    case 'User': {
      if (field === 'login') return VIEWER.login;
      if (field === 'id') return gid('User', VIEWER.id);
      if (field === 'databaseId') return VIEWER.id;
      if (field === 'name') return VIEWER.name;
      if (field === 'email') return VIEWER.email;
      if (field === 'url') return 'https://forge.invalid/adaiversen';
      if (field === 'createdAt' || field === 'updatedAt') return isoOf(1);
      return undefined;
    }
    case 'Repository': {
      const repo = source.repo as RepoRec;
      switch (field) {
        case 'id': return gid('Repository', repo.dbId);
        case 'databaseId': return repo.dbId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return userObj();
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'url': return `https://forge.invalid/${repo.owner}/${repo.name}`;
        case 'defaultBranchRef': {
          return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' } as GqlObj;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasPullRequestsEnabled': return true;
        case 'createdAt': return isoOf(repo.tick);
        case 'updatedAt': return isoOf(repo.tick);
        case 'issue': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const rec = repo.issues.get(number);
          return rec !== undefined && !rec.isPR ? issueObj(repo, rec) : null;
        }
        case 'issues': {
          let items = sortedIssues(repo, false);
          const states = args.states;
          if (Array.isArray(states)) {
            const wanted = states.map((state) => String(state).toLowerCase());
            items = items.filter((rec) => wanted.includes(rec.state));
          }
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const direction = str(orderBy.direction) || 'ASC';
          if (direction === 'DESC') items.reverse();
          const first = typeof args.first === 'number' ? args.first : 100;
          return connectionOf(items.map((rec) => issueObj(repo, rec)), { first, after: args.after }, 'IssueConnection');
        }
        case 'pullRequest': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const rec = repo.issues.get(number);
          return rec !== undefined && rec.isPR ? pullObj(repo, rec) : null;
        }
        case 'pullRequests': {
          let items = sortedIssues(repo, true);
          const states = args.states;
          if (Array.isArray(states)) {
            const wanted = states.map((state) => String(state).toLowerCase());
            items = items.filter((rec) => wanted.includes(rec.merged ? 'merged' : rec.state));
          }
          const first = typeof args.first === 'number' ? args.first : 100;
          return connectionOf(items.map((rec) => pullObj(repo, rec)), { first, after: args.after }, 'PullRequestConnection');
        }
        default: return undefined;
      }
    }
    case 'Issue': {
      const rec = source.rec as IssueRec;
      switch (field) {
        case 'id': return gid('Issue', rec.dbId);
        case 'databaseId': return rec.dbId;
        case 'number': return rec.number;
        case 'title': return rec.title;
        case 'body': return rec.body;
        case 'state': return rec.state.toUpperCase();
        case 'url': return `https://forge.invalid/issues/${rec.number}`;
        case 'author': return userObj();
        case 'repository': return repoObj(source.repo as RepoRec);
        case 'createdAt': return isoOf(rec.tick);
        case 'updatedAt': return isoOf(rec.tick);
        case 'closedAt': return rec.state === 'closed' ? isoOf(rec.tick) : null;
        case 'closed': return rec.state === 'closed';
        case 'locked': return false;
        default: return undefined;
      }
    }
    case 'PullRequest': {
      const repo = source.repo as RepoRec;
      const rec = source.rec as IssueRec;
      switch (field) {
        case 'id': return gid('PullRequest', rec.dbId);
        case 'databaseId': return rec.dbId;
        case 'number': return rec.number;
        case 'title': return rec.title;
        case 'body': return rec.body;
        case 'state': return rec.merged ? 'MERGED' : rec.state.toUpperCase();
        case 'merged': return rec.merged;
        case 'mergeable': {
          if (rec.merged || rec.state !== 'open') return 'UNKNOWN';
          return pullMergeable(repo, rec) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'headRefName': return rec.headRef;
        case 'baseRefName': return rec.baseRef;
        case 'author': return userObj();
        case 'repository': return repoObj(repo);
        case 'createdAt': return isoOf(rec.tick);
        case 'updatedAt': return isoOf(rec.tick);
        case 'mergedAt': return rec.mergedAt;
        case 'closedAt': return rec.state === 'closed' ? isoOf(rec.tick) : null;
        case 'isDraft': return false;
        case 'files': {
          const files = pullFiles(repo, rec).map((file) => ({
            __typename: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          } as GqlObj));
          const first = typeof args.first === 'number' ? args.first : 100;
          return connectionOf(files, { first, after: args.after }, 'PullRequestChangedFileConnection');
        }
        default: return undefined;
      }
    }
    case '__Type': {
      if (field === 'name') return source.name;
      if (field === 'kind') return source.kind;
      if (field === 'description') return null;
      if (field === 'fields') {
        return (source.fieldsList as string[]).map((name) => ({ __typename: '__Field', name } as GqlObj));
      }
      if (field === 'enumValues') {
        return (source.enumList as string[]).map((name) => ({ __typename: '__EnumValue', name } as GqlObj));
      }
      return undefined;
    }
    case '__Field': {
      if (field === 'name') return source.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return undefined;
    }
    case '__EnumValue': {
      if (field === 'name') return source.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      return undefined;
    }
    default:
      return undefined;
  }
}

function executeSelections(type: string, source: GqlObj, selections: GqlSelection[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === type) {
        Object.assign(out, executeSelections(type, source, selection.selection, ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === type) {
        Object.assign(out, executeSelections(type, source, fragment.selection, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = type;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(type, source, selection.name, argsOf(selection, ctx));
    } catch (error) {
      if (error instanceof GqlFail) {
        ctx.errors.push({ message: error.message });
        out[key] = null;
        continue;
      }
      throw error;
    }
    if (value === undefined && Object.prototype.hasOwnProperty.call(source, selection.name)) {
      value = source[selection.name]; // plain wrapper objects (connections, payloads, pageInfo)
    }
    if (value === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${type}'` });
      out[key] = null;
      continue;
    }
    if (selection.selection !== undefined && value !== null) {
      if (Array.isArray(value)) {
        out[key] = value.map((item) => {
          const obj = item as GqlObj;
          return obj !== null && typeof obj === 'object' && typeof obj.__typename === 'string'
            ? executeSelections(obj.__typename, obj, selection.selection!, ctx)
            : item;
        });
      } else if (typeof value === 'object' && typeof (value as GqlObj).__typename === 'string') {
        const obj = value as GqlObj;
        out[key] = executeSelections(obj.__typename, obj, selection.selection, ctx);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function executeGraphQL(body: Record<string, unknown>): Record<string, unknown> {
  const query = str(body.query);
  const vars: Record<string, unknown> = {};
  if (body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables)) {
    Object.assign(vars, body.variables as Record<string, unknown>);
  }
  let document: GqlDocument;
  try {
    document = new GqlParser(query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'no operation in document' }] };
  let operation = document.operations[0];
  const operationName = optStr(body.operationName);
  if (operationName !== undefined) {
    operation = document.operations.find((op) => op.name === operationName) ?? operation;
  }
  for (const def of operation.varDefs) {
    if (vars[def.name] === undefined && def.defaultValue !== undefined) {
      vars[def.name] = resolveGqlValue(def.defaultValue, vars);
    }
  }
  const ctx: GqlCtx = { vars, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, { __typename: rootType } as GqlObj, operation.selection, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

async function handleGraphQL(res: ServerResponse, raw: Buffer): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { errors: [{ message: 'invalid operation' }] };
      return executeGraphQL(entry as Record<string, unknown>);
    });
    sendJson(res, 200, results);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, { errors: [{ message: 'invalid request body' }] });
    return;
  }
  sendJson(res, 200, executeGraphQL(parsed as Record<string, unknown>));
}

// --------------------------------------------------------------------------- MCP (streamable HTTP)

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): McpTool {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: true } };
}
const stringProp = (description: string): Record<string, unknown> => ({ type: 'string', description });

const MCP_TOOLS: McpTool[] = [
  tool('create_repo', 'Create a new repository for the authenticated user.', {
    owner: stringProp('The account that will own the repository.'),
    name: stringProp('The name of the repository.'),
    description: stringProp('A short description of the repository.'),
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Read a repository by owner and name.', {
    owner: stringProp('The repository owner.'),
    repo: stringProp('The repository name.'),
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: stringProp('The repository owner.'),
    repo: stringProp('The repository name.'),
    title: stringProp('The issue title.'),
    body: stringProp('The issue body.'),
    labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository.', {
    owner: stringProp('The repository owner.'),
    repo: stringProp('The repository name.'),
    state: stringProp('Filter by state: open, closed or all.'),
  }, ['owner', 'repo']),
  tool('get_issue', 'Read one issue by number.', {
    owner: stringProp('The repository owner.'),
    repo: stringProp('The repository name.'),
    number: { type: 'integer', description: 'The issue number.' },
  }, ['owner', 'repo', 'number']),
  tool('list_pull_requests', 'List the pull requests of a repository.', {
    owner: stringProp('The repository owner.'),
    repo: stringProp('The repository name.'),
    state: stringProp('Filter by state: open, closed or all.'),
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: stringProp('The repository owner.'),
    repo: stringProp('The repository name.'),
    title: stringProp('The pull request title.'),
    body: stringProp('The pull request body.'),
    head: stringProp('The head branch.'),
    base: stringProp('The base branch.'),
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request into its base branch.', {
    owner: stringProp('The repository owner.'),
    repo: stringProp('The repository name.'),
    pull_number: { type: 'integer', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
];

const MCP_TOOLS_BY_NAME = new Map(MCP_TOOLS.map((entry) => [entry.name, entry]));

interface ToolOutcome {
  value?: unknown;
  error?: string;
}

function runTool(name: string, args: Record<string, unknown>): ToolOutcome {
  const repoOf = (): RepoRec | undefined => findRepo(str(args.owner) || VIEWER.login, str(args.repo));
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (repoName === '') return { error: 'name is required' };
      const existing = repos.get(repoName);
      if (existing !== undefined) return { value: repoJson(existing) };
      const repo = createRepoRec(repoName, str(args.description), bool(args.private));
      return { value: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = repoOf();
      if (repo === undefined) return { error: 'repository not found' };
      return { value: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = repoOf();
      if (repo === undefined) return { error: 'repository not found' };
      let labels: string[] = [];
      if (args.labels !== undefined) {
        const parsed = labelNamesOf(repo, args.labels);
        if (parsed === null) return { error: 'one or more labels do not exist in this repository' };
        labels = parsed;
      }
      const rec = newIssueRec(repo, { title: str(args.title), body: str(args.body), labels });
      return { value: issueJson(repo, rec) };
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === undefined) return { error: 'repository not found' };
      const state = str(args.state) || 'open';
      let items = sortedIssues(repo, false);
      if (state === 'open' || state === 'closed') items = items.filter((rec) => rec.state === state);
      return { value: items.map((rec) => issueJson(repo, rec)) };
    }
    case 'get_issue': {
      const repo = repoOf();
      if (repo === undefined) return { error: 'repository not found' };
      const rec = repo.issues.get(typeof args.number === 'number' ? args.number : -1);
      if (rec === undefined || rec.isPR) return { error: 'issue not found' };
      return { value: issueJson(repo, rec) };
    }
    case 'list_pull_requests': {
      const repo = repoOf();
      if (repo === undefined) return { error: 'repository not found' };
      const state = str(args.state) || 'open';
      let items = sortedIssues(repo, true);
      if (state === 'open' || state === 'closed') items = items.filter((rec) => rec.state === state);
      return { value: items.map((rec) => pullJson(repo, rec)) };
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (repo === undefined) return { error: 'repository not found' };
      const head = str(args.head).split(':').pop() ?? '';
      const base = str(args.base).split(':').pop() ?? '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined) return { error: `head ref ${head} does not exist` };
      if (baseSha === undefined) return { error: `base ref ${base} does not exist` };
      if (head === base || headSha === baseSha) return { error: 'no commits between base and head' };
      const duplicate = sortedIssues(repo, true).find((rec) => rec.state === 'open' && rec.headRef === head && rec.baseRef === base);
      if (duplicate !== undefined) return { value: pullJson(repo, duplicate) };
      const rec = newIssueRec(repo, { title: str(args.title), body: str(args.body), isPR: true, headRef: head, baseRef: base, headSha, baseSha });
      return { value: pullJson(repo, rec) };
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === undefined) return { error: 'repository not found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : -1;
      const rec = repo.issues.get(number);
      if (rec === undefined || !rec.isPR) return { error: 'pull request not found' };
      if (rec.state !== 'open') return { error: 'pull request is not open' };
      const sha = mergePullRequest(repo, rec, 'squash');
      if (sha === null) return { error: 'pull request is not mergeable' };
      return { value: pullJson(repo, rec) };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

const MCP_SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleRpc(request: Record<string, unknown>): Record<string, unknown> | null {
  const method = str(request.method);
  const id = request.id;
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (id === undefined) return null; // a notification: nothing to answer
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      });
    case 'initialize': {
      const requested = str(params.protocolVersion);
      const version = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
    }
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = str(params.name);
      const toolDef = MCP_TOOLS_BY_NAME.get(name);
      if (toolDef === undefined) return rpcError(id, -32602, `unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const schema = toolDef.inputSchema as { required?: string[] };
      for (const required of schema.required ?? []) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcError(id, -32602, `missing required argument: ${required}`);
        }
      }
      const outcome = runTool(name, args);
      if (outcome.error !== undefined) {
        return rpcResult(id, { content: [{ type: 'text', text: outcome.error }], isError: true });
      }
      const text = JSON.stringify(outcome.value);
      return rpcResult(id, { content: [{ type: 'text', text }], structuredContent: outcome.value, isError: false });
    }
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<void> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (method === 'GET') {
    sendJson(res, 405, rpcError(null, -32601, 'this server is stateless; POST JSON-RPC messages'));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed)) {
    const results: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      if (entry !== null && typeof entry === 'object') {
        const answer = handleRpc(entry as Record<string, unknown>);
        if (answer !== null) results.push(answer);
      }
    }
    sendJson(res, 200, results);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const answer = handleRpc(parsed as Record<string, unknown>);
  if (answer === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}

// --------------------------------------------------------------------------- the app

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/mcp') {
          if (!authed(req)) {
            sendJson(res, 401, rpcError(null, -32001, 'unauthorized'));
            return;
          }
          await handleMcp(req, res, await readBody(req));
          return;
        }

        if (path === '/api/graphql') {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          await handleGraphQL(res, await readBody(req));
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authed(req)) {
            restError(res, 401, 'Bad credentials');
            return;
          }
          const raw = method === 'GET' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);
          await handleRest(req, res, url, raw);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const owner = decodeURIComponent(gitMatch[1]);
          const repo = findRepo(owner, decodeURIComponent(gitMatch[2]));
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const endpoint = gitMatch[3];
          if (endpoint === 'info/refs' && method === 'GET') {
            handleInfoRefs(res, repo, url, req);
            return;
          }
          if (endpoint === 'git-upload-pack' && method === 'POST') {
            handleUploadPack(res, repo, await readBody(req), req);
            return;
          }
          if (endpoint === 'git-receive-pack' && method === 'POST') {
            handleReceivePack(res, repo, await readBody(req));
            return;
          }
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { message: 'Internal Server Error' });
          } catch {
            // The socket is already gone; nothing more to do.
          }
        } else {
          try {
            res.end();
          } catch {
            // Same as above.
          }
        }
      }
    })();
  });
}
