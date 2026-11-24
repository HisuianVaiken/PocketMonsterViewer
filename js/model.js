// Builds a viewer model directly from the game's Unity bundles (port of _viewer/export.py logic).
import { Env, CID, lz4Decompress } from './unity.js';
import { decodeASTC, ASTC_FORMATS } from './astc.js';

const GLES3 = 9;
const RUNTIME_KW = new Set(['DIRECTIONAL']);
const IGNORED_KW = new Set(['DYNAMICLIGHTMAP_ON', 'LIGHTMAP_ON', 'LIGHTMAP_SHADOW_MIXING', 'DIRLIGHTMAP_COMBINED',
  'SHADOWS_SHADOWMASK', 'SHADOWS_SCREEN', 'SHADOWS_DEPTH', 'SHADOWS_CUBE', 'INSTANCING_ON', 'STEREO_INSTANCING_ON',
  'UNITY_SINGLE_PASS_STEREO', 'STEREO_MULTIVIEW_ON', 'STEREO_CUBEMAP_RENDER_ON', 'shadowcaster', 'FOG_LINEAR', 'FOG_EXP', 'FOG_EXP2']);
const SKIP_PASSES = new Set(['SHADOWCASTER', 'FORWARDADD', 'META', 'DEFERRED', 'PREPASSBASE', 'PREPASSFINAL', 'MOTIONVECTORS', 'DEPTHONLY']);

const pidKey = p => String(typeof p === 'bigint' ? p : BigInt(p || 0));
const fetchBuf = async url => { const r = await fetch(url); if (!r.ok) throw new Error(url + ': HTTP ' + r.status); return new Uint8Array(await r.arrayBuffer()); };

// ============================================================ shader library (mtshaders bundle)
export class ShaderLib {
  static async load(url) {
    const env = new Env();
    env.addBundle(await fetchBuf(url));
    const lib = new ShaderLib();
    for (const o of env.objects()) {
      if (o.classID !== CID.Shader) continue;
      const t = env.read(o);
      const pi = Array.from(t.platforms).indexOf(GLES3);
      if (pi < 0) continue;
      lib.shaders.set(pidKey(o.pathID), {
        name: t.m_ParsedForm.m_Name, pf: t.m_ParsedForm, blob: t.compressedBlob,
        offs: t.offsets[pi], cl: t.compressedLengths[pi], dl: t.decompressedLengths[pi], segs: null, variants: new Map(),
      });
    }
    return lib;
  }
  constructor() { this.shaders = new Map(); this.files = new Map(); }

  segments(s) {
    if (!s.segs) {
      const offs = Array.from(s.offs.length !== undefined ? s.offs : [s.offs]);
      const cl = Array.from(s.cl.length !== undefined ? s.cl : [s.cl]);
      const dl = Array.from(s.dl.length !== undefined ? s.dl : [s.dl]);
      s.segs = offs.map((o, i) => lz4Decompress(s.blob.subarray(o, o + cl[i]), dl[i]));
    }
    return s.segs;
  }
  source(s, blobIndex) {
    const segs = this.segments(s);
    const d = segs[0]; const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const off = dv.getInt32(4 + 12 * blobIndex, true), len = dv.getInt32(8 + 12 * blobIndex, true), seg = dv.getInt32(12 + 12 * blobIndex, true);
    const entry = (segs[seg] || d).subarray(off, off + len);
    const needle = [0x23, 0x69, 0x66, 0x64, 0x65, 0x66, 0x20, 0x56, 0x45, 0x52, 0x54, 0x45, 0x58];   // "#ifdef VERTEX"
    let i = -1;
    outer: for (let k = 0; k + needle.length <= entry.length; k++) {
      for (let j = 0; j < needle.length; j++) if (entry[k + j] !== needle[j]) continue outer;
      i = k; break;
    }
    if (i < 0) return null;
    const edv = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    const ln = i >= 4 ? edv.getInt32(i - 4, true) : -1;
    let src = ln > 0 && ln <= entry.length - i ? entry.subarray(i, i + ln) : entry.subarray(i);
    const z = src.indexOf(0); if (z > 0 && !(ln > 0)) src = src.subarray(0, z);
    return splitAndPatch(new TextDecoder().decode(src));
  }
  // returns file key of the variant (cached), building the shader JSON like export.py did
  variant(s, blobIndex) {
    const key = s.name.replace(/\//g, '_') + '_' + blobIndex + '.json';
    if (this.files.has(key)) return key;
    const r = this.source(s, blobIndex);
    if (!r) return null;
    const [vs, fs] = r;
    const uniforms = [...new Set([...(vs + '\n' + fs).matchAll(/uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)/g)].map(m => m[1]))].sort();
    const props = {};
    for (const p of s.pf.m_PropInfo.m_Props) {
      props[p.m_Name] = { type: p.m_Type, value: [p['m_DefValue[0]'] ?? 0, p['m_DefValue[1]'] ?? 0, p['m_DefValue[2]'] ?? 0, p['m_DefValue[3]'] ?? 0],
        tex: p.m_DefTexture ? p.m_DefTexture.m_DefaultName : null };
    }
    this.files.set(key, { shader: s.name, blob: blobIndex, vs, fs, uniforms, props });
    return key;
  }
}

function splitAndPatch(src) {
  const m = src.match(/#ifdef VERTEX\s*\n([\s\S]*?)\n#endif\s*\n#ifdef FRAGMENT\s*\n([\s\S]*)\n#endif\s*$/);
  if (!m) return null;
  const patch = x => x.replace('#define HLSLCC_ENABLE_UNIFORM_BUFFERS 1', '#define HLSLCC_ENABLE_UNIFORM_BUFFERS 0')
    .replace('#define UNITY_SUPPORTS_UNIFORM_LOCATION 1', '#define UNITY_SUPPORTS_UNIFORM_LOCATION 0').trim() + '\n';
  return [patch(m[1]), patch(m[2])];
}

function pickVariant(s, pass, matKw) {
  const names = s.pf.m_KeywordNames;
  const ps = pass.progVertex.m_PlayerSubPrograms;
  const progs = ps && ps[0] && ps[0].length ? ps[0] : [];
  const want = new Set([...matKw, ...RUNTIME_KW].filter(k => !IGNORED_KW.has(k)));
  let best = null, bestScore = null;
  for (const p of progs) {
    let ks = new Set(Array.from(p.m_KeywordIndices).filter(k => k < names.length).map(k => names[k]));
    const pen = [...ks].some(k => IGNORED_KW.has(k)) ? 100 : 0;
    ks = new Set([...ks].filter(k => !IGNORED_KW.has(k)));
    let diff = 0; for (const k of want) if (!ks.has(k)) diff++; for (const k of ks) if (!want.has(k)) diff++;
    const score = [pen, diff, ks.size];
    if (!bestScore || score[0] < bestScore[0] || (score[0] === bestScore[0] && (score[1] < bestScore[1] || (score[1] === bestScore[1] && score[2] < bestScore[2])))) {
      best = p; bestScore = score;
    }
  }
  return best;
}

// ============================================================ math
function quatMat(x, y, z, w) {
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
}
const convPos = v => [-v[0], v[1], v[2]];
const convQuat = q => [q[0], -q[1], -q[2], q[3]];
function mat44(m) { const r = []; for (let i = 0; i < 4; i++) { r.push([]); for (let j = 0; j < 4; j++) r[i].push(m['e' + i + j]); } return r; }
function mirrorMat(M) {   // S*M*S with S = diag(-1,1,1,1)
  const s = [-1, 1, 1, 1];
  return M.map((row, i) => row.map((v, j) => v * s[i] * s[j]));
}
function qmul(a, b) {
  const [x1, y1, z1, w1] = a, [x2, y2, z2, w2] = b;
  return [w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2, w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2];
}
const ROT_ORDERS = ['XYZ', 'XZY', 'YZX', 'YXZ', 'ZXY', 'ZYX'];
function eulerToQuat(ex, ey, ez, order) {
  const seq = ROT_ORDERS[order >= 0 && order < 6 ? order : 4];
  const ang = [ex, ey, ez].map(d => d * Math.PI / 180);
  let q = null;
  for (const ch of seq) {
    const a = 'XYZ'.indexOf(ch);
    const qa = [0, 0, 0, Math.cos(ang[a] / 2)]; qa[a] = Math.sin(ang[a] / 2);
    q = q ? qmul(qa, q) : qa;
  }
  return q;
}
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(str) {
  const b = new TextEncoder().encode(str); let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function half(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

// ============================================================ mesh decoding (Unity 2019+ vertex layout)
const FMT_SIZE = [4, 2, 1, 1, 2, 2, 1, 1, 2, 2, 4, 4];
function decodeMesh(m, env) {
  if (m.m_MeshCompression) throw new Error('compressed meshes not supported: ' + m.m_Name);
  const vd = m.m_VertexData; const nv = vd.m_VertexCount;
  let data = vd.m_DataSize;
  if ((!data || !data.length) && m.m_StreamData && m.m_StreamData.path) {
    const res = env.resource(m.m_StreamData.path);
    data = res.subarray(Number(m.m_StreamData.offset), Number(m.m_StreamData.offset) + m.m_StreamData.size);
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ch = vd.m_Channels.map(c => ({ stream: c.stream, offset: c.offset, format: c.format, dim: c.dimension & 0xF }));
  const nStreams = 1 + Math.max(0, ...ch.map(c => c.stream));
  const streams = []; let off = 0;
  for (let s = 0; s < nStreams; s++) {
    let stride = 0;
    for (const c of ch) if (c.stream === s && c.dim > 0) stride += c.dim * FMT_SIZE[c.format];
    streams.push({ offset: off, stride });
    off += nv * stride;
    if (off % 16) off += 16 - (off % 16);
  }
  const read = (ci, asInt) => {
    const c = ch[ci]; if (!c || !c.dim) return null;
    const st = streams[c.stream]; const out = asInt ? new Uint32Array(nv * c.dim) : new Float32Array(nv * c.dim);
    const sz = FMT_SIZE[c.format];
    for (let v = 0; v < nv; v++) {
      const base = st.offset + v * st.stride + c.offset;
      for (let k = 0; k < c.dim; k++) {
        const p = base + k * sz; let x;
        switch (c.format) {
          case 0: x = dv.getFloat32(p, true); break;
          case 1: x = half(dv.getUint16(p, true)); break;
          case 2: x = dv.getUint8(p) / 255; break;
          case 3: x = Math.max(dv.getInt8(p) / 127, -1); break;
          case 4: x = dv.getUint16(p, true) / 65535; break;
          case 5: x = Math.max(dv.getInt16(p, true) / 32767, -1); break;
          case 6: x = dv.getUint8(p); break;
          case 7: x = dv.getInt8(p); break;
          case 8: x = dv.getUint16(p, true); break;
          case 9: x = dv.getInt16(p, true); break;
          case 10: x = dv.getUint32(p, true); break;
          case 11: x = dv.getInt32(p, true); break;
        }
        out[v * c.dim + k] = x;
      }
    }
    return { data: out, dim: c.dim };
  };
  const res = { nv, pos: read(0), nrm: read(1), tan: read(2), col: read(3), uv: [], bw: read(12), bi: read(13, true) };
  for (let i = 0; i < 8; i++) res.uv.push(read(4 + i));
  // indices
  const ib = m.m_IndexBuffer; const u16 = m.m_IndexFormat === 0;
  const idv = new DataView(ib.buffer, ib.byteOffset, ib.byteLength);
  res.subs = m.m_SubMeshes.map(sm => {
    const first = sm.firstByte / (u16 ? 2 : 4); const n = sm.indexCount; const bv = sm.baseVertex || 0;
    if (sm.topology !== 0) return null;   // only triangles
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = (u16 ? idv.getUint16((first + i) * 2, true) : idv.getUint32((first + i) * 4, true)) + bv;
    return out;
  });
  return res;
}

// ============================================================ animation decoding (muscle clip)
function decodeStreamed(words) {
  const dv = new DataView(words.buffer, words.byteOffset, words.byteLength);
  const curves = new Map(); let p = 0; const n = words.byteLength;
  while (p + 8 <= n) {
    const time = dv.getFloat32(p, true); const nk = dv.getUint32(p + 4, true); p += 8;
    for (let k = 0; k < nk; k++) {
      const idx = dv.getInt32(p, true);
      const key = [time, dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true), dv.getFloat32(p + 12, true), dv.getFloat32(p + 16, true)];
      p += 20;
      if (!curves.has(idx)) curves.set(idx, []);
      curves.get(idx).push(key);
    }
  }
  return curves;
}
function sampleStreamed(keys, t) {
  let lo = 0, hi = keys.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (keys[mid][0] <= t) lo = mid; else hi = mid - 1; }
  const k = keys[lo]; const t0 = k[0];
  if (t0 < -1e30 || t0 > 1e30) return k[4];
  const dt = t - t0; const v = ((k[1] * dt + k[2]) * dt + k[3]) * dt + k[4];
  return Number.isFinite(v) ? v : k[4];
}

function decodeClip(t, pathOfHash) {
  const mc = t.m_MuscleClip; const cd = mc.m_Clip.data;
  const start = mc.m_StartTime, stop = mc.m_StopTime;
  const dur = Math.max(stop - start, 1e-4);
  const rate = Math.min(Math.max(t.m_SampleRate || 30, 15), 30);
  const nf = Math.max(2, Math.floor(dur * rate + 1e-4) + 1);
  const times = new Float64Array(nf); for (let i = 0; i < nf; i++) times[i] = start + (stop - start) * i / (nf - 1);
  const S = cd.m_StreamedClip.curveCount, D = cd.m_DenseClip.m_CurveCount;
  const constant = cd.m_ConstantClip.data; const C = constant.length;
  const streamed = S ? decodeStreamed(cd.m_StreamedClip.data) : new Map();
  const dense = cd.m_DenseClip.m_SampleArray; const dFrames = D ? Math.floor(dense.length / D) : 0;
  const drate = cd.m_DenseClip.m_SampleRate || rate, dbegin = cd.m_DenseClip.m_BeginTime;
  const curve = ci => {
    const out = new Float64Array(nf);
    if (ci < S) { const keys = streamed.get(ci); if (keys) for (let i = 0; i < nf; i++) out[i] = sampleStreamed(keys, times[i]); return out; }
    ci -= S;
    if (ci < D) {
      for (let i = 0; i < nf; i++) {
        const f = Math.min(Math.max((times[i] - dbegin) * drate, 0), dFrames - 1);
        const f0 = Math.floor(f), f1 = Math.min(f0 + 1, dFrames - 1), a = f - f0;
        out[i] = dense[f0 * D + ci] * (1 - a) + dense[f1 * D + ci] * a;
      }
      return out;
    }
    ci -= D; out.fill(ci < C ? constant[ci] : 0); return out;
  };
  const tracks = new Map(); let ci = 0;
  for (const b of t.m_ClipBindingConstant.genericBindings) {
    const attr = b.attribute, tid = b.typeID;
    const n = tid === 4 ? (attr === 2 ? 4 : 3) : 1;
    if (tid === 4 && attr >= 1 && attr <= 4) {
      const node = pathOfHash.get(b.path >>> 0);
      if (node !== undefined) {
        const comps = []; for (let k = 0; k < n; k++) comps.push(curve(ci + k));
        const tr = tracks.get(node) || {}; tracks.set(node, tr);
        if (attr === 1) { const a = new Float32Array(nf * 3); for (let i = 0; i < nf; i++) { a[i * 3] = -comps[0][i]; a[i * 3 + 1] = comps[1][i]; a[i * 3 + 2] = comps[2][i]; } tr.pos = a; }
        else if (attr === 3) { const a = new Float32Array(nf * 3); for (let i = 0; i < nf; i++) { a[i * 3] = comps[0][i]; a[i * 3 + 1] = comps[1][i]; a[i * 3 + 2] = comps[2][i]; } tr.scl = a; }
        else {
          const a = new Float32Array(nf * 4); let prev = null;
          for (let i = 0; i < nf; i++) {
            let q;
            if (attr === 2) { q = [comps[0][i], comps[1][i], comps[2][i], comps[3][i]]; const l = Math.hypot(...q) || 1; q = q.map(v => v / l); }
            else q = eulerToQuat(comps[0][i], comps[1][i], comps[2][i], b.customType ?? 4);
            if (prev && (q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3]) < 0) q = q.map(v => -v);
            prev = q;
            const c = convQuat(q); a.set(c, i * 4);
          }
          tr.rot = a;
        }
      }
    }
    ci += n;
  }
  const events = (t.m_Events || []).map(e => ({ time: e.time, fn: e.functionName, data: e.data || '' }));
  return { duration: dur, frames: nf, loop: !!mc.m_LoopTime, tracks, events };
}

// ============================================================ buffer builder
class BufBuilder {
  constructor() { this.parts = []; this.size = 0; }
  add(typed) {
    if (this.size % 4) { const pad = 4 - (this.size % 4); this.parts.push(new Uint8Array(pad)); this.size += pad; }
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const off = this.size; this.parts.push(bytes); this.size += bytes.byteLength;
    return [off, bytes.byteLength];
  }
  build() { const out = new Uint8Array(this.size); let p = 0; for (const b of this.parts) { out.set(b, p); p += b.byteLength; } return out.buffer; }
}

// ============================================================ main entry
/**
 * @param entry  catalog entry {name, path, deps:[paths]}
 * @param base   base URL of the bundles folder
 * @param lib    ShaderLib
 * @returns {model, bin, textures: Map, shaders: Map}
 */
export async function buildModel(entry, base, lib) {
  const env = new Env();
  const bufs = await Promise.all([entry.path, ...entry.deps].map(p => fetchBuf(base + p)));
  for (const b of bufs) env.addBundle(b);
  const objs = [...env.objects()];
  const rd = o => env.read(o);
  const resolve = (o, pptr) => o.file.resolve(pptr);

  // ---------------- skeleton
  const trs = objs.filter(o => o.classID === CID.Transform);
  const trByKey = new Map(trs.map(o => [o.file.name + ':' + pidKey(o.pathID), o]));
  const keyOf = o => o.file.name + ':' + pidKey(o.pathID);
  const roots = trs.filter(o => { const t = rd(o); const f = resolve(o, t.m_Father); return !f; });
  const nodes = []; const nodeOf = new Map();
  const addNode = (o, parent) => {
    const t = rd(o); const goO = resolve(o, t.m_GameObject); const go = goO ? rd(goO) : null;
    const p = t.m_LocalPosition, r = t.m_LocalRotation, s = t.m_LocalScale;
    nodeOf.set(keyOf(o), nodes.length);
    nodes.push({ name: go ? go.m_Name : 'node', parent, pos: convPos([p.x, p.y, p.z]), rot: convQuat([r.x, r.y, r.z, r.w]),
      scl: [s.x, s.y, s.z], active: go ? !!go.m_IsActive : true, _go: goO ? keyOf(goO) : null });
    const me = nodes.length - 1;
    for (const c of t.m_Children) { const co = resolve(o, c); if (co && co.classID === CID.Transform) addNode(co, me); }
  };
  for (const r of roots) addNode(r, -1);
  const nodeForTransform = (o, pptr) => { const t = resolve(o, pptr); return t ? nodeOf.get(keyOf(t)) : undefined; };
  const goNode = new Map(nodes.map((n, i) => [n._go, i]));

  let animRoot = 0;
  for (const o of objs) if (o.classID === CID.Animator) {
    const a = rd(o); const g = resolve(o, a.m_GameObject); if (g && goNode.has(keyOf(g))) animRoot = goNode.get(keyOf(g));
  }
  const pathOfHash = new Map();
  const walk = (i, path) => {
    pathOfHash.set(crc32(path), i);
    nodes.forEach((n, j) => { if (n.parent === i) walk(j, (path ? path + '/' : '') + n.name); });
  };
  walk(animRoot, '');

  const bb = new BufBuilder();
  const textures = new Map();

  // ---------------- textures
  const texDone = new Map();
  const exportTex = to => {
    const k = keyOf(to);
    if (texDone.has(k)) return texDone.get(k);
    const t = rd(to);
    let info = null;
    try {
      let data = t['image data'];
      const sd = t.m_StreamData;
      if ((!data || !data.length) && sd && sd.path) {
        const res = env.resource(sd.path);
        data = res.subarray(Number(sd.offset), Number(sd.offset) + sd.size);
      }
      const fmt = ASTC_FORMATS[t.m_TextureFormat];
      if (!fmt) throw new Error('texture format ' + t.m_TextureFormat);
      const rgba = decodeASTC(data, t.m_Width, t.m_Height, fmt[0], fmt[1]);
      const ts = t.m_TextureSettings || {};
      const wm = ts.m_WrapMode || 0;
      info = { file: 'tex:' + k, name: t.m_Name, w: t.m_Width, h: t.m_Height, wrapU: ts.m_WrapU ?? wm, wrapV: ts.m_WrapV ?? wm, filter: ts.m_FilterMode ?? 1 };
      textures.set(info.file, { rgba, w: t.m_Width, h: t.m_Height });
    } catch (e) { console.warn('texture', t.m_Name, e.message); }
    texDone.set(k, info);
    return info;
  };

  // ---------------- materials
  const materials = []; const matIndex = new Map();
  const exportMat = (owner, pptr) => {
    const mo = resolve(owner, pptr);
    if (!mo) return -1;
    const k = keyOf(mo);
    if (matIndex.has(k)) return matIndex.get(k);
    const t = rd(mo); const sp = t.m_SavedProperties;
    const floats = Object.fromEntries(sp.m_Floats);
    const ints = Object.fromEntries(sp.m_Ints || []);
    const colors = Object.fromEntries(sp.m_Colors.map(([n, c]) => [n, [c.r, c.g, c.b, c.a]]));
    const texs = {};
    for (const [n, v] of sp.m_TexEnvs) {
      const to = resolve(mo, v.m_Texture);
      texs[n] = { tex: to && to.classID === CID.Texture2D ? exportTex(to) : null, st: [v.m_Scale.x, v.m_Scale.y, v.m_Offset.x, v.m_Offset.y] };
    }
    let kws = Array.from(t.m_ValidKeywords || []);
    if (!kws.length && t.m_ShaderKeywords) kws = t.m_ShaderKeywords.split(/\s+/).filter(Boolean);
    const s = lib.shaders.get(pidKey(t.m_Shader.m_PathID));
    const passes = [];
    if (s) {
      for (const p of s.pf.m_SubShaders[0].m_Passes) {
        const st = p.m_State;
        const tags = Object.fromEntries((st.m_Tags && st.m_Tags.tags) || []);
        const lm = (tags.LIGHTMODE || '').toUpperCase();
        if (SKIP_PASSES.has(lm)) continue;
        const v = pickVariant(s, p, kws);
        if (!v) continue;
        const f = lib.variant(s, v.m_BlobIndex);
        if (!f) continue;
        const sv = x => { const n = x.name; if (n && n !== '<noninit>') { if (n in floats) return floats[n]; if (n in ints) return ints[n]; } return x.val; };
        const rb = st.rtBlend0;
        passes.push({ shader: f, lightMode: lm, cull: sv(st.culling), zWrite: sv(st.zWrite), zTest: sv(st.zTest),
          src: sv(rb.srcBlend), dst: sv(rb.destBlend), srcA: sv(rb.srcBlendAlpha), dstA: sv(rb.destBlendAlpha),
          blendOp: sv(rb.blendOp), colMask: sv(rb.colMask),
          offsetFactor: st.offsetFactor ? sv(st.offsetFactor) : 0, offsetUnits: st.offsetUnits ? sv(st.offsetUnits) : 0 });
      }
    }
    for (const [n, v] of Object.entries(ints)) floats[n] = Number(v);
    materials.push({ name: t.m_Name, shaderName: s ? s.name : null, keywords: kws, queue: t.m_CustomRenderQueue ?? -1,
      floats, colors, textures: texs, passes });
    matIndex.set(k, materials.length - 1);
    return materials.length - 1;
  };

  // ---------------- meshes
  const meshFilters = new Map();
  for (const o of objs) if (o.classID === CID.MeshFilter) { const mf = rd(o); const g = resolve(o, mf.m_GameObject); if (g) meshFilters.set(keyOf(g), [o, mf]); }
  const meshesOut = []; const rendererIndex = new Map(); let totalTris = 0;
  for (const ro of objs.filter(o => o.classID === CID.SkinnedMeshRenderer || o.classID === CID.MeshRenderer)) {
    const r = rd(ro);
    const g = resolve(ro, r.m_GameObject);
    let meshO = null;
    if (ro.classID === CID.SkinnedMeshRenderer) meshO = resolve(ro, r.m_Mesh);
    else { const mf = g && meshFilters.get(keyOf(g)); if (mf) meshO = resolve(mf[0], mf[1].m_Mesh); }
    if (!meshO) continue;
    const mesh = rd(meshO);
    const h = decodeMesh(mesh, env);
    if (!h.pos) continue;
    const nv = h.nv;
    const attrs = {};
    { const p = h.pos.data; const a = new Float32Array(nv * 3); for (let i = 0; i < nv; i++) { a[i * 3] = -p[i * h.pos.dim]; a[i * 3 + 1] = p[i * h.pos.dim + 1]; a[i * 3 + 2] = p[i * h.pos.dim + 2]; } attrs.a_POSITION0 = [3, ...bb.add(a)]; }
    if (h.nrm) { const p = h.nrm.data; const d = h.nrm.dim; const a = new Float32Array(nv * 3); for (let i = 0; i < nv; i++) { a[i * 3] = -p[i * d]; a[i * 3 + 1] = p[i * d + 1]; a[i * 3 + 2] = p[i * d + 2]; } attrs.a_NORMAL0 = [3, ...bb.add(a)]; }
    if (h.tan) { const p = h.tan.data; const a = new Float32Array(nv * 4); for (let i = 0; i < nv; i++) { a[i * 4] = -p[i * 4]; a[i * 4 + 1] = p[i * 4 + 1]; a[i * 4 + 2] = p[i * 4 + 2]; a[i * 4 + 3] = -p[i * 4 + 3]; } attrs.a_TANGENT0 = [4, ...bb.add(a)]; }
    if (h.col) attrs.in_COLOR0 = [h.col.dim, ...bb.add(h.col.data)];
    h.uv.forEach((u, i) => { if (u) attrs['in_TEXCOORD' + i] = [u.dim, ...bb.add(u.data)]; });

    let skin = null;
    const bonesP = r.m_Bones || [];
    if (ro.classID === CID.SkinnedMeshRenderer && (h.bw || h.bi) && bonesP.length && mesh.m_BindPose.length) {
      const bones = bonesP.map(b => { const n = nodeForTransform(ro, b); return n === undefined ? -1 : n; });
      const binds = mesh.m_BindPose.slice(0, bones.length).map(bp => mirrorMat(mat44(bp)));
      const bi = new Float32Array(nv * 4), bw = new Float32Array(nv * 4);
      for (let v = 0; v < nv; v++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          const idx = h.bi && k < h.bi.dim ? h.bi.data[v * h.bi.dim + k] : 0;
          bi[v * 4 + k] = Math.min(Math.max(idx, 0), bones.length - 1);
          const w = h.bw ? (k < h.bw.dim ? h.bw.data[v * h.bw.dim + k] : 0) : (k === 0 ? 1 : 0);
          bw[v * 4 + k] = w; sum += w;
        }
        if (sum === 0) { bw[v * 4] = 1; sum = 1; }
        for (let k = 0; k < 4; k++) bw[v * 4 + k] /= sum;
      }
      attrs.a_skinIndex = [4, ...bb.add(bi)];
      attrs.a_skinWeight = [4, ...bb.add(bw)];
      skin = { bones: bones.map(b => Math.max(b, 0)), boneInverses: binds.map(M => { const a = []; for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) a.push(M[rr][c]); return a; }) };
    }

    const subs = []; const mats = r.m_Materials || [];
    h.subs.forEach((tri, si) => {
      if (!tri || !tri.length) return;
      const flipped = new Uint32Array(tri.length);
      for (let i = 0; i < tri.length; i += 3) { flipped[i] = tri[i]; flipped[i + 1] = tri[i + 2]; flipped[i + 2] = tri[i + 1]; }
      totalTris += tri.length / 3;
      const mi = mats.length ? exportMat(ro, mats[Math.min(si, mats.length - 1)]) : -1;
      if (nv <= 65535) subs.push({ index: bb.add(Uint16Array.from(flipped)), indexType: 'u16', count: tri.length, material: mi, slot: si });
      else subs.push({ index: bb.add(flipped), indexType: 'u32', count: tri.length, material: mi, slot: si });
    });
    if (mats.length > h.subs.length && subs.length) {
      mats.slice(h.subs.length).forEach((m, k) => { const e = { ...subs[subs.length - 1] }; e.material = exportMat(ro, m); e.slot = h.subs.length + k; subs.push(e); });
    }
    rendererIndex.set(keyOf(ro), meshesOut.length);
    meshesOut.push({ name: mesh.m_Name, node: g ? (goNode.get(keyOf(g)) ?? 0) : 0, enabled: r.m_Enabled !== 0 && r.m_Enabled !== false,
      vertexCount: nv, attributes: attrs, submeshes: subs, skin,
      rootBone: skin ? (nodeForTransform(ro, r.m_RootBone) ?? -1) : -1 });
  }
  if (!meshesOut.length) throw new Error('no meshes found');

  // ---------------- game scripts
  const uvDrivers = [], visDrivers = [], layers = []; const clipStateName = new Map();
  for (const o of objs) {
    if (o.classID !== CID.MonoBehaviour) continue;
    let t; try { t = rd(o); } catch (e) { continue; }
    for (const mm of t._materialModifiers || []) {
      for (const prop of mm.properties || []) {
        const n = nodeForTransform(o, prop.textureTransform); if (n === undefined) continue;
        for (const b of mm.binders || []) {
          const rO = resolve(o, b.renderer); const mi = rO ? rendererIndex.get(keyOf(rO)) : undefined; if (mi === undefined) continue;
          uvDrivers.push({ mesh: mi, slot: b.materialIndex, property: prop.propertyName, propertyType: prop.propertyType, node: n, uvScale: [prop.uvScale.x, prop.uvScale.y] });
        }
      }
    }
    for (const rv of t._rendererVisibilities || []) {
      const n = nodeForTransform(o, rv.transform); const rO = resolve(o, rv.renderer); const mi = rO ? rendererIndex.get(keyOf(rO)) : undefined;
      if (n !== undefined && mi !== undefined) visDrivers.push({ mesh: mi, node: n });
    }
    for (const vg of t._visibilityGroups || []) {
      const n = vg.transform ? nodeForTransform(o, vg.transform) : undefined;
      for (const rr of vg.renderers || []) { const rO = resolve(o, rr); const mi = rO ? rendererIndex.get(keyOf(rO)) : undefined; if (n !== undefined && mi !== undefined) visDrivers.push({ mesh: mi, node: n }); }
    }
    for (const L of t.layers || []) {
      const states = (L.states || []).map(st => { const c = resolve(o, st.clip); const ck = c ? keyOf(c) : null; if (ck && !clipStateName.has(ck)) clipStateName.set(ck, st.name); return { name: st.name, clip: ck }; });
      layers.push({ name: L.layerName, index: L.layerIndex, weight: L.defaultWeight ?? 1, states, default: L.defaultState ? L.defaultState.name : null });
    }
  }

  // ---------------- animations
  const animations = []; const clipId = new Map();
  for (const o of objs) {
    if (o.classID !== CID.AnimationClip) continue;
    const t = rd(o);
    let c;
    try { c = decodeClip(t, pathOfHash); } catch (e) { console.warn('anim', t.m_Name, e); continue; }
    const tracks = [];
    for (const [ni, tr] of c.tracks) {
      const e = { node: ni };
      for (const [k, n] of [['pos', 3], ['rot', 4], ['scl', 3]]) {
        if (!tr[k]) continue;
        let v = tr[k];
        // constant track -> one key
        let constant = true;
        for (let i = n; i < v.length && constant; i++) if (Math.abs(v[i] - v[i % n]) > 1e-6) constant = false;
        if (constant) v = v.slice(0, n);
        e[k] = bb.add(v);
      }
      tracks.push(e);
    }
    clipId.set(keyOf(o), animations.length);
    animations.push({ name: t.m_Name, state: clipStateName.get(keyOf(o)) || t.m_Name.replace(entry.name + '_', ''), duration: c.duration,
      frames: c.frames, loop: c.loop, tracks, events: c.events });
  }
  for (const L of layers) for (const st of L.states) st.clip = st.clip && clipId.has(st.clip) ? clipId.get(st.clip) : -1;
  for (const n of nodes) delete n._go;

  const model = { version: 6, name: entry.name, group: entry.group, nodes, meshes: meshesOut, materials, animations, layers,
    uvDrivers, visDrivers, tris: totalTris };
  return { model, bin: bb.build(), textures, shaders: lib.files };
}
