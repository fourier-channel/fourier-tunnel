"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { extractCreatorTags, pngTextChunks, promptToTags } = require("./prompt-tags");

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.from([0, 0, 0, 0])]); // dummy CRC
}
function png(chunks) { return Buffer.concat([SIG, ...chunks]); }
function tEXt(keyword, text) { return chunk("tEXt", Buffer.from(keyword + "\0" + text, "latin1")); }

test("A1111: content vs quality/meta split; weights/lora/negatives dropped", () => {
  const params =
    "masterpiece, best quality, highres, 1girl, solo, twintails, blue_hair, (smile:1.2), <lora:foo:0.8>\n" +
    "Negative prompt: bad hands, lowres\n" +
    "Steps: 20, Sampler: Euler a";
  const r = extractCreatorTags(png([tEXt("parameters", params), chunk("IEND", Buffer.alloc(0))]), "image/png");
  assert.ok(r.tags.includes("1girl") && r.tags.includes("twintails") && r.tags.includes("blue_hair"));
  assert.ok(r.tags.includes("smile"), "weight stripped to bare tag");
  assert.ok(r.meta.includes("masterpiece") && r.meta.includes("best_quality") && r.meta.includes("highres"), "quality/meta classified, not dropped");
  assert.ok(!r.tags.includes("masterpiece"), "quality term kept out of content bucket");
  assert.ok(!r.tags.includes("bad_hands"), "negative prompt excluded");
  assert.ok(!r.tags.concat(r.meta).some((t) => t.includes("lora")), "lora token removed");
});

test("ComfyUI: positive CLIP text chosen over the shorter negative", () => {
  const graph = JSON.stringify({
    "3": { class_type: "CLIPTextEncode", inputs: { text: "masterpiece, 1girl, hoodie, backpack, monochrome" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "lowres, bad" } },
  });
  const r = extractCreatorTags(png([tEXt("prompt", graph), chunk("IEND", Buffer.alloc(0))]), "image/png");
  assert.ok(r.tags.includes("1girl") && r.tags.includes("hoodie") && r.tags.includes("backpack"));
  assert.ok(r.meta.includes("masterpiece"));
  assert.ok(!r.tags.includes("lowres"), "negative CLIP text not chosen");
});

test("zTXt (compressed) parameters inflate and read as content", () => {
  const comp = zlib.deflateSync(Buffer.from("landscape, scenery, no_humans, wide_shot", "utf8"));
  const data = Buffer.concat([Buffer.from("parameters\0", "latin1"), Buffer.from([0]), comp]);
  const r = extractCreatorTags(png([chunk("zTXt", data), chunk("IEND", Buffer.alloc(0))]), "image/png");
  assert.deepEqual(r.tags, ["landscape", "scenery", "no_humans", "wide_shot"]);
  assert.deepEqual(r.meta, []);
});

test("non-AI image (no text chunks) -> empty tags and meta", () => {
  assert.deepEqual(extractCreatorTags(png([chunk("IEND", Buffer.alloc(0))]), "image/png"), { tags: [], meta: [] });
});

test("non-PNG / null bytes -> empty (never throws)", () => {
  assert.deepEqual(extractCreatorTags(Buffer.from("ffd8ffe0", "hex"), "image/jpeg"), { tags: [], meta: [] });
  assert.deepEqual(extractCreatorTags(null, ""), { tags: [], meta: [] });
});

test("promptToTags dedupes content and respects max (meta not counted against max)", () => {
  assert.deepEqual(promptToTags("1girl, 1girl, solo", {}).tags, ["1girl", "solo"]);
  assert.equal(promptToTags("a_tag, b_tag, c_tag", { max: 2 }).tags.length, 2);
});

test("pngTextChunks returns {} for a truncated buffer", () => {
  assert.deepEqual(pngTextChunks(Buffer.from([1, 2, 3])), {});
});

// --- JPEG and WebP: the same prompt, carried in EXIF -------------------------
// A TIFF payload by hand, the way fourier-sampling's converter writes one:
// IFD0 -> ExifIFD -> UserComment, plus an optional ImageDescription on IFD0.
function tiff({ userComment, imageDescription, order = "MM" } = {}) {
  const be = order === "MM";
  const w16 = (b, v, o) => (be ? b.writeUInt16BE(v, o) : b.writeUInt16LE(v, o));
  const w32 = (b, v, o) => (be ? b.writeUInt32BE(v, o) : b.writeUInt32LE(v, o));
  const ifd0Entries = [];
  const exifEntries = [];
  if (imageDescription !== undefined) ifd0Entries.push({ tag: 0x010e, type: 2, raw: Buffer.from(imageDescription + "\0", "utf8") });
  ifd0Entries.push({ tag: 0x8769, type: 4, raw: null }); // pointer, patched below
  if (userComment !== undefined) exifEntries.push({ tag: 0x9286, type: 7, raw: userComment });
  const ifd0Off = 8;
  const ifd0Len = 2 + 12 * ifd0Entries.length + 4;
  const exifOff = ifd0Off + ifd0Len;
  const exifLen = 2 + 12 * exifEntries.length + 4;
  let dataOff = exifOff + exifLen;
  const data = [];
  const encodeIfd = (entries, off) => {
    const b = Buffer.alloc(2 + 12 * entries.length + 4);
    w16(b, entries.length, 0);
    entries.forEach((e, i) => {
      const rec = 2 + i * 12;
      w16(b, e.tag, rec); w16(b, e.type, rec + 2);
      if (e.tag === 0x8769) { w32(b, 1, rec + 4); w32(b, exifOff, rec + 8); return; }
      w32(b, e.raw.length, rec + 4);
      if (e.raw.length <= 4) { e.raw.copy(b, rec + 8); } else { w32(b, dataOff, rec + 8); data.push(e.raw); dataOff += e.raw.length + (e.raw.length % 2); if (e.raw.length % 2) data.push(Buffer.alloc(1)); }
    });
    return b;
  };
  const head = Buffer.alloc(8); head.write(order, 0, "latin1"); w16(head, 42, 2); w32(head, 8, 4);
  const ifd0 = encodeIfd(ifd0Entries, ifd0Off);
  const exif = encodeIfd(exifEntries, exifOff);
  return Buffer.concat([head, ifd0, exif, ...data]);
}
function jpeg(tiffBuf) {
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiffBuf]);
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(payload.length + 2, 2);
  // SOI, a JFIF APP0 first (as cameras and encoders write), then APP1, then a scan.
  const app0 = Buffer.from("ffe00010" + Buffer.from("JFIF\0", "latin1").toString("hex") + "0101000001000100" + "0000", "hex");
  return Buffer.concat([Buffer.from("ffd8", "hex"), app0, seg, payload, Buffer.from("ffda0008", "hex"), Buffer.alloc(6), Buffer.from("ffd9", "hex")]);
}
function webp(tiffBuf, withHeader) {
  const exifData = withHeader ? Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiffBuf]) : tiffBuf;
  const chunk = (fourcc, d) => { const h = Buffer.alloc(8); h.write(fourcc, 0, "latin1"); h.writeUInt32LE(d.length, 4); return Buffer.concat([h, d, d.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), chunk("VP8X", Buffer.alloc(10)), chunk("EXIF", exifData), chunk("VP8 ", Buffer.alloc(3))]);
  const riff = Buffer.alloc(8); riff.write("RIFF", 0, "latin1"); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
const ascii = (t) => Buffer.concat([Buffer.from("ASCII\0\0\0", "latin1"), Buffer.from(t, "utf8")]);
const unicodeBE = (t) => Buffer.concat([Buffer.from("UNICODE\0", "latin1"), (() => { const b = Buffer.from(t, "utf16le"); b.swap16(); return b; })()]);
const unicodeLE = (t) => Buffer.concat([Buffer.from("UNICODE\0", "latin1"), Buffer.from(t, "utf16le")]);
const PARAMS = "1girl, solo, twintails, blue_hair, masterpiece\nNegative prompt: bad hands\nSteps: 20, Sampler: Euler a";

test("JPEG: A1111 parameters in EXIF UserComment (ASCII, as fourier-sampling writes it)", () => {
  const r = extractCreatorTags(jpeg(tiff({ userComment: ascii(PARAMS) })), "image/jpeg");
  assert.deepEqual(r.tags, ["1girl", "solo", "twintails", "blue_hair"]);
  assert.deepEqual(r.meta, ["masterpiece"]);
});

test("JPEG: UNICODE UserComment in either byte order (piexif writes BE, others LE)", () => {
  for (const enc of [unicodeBE, unicodeLE]) {
    const r = extractCreatorTags(jpeg(tiff({ userComment: enc(PARAMS) })), "image/jpeg");
    assert.deepEqual(r.tags, ["1girl", "solo", "twintails", "blue_hair"], enc.name);
  }
});

test("JPEG: little-endian TIFF reads the same as big-endian", () => {
  const r = extractCreatorTags(jpeg(tiff({ userComment: ascii(PARAMS), order: "II" })), "image/jpeg");
  assert.deepEqual(r.tags, ["1girl", "solo", "twintails", "blue_hair"]);
});

test("JPEG: a ComfyUI graph in UserComment is read as the prompt embedding", () => {
  const graph = JSON.stringify({
    "3": { class_type: "CLIPTextEncode", inputs: { text: "masterpiece, 1girl, hoodie, backpack" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "lowres" } },
  });
  const r = extractCreatorTags(jpeg(tiff({ userComment: ascii(graph) })), "image/jpeg");
  assert.deepEqual(r.tags, ["1girl", "hoodie", "backpack"]);
  assert.deepEqual(r.meta, ["masterpiece"]);
});

test("JPEG: ImageDescription is read when UserComment is absent", () => {
  const r = extractCreatorTags(jpeg(tiff({ imageDescription: "landscape, scenery, no_humans" })), "image/jpeg");
  assert.deepEqual(r.tags, ["landscape", "scenery", "no_humans"]);
});

test("JPEG: the bytes decide, not the declared type", () => {
  const r = extractCreatorTags(jpeg(tiff({ userComment: ascii(PARAMS) })), "application/octet-stream");
  assert.deepEqual(r.tags, ["1girl", "solo", "twintails", "blue_hair"]);
});

test("JPEG: no APP1, a truncated segment, and a bogus IFD offset all read as empty, never throw", () => {
  assert.deepEqual(extractCreatorTags(Buffer.from("ffd8ffda0008000000000000ffd9", "hex"), "image/jpeg"), { tags: [], meta: [] });
  const whole = jpeg(tiff({ userComment: ascii(PARAMS) }));
  assert.deepEqual(extractCreatorTags(whole.subarray(0, 40), "image/jpeg"), { tags: [], meta: [] });
  const bad = tiff({ userComment: ascii(PARAMS) }); bad.writeUInt32BE(0x7fffffff, 4);
  assert.deepEqual(extractCreatorTags(jpeg(bad), "image/jpeg"), { tags: [], meta: [] });
});

test("WebP: the EXIF chunk, with and without the Exif header, reads like a JPEG", () => {
  for (const withHeader of [true, false]) {
    const r = extractCreatorTags(webp(tiff({ userComment: ascii(PARAMS) }), withHeader), "image/webp");
    assert.deepEqual(r.tags, ["1girl", "solo", "twintails", "blue_hair"], `header=${withHeader}`);
  }
});

test("PNG still reads exactly as before through the same door", () => {
  const r = extractCreatorTags(png([tEXt("parameters", PARAMS), chunk("IEND", Buffer.alloc(0))]), "image/png");
  assert.deepEqual(r.tags, ["1girl", "solo", "twintails", "blue_hair"]);
});

// --- the qualifier survives -------------------------------------------------
const { normalizeTerm } = require("./prompt-tags");

test("normaliser: escaped and trailing qualifiers are kept, emphasis and weights are not", () => {
  assert.equal(normalizeTerm("hilda \\(pokemon\\)"), "hilda_(pokemon)");
  assert.equal(normalizeTerm("hilda (pokemon)"), "hilda_(pokemon)");
  assert.equal(normalizeTerm("(hilda \\(pokemon\\):1.3)"), "hilda_(pokemon)");
  assert.equal(normalizeTerm("(hilda:1.2)"), "hilda");
  assert.equal(normalizeTerm("((hilda))"), "hilda");
  assert.equal(normalizeTerm("(masterpiece)"), "masterpiece");
});

test("normaliser: colons and slashes inside names survive; a colon-number is a weight", () => {
  assert.equal(normalizeTerm("re:zero kara hajimeru isekai seikatsu"), "re:zero_kara_hajimeru_isekai_seikatsu");
  assert.equal(normalizeTerm("fate/grand order"), "fate/grand_order");
  assert.equal(normalizeTerm("blue hair:0.8"), "blue_hair");
});

test("prompt with a qualified character lands as that character's name", () => {
  const r = promptToTags("masterpiece, 1girl, hilda \\(pokemon\\), (smile:1.1), astolfo \\(fate\\)");
  assert.deepEqual(r.tags, ["1girl", "hilda_(pokemon)", "smile", "astolfo_(fate)"]);
});

test("normaliser: search operators and handles do not become tags", () => {
  assert.equal(normalizeTerm("@h4ra1d2"), "h4ra1d2");
  assert.equal(normalizeTerm("-blurry"), "blurry");
  assert.equal(normalizeTerm("~maybe"), "maybe");
  assert.equal(normalizeTerm("tom & jerry"), "tom_&_jerry");
  assert.equal(normalizeTerm("k-on!"), "k-on!");
});
