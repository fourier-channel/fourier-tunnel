"use strict";

// strip-generation.js against fixtures built here, byte by byte: what comes
// out, what stays, and that the files are still the files -- every PNG CRC
// valid, IDAT and the JPEG scan untouched, Orientation still 6, the RIFF size
// right, the GIF still walking to its trailer. A strip that "passes" while
// breaking the image would be the confident green this org keeps paying for,
// so the structure is walked, not trusted.
//
// STRIP_FIXTURE_DUMP=<dir> writes every fixture and its stripped bytes there,
// so an independent decoder (PIL, exiftool, a browser) can open them.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const {
  stripGeneration, stripOnce, residue, markerResidue, promptTagsResidue, stealthResidue, carriersIn,
  hasGenerationMarkers, looksLikePrompt, promptStrength, demirror, PNG_GENERATOR_KEYS, LOOSE, STRONG,
} = require("./strip-generation");
const { embeddedChunks, extractCreatorTags, extractCreatorTagsFromFields } = require("./prompt-tags");
const crypto = require("node:crypto");

// --- dump -------------------------------------------------------------------

function dump(name, ext, raw, stripped) {
  const dir = process.env.STRIP_FIXTURE_DUMP;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.raw.${ext}`), raw);
  fs.writeFileSync(path.join(dir, `${name}.stripped.${ext}`), stripped);
}

// --- PNG ----------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, crc]);
}
const tEXt = (k, v) => chunk("tEXt", Buffer.from(`${k}\0${v}`, "latin1"));
const zTXt = (k, v) => chunk("zTXt", Buffer.concat([Buffer.from(`${k}\0`, "latin1"), Buffer.from([0]), zlib.deflateSync(Buffer.from(v, "utf8"))]));
const iTXt = (k, v, compressed) => chunk("iTXt", Buffer.concat([
  Buffer.from(`${k}\0`, "latin1"), Buffer.from([compressed ? 1 : 0, 0]), Buffer.from("\0\0", "latin1"),
  compressed ? zlib.deflateSync(Buffer.from(v, "utf8")) : Buffer.from(v, "utf8"),
]));

// A real 4x4 RGB image, so a decoder can open the result.
const IHDR = chunk("IHDR", Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0]));
const IDAT = chunk("IDAT", zlib.deflateSync(Buffer.concat(
  [0, 1, 2, 3].map((y) => Buffer.from([0, ...[0, 1, 2, 3].flatMap((x) => [x * 60, y * 60, 128])])),
)));
const IEND = chunk("IEND", Buffer.alloc(0));
// Text before IDAT and after it, both legal, both seen in the wild.
const png = (before, after = []) => Buffer.concat([SIG, IHDR, ...before, IDAT, ...after, IEND]);

// Every chunk, CRC verified, walking to IEND and nothing after it.
function walkPng(buf) {
  assert.ok(buf.subarray(0, 8).equals(SIG), "PNG signature");
  const out = [];
  let off = 8;
  for (;;) {
    assert.ok(off + 12 <= buf.length, `chunk header at ${off} in bounds`);
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    assert.equal(buf.readUInt32BE(off + 8 + len), crc32(buf.subarray(off + 4, off + 8 + len)), `CRC of ${type}`);
    out.push({ type, data, raw: buf.subarray(off, off + 12 + len) });
    off += 12 + len;
    if (type === "IEND") break;
  }
  assert.equal(off, buf.length, "nothing after IEND");
  return out;
}
const idatOf = (buf) => Buffer.concat(walkPng(buf).filter((c) => c.type === "IDAT").map((c) => c.raw));
const keywordsOf = (buf) => walkPng(buf).filter((c) => ["tEXt", "zTXt", "iTXt"].includes(c.type)).map((c) => c.data.toString("latin1").split("\0")[0]);

const PARAMS = "masterpiece, 1girl, solo, twintails, blue_hair, (smile:1.2), <lora:foo:0.8>\n" +
  "Negative prompt: bad hands, lowres\n" +
  "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1234, Size: 512x768, Model hash: abcdef1234";
const GRAPH = JSON.stringify({
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "masterpiece, 1girl, hoodie, backpack" } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "lowres" } },
});
const WORKFLOW = JSON.stringify({ last_node_id: 7, nodes: [{ id: 3, type: "KSampler", widgets_values: [1, "fixed", 20] }], links: [] });

test("PNG, A1111: parameters comes out verbatim; every other chunk stays byte for byte, CRCs valid", () => {
  const raw = png([tEXt("Software", "GIMP 2.10.36"), tEXt("parameters", PARAMS)]);
  const r = stripGeneration(raw, "image/png");
  dump("png-a1111", "png", raw, r.buffer);
  assert.equal(r.changed, true);
  assert.equal(r.confident, true, "a generator's own keyword is a confident signal");
  assert.deepEqual(r.removed, { "png:parameters": PARAMS });
  const chunks = walkPng(r.buffer);
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "tEXt", "IDAT", "IEND"]);
  assert.equal(chunks[1].data.toString("latin1"), "Software\0GIMP 2.10.36");
  assert.ok(idatOf(r.buffer).equals(idatOf(raw)), "IDAT identical");
  assert.equal(r.buffer.length, raw.length - tEXt("parameters", PARAMS).length);
  assert.deepEqual(extractCreatorTags(r.buffer, "image/png").tags, [], "no prompt left to read");
});

test("PNG, ComfyUI: prompt and workflow come out, tEXt / zTXt / iTXt alike; an unrelated chunk survives", () => {
  for (const [label, make] of [["tEXt", tEXt], ["zTXt", zTXt], ["iTXt", (k, v) => iTXt(k, v, false)], ["iTXt-z", (k, v) => iTXt(k, v, true)]]) {
    const raw = png([make("prompt", GRAPH)], [make("workflow", WORKFLOW), tEXt("Author", "someone")]);
    const r = stripGeneration(raw, "image/png");
    dump(`png-comfy-${label}`, "png", raw, r.buffer);
    assert.deepEqual(r.removed, { "png:prompt": GRAPH, "png:workflow": WORKFLOW }, label);
    const chunks = walkPng(r.buffer);
    assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "IDAT", "tEXt", "IEND"], label);
    assert.equal(chunks[2].data.toString("latin1"), "Author\0someone", label);
    assert.ok(idatOf(r.buffer).equals(idatOf(raw)), `${label}: IDAT identical`);
  }
});

test("PNG, NovelAI: Comment, Description, Source and Generation time out; Title and Software stay", () => {
  const comment = JSON.stringify({ prompt: "1girl, solo, smile", steps: 28, sampler: "k_euler_ancestral", uc: "lowres", seed: 42 });
  const raw = png([
    tEXt("Title", "AI generated image"),
    tEXt("Description", "1girl, solo, smile"),
    tEXt("Software", "NovelAI"),
    tEXt("Source", "Stable Diffusion XL C1E1DE52"),
    tEXt("Generation time", "3.21"),
    tEXt("Comment", comment),
    tEXt("Copyright", "mine"),
  ]);
  const r = stripGeneration(raw, "image/png");
  dump("png-novelai", "png", raw, r.buffer);
  assert.deepEqual(r.removed, {
    "png:Description": "1girl, solo, smile",
    "png:Source": "Stable Diffusion XL C1E1DE52",
    "png:Generation time": "3.21",
    "png:Comment": comment,
  });
  assert.deepEqual(keywordsOf(r.buffer), ["Title", "Software", "Copyright"]);
});

// ONE TEST PER GENERATOR KEYWORD, from a list written out here rather than
// read from the module: deleting a keyword from the module must turn its own
// test red, and a value with no markers means the keyword alone is what
// decides. (The list and the module's set are also held equal below, so a
// keyword added to one and not the other is caught too.)
const GENERATOR_KEYWORDS = [
  "parameters", "postprocessing", "extras", "prompt", "workflow",
  "invokeai_metadata", "invokeai_graph", "invokeai_workflow", "sd-metadata", "Dream", "fooocus_scheme",
  "parameters-json", "smproj",
  "negative_prompt", "use_stable_diffusion_model", "use_vae_model", "use_text_encoder_model",
  "use_lora_model", "lora_alpha", "use_hypernetwork_model", "hypernetwork_strength",
  "use_embedding_models", "use_embeddings_model", "use_controlnet_model", "control_filter_to_apply",
  "control_alpha", "use_face_correction", "use_upscale", "upscale_amount", "latent_upscaler_steps",
  "num_inference_steps", "guidance_scale", "distilled_guidance_scale", "prompt_strength",
  "sampler_name", "scheduler_name", "clip_skip",
];
const PLAIN_VALUE = "\"a cat in space\" -s 50 -S 3357757885 -W 512 -H 512";
for (const keyword of GENERATOR_KEYWORDS) {
  test(`PNG generator keyword "${keyword}": goes on its name alone, whatever it holds`, () => {
    assert.equal(hasGenerationMarkers(PLAIN_VALUE), false, "precondition: the value itself says nothing");
    const raw = png([tEXt("Software", "x"), tEXt(keyword, PLAIN_VALUE)]);
    const r = stripGeneration(raw, "image/png");
    assert.deepEqual(r.removed, { [`png:${keyword}`]: PLAIN_VALUE });
    assert.deepEqual(keywordsOf(r.buffer), ["Software"]);
    assert.equal(r.confident, true);
  });
}
test("the generator keyword list here and the module's are the same list", () => {
  assert.deepEqual([...PNG_GENERATOR_KEYS].sort(), [...GENERATOR_KEYWORDS].sort());
});

test("PNG, Easy Diffusion: one chunk per setting, every one of them out -- seed, width and height too, in an ED file only", () => {
  const settings = [
    ["prompt", "a cat, sitting on a chair"], ["negative_prompt", "lowres, bad anatomy"], ["seed", "3141592653"],
    ["use_stable_diffusion_model", "secretmodel_v3"], ["sampler_name", "euler_a"], ["num_inference_steps", "30"],
    ["guidance_scale", "7.5"], ["use_lora_model", "secretlora"], ["clip_skip", "2"], ["use_vae_model", "vae-ft-mse"],
    ["width", "512"], ["height", "768"], ["tiling", "None"],
  ];
  const raw = png([tEXt("Software", "GIMP"), ...settings.map(([k, v]) => tEXt(k, v))]);
  const r = stripGeneration(raw, "image/png");
  dump("png-easydiffusion", "png", raw, r.buffer);
  assert.deepEqual(r.removed, Object.fromEntries(settings.map(([k, v]) => [`png:${k}`, v])));
  assert.deepEqual(keywordsOf(r.buffer), ["Software"]);

  // Outside an Easy Diffusion file, "seed", "width" and "height" are just words.
  const plain = png([tEXt("width", "512"), tEXt("seed", "42"), tEXt("height", "768")]);
  assert.equal(stripGeneration(plain, "image/png").changed, false);
});

test("PNG, A1111's extras tab: postprocessing and extras come out beside parameters", () => {
  const post = "Postprocess upscale by: 2, Postprocess upscaler: R-ESRGAN 4x+";
  const raw = png([tEXt("parameters", PARAMS), tEXt("postprocessing", post), tEXt("extras", "Postprocess upscaler: 4x-UltraSharp")]);
  const r = stripGeneration(raw, "image/png");
  assert.deepEqual(Object.keys(r.removed).sort(), ["png:extras", "png:parameters", "png:postprocessing"]);
  assert.deepEqual(keywordsOf(r.buffer), []);
});

test("PNG: bytes after IEND are copied as they came -- not ours to judge, and not ours to lose", () => {
  const tail = Buffer.from("PK\u0003\u0004 appended archive", "latin1");
  const body = png([tEXt("parameters", PARAMS)]);
  const r = stripGeneration(Buffer.concat([body, tail]), "image/png");
  assert.ok(r.buffer.subarray(r.buffer.length - tail.length).equals(tail));
  walkPng(r.buffer.subarray(0, r.buffer.length - tail.length));
});

test("PNG: an ordinary Comment and Description are not generation data and are left alone", () => {
  const raw = png([tEXt("Comment", "Created with GIMP"), tEXt("Description", "My cat on the sofa")]);
  const r = stripGeneration(raw, "image/png");
  assert.equal(r.changed, false);
  assert.equal(r.buffer, raw, "the very buffer passed in");
  assert.deepEqual(r.removed, {});
});

test("PNG, not NovelAI: a Description or Comment that reads as a prompt goes on the prompt SHAPE, no markers needed", () => {
  // Pins the shape rule for the shared keywords: judged only by the strong
  // markers, both of these would be served.
  for (const [keyword, text] of [["Description", "1girl, solo, smile, long hair"], ["Comment", "scenery, mountain, lake, sunset"]]) {
    assert.equal(hasGenerationMarkers(text), false, "precondition");
    const r = stripGeneration(png([tEXt(keyword, text)]), "image/png");
    assert.deepEqual(r.removed, { [`png:${keyword}`]: text }, keyword);
    assert.deepEqual(keywordsOf(r.buffer), [], keyword);
  }
});

test("PNG: a generator's chunk that will not decode still goes, and its bytes are kept for the record", () => {
  const broken = chunk("zTXt", Buffer.concat([Buffer.from("parameters\0", "latin1"), Buffer.from([0]), Buffer.from("not deflate at all")]));
  const raw = png([broken]);
  const r = stripGeneration(raw, "image/png");
  assert.match(r.removed["png:parameters"], /^\[undecodable zTXt chunk, base64\] /);
  assert.deepEqual(walkPng(r.buffer).map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
});

test("PNG: a compressed text chunk nobody can open is refused -- it cannot be read, so it cannot be cleared", () => {
  const broken = chunk("zTXt", Buffer.concat([Buffer.from("Notes\0", "latin1"), Buffer.from([0]), Buffer.from("not deflate at all")]));
  assert.throws(() => stripGeneration(png([broken]), "image/png"), /will not decompress.*NOT posted/);
});

// A mixed XMP packet: a generator's prompt beside provenance nobody may take
// -- the creator, the copyright, the tool, the IPTC digital source type.
const XMP_MIXED = "<?xpacket begin=\"\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\">" +
  "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">" +
  "<rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\"" +
  " xmlns:Iptc4xmpExt=\"http://iptc.org/std/Iptc4xmpExt/2008-02-29/\" xmlns:ai=\"http://example.invalid/ai/\"" +
  " xmp:CreatorTool=\"Midjourney\" ai:settings=\"{&quot;prompt&quot;: &quot;1girl&quot;, &quot;steps&quot;: 20}\"" +
  " Iptc4xmpExt:DigitalSourceType=\"http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia\">" +
  "<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">a cat in space --ar 16:9 --v 6 Job ID: 0b9f3c2e-1234-4d5e-9f00-aabbccddeeff</rdf:li></rdf:Alt></dc:description>" +
  "<dc:rights><rdf:Alt><rdf:li xml:lang=\"x-default\">Copyright 2026 Jane Doe</rdf:li></rdf:Alt></dc:rights>" +
  "<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>" +
  "</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>";
const MIXED_DESCRIPTION = "<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">a cat in space --ar 16:9 --v 6 Job ID: 0b9f3c2e-1234-4d5e-9f00-aabbccddeeff</rdf:li></rdf:Alt></dc:description>";
const MIXED_SETTINGS = "ai:settings=\"{&quot;prompt&quot;: &quot;1girl&quot;, &quot;steps&quot;: 20}\"";

// The packet after the strip: same length, the two generation properties
// gone, every other property where it was.
function assertMixedPacket(packet, label) {
  assert.equal(packet.length, Buffer.byteLength(XMP_MIXED), `${label}: same length -- blanked, not cut`);
  const s = packet.toString("utf8");
  for (const kept of ["Copyright 2026 Jane Doe", "<rdf:li>Jane Doe</rdf:li>", "xmp:CreatorTool=\"Midjourney\"", "trainedAlgorithmicMedia", "<?xpacket end=\"w\"?>"]) {
    assert.ok(s.includes(kept), `${label}: kept ${kept}`);
  }
  for (const gone of ["Job ID", "a cat in space", "ai:settings", "&quot;prompt&quot;"]) assert.ok(!s.includes(gone), `${label}: removed ${gone}`);
}

test("PNG: an XMP iTXt keeps every property but the generation ones, compressed or not", () => {
  for (const compressed of [false, true]) {
    const raw = png([iTXt("XML:com.adobe.xmp", XMP_MIXED, compressed)]);
    const r = stripGeneration(raw, "image/png");
    dump(`png-xmp-mixed-${compressed ? "z" : "plain"}`, "png", raw, r.buffer);
    assert.deepEqual(Object.keys(r.removed), ["png:XML:com.adobe.xmp"]);
    assert.ok(r.removed["png:XML:com.adobe.xmp"].includes(MIXED_DESCRIPTION));
    assert.ok(r.removed["png:XML:com.adobe.xmp"].includes(MIXED_SETTINGS));
    const itxt = walkPng(r.buffer).find((c) => c.type === "iTXt").data;
    const at = "XML:com.adobe.xmp".length + 1 + 2 + 2; // keyword \0, flag, method, empty language \0, empty translation \0
    const packet = compressed ? zlib.inflateSync(itxt.subarray(at)) : itxt.subarray(at);
    assertMixedPacket(packet, compressed ? "compressed" : "plain");
  }
  const plain = "<x:xmpmeta><rdf:RDF><rdf:Description xmp:CreatorTool=\"Photoshop\"/></rdf:RDF></x:xmpmeta>";
  assert.equal(stripGeneration(png([iTXt("XML:com.adobe.xmp", plain, false)]), "image/png").changed, false);
});

// --- EXIF, and EXIF inside a PNG -------------------------------------------------

// A TIFF structure: IFD0 entries, an ExifIFD, an optional IFD1, values after.
// Entries are { tag, type, raw } -- raw is the value's bytes.
function tiff({ ifd0 = [], exif = [], ifd1 = [], order = "MM" }) {
  const be = order === "MM";
  const w16 = (b, v, o) => (be ? b.writeUInt16BE(v, o) : b.writeUInt16LE(v, o));
  const w32 = (b, v, o) => (be ? b.writeUInt32BE(v, o) : b.writeUInt32LE(v, o));
  const size = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 };
  const i0 = [...ifd0, ...(exif.length ? [{ tag: 0x8769, type: 4, pointer: true }] : [])].sort((a, b) => a.tag - b.tag);
  const ifd0Off = 8;
  const exifOff = ifd0Off + 2 + 12 * i0.length + 4;
  const ifd1Off = exifOff + (exif.length ? 2 + 12 * exif.length + 4 : 0);
  let dataOff = ifd1Off + (ifd1.length ? 2 + 12 * ifd1.length + 4 : 0);
  const data = [];
  const encode = (entries, next) => {
    const b = Buffer.alloc(2 + 12 * entries.length + 4);
    w16(b, entries.length, 0);
    entries.forEach((e, i) => {
      const at = 2 + i * 12;
      w16(b, e.tag, at); w16(b, e.type, at + 2);
      if (e.pointer) { w32(b, 1, at + 4); w32(b, exifOff, at + 8); return; }
      w32(b, e.raw.length / size[e.type], at + 4);
      if (e.raw.length <= 4) { e.raw.copy(b, at + 8); return; }
      w32(b, dataOff, at + 8);
      const padded = e.raw.length % 2 ? Buffer.concat([e.raw, Buffer.alloc(1)]) : e.raw;
      data.push(padded);
      dataOff += padded.length;
    });
    w32(b, next, 2 + 12 * entries.length);
    return b;
  };
  const head = Buffer.alloc(8); head.write(order, 0, "latin1"); w16(head, 42, 2); w32(head, ifd0Off, 4);
  const a = encode(i0, ifd1.length ? ifd1Off : 0);
  const b = exif.length ? encode(exif, 0) : Buffer.alloc(0);
  const c = ifd1.length ? encode(ifd1, 0) : Buffer.alloc(0);
  return Buffer.concat([head, a, b, c, ...data]);
}
const short = (v, order = "MM") => { const b = Buffer.alloc(2); if (order === "MM") b.writeUInt16BE(v); else b.writeUInt16LE(v); return b; };
const asciiValue = (s) => Buffer.from(`${s}\0`, "utf8");
const userCommentAscii = (s) => Buffer.concat([Buffer.from("ASCII\0\0\0", "latin1"), Buffer.from(s, "utf8")]);
const userCommentUnicodeBE = (s) => { const b = Buffer.from(s, "utf16le"); b.swap16(); return Buffer.concat([Buffer.from("UNICODE\0", "latin1"), b]); };
const xpValue = (s) => Buffer.from(`${s}\0`, "utf16le");

// One IFD0 tag's SHORT value (Orientation lives there).
function ifd0Short(t, wanted) {
  const be = t.toString("latin1", 0, 2) === "MM";
  const u16 = (o) => (be ? t.readUInt16BE(o) : t.readUInt16LE(o));
  const u32 = (o) => (be ? t.readUInt32BE(o) : t.readUInt32LE(o));
  const off = u32(4);
  for (let k = 0; k < u16(off); k++) {
    const e = off + 2 + k * 12;
    if (u16(e) === wanted) return u16(e + 8);
  }
  return undefined;
}

const A1111_TIFF = () => tiff({ ifd0: [{ tag: 0x0112, type: 3, raw: short(6) }], exif: [{ tag: 0x9286, type: 7, raw: userCommentAscii(PARAMS) }] });

test("PNG eXIf (what libvips, ImageMagick 7 and Pillow write): the UserComment is blanked in place, Orientation kept, CRC fresh", () => {
  for (const [label, data] of [["bare TIFF", A1111_TIFF()], ["Exif-prefixed", Buffer.concat([Buffer.from("Exif\0\0", "latin1"), A1111_TIFF()])]]) {
    const raw = png([chunk("eXIf", data)]);
    const r = stripGeneration(raw, "image/png");
    dump(`png-exif-${label.replace(/ /g, "-")}`, "png", raw, r.buffer);
    assert.deepEqual(r.removed, { "exif:UserComment": PARAMS }, label);
    assert.equal(r.buffer.length, raw.length, `${label}: same length`);
    const exif = walkPng(r.buffer).find((c) => c.type === "eXIf").data;
    const t = exif.subarray(label === "bare TIFF" ? 0 : 6);
    assert.equal(ifd0Short(t, 0x0112), 6, `${label}: Orientation still 6`);
    assert.equal(exif.indexOf("Negative prompt"), -1, `${label}: the prompt is gone`);
  }
});

// ImageMagick's and exiv2's hex-in-a-text-chunk profile.
function rawProfile(name, data) {
  const lines = data.toString("hex").match(/.{1,72}/g).join("\n");
  return `\n${name}\n${String(data.length).padStart(8)}\n${lines}\n`;
}
function profileBytes(textChunkData) {
  const z = textChunkData.indexOf(0);
  const text = zlib.inflateSync(textChunkData.subarray(z + 2)).toString("latin1");
  const [, , , ...hex] = text.split("\n");
  return Buffer.from(hex.join("").replace(/\s/g, ""), "hex");
}

test("PNG \"Raw profile type exif\" (a GIMP / exiv2 export of an A1111 JPEG): decoded, blanked, re-encoded in the same shape", () => {
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), A1111_TIFF()]);
  const raw = png([zTXt("Raw profile type exif", rawProfile("exif", exif))]);
  assert.equal(hasGenerationMarkers(rawProfile("exif", exif)), false, "precondition: as hex, the prompt shows no marker");
  const r = stripGeneration(raw, "image/png");
  dump("png-rawprofile-exif", "png", raw, r.buffer);
  assert.deepEqual(r.removed, { "exif:UserComment": PARAMS });
  const out = profileBytes(walkPng(r.buffer).find((c) => c.type === "zTXt").data);
  assert.equal(out.length, exif.length, "the profile is the same length");
  assert.equal(ifd0Short(out.subarray(6), 0x0112), 6, "Orientation still 6");
  assert.equal(out.indexOf("Negative prompt"), -1);
});

test("PNG \"Raw profile type xmp\": property by property, the rest of the packet kept", () => {
  const raw = png([zTXt("Raw profile type xmp", rawProfile("xmp", Buffer.from(XMP_MIXED, "utf8")))]);
  const r = stripGeneration(raw, "image/png");
  assert.deepEqual(Object.keys(r.removed), ["png:Raw profile type xmp"]);
  assertMixedPacket(profileBytes(walkPng(r.buffer).find((c) => c.type === "zTXt").data), "raw profile xmp");
});

test("PNG: ImageMagick's exif:* text mirrors are judged as the EXIF field they mirror, UTF-16 dots and all", () => {
  // What `convert a1111.jpg out.png` writes beside the eXIf chunk for a
  // UNICODE UserComment: the raw bytes, each unprintable one as '.'.
  const dotted = "UNICODE." + [...PARAMS.replace(/\n/g, " ")].map((c) => `.${c}`).join("");
  assert.equal(hasGenerationMarkers(dotted), false, "precondition: dotted, the markers do not read");
  assert.equal(demirror(dotted), PARAMS.replace(/\n/g, " "));
  const raw = png([tEXt("exif:UserComment", dotted), tEXt("exif:ImageDescription", "ASCII...1girl, solo, smile"), tEXt("exif:Make", "Canon"), tEXt("date:create", "2026-09-29T00:00:00+00:00")]);
  const r = stripGeneration(raw, "image/png");
  assert.deepEqual(Object.keys(r.removed).sort(), ["png:exif:ImageDescription", "png:exif:UserComment"]);
  assert.equal(r.removed["png:exif:UserComment"], PARAMS.replace(/\n/g, " "), "recorded as the text it was");
  assert.deepEqual(keywordsOf(r.buffer), ["exif:Make", "date:create"]);
});

test("the post-condition: generation text the strip missed but prompt-tags can read refuses, with the reason", () => {
  // A truncated upload: the last chunk is a parameters tEXt whose CRC never
  // arrived. The stripper will not walk a chunk it cannot see whole; prompt-
  // tags reads it anyway -- and so, in the file, would anyone else. A bare
  // prompt, so no marker is there to catch it: prompt-tags' own reading does.
  const bare = "1girl, hoodie, backpack";
  const whole = Buffer.concat([SIG, IHDR, IDAT, tEXt("parameters", bare)]);
  const truncated = whole.subarray(0, whole.length - 4);
  assert.equal(embeddedChunks(truncated, "image/png").parameters, bare, "precondition: prompt-tags reads it");
  assert.throws(() => stripGeneration(truncated, "image/png"),
    (err) => /survived the strip/.test(err.message) && /PNG chunk "parameters"/.test(err.message) && /Fix:/.test(err.message));
});

// --- JPEG ---------------------------------------------------------------------

// An 8x8 baseline JPEG from PIL, no metadata but its JFIF APP0.
const BASE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCDT9C6fJRRRXPVxNTm3LwGLq+xWp//2Q==",
  "base64",
);
const AFTER_APP0 = 20; // SOI (2) + APP0 (2 + 16)

function segment(marker, payload) {
  const h = Buffer.alloc(4);
  h[0] = 0xff; h[1] = marker; h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}
const app1Exif = (t) => segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]));
const app1Xmp = (xml) => segment(0xe1, Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(xml, "utf8")]));
function app1XmpExt(xml, { offset = 0, full } = {}) {
  const data = Buffer.from(xml, "utf8");
  const head = Buffer.alloc(40, 0x41); // GUID
  head.writeUInt32BE(full === undefined ? data.length : full, 32);
  head.writeUInt32BE(offset, 36);
  return segment(0xe1, Buffer.concat([Buffer.from("http://ns.adobe.com/xmp/extension/\0", "latin1"), head, data]));
}
const com = (text) => segment(0xfe, Buffer.from(text, "utf8"));
const jpeg = (segs) => Buffer.concat([BASE_JPEG.subarray(0, AFTER_APP0), ...segs, BASE_JPEG.subarray(AFTER_APP0)]);

// The marker chain to SOS, every length in bounds, and the scan exactly the base's.
function walkJpeg(buf) {
  assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8);
  const segs = [];
  let i = 2;
  for (;;) {
    assert.equal(buf[i], 0xff, `marker at ${i}`);
    const marker = buf[i + 1];
    if (marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    assert.ok(len >= 2 && i + 2 + len <= buf.length, `segment ${marker.toString(16)} in bounds`);
    segs.push({ marker, payload: buf.subarray(i + 4, i + 2 + len) });
    i += 2 + len;
  }
  const scan = BASE_JPEG.subarray(BASE_JPEG.indexOf(Buffer.from([0xff, 0xda])));
  assert.ok(buf.subarray(i).equals(scan), "scan and EOI identical to the base image");
  return segs;
}
const xmpOf = (segs) => segs.find((s) => s.marker === 0xe1 && s.payload.toString("latin1", 0, 28) === "http://ns.adobe.com/xap/1.0/").payload.subarray(29);

const XMP_GEN = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description xmp:CreatorTool="Draw Things"><exif:UserComment>{&quot;c&quot;: &quot;1girl, solo&quot;, &quot;uc&quot;: &quot;lowres&quot;, &quot;sampler&quot;: &quot;DPM++ 2M Karras&quot;}</exif:UserComment></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
const XMP_GEN_PROP = "<exif:UserComment>{&quot;c&quot;: &quot;1girl, solo&quot;, &quot;uc&quot;: &quot;lowres&quot;, &quot;sampler&quot;: &quot;DPM++ 2M Karras&quot;}</exif:UserComment>";
const XMP_PLAIN = "<?xpacket begin=\"\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF><rdf:Description xmp:CreatorTool=\"Adobe Photoshop\"/></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>";
const COM_GEN = "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 99";
// Not XML at all, with markers: the packet cannot be taken apart, so it goes whole.
const XMP_UNPARSEABLE = "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1 -- not an XMP packet";

test("JPEG: UserComment blanked in place, Orientation still 6, the XMP prompt property emptied, COM with markers removed", () => {
  const t = tiff({
    ifd0: [{ tag: 0x0112, type: 3, raw: short(6) }, { tag: 0x010e, type: 2, raw: asciiValue("OLYMPUS DIGITAL CAMERA") }],
    exif: [{ tag: 0x9286, type: 7, raw: userCommentAscii(PARAMS) }],
  });
  const raw = jpeg([app1Exif(t), app1Xmp(XMP_GEN), com(COM_GEN), com("Created with GIMP")]);
  const r = stripGeneration(raw, "image/jpeg");
  dump("jpeg-a1111", "jpg", raw, r.buffer);
  assert.equal(r.changed, true);
  assert.deepEqual(r.removed, { "exif:UserComment": PARAMS, xmp: XMP_GEN_PROP, "jpeg:COM": COM_GEN });

  const segs = walkJpeg(r.buffer);
  const exif = segs.find((s) => s.marker === 0xe1 && s.payload.subarray(0, 6).toString("latin1") === "Exif\0\0");
  assert.ok(exif, "the EXIF APP1 is still there");
  assert.equal(exif.payload.length, t.length + 6, "same length: nothing inside it moved");
  assert.equal(ifd0Short(exif.payload.subarray(6), 0x0112), 6, "Orientation still 6");
  const xmp = xmpOf(segs).toString("utf8");
  assert.equal(xmp.length, XMP_GEN.length, "the XMP packet is still there, the same length");
  assert.ok(xmp.includes("xmp:CreatorTool=\"Draw Things\""), "its other property survives");
  assert.ok(!xmp.includes("uc&quot;"), "the prompt property does not");
  assert.deepEqual(segs.filter((s) => s.marker === 0xfe).map((s) => s.payload.toString("utf8")), ["Created with GIMP"]);
  const seen = embeddedChunks(r.buffer, "image/jpeg");
  assert.deepEqual(seen, { parameters: "OLYMPUS DIGITAL CAMERA" }, "the camera's description stays; the prompt does not");
  assert.equal(r.buffer.length, raw.length - com(COM_GEN).length);
});

test("JPEG: a mixed XMP packet loses only its generation properties -- copyright, creator, tool and source type stay", () => {
  const raw = jpeg([app1Xmp(XMP_MIXED)]);
  const r = stripGeneration(raw, "image/jpeg");
  dump("jpeg-xmp-mixed", "jpg", raw, r.buffer);
  assert.equal(r.buffer.length, raw.length);
  assertMixedPacket(xmpOf(walkJpeg(r.buffer)), "jpeg");
  assert.deepEqual(r.removed, { xmp: `${MIXED_SETTINGS}\n${MIXED_DESCRIPTION}` });
});

test("JPEG: a UNICODE UserComment in a little-endian TIFF, an XPComment and a prompt in ImageDescription", () => {
  const t = tiff({
    order: "II",
    ifd0: [
      { tag: 0x0112, type: 3, raw: short(6, "II") },
      { tag: 0x010e, type: 2, raw: asciiValue("landscape, scenery, no_humans, sky, cloud") },
      { tag: 0x9c9c, type: 1, raw: xpValue(COM_GEN) },
    ],
    exif: [{ tag: 0x9286, type: 7, raw: userCommentUnicodeBE(PARAMS) }],
  });
  const raw = jpeg([app1Exif(t)]);
  const r = stripGeneration(raw, "image/jpeg");
  dump("jpeg-unicode-le", "jpg", raw, r.buffer);
  assert.deepEqual(r.removed, {
    "exif:ImageDescription": "landscape, scenery, no_humans, sky, cloud",
    "exif:XPComment": COM_GEN,
    "exif:UserComment": PARAMS,
  });
  assert.equal(r.buffer.length, raw.length, "in place: not one byte added or removed");
  const exif = walkJpeg(r.buffer).find((s) => s.marker === 0xe1);
  assert.equal(ifd0Short(exif.payload.subarray(6), 0x0112), 6);
  assert.deepEqual(embeddedChunks(r.buffer, "image/jpeg"), {});
});

test("JPEG EXIF: DocumentName holding a graph is blanked, and so is a field in IFD1 -- a Canon Make is not", () => {
  const t = tiff({
    ifd0: [{ tag: 0x010d, type: 2, raw: asciiValue(`prompt:${GRAPH}`) }, { tag: 0x010f, type: 2, raw: asciiValue("Canon") }, { tag: 0x0112, type: 3, raw: short(6) }],
    ifd1: [{ tag: 0x010e, type: 2, raw: asciiValue(COM_GEN) }],
  });
  const r = stripGeneration(jpeg([app1Exif(t)]), "image/jpeg");
  assert.deepEqual(r.removed, { "exif:DocumentName": `prompt:${GRAPH}`, "exif:ImageDescription": COM_GEN });
  const payload = walkJpeg(r.buffer).find((s) => s.marker === 0xe1).payload;
  assert.ok(payload.includes("Canon"));
  assert.equal(ifd0Short(payload.subarray(6), 0x0112), 6);
});

test("JPEG: a caption that merely LOOKS like a prompt is stripped and kept privately, but is not a confident signal", () => {
  const t = tiff({ ifd0: [{ tag: 0x010e, type: 2, raw: asciiValue("Paris, France, summer, 2019") }] });
  const r = stripGeneration(jpeg([app1Exif(t)]), "image/jpeg");
  assert.deepEqual(r.removed, { "exif:ImageDescription": "Paris, France, summer, 2019" });
  assert.equal(r.confident, false, "a comma list alone never labels a photo ai-generated");
  const strong = stripGeneration(jpeg([app1Exif(A1111_TIFF())]), "image/jpeg");
  assert.equal(strong.confident, true);
});

test("JPEG: an extension carrying a generation property goes WHOLE, and the main packet's pointer to it is emptied", () => {
  const main = "<?xpacket begin=\"\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF><rdf:Description xmp:CreatorTool=\"ComfyUI\" xmpNote:HasExtendedXMP=\"41414141414141414141414141414141\"/></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>";
  const ext = `<x:xmpmeta><rdf:RDF><rdf:Description><sd:workflow>${WORKFLOW.replace(/"/g, "&quot;")}</sd:workflow></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const half = Math.floor(ext.length / 2);
  const raw = jpeg([app1Xmp(main), app1XmpExt(ext.slice(half), { offset: half, full: ext.length }), app1XmpExt(ext.slice(0, half), { offset: 0, full: ext.length })]);
  const r = stripGeneration(raw, "image/jpeg");
  const segs = walkJpeg(r.buffer);
  assert.equal(segs.filter((s) => s.marker === 0xe1).length, 1, "both extension segments are gone");
  assert.equal(r.removed.xmp, ext, "reassembled in offset order, not segment order");
  const kept = xmpOf(segs).toString("utf8");
  assert.ok(kept.includes("xmp:CreatorTool=\"ComfyUI\""));
  assert.ok(!kept.includes("HasExtendedXMP"), "no pointer to an extension that is not there");

  // An extension with nothing generative in it stays exactly as it was.
  const plainExt = "<x:xmpmeta><rdf:RDF><rdf:Description><photoshop:History>resized</photoshop:History></rdf:Description></rdf:RDF></x:xmpmeta>";
  const r2 = stripGeneration(jpeg([app1Xmp(main), app1XmpExt(plainExt)]), "image/jpeg");
  assert.equal(r2.changed, false);
});

test("JPEG, multi-picture: nothing is cut after an MPF header -- a property is blanked in place, a packet that must go is neutralised", () => {
  const mpf = segment(0xe2, Buffer.concat([Buffer.from("MPF\0", "latin1"), Buffer.alloc(16)]));
  const raw = jpeg([mpf, app1Xmp(XMP_GEN)]);
  const r = stripGeneration(raw, "image/jpeg");
  assert.equal(r.buffer.length, raw.length, "not one byte moved: MPF offsets still point where they did");
  assert.ok(xmpOf(walkJpeg(r.buffer)).toString("utf8").includes("CreatorTool"));
  assert.equal(r.removed.xmp, XMP_GEN_PROP);

  const raw2 = jpeg([mpf, app1Xmp(XMP_UNPARSEABLE)]);
  const r2 = stripGeneration(raw2, "image/jpeg");
  assert.equal(r2.buffer.length, raw2.length);
  const neutral = walkJpeg(r2.buffer)[2]; // APP0, the MPF APP2, then what was the XMP packet
  assert.equal(neutral.marker, 0xfe, "relabelled as a comment");
  assert.ok(neutral.payload.every((b) => b === 0), "and zeroed");
  assert.equal(r2.removed.xmp, XMP_UNPARSEABLE);
});

test("JPEG: a camera's EXIF, a plain XMP and a plain COM are all left exactly as they were", () => {
  const t = tiff({
    ifd0: [{ tag: 0x010f, type: 2, raw: asciiValue("Canon") }, { tag: 0x0110, type: 2, raw: asciiValue("Canon EOS R5") }, { tag: 0x0112, type: 3, raw: short(6) }],
    exif: [{ tag: 0x9286, type: 7, raw: userCommentAscii("        ") }],
  });
  const raw = jpeg([app1Exif(t), app1Xmp(XMP_PLAIN), com("Created with GIMP")]);
  const r = stripGeneration(raw, "image/jpeg");
  assert.equal(r.changed, false);
  assert.equal(r.buffer, raw);
});

test("the NUL a field carries never reaches the record: Postgres refuses it in jsonb", () => {
  const t = tiff({ exif: [{ tag: 0x9286, type: 7, raw: userCommentAscii("1girl, solo\0\0, smile\nSteps: 20, Sampler: Euler a") }] });
  const r = stripGeneration(jpeg([app1Exif(t), com(`${COM_GEN}\0`)]), "image/jpeg");
  assert.deepEqual(Object.keys(r.removed).sort(), ["exif:UserComment", "jpeg:COM"]);
  for (const [k, v] of Object.entries(r.removed)) assert.ok(!v.includes("\0"), `${k} carries no NUL`);
  assert.equal(r.removed["jpeg:COM"], COM_GEN);
  assert.equal(r.removed["exif:UserComment"], "1girl, solo, smile\nSteps: 20, Sampler: Euler a");
});

// --- WebP ---------------------------------------------------------------------

// An 8x8 lossless WebP from PIL; its VP8L chunk is reused inside an extended file.
const BASE_WEBP = Buffer.from("UklGRi4AAABXRUJQVlA4TCIAAAAvB8ABALkyRPQ/dhHR/wBhtlFRzp9zryMYkAGMCaB6oP8A", "base64");
const VP8L = BASE_WEBP.subarray(12);
function riffChunk(fourcc, data) {
  const h = Buffer.alloc(8); h.write(fourcc, 0, "latin1"); h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function webp({ exif, xmp, appended, filler = 0 }) {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = (exif ? 0x08 : 0) | (xmp || appended ? 0x04 : 0);
  vp8x.writeUIntLE(7, 4, 3); vp8x.writeUIntLE(7, 7, 3); // canvas 8x8, stored minus one
  const body = Buffer.concat([
    Buffer.from("WEBP", "latin1"), riffChunk("VP8X", vp8x), VP8L,
    // An unknown chunk a decoder skips, to give the file a real bitstream's bulk.
    ...(filler ? [riffChunk("JUNK", Buffer.alloc(filler, 0x55))] : []),
    ...(exif ? [riffChunk("EXIF", exif)] : []),
    ...(xmp ? [riffChunk("XMP ", Buffer.from(xmp, "utf8"))] : []),
  ]);
  const h = Buffer.alloc(8); h.write("RIFF", 0, "latin1"); h.writeUInt32LE(body.length, 4);
  // A writer that appended a chunk and never updated the RIFF size.
  return Buffer.concat([h, body, ...(appended ? [riffChunk("XMP ", Buffer.from(appended, "utf8"))] : [])]);
}
// Every chunk, walked to the exact end of the file the RIFF size declares.
function walkWebp(buf) {
  assert.equal(buf.toString("latin1", 0, 4), "RIFF");
  assert.equal(buf.readUInt32LE(4), buf.length - 8, "RIFF size is the file's");
  const out = [];
  let i = 12;
  while (i < buf.length) {
    const size = buf.readUInt32LE(i + 4);
    out.push({ fourcc: buf.toString("latin1", i, i + 4), data: buf.subarray(i + 8, i + 8 + size) });
    i += 8 + size + (size & 1);
  }
  assert.equal(i, buf.length, "chunks end exactly at the end");
  return out;
}

test("WebP: EXIF blanked in place, the XMP's prompt property emptied in place, everything else where it was", () => {
  const t = A1111_TIFF();
  // An ODD-length EXIF chunk, so the XMP after it is only found by honouring
  // RIFF's pad byte.
  let exifData = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]);
  if (exifData.length % 2 === 0) exifData = Buffer.concat([exifData, Buffer.from([0])]);
  const raw = webp({ exif: exifData, xmp: XMP_GEN });
  const r = stripGeneration(raw, "image/webp");
  dump("webp-a1111", "webp", raw, r.buffer);
  assert.deepEqual(r.removed, { "exif:UserComment": PARAMS, "webp:xmp": XMP_GEN_PROP });
  assert.equal(r.buffer.length, raw.length);
  const chunks = walkWebp(r.buffer);
  assert.deepEqual(chunks.map((c) => c.fourcc), ["VP8X", "VP8L", "EXIF", "XMP "]);
  assert.equal(chunks[0].data[0], 0x0c, "both flags still true: both chunks are still there");
  assert.ok(chunks[1].data.equals(VP8L.subarray(8, 8 + VP8L.readUInt32LE(4))), "image data identical");
  assert.equal(ifd0Short(chunks[2].data.subarray(6), 0x0112), 6, "Orientation still 6");
  assert.ok(chunks[3].data.toString("utf8").includes("CreatorTool=\"Draw Things\""));
  assert.deepEqual(embeddedChunks(r.buffer, "image/webp"), {});
});

test("WebP: an XMP chunk that must go whole is cut, and the RIFF size and the VP8X flag are corrected", () => {
  const raw = webp({ exif: A1111_TIFF(), xmp: XMP_UNPARSEABLE });
  const r = stripGeneration(raw, "image/webp");
  assert.deepEqual(Object.keys(r.removed).sort(), ["exif:UserComment", "webp:xmp"]);
  const chunks = walkWebp(r.buffer);
  assert.deepEqual(chunks.map((c) => c.fourcc), ["VP8X", "VP8L", "EXIF"]);
  assert.equal(chunks[0].data[0], 0x08, "EXIF flag kept, XMP flag cleared");
});

test("WebP: a chunk appended past the declared RIFF size is cut WITHOUT shrinking the RIFF size into the bitstream", () => {
  // 4000 bytes inside the RIFF, as in the reported case: large enough that a
  // RIFF size shrunk by the cut chunk stays positive and lands in the data,
  // rather than tripping the fallback that happens to be right.
  const raw = webp({ appended: XMP_UNPARSEABLE, filler: 4000 });
  const declared = raw.readUInt32LE(4);
  assert.ok(8 + declared < raw.length, "precondition: the XMP chunk lies past the RIFF's end");
  assert.ok(declared > raw.length - 8 - declared, "precondition: the RIFF is bigger than what lies past it");
  const r = stripGeneration(raw, "image/webp");
  assert.deepEqual(Object.keys(r.removed), ["webp:xmp"]);
  assert.equal(r.buffer.readUInt32LE(4), declared, "the RIFF size is what it was -- the cut chunk was never in it");
  assert.equal(r.buffer.length, 8 + declared);
  assert.ok(walkWebp(r.buffer).find((c) => c.fourcc === "VP8L"), "the bitstream is whole");
});

test("WebP, ComfyUI's saver: the graphs in EXIF Model and Make are blanked; a plain XMP stays", () => {
  const prompt = `prompt:${GRAPH}`, workflow = `workflow:${WORKFLOW}`;
  const t = tiff({ ifd0: [{ tag: 0x010f, type: 2, raw: asciiValue(workflow) }, { tag: 0x0110, type: 2, raw: asciiValue(prompt) }] });
  const raw = webp({ exif: t, xmp: XMP_PLAIN });
  const r = stripGeneration(raw, "image/webp");
  dump("webp-comfy", "webp", raw, r.buffer);
  assert.deepEqual(r.removed, { "exif:Make": workflow, "exif:Model": prompt });
  assert.equal(r.buffer.length, raw.length);
  const chunks = walkWebp(r.buffer);
  assert.deepEqual(chunks.map((c) => c.fourcc), ["VP8X", "VP8L", "EXIF", "XMP "]);
  assert.equal(chunks[0].data[0], 0x0c, "both flags still true");
  assert.equal(chunks[3].data.toString("utf8"), XMP_PLAIN);
});

// --- GIF ------------------------------------------------------------------------

// A 1x1 GIF89a: header + screen descriptor (13), a 2-colour table (6), then a
// graphic control extension, the image, the trailer.
const BASE_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const GIF_HEAD = 19;
const subBlocked = (data) => {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) { const c = data.subarray(i, i + 255); parts.push(Buffer.from([c.length]), c); }
  return Buffer.concat([...parts, Buffer.from([0])]);
};
const gifComment = (text) => Buffer.concat([Buffer.from([0x21, 0xfe]), subBlocked(Buffer.from(text, "utf8"))]);
const MAGIC_TRAILER = Buffer.concat([Buffer.from([1]), Buffer.from(Array.from({ length: 256 }, (_, k) => 0xff - k)), Buffer.from([0])]);
const gifXmpRaw = (xml) => Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from("XMP DataXMP", "latin1"), Buffer.from(xml, "utf8"), MAGIC_TRAILER]);
const gifXmpBlocked = (xml) => Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from("XMP DataXMP", "latin1"), subBlocked(Buffer.from(xml, "utf8"))]);
const gif = (exts, tail = Buffer.alloc(0)) => Buffer.concat([BASE_GIF.subarray(0, GIF_HEAD), ...exts, BASE_GIF.subarray(GIF_HEAD), tail]);

// Walked the way a decoder walks it: every block, sub-block by sub-block, to
// the trailer. The image block must come through byte for byte.
function walkGif(buf) {
  assert.equal(buf.toString("latin1", 0, 6), "GIF89a");
  let i = GIF_HEAD;
  const blocks = [];
  const skip = (p) => { while (buf[p] !== 0) { assert.ok(p < buf.length, "sub-blocks in bounds"); p += 1 + buf[p]; } return p + 1; };
  for (;;) {
    assert.ok(i < buf.length, "a trailer before the end");
    const b = buf[i];
    if (b === 0x3b) return { blocks, end: i + 1 };
    if (b === 0x2c) { const end = skip(i + 11); blocks.push({ kind: "image", bytes: buf.subarray(i, end) }); i = end; continue; }
    assert.equal(b, 0x21, `extension introducer at ${i}`);
    const end = skip(i + 2);
    blocks.push({ kind: buf[i + 1], bytes: buf.subarray(i, end) });
    i = end;
  }
}
const baseImage = walkGif(BASE_GIF).blocks.find((b) => b.kind === "image").bytes;
// The XMP packet inside a GIF application extension, either way it is stored.
function gifXmpText(app, label) {
  if (label === "raw") return app.subarray(14, app.length - 258);
  const out = [];
  let p = 14;
  while (app[p] !== 0) { out.push(app.subarray(p + 1, p + 1 + app[p])); p += 1 + app[p]; }
  return Buffer.concat(out);
}

test("GIF: an A1111 comment is cut, GIMP's is kept, and the image comes through byte for byte", () => {
  const raw = gif([gifComment("Created with GIMP"), gifComment(PARAMS)]);
  const r = stripGeneration(raw, "image/gif");
  dump("gif-a1111", "gif", raw, r.buffer);
  assert.deepEqual(r.removed, { "gif:Comment": PARAMS });
  assert.equal(r.confident, true);
  const { blocks, end } = walkGif(r.buffer);
  assert.equal(end, r.buffer.length);
  assert.deepEqual(blocks.map((b) => b.kind), [0xfe, 0xf9, "image"]);
  assert.ok(blocks[0].bytes.includes("Created with GIMP"));
  assert.ok(blocks[2].bytes.equals(baseImage), "image data identical");
  assert.equal(r.buffer.length, raw.length - gifComment(PARAMS).length);
});

test("GIF: a comment longer than one sub-block is read whole", () => {
  const long = `${"masterpiece, ".repeat(30)}1girl\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a`;
  const r = stripGeneration(gif([gifComment(long)]), "image/gif");
  assert.deepEqual(r.removed, { "gif:Comment": long });
});

test("GIF XMP, raw with the magic trailer (as the spec writes it) and in sub-blocks: blanked in place, the rest kept, still walks", () => {
  for (const [label, make] of [["raw", gifXmpRaw], ["sub-blocked", gifXmpBlocked]]) {
    const raw = gif([make(XMP_MIXED)]);
    const r = stripGeneration(raw, "image/gif");
    dump(`gif-xmp-${label}`, "gif", raw, r.buffer);
    assert.equal(r.buffer.length, raw.length, `${label}: same length`);
    const { blocks, end } = walkGif(r.buffer);
    assert.equal(end, r.buffer.length, `${label}: walks to its trailer`);
    assertMixedPacket(gifXmpText(blocks.find((b) => b.kind === 0xff).bytes, label), label);
    assert.deepEqual(Object.keys(r.removed), ["xmp"], label);
  }
});

test("GIF: bytes after the trailer are copied as they came", () => {
  const tail = Buffer.from("trailing junk", "latin1");
  const r = stripGeneration(gif([gifComment(PARAMS)], tail), "image/gif");
  assert.ok(r.buffer.subarray(r.buffer.length - tail.length).equals(tail));
});

// --- formats that cannot be verified ------------------------------------------------

function box(type, ...payload) {
  const body = Buffer.concat(payload);
  const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, "latin1");
  return Buffer.concat([h, body]);
}
const fullBox = (type, version, ...payload) => box(type, Buffer.from([version, 0, 0, 0]), ...payload);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const infe = (id, type, extra = "") => fullBox("infe", 2, u16(id), u16(0), Buffer.from(type, "latin1"), Buffer.from(`\0${extra}`, "latin1"));
// An AVIF's box structure: the item list is what says whether it carries metadata.
const avif = (items, mdat) => Buffer.concat([
  box("ftyp", Buffer.from("avif\0\0\0\0avifmif1miaf", "latin1")),
  fullBox("meta", 0, fullBox("hdlr", 0, Buffer.alloc(4), Buffer.from("pict"), Buffer.alloc(12), Buffer.from([0])), fullBox("iinf", 0, u16(items.length), ...items)),
  box("mdat", mdat),
]);

test("AVIF with an Exif item (A1111 / Forge save AVIF that way) is REFUSED, whatever the Exif says", () => {
  const raw = avif([infe(1, "av01"), infe(2, "Exif")], Buffer.concat([Buffer.alloc(64, 7), Buffer.from([0, 0, 0, 0]), A1111_TIFF()]));
  assert.throws(() => stripGeneration(raw, "image/avif"), (err) => /cannot be checked/.test(err.message) && /an Exif item/.test(err.message) && /NOT posted/.test(err.message) && /Fix:/.test(err.message));
  const xmp = avif([infe(1, "av01"), infe(2, "mime", "application/rdf+xml\0")], Buffer.alloc(64, 7));
  assert.throws(() => stripGeneration(xmp, "image/avif"), /an item of type "application\/rdf\+xml"/);
});

test("AVIF with no metadata carrier goes through untouched; a TIFF, and any blob carrying an XMP packet, do not", () => {
  const clean = avif([infe(1, "av01")], Buffer.alloc(256, 9));
  const r = stripGeneration(clean, "image/avif");
  assert.equal(r.buffer, clean);
  assert.equal(r.changed, false);
  assert.deepEqual(carriersIn(clean), []);
  assert.throws(() => stripGeneration(A1111_TIFF(), "image/tiff"), /a TIFF cannot be checked/);
  const blob = Buffer.concat([Buffer.from("BM"), Buffer.alloc(40), Buffer.from("<x:xmpmeta>hello</x:xmpmeta>")]);
  assert.throws(() => stripGeneration(blob, "image/bmp"), /an XMP packet/);
  const bmp = Buffer.concat([Buffer.from("BM"), Buffer.alloc(80, 3)]);
  assert.equal(stripGeneration(bmp, "image/bmp").buffer, bmp);
});

// --- everything else -------------------------------------------------------------

test("no generation data: identical bytes, the same buffer, changed=false, for every format", () => {
  const video = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42", "latin1"), Buffer.alloc(16)]);
  for (const [label, buf, type] of [
    ["png", png([]), "image/png"], ["jpeg", BASE_JPEG, "image/jpeg"], ["webp", BASE_WEBP, "image/webp"],
    ["webp-vp8x", webp({ exif: tiff({ ifd0: [{ tag: 0x0112, type: 3, raw: short(6) }] }) }), "image/webp"],
    ["gif", BASE_GIF, "image/gif"], ["gif-gimp", gif([gifComment("Created with GIMP")]), "image/gif"],
    ["video", video, "video/mp4"], ["tiny", Buffer.from([1, 2, 3]), "image/png"],
  ]) {
    const r = stripGeneration(buf, type);
    assert.equal(r.changed, false, label);
    assert.equal(r.buffer, buf, label);
    assert.deepEqual(r.removed, {}, label);
  }
});

test("idempotent: stripping a stripped file changes nothing", () => {
  const t = A1111_TIFF();
  for (const [label, raw, type] of [
    ["png", png([tEXt("parameters", PARAMS), chunk("eXIf", t), iTXt("XML:com.adobe.xmp", XMP_MIXED, true)], [zTXt("workflow", WORKFLOW)]), "image/png"],
    ["jpeg", jpeg([app1Exif(t), app1Xmp(XMP_GEN), com(COM_GEN)]), "image/jpeg"],
    ["webp", webp({ exif: t, xmp: XMP_GEN }), "image/webp"],
    ["gif", gif([gifComment(PARAMS), gifXmpRaw(XMP_MIXED)]), "image/gif"],
  ]) {
    const once = stripGeneration(raw, type);
    assert.equal(once.changed, true, label);
    const twice = stripGeneration(once.buffer, type);
    assert.equal(twice.changed, false, label);
    assert.ok(twice.buffer.equals(once.buffer), label);
    assert.equal(stripOnce(once.buffer).changed, false, label);
  }
});

test("the bytes decide the format, not the declared type", () => {
  const r = stripGeneration(png([tEXt("parameters", PARAMS)]), "image/jpeg");
  assert.deepEqual(Object.keys(r.removed), ["png:parameters"]);
});

test("hostile input: an out-of-range XML character reference is not a crash, and a bogus EXIF type is still blanked", () => {
  const xmp = `${XMP_GEN}<x:bad>&#x110000; &#99999999999;</x:bad>`;
  const r = stripGeneration(jpeg([app1Xmp(xmp)]), "image/jpeg");
  assert.equal(r.removed.xmp, XMP_GEN_PROP);
  const t = A1111_TIFF();
  const typeAt = t.indexOf(Buffer.from([0x92, 0x86])) + 2;
  t.writeUInt16BE(0, typeAt); // type 0 does not exist; prompt-tags reads the value as bytes anyway
  const r2 = stripGeneration(jpeg([app1Exif(t)]), "image/jpeg");
  assert.equal(r2.removed["exif:UserComment"], PARAMS);
});

test("stripGeneration refuses anything that is not a Buffer", () => {
  assert.throws(() => stripGeneration("not bytes", "image/png"), TypeError);
});

test("the markers and the prompt shape: generator text matches, a camera's and a person's does not", () => {
  assert.ok(hasGenerationMarkers(PARAMS));
  assert.ok(hasGenerationMarkers(GRAPH));
  assert.ok(hasGenerationMarkers(WORKFLOW));
  assert.ok(hasGenerationMarkers("a cat in space --ar 16:9 --v 6 Job ID: 0b9f3c2e-1234-4d5e-9f00-aabbccddeeff"));
  assert.ok(hasGenerationMarkers("a knight <lora:armor_v2:0.7>"), "a LoRA token alone is a generator's syntax");
  for (const plain of ["OLYMPUS DIGITAL CAMERA", "Created with GIMP", "Canon EOS R5", "My cat on the sofa", "Steps: take the stairs", "a <b>bold</b> caption"]) {
    assert.equal(hasGenerationMarkers(plain), false, plain);
    assert.equal(looksLikePrompt(plain), false, plain);
  }
  assert.equal(promptStrength("1girl, solo"), STRONG);
  assert.equal(promptStrength("a castle (dramatic:1.3)"), STRONG);
  assert.equal(promptStrength("a castle (dramatic:2)"), LOOSE);
  assert.equal(promptStrength("scenery, mountain, lake, sunset"), LOOSE);
  assert.equal(promptStrength("Paris, France, summer, 2019"), LOOSE);
});

// --- the post-condition, apart from the stripper -----------------------------------
//
// Each part of it is shown catching generation data in a file the stripper
// never touched, so none of them is only as good as the stripper's classifier.

test("post-condition, markers anywhere: past IEND, past the JPEG EOI, inside compressed or hex text, in UTF-16", () => {
  const unicode = jpeg([app1Exif(tiff({ exif: [{ tag: 0x9286, type: 7, raw: userCommentUnicodeBE(PARAMS) }] }))]);
  const cases = [
    ["after IEND", Buffer.concat([png([]), Buffer.from(PARAMS)])],
    ["after EOI", Buffer.concat([BASE_JPEG, Buffer.from(`\n${COM_GEN}`)])],
    ["a zTXt under a keyword nobody knows", png([zTXt("Notes", "{\"class_type\": \"KSampler\"}")])],
    ["a raw profile's hex", png([zTXt("Raw profile type iptc", rawProfile("iptc", Buffer.from(PARAMS)))])],
    ["a UTF-16BE UserComment", unicode],
    ["a GIF comment", gif([gifComment(PARAMS)])],
    ["an escaped JSON key inside XMP", jpeg([app1Xmp("<x:a>{&quot;prompt&quot;: 1}</x:a>")])],
    ["an AVIF's Exif item", avif([infe(2, "Exif")], A1111_TIFF())],
  ];
  for (const [label, raw] of cases) assert.ok(markerResidue(raw), label);
  // What the strip leaves behind in the fixtures above is clean to it.
  for (const clean of [png([tEXt("Comment", "Created with GIMP")]), BASE_JPEG, BASE_GIF, jpeg([app1Xmp(XMP_PLAIN)])]) {
    assert.equal(markerResidue(clean), null);
  }
  // And a strip that leaves bytes it does not own -- past IEND -- is refused
  // on the scan alone.
  assert.throws(() => stripGeneration(Buffer.concat([png([]), Buffer.from(PARAMS)]), "image/png"), /Negative prompt:" line is still in the file's bytes/);
  assert.throws(() => stripGeneration(Buffer.concat([BASE_JPEG, Buffer.from(`\n${COM_GEN}`)]), "image/jpeg"), /A1111 settings line/);
});

test("post-condition, prompt-tags' own reading: a generator's chunk, a graph, a JSON prompt, A1111 delimiters -- not a camera's caption", () => {
  const exifWith = (text) => jpeg([app1Exif(tiff({ exif: [{ tag: 0x9286, type: 7, raw: userCommentAscii(text) }] }))]);
  assert.match(promptTagsResidue(png([tEXt("parameters", "1girl, smile")]), "image/png"), /PNG chunk "parameters"/);
  assert.match(promptTagsResidue(png([tEXt("workflow", "{}")]), "image/png"), /PNG chunk "workflow"/);
  assert.match(promptTagsResidue(png([tEXt("Comment", "{\"prompt\": \"a cat\"}")]), "image/png"), /JSON prompt/);
  assert.match(promptTagsResidue(exifWith(GRAPH), "image/jpeg"), /ComfyUI graph/);
  assert.match(promptTagsResidue(exifWith("{\"prompt\": \"a cat\"}"), "image/jpeg"), /JSON prompt/);
  assert.match(promptTagsResidue(exifWith("a cat\nSteps: 20"), "image/jpeg"), /A1111 parameters/);
  assert.equal(promptTagsResidue(jpeg([app1Exif(tiff({ ifd0: [{ tag: 0x010e, type: 2, raw: asciiValue("OLYMPUS DIGITAL CAMERA") }] }))]), "image/jpeg"), null);
  assert.equal(promptTagsResidue(png([tEXt("Description", "My cat on the sofa")]), "image/png"), null);
});

test("post-condition, second pass: what only the stripper's classifier knows is still caught on a file it did not clean", () => {
  const raw = png([tEXt("negative_prompt", "lowres, bad anatomy")]);
  assert.equal(markerResidue(raw), null, "no marker");
  assert.equal(promptTagsResidue(raw, "image/png"), null, "prompt-tags does not read it");
  assert.match(residue(raw, "image/png"), /a second pass still finds png:negative_prompt/);
});

test("the post-condition alone -- stripper or no stripper -- catches every generator's embedding that carries a marker or a generator's own chunk", () => {
  // Which part catches each, stated, so a gap is a visible line rather than an
  // assumption. The last group has no signal but its keyword or its shape, and
  // is caught by the stripper's classifier (and the second pass) only.
  const byMarkersOrPromptTags = [
    ["A1111 PNG", png([tEXt("parameters", PARAMS)]), "image/png"],
    ["ComfyUI PNG", png([zTXt("prompt", GRAPH), iTXt("workflow", WORKFLOW, true)]), "image/png"],
    ["NovelAI PNG", png([tEXt("Software", "NovelAI"), tEXt("Comment", JSON.stringify({ prompt: "1girl", uc: "lowres" }))]), "image/png"],
    ["InvokeAI PNG", png([tEXt("invokeai_metadata", JSON.stringify({ positive_prompt: "a cat", cfg_scale: 7 }))]), "image/png"],
    ["A1111 JPEG", jpeg([app1Exif(A1111_TIFF())]), "image/jpeg"],
    ["Draw Things XMP", jpeg([app1Xmp(XMP_GEN)]), "image/jpeg"],
    ["Midjourney XMP", jpeg([app1Xmp(XMP_MIXED)]), "image/jpeg"],
    ["A1111 WebP", webp({ exif: A1111_TIFF() }), "image/webp"],
    ["ComfyUI WebP", webp({ exif: tiff({ ifd0: [{ tag: 0x0110, type: 2, raw: asciiValue(`prompt:${GRAPH}`) }] }) }), "image/webp"],
    ["A1111 GIF", gif([gifComment(PARAMS)]), "image/gif"],
    ["PNG eXIf", png([chunk("eXIf", A1111_TIFF())]), "image/png"],
    ["PNG raw profile", png([zTXt("Raw profile type exif", rawProfile("exif", A1111_TIFF()))]), "image/png"],
  ];
  for (const [label, raw, type] of byMarkersOrPromptTags) {
    assert.ok(markerResidue(raw) || promptTagsResidue(raw, type), `${label}: caught without the stripper's classifier`);
  }
  const byClassifierOnly = [
    ["Easy Diffusion settings", png([tEXt("use_stable_diffusion_model", "secretmodel_v3"), tEXt("seed", "3141592653")])],
    ["InvokeAI 2 Dream", png([tEXt("Dream", PLAIN_VALUE)])],
    ["a bare prompt in a Description", png([tEXt("Description", "1girl, solo, smile, long hair")])],
  ];
  for (const [label, raw] of byClassifierOnly) {
    assert.equal(markerResidue(raw) || promptTagsResidue(raw, "image/png"), null, `${label}: no independent signal`);
    assert.ok(residue(raw, "image/png"), `${label}: the second pass still refuses it`);
  }
});

// --- Stability Matrix, and keywords that name generation content ---------------

// Stability Matrix Inference (PngDataHelper.AddMetadata) writes three chunks:
// the A1111 "parameters", then the same settings as PascalCase JSON, then the
// whole project with its prompt card.
const SM_JSON = JSON.stringify({ PositivePrompt: "1girl, lighthouse, SECRETPROMPTTOKEN", NegativePrompt: "lowres", CfgScale: 7, Seed: 42, ModelName: "ponyDiffusionV6XL.safetensors" });
const SM_PROJ = JSON.stringify({ Version: 2, ProjectType: "Inference", State: { Prompt: "1girl, lighthouse", NegativePrompt: "lowres" } });

test("PNG, Stability Matrix: parameters, parameters-json and smproj all come out, and the JSON is a marker of its own", () => {
  const raw = png([tEXt("parameters", PARAMS), tEXt("parameters-json", SM_JSON), tEXt("smproj", SM_PROJ), tEXt("Software", "StabilityMatrix")]);
  const r = stripGeneration(raw, "image/png");
  assert.deepEqual(Object.keys(r.removed).sort(), ["png:parameters", "png:parameters-json", "png:smproj"]);
  assert.deepEqual(keywordsOf(r.buffer), ["Software"]);
  assert.equal(r.buffer.indexOf("SECRETPROMPTTOKEN"), -1);
  assert.equal(r.confident, true);
  // The post-condition's own scan reads the PascalCase keys, stripper or not.
  assert.match(markerResidue(png([tEXt("anything", SM_JSON)])), /Stability Matrix JSON key/);
  assert.equal(hasGenerationMarkers(SM_PROJ), true, "a NegativePrompt key is a generator's");
});

test("PNG: a keyword that NAMES generation content goes on its name -- stripped, kept privately, labels nothing", () => {
  for (const keyword of ["sd_prompt", "Workflow", "parameters_v2"]) {
    const r = stripGeneration(png([tEXt(keyword, "a cat in a hat"), tEXt("Author", "someone")]), "image/png");
    assert.deepEqual(r.removed, { [`png:${keyword}`]: "a cat in a hat" }, keyword);
    assert.equal(r.confident, false, `${keyword}: a name alone is not a generator's signature`);
  }
  assert.equal(stripGeneration(png([tEXt("Author", "a prompt writer")]), "image/png").changed, false, "the VALUE naming it decides nothing");
});

// --- the quality words ------------------------------------------------------------

test("\"masterpiece\" and \"best quality\" are English: a camera's caption using them is kept private but NOT labelled", () => {
  const caption = "Water Lilies by Claude Monet, a masterpiece of impressionism at the Musee de l'Orangerie";
  const t = tiff({ ifd0: [{ tag: 0x010f, type: 2, raw: asciiValue("Canon") }, { tag: 0x0112, type: 3, raw: short(6) }, { tag: 0x010e, type: 2, raw: asciiValue(caption) }] });
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description><dc:description><rdf:Alt><rdf:li xml:lang="x-default">${caption.replace(/'/g, "&apos;")}</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const r = stripGeneration(jpeg([app1Exif(t), app1Xmp(xmp)]), "image/jpeg");
  assert.equal(r.confident, false, "no public ai-generated label on a photograph");
  assert.equal(r.removed["exif:ImageDescription"], caption);
  assert.equal(promptStrength("masterpiece, best quality"), LOOSE);
  assert.equal(promptStrength("best_quality, a castle"), LOOSE);
  assert.equal(promptStrength("1girl, solo"), STRONG, "booru-tag words are still a generator's");
  assert.equal(promptStrength("absurdres, a castle"), STRONG);
});

// --- EXIF UserComment with no charset header ---------------------------------------

test("a UserComment with NO charset header (Pillow, as Fooocus writes it) is recorded whole, and its creator tags are clean", () => {
  const record = JSON.stringify({ prompt: "a lighthouse on a cliff at dawn", negative_prompt: "", styles: ["fooocus_v2"], base_model: "juggernautxl_v9" });
  const t = tiff({ exif: [{ tag: 0x9286, type: 7, raw: Buffer.from(record, "utf8") }] });
  const r = stripGeneration(jpeg([app1Exif(t)]), "image/jpeg");
  assert.equal(r.removed["exif:UserComment"], record, "not one byte of it dropped as a 'header'");
  assert.deepEqual(extractCreatorTagsFromFields(r.removed).tags, ["a_lighthouse_on_a_cliff_at_dawn"]);
  const a1111 = "a lighthouse on a cliff, SECRET\nNegative prompt: x\nSteps: 20, Sampler: Euler a";
  const r2 = stripGeneration(webp({ exif: tiff({ exif: [{ tag: 0x9286, type: 7, raw: Buffer.from(a1111, "utf8") }] }) }), "image/webp");
  assert.equal(r2.removed["exif:UserComment"], a1111);
});

// --- GIF: an unfinished walk -------------------------------------------------------

test("GIF: a walk that cannot finish is REFUSED -- a stray byte, or image data cut short -- never posted as it came", () => {
  const comment = "masterpiece, best quality, 1girl, solo, long hair, SECRETPROMPTTOKEN";
  const good = gif([gifComment(comment)]);
  const stray = Buffer.concat([good.subarray(0, good.length - 1), Buffer.from([0x00, 0x3b])]);
  assert.throws(() => stripGeneration(stray, "image/gif"), (err) => /a GIF that does not walk cannot be checked/.test(err.message) && /NOT posted/.test(err.message) && /Fix:/.test(err.message));
  const truncated = good.subarray(0, good.length - 4);
  assert.throws(() => stripGeneration(truncated, "image/gif"), /a truncated GIF cannot be checked/);
  // A GIF that simply ends where its trailer should be walked to that point: fine.
  const noTrailer = stripGeneration(good.subarray(0, good.length - 1), "image/gif");
  assert.deepEqual(noTrailer.removed, { "gif:Comment": comment });
});

// --- IPTC ------------------------------------------------------------------------

// IIM datasets, Photoshop resource blocks and the APP13 that carries them.
function dataset(rec, num, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (v.length < 0x8000) return Buffer.concat([Buffer.from([0x1c, rec, num, v.length >> 8, v.length & 0xff]), v]);
  const len = Buffer.alloc(4); len.writeUInt32BE(v.length);
  return Buffer.concat([Buffer.from([0x1c, rec, num, 0x80, 0x04]), len, v]);
}
function irb(id, data) {
  const head = Buffer.from([0x38, 0x42, 0x49, 0x4d, id >> 8, id & 0xff, 0, 0, 0, 0, 0, 0]);
  head.writeUInt32BE(data.length, 8);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
const md5 = (b) => crypto.createHash("md5").update(b).digest();
const app13 = (...blocks) => segment(0xed, Buffer.concat([Buffer.from("Photoshop 3.0\0", "latin1"), ...blocks]));
// Mochi Diffusion's own record (SDImage.swift), in the caption it writes it to.
const MOCHI = "Metadata Version: 2\nInclude in Image: a lighthouse on a cliff at dawn, dramatic sky SECRETPROMPTTOKEN\n" +
  "Exclude from Image: blurry\nModel: stable-diffusion-2-1-base\nSize: 512 x 512\nScheduler: DPM-Solver++\nSeed: 1234\nSteps: 30\nGuidance Scale: 7.5\nGenerator: Mochi Diffusion 5.2";
const MOCHI_IIM = Buffer.concat([dataset(2, 0, Buffer.from([0, 4])), dataset(2, 65, "Mochi Diffusion"), dataset(2, 70, "5.2"), dataset(2, 120, MOCHI)]);

test("JPEG IPTC: Mochi Diffusion's Caption-Abstract is blanked in place -- the program name, the other resources and every length stay, and the digest follows", () => {
  const resolution = irb(0x03ed, Buffer.from([0, 72, 0, 0, 0, 1, 0, 1, 0, 72, 0, 0, 0, 1, 0, 1]));
  const raw = jpeg([app13(irb(0x0404, MOCHI_IIM), irb(0x0425, md5(MOCHI_IIM)), resolution)]);
  const r = stripGeneration(raw, "image/jpeg");
  dump("jpeg-iptc-mochi", "jpg", raw, r.buffer);
  assert.deepEqual(r.removed, { "iptc:Caption-Abstract": MOCHI });
  assert.equal(r.confident, true, "Mochi's labels are a generator's own");
  assert.equal(r.buffer.length, raw.length, "in place: not one byte added or removed");
  assert.equal(r.buffer.indexOf("SECRETPROMPTTOKEN"), -1);
  const seg = walkJpeg(r.buffer).find((s) => s.marker === 0xed).payload;
  assert.ok(seg.includes("Mochi Diffusion"), "OriginatingProgram names the tool and stays");
  assert.ok(seg.includes(resolution.subarray(12)), "the resolution resource is untouched");
  const iim = seg.subarray(14 + 12, 14 + 12 + MOCHI_IIM.length);
  assert.ok(iim.subarray(iim.length - MOCHI.length).every((b) => b === 0x20), "the caption's bytes are spaces");
  assert.ok(seg.includes(md5(iim)), "the IPTC digest is the digest of the IPTC now there");
  assert.equal(markerResidue(raw) !== null, true, "and the post-condition's scan knows Mochi's labels, stripper or not");
});

test("the MWG caption mirror: the same prompt in EXIF, XMP and IPTC comes out of all three", () => {
  const caption = "a lighthouse on a cliff, (dramatic:1.3), SECRETPROMPTTOKEN";
  const t = tiff({ ifd0: [{ tag: 0x010e, type: 2, raw: asciiValue(caption) }] });
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description><dc:description><rdf:Alt><rdf:li xml:lang="x-default">${caption}</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const r = stripGeneration(jpeg([app1Exif(t), app1Xmp(xmp), app13(irb(0x0404, dataset(2, 120, caption)))]), "image/jpeg");
  assert.deepEqual(Object.keys(r.removed).sort(), ["exif:ImageDescription", "iptc:Caption-Abstract", "xmp"]);
  assert.equal(r.buffer.indexOf("SECRETPROMPTTOKEN"), -1, "no copy left anywhere");
});

test("PNG \"Raw profile type iptc\" and \"8bim\" (ImageMagick's copies of a JPEG's IPTC): blanked in the hex, same shape", () => {
  const raw = png([zTXt("Raw profile type 8bim", rawProfile("8bim", irb(0x0404, MOCHI_IIM))), zTXt("Raw profile type iptc", rawProfile("iptc", MOCHI_IIM))]);
  const r = stripGeneration(raw, "image/png");
  dump("png-rawprofile-iptc", "png", raw, r.buffer);
  assert.deepEqual(r.removed, { "iptc:Caption-Abstract": MOCHI }, "one text, recorded once");
  const profiles = walkPng(r.buffer).filter((c) => c.type === "zTXt").map((c) => profileBytes(c.data));
  assert.equal(profiles.length, 2);
  for (const p of profiles) {
    assert.ok(p.includes("Mochi Diffusion"));
    assert.equal(p.indexOf("SECRETPROMPTTOKEN"), -1);
  }
  assert.equal(profiles[1].length, MOCHI_IIM.length, "the same length as it came");
});

test("IPTC: an extended-length dataset is walked; a TIFF's IPTC-NAA tag is blanked too", () => {
  const long = `${"1girl, ".repeat(5000)}SECRETPROMPTTOKEN`;
  const r = stripGeneration(jpeg([app13(irb(0x0404, Buffer.concat([dataset(2, 5, "title"), dataset(2, 120, long)])))]), "image/jpeg");
  assert.equal(r.removed["iptc:Caption-Abstract"], long);
  assert.equal(r.buffer.indexOf("SECRETPROMPTTOKEN"), -1);
  const t = tiff({ ifd0: [{ tag: 0x83bb, type: 7, raw: MOCHI_IIM }, { tag: 0x0112, type: 3, raw: short(6) }] });
  const r2 = stripGeneration(jpeg([app1Exif(t)]), "image/jpeg");
  assert.deepEqual(r2.removed, { "iptc:Caption-Abstract": MOCHI });
  assert.equal(ifd0Short(walkJpeg(r2.buffer).find((s) => s.marker === 0xe1).payload.subarray(6), 0x0112), 6);
});

test("IPTC: a photo's own caption and keywords stay exactly as they were", () => {
  const iim = Buffer.concat([dataset(2, 120, "Sunset over the harbour at Honfleur"), dataset(2, 25, "harbour"), dataset(2, 25, "sunset"), dataset(2, 116, "(c) someone")]);
  const raw = jpeg([app13(irb(0x0404, iim))]);
  const r = stripGeneration(raw, "image/jpeg");
  assert.equal(r.changed, false);
  assert.equal(r.buffer, raw);
});

test("IPTC that will not parse is REFUSED when it carries markers, and left alone when it does not", () => {
  const broken = (text) => segment(0xed, Buffer.concat([Buffer.from("Photoshop 3.0\0", "latin1"), Buffer.from("XXXX not a resource block ", "latin1"), Buffer.from(text, "utf8")]));
  assert.throws(() => stripGeneration(jpeg([broken(COM_GEN)]), "image/jpeg"),
    (err) => /APP13 segment carries generation text in an IPTC \/ Photoshop block that does not parse/.test(err.message) && /NOT posted/.test(err.message) && /Fix: re-save the image without its IPTC/.test(err.message));
  const plain = jpeg([broken("nothing to see")]);
  assert.equal(stripGeneration(plain, "image/jpeg").buffer, plain);
  const brokenProfile = png([zTXt("Raw profile type iptc", rawProfile("iptc", Buffer.from(`garbage ${COM_GEN}`)))]);
  assert.throws(() => stripGeneration(brokenProfile, "image/png"), /"Raw profile type iptc" chunk carries generation text/);
});

// --- stealth: generation data in the pixels ------------------------------------------

// An RGBA picture built here pixel by pixel and filtered row by row, each row
// under one of the five filter types, and read back by THIS file's decoder --
// not png-pixels, which the module uses -- so the check is not the module's
// reader agreeing with itself.
function filterRow(row, prev, ft, bpp) {
  const f = Buffer.alloc(row.length);
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    const pae = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    f[i] = (row[i] - [0, a, b, (a + b) >> 1, pae][ft]) & 0xff;
  }
  return f;
}
function rgbaPng(width, height, pixelAt, before = []) {
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.from(Array.from({ length: width }, (_, x) => pixelAt(x, y)).flat()));
  const data = Buffer.concat(rows.map((row, y) => Buffer.concat([Buffer.from([y % 5]), filterRow(row, y ? rows[y - 1] : null, y % 5, 4)])));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const z = zlib.deflateSync(data), half = Math.ceil(z.length / 2);
  return Buffer.concat([SIG, chunk("IHDR", ihdr), ...before, chunk("IDAT", z.subarray(0, half)), chunk("IDAT", z.subarray(half)), tEXt("Title", "after the data"), IEND]);
}
function readRgba(buf) {
  const cs = walkPng(buf);
  const ihdr = cs.find((c) => c.type === "IHDR").data;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4), stride = width * 4;
  const data = zlib.inflateSync(Buffer.concat(cs.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const rows = [];
  for (let y = 0; y < height; y++) {
    const ft = data[y * (stride + 1)], f = data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = Buffer.alloc(stride), prev = rows[y - 1];
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? row[i - 4] : 0, b = prev ? prev[i] : 0, c = prev && i >= 4 ? prev[i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      row[i] = (f[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][ft]) & 0xff;
    }
    rows.push(row);
  }
  return { width, height, at: (x, y) => [...rows[y].subarray(x * 4, x * 4 + 4)] };
}
// The bits NovelAI's and the extension's writers lay down: magic, 32-bit
// length in bits, payload, down each column and then the next.
function stealthBits(magic, payload) {
  const bytes = Buffer.concat([Buffer.from(magic, "latin1"), Buffer.alloc(4), payload]);
  bytes.writeUInt32BE(payload.length * 8, magic.length);
  return [...bytes].flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((k) => (b >> k) & 1));
}
function stealthPng(width, height, magic, payload, { stream = "alpha", alpha = () => 255, before = [] } = {}) {
  const bits = stealthBits(magic, payload);
  return rgbaPng(width, height, (x, y) => {
    const px = [(x * 37 + y * 11) & 0xff, (x * 5 + y * 71) & 0xff, (x * 19 + y * 3) & 0xff, alpha(x, y)];
    const k = x * height + y;
    if (stream === "alpha" && k < bits.length) px[3] = (px[3] & 0xfe) | bits[k];
    if (stream === "rgb") for (let c = 0; c < 3; c++) if (3 * k + c < bits.length) px[c] = (px[c] & 0xfe) | bits[3 * k + c];
    return px;
  }, before);
}
// NovelAI's reader (novelai-image-metadata nai_meta.py LSBExtractor): the
// alpha LSBs, down each column, as bytes.
function naiMagic(buf) {
  const img = readRgba(buf);
  let s = "";
  for (let n = 0; n < 15; n++) {
    let v = 0;
    for (let b = 0; b < 8; b++) { const k = n * 8 + b; v = (v << 1) | (img.at(Math.floor(k / img.height), k % img.height)[3] & 1); }
    s += String.fromCharCode(v);
  }
  return s;
}
const NAI_META = JSON.stringify({ Description: "1girl, silver hair, SECRETPROMPTTOKEN", Software: "NovelAI", Comment: JSON.stringify({ prompt: "1girl, silver hair, SECRETPROMPTTOKEN", uc: "lowres" }) });

test("stealth, NovelAI's alpha copy: recorded privately, every alpha LSB set, every colour and every other chunk as it came", () => {
  const raw = stealthPng(40, 64, "stealth_pngcomp", zlib.gzipSync(NAI_META), { before: [tEXt("Software", "NovelAI"), tEXt("Description", "1girl, silver hair, SECRETPROMPTTOKEN")] });
  assert.equal(naiMagic(raw), "stealth_pngcomp", "precondition: NovelAI's reader finds it");
  const r = stripGeneration(raw, "image/png");
  dump("png-stealth-novelai", "png", raw, r.buffer);
  assert.equal(r.removed["png:stealth"], NAI_META, "the payload, un-gzipped, is the private record");
  assert.equal(r.confident, true, "the magic is a generator's own");
  assert.notEqual(naiMagic(r.buffer), "stealth_pngcomp", "NovelAI's reader finds nothing now");
  const before = readRgba(raw), after = readRgba(r.buffer);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 40; x++) {
    const [r0, g0, b0] = before.at(x, y), [r1, g1, b1, a1] = after.at(x, y);
    assert.deepEqual([r1, g1, b1], [r0, g0, b0], `colour of ${x},${y}`);
    assert.equal(a1, 255, `alpha of ${x},${y}: an opaque picture is opaque again`);
  }
  const kept = walkPng(r.buffer), orig = walkPng(raw);
  assert.deepEqual(kept.map((c) => c.type), ["IHDR", "tEXt", "IDAT", "tEXt", "IEND"], "one IDAT where the first was");
  assert.ok(kept[0].raw.equals(orig[0].raw), "IHDR byte for byte");
  assert.ok(kept[3].raw.equals(orig[5].raw), "the chunk after the data byte for byte");
  assert.equal(stripOnce(r.buffer).changed, false, "a second pass finds nothing");
});

test("stealth: the extension's uncompressed alpha copy is recorded as its text, and makes the creator tags when it is all there is", () => {
  const params = "1girl, hoodie\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a";
  const r = stripGeneration(stealthPng(24, 50, "stealth_pnginfo", Buffer.from(params)), "image/png");
  assert.deepEqual(r.removed, { "png:stealth": params });
  assert.deepEqual(extractCreatorTagsFromFields(r.removed).tags, ["1girl", "hoodie"]);
  const nai = stripGeneration(stealthPng(40, 64, "stealth_pngcomp", zlib.gzipSync(NAI_META)), "image/png");
  assert.deepEqual(extractCreatorTagsFromFields(nai.removed).tags, ["1girl", "silver_hair", "secretprompttoken"], "NovelAI's JSON read through its Comment");
});

test("stealth: a translucent pixel moves by one level at most, an opaque one not at all", () => {
  const alpha = (x, y) => 100 + ((x * 7 + y * 13) % 156);
  const raw = stealthPng(20, 40, "stealth_pngcomp", zlib.gzipSync("x"), { alpha });
  const r = stripGeneration(raw, "image/png");
  const before = readRgba(raw), after = readRgba(r.buffer);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 20; x++) assert.equal(after.at(x, y)[3], before.at(x, y)[3] | 1);
});

test("stealth in the COLOUR bits is REFUSED -- clearing it would change the picture -- and says what to do", () => {
  for (const magic of ["stealth_rgbinfo", "stealth_rgbcomp"]) {
    assert.throws(() => stripGeneration(stealthPng(30, 30, magic, Buffer.from("1girl, SECRETPROMPTTOKEN"), { stream: "rgb" }), "image/png"),
      (err) => err.message.includes(`"${magic}"`) && /COLOUR values/.test(err.message) && /NOT posted/.test(err.message) && /Fix: re-save it without the stealth copy/.test(err.message));
  }
});

test("stealth in a palette's transparency cannot be cleared without changing the picture: REFUSED", () => {
  const bits = stealthBits("stealth_pngcomp", zlib.gzipSync("1girl"));
  const w = 20, h = 30;
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.from([0, ...Array.from({ length: w }, (_, x) => { const k = x * h + y; return k < bits.length ? bits[k] : 1; })]));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3;
  const raw = Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("PLTE", Buffer.from([10, 20, 30, 10, 20, 30])), chunk("tRNS", Buffer.from([254, 255])), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), IEND]);
  assert.throws(() => stripGeneration(raw, "image/png"), /transparency its palette or colour key gives its pixels.*NOT posted.*Fix: re-save it as an RGBA PNG/);
});

test("post-condition, the pixels: EVERY signature in EITHER stream is found, on files the stripper never cleaned", () => {
  for (const magic of ["stealth_pnginfo", "stealth_pngcomp", "stealth_rgbinfo", "stealth_rgbcomp"]) {
    for (const stream of ["alpha", "rgb"]) {
      const raw = stealthPng(30, 40, magic, Buffer.from("1girl"), { stream });
      assert.match(stealthResidue(raw) || "", new RegExp(`"${magic}" signature is still in the ${stream === "alpha" ? "alpha" : "colour"} values`), `${magic} in ${stream}`);
    }
  }
  // An alpha magic in the colours is somewhere the stripper does not look for
  // it; the post-condition refuses the file anyway.
  assert.throws(() => stripGeneration(stealthPng(30, 40, "stealth_pngcomp", Buffer.from("1girl"), { stream: "rgb" }), "image/png"),
    /survived the strip: a "stealth_pngcomp" signature is still in the colour values/);
  assert.equal(stealthResidue(stealthPng(30, 40, "not_a_signature", Buffer.from("1girl"))), null);
});

test("post-condition: a PNG whose pixels will not decode cannot be checked, and is refused; one too small to hold a signature passes", () => {
  const raw = stealthPng(30, 40, "stealth_pngcomp", Buffer.from("x"));
  const idat = walkPng(raw).find((c) => c.type === "IDAT");
  const at = raw.indexOf(idat.raw);
  const corrupt = Buffer.from(raw); corrupt.fill(0xff, at + 8, at + 8 + idat.data.length);
  assert.throws(() => stripGeneration(corrupt, "image/png"),
    (err) => /pixels cannot be read to check them/.test(err.message) && !/survived the strip/.test(err.message) && /Fix: re-save it as a PNG any decoder opens/.test(err.message));
  assert.equal(stripGeneration(png([]), "image/png").changed, false, "4 x 4: sixteen pixels hold no 120-bit signature");
});

// --- ComfyUI's extra entries -----------------------------------------------------

test("ComfyUI's savers write every extra_pnginfo entry too: in WebP EXIF as \"<key>:<json>\", in PNG as a JSON chunk -- both go", () => {
  const t = tiff({ ifd0: [
    { tag: 0x010d, type: 2, raw: asciiValue("custom_note:{\"text\": \"a red fox in snow SECRETPROMPTTOKEN\"}") },
    { tag: 0x010e, type: 2, raw: asciiValue("comfy_version:{\"v\": \"0.3.10\"}") },
    { tag: 0x010f, type: 2, raw: asciiValue(`workflow:${WORKFLOW}`) },
    { tag: 0x0110, type: 2, raw: asciiValue(`prompt:${GRAPH}`) },
  ] });
  const r = stripGeneration(webp({ exif: t }), "image/webp");
  assert.deepEqual(Object.keys(r.removed).sort(), ["exif:DocumentName", "exif:ImageDescription", "exif:Make", "exif:Model"]);
  assert.equal(r.buffer.indexOf("SECRETPROMPTTOKEN"), -1);
  assert.deepEqual(extractCreatorTagsFromFields(r.removed).tags, ["1girl", "hoodie", "backpack"], "the creator tags are the graph's prompt, not a note's label");
  // A caption or a camera written the way people write them is not that shape.
  for (const plain of ["Canon", "Note: {see the back}", "Trip: [Paris, 2019]"]) {
    const kept = stripGeneration(jpeg([app1Exif(tiff({ ifd0: [{ tag: 0x010e, type: 2, raw: asciiValue(plain) }] }))]), "image/jpeg");
    assert.equal(kept.changed, false, plain);
  }
  const comfy = png([tEXt("prompt", GRAPH), tEXt("workflow", WORKFLOW), tEXt("custom_note", "{\"text\": \"a red fox SECRETPROMPTTOKEN\"}"), tEXt("Author", "someone")]);
  const r2 = stripGeneration(comfy, "image/png");
  assert.deepEqual(keywordsOf(r2.buffer), ["Author"]);
  assert.ok(r2.removed["png:custom_note"]);
  const notComfy = png([tEXt("custom_note", "{\"text\": \"my own json\"}")]);
  assert.equal(stripGeneration(notComfy, "image/png").changed, false, "outside a ComfyUI file, a JSON chunk is somebody else's business");
});

// --- every key the tunnel can send ---------------------------------------------------
//
// THE SAME LIST is in chanbooru's
// test/functional/fourier_generation_metadata_controller_test.rb
// (TUNNEL_FIELD_KEYS), kept equal by hand. This side goes red when the
// stripper emits a key the list does not name, or stops emitting one it does;
// that side goes red when the booru's FIELD_KEY refuses a key the list names.
// So a drift is a red test on whichever side changes first, and a key added
// on one side is added to BOTH files in the same change. Round two let the
// tunnel send gif:Comment while the booru refused it, each side green against
// its own stand-in.
const TUNNEL_FIELD_KEYS = [
  // PNG text chunks, png:<keyword>: generators' own keywords
  "png:parameters", "png:postprocessing", "png:extras", "png:prompt", "png:workflow",
  "png:invokeai_metadata", "png:invokeai_graph", "png:invokeai_workflow", "png:sd-metadata", "png:Dream",
  "png:fooocus_scheme", "png:parameters-json", "png:smproj",
  // Easy Diffusion, one chunk per setting
  "png:negative_prompt", "png:use_stable_diffusion_model", "png:use_vae_model", "png:use_text_encoder_model",
  "png:use_lora_model", "png:lora_alpha", "png:use_hypernetwork_model", "png:hypernetwork_strength",
  "png:use_embedding_models", "png:use_embeddings_model", "png:use_controlnet_model", "png:control_filter_to_apply",
  "png:control_alpha", "png:use_face_correction", "png:use_upscale", "png:upscale_amount", "png:latent_upscaler_steps",
  "png:num_inference_steps", "png:guidance_scale", "png:distilled_guidance_scale", "png:prompt_strength",
  "png:sampler_name", "png:scheduler_name", "png:clip_skip", "png:seed", "png:width", "png:height", "png:tiling",
  // shared keywords, and NovelAI's
  "png:Comment", "png:Description", "png:Source", "png:Generation time",
  // XMP and raw profiles carried in PNG text chunks
  "png:XML:com.adobe.xmp", "png:Raw profile type exif", "png:Raw profile type APP1", "png:Raw profile type xmp",
  "png:Raw profile type iptc",
  // ImageMagick's EXIF mirrors, and the alpha-channel stealth payload
  "png:exif:UserComment", "png:exif:ImageDescription", "png:stealth",
  // EXIF (JPEG APP1, WebP EXIF, PNG eXIf)
  "exif:UserComment", "exif:ImageDescription", "exif:XPComment", "exif:Make", "exif:Model", "exif:DocumentName",
  // IPTC (JPEG APP13, PNG raw profile), by ExifTool's dataset name
  "iptc:Caption-Abstract", "iptc:ObjectName", "iptc:Keywords", "iptc:SpecialInstructions", "iptc:Writer-Editor",
  "iptc:Headline",
  // whole packets and comments
  "xmp", "webp:xmp", "jpeg:COM", "gif:Comment",
];

test("the key list: the stripper, run over one file per carrier, emits EXACTLY the keys both repos pin", () => {
  const generatorPng = png([
    ...GENERATOR_KEYWORDS.map((k) => tEXt(k, PLAIN_VALUE)),
    ...["seed", "width", "height", "tiling"].map((k) => tEXt(k, "1")),
    iTXt("XML:com.adobe.xmp", XMP_GEN, false),
    tEXt("Raw profile type exif", COM_GEN), tEXt("Raw profile type APP1", COM_GEN), tEXt("Raw profile type iptc", COM_GEN),
    zTXt("Raw profile type xmp", rawProfile("xmp", Buffer.from(XMP_GEN, "utf8"))),
    tEXt("exif:UserComment", "1girl, solo, smile"), tEXt("exif:ImageDescription", "1girl, solo, smile"),
  ]);
  const novelai = png([tEXt("Software", "NovelAI"), tEXt("Comment", "{}"), tEXt("Description", "1girl"), tEXt("Source", "NAI"), tEXt("Generation time", "3")]);
  const stealth = stealthPng(30, 40, "stealth_pnginfo", Buffer.from("1girl"));
  const exif = tiff({
    ifd0: [
      { tag: 0x010d, type: 2, raw: asciiValue(COM_GEN) }, { tag: 0x010e, type: 2, raw: asciiValue("1girl, solo") },
      { tag: 0x010f, type: 2, raw: asciiValue(`workflow:${WORKFLOW}`) }, { tag: 0x0110, type: 2, raw: asciiValue(`prompt:${GRAPH}`) },
      { tag: 0x9c9c, type: 1, raw: xpValue(COM_GEN) },
    ],
    exif: [{ tag: 0x9286, type: 7, raw: userCommentAscii(PARAMS) }],
  });
  const iim = Buffer.concat([[5, "ObjectName"], [25, "Keywords"], [40, "SpecialInstructions"], [105, "Headline"], [120, "Caption-Abstract"], [122, "Writer-Editor"]]
    .map(([n, name]) => dataset(2, n, `${name}: ${COM_GEN}`)));
  const jpegAll = jpeg([app1Exif(exif), app1Xmp(XMP_GEN), app13(irb(0x0404, iim)), com(COM_GEN)]);
  const emitted = new Set();
  for (const [raw, type] of [[generatorPng, "image/png"], [novelai, "image/png"], [stealth, "image/png"], [jpegAll, "image/jpeg"],
    [webp({ xmp: XMP_GEN }), "image/webp"], [gif([gifComment(PARAMS)]), "image/gif"]]) {
    for (const k of Object.keys(stripGeneration(raw, type).removed)) emitted.add(k);
  }
  assert.deepEqual([...emitted].sort(), [...TUNNEL_FIELD_KEYS].sort());
  assert.equal(new Set(TUNNEL_FIELD_KEYS).size, TUNNEL_FIELD_KEYS.length, "no key listed twice");
});

test("the key list: a keyword nobody listed still makes a key the booru's png: grammar takes -- 1 to 79 characters, no control character", () => {
  // The booru's png: branch of FIELD_KEY, as that repo writes it.
  const PNG_KEY = /^png:[^\x00-\x1f\x7f]{1,79}$/;
  const odd = [`bad\u0001keyword`, "k".repeat(120), "sd_prompt", "Notes"];
  const r = stripGeneration(png(odd.map((k) => tEXt(k, COM_GEN))), "image/png");
  const keys = Object.keys(r.removed);
  assert.equal(keys.length, odd.length);
  for (const k of keys) assert.match(k, PNG_KEY, JSON.stringify(k));
  assert.ok(keys.includes("png:bad?keyword"), "a control character becomes ?");
  assert.ok(keys.includes(`png:${"k".repeat(79)}`), "a keyword past the PNG limit is cut to it");
});
