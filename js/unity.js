// Minimal Unity asset bundle reader (UnityFS + SerializedFile v22 + TypeTree) for the browser.
// Covers what the Pokemon HOME bundles use: UnityFS v8, LZ4/LZ4HC blocks, typetrees embedded.
import { COMMON_STRINGS } from './commonstrings.js';

// ------------------------------------------------------------------ LZ4 (block format)
export function lz4Decompress(src, outSize) {
  const dst = new Uint8Array(outSize);
  let si = 0, di = 0;
  const n = src.length;
  while (si < n) {
    const token = src[si++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[si++]; lit += b; } while (b === 255); }
    dst.set(src.subarray(si, si + lit), di); si += lit; di += lit;
    if (si >= n) break;
    const off = src[si] | (src[si + 1] << 8); si += 2;
    let ml = token & 15;
    if (ml === 15) { let b; do { b = src[si++]; ml += b; } while (b === 255); }
    ml += 4;
    let from = di - off;
    if (off >= ml) { dst.copyWithin(di, from, from + ml); di += ml; }
    else { for (let k = 0; k < ml; k++) dst[di++] = dst[from++]; }
  }
  return di === outSize ? dst : dst.subarray(0, di);
}

// ------------------------------------------------------------------ binary reader
class Reader {
  constructor(u8, little = true) {
    this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.p = 0; this.le = little;
  }
  u8_() { return this.u8[this.p++]; }
  i8() { const v = this.dv.getInt8(this.p); this.p += 1; return v; }
  u16() { const v = this.dv.getUint16(this.p, this.le); this.p += 2; return v; }
  i16() { const v = this.dv.getInt16(this.p, this.le); this.p += 2; return v; }
  u32() { const v = this.dv.getUint32(this.p, this.le); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p, this.le); this.p += 4; return v; }
  i64() { const v = this.dv.getBigInt64(this.p, this.le); this.p += 8; return v; }
  u64() { const v = this.dv.getBigUint64(this.p, this.le); this.p += 8; return v; }
  f32() { const v = this.dv.getFloat32(this.p, this.le); this.p += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.p, this.le); this.p += 8; return v; }
  bytes(n) { const b = this.u8.subarray(this.p, this.p + n); this.p += n; return b; }
  cstr() { let e = this.p; while (this.u8[e] !== 0) e++; const s = utf8(this.u8.subarray(this.p, e)); this.p = e + 1; return s; }
  align(n = 4) { const r = this.p % n; if (r) this.p += n - r; }
}
const _td = new TextDecoder('utf-8');
const utf8 = b => _td.decode(b);

// ------------------------------------------------------------------ UnityFS bundle
export function readBundle(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(u8, false);
  const sig = r.cstr();
  if (sig !== 'UnityFS') throw new Error('not a UnityFS bundle: ' + sig);
  const version = r.u32(); r.cstr(); r.cstr();
  r.i64();
  const cbi = r.u32(), ubi = r.u32(), flags = r.u32();
  if (version >= 7) r.align(16);
  let biRaw;
  if (flags & 0x80) { biRaw = u8.subarray(u8.length - cbi); }
  else { biRaw = r.bytes(cbi); }
  const bi = decompress(biRaw, ubi, flags & 0x3f);
  const br = new Reader(bi, false);
  br.p += 16;
  const nBlocks = br.i32();
  const blocks = [];
  for (let i = 0; i < nBlocks; i++) blocks.push({ u: br.u32(), c: br.u32(), f: br.u16() });
  const nNodes = br.i32();
  const nodes = [];
  for (let i = 0; i < nNodes; i++) {
    const off = Number(br.i64()), size = Number(br.i64()); const f = br.u32(); const path = br.cstr();
    nodes.push({ off, size, f, path });
  }
  if (flags & 0x200) r.align(16);
  // decompress all blocks into one buffer
  const total = blocks.reduce((a, b) => a + b.u, 0);
  const data = new Uint8Array(total);
  let di = 0;
  for (const b of blocks) {
    const src = r.bytes(b.c);
    data.set(decompress(src, b.u, b.f & 0x3f), di); di += b.u;
  }
  const files = {};
  for (const nd of nodes) files[nd.path] = data.subarray(nd.off, nd.off + nd.size);
  return { files, nodes };
}
function decompress(src, size, comp) {
  if (comp === 0) return src;
  if (comp === 2 || comp === 3) return lz4Decompress(src, size);
  throw new Error('unsupported bundle compression ' + comp + ' (LZMA not implemented)');
}

// ------------------------------------------------------------------ SerializedFile
export class SerializedFile {
  constructor(name, u8, env) {
    this.name = name; this.env = env;
    const r = new Reader(u8, false);
    r.u32(); r.u32(); const version = r.u32(); r.u32();
    this.version = version;
    if (version < 22) throw new Error('SerializedFile version ' + version + ' not supported');
    const endian = r.u8_(); r.p += 3;
    r.u32(); r.i64(); const dataOffset = Number(r.i64()); r.i64();
    r.le = endian === 0;
    this.unityVersion = r.cstr();
    this.platform = r.i32();
    const typeTreeOn = r.u8_() !== 0;
    const typeCount = r.i32();
    this.types = [];
    for (let i = 0; i < typeCount; i++) this.types.push(readSerializedType(r, version, typeTreeOn, false));
    const objCount = r.i32();
    this.objects = new Map();
    this.objectList = [];
    for (let i = 0; i < objCount; i++) {
      r.align(4);
      const pathID = r.i64();
      const start = Number(r.i64()) + dataOffset;
      const size = r.u32();
      const typeIdx = r.i32();
      const t = this.types[typeIdx];
      const o = { file: this, pathID, start, size, type: t, classID: t.classID };
      this.objects.set(pathID, o); this.objectList.push(o);
    }
    const scriptCount = r.i32();
    for (let i = 0; i < scriptCount; i++) { r.i32(); r.align(4); r.i64(); }
    const extCount = r.i32();
    this.externals = [];
    for (let i = 0; i < extCount; i++) { r.cstr(); r.p += 16; r.i32(); this.externals.push(r.cstr()); }
    this.u8 = u8;
    this.le = r.le;
  }
  read(obj) {
    if (obj._v) return obj._v;
    const r = new Reader(this.u8.subarray(obj.start, obj.start + obj.size), this.le);
    obj._v = readTypeTree(r, obj.type.nodes, 0).value;
    return obj._v;
  }
  // resolve a PPtr {m_FileID, m_PathID} -> object descriptor (or null)
  resolve(pptr) {
    if (!pptr) return null;
    const pid = typeof pptr.m_PathID === 'bigint' ? pptr.m_PathID : BigInt(pptr.m_PathID || 0);
    if (pid === 0n) return null;
    let f = this;
    if (pptr.m_FileID) {
      const ext = this.externals[pptr.m_FileID - 1];
      f = ext ? this.env.fileByExternal(ext) : null;
      if (!f) return null;
    }
    return f.objects.get(pid) || null;
  }
}

function readSerializedType(r, version, typeTreeOn, isRef) {
  const t = { classID: r.i32() };
  r.u8_();                      // isStrippedType
  t.scriptTypeIndex = r.i16();
  if (isRef || t.classID === 114) r.p += 16;   // script id
  r.p += 16;                    // old type hash
  if (typeTreeOn) {
    t.nodes = readTypeTreeBlob(r, version);
    if (version >= 21) {
      if (isRef) { r.cstr(); r.cstr(); r.cstr(); }
      else { const n = r.i32(); r.p += 4 * n; }
    }
  }
  return t;
}

function readTypeTreeBlob(r, version) {
  const n = r.i32(), strSize = r.i32();
  const raw = [];
  for (let i = 0; i < n; i++) {
    const nd = { version: r.u16(), level: r.u8_(), flags: r.u8_(), typeOff: r.u32(), nameOff: r.u32(),
      size: r.i32(), index: r.i32(), meta: r.i32() };
    if (version >= 19) r.p += 8;
    raw.push(nd);
  }
  const strs = r.bytes(strSize);
  const str = off => {
    if (off & 0x80000000) return COMMON_STRINGS[off & 0x7fffffff] ?? String(off & 0x7fffffff);
    let e = off; while (strs[e] !== 0) e++; return utf8(strs.subarray(off, e));
  };
  for (const nd of raw) { nd.type = str(nd.typeOff); nd.name = str(nd.nameOff); }
  // build children lists by level
  const stack = [];
  for (const nd of raw) {
    nd.children = [];
    while (stack.length && stack[stack.length - 1].level >= nd.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(nd);
    stack.push(nd);
  }
  return raw[0];
}

// ------------------------------------------------------------------ TypeTree value reader
const PRIM = {
  bool: r => r.u8_() !== 0, SInt8: r => r.i8(), UInt8: r => r.u8_(), char: r => r.u8_(),
  short: r => r.i16(), SInt16: r => r.i16(), 'unsigned short': r => r.u16(), UInt16: r => r.u16(),
  int: r => r.i32(), SInt32: r => r.i32(), 'unsigned int': r => r.u32(), UInt32: r => r.u32(), 'Type*': r => r.u32(),
  'long long': r => r.i64(), SInt64: r => r.i64(), 'unsigned long long': r => r.u64(), UInt64: r => r.u64(), FileSize: r => r.u64(),
  float: r => r.f32(), double: r => r.f64(),
};
const TYPED = {   // fast paths for arrays of primitives
  UInt8: [Uint8Array, 1], char: [Uint8Array, 1], SInt8: [Int8Array, 1], bool: [Uint8Array, 1],
  float: [Float32Array, 4], int: [Int32Array, 4], SInt32: [Int32Array, 4], UInt32: [Uint32Array, 4], 'unsigned int': [Uint32Array, 4],
  SInt16: [Int16Array, 2], short: [Int16Array, 2], UInt16: [Uint16Array, 2], 'unsigned short': [Uint16Array, 2],
};

function readTypeTree(r, node) {
  let value;
  let align = (node.meta & 0x4000) !== 0;
  const t = node.type;
  if (PRIM[t] && node.children.length === 0) {
    value = PRIM[t](r);
  } else if (t === 'string') {
    const len = r.i32(); value = utf8(r.bytes(len));
    if (node.children[0] && (node.children[0].meta & 0x4000)) align = true;
  } else if (t === 'TypelessData') {
    const len = r.i32(); value = r.bytes(len);
  } else if (node.children.length === 1 && node.children[0].type === 'Array' || (node.flags & 1)) {
    const arr = (node.flags & 1) ? node : node.children[0];
    if (arr.meta & 0x4000) align = true;
    value = readArray(r, arr);
  } else if (t === 'pair' && node.children.length === 2) {
    value = [readTypeTree(r, node.children[0]).value, readTypeTree(r, node.children[1]).value];
  } else {
    value = {};
    for (const c of node.children) value[c.name] = readTypeTree(r, c).value;
  }
  if (align) r.align(4);
  return { value };
}

function readArray(r, arr) {
  const n = r.i32();
  const elem = arr.children[1];
  const tp = TYPED[elem.type];
  if (tp && elem.children.length === 0) {
    const [C, sz] = tp;
    const bytes = r.bytes(n * sz);
    if (bytes.byteOffset % sz === 0) return new C(bytes.buffer, bytes.byteOffset, n);
    return new C(bytes.slice().buffer, 0, n);
  }
  const out = new Array(n);
  if (elem.type === 'pair' && elem.children.length === 2) {
    for (let i = 0; i < n; i++) out[i] = [readTypeTree(r, elem.children[0]).value, readTypeTree(r, elem.children[1]).value];
  } else {
    for (let i = 0; i < n; i++) out[i] = readTypeTree(r, elem).value;
  }
  return out;
}

// ------------------------------------------------------------------ environment (several bundles loaded together)
export class Env {
  constructor() { this.files = new Map(); this.resources = new Map(); }
  addBundle(buf) {
    const b = readBundle(buf);
    for (const [path, data] of Object.entries(b.files)) {
      const key = path.toLowerCase();
      if (/\.res[s]?$/.test(key)) { this.resources.set(key, data); continue; }
      const sf = new SerializedFile(path, data, this);
      this.files.set(key, sf);
    }
    return b;
  }
  fileByExternal(ext) {
    const k = ext.toLowerCase().split('/').pop();
    return this.files.get(k) || null;
  }
  resource(path) {
    const k = path.toLowerCase().split('/').pop();
    return this.resources.get(k) || null;
  }
  *objects() { for (const f of this.files.values()) yield* f.objectList; }
  read(o) { return o.file.read(o); }
}

// class IDs
export const CID = { GameObject: 1, Transform: 4, Material: 21, MeshRenderer: 23, Texture2D: 28, MeshFilter: 33, Mesh: 43,
  Shader: 48, TextAsset: 49, AnimationClip: 74, Animator: 95, MonoBehaviour: 114, SkinnedMeshRenderer: 137, AssetBundle: 142 };
