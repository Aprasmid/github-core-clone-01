// main.ts -- a one-process GitHub-compatible git forge.
//
// One Node process serves four surfaces over a single in-memory store:
//   * the REST v3 API            under /api/v3
//   * the GraphQL v4 API         at    /api/graphql
//   * an MCP endpoint            at    /mcp
//   * git smart HTTP (v0 + v2)   at    /<owner>/<repo>.git/...
//
// Lifecycle (the harness contract): bind an ephemeral port, POST {"port": N}
// to $MAKEFUN_ENV_URL/register, serve until GET $MAKEFUN_ENV_URL/done
// answers {"done": true}, then exit 0. No filesystem, no subprocess, no
// network beyond the harness: every object lives in Maps in this process.
//
// The bearer token the harness hands out (MAKEFUN_SHOP_TOKEN) belongs to
// one user -- the scenario's viewer. The scenario is a pure function of a
// fixed seed (see the PRNG below), so the viewer's login is derived here
// exactly the way the suite derives it, from the same public constants.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// The scenario PRNG: FNV-1a label hash, splitmix64 mix, xorshift64* stream.
// Replicated so this server can know the viewer's login without any config.
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
/** 2025-01-01T00:00:00Z: the epoch every generated timestamp derives from. */
const SCENARIO_EPOCH_SEC = 1_735_689_600;

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

class ScenarioRng {
  private state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }

  static fromLabel(label: string): ScenarioRng {
    return new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64(label)));
  }

  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
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

/** The scenario's first generated user is the viewer; the token is theirs. */
function deriveViewerLogin(): string {
  const rng = ScenarioRng.fromLabel('users');
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

const VIEWER_LOGIN = deriveViewerLogin();
const VIEWER_ID = 1000;
const ZERO_OID = '0'.repeat(40);
const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

/** ISO-8601 for a scenario-epoch second count. */
function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function b64EncodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64DecodeText(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

// ---------------------------------------------------------------------------
// The git object store: content-addressed, SHA-1 over "<type> <len>\0<body>".
// ---------------------------------------------------------------------------

type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const OBJECT_TYPE_BY_CODE: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};
const OBJECT_CODE_BY_TYPE: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

/** Every object this forge knows, by hex sha. One store for all repositories. */
const objectStore = new Map<string, GitObject>();

function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

function storeObject(type: GitObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!objectStore.has(sha)) objectStore.set(sha, { type, data });
  return sha;
}

function getObject(sha: string): GitObject | null {
  return objectStore.get(sha) ?? null;
}

// ---------------------------------------------------------------------------
// Trees: "<mode> <name>\0<20-byte sha>" entries, git's sort (a directory's
// name compares as if it ended in '/').
// ---------------------------------------------------------------------------

interface TreeEntry {
  mode: string; // as stored: '100644', '100755', '120000', '40000', '160000'
  name: string;
  sha: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = Buffer.from(treeSortKey(a), 'utf8');
    const kb = Buffer.from(treeSortKey(b), 'utf8');
    return Buffer.compare(ka, kb);
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

function storeTree(entries: TreeEntry[]): string {
  return storeObject('tree', buildTree(entries));
}

/** The empty tree every diff against "nothing" bottoms out at. */
const EMPTY_TREE_SHA = storeObject('tree', Buffer.alloc(0));

// ---------------------------------------------------------------------------
// Commits: header lines, a blank line, then the message.
// ---------------------------------------------------------------------------

interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorSec: number;
  committerName: string;
  committerEmail: string;
  committerSec: number;
  message: string;
}

function parseIdentity(line: string): { name: string; email: string; sec: number } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', sec: SCENARIO_EPOCH_SEC };
  return { name: match[1] ?? '', email: match[2] ?? '', sec: Number(match[3] ?? SCENARIO_EPOCH_SEC) };
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorSec: SCENARIO_EPOCH_SEC,
    committerName: '',
    committerEmail: '',
    committerSec: SCENARIO_EPOCH_SEC,
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const id = parseIdentity(line.slice(7));
      info.authorName = id.name;
      info.authorEmail = id.email;
      info.authorSec = id.sec;
    } else if (line.startsWith('committer ')) {
      const id = parseIdentity(line.slice(10));
      info.committerName = id.name;
      info.committerEmail = id.email;
      info.committerSec = id.sec;
    }
  }
  return info;
}

function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.authorName} <${info.authorEmail}> ${info.authorSec} +0000`);
  lines.push(`committer ${info.committerName} <${info.committerEmail}> ${info.committerSec} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

function getCommit(sha: string): CommitInfo | null {
  const object = getObject(sha);
  if (object === null || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** Peel a tag or commit sha down to its commit; null when it is not commit-like. */
function peelToCommit(sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = getObject(current);
    if (object === null) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null || match[1] === undefined) return null;
    current = match[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Packfiles: read (plain objects plus ofs/ref deltas) and write (plain).
// ---------------------------------------------------------------------------

function readPackVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (;;) {
    const byte = buf[cursor] as number;
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: cursor };
}

/** Apply a git delta to its base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readPackVarint(delta, 0);
  const target = readPackVarint(delta, source.next);
  if (source.value !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  let cursor = target.next;
  while (cursor < delta.length) {
    const opcode = delta[cursor] as number;
    cursor += 1;
    if (opcode & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) {
          offset += (delta[cursor] as number) * 2 ** (8 * bit);
          cursor += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) {
          size += (delta[cursor] as number) * 2 ** (8 * bit);
          cursor += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (opcode > 0) {
      out.push(delta.subarray(cursor, cursor + opcode));
      produced += opcode;
      cursor += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== target.value || result.length !== target.value) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  sha: string;
  type: GitObjectType;
  data: Buffer;
}

/**
 * Parse a whole pack into the object store. Returns the stored entries.
 * The trailer checksum is verified against the bytes that precede it.
 */
function ingestPack(pack: Buffer): PackEntry[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack signature missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');

  const entries: PackEntry[] = [];
  // Delta entries resolve after their base is known; keep them pending.
  const pending: Array<{ kind: 'ofs'; baseOffset: number; delta: Buffer } | { kind: 'ref'; baseSha: string; delta: Buffer }> = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const first = pack[offset] as number;
    offset += 1;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseSha = '';
    if (typeCode === 6) {
      // ofs-delta: a negative-offset varint with git's quirky encoding.
      byte = pack[offset] as number;
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (typeCode === 7) {
      baseSha = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const data = inflated.buffer;
    if (data.length !== size) throw new Error('pack entry size mismatch');
    offset += inflated.engine.bytesWritten;
    if (typeCode === 6) {
      pending.push({ kind: 'ofs', baseOffset, delta: data });
    } else if (typeCode === 7) {
      pending.push({ kind: 'ref', baseSha, delta: data });
    } else {
      const type = OBJECT_TYPE_BY_CODE[typeCode];
      if (type === undefined) throw new Error(`pack entry type ${typeCode}`);
      const sha = storeObject(type, data);
      const entry = { sha, type, data };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    }
    // Resolve any pending delta whose base just landed (offsets resolve in
    // order, ref bases may arrive later in the same pack or be pre-existing).
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const item = pending[i] as (typeof pending)[number];
        const base = item.kind === 'ofs' ? byOffset.get(item.baseOffset) : ((): PackEntry | null => {
          const known = getObject(item.baseSha);
          return known === null ? null : { sha: item.baseSha, type: known.type, data: known.data };
        })();
        if (base === null || base === undefined) continue;
        const resolved = applyDelta(base.data, item.delta);
        const sha = storeObject(base.type, resolved);
        entries.push({ sha, type: base.type, data: resolved });
        pending.splice(i, 1);
        progressed = true;
      }
    }
  }
  if (pending.length > 0) throw new Error('pack delta base missing');
  return entries;
}

/** Write a pack carrying exactly `shas` (full objects, no deltas). */
function writePack(shas: readonly string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  const parts: Buffer[] = [header];
  for (const sha of shas) {
    const object = getObject(sha);
    if (object === null) throw new Error(`writePack: unknown object ${sha}`);
    const code = OBJECT_CODE_BY_TYPE[object.type];
    let size = object.data.length;
    const firstByte = (code << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    const head: number[] = [];
    if (size === 0) {
      head.push(firstByte);
    } else {
      head.push(firstByte | 0x80);
      while (size > 0) {
        let byte = size & 0x7f;
        size = Math.floor(size / 128);
        if (size > 0) byte |= 0x80;
        head.push(byte);
      }
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// The domain store: repositories with refs, labels, issues, pull requests.
// Issues and pull requests share one number sequence per repository, as on
// GitHub. All state is in these Maps; nothing outlives the process.
// ---------------------------------------------------------------------------

interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

interface CommentRec {
  id: number;
  body: string;
  authorLogin: string;
  createdSec: number;
}

interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSec: number;
  updatedSec: number;
}

interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string; // branch name, e.g. 'feature'
  headShaAtOpen: string;
  baseRef: string; // branch name, e.g. 'main'
  merged: boolean;
  mergedAtSec: number | null;
  mergeCommitSha: string | null;
  comments: CommentRec[];
  createdSec: number;
  updatedSec: number;
}

type NumberedRec = IssueRec | PullRec;

interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>; // full ref name -> commit (or tag object) sha
  headRef: string; // the symref HEAD names, e.g. 'refs/heads/main'
  labels: Map<string, LabelRec>;
  numbered: Map<number, NumberedRec>;
  nextNumber: number;
  createdSec: number;
}

const repos = new Map<string, RepoRec>();
let nextRepoId = 1;
let nextRecordId = 1;
let nextCommentId = 1;
/** Deterministic clock: scenario epoch plus a tick per mutation. */
let clockTick = 0;

function tickSec(): number {
  clockTick += 1;
  return SCENARIO_EPOCH_SEC + clockTick * 60;
}

function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

function findRepo(owner: string, name: string): RepoRec | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

function createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
  const repo: RepoRec = {
    id: nextRepoId,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    refs: new Map(),
    headRef: `refs/heads/${DEFAULT_BRANCH}`,
    labels: new Map(),
    numbered: new Map(),
    nextNumber: 1,
    createdSec: tickSec(),
  };
  nextRepoId += 1;
  repos.set(repoKey(owner, name), repo);
  return repo;
}

function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

// ---------------------------------------------------------------------------
// Ref and tree navigation.
// ---------------------------------------------------------------------------

/** Resolve a branch name, tag name, full ref, 'HEAD' or sha to a commit sha. */
function resolveToCommit(repo: RepoRec, ref: string): string | null {
  if (ref === 'HEAD') {
    const target = repo.refs.get(repo.headRef);
    return target === undefined ? null : peelToCommit(target);
  }
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const sha = repo.refs.get(candidate);
    if (sha !== undefined) return peelToCommit(sha);
  }
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const peeled = peelToCommit(ref);
    if (peeled !== null) return peeled;
  }
  return null;
}

/** The commit sha a branch ref currently names, or null when unborn/absent. */
function branchTip(repo: RepoRec, branch: string): string | null {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  return sha === undefined ? null : peelToCommit(sha);
}

/** Flatten a tree (recursively) into path -> {sha, mode}. */
function flattenTree(treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const object = getObject(treeSha);
  if (object === null || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** The flattened file map of a commit (empty for a null commit). */
function filesOfCommit(commitSha: string | null): Map<string, { sha: string; mode: string }> {
  if (commitSha === null) return new Map();
  const commit = getCommit(commitSha);
  if (commit === null) return new Map();
  return flattenTree(commit.tree);
}

/** Build (and store) nested trees from a flat path -> {sha, mode} map. */
function storeTreeFromFiles(files: Map<string, { sha: string; mode: string }>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ mode: file.mode, name: parts[parts.length - 1] as string, sha: file.sha });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, sha: build(child) });
    }
    return storeTree(entries);
  };
  return build(root);
}

/** Read one path out of a tree: a blob entry, a subtree sha, or null. */
function lookupPath(treeSha: string, path: string): { kind: 'blob' | 'tree'; sha: string; mode: string } | null {
  const parts = path.split('/').filter((part) => part !== '');
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const object = getObject(current);
    if (object === null || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) {
      return entry.mode === '40000'
        ? { kind: 'tree', sha: entry.sha, mode: entry.mode }
        : { kind: 'blob', sha: entry.sha, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.sha;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commit-graph walks: ancestry, merge base, history listing.
// ---------------------------------------------------------------------------

/** Every commit reachable from `start` (inclusive), breadth-first. */
function ancestorSet(start: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = getCommit(current);
    if (commit !== null) queue.push(...commit.parents);
  }
  return seen;
}

function isAncestor(maybeAncestor: string, of: string): boolean {
  return ancestorSet(of).has(maybeAncestor);
}

/** A best common ancestor of two commits, or null for unrelated histories. */
function mergeBaseOf(a: string, b: string): string | null {
  const ancestorsOfA = ancestorSet(a);
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (ancestorsOfA.has(current)) return current;
    const commit = getCommit(current);
    if (commit !== null) queue.push(...commit.parents);
  }
  return null;
}

/** History from a tip, newest first (breadth-first by generation). */
function historyFrom(tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    const commit = getCommit(current);
    if (commit !== null) queue.push(...commit.parents);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Three-way merge over flattened file maps, and line-level diffs.
// ---------------------------------------------------------------------------

interface MergeOutcome {
  ok: boolean;
  files: Map<string, { sha: string; mode: string }>;
  conflicts: string[];
}

/** Classic three-way: a path changed on only one side takes that side. */
function mergeFileMaps(
  base: Map<string, { sha: string; mode: string }>,
  ours: Map<string, { sha: string; mode: string }>,
  theirs: Map<string, { sha: string; mode: string }>,
): MergeOutcome {
  const files = new Map<string, { sha: string; mode: string }>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const inBase = base.get(path);
    const inOurs = ours.get(path);
    const inTheirs = theirs.get(path);
    const oursChanged = inOurs?.sha !== inBase?.sha || inOurs?.mode !== inBase?.mode;
    const theirsChanged = inTheirs?.sha !== inBase?.sha || inTheirs?.mode !== inBase?.mode;
    if (!oursChanged && !theirsChanged) {
      if (inBase !== undefined) files.set(path, inBase);
    } else if (oursChanged && !theirsChanged) {
      if (inOurs !== undefined) files.set(path, inOurs);
    } else if (!oursChanged && theirsChanged) {
      if (inTheirs !== undefined) files.set(path, inTheirs);
    } else if (inOurs?.sha === inTheirs?.sha && inOurs?.mode === inTheirs?.mode) {
      if (inOurs !== undefined) files.set(path, inOurs);
    } else {
      conflicts.push(path);
    }
  }
  return { ok: conflicts.length === 0, files, conflicts };
}

/** Line counts of a change between two blob bodies (LCS over lines). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // LCS via dynamic programming; the blobs in play are small.
  const rows = oldLines.length;
  const cols = newLines.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const common = dp[0]![0] as number;
  return { additions: cols - common, deletions: rows - common };
}

interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** The file-level diff between two commits' trees (base -> head). */
function diffCommits(baseCommit: string | null, headCommit: string | null): FileChange[] {
  const baseFiles = filesOfCommit(baseCommit);
  const headFiles = filesOfCommit(headCommit);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    if (inBase !== undefined && inHead !== undefined && inBase.sha === inHead.sha) continue;
    const oldText = inBase === undefined ? '' : (getObject(inBase.sha)?.data.toString('utf8') ?? '');
    const newText = inHead === undefined ? '' : (getObject(inHead.sha)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    changes.push({
      filename: path,
      status: inBase === undefined ? 'added' : inHead === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: inHead?.sha ?? inBase?.sha ?? '',
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Commits authored through the APIs (contents writes, merges). Authorship is
// the viewer; timestamps tick deterministically off the scenario epoch.
// ---------------------------------------------------------------------------

function makeApiCommit(repo: RepoRec, treeSha: string, parents: string[], message: string): string {
  const sec = tickSec();
  const info: CommitInfo = {
    tree: treeSha,
    parents,
    authorName: VIEWER_LOGIN,
    authorEmail: `${VIEWER_LOGIN}@example.invalid`,
    authorSec: sec,
    committerName: VIEWER_LOGIN,
    committerEmail: `${VIEWER_LOGIN}@example.invalid`,
    committerSec: sec,
    message,
  };
  return storeObject('commit', buildCommit(info));
}

// ---------------------------------------------------------------------------
// Serializers: the JSON shapes the REST surface answers with.
// ---------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : 0,
    node_id: Buffer.from(`04:User${login === VIEWER_LOGIN ? VIEWER_ID : 0}`).toString('base64'),
    type: 'User',
    site_admin: false,
  };
}

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`010:Repository${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdSec),
    updated_at: isoOf(repo.createdSec),
    pushed_at: isoOf(repo.createdSec),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.numbered.values()].filter((rec) => rec.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(label: LabelRec): Record<string, unknown> {
  return {
    id: 0,
    node_id: '',
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`05:IssueComment${comment.id}`).toString('base64'),
    body: comment.body,
    user: userJson(comment.authorLogin),
    created_at: isoOf(comment.createdSec),
    updated_at: isoOf(comment.createdSec),
  };
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`05:Issue${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name.toLowerCase()))
      .filter((label): label is LabelRec => label !== undefined)
      .map(labelJson),
    user: userJson(VIEWER_LOGIN),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdSec),
    updated_at: isoOf(issue.updatedSec),
    closed_at: issue.state === 'closed' ? isoOf(issue.updatedSec) : null,
    repository_url: '',
  };
}

function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaAtOpen;
  const baseSha = branchTip(repo, pull.baseRef) ?? '';
  return {
    id: pull.id,
    node_id: Buffer.from(`09:PullRequest${pull.id}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAtSec === null ? null : isoOf(pull.mergedAtSec),
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(VIEWER_LOGIN),
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${repo.owner}:${pull.headRef}`,
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      repo: repoJson(repo),
    },
    created_at: isoOf(pull.createdSec),
    updated_at: isoOf(pull.updatedSec),
    closed_at: pull.state === 'closed' ? isoOf(pull.updatedSec) : null,
  };
}

function commitJson(sha: string): Record<string, unknown> {
  const commit = getCommit(sha);
  if (commit === null) return { sha };
  return {
    sha,
    node_id: Buffer.from(`03:Commit${sha}`).toString('base64'),
    commit: {
      message: commit.message,
      tree: { sha: commit.tree },
      author: { name: commit.authorName, email: commit.authorEmail, date: isoOf(commit.authorSec) },
      committer: { name: commit.committerName, email: commit.committerEmail, date: isoOf(commit.committerSec) },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing shared by every surface.
// ---------------------------------------------------------------------------

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  segments: string[]; // decoded path segments
  rawBody: Buffer;
  json: unknown; // parsed JSON body, when it parsed
  jsonMalformed: boolean; // a non-empty body that was not JSON
}

function requestId(): string {
  return randomUUID().toUpperCase();
}

function sendJson(ctx: Ctx, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'x-github-request-id': requestId(),
    'x-oauth-scopes': 'repo, user, admin:org',
  });
  ctx.res.end(body);
}

function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message, documentation_url: '' });
}

function sendEmpty(ctx: Ctx, status: number): void {
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': 0,
    'x-github-request-id': requestId(),
  });
  ctx.res.end();
}

function isAuthed(ctx: Ctx): boolean {
  if (SHOP_TOKEN === '') return true;
  const header = ctx.req.headers.authorization ?? '';
  return header === `Bearer ${SHOP_TOKEN}`;
}

/** GitHub-style list pagination plus the Link header the checks follow. */
function paginate<T>(ctx: Ctx, items: T[]): T[] {
  const perPageRaw = Number(ctx.url.searchParams.get('per_page') ?? 30);
  const pageRaw = Number(ctx.url.searchParams.get('page') ?? 1);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const linkFor = (target: number, rel: string): string => {
    const params = new URLSearchParams(ctx.url.searchParams);
    params.set('page', String(target));
    params.set('per_page', String(perPage));
    const host = ctx.req.headers.host ?? '127.0.0.1';
    return `<http://${host}${ctx.url.pathname}?${params.toString()}>; rel="${rel}"`;
  };
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  if (totalPages > 1) {
    links.push(linkFor(1, 'first'));
    links.push(linkFor(totalPages, 'last'));
  }
  if (links.length > 0) ctx.res.setHeader('link', links.join(', '));
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function bodyObject(ctx: Ctx): Record<string, unknown> {
  return isRecord(ctx.json) ? ctx.json : {};
}

function bodyString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------
// REST: repositories.
// ---------------------------------------------------------------------------

function restCreateRepo(ctx: Ctx): void {
  const body = bodyObject(ctx);
  const name = bodyString(body, 'name');
  if (name === null || name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    sendError(ctx, 422, 'Repository creation failed: name is invalid');
    return;
  }
  if (findRepo(VIEWER_LOGIN, name) !== null) {
    sendError(ctx, 422, `name already exists on this account`);
    return;
  }
  const description = bodyString(body, 'description') ?? '';
  const isPrivate = body.private === true;
  const repo = createRepo(VIEWER_LOGIN, name, description, isPrivate);
  sendJson(ctx, 201, repoJson(repo));
}

function restListViewerRepos(ctx: Ctx): void {
  const mine = [...repos.values()]
    .filter((repo) => repo.owner === VIEWER_LOGIN)
    .sort((a, b) => a.id - b.id)
    .map(repoJson);
  sendJson(ctx, 200, paginate(ctx, mine));
}

/** Load the repo a /repos/{owner}/{name} route names, or answer 404. */
function withRepo(ctx: Ctx, owner: string, name: string): RepoRec | null {
  const repo = findRepo(owner, name);
  if (repo === null || repo.owner !== VIEWER_LOGIN) {
    // A repository under another owner is indistinguishable from absent.
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

function restGetRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = withRepo(ctx, owner, name);
  if (repo !== null) sendJson(ctx, 200, repoJson(repo));
}

function restPatchRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = withRepo(ctx, owner, name);
  if (repo === null) return;
  const body = bodyObject(ctx);
  const description = bodyString(body, 'description');
  if (description !== null) repo.description = description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  const defaultBranch = bodyString(body, 'default_branch');
  if (defaultBranch !== null && repo.refs.has(`refs/heads/${defaultBranch}`)) {
    repo.defaultBranch = defaultBranch;
    repo.headRef = `refs/heads/${defaultBranch}`;
  }
  sendJson(ctx, 200, repoJson(repo));
}

function restDeleteRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = withRepo(ctx, owner, name);
  if (repo === null) return;
  deleteRepo(repo.owner, repo.name);
  sendEmpty(ctx, 204);
}

// ---------------------------------------------------------------------------
// REST: contents (the GitHub contents API over the tree store).
// ---------------------------------------------------------------------------

function restGetContents(ctx: Ctx, repo: RepoRec, path: string): void {
  const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
  const commitSha = resolveToCommit(repo, ref);
  if (commitSha === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const commit = getCommit(commitSha);
  if (commit === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (path === '') {
    const entries = parseTree((getObject(commit.tree) as GitObject).data);
    sendJson(
      ctx,
      200,
      entries.map((entry) => ({
        name: entry.name,
        path: entry.name,
        sha: entry.sha,
        size: entry.mode === '40000' ? 0 : ((getObject(entry.sha)?.data.length ?? 0) as number),
        type: entry.mode === '40000' ? 'dir' : 'file',
      })),
    );
    return;
  }
  const found = lookupPath(commit.tree, path);
  if (found === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const name = path.split('/').pop() as string;
  if (found.kind === 'tree') {
    const entries = parseTree((getObject(found.sha) as GitObject).data);
    sendJson(
      ctx,
      200,
      entries.map((entry) => ({
        name: entry.name,
        path: `${path}/${entry.name}`,
        sha: entry.sha,
        size: entry.mode === '40000' ? 0 : ((getObject(entry.sha)?.data.length ?? 0) as number),
        type: entry.mode === '40000' ? 'dir' : 'file',
      })),
    );
    return;
  }
  const blob = getObject(found.sha);
  if (blob === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, {
    name,
    path,
    sha: found.sha,
    size: blob.data.length,
    type: 'file',
    encoding: 'base64',
    content: blob.data.toString('base64'),
  });
}

function restPutContents(ctx: Ctx, repo: RepoRec, path: string): void {
  const body = bodyObject(ctx);
  const content = bodyString(body, 'content');
  const message = bodyString(body, 'message');
  if (content === null || message === null || path === '') {
    sendError(ctx, 422, 'Validation Failed: content, message and a path are required');
    return;
  }
  const requestedBranch = bodyString(body, 'branch');
  const branch = requestedBranch ?? repo.defaultBranch;
  let tip = branchTip(repo, branch);
  if (tip === null && requestedBranch !== null && requestedBranch !== repo.defaultBranch) {
    // Creating a branch through the contents route: it starts from the
    // default branch's tip (or from nothing on an unborn repository).
    tip = branchTip(repo, repo.defaultBranch);
  }
  const files = filesOfCommit(tip);
  const existing = files.get(path);
  const givenSha = bodyString(body, 'sha');
  if (existing !== undefined) {
    if (givenSha === null) {
      sendError(ctx, 422, 'Validation Failed: sha must be supplied when updating an existing file');
      return;
    }
    if (givenSha !== existing.sha) {
      sendError(ctx, 409, `${path} does not match ${givenSha}`);
      return;
    }
  } else if (givenSha !== null) {
    sendError(ctx, 422, 'Validation Failed: sha must not be supplied when creating a file');
    return;
  }
  const data = b64DecodeText(content);
  const blobSha = storeObject('blob', data);
  files.set(path, { sha: blobSha, mode: existing?.mode ?? '100644' });
  const treeSha = storeTreeFromFiles(files);
  const commitSha = makeApiCommit(repo, treeSha, tip === null ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  sendJson(ctx, existing === undefined ? 201 : 200, {
    content: {
      name: path.split('/').pop() as string,
      path,
      sha: blobSha,
      size: data.length,
      type: 'file',
      encoding: 'base64',
    },
    commit: { sha: commitSha, message },
  });
}

function restDeleteContents(ctx: Ctx, repo: RepoRec, path: string): void {
  const body = bodyObject(ctx);
  const message = bodyString(body, 'message');
  const givenSha = bodyString(body, 'sha');
  const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  const files = filesOfCommit(tip);
  const existing = files.get(path);
  if (existing === undefined || tip === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (message === null || givenSha === null) {
    sendError(ctx, 422, 'Validation Failed: message and sha are required');
    return;
  }
  if (givenSha !== existing.sha) {
    sendError(ctx, 409, `${path} does not match ${givenSha}`);
    return;
  }
  files.delete(path);
  const treeSha = storeTreeFromFiles(files);
  const commitSha = makeApiCommit(repo, treeSha, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  sendJson(ctx, 200, { content: null, commit: { sha: commitSha, message } });
}

// ---------------------------------------------------------------------------
// REST: branches, refs, commits, tags.
// ---------------------------------------------------------------------------

function restListBranches(ctx: Ctx, repo: RepoRec): void {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(ctx, 200, paginate(ctx, branches));
}

function restGetBranch(ctx: Ctx, repo: RepoRec, branch: string): void {
  const tip = branchTip(repo, branch);
  if (tip === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, {
    name: branch,
    commit: commitJson(tip),
    protected: false,
  });
}

function restCreateRef(ctx: Ctx, repo: RepoRec): void {
  const body = bodyObject(ctx);
  const ref = bodyString(body, 'ref');
  const sha = bodyString(body, 'sha');
  if (ref === null || sha === null || !ref.startsWith('refs/')) {
    sendError(ctx, 422, 'Validation Failed: ref and sha are required');
    return;
  }
  const object = getObject(sha);
  if (object === null) {
    sendError(ctx, 422, 'Validation Failed: object does not exist');
    return;
  }
  if (repo.refs.has(ref)) {
    sendError(ctx, 422, 'Reference already exists');
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(ctx, 201, {
    ref,
    node_id: Buffer.from(`07:Ref${ref}`).toString('base64'),
    object: { sha, type: object.type },
  });
}

function restGetRef(ctx: Ctx, repo: RepoRec, refPath: string): void {
  const full = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
  const sha = repo.refs.get(full);
  if (sha === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const object = getObject(sha);
  sendJson(ctx, 200, { ref: full, object: { sha, type: object?.type ?? 'commit' } });
}

function restDeleteRef(ctx: Ctx, repo: RepoRec, refPath: string): void {
  const full = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
  if (!repo.refs.delete(full)) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendEmpty(ctx, 204);
}

function restListCommits(ctx: Ctx, repo: RepoRec): void {
  const ref = ctx.url.searchParams.get('sha') ?? repo.headRef;
  const tip = resolveToCommit(repo, ref);
  if (tip === null) {
    sendJson(ctx, 200, []);
    return;
  }
  const history = historyFrom(tip, 10_000);
  sendJson(ctx, 200, paginate(ctx, history.map(commitJson)));
}

function restGetCommit(ctx: Ctx, repo: RepoRec, sha: string): void {
  if (getCommit(sha) === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, commitJson(sha));
}

function restListTags(ctx: Ctx, repo: RepoRec): void {
  const tags: Array<Record<string, unknown>> = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/tags/')) continue;
    tags.push({ name: ref.slice('refs/tags/'.length), commit: { sha: peelToCommit(sha) ?? sha } });
  }
  tags.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(ctx, 200, paginate(ctx, tags));
}

// ---------------------------------------------------------------------------
// REST: labels.
// ---------------------------------------------------------------------------

function restListLabels(ctx: Ctx, repo: RepoRec): void {
  const labels = [...repo.labels.values()].sort((a, b) => a.name.localeCompare(b.name)).map(labelJson);
  sendJson(ctx, 200, paginate(ctx, labels));
}

function restCreateLabel(ctx: Ctx, repo: RepoRec): void {
  const body = bodyObject(ctx);
  const name = bodyString(body, 'name');
  if (name === null || name === '') {
    sendError(ctx, 422, 'Validation Failed: name is required');
    return;
  }
  if (repo.labels.has(name.toLowerCase())) {
    sendError(ctx, 422, 'Validation Failed: name has already been taken');
    return;
  }
  const label: LabelRec = {
    name,
    color: (bodyString(body, 'color') ?? 'ededed').replace(/^#/, ''),
    description: bodyString(body, 'description'),
  };
  repo.labels.set(name.toLowerCase(), label);
  sendJson(ctx, 201, labelJson(label));
}

/** Validate label names for an issue write; returns an error message or null. */
function labelError(repo: RepoRec, body: Record<string, unknown>): string | null {
  const raw = body.labels;
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return 'Validation Failed: labels must be an array';
  for (const item of raw) {
    const name = typeof item === 'string' ? item : isRecord(item) ? bodyString(item, 'name') : null;
    if (name === null || !repo.labels.has(name.toLowerCase())) {
      return `Validation Failed: label ${name ?? '?'} does not exist`;
    }
  }
  return null;
}

function labelNamesOf(repo: RepoRec, body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item : isRecord(item) ? bodyString(item, 'name') : null;
    if (name === null) continue;
    const label = repo.labels.get(name.toLowerCase());
    if (label !== undefined) names.push(label.name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// REST: issues and comments.
// ---------------------------------------------------------------------------

function restCreateIssue(ctx: Ctx, repo: RepoRec): void {
  const body = bodyObject(ctx);
  const title = bodyString(body, 'title');
  if (title === null || title === '') {
    sendError(ctx, 422, 'Validation Failed: title is required');
    return;
  }
  const badLabel = labelError(repo, body);
  if (badLabel !== null) {
    sendError(ctx, 422, badLabel);
    return;
  }
  const sec = tickSec();
  const issue: IssueRec = {
    kind: 'issue',
    id: nextRecordId,
    number: repo.nextNumber,
    title,
    body: bodyString(body, 'body') ?? '',
    state: 'open',
    labels: labelNamesOf(repo, body),
    comments: [],
    createdSec: sec,
    updatedSec: sec,
  };
  nextRecordId += 1;
  repo.nextNumber += 1;
  repo.numbered.set(issue.number, issue);
  sendJson(ctx, 201, issueJson(repo, issue));
}

function restListIssues(ctx: Ctx, repo: RepoRec): void {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  const sort = ctx.url.searchParams.get('sort') ?? 'created';
  const direction = ctx.url.searchParams.get('direction') === 'desc' ? -1 : 1;
  let list = [...repo.numbered.values()].filter((rec) => rec.kind === 'issue') as IssueRec[];
  if (state !== 'all') list = list.filter((issue) => issue.state === state);
  if (sort === 'created') list.sort((a, b) => (a.number - b.number) * direction);
  sendJson(ctx, 200, paginate(ctx, list.map((issue) => issueJson(repo, issue))));
}

function findNumbered(repo: RepoRec, raw: string): NumberedRec | null {
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return repo.numbered.get(number) ?? null;
}

function restGetIssue(ctx: Ctx, repo: RepoRec, raw: string): void {
  const rec = findNumbered(repo, raw);
  if (rec === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (rec.kind === 'pull') {
    // GitHub answers a pull request's number on the issues surface too.
    const asIssue = {
      ...issueShellOfPull(repo, rec),
    };
    sendJson(ctx, 200, asIssue);
    return;
  }
  sendJson(ctx, 200, issueJson(repo, rec));
}

function issueShellOfPull(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`05:Issue${pull.id}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    user: userJson(VIEWER_LOGIN),
    comments: pull.comments.length,
    pull_request: { url: '', html_url: '', diff_url: '', patch_url: '' },
    created_at: isoOf(pull.createdSec),
    updated_at: isoOf(pull.updatedSec),
    closed_at: pull.state === 'closed' ? isoOf(pull.updatedSec) : null,
  };
}

function restPatchIssue(ctx: Ctx, repo: RepoRec, raw: string): void {
  const rec = findNumbered(repo, raw);
  if (rec === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const body = bodyObject(ctx);
  const badLabel = rec.kind === 'issue' ? labelError(repo, body) : null;
  if (badLabel !== null) {
    sendError(ctx, 422, badLabel);
    return;
  }
  const title = bodyString(body, 'title');
  if (title !== null) rec.title = title;
  const newBody = bodyString(body, 'body');
  if (newBody !== null) rec.body = newBody;
  const state = bodyString(body, 'state');
  if (state === 'open' || state === 'closed') rec.state = state;
  if (rec.kind === 'issue' && body.labels !== undefined) rec.labels = labelNamesOf(repo, body);
  rec.updatedSec = tickSec();
  sendJson(ctx, 200, rec.kind === 'issue' ? issueJson(repo, rec) : issueShellOfPull(repo, rec));
}

function restListComments(ctx: Ctx, repo: RepoRec, raw: string): void {
  const rec = findNumbered(repo, raw);
  if (rec === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, paginate(ctx, rec.comments.map(commentJson)));
}

function restCreateComment(ctx: Ctx, repo: RepoRec, raw: string): void {
  const rec = findNumbered(repo, raw);
  if (rec === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const body = bodyObject(ctx);
  const text = bodyString(body, 'body');
  if (text === null) {
    sendError(ctx, 422, 'Validation Failed: body is required');
    return;
  }
  const comment: CommentRec = {
    id: nextCommentId,
    body: text,
    authorLogin: VIEWER_LOGIN,
    createdSec: tickSec(),
  };
  nextCommentId += 1;
  rec.comments.push(comment);
  rec.updatedSec = comment.createdSec;
  sendJson(ctx, 201, commentJson(comment));
}

// ---------------------------------------------------------------------------
// REST: pull requests and merging.
// ---------------------------------------------------------------------------

function restCreatePull(ctx: Ctx, repo: RepoRec): void {
  const body = bodyObject(ctx);
  const title = bodyString(body, 'title');
  const head = bodyString(body, 'head');
  const base = bodyString(body, 'base');
  if (title === null || head === null || base === null) {
    sendError(ctx, 422, 'Validation Failed: title, head and base are required');
    return;
  }
  const headBranch = head.includes(':') ? (head.split(':').pop() as string) : head;
  const headTip = branchTip(repo, headBranch);
  if (headTip === null) {
    sendError(ctx, 422, `Validation Failed: head branch ${headBranch} does not exist`);
    return;
  }
  if (branchTip(repo, base) === null) {
    sendError(ctx, 422, `Validation Failed: base branch ${base} does not exist`);
    return;
  }
  const existing = [...repo.numbered.values()].find(
    (rec) => rec.kind === 'pull' && rec.state === 'open' && rec.headRef === headBranch && rec.baseRef === base,
  );
  if (existing !== undefined) {
    sendError(ctx, 422, `A pull request already exists for ${headBranch} into ${base}`);
    return;
  }
  const sec = tickSec();
  const pull: PullRec = {
    kind: 'pull',
    id: nextRecordId,
    number: repo.nextNumber,
    title,
    body: bodyString(body, 'body') ?? '',
    state: 'open',
    headRef: headBranch,
    headShaAtOpen: headTip,
    baseRef: base,
    merged: false,
    mergedAtSec: null,
    mergeCommitSha: null,
    comments: [],
    createdSec: sec,
    updatedSec: sec,
  };
  nextRecordId += 1;
  repo.nextNumber += 1;
  repo.numbered.set(pull.number, pull);
  sendJson(ctx, 201, pullJson(repo, pull));
}

function restListPulls(ctx: Ctx, repo: RepoRec): void {
  const state = ctx.url.searchParams.get('state') ?? 'open';
  let list = [...repo.numbered.values()].filter((rec) => rec.kind === 'pull') as PullRec[];
  if (state !== 'all') list = list.filter((pull) => pull.state === state);
  list.sort((a, b) => a.number - b.number);
  sendJson(ctx, 200, paginate(ctx, list.map((pull) => pullJson(repo, pull))));
}

function restGetPull(ctx: Ctx, repo: RepoRec, raw: string): void {
  const rec = findNumbered(repo, raw);
  if (rec === null || rec.kind !== 'pull') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, pullJson(repo, rec));
}

function restPatchPull(ctx: Ctx, repo: RepoRec, raw: string): void {
  const rec = findNumbered(repo, raw);
  if (rec === null || rec.kind !== 'pull') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const body = bodyObject(ctx);
  const title = bodyString(body, 'title');
  if (title !== null) rec.title = title;
  const newBody = bodyString(body, 'body');
  if (newBody !== null) rec.body = newBody;
  const state = bodyString(body, 'state');
  if (state === 'open' || state === 'closed') rec.state = state;
  rec.updatedSec = tickSec();
  sendJson(ctx, 200, pullJson(repo, rec));
}

function restPullFiles(ctx: Ctx, repo: RepoRec, raw: string): void {
  const rec = findNumbered(repo, raw);
  if (rec === null || rec.kind !== 'pull') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const headTip = branchTip(repo, rec.headRef) ?? rec.headShaAtOpen;
  const baseTip = branchTip(repo, rec.baseRef);
  const base = baseTip === null ? null : (mergeBaseOf(baseTip, headTip) ?? baseTip);
  const changes = diffCommits(base, headTip).map((change) => ({
    filename: change.filename,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.changes,
    sha: change.sha,
  }));
  sendJson(ctx, 200, paginate(ctx, changes));
}

/** Whether a pull can merge cleanly right now, and the merged file map. */
function pullMergePreview(repo: RepoRec, pull: PullRec): { baseTip: string; headTip: string; outcome: MergeOutcome } | null {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.headShaAtOpen;
  if (baseTip === null) return null;
  const base = mergeBaseOf(baseTip, headTip);
  const outcome = mergeFileMaps(filesOfCommit(base), filesOfCommit(baseTip), filesOfCommit(headTip));
  return { baseTip, headTip, outcome };
}

function restMergePull(ctx: Ctx, repo: RepoRec, raw: string): void {
  const rec = findNumbered(repo, raw);
  if (rec === null || rec.kind !== 'pull') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const pull = rec;
  if (pull.merged || pull.state !== 'open') {
    sendError(ctx, 405, 'Pull Request is not mergeable');
    return;
  }
  const preview = pullMergePreview(repo, pull);
  if (preview === null) {
    sendError(ctx, 405, 'Pull Request is not mergeable');
    return;
  }
  const { baseTip, headTip, outcome } = preview;
  if (isAncestor(headTip, baseTip)) {
    sendError(ctx, 405, 'Pull Request is not mergeable: the head is already contained in the base');
    return;
  }
  if (!outcome.ok) {
    sendError(ctx, 405, 'Pull Request is not mergeable: merge conflict');
    return;
  }
  const body = bodyObject(ctx);
  const method = bodyString(body, 'merge_method') ?? 'merge';
  const treeSha = storeTreeFromFiles(outcome.files);
  let mergeSha: string;
  if (method === 'squash') {
    const title = bodyString(body, 'commit_title') ?? `${pull.title} (#${pull.number})`;
    mergeSha = makeApiCommit(repo, treeSha, [baseTip], title);
  } else if (method === 'rebase' && isAncestor(baseTip, headTip)) {
    mergeSha = headTip;
  } else if (method === 'rebase') {
    const title = bodyString(body, 'commit_title') ?? `${pull.title} (#${pull.number})`;
    mergeSha = makeApiCommit(repo, treeSha, [baseTip], title);
  } else {
    const message = `Merge pull request #${pull.number} from ${repo.owner}:${pull.headRef}\n\n${pull.title}`;
    mergeSha = makeApiCommit(repo, treeSha, [baseTip, headTip], message);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAtSec = tickSec();
  pull.updatedSec = pull.mergedAtSec;
  pull.mergeCommitSha = mergeSha;
  sendJson(ctx, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
}

function restPullMerged(ctx: Ctx, repo: RepoRec, raw: string): void {
  const rec = findNumbered(repo, raw);
  if (rec === null || rec.kind !== 'pull') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (rec.merged) sendEmpty(ctx, 204);
  else sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Git smart HTTP: pkt-lines, ref advertisement, ls-refs, fetch, receive-pack.
// ---------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface PktFrame {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse pkt-frames from `offset`; returns the frames and the end offset. */
function parsePktFrames(buf: Buffer, offset: number): { frames: PktFrame[]; next: number } {
  const frames: PktFrame[] = [];
  let cursor = offset;
  while (cursor + 4 <= buf.length) {
    const head = buf.toString('ascii', cursor, cursor + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      frames.push({ kind: 'flush', payload: Buffer.alloc(0) });
      cursor += 4;
      break;
    }
    if (length === 1) {
      frames.push({ kind: 'delim', payload: Buffer.alloc(0) });
      cursor += 4;
      continue;
    }
    if (length === 2) {
      frames.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      cursor += 4;
      continue;
    }
    if (length < 4 || cursor + length > buf.length) break;
    frames.push({ kind: 'data', payload: buf.subarray(cursor + 4, cursor + length) });
    cursor += length;
  }
  return { frames, next: cursor };
}

/** Parse a request body that is pkt-lines all the way down. */
function parsePktLines(buf: Buffer): { lines: string[]; packStart: number } {
  const lines: string[] = [];
  let cursor = 0;
  while (cursor + 4 <= buf.length) {
    const head = buf.toString('ascii', cursor, cursor + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      cursor += 4;
      break;
    }
    if (length === 1 || length === 2) {
      cursor += 4;
      continue;
    }
    if (length < 4 || cursor + length > buf.length) break;
    lines.push(buf.toString('utf8', cursor + 4, cursor + length));
    cursor += length;
  }
  return { lines, packStart: cursor };
}

function lineText(payload: Buffer): string {
  return payload.toString('utf8').replace(/\n$/, '');
}

const AGENT_TOKEN = 'forge/1.0';

/** Refs in advertisement order: HEAD first (when born), then names sorted. */
function advertisementRefs(repo: RepoRec): Array<{ name: string; sha: string }> {
  const refs: Array<{ name: string; sha: string }> = [];
  const headSha = repo.refs.get(repo.headRef);
  if (headSha !== undefined) refs.push({ name: 'HEAD', sha: headSha });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) refs.push({ name, sha: repo.refs.get(name) as string });
  return refs;
}

function handleInfoRefs(ctx: Ctx, repo: RepoRec, service: string): void {
  const wantsV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack' && wantsV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT_TOKEN}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    ctx.res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'content-length': body.length,
      'x-github-request-id': requestId(),
      'cache-control': 'no-cache',
    });
    ctx.res.end(body);
    return;
  }
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${repo.headRef} side-band-64k ofs-delta shallow agent=${AGENT_TOKEN}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT_TOKEN}`;
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisementRefs(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      lines.push(pktLine(`${ref.sha} ${ref.name}${suffix}`));
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(ref.sha);
        if (peeled !== null && peeled !== ref.sha) lines.push(pktLine(`${peeled} ${ref.name}^{}`));
      }
    });
  }
  lines.push(PKT_FLUSH);
  const body = Buffer.concat(lines);
  ctx.res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    'cache-control': 'no-cache',
  });
  ctx.res.end(body);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2).
// ---------------------------------------------------------------------------

function handleLsRefs(ctx: Ctx, repo: RepoRec, args: string[]): void {
  const wantsPeel = args.includes('peel');
  const wantsSymrefs = args.includes('symrefs');
  const wantsUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const headSha = repo.refs.get(repo.headRef);
  if (matches('HEAD')) {
    if (headSha !== undefined) {
      const attrs = wantsSymrefs ? ` symref-target:${repo.headRef}` : '';
      out.push(pktLine(`${headSha} HEAD${attrs}\n`));
    } else if (wantsUnborn) {
      out.push(pktLine(`unborn HEAD symref-target:${repo.headRef}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!matches(name)) continue;
    const sha = repo.refs.get(name) as string;
    let attrs = '';
    if (wantsPeel && name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(sha);
      if (peeled !== null && peeled !== sha) attrs = ` peeled:${peeled}`;
    }
    out.push(pktLine(`${sha} ${name}${attrs}\n`));
  }
  out.push(PKT_FLUSH);
  const body = Buffer.concat(out);
  ctx.res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  ctx.res.end(body);
}

// ---------------------------------------------------------------------------
// Fetch: closure computation with have-exclusion and shallow cutting.
// ---------------------------------------------------------------------------

interface FetchPlan {
  /** Commit shas whose objects go in the pack. */
  commits: string[];
  /** Object shas for the pack (commits, trees, blobs), order-stable. */
  objects: string[];
  /** Commits that become shallow boundaries on the client. */
  newShallow: string[];
  /** Client shallow commits that stop being boundaries. */
  unshallow: string[];
  /** Have shas the server recognises as common. */
  common: string[];
}

function planFetch(
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
  deepenSince: number | null,
  deepenNot: string[],
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  const notSet = new Set<string>();
  for (const ref of deepenNot) {
    // deepen-not names a ref the caller resolves for us only by sha in this
    // suite; a raw sha is honoured, a ref name is ignored gracefully.
    if (/^[0-9a-f]{40}$/.test(ref)) notSet.add(ref);
  }

  // The exclusion closure: everything reachable from the haves, stopping at
  // the client's declared shallow boundaries (their parents are not had).
  const excludedCommits = new Set<string>();
  {
    const queue = [...haves];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (excludedCommits.has(current)) continue;
      const commit = getCommit(current);
      if (commit === null) continue;
      excludedCommits.add(current);
      if (shallowSet.has(current)) continue;
      queue.push(...commit.parents);
    }
  }
  for (const sha of notSet) {
    for (const ancestor of ancestorSet(sha)) excludedCommits.add(ancestor);
  }

  // Wants may name tag objects (a clone asks for every ref tip): the tag
  // itself goes in the pack, and its commit joins the walk.
  const extraObjects: string[] = [];
  const commitWants: string[] = [];
  for (const sha of wants) {
    const object = getObject(sha);
    if (object === null) continue;
    if (object.type === 'commit') {
      commitWants.push(sha);
    } else if (object.type === 'tag') {
      extraObjects.push(sha);
      const target = peelToCommit(sha);
      if (target !== null) commitWants.push(target);
    } else {
      extraObjects.push(sha);
    }
  }

  // The inclusion walk: breadth-first from the wants, generation by
  // generation, so a depth limit cuts at an exact generation.
  const included = new Map<string, number>(); // sha -> generation distance
  {
    let frontier = [...new Set(commitWants)].filter((sha) => getCommit(sha) !== null);
    let generation = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const sha of frontier) {
        if (included.has(sha)) continue;
        if (excludedCommits.has(sha) && !commitWants.includes(sha)) continue;
        included.set(sha, generation);
        const commit = getCommit(sha);
        if (commit === null) continue;
        if (depth !== null && generation + 1 >= depth) continue;
        if (deepenSince !== null && commit.committerSec <= deepenSince) continue;
        if (shallowSet.has(sha) && depth === null && deepenSince === null) continue;
        next.push(...commit.parents);
      }
      frontier = next;
      generation += 1;
    }
  }

  // Boundaries: included commits with a parent that exists but was cut.
  const newShallow: string[] = [];
  if (depth !== null || deepenSince !== null) {
    for (const sha of included.keys()) {
      const commit = getCommit(sha);
      if (commit === null) continue;
      const cut = commit.parents.some((parent) => !included.has(parent) && getCommit(parent) !== null);
      if (cut) newShallow.push(sha);
    }
  }
  const unshallow: string[] = [];
  for (const sha of shallowSet) {
    if (!included.has(sha)) continue;
    const commit = getCommit(sha);
    if (commit === null) continue;
    const stillBoundary = commit.parents.some((parent) => !included.has(parent) && getCommit(parent) !== null);
    if (!stillBoundary && commit.parents.length > 0) unshallow.push(sha);
    else if (commit.parents.length === 0) unshallow.push(sha);
  }

  // Excluded objects: the tree closures of every excluded commit, plus the
  // parents cut off at a new boundary (their whole ancestry is not sent).
  const excludedObjects = new Set<string>();
  const markExcluded = (commitSha: string): void => {
    const commit = getCommit(commitSha);
    if (commit === null) return;
    excludedObjects.add(commitSha);
    for (const [path, file] of flattenTree(commit.tree)) {
      void path;
      excludedObjects.add(file.sha);
    }
    // Trees themselves: walk them too.
    const walkTree = (treeSha: string): void => {
      if (excludedObjects.has(treeSha)) return;
      excludedObjects.add(treeSha);
      const object = getObject(treeSha);
      if (object === null || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') walkTree(entry.sha);
        else excludedObjects.add(entry.sha);
      }
    };
    walkTree(commit.tree);
  };
  for (const sha of excludedCommits) markExcluded(sha);
  // Note: the parents cut off at a shallow boundary are NOT excluded. They
  // are simply not included; their trees may share blobs with an included
  // commit's tree, and those shared objects must still be sent.

  // Collect what goes out: the included commits minus the excluded ones,
  // each with its tree closure, pruning anything excluded.
  const objects: string[] = [];
  const seenObjects = new Set<string>();
  const addObject = (sha: string): void => {
    if (seenObjects.has(sha) || excludedObjects.has(sha)) return;
    const object = getObject(sha);
    if (object === null) return;
    seenObjects.add(sha);
    objects.push(sha);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) addObject(entry.sha);
    }
  };
  const commits: string[] = [];
  for (const sha of included.keys()) {
    if (excludedCommits.has(sha)) continue;
    commits.push(sha);
    addObject(sha);
    const commit = getCommit(sha);
    if (commit !== null) addObject(commit.tree);
  }
  for (const sha of extraObjects) addObject(sha);

  const common = haves.filter((sha) => getCommit(sha) !== null);
  return { commits, objects, newShallow, unshallow, common };
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

function parseFetchArgs(args: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.depth = Number(arg.slice(7).trim());
    else if (arg.startsWith('deepen-since ')) request.deepenSince = Number(arg.slice(13).trim());
    else if (arg.startsWith('deepen-not ')) request.deepenNot.push(arg.slice(11).trim());
    else if (arg === 'done') request.done = true;
  }
  if (request.depth !== null && (!Number.isFinite(request.depth) || request.depth <= 0)) request.depth = null;
  if (request.deepenSince !== null && !Number.isFinite(request.deepenSince)) request.deepenSince = null;
  return request;
}

/** Sideband-1 packets carrying a pack, each within the 64k frame limit. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65_000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return packets;
}

function handleFetchV2(ctx: Ctx, repo: RepoRec, args: string[]): void {
  void repo;
  const request = parseFetchArgs(args);
  const plan = planFetch(request.wants, request.haves, request.shallow, request.depth, request.deepenSince, request.deepenNot);
  const out: Buffer[] = [];
  // acknowledgments
  out.push(pktLine('acknowledgments\n'));
  if (plan.common.length === 0) {
    out.push(pktLine('NAK\n'));
  } else {
    for (const sha of plan.common) out.push(pktLine(`ACK ${sha}\n`));
  }
  if (request.done) out.push(pktLine('ready\n'));
  out.push(PKT_FLUSH);
  // shallow-info, only when it has something to say
  if (plan.newShallow.length > 0 || plan.unshallow.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const sha of plan.newShallow) out.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) out.push(pktLine(`unshallow ${sha}\n`));
    out.push(PKT_FLUSH);
  }
  // packfile, only when there are objects to send
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    out.push(pktLine('packfile\n'));
    out.push(...sidebandPackets(pack));
    out.push(PKT_FLUSH);
  }
  const body = Buffer.concat(out);
  ctx.res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  ctx.res.end(body);
}

function handleFetchV0(ctx: Ctx, repo: RepoRec, body: Buffer): void {
  void repo;
  // Two pkt sections: wants (with deepen/shallow), flush, haves + done, flush.
  const first = parsePktFrames(body, 0);
  const wants: string[] = [];
  const shallow: string[] = [];
  const deepenNot: string[] = [];
  let depth: number | null = null;
  let deepenSince: number | null = null;
  for (const frame of first.frames) {
    if (frame.kind !== 'data') continue;
    const line = lineText(frame.payload);
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      wants.push(rest.split(' ')[0] as string);
    } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11).trim());
  }
  const haves: string[] = [];
  const second = parsePktFrames(body, first.next);
  for (const frame of second.frames) {
    if (frame.kind !== 'data') continue;
    const line = lineText(frame.payload);
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  if (depth !== null && (!Number.isFinite(depth) || depth <= 0)) depth = null;
  if (deepenSince !== null && !Number.isFinite(deepenSince)) deepenSince = null;
  const plan = planFetch(wants, haves, shallow, depth, deepenSince, deepenNot);
  const out: Buffer[] = [];
  for (const sha of plan.newShallow) out.push(pktLine(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) out.push(pktLine(`unshallow ${sha}\n`));
  if (plan.common.length === 0) out.push(pktLine('NAK\n'));
  else out.push(pktLine(`ACK ${plan.common[plan.common.length - 1]}\n`));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    out.push(...sidebandPackets(pack));
  }
  out.push(PKT_FLUSH);
  const bodyOut = Buffer.concat(out);
  ctx.res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': bodyOut.length,
    'x-github-request-id': requestId(),
  });
  ctx.res.end(bodyOut);
}

/** Route one POST to git-upload-pack: an ls-refs or fetch command (v2), or a v0 fetch. */
function handleUploadPack(ctx: Ctx, repo: RepoRec): void {
  const wantsV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  if (!wantsV2) {
    handleFetchV0(ctx, repo, ctx.rawBody);
    return;
  }
  // v2 request grammar: command line, capability lines, delim, args, flush.
  const { frames } = parsePktFrames(ctx.rawBody, 0);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const frame of frames) {
    if (frame.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (frame.kind !== 'data') continue;
    const line = lineText(frame.payload);
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  if (command === 'ls-refs') {
    handleLsRefs(ctx, repo, args);
    return;
  }
  if (command === 'fetch') {
    handleFetchV2(ctx, repo, args);
    return;
  }
  sendError(ctx, 400, `unknown upload-pack command ${command}`);
}

// ---------------------------------------------------------------------------
// receive-pack: command list, pack ingest, fast-forward validation, report.
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function sendPushReport(ctx: Ctx, lines: string[]): void {
  const packets: Buffer[] = [];
  for (const line of lines) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(line)])));
  }
  packets.push(pktLine(Buffer.concat([Buffer.from([1]), PKT_FLUSH])));
  const body = Buffer.concat(packets);
  ctx.res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  ctx.res.end(body);
}

function handleReceivePack(ctx: Ctx, repo: RepoRec): void {
  const { frames, next } = parsePktFrames(ctx.rawBody, 0);
  const commands: PushCommand[] = [];
  let malformed = false;
  for (const frame of frames) {
    if (frame.kind !== 'data') continue;
    let line = lineText(frame.payload);
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !/^[0-9a-f]{40}$/.test(parts[0] as string) || !/^[0-9a-f]{40}$/.test(parts[1] as string)) {
      malformed = true;
      break;
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  if (malformed || commands.length === 0) {
    // A garbage body must never take the server down; answer a report that
    // says so, and change nothing.
    sendPushReport(ctx, ['unpack error malformed command list\n']);
    return;
  }
  let unpackOk = true;
  const packBytes = ctx.rawBody.subarray(next);
  if (packBytes.length > 0) {
    try {
      ingestPack(Buffer.from(packBytes));
    } catch {
      unpackOk = false;
    }
  }
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : 'error pack failed to unpack'}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      lines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    lines.push(`${applyPushCommand(repo, command)}\n`);
  }
  sendPushReport(ctx, lines);
}

/** Validate and apply one push command; returns its report line (no newline). */
function applyPushCommand(repo: RepoRec, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) return `ng ${ref} invalid ref`;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // A deletion.
    if (current === ZERO_OID) return `ng ${ref} reference does not exist`;
    if (ref === repo.headRef) return `ng ${ref} deletion of the current branch prohibited`;
    if (oldOid !== ZERO_OID && oldOid !== current) return `ng ${ref} stale info`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  if (getObject(newOid) === null) return `ng ${ref} unknown object`;
  if (current !== oldOid) return `ng ${ref} stale info`;
  if (current !== ZERO_OID) {
    const currentCommit = peelToCommit(current);
    const newCommit = peelToCommit(newOid);
    if (currentCommit !== null && newCommit !== null && currentCommit !== newCommit && !isAncestor(currentCommit, newCommit)) {
      return `ng ${ref} non-fast-forward`;
    }
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

// ---------------------------------------------------------------------------
// Routing: REST dispatch, git dispatch, and the top-level handler.
// ---------------------------------------------------------------------------

function handleRest(ctx: Ctx): void {
  if (!isAuthed(ctx)) {
    sendError(ctx, 401, 'Requires authentication');
    return;
  }
  if (ctx.jsonMalformed) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const seg = ctx.segments.slice(2); // after /api/v3
  const method = ctx.method;

  if (seg.length === 0 && method === 'GET') {
    // The API root: a loose directory of the surface, as GHES answers.
    sendJson(ctx, 200, {
      current_user_url: '/api/v3/user',
      user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issues_url: '/api/v3/repos/{owner}/{repo}/issues',
    });
    return;
  }
  if (seg[0] === 'meta' && seg.length === 1 && method === 'GET') {
    sendJson(ctx, 200, {
      installed_version: '3.19.0-forge',
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      github_services_sha: '',
    });
    return;
  }
  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') {
    sendJson(ctx, 200, {
      ...userJson(VIEWER_LOGIN),
      name: VIEWER_LOGIN,
      email: `${VIEWER_LOGIN}@example.invalid`,
    });
    return;
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') return restListViewerRepos(ctx);
    if (method === 'POST') return restCreateRepo(ctx);
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1] as string;
    const name = seg[2] as string;
    const tail = seg.slice(3);
    if (tail.length === 0) {
      if (method === 'GET') return restGetRepo(ctx, owner, name);
      if (method === 'PATCH') return restPatchRepo(ctx, owner, name);
      if (method === 'DELETE') return restDeleteRepo(ctx, owner, name);
    }
    const repo = withRepo(ctx, owner, name);
    if (repo === null) return;
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (method === 'GET') return restGetContents(ctx, repo, path);
      if (method === 'PUT') return restPutContents(ctx, repo, path);
      if (method === 'DELETE') return restDeleteContents(ctx, repo, path);
    }
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') return restListBranches(ctx, repo);
      if (tail.length >= 2 && method === 'GET') return restGetBranch(ctx, repo, tail.slice(1).join('/'));
    }
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') return restCreateRef(ctx, repo);
      if (tail.length >= 3 && method === 'GET') return restGetRef(ctx, repo, tail.slice(2).join('/'));
      if (tail.length >= 3 && method === 'DELETE') return restDeleteRef(ctx, repo, tail.slice(2).join('/'));
    }
    if (tail[0] === 'git' && tail[1] === 'ref') {
      if (tail.length >= 3 && method === 'GET') return restGetRef(ctx, repo, tail.slice(2).join('/'));
      if (tail.length >= 3 && method === 'DELETE') return restDeleteRef(ctx, repo, tail.slice(2).join('/'));
    }
    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') return restListCommits(ctx, repo);
      if (tail.length === 2 && method === 'GET') return restGetCommit(ctx, repo, tail[1] as string);
    }
    if (tail[0] === 'tags' && tail.length === 1 && method === 'GET') return restListTags(ctx, repo);
    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'GET') return restListLabels(ctx, repo);
      if (tail.length === 1 && method === 'POST') return restCreateLabel(ctx, repo);
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1 && method === 'GET') return restListIssues(ctx, repo);
      if (tail.length === 1 && method === 'POST') return restCreateIssue(ctx, repo);
      if (tail.length === 2 && method === 'GET') return restGetIssue(ctx, repo, tail[1] as string);
      if (tail.length === 2 && method === 'PATCH') return restPatchIssue(ctx, repo, tail[1] as string);
      if (tail.length === 3 && tail[2] === 'comments' && method === 'GET') return restListComments(ctx, repo, tail[1] as string);
      if (tail.length === 3 && tail[2] === 'comments' && method === 'POST') return restCreateComment(ctx, repo, tail[1] as string);
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1 && method === 'GET') return restListPulls(ctx, repo);
      if (tail.length === 1 && method === 'POST') return restCreatePull(ctx, repo);
      if (tail.length === 2 && method === 'GET') return restGetPull(ctx, repo, tail[1] as string);
      if (tail.length === 2 && method === 'PATCH') return restPatchPull(ctx, repo, tail[1] as string);
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') return restPullFiles(ctx, repo, tail[1] as string);
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') return restMergePull(ctx, repo, tail[1] as string);
      if (tail.length === 3 && tail[2] === 'merge' && method === 'GET') return restPullMerged(ctx, repo, tail[1] as string);
    }
  }
  sendError(ctx, 404, 'Not Found');
}

function handleGitRoot(ctx: Ctx, owner: string, repoSegment: string): void {
  const name = repoSegment.slice(0, -'.git'.length);
  if (!isAuthed(ctx)) {
    sendError(ctx, 401, 'Requires authentication');
    return;
  }
  const repo = findRepo(owner, name);
  if (repo === null || repo.owner !== VIEWER_LOGIN) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const tail = ctx.segments.slice(2);
  if (tail[0] === 'info' && tail[1] === 'refs' && ctx.method === 'GET') {
    const service = ctx.url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(ctx, 400, 'Unknown service');
      return;
    }
    handleInfoRefs(ctx, repo, service);
    return;
  }
  if (tail[0] === 'git-upload-pack' && ctx.method === 'POST') {
    handleUploadPack(ctx, repo);
    return;
  }
  if (tail[0] === 'git-receive-pack' && ctx.method === 'POST') {
    handleReceivePack(ctx, repo);
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const data = chunk as Buffer;
    total += data.length;
    if (total > 128 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.internal');
  const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
  const method = (req.method ?? 'GET').toUpperCase();
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const rawBody = needsBody ? await readRequestBody(req) : Buffer.alloc(0);
  let json: unknown;
  let jsonMalformed = false;
  if (rawBody.length > 0) {
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      jsonMalformed = true;
    }
  }
  const ctx: Ctx = { req, res, url, method, segments, rawBody, json, jsonMalformed };
  try {
    if (segments[0] === 'healthz' && method === 'GET') {
      sendJson(ctx, 200, { status: 'ok' });
      return;
    }
    if (segments[0] === 'mcp') {
      handleMcp(ctx);
      return;
    }
    if (segments[0] === 'api' && segments[1] === 'graphql') {
      handleGraphQL(ctx);
      return;
    }
    if (segments[0] === 'api' && segments[1] === 'v3') {
      handleRest(ctx);
      return;
    }
    if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
      handleGitRoot(ctx, segments[0] as string, segments[1] as string);
      return;
    }
    sendError(ctx, 404, 'Not Found');
  } catch (error) {
    // One bad request must never take the forge down.
    if (!res.headersSent) sendError(ctx, 500, `Internal error: ${error instanceof Error ? error.message : String(error)}`);
    else res.end();
  }
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small parser and executor covering the query shapes gh and
// the github-mcp-server send -- fields, aliases, variables, enums, input
// objects, inline fragments, connections with cursors, Relay node ids, the
// mutations the suite drives, and the __type introspection probes.
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  directives: Array<{ name: string; args: Array<{ name: string; value: GqlValue }> }>;
  selection: GqlSelection[] | null;
}

interface GqlFragmentSpread {
  kind: 'spread';
  name: string;
}

interface GqlInlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selection: GqlSelection[];
}

type GqlSelection = GqlField | GqlFragmentSpread | GqlInlineFragment;

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, GqlValue>;
  selection: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string; selection: GqlSelection[] }>;
}

function gqlTokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end === -1 ? source.length : end)}"`);
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          text += source[j + 1];
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      tokens.push(`"${text}"`);
      i = j + 1;
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
    if (nameMatch !== null) {
      tokens.push(nameMatch[0]);
      i += nameMatch[0].length;
      continue;
    }
    const numberMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
    if (numberMatch !== null) {
      tokens.push(numberMatch[0]);
      i += numberMatch[0].length;
      continue;
    }
    throw new Error(`GraphQL: unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = gqlTokenize(source);
  }

  private peek(): string | null {
    return this.tokens[this.pos] ?? null;
  }

  private take(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('GraphQL: unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.take();
    if (got !== token) throw new Error(`GraphQL: expected ${token}, got ${got}`);
  }

  private skipType(): void {
    if (this.peek() === '[') {
      this.take();
      this.skipType();
      this.expect(']');
    } else {
      this.take();
    }
    if (this.peek() === '!') this.take();
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: GqlSelection[] }>();
    while (this.peek() !== null) {
      const head = this.peek() as string;
      if (head === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selection: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.take();
        let name: string | null = null;
        if (this.peek() !== null && this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@') {
          name = this.take();
        }
        const defaults = new Map<string, GqlValue>();
        if (this.peek() === '(') {
          this.take();
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.take();
            this.expect(':');
            this.skipType();
            if (this.peek() === '=') {
              this.take();
              defaults.set(varName, this.parseValue());
            }
            this.parseDirectives();
          }
          this.take();
        }
        this.parseDirectives();
        operations.push({
          type: head === 'mutation' ? 'mutation' : 'query',
          name,
          variableDefaults: defaults,
          selection: this.parseSelectionSet(),
        });
      } else if (head === 'fragment') {
        this.take();
        const fragName = this.take();
        this.expect('on');
        const typeCondition = this.take();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`GraphQL: unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private parseDirectives(): Array<{ name: string; args: Array<{ name: string; value: GqlValue }> }> {
    const directives: Array<{ name: string; args: Array<{ name: string; value: GqlValue }> }> = [];
    while (this.peek() === '@') {
      this.take();
      const name = this.take();
      const args = this.peek() === '(' ? this.parseArgs() : [];
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArgs(): Array<{ name: string; value: GqlValue }> {
    const args: Array<{ name: string; value: GqlValue }> = [];
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.take();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.take();
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.peek() as string;
    if (token === '$') {
      this.take();
      return { kind: 'variable', name: this.take() };
    }
    if (token === '[') {
      this.take();
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.take();
      return { kind: 'list', items };
    }
    if (token === '{') {
      this.take();
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}') {
        const name = this.take();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.take();
      return { kind: 'object', fields };
    }
    this.take();
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.take();
        if (this.peek() === 'on') {
          this.take();
          const typeCondition = this.take();
          this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (this.peek() === '{') {
          selections.push({ kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() });
        } else {
          const name = this.take();
          this.parseDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.take();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.take();
        alias = name;
        name = this.take();
      }
      const args = this.peek() === '(' ? this.parseArgs() : [];
      const directives = this.parseDirectives();
      const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, directives, selection });
    }
    this.take();
    return selections;
  }
}

// ---------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, and decodable by this server alone.
// ---------------------------------------------------------------------------

function globalId(type: string, numericId: string | number): string {
  return Buffer.from(`${type}:${numericId}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; numeric: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.indexOf(':');
    if (split <= 0) return null;
    return { type: text.slice(0, split), numeric: text.slice(split + 1) };
  } catch {
    return null;
  }
}

/** Find a repository by its numeric id across the store. */
function repoByNumericId(numeric: string): RepoRec | null {
  const id = Number(numeric);
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}

/** Find an issue/pull record by its global record id. */
function numberedByGlobalId(numeric: string): { repo: RepoRec; rec: NumberedRec } | null {
  const id = Number(numeric);
  for (const repo of repos.values()) {
    for (const rec of repo.numbered.values()) {
      if (rec.id === id) return { repo, rec };
    }
  }
  return null;
}

function commentByGlobalId(numeric: string): { repo: RepoRec; rec: NumberedRec; comment: CommentRec } | null {
  const id = Number(numeric);
  for (const repo of repos.values()) {
    for (const rec of repo.numbered.values()) {
      for (const comment of rec.comments) {
        if (comment.id === id) return { repo, rec, comment };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// GraphQL object wrappers: plain records tagged with their schema type.
// ---------------------------------------------------------------------------

interface GqlObj {
  gqlType: string;
  [key: string]: unknown;
}

function gqlRepo(repo: RepoRec): GqlObj {
  return { gqlType: 'Repository', repo };
}

function gqlIssue(repo: RepoRec, issue: IssueRec): GqlObj {
  return { gqlType: 'Issue', repo, rec: issue };
}

function gqlPull(repo: RepoRec, pull: PullRec): GqlObj {
  return { gqlType: 'PullRequest', repo, rec: pull };
}

function gqlComment(comment: CommentRec): GqlObj {
  return { gqlType: 'IssueComment', comment };
}

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'viewerPermission',
    'hasIssuesEnabled', 'defaultBranchRef', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url',
    'createdAt', 'updatedAt',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'labels', 'comments', 'repository',
    'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'author', 'files', 'comments', 'repository', 'createdAt',
    'updatedAt', 'mergedAt', 'mergeCommit', 'url',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['name', 'target', 'repository'],
  Label: ['id', 'name', 'color', 'description'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
};

// ---------------------------------------------------------------------------
// The executor.
// ---------------------------------------------------------------------------

interface GqlExec {
  variables: Record<string, unknown>;
  defaults: Map<string, GqlValue>;
  fragments: Map<string, { typeCondition: string; selection: GqlSelection[] }>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

function gqlValueOf(value: GqlValue, exec: GqlExec): unknown {
  switch (value.kind) {
    case 'variable': {
      if (value.name in exec.variables) return exec.variables[value.name];
      const fallback = exec.defaults.get(value.name);
      return fallback === undefined ? null : gqlValueOf(fallback, exec);
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => gqlValueOf(item, exec));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = gqlValueOf(field.value, exec);
      return out;
    }
  }
}

function argsObject(field: GqlField, exec: GqlExec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = gqlValueOf(arg.value, exec);
  return out;
}

function directiveSkips(field: GqlField, exec: GqlExec): boolean {
  for (const directive of field.directives) {
    const args: Record<string, unknown> = {};
    for (const arg of directive.args) args[arg.name] = gqlValueOf(arg.value, exec);
    if (directive.name === 'skip' && args.if === true) return true;
    if (directive.name === 'include' && args.if === false) return true;
  }
  return false;
}

/** A connection slice: cursor-paginate a pre-ordered list of nodes. */
function connectionOf(nodes: GqlObj[], args: Record<string, unknown>): GqlObj {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : nodes.length;
  let start = 0;
  if (typeof args.after === 'string') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match !== null) start = Number(match[1]);
    } catch {
      start = 0;
    }
  }
  const slice = nodes.slice(start, start + first);
  const hasNextPage = start + slice.length < nodes.length;
  const endCursor = slice.length > 0 ? Buffer.from(`cursor:${start + slice.length}`, 'utf8').toString('base64') : null;
  return {
    gqlType: 'Connection',
    nodes: slice,
    pageInfo: {
      gqlType: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? Buffer.from(`cursor:${start}`, 'utf8').toString('base64') : null,
      endCursor,
    } satisfies GqlObj,
    totalCount: nodes.length,
    edges: slice.map((node, index) => ({
      gqlType: 'Edge',
      node,
      cursor: Buffer.from(`cursor:${start + index + 1}`, 'utf8').toString('base64'),
    })),
  };
}

function pullMergeable(repo: RepoRec, pull: PullRec): string {
  if (pull.merged) return 'MERGEABLE';
  const preview = pullMergePreview(repo, pull);
  if (preview === null) return 'UNKNOWN';
  return preview.outcome.ok ? 'MERGEABLE' : 'CONFLICTING';
}

function pullState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Resolve one field on one object. Throws nothing; unknown fields error. */
function resolveGqlField(source: GqlObj | null, field: GqlField, exec: GqlExec, path: Array<string | number>): unknown {
  const typeName = source === null ? (exec as unknown as { rootType: string }).rootType : source.gqlType;
  const name = field.name;
  const args = argsObject(field, exec);
  const fail = (message: string): null => {
    exec.errors.push({ message, path: [...path, field.alias ?? field.name] });
    return null;
  };

  if (name === '__typename') return typeName;
  if (name === '__type' && source === null) {
    const typeNameArg = typeof args.name === 'string' ? args.name : '';
    if (GQL_TYPE_FIELDS[typeNameArg] === undefined && GQL_ENUM_VALUES[typeNameArg] === undefined) return null;
    return {
      gqlType: '__Type',
      typeName: typeNameArg,
      kind: GQL_ENUM_VALUES[typeNameArg] !== undefined ? 'ENUM' : 'OBJECT',
    } satisfies GqlObj;
  }

  if (source === null) {
    // Root Query / Mutation fields.
    if (name === 'viewer') return { gqlType: 'User', login: VIEWER_LOGIN } satisfies GqlObj;
    if (name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.name === 'string' ? args.name : '';
      const repo = findRepo(owner, repoName);
      if (repo === null || repo.owner !== VIEWER_LOGIN) return null;
      return gqlRepo(repo);
    }
    if (name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = repoByNumericId(parsed.numeric);
        return repo === null ? null : gqlRepo(repo);
      }
      if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
        const found = numberedByGlobalId(parsed.numeric);
        if (found === null) return null;
        return found.rec.kind === 'issue' ? gqlIssue(found.repo, found.rec) : gqlPull(found.repo, found.rec);
      }
      if (parsed.type === 'IssueComment') {
        const found = commentByGlobalId(parsed.numeric);
        return found === null ? null : gqlComment(found.comment);
      }
      if (parsed.type === 'User') return { gqlType: 'User', login: VIEWER_LOGIN } satisfies GqlObj;
      return null;
    }
    if (name === 'createIssue') return gqlCreateIssue(args, exec, field);
    if (name === 'closeIssue') return gqlCloseIssue(args);
    if (name === 'createPullRequest') return gqlCreatePullRequest(args);
    if (name === 'mergePullRequest') return gqlMergePullRequest(args);
    if (name === 'addComment') return gqlAddComment(args);
    return fail(`Field '${name}' doesn't exist on type '${typeName}'`);
  }

  // Mutation payloads are plain bags: their fields are the stored values.
  if (source.gqlType.endsWith('Payload') && name in source) {
    return source[name];
  }

  switch (source.gqlType) {
    case 'User':
      if (name === 'login') return source.login as string;
      if (name === 'id') return globalId('User', VIEWER_ID);
      if (name === 'name') return source.login as string;
      if (name === 'email') return `${source.login as string}@example.invalid`;
      if (name === 'url') return '';
      break;
    case 'Repository':
      return resolveRepoField(source.repo as RepoRec, name, args, exec, field, path);
    case 'Issue': {
      const issue = source.rec as IssueRec;
      const repo = source.repo as RepoRec;
      if (name === 'id') return globalId('Issue', issue.id);
      if (name === 'databaseId') return issue.id;
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'author') return { gqlType: 'User', login: VIEWER_LOGIN } satisfies GqlObj;
      if (name === 'repository') return gqlRepo(repo);
      if (name === 'createdAt') return isoOf(issue.createdSec);
      if (name === 'updatedAt') return isoOf(issue.updatedSec);
      if (name === 'closedAt') return issue.state === 'closed' ? isoOf(issue.updatedSec) : null;
      if (name === 'url') return '';
      if (name === 'labels') {
        return connectionOf(
          issue.labels
            .map((labelName) => repo.labels.get(labelName.toLowerCase()))
            .filter((label): label is LabelRec => label !== undefined)
            .map((label) => ({ gqlType: 'Label', label }) satisfies GqlObj),
          args,
        );
      }
      if (name === 'comments') {
        return connectionOf(issue.comments.map(gqlComment), args);
      }
      break;
    }
    case 'PullRequest': {
      const pull = source.rec as PullRec;
      const repo = source.repo as RepoRec;
      if (name === 'id') return globalId('PullRequest', pull.id);
      if (name === 'databaseId') return pull.id;
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pullState(pull);
      if (name === 'merged') return pull.merged;
      if (name === 'mergeable') return pullMergeable(repo, pull);
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'author') return { gqlType: 'User', login: VIEWER_LOGIN } satisfies GqlObj;
      if (name === 'repository') return gqlRepo(repo);
      if (name === 'createdAt') return isoOf(pull.createdSec);
      if (name === 'updatedAt') return isoOf(pull.updatedSec);
      if (name === 'mergedAt') return pull.mergedAtSec === null ? null : isoOf(pull.mergedAtSec);
      if (name === 'mergeCommit') {
        return pull.mergeCommitSha === null ? null : ({ gqlType: 'Commit', sha: pull.mergeCommitSha } satisfies GqlObj);
      }
      if (name === 'headRef' || name === 'baseRef') {
        const branch = name === 'headRef' ? pull.headRef : pull.baseRef;
        const tip = branchTip(repo, branch);
        return tip === null ? null : ({ gqlType: 'Ref', name: branch, sha: tip, repo } satisfies GqlObj);
      }
      if (name === 'files') {
        const headTip = branchTip(repo, pull.headRef) ?? pull.headShaAtOpen;
        const baseTip = branchTip(repo, pull.baseRef);
        const base = baseTip === null ? null : (mergeBaseOf(baseTip, headTip) ?? baseTip);
        const files = diffCommits(base, headTip).map(
          (change) =>
            ({
              gqlType: 'PullRequestFile',
              path: change.filename,
              additions: change.additions,
              deletions: change.deletions,
              changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
            }) satisfies GqlObj,
        );
        return connectionOf(files, args);
      }
      if (name === 'comments') return connectionOf(pull.comments.map(gqlComment), args);
      if (name === 'url') return '';
      break;
    }
    case 'IssueComment': {
      const comment = source.comment as CommentRec;
      if (name === 'id') return globalId('IssueComment', comment.id);
      if (name === 'databaseId') return comment.id;
      if (name === 'body') return comment.body;
      if (name === 'author') return { gqlType: 'User', login: comment.authorLogin } satisfies GqlObj;
      if (name === 'createdAt') return isoOf(comment.createdSec);
      if (name === 'updatedAt') return isoOf(comment.createdSec);
      if (name === 'url') return '';
      break;
    }
    case 'Ref':
      if (name === 'name') return source.name as string;
      if (name === 'target') return { gqlType: 'Commit', sha: source.sha as string } satisfies GqlObj;
      if (name === 'repository') return gqlRepo(source.repo as RepoRec);
      break;
    case 'Commit':
      if (name === 'id') return globalId('Commit', source.sha as string);
      if (name === 'oid') return source.sha as string;
      if (name === 'message') return getCommit(source.sha as string)?.message ?? '';
      break;
    case 'Label': {
      const label = source.label as LabelRec;
      if (name === 'id') return globalId('Label', label.name);
      if (name === 'name') return label.name;
      if (name === 'color') return label.color;
      if (name === 'description') return label.description;
      break;
    }
    case 'PullRequestFile':
      if (name === 'path' || name === 'additions' || name === 'deletions' || name === 'changeType') return source[name];
      break;
    case 'PageInfo':
      if (name === 'hasNextPage' || name === 'hasPreviousPage' || name === 'startCursor' || name === 'endCursor') return source[name];
      break;
    case 'Connection':
      if (name === 'nodes') return source.nodes as GqlObj[];
      if (name === 'edges') return source.edges as GqlObj[];
      if (name === 'pageInfo') return source.pageInfo as GqlObj;
      if (name === 'totalCount') return source.totalCount as number;
      break;
    case 'Edge':
      if (name === 'node') return source.node as GqlObj;
      if (name === 'cursor') return source.cursor as string;
      break;
    case '__Type': {
      const typeName = source.typeName as string;
      if (name === 'name') return typeName;
      if (name === 'kind') return source.kind as string;
      if (name === 'fields') {
        return (GQL_TYPE_FIELDS[typeName] ?? []).map((fieldName) => ({ gqlType: '__Field', fieldName }) satisfies GqlObj);
      }
      if (name === 'enumValues') {
        return (GQL_ENUM_VALUES[typeName] ?? []).map((valueName) => ({ gqlType: '__EnumValue', valueName }) satisfies GqlObj);
      }
      break;
    }
    case '__Field':
      if (name === 'name') return source.fieldName as string;
      break;
    case '__EnumValue':
      if (name === 'name') return source.valueName as string;
      break;
    default:
      break;
  }
  return fail(`Field '${name}' doesn't exist on type '${typeName}'`);
}

function resolveRepoField(repo: RepoRec, name: string, args: Record<string, unknown>, exec: GqlExec, field: GqlField, path: Array<string | number>): unknown {
  switch (name) {
    case 'id':
      return globalId('Repository', repo.id);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.isPrivate;
    case 'owner':
      return { gqlType: 'User', login: repo.owner } satisfies GqlObj;
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'defaultBranchRef': {
      const tip = branchTip(repo, repo.defaultBranch);
      return tip === null ? null : ({ gqlType: 'Ref', name: repo.defaultBranch, sha: tip, repo } satisfies GqlObj);
    }
    case 'createdAt':
      return isoOf(repo.createdSec);
    case 'updatedAt':
      return isoOf(repo.createdSec);
    case 'url':
      return '';
    case 'issue': {
      const number = typeof args.number === 'number' ? args.number : -1;
      const rec = repo.numbered.get(number);
      if (rec === undefined) return null;
      return rec.kind === 'issue' ? gqlIssue(repo, rec) : gqlPull(repo, rec);
    }
    case 'issues': {
      let list = [...repo.numbered.values()].filter((rec) => rec.kind === 'issue') as IssueRec[];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states !== null) {
        list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
      const descending = orderBy !== null && orderBy.direction === 'DESC';
      list.sort((a, b) => (a.number - b.number) * (descending ? -1 : 1));
      return connectionOf(list.map((issue) => gqlIssue(repo, issue)), args);
    }
    case 'pullRequest': {
      const number = typeof args.number === 'number' ? args.number : -1;
      const rec = repo.numbered.get(number);
      if (rec === undefined || rec.kind !== 'pull') return null;
      return gqlPull(repo, rec);
    }
    case 'pullRequests': {
      let list = [...repo.numbered.values()].filter((rec) => rec.kind === 'pull') as PullRec[];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states !== null) list = list.filter((pull) => states.includes(pullState(pull)));
      list.sort((a, b) => a.number - b.number);
      return connectionOf(list.map((pull) => gqlPull(repo, pull)), args);
    }
    default: {
      exec.errors.push({
        message: `Field '${name}' doesn't exist on type 'Repository'`,
        path: [...path, field.alias ?? field.name],
      });
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// GraphQL mutations, sharing the REST domain logic.
// ---------------------------------------------------------------------------

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  return isRecord(args.input) ? args.input : {};
}

function gqlCreateIssue(args: Record<string, unknown>, exec: GqlExec, field: GqlField): unknown {
  const input = inputOf(args);
  const repoId = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
  const repo = repoId !== null && repoId.type === 'Repository' ? repoByNumericId(repoId.numeric) : null;
  if (repo === null) {
    exec.errors.push({ message: 'Could not resolve repository', path: [field.alias ?? field.name] });
    return null;
  }
  const title = typeof input.title === 'string' ? input.title : '';
  const sec = tickSec();
  const issue: IssueRec = {
    kind: 'issue',
    id: nextRecordId,
    number: repo.nextNumber,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    comments: [],
    createdSec: sec,
    updatedSec: sec,
  };
  nextRecordId += 1;
  repo.nextNumber += 1;
  repo.numbered.set(issue.number, issue);
  return { gqlType: 'CreateIssuePayload', issue: gqlIssue(repo, issue) } satisfies GqlObj;
}

function gqlCloseIssue(args: Record<string, unknown>): unknown {
  const input = inputOf(args);
  const id = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
  const found = id !== null ? numberedByGlobalId(id.numeric) : null;
  if (found === null || found.rec.kind !== 'issue') return null;
  found.rec.state = 'closed';
  found.rec.updatedSec = tickSec();
  return { gqlType: 'CloseIssuePayload', issue: gqlIssue(found.repo, found.rec) } satisfies GqlObj;
}

function gqlCreatePullRequest(args: Record<string, unknown>): unknown {
  const input = inputOf(args);
  const repoId = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
  const repo = repoId !== null && repoId.type === 'Repository' ? repoByNumericId(repoId.numeric) : null;
  if (repo === null) return null;
  const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
  const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const headTip = branchTip(repo, headRef);
  if (headTip === null || branchTip(repo, baseRef) === null) return null;
  const sec = tickSec();
  const pull: PullRec = {
    kind: 'pull',
    id: nextRecordId,
    number: repo.nextNumber,
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    headRef,
    headShaAtOpen: headTip,
    baseRef,
    merged: false,
    mergedAtSec: null,
    mergeCommitSha: null,
    comments: [],
    createdSec: sec,
    updatedSec: sec,
  };
  nextRecordId += 1;
  repo.nextNumber += 1;
  repo.numbered.set(pull.number, pull);
  return { gqlType: 'CreatePullRequestPayload', pullRequest: gqlPull(repo, pull) } satisfies GqlObj;
}

function gqlMergePullRequest(args: Record<string, unknown>): unknown {
  const input = inputOf(args);
  const id = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
  const found = id !== null ? numberedByGlobalId(id.numeric) : null;
  if (found === null || found.rec.kind !== 'pull') return null;
  const { repo } = found;
  const pull = found.rec;
  if (!pull.merged && pull.state === 'open') {
    const preview = pullMergePreview(repo, pull);
    if (preview !== null && preview.outcome.ok && !isAncestor(preview.headTip, preview.baseTip)) {
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
      const treeSha = storeTreeFromFiles(preview.outcome.files);
      let mergeSha: string;
      if (method === 'SQUASH') {
        mergeSha = makeApiCommit(repo, treeSha, [preview.baseTip], `${pull.title} (#${pull.number})`);
      } else if (method === 'REBASE' && isAncestor(preview.baseTip, preview.headTip)) {
        mergeSha = preview.headTip;
      } else {
        mergeSha = makeApiCommit(repo, treeSha, [preview.baseTip, preview.headTip], `Merge pull request #${pull.number}`);
      }
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAtSec = tickSec();
      pull.updatedSec = pull.mergedAtSec;
      pull.mergeCommitSha = mergeSha;
    }
  }
  return { gqlType: 'MergePullRequestPayload', pullRequest: gqlPull(repo, pull) } satisfies GqlObj;
}

function gqlAddComment(args: Record<string, unknown>): unknown {
  const input = inputOf(args);
  const id = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
  const found = id !== null ? numberedByGlobalId(id.numeric) : null;
  if (found === null) return null;
  const comment: CommentRec = {
    id: nextCommentId,
    body: typeof input.body === 'string' ? input.body : '',
    authorLogin: VIEWER_LOGIN,
    createdSec: tickSec(),
  };
  nextCommentId += 1;
  found.rec.comments.push(comment);
  found.rec.updatedSec = comment.createdSec;
  return {
    gqlType: 'AddCommentPayload',
    commentEdge: { gqlType: 'Edge', node: gqlComment(comment), cursor: '' } satisfies GqlObj,
  } satisfies GqlObj;
}

/** Complete a resolved value against a selection set. */
function completeGqlValue(value: unknown, selection: GqlSelection[] | null, exec: GqlExec, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (selection === null) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeGqlValue(item, selection, exec, [...path, index]));
  }
  if (isRecord(value) && typeof value.gqlType === 'string') {
    return executeSelectionSet(value as GqlObj, selection, exec, path);
  }
  return value;
}

function executeSelectionSet(source: GqlObj | null, selections: GqlSelection[], exec: GqlExec, path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = exec.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (source !== null && fragment.typeCondition !== source.gqlType) continue;
      Object.assign(out, executeSelectionSet(source, fragment.selection, exec, path));
      continue;
    }
    if (selection.kind === 'inline') {
      if (source !== null && selection.typeCondition !== null && selection.typeCondition !== source.gqlType) continue;
      Object.assign(out, executeSelectionSet(source, selection.selection, exec, path));
      continue;
    }
    if (directiveSkips(selection, exec)) continue;
    const key = selection.alias ?? selection.name;
    const resolved = resolveGqlField(source, selection, exec, path);
    out[key] = completeGqlValue(resolved, selection.selection, exec, [...path, key]);
  }
  return out;
}

function runGraphQL(document: string, variables: Record<string, unknown>, operationName: string | null): Record<string, unknown> {
  const parsed = new GqlParser(document).parseDocument();
  const operation =
    parsed.operations.find((candidate) => operationName === null || candidate.name === operationName) ?? parsed.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const exec: GqlExec & { rootType: string } = {
    variables,
    defaults: operation.variableDefaults,
    fragments: parsed.fragments,
    errors: [],
    rootType: operation.type === 'mutation' ? 'Mutation' : 'Query',
  };
  const data = executeSelectionSet(null, operation.selection, exec, []);
  const envelope: Record<string, unknown> = { data };
  if (exec.errors.length > 0) envelope.errors = exec.errors;
  return envelope;
}

function handleGraphQL(ctx: Ctx): void {
  if (!isAuthed(ctx)) {
    sendError(ctx, 401, 'Requires authentication');
    return;
  }
  if (ctx.method !== 'POST') {
    sendError(ctx, 405, 'Method Not Allowed');
    return;
  }
  if (ctx.jsonMalformed) {
    sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const respondOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { errors: [{ message: 'A GraphQL operation needs a query string' }] };
    }
    const variables = isRecord(entry.variables) ? entry.variables : {};
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
    try {
      return runGraphQL(entry.query, variables, operationName);
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
    }
  };
  if (Array.isArray(ctx.json)) {
    sendJson(ctx, 200, ctx.json.map(respondOne));
    return;
  }
  sendJson(ctx, 200, respondOne(ctx.json));
}

// ---------------------------------------------------------------------------
// MCP: the Model Context Protocol endpoint at /mcp. Stateless per request;
// both protocol eras are served -- the modern server/discover handshake and
// the legacy initialize handshake -- over one tool set backed by the store.
// ---------------------------------------------------------------------------

const MCP_SERVER_INFO = { name: 'forge', version: '1.0.0' };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name (or by full_name "owner/repo").',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The "owner/repo" full name.' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The "owner/repo" full name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The "owner/repo" full name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The "owner/repo" full name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The "owner/repo" full name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        number: { type: 'integer', description: 'The pull request number (alias).' },
        merge_method: { type: 'string', description: 'merge, squash or rebase.' },
      },
      required: [],
    },
  },
];

class ToolFailure extends Error {}

function mcpStringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Resolve the repository an MCP tool call names, GitHub-MCP style. */
function mcpRepoArg(args: Record<string, unknown>): RepoRec | null {
  let owner = mcpStringArg(args, 'owner');
  let name = mcpStringArg(args, 'repo');
  const fullName = mcpStringArg(args, 'full_name');
  if (fullName !== null && fullName.includes('/')) {
    const split = fullName.indexOf('/');
    owner = fullName.slice(0, split);
    name = fullName.slice(split + 1);
  }
  if (name === null) return null;
  const repo = findRepo(owner ?? VIEWER_LOGIN, name);
  return repo !== null && repo.owner === VIEWER_LOGIN ? repo : null;
}

function mcpToolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
    resultType: 'complete',
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    resultType: 'complete',
  };
}

function runMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  switch (name) {
    case 'create_repo': {
      const repoName = mcpStringArg(args, 'name') ?? mcpStringArg(args, 'repo');
      if (repoName === null) return mcpToolError('create_repo needs a repository name');
      const existing = findRepo(VIEWER_LOGIN, repoName);
      if (existing !== null) return mcpToolResult(repoJson(existing));
      const repo = createRepo(
        VIEWER_LOGIN,
        repoName,
        mcpStringArg(args, 'description') ?? '',
        args.private === true,
      );
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = mcpRepoArg(args);
      if (repo === null) return mcpToolError('repository not found');
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = mcpRepoArg(args);
      if (repo === null) return mcpToolError('repository not found');
      const title = mcpStringArg(args, 'title');
      if (title === null) return mcpToolError('create_issue needs a title');
      const labelBody: Record<string, unknown> = { labels: args.labels };
      const badLabel = labelError(repo, labelBody);
      if (badLabel !== null) return mcpToolError(badLabel);
      const sec = tickSec();
      const issue: IssueRec = {
        kind: 'issue',
        id: nextRecordId,
        number: repo.nextNumber,
        title,
        body: mcpStringArg(args, 'body') ?? '',
        state: 'open',
        labels: labelNamesOf(repo, labelBody),
        comments: [],
        createdSec: sec,
        updatedSec: sec,
      };
      nextRecordId += 1;
      repo.nextNumber += 1;
      repo.numbered.set(issue.number, issue);
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = mcpRepoArg(args);
      if (repo === null) return mcpToolError('repository not found');
      const state = mcpStringArg(args, 'state') ?? 'open';
      let list = [...repo.numbered.values()].filter((rec) => rec.kind === 'issue') as IssueRec[];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => a.number - b.number);
      return mcpToolResult(list.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = mcpRepoArg(args);
      if (repo === null) return mcpToolError('repository not found');
      const title = mcpStringArg(args, 'title');
      const head = mcpStringArg(args, 'head');
      const base = mcpStringArg(args, 'base');
      if (title === null || head === null || base === null) {
        return mcpToolError('create_pull_request needs title, head and base');
      }
      const headTip = branchTip(repo, head);
      if (headTip === null) return mcpToolError(`head branch ${head} does not exist`);
      if (branchTip(repo, base) === null) return mcpToolError(`base branch ${base} does not exist`);
      const sec = tickSec();
      const pull: PullRec = {
        kind: 'pull',
        id: nextRecordId,
        number: repo.nextNumber,
        title,
        body: mcpStringArg(args, 'body') ?? '',
        state: 'open',
        headRef: head,
        headShaAtOpen: headTip,
        baseRef: base,
        merged: false,
        mergedAtSec: null,
        mergeCommitSha: null,
        comments: [],
        createdSec: sec,
        updatedSec: sec,
      };
      nextRecordId += 1;
      repo.nextNumber += 1;
      repo.numbered.set(pull.number, pull);
      return mcpToolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = mcpRepoArg(args);
      if (repo === null) return mcpToolError('repository not found');
      const rawNumber = args.pull_number ?? args.number;
      const number = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number(rawNumber) : NaN;
      if (!Number.isSafeInteger(number) || number <= 0) return mcpToolError('merge_pull_request needs a pull_number');
      const rec = repo.numbered.get(number);
      if (rec === undefined || rec.kind !== 'pull') return mcpToolError(`pull request ${number} not found`);
      if (rec.merged) {
        return mcpToolResult({ ...pullJson(repo, rec), merged: true, sha: rec.mergeCommitSha });
      }
      if (rec.state !== 'open') return mcpToolError('pull request is not open');
      const preview = pullMergePreview(repo, rec);
      if (preview === null || !preview.outcome.ok || isAncestor(preview.headTip, preview.baseTip)) {
        return mcpToolError('pull request is not mergeable');
      }
      const method = (mcpStringArg(args, 'merge_method') ?? 'merge').toLowerCase();
      const treeSha = storeTreeFromFiles(preview.outcome.files);
      let mergeSha: string;
      if (method === 'squash') {
        mergeSha = makeApiCommit(repo, treeSha, [preview.baseTip], `${rec.title} (#${rec.number})`);
      } else if (method === 'rebase' && isAncestor(preview.baseTip, preview.headTip)) {
        mergeSha = preview.headTip;
      } else {
        mergeSha = makeApiCommit(repo, treeSha, [preview.baseTip, preview.headTip], `Merge pull request #${rec.number} from ${repo.owner}:${rec.headRef}`);
      }
      repo.refs.set(`refs/heads/${rec.baseRef}`, mergeSha);
      rec.merged = true;
      rec.state = 'closed';
      rec.mergedAtSec = tickSec();
      rec.updatedSec = rec.mergedAtSec;
      rec.mergeCommitSha = mergeSha;
      return mcpToolResult({ ...pullJson(repo, rec), merged: true, sha: mergeSha });
    }
    default:
      return null;
  }
}

interface RpcOutcome {
  response: Record<string, unknown> | null; // null: a notification, answer 202
}

function processRpcMessage(message: unknown): RpcOutcome {
  if (!isRecord(message) || typeof message.method !== 'string') {
    return {
      response: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const method = message.method;
  const hasId = 'id' in message;
  const id = (message.id ?? null) as string | number | null;
  const params = isRecord(message.params) ? message.params : {};
  const ok = (result: unknown): RpcOutcome => ({ response: { jsonrpc: '2.0', id, result } });
  const err = (code: number, text: string): RpcOutcome => ({
    response: { jsonrpc: '2.0', id, error: { code, message: text } },
  });

  if (!hasId) return { response: null }; // a notification: nothing to answer

  switch (method) {
    case 'server/discover':
      return ok({
        resultType: 'complete',
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        instructions: 'A GitHub-compatible forge: repository, issue and pull request tools.',
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return ok({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: MCP_TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = isRecord(params.arguments) ? params.arguments : {};
      const known = MCP_TOOLS.some((tool) => tool.name === toolName);
      if (!known) return err(-32602, `Unknown tool: ${toolName}`);
      try {
        const result = runMcpTool(toolName, toolArgs);
        if (result === null) return err(-32602, `Unknown tool: ${toolName}`);
        return ok(result);
      } catch (error) {
        if (error instanceof ToolFailure) return ok(mcpToolError(error.message));
        throw error;
      }
    }
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

function handleMcp(ctx: Ctx): void {
  if (ctx.method === 'DELETE') {
    sendEmpty(ctx, 200);
    return;
  }
  if (ctx.method !== 'POST') {
    sendError(ctx, 405, 'Method Not Allowed');
    return;
  }
  if (!isAuthed(ctx)) {
    sendError(ctx, 401, 'Requires authentication');
    return;
  }
  if (ctx.jsonMalformed) {
    // JSON-RPC's parse error, with the HTTP 400 the modern era demands.
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      'utf8',
    );
    ctx.res.writeHead(400, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'x-github-request-id': requestId(),
    });
    ctx.res.end(body);
    return;
  }
  if (Array.isArray(ctx.json)) {
    const responses: Array<Record<string, unknown>> = [];
    for (const entry of ctx.json) {
      const outcome = processRpcMessage(entry);
      if (outcome.response !== null) responses.push(outcome.response);
    }
    sendJson(ctx, 200, responses);
    return;
  }
  const outcome = processRpcMessage(ctx.json);
  if (outcome.response === null) {
    ctx.res.writeHead(202, { 'x-github-request-id': requestId() });
    ctx.res.end();
    return;
  }
  sendJson(ctx, 200, outcome.response);
}

// ---------------------------------------------------------------------------
// Lifecycle: bind an ephemeral port, register with the harness, serve until
// it answers done, exit 0. Without MAKEFUN_ENV_URL the forge just serves
// (a developer's local run).
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerAndPoll(envUrl: string, port: number): Promise<void> {
  const base = envUrl.replace(/\/+$/, '');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) break;
    } catch {
      // The harness may still be binding; keep trying inside the boot budget.
    }
    await sleep(250);
  }
  for (;;) {
    try {
      const response = await fetch(`${base}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) {
          process.exit(0);
        }
      }
    } catch {
      // A dropped poll is not the end; the harness decides when we are done.
    }
    await sleep(200);
  }
}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch(() => {
    try {
      res.end();
    } catch {
      // The socket is already gone; nothing to salvage.
    }
  });
});

process.on('SIGTERM', () => process.exit(0));

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
  if (envUrl !== '' && port > 0) {
    void registerAndPoll(envUrl, port);
  }
});
