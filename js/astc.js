// ASTC LDR software decoder (any 2D block footprint) -> RGBA8.
// Written from the Khronos ASTC specification. HDR endpoint modes decode to magenta (not used by these assets).
// Output rows are in storage order (row 0 = first row of blocks), which is what WebGL expects with flipY = false.

// ---------------------------------------------------------------- bit helpers
function getBits(b, start, count) {          // little-endian bit read from 16-byte block
  let v = 0;
  for (let i = 0; i < count; i++) {
    const bit = start + i;
    v |= ((b[bit >> 3] >> (bit & 7)) & 1) << i;
  }
  return v >>> 0;
}

// ---------------------------------------------------------------- integer sequence encoding
// quantization levels table: index -> {trits, quints, bits}
const LEVELS = [];   // levels (number of values) -> encoding
function enc(levels) {
  if (levels % 3 === 0 && isPow2(levels / 3)) return { t: 1, q: 0, n: Math.log2(levels / 3) };
  if (levels % 5 === 0 && isPow2(levels / 5)) return { t: 0, q: 1, n: Math.log2(levels / 5) };
  return { t: 0, q: 0, n: Math.log2(levels) };
}
function isPow2(x) { return x >= 1 && (x & (x - 1)) === 0; }
const COLOR_LEVELS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 160, 192, 256];

function iseBits(levels, count) {
  const e = enc(levels);
  if (e.t) return Math.ceil(count * (8 + 5 * e.n) / 5);
  if (e.q) return Math.ceil(count * (7 + 3 * e.n) / 3);
  return count * e.n;
}

// trit / quint decode tables
const TRITS = []; const QUINTS = [];
(function buildTables() {
  for (let T = 0; T < 256; T++) {
    const b = i => (T >> i) & 1;
    let C, t0, t1, t2, t3, t4;
    if (((T >> 2) & 7) === 7) { C = (((T >> 5) & 7) << 2) | (T & 3); t4 = 2; t3 = 2; }
    else { C = T & 0x1F; if (((T >> 5) & 3) === 3) { t4 = 2; t3 = b(7); } else { t4 = b(7); t3 = (T >> 5) & 3; } }
    const c = i => (C >> i) & 1;
    if ((C & 3) === 3) { t2 = 2; t1 = c(4); t0 = (c(3) << 1) | (c(2) & (c(3) ^ 1)); }
    else if (((C >> 2) & 3) === 3) { t2 = 2; t1 = 2; t0 = C & 3; }
    else { t2 = c(4); t1 = (C >> 2) & 3; t0 = (c(1) << 1) | (c(0) & (c(1) ^ 1)); }
    TRITS.push([t0, t1, t2, t3, t4]);
  }
  for (let Q = 0; Q < 128; Q++) {
    const b = i => (Q >> i) & 1;
    let q0, q1, q2;
    if (((Q >> 1) & 3) === 3 && ((Q >> 5) & 3) === 0) {
      q2 = (b(0) << 2) | ((b(4) & (b(0) ^ 1)) << 1) | (b(3) & (b(0) ^ 1)); q1 = 4; q0 = 4;
    } else {
      let C;
      if (((Q >> 1) & 3) === 3) { q2 = 4; C = (((Q >> 3) & 3) << 3) | (((~(Q >> 5)) & 3) << 1) | b(0); }
      else { q2 = (Q >> 5) & 3; C = Q & 0x1F; }
      if ((C & 7) === 5) { q1 = 4; q0 = (C >> 3) & 3; }
      else { q1 = (C >> 3) & 3; q0 = C & 7; }
    }
    QUINTS.push([q0, q1, q2]);
  }
})();

// decode `count` values of `levels` levels from bit-reader fn rd(start,count); returns [{v (m), t (trit/quint)}]
function decodeISE(rd0, start, levels, count) {
  const e = enc(levels);
  const out = new Array(count);
  let p = start;
  // bits past the end of the sequence (partial last trit/quint group) must read as zero
  const end = start + iseBits(levels, count);
  const rd = (s, n) => {
    if (n <= 0 || s >= end) return 0;
    if (s + n > end) n = end - s;
    return rd0(s, n);
  };
  if (e.t) {
    for (let i = 0; i < count; i += 5) {
      const m = [0, 0, 0, 0, 0]; let T = 0;
      m[0] = rd(p, e.n); p += e.n; T |= rd(p, 2); p += 2;
      m[1] = rd(p, e.n); p += e.n; T |= rd(p, 2) << 2; p += 2;
      m[2] = rd(p, e.n); p += e.n; T |= rd(p, 1) << 4; p += 1;
      m[3] = rd(p, e.n); p += e.n; T |= rd(p, 2) << 5; p += 2;
      m[4] = rd(p, e.n); p += e.n; T |= rd(p, 1) << 7; p += 1;
      const t = TRITS[T];
      for (let k = 0; k < 5 && i + k < count; k++) out[i + k] = { m: m[k], d: t[k], e };
    }
  } else if (e.q) {
    for (let i = 0; i < count; i += 3) {
      const m = [0, 0, 0]; let Q = 0;
      m[0] = rd(p, e.n); p += e.n; Q |= rd(p, 3); p += 3;
      m[1] = rd(p, e.n); p += e.n; Q |= rd(p, 2) << 3; p += 2;
      m[2] = rd(p, e.n); p += e.n; Q |= rd(p, 2) << 5; p += 2;
      const q = QUINTS[Q];
      for (let k = 0; k < 3 && i + k < count; k++) out[i + k] = { m: m[k], d: q[k], e };
    }
  } else {
    for (let i = 0; i < count; i++) { out[i] = { m: rd(p, e.n), d: 0, e }; p += e.n; }
  }
  return out;
}

// ---------------------------------------------------------------- unquantization
function bitRep(v, from, to) {       // replicate `from`-bit value into `to` bits
  let r = 0, s = to;
  while (s > 0) { const sh = s - from; r |= sh >= 0 ? v << sh : v >> -sh; s -= from; }
  return r & ((1 << to) - 1);
}
function unqColor(x) {
  const { m, d, e } = x;
  if (!e.t && !e.q) return bitRep(m, e.n, 8);
  const n = e.n;
  const bit = i => (m >> i) & 1;
  const A = bit(0) ? 0x1FF : 0;
  let B = 0, C = 0;
  const a = bit(1), b2 = bit(2), c3 = bit(3), d4 = bit(4), e5 = bit(5);
  if (e.t) {
    switch (n) {
      case 1: C = 204; B = 0; break;
      case 2: C = 93; { const b = bit(1); B = (b << 8) | (b << 4) | (b << 2) | (b << 1); } break;          // b000b0bb0
      case 3: C = 44; { const b = bit(1), c = bit(2); B = (c << 8) | (b << 7) | (c << 3) | (b << 2) | (c << 1) | b; } break; // cb000cbcb
      case 4: C = 22; { const b = bit(1), c = bit(2), dd = bit(3); B = (dd << 8) | (c << 7) | (b << 6) | (dd << 2) | (c << 1) | b; } break; // dcb000dcb
      case 5: C = 11; { const b = bit(1), c = bit(2), dd = bit(3), ee = bit(4); B = (ee << 8) | (dd << 7) | (c << 6) | (b << 5) | (ee << 1) | dd; } break; // edcb000ed
      case 6: C = 5; { const b = bit(1), c = bit(2), dd = bit(3), ee = bit(4), f = bit(5); B = (f << 8) | (ee << 7) | (dd << 6) | (c << 5) | (b << 4) | f; } break; // fedcb000f
    }
  } else {
    switch (n) {
      case 1: C = 113; B = 0; break;
      case 2: C = 54; { const b = bit(1); B = (b << 8) | (b << 3) | (b << 2); } break;           // b0000bb00
      case 3: C = 26; { const b = bit(1), c = bit(2); B = (c << 8) | (b << 7) | (c << 2) | (b << 1) | c; } break; // cb0000cbc
      case 4: C = 13; { const b = bit(1), c = bit(2), dd = bit(3); B = (dd << 8) | (c << 7) | (b << 6) | (dd << 1) | c; } break; // dcb0000dc
      case 5: C = 6; { const b = bit(1), c = bit(2), dd = bit(3), ee = bit(4); B = (ee << 8) | (dd << 7) | (c << 6) | (b << 5) | ee; } break; // edcb0000e
    }
  }
  let T = d * C + B;
  T ^= A;
  return ((A & 0x80) | (T >> 2)) & 0xFF;
}
function unqWeight(x) {
  const { m, d, e } = x;
  let r;
  if (!e.t && !e.q) {
    r = e.n === 0 ? 0 : bitRep(m, e.n, 6);
  } else if (e.n === 0) {
    r = e.t ? [0, 32, 63][d] : [0, 16, 32, 47, 63][d];
  } else {
    const bit = i => (m >> i) & 1;
    const A = bit(0) ? 0x7F : 0;
    let B = 0, C = 0;
    if (e.t) {
      if (e.n === 1) { C = 50; B = 0; }
      else if (e.n === 2) { C = 23; const b = bit(1); B = (b << 6) | (b << 2) | b; }               // b000b0b
      else { C = 11; const b = bit(1), c = bit(2); B = (c << 6) | (b << 5) | (c << 1) | b; }        // cb000cb
    } else {
      if (e.n === 1) { C = 28; B = 0; }
      else { C = 13; const b = bit(1); B = (b << 6) | (b << 1); }                                   // b0000b0
    }
    let T = d * C + B;
    T ^= A;
    r = (A & 0x20) | (T >> 2);
  }
  if (r > 32) r += 1;
  return r;
}

// ---------------------------------------------------------------- color endpoint decoding (LDR)
const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;
function bts(a, b) {   // bit_transfer_signed: returns [a (signed delta), b]
  b = (b >> 1) | (a & 0x80);
  a = (a >> 1) & 0x3F;
  if (a & 0x20) a -= 0x40;
  return [a, b];
}
const blue = (r, g, b, a) => [(r + b) >> 1, (g + b) >> 1, b, a];

function decodeEndpoints(mode, v) {
  let e0, e1;
  switch (mode) {
    case 0: e0 = [v[0], v[0], v[0], 255]; e1 = [v[1], v[1], v[1], 255]; break;
    case 1: { const L0 = (v[0] >> 2) | (v[1] & 0xC0); const L1 = Math.min(L0 + (v[1] & 0x3F), 255); e0 = [L0, L0, L0, 255]; e1 = [L1, L1, L1, 255]; break; }
    case 4: e0 = [v[0], v[0], v[0], v[2]]; e1 = [v[1], v[1], v[1], v[3]]; break;
    case 5: { let [a1, b0] = bts(v[1], v[0]); let [a3, b2] = bts(v[3], v[2]);
      e0 = [b0, b0, b0, b2]; e1 = [clamp(b0 + a1), clamp(b0 + a1), clamp(b0 + a1), clamp(b2 + a3)]; break; }
    case 6: e0 = [(v[0] * v[3]) >> 8, (v[1] * v[3]) >> 8, (v[2] * v[3]) >> 8, 255]; e1 = [v[0], v[1], v[2], 255]; break;
    case 8: { const s0 = v[0] + v[2] + v[4], s1 = v[1] + v[3] + v[5];
      if (s1 >= s0) { e0 = [v[0], v[2], v[4], 255]; e1 = [v[1], v[3], v[5], 255]; }
      else { e0 = blue(v[1], v[3], v[5], 255); e1 = blue(v[0], v[2], v[4], 255); } break; }
    case 9: { let [a1, b0] = bts(v[1], v[0]); let [a3, b2] = bts(v[3], v[2]); let [a5, b4] = bts(v[5], v[4]);
      if (a1 + a3 + a5 >= 0) { e0 = [b0, b2, b4, 255]; e1 = [clamp(b0 + a1), clamp(b2 + a3), clamp(b4 + a5), 255]; }
      else { e0 = blue(clamp(b0 + a1), clamp(b2 + a3), clamp(b4 + a5), 255); e1 = blue(b0, b2, b4, 255); } break; }
    case 10: e0 = [(v[0] * v[3]) >> 8, (v[1] * v[3]) >> 8, (v[2] * v[3]) >> 8, v[4]]; e1 = [v[0], v[1], v[2], v[5]]; break;
    case 12: { const s0 = v[0] + v[2] + v[4], s1 = v[1] + v[3] + v[5];
      if (s1 >= s0) { e0 = [v[0], v[2], v[4], v[6]]; e1 = [v[1], v[3], v[5], v[7]]; }
      else { e0 = blue(v[1], v[3], v[5], v[7]); e1 = blue(v[0], v[2], v[4], v[6]); } break; }
    case 13: { let [a1, b0] = bts(v[1], v[0]); let [a3, b2] = bts(v[3], v[2]); let [a5, b4] = bts(v[5], v[4]); let [a7, b6] = bts(v[7], v[6]);
      if (a1 + a3 + a5 >= 0) { e0 = [b0, b2, b4, b6]; e1 = [clamp(b0 + a1), clamp(b2 + a3), clamp(b4 + a5), clamp(b6 + a7)]; }
      else { e0 = blue(clamp(b0 + a1), clamp(b2 + a3), clamp(b4 + a5), clamp(b6 + a7)); e1 = blue(b0, b2, b4, b6); } break; }
    default: return null;   // HDR modes
  }
  return [e0, e1];
}

// ---------------------------------------------------------------- partition selection
function hash52(p) {
  p >>>= 0;
  p ^= p >>> 15; p = (p - (p << 17)) >>> 0; p = (p + (p << 7)) >>> 0; p = (p + (p << 4)) >>> 0;
  p ^= p >>> 5; p = (p + (p << 16)) >>> 0; p ^= p >>> 7; p ^= p >>> 3; p = (p ^ (p << 6)) >>> 0; p ^= p >>> 17;
  return p >>> 0;
}
function selectPartition(seed, x, y, z, count, small) {
  if (small) { x <<= 1; y <<= 1; z <<= 1; }
  seed += (count - 1) * 1024;
  const rnum = hash52(seed);
  let s = [rnum & 0xF, (rnum >>> 4) & 0xF, (rnum >>> 8) & 0xF, (rnum >>> 12) & 0xF, (rnum >>> 16) & 0xF, (rnum >>> 20) & 0xF,
    (rnum >>> 24) & 0xF, (rnum >>> 28) & 0xF, (rnum >>> 18) & 0xF, (rnum >>> 22) & 0xF, (rnum >>> 26) & 0xF, ((rnum >>> 30) | (rnum << 2)) & 0xF];
  s = s.map(v => v * v);
  let sh1, sh2;
  if (seed & 1) { sh1 = (seed & 2) ? 4 : 5; sh2 = count === 3 ? 6 : 5; }
  else { sh1 = count === 3 ? 6 : 5; sh2 = (seed & 2) ? 4 : 5; }
  const sh3 = (seed & 0x10) ? sh1 : sh2;
  s[0] >>= sh1; s[1] >>= sh2; s[2] >>= sh1; s[3] >>= sh2; s[4] >>= sh1; s[5] >>= sh2; s[6] >>= sh1; s[7] >>= sh2;
  s[8] >>= sh3; s[9] >>= sh3; s[10] >>= sh3; s[11] >>= sh3;
  let a = (s[0] * x + s[1] * y + s[10] * z + (rnum >>> 14)) & 0x3F;
  let b = (s[2] * x + s[3] * y + s[11] * z + (rnum >>> 10)) & 0x3F;
  let c = (s[4] * x + s[5] * y + s[8] * z + (rnum >>> 6)) & 0x3F;
  let d = (s[6] * x + s[7] * y + s[9] * z + (rnum >>> 2)) & 0x3F;
  if (count < 4) d = 0;
  if (count < 3) c = 0;
  if (a >= b && a >= c && a >= d) return 0;
  if (b >= c && b >= d) return 1;
  if (c >= d) return 2;
  return 3;
}

// ---------------------------------------------------------------- block decode
const ERR = [255, 0, 255, 255];
const WEIGHT_LEVELS = [[0, 0, 2, 3, 4, 5, 6, 8], [0, 0, 10, 12, 16, 20, 24, 32]];

function decodeBlock(blk, bw, bh, out, outStride, ox, oy, W, H) {
  const put = (x, y, c) => {
    const px = ox + x, py = oy + y;
    if (px >= W || py >= H) return;
    const i = (py * outStride + px) * 4;
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = c[3];
  };
  const fill = c => { for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) put(x, y, c); };

  const mode = getBits(blk, 0, 11);
  // void extent
  if ((mode & 0x1FF) === 0x1FC) {
    if (mode & 0x200) { fill(ERR); return; }   // HDR void extent
    fill([blk[9], blk[11], blk[13], blk[15]]);
    return;
  }
  // block mode -> grid size, range, dual plane
  let gw, gh, R, H_, D = (mode >> 10) & 1;
  H_ = (mode >> 9) & 1;
  if ((mode & 3) !== 0) {
    R = ((mode >> 4) & 1) | ((mode & 3) << 1);
    const A = (mode >> 5) & 3, B = (mode >> 7) & 3;
    switch ((mode >> 2) & 3) {
      case 0: gw = B + 4; gh = A + 2; break;
      case 1: gw = B + 8; gh = A + 2; break;
      case 2: gw = A + 2; gh = B + 8; break;
      case 3: if ((mode >> 8) & 1) { gw = (B & 1) + 2; gh = A + 2; } else { gw = A + 2; gh = (B & 1) + 6; } break;
    }
  } else {
    R = ((mode >> 4) & 1) | (((mode >> 2) & 3) << 1);
    const A = (mode >> 5) & 3, B = (mode >> 9) & 3;
    if ((mode & 0xF) === 0) { fill(ERR); return; }   // reserved
    switch ((mode >> 7) & 3) {
      case 0: gw = 12; gh = A + 2; break;
      case 1: gw = A + 2; gh = 12; break;
      case 2: gw = A + 6; gh = B + 6; D = 0; H_ = 0; break;
      case 3:
        if (((mode >> 5) & 3) === 0) { gw = 6; gh = 10; }
        else if (((mode >> 5) & 3) === 1) { gw = 10; gh = 6; }
        else { fill(ERR); return; }
        break;
    }
  }
  if (R < 2) { fill(ERR); return; }
  const wLevels = WEIGHT_LEVELS[H_][R];
  const planes = D ? 2 : 1;
  const nWeights = gw * gh * planes;
  if (nWeights > 64 || gw > bw || gh > bh) { fill(ERR); return; }
  const wBits = iseBits(wLevels, nWeights);
  if (wBits < 24 || wBits > 96) { fill(ERR); return; }

  const parts = getBits(blk, 11, 2) + 1;
  if (D && parts === 4) { fill(ERR); return; }
  let colorStart, seed = 0;
  const cems = [];
  const belowWeights = 128 - wBits;
  let extraEnd = belowWeights;
  if (parts === 1) {
    cems.push(getBits(blk, 13, 4));
    colorStart = 17;
  } else {
    seed = getBits(blk, 13, 10);
    const field = getBits(blk, 23, 6);
    const sel = field & 3;
    if (sel === 0) {
      const c = field >> 2;
      for (let i = 0; i < parts; i++) cems.push(c);
    } else {
      const extra = 3 * parts - 4;
      extraEnd = belowWeights - extra;
      const all = (field >> 2) | (getBits(blk, extraEnd, extra) << 4);
      const base = sel - 1;
      for (let i = 0; i < parts; i++) {
        const c = (all >> i) & 1;
        const m = (all >> (parts + 2 * i)) & 3;
        cems.push(((base + c) << 2) | m);
      }
    }
    colorStart = 29;
  }
  let ccs = -1;
  let colorEnd = extraEnd;
  if (D) { colorEnd -= 2; ccs = getBits(blk, colorEnd, 2); }

  // color values
  let nValues = 0;
  for (const c of cems) nValues += ((c >> 2) + 1) * 2;
  if (nValues > 18) { fill(ERR); return; }
  const avail = colorEnd - colorStart;
  let cLevels = 0;
  for (let i = COLOR_LEVELS.length - 1; i >= 0; i--) {
    if (iseBits(COLOR_LEVELS[i], nValues) <= avail) { cLevels = COLOR_LEVELS[i]; break; }
  }
  if (!cLevels) { fill(ERR); return; }
  const rd = (s, n) => getBits(blk, s, n);
  const cvals = decodeISE(rd, colorStart, cLevels, nValues).map(unqColor);

  const endpoints = [];
  let vi = 0;
  for (let p = 0; p < parts; p++) {
    const n = ((cems[p] >> 2) + 1) * 2;
    const ep = decodeEndpoints(cems[p], cvals.slice(vi, vi + n));
    vi += n;
    if (!ep) { fill(ERR); return; }
    endpoints.push(ep);
  }


  // weights: stored bit-reversed from the top of the block
  const rdRev = (s, n) => { let v = 0; for (let i = 0; i < n; i++) { const bit = 127 - (s + i); v |= ((blk[bit >> 3] >> (bit & 7)) & 1) << i; } return v >>> 0; };
  const wq = decodeISE(rdRev, 0, wLevels, nWeights).map(unqWeight);

  // infill weights to texel grid
  const Ds = Math.floor((1024 + (bw >> 1)) / (bw - 1));
  const Dt = Math.floor((1024 + (bh >> 1)) / (bh - 1));
  const small = bw * bh < 31;
  const tw = new Array(planes);
  for (let pl = 0; pl < planes; pl++) {
    const arr = new Uint8Array(bw * bh);
    for (let t = 0; t < bh; t++) for (let s = 0; s < bw; s++) {
      if (gw === bw && gh === bh) { arr[t * bw + s] = wq[(t * gw + s) * planes + pl]; continue; }
      const cs = Ds * s, ct = Dt * t;
      const gs = (cs * (gw - 1) + 32) >> 6, gt = (ct * (gh - 1) + 32) >> 6;
      const js = gs >> 4, fs = gs & 0xF, jt = gt >> 4, ft = gt & 0xF;
      const v0 = js + jt * gw;
      const w11 = (fs * ft + 8) >> 4, w10 = ft - w11, w01 = fs - w11, w00 = 16 - fs - ft + w11;
      const g = i => (i < gw * gh ? wq[i * planes + pl] : 0);
      const p00 = g(v0), p01 = js + 1 < gw ? g(v0 + 1) : 0, p10 = jt + 1 < gh ? g(v0 + gw) : 0, p11 = (js + 1 < gw && jt + 1 < gh) ? g(v0 + gw + 1) : 0;
      arr[t * bw + s] = (p00 * w00 + p01 * w01 + p10 * w10 + p11 * w11 + 8) >> 4;
    }
    tw[pl] = arr;
  }

  const c = [0, 0, 0, 0];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const p = parts > 1 ? selectPartition(seed, x, y, 0, parts, small) : 0;
    const [e0, e1] = endpoints[p];
    const w0 = tw[0][y * bw + x];
    for (let ch = 0; ch < 4; ch++) {
      const w = (D && ch === ccs) ? tw[1][y * bw + x] : w0;
      const a = e0[ch] * 257, b = e1[ch] * 257;
      const v = (a * (64 - w) + b * w + 32) >> 6;
      c[ch] = Math.min(255, (v * 255 + 32768) >>> 16);
    }
    put(x, y, c);
  }
}

/** Decode ASTC data (top mip only) to RGBA8. */
export function decodeASTC(data, width, height, bw, bh) {
  const out = new Uint8Array(width * height * 4);
  const bx = Math.ceil(width / bw), by = Math.ceil(height / bh);
  let off = 0;
  for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
    decodeBlock(data.subarray(off, off + 16), bw, bh, out, width, i * bw, j * bh, width, height);
    off += 16;
  }
  return out;
}

export const ASTC_FORMATS = {   // Unity TextureFormat -> block size
  48: [4, 4], 49: [5, 5], 50: [6, 6], 51: [8, 8], 52: [10, 10], 53: [12, 12],
  54: [4, 4], 55: [5, 5], 56: [6, 6], 57: [8, 8], 58: [10, 10], 59: [12, 12],
};
