"use strict";

// png-pixels.js against images this file ENCODES ITSELF: its own filters (all
// five types, row by row), its own Adam7 split, its own zlib stream. Decoding
// must give back exactly the samples that went in. The stealth work in
// strip-generation.js -- finding a hidden copy of a prompt in the pixels,
// clearing it, and the post-condition that checks it is gone -- is only as
// good as this reading, so the reading is pinned apart from it. (It was also
// checked against Pillow's own view of every colour type, depth and
// interlace on 2026-09-29; a decoder that disagreed with Pillow would miss
// what Pillow-based readers find.)

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const px = require("./png-pixels");

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, crc]);
}
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// A deterministic stream of bytes, so a failure reproduces.
function rand(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 16) & 0xff; };
}

// Filter rows the way the spec defines, each row under type (row % 5).
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function filterRows(rows, bpp) {
  const out = [];
  rows.forEach((row, r) => {
    const ft = r % 5, prev = r > 0 ? rows[r - 1] : null, f = Buffer.alloc(row.length);
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
      f[i] = (row[i] - [0, a, b, (a + b) >> 1, paeth(a, b, c)][ft]) & 0xff;
    }
    out.push(Buffer.from([ft]), f);
  });
  return Buffer.concat(out);
}
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

// samples[y][x] = [channel values]; depth 8 or 16 here (sub-byte below).
function encode({ width, height, depth, colorType, channels, interlace = 0, samples, extra = [] }) {
  const size = depth >> 3, bpp = channels * size;
  const rowOf = (xs) => {
    const b = Buffer.alloc(xs.length * bpp);
    xs.forEach((x, i) => (x).forEach((v, c) => { if (size === 1) b[i * bpp + c] = v; else b.writeUInt16BE(v, i * bpp + 2 * c); }));
    return b;
  };
  const parts = [];
  for (const [xs, ys, dx, dy] of interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const rows = [];
    for (let y = ys; y < height; y += dy) {
      const line = [];
      for (let x = xs; x < width; x += dx) line.push(samples[y][x]);
      if (line.length) rows.push(rowOf(line));
    }
    if (rows.length) parts.push(filterRows(rows, bpp));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = colorType; ihdr[12] = interlace;
  const z = zlib.deflateSync(Buffer.concat(parts));
  // Split across three IDAT chunks: one stream, however a writer cut it.
  const third = Math.ceil(z.length / 3);
  const idats = [0, 1, 2].map((k) => chunk("IDAT", z.subarray(k * third, (k + 1) * third)));
  return Buffer.concat([SIG, chunk("IHDR", ihdr), ...extra, ...idats, chunk("IEND", Buffer.alloc(0))]);
}
function randomSamples(width, height, channels, max, seed) {
  const r = rand(seed);
  return Array.from({ length: height }, () => Array.from({ length: width }, () => Array.from({ length: channels }, () => (max > 255 ? (r() << 8) | r() : r()) % (max + 1))));
}

for (const [label, depth, colorType, channels, interlace] of [
  ["RGBA 8-bit", 8, 6, 4, 0], ["RGBA 8-bit, interlaced", 8, 6, 4, 1], ["RGB 16-bit", 16, 2, 3, 0],
  ["RGBA 16-bit, interlaced", 16, 6, 4, 1], ["grey+alpha 8-bit", 8, 4, 2, 0], ["grey 16-bit, interlaced", 16, 0, 1, 1],
]) {
  test(`decode: ${label}, every filter type, gives back exactly the samples that went in`, () => {
    const width = 13, height = 11;
    const samples = randomSamples(width, height, channels, depth === 16 ? 65535 : 255, width * depth + colorType + interlace);
    const png = encode({ width, height, depth, colorType, channels, interlace, samples });
    const dec = px.decode(png, { whole: true });
    assert.equal(dec.error, undefined, dec.error);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      assert.deepEqual(px.samplesAt(dec.img, dec.data, x, y), samples[y][x], `pixel ${x},${y}`);
    }
  });
}

test("decode: only the rows the first N pixels in column order need, and those agree with the whole decode", () => {
  const width = 9, height = 300;
  const samples = randomSamples(width, height, 4, 255, 5);
  const png = encode({ width, height, depth: 8, colorType: 6, channels: 4, samples });
  const head = px.decode(png, { pixels: 120 });
  assert.equal(head.rows, 120, "a column of 300 holds the first 120 pixels in its top 120 rows");
  assert.equal(head.data.length, 120 * (width * 4 + 1));
  for (let y = 0; y < 120; y++) assert.deepEqual(px.samplesAt(head.img, head.data, 0, y), samples[y][0]);
  const short = px.decode(encode({ width: 50, height: 7, depth: 8, colorType: 6, channels: 4, samples: randomSamples(50, 7, 4, 255, 6) }), { pixels: 120 });
  assert.equal(short.rows, 7, "a short image needs every row, and the first 18 columns of each");
});

test("sub-byte samples and palettes: a 2-bit palette with tRNS reads Pillow's way", () => {
  // 3 x 2 pixels, 2 bits each: indices 0 1 2 / 3 0 1.
  const idx = [[0, 1, 2], [3, 0, 1]];
  const rows = idx.map((r) => Buffer.from([(r[0] << 6) | (r[1] << 4) | (r[2] << 2)]));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 2; ihdr[9] = 3;
  const plte = chunk("PLTE", Buffer.from([1, 2, 3, 10, 11, 12, 255, 254, 0, 7, 8, 9]));
  const trns = chunk("tRNS", Buffer.from([0, 255, 128]));
  const png = Buffer.concat([SIG, chunk("IHDR", ihdr), plte, trns, chunk("IDAT", zlib.deflateSync(Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), r]))))), chunk("IEND", Buffer.alloc(0))]);
  const dec = px.decode(png, { whole: true });
  assert.deepEqual(px.samplesAt(dec.img, dec.data, 2, 0), [2]);
  assert.deepEqual(px.samplesAt(dec.img, dec.data, 0, 1), [3]);
  assert.deepEqual(px.lsbAt(dec.img, dec.data, 0, 0, "8-bit"), [1, 0, 1, 0], "PLTE 1,2,3 and alpha 0");
  assert.deepEqual(px.lsbAt(dec.img, dec.data, 2, 0, "8-bit"), [1, 0, 0, 0], "PLTE 255,254,0 and alpha 128");
  assert.deepEqual(px.lsbAt(dec.img, dec.data, 0, 1, "8-bit"), [1, 0, 1, 1], "index 3 has no tRNS entry: opaque");
});

test("16-bit samples have two views: the byte Pillow reads, and the sample's own low bit", () => {
  const samples = [[[0x0100, 0x0001, 0xfffe, 0x01ff]]];
  const png = encode({ width: 1, height: 1, depth: 16, colorType: 6, channels: 4, samples });
  const dec = px.decode(png, { whole: true });
  assert.deepEqual(px.viewsOf(dec.img), ["8-bit", "16-bit"]);
  assert.deepEqual(px.lsbAt(dec.img, dec.data, 0, 0, "8-bit"), [1, 0, 1, 1]);
  assert.deepEqual(px.lsbAt(dec.img, dec.data, 0, 0, "16-bit"), [0, 1, 0, 1]);
});

test("refilter is the inverse of the decode: the same rows, under the same filter types", () => {
  const samples = randomSamples(10, 12, 4, 255, 9);
  const png = encode({ width: 10, height: 12, depth: 8, colorType: 6, channels: 4, interlace: 1, samples });
  const dec = px.decode(png, { whole: true });
  const idat = Buffer.concat(px.chunksOf(png).filter((c) => c.type === "IDAT").map((c) => c.data));
  assert.ok(px.refilter(dec.img, dec.data).equals(zlib.inflateSync(idat)), "byte for byte the filtered stream that was encoded");
});

test("what no decoder could read is an error, never a guess", () => {
  const good = encode({ width: 2, height: 2, depth: 8, colorType: 2, channels: 3, samples: randomSamples(2, 2, 3, 255, 1) });
  const ihdrAt = 8 + 8;
  const withIhdr = (patch) => { const b = Buffer.from(good); patch(b); return b; };
  assert.match(px.decode(Buffer.from("not a png at all")).error, /not a PNG/);
  assert.match(px.decode(withIhdr((b) => b.writeUInt32BE(0, ihdrAt))).error, /0 x 2 image/);
  assert.match(px.decode(withIhdr((b) => { b[ihdrAt + 8] = 3; })).error, /colour type 2 at bit depth 3/);
  const noIdat = Buffer.concat(px.chunksOf(good).filter((c) => c.type !== "IDAT").map((c) => good.subarray(c.start, c.end)));
  assert.match(px.decode(Buffer.concat([SIG, noIdat])).error, /no image data/);
  const idat = px.chunksOf(good).find((c) => c.type === "IDAT");
  const corrupt = Buffer.from(good); corrupt.fill(0xff, idat.start + 8, idat.end - 4);
  assert.match(px.decode(corrupt).error, /will not inflate/);
  const palette = withIhdr((b) => { b[ihdrAt + 9] = 3; });
  assert.match(px.decode(palette).error, /no palette/);
});

test("inflatePrefix: a stream built to balloon is read only as far as asked, never to its end", () => {
  const huge = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024));   // 64 MiB of zeros, ~64 KiB compressed
  const out = px.inflatePrefix(huge, 1000, 1 << 20);
  assert.ok(out.length >= 1000 && out.length <= 1 << 20, `${out.length} bytes`);
  const small = zlib.deflateSync(Buffer.from("abc"));
  assert.equal(px.inflatePrefix(small, 1000, 1 << 20).toString(), "abc", "a stream that ends first gives what it has");
  // A wrong Adler-32 at the end: browsers show the picture, so it is readable.
  const badSum = Buffer.from(small); badSum[badSum.length - 1] ^= 0xff;
  assert.equal(px.inflatePrefix(badSum, 1000, 1 << 20).toString(), "abc");
  assert.throws(() => px.inflatePrefix(Buffer.from("not zlib"), 10, 100), /not a zlib stream/);
});
