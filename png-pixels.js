"use strict";

// A PNG'S PIXELS, READ WITHOUT A CODEC: the IHDR, the IDAT stream inflated,
// each scanline unfiltered, each sample read the way Pillow reads it.
//
// WHY THE TUNNEL READS PIXELS AT ALL. NovelAI, and the A1111 "stealth
// pnginfo" extension, put a SECOND copy of the generation data in the least
// significant bit of every pixel: a magic string ("stealth_pngcomp" and its
// kin), a 32-bit length, then the payload, column by column from the top
// left. Removing the text chunks leaves that copy in the image, where
// NovelAI's own published reader and the extension both find it
// (strip-generation.js, "stealth"). Finding it, clearing it and checking it
// is gone all start here.
//
// PILLOW'S VIEW, because Pillow is what both readers open the file with: a
// 16-bit sample is seen by its HIGH byte, a 1-, 2- or 4-bit grey or palette
// sample by its value (Pillow scales those by an odd number, so the least
// significant bit survives), a palette pixel by its PLTE colour and its tRNS
// alpha. A 16-bit sample's own low bit is offered as a second view: a reader
// built on another library would see that one.
//
// BOUNDED. Nothing here decodes more of an image than it is asked for: the
// check reads the first rows only, and inflatePrefix never lets a stream
// built to balloon take the memory with it. A whole image is decoded only to
// clear it, and only up to MAX_DECODE.

const zlib = require("zlib");

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// The most inflated image data this will hold at once: 512 MiB is an
// 11585 x 11585 RGBA picture. Past it, a picture that needs decoding whole
// is refused rather than guessed at.
const MAX_DECODE = 512 * 1024 * 1024;

// Channels per color type, and the bit depths the PNG spec allows each.
const CHANNELS = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
const DEPTHS = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);

// Adam7: each pass's first column, first row, and step in each direction.
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

// Every chunk to IEND, CRCs not checked: { type, start, end, data }.
function chunksOf(buf) {
  const chunks = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const end = off + 12 + len;
    if (end > buf.length) break;
    const type = buf.toString("latin1", off + 4, off + 8);
    chunks.push({ type, start: off, end, data: buf.subarray(off + 8, off + 8 + len) });
    off = end;
    if (type === "IEND") break;
  }
  return chunks;
}

/**
 * What the IHDR says, and where the image data is. { error } when there is
 * nothing a decoder could read: no IHDR, a size or depth the spec forbids, no
 * IDAT, a palette image with no palette.
 */
function describe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return { error: "it is not a PNG" };
  const chunks = chunksOf(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) return { error: "it has no image header (IHDR)" };
  const width = ihdr.data.readUInt32BE(0), height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8], colorType = ihdr.data[9], interlace = ihdr.data[12];
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) return { error: `its header declares a ${width} x ${height} image` };
  if (!CHANNELS.has(colorType) || !DEPTHS.get(colorType).includes(depth)) return { error: `its header declares colour type ${colorType} at bit depth ${depth}, which no decoder reads` };
  if (interlace > 1) return { error: `its header declares interlace method ${interlace}` };
  const channels = CHANNELS.get(colorType);
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const plte = chunks.find((c) => c.type === "PLTE");
  if (colorType === 3 && !plte) return { error: "it is a palette image with no palette (PLTE)" };
  const trns = chunks.find((c) => c.type === "tRNS");
  const idat = chunks.filter((c) => c.type === "IDAT");
  if (!idat.length) return { error: "it has no image data (IDAT)" };

  const passes = [];
  let offset = 0;
  for (const [xs, ys, dx, dy] of interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const w = width > xs ? Math.ceil((width - xs) / dx) : 0;
    const h = height > ys ? Math.ceil((height - ys) / dy) : 0;
    const rowBytes = Math.ceil((w * bitsPerPixel) / 8);
    passes.push({ xs, ys, dx, dy, w, h, rowBytes, offset });
    if (w && h) offset += (rowBytes + 1) * h;
  }
  return {
    width, height, depth, colorType, interlace, channels, bitsPerPixel, bpp, passes,
    size: offset,
    palette: plte ? plte.data : null,
    trns: trns ? trns.data : null,
    idat,
  };
}

/**
 * The first `want` bytes of a zlib stream, inflating no more of it than that
 * takes. A truncated deflate stream inflates, under Z_SYNC_FLUSH, to a prefix
 * of its output, so the input is fed in doubling prefixes; every attempt's
 * output is capped at `cap`, and one that would pass it is retried on less
 * input. Returns what there is -- shorter than `want` when the stream ends
 * first. Throws when the stream is corrupt before `want` bytes.
 *
 * Read as RAW deflate past the 2-byte zlib header, so the Adler-32 at the end
 * is never checked: browsers do not check it either, and a picture that shows
 * everywhere must not be "unreadable" here over a checksum.
 */
function inflatePrefix(data, want, cap) {
  if (data.length < 2 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0 || data[1] & 0x20) {
    throw new Error("it is not a zlib stream");
  }
  const body = data.subarray(2);
  const opts = { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: cap };
  let lo = 0;                 // input known to inflate to less than `want`
  let hi = body.length;       // input known not to exceed the cap (or all of it)
  let k = Math.min(hi, Math.max(4096, want >> 3));
  for (let tries = 0; tries < 96; tries++) {
    let out = null;
    try {
      out = zlib.inflateRawSync(body.subarray(0, k), opts);
    } catch (err) {
      if (!err || err.code !== "ERR_BUFFER_TOO_LARGE") throw err;
    }
    if (out && (out.length >= want || k >= body.length)) return out;
    if (out) { lo = k; k = Math.min(hi, k * 2); } else { hi = k - 1; k = lo + Math.max(1, (k - lo) >> 1); }
    if (k <= lo || k > hi) break;
  }
  throw new Error(`the image data would not inflate to ${want} bytes within ${cap}`);
}

// Undo the PNG filters of rows [0, rows) of one pass, IN PLACE. Each row keeps
// its filter-type byte, so the filters can be put back (refilter).
function unfilter(data, pass, bpp, rows) {
  const stride = pass.rowBytes + 1;
  for (let r = 0; r < rows; r++) {
    const at = pass.offset + r * stride;
    const ft = data[at], line = at + 1, up = line - stride;
    const n = pass.rowBytes;
    if (ft === 0) continue;
    if (ft === 1) {
      for (let i = bpp; i < n; i++) data[line + i] = (data[line + i] + data[line + i - bpp]) & 0xff;
    } else if (ft === 2) {
      if (r > 0) for (let i = 0; i < n; i++) data[line + i] = (data[line + i] + data[up + i]) & 0xff;
    } else if (ft === 3) {
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? data[line + i - bpp] : 0, b = r > 0 ? data[up + i] : 0;
        data[line + i] = (data[line + i] + ((a + b) >> 1)) & 0xff;
      }
    } else if (ft === 4) {
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? data[line + i - bpp] : 0, b = r > 0 ? data[up + i] : 0;
        const c = i >= bpp && r > 0 ? data[up + i - bpp] : 0;
        data[line + i] = (data[line + i] + paeth(a, b, c)) & 0xff;
      }
    } else {
      throw new Error(`row ${r} carries filter type ${ft}, which does not exist`);
    }
  }
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// The filtered form of unfiltered `data`, each row under the filter type it
// arrived with: what goes back into IDAT once a pixel has changed.
function refilter(img, data) {
  const out = Buffer.from(data);
  for (const pass of img.passes) {
    if (!pass.w || !pass.h) continue;
    const stride = pass.rowBytes + 1, n = pass.rowBytes, bpp = img.bpp;
    for (let r = 0; r < pass.h; r++) {
      const at = pass.offset + r * stride, line = at + 1, up = line - stride, ft = data[at];
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? data[line + i - bpp] : 0, b = r > 0 ? data[up + i] : 0;
        const c = i >= bpp && r > 0 ? data[up + i - bpp] : 0;
        const pred = ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : ft === 4 ? paeth(a, b, c) : 0;
        out[line + i] = (data[line + i] - pred) & 0xff;
      }
    }
  }
  return out;
}

/**
 * Decode an image's pixels, all of them (`whole`) or only as many rows from
 * the top as the first `pixels` pixels in column order need -- which, in an
 * interlaced image, is all of them anyway. Returns { img, data, rows } --
 * `rows` how many rows of the image can be read -- or { error }.
 */
function decode(buf, { pixels = Infinity, whole = false } = {}) {
  const img = describe(buf);
  if (img.error) return img;
  const rowsWanted = whole || img.interlace ? img.height : Math.min(img.height, Math.ceil(Math.min(pixels, img.width * img.height)));
  const want = img.interlace || whole ? img.size : (img.passes[0].rowBytes + 1) * rowsWanted;
  if (want > MAX_DECODE) return { error: `its image data is ${want} bytes inflated, more than the ${MAX_DECODE} this reads at once`, tooBig: true };
  let data;
  try {
    data = inflatePrefix(Buffer.concat(img.idat.map((c) => c.data)), want, want + (8 << 20));
  } catch (err) {
    return { error: `its image data will not inflate (${err && err.message ? err.message : String(err)})` };
  }
  if (data.length < want) return { error: `its image data ends after ${data.length} of the ${want} bytes needed` };
  data = Buffer.from(data.subarray(0, Math.max(want, 0)));
  try {
    if (img.interlace || whole) {
      for (const pass of img.passes) if (pass.w && pass.h) unfilter(data, pass, img.bpp, pass.h);
    } else {
      unfilter(data, img.passes[0], img.bpp, rowsWanted);
    }
  } catch (err) {
    return { error: `its image data does not unfilter (${err.message})` };
  }
  return { img, data, rows: rowsWanted };
}

// The raw samples of pixel (x, y): one value per channel, 0 .. 2^depth - 1.
function samplesAt(img, data, x, y) {
  let pass = img.passes[0];
  if (img.interlace) {
    for (const p of img.passes) {
      if (x >= p.xs && y >= p.ys && (x - p.xs) % p.dx === 0 && (y - p.ys) % p.dy === 0) { pass = p; break; }
    }
  }
  const px = (x - pass.xs) / pass.dx, py = (y - pass.ys) / pass.dy;
  const line = pass.offset + py * (pass.rowBytes + 1) + 1;
  const out = [];
  if (img.depth < 8) {
    const bit = px * img.depth;
    const byte = data[line + (bit >> 3)];
    out.push((byte >> (8 - img.depth - (bit & 7))) & ((1 << img.depth) - 1));
    return out;
  }
  const size = img.depth >> 3;
  const at = line + px * img.channels * size;
  for (let c = 0; c < img.channels; c++) out.push(size === 1 ? data[at + c] : (data[at + 2 * c] << 8) | data[at + 2 * c + 1]);
  return out;
}

// The views a reader could take of this image's least significant bits:
// Pillow's ("8-bit": a 16-bit sample's high byte) and, for 16-bit images, the
// sample's own low bit.
function viewsOf(img) {
  return img.depth === 16 ? ["8-bit", "16-bit"] : ["8-bit"];
}

/**
 * The least significant bits [r, g, b, a] of pixel (x, y) as `view` sees it,
 * with Pillow's convert("RGBA") filling in what the colour type lacks: grey
 * repeated into r, g and b, a palette index looked up, alpha from tRNS (a
 * matching colour key is 0, anything else 255).
 */
function lsbAt(img, data, x, y, view) {
  const v = samplesAt(img, data, x, y);
  const low = (s) => (img.depth === 16 && view === "8-bit" ? (s >> 8) & 1 : s & 1);
  const u16 = (b, i) => (b && b.length >= i + 2 ? b.readUInt16BE(i) : -1);
  switch (img.colorType) {
    case 0: {
      const g = low(v[0]);
      return [g, g, g, img.trns && v[0] === u16(img.trns, 0) ? 0 : 1];
    }
    case 2: {
      const keyed = img.trns && v[0] === u16(img.trns, 0) && v[1] === u16(img.trns, 2) && v[2] === u16(img.trns, 4);
      return [low(v[0]), low(v[1]), low(v[2]), keyed ? 0 : 1];
    }
    case 3: {
      const i = v[0], pal = img.palette;
      const rgb = 3 * i + 2 < pal.length ? [pal[3 * i] & 1, pal[3 * i + 1] & 1, pal[3 * i + 2] & 1] : [0, 0, 0];
      return [...rgb, img.trns && i < img.trns.length ? img.trns[i] & 1 : 1];
    }
    case 4: {
      const g = low(v[0]);
      return [g, g, g, low(v[1])];
    }
    default:
      return [low(v[0]), low(v[1]), low(v[2]), low(v[3])];
  }
}

module.exports = { PNG_SIG, MAX_DECODE, chunksOf, describe, decode, inflatePrefix, refilter, samplesAt, lsbAt, viewsOf };
