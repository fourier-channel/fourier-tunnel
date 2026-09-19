"use strict";

// Creator-tag extraction: AI-generated images embed their generation prompt in
// the file's metadata. Parse it out and normalise it into Danbooru-style tags --
// the CREATOR-submitted provenance source (green in the UI). Best-effort and
// dependency-free; returns [] for anything it can't read.
//
// Supported embeddings, PNG:
//   - AUTOMATIC1111 / SD-webui : tEXt "parameters"  ("<prompt>\nNegative prompt:...\nSteps:...")
//   - ComfyUI                  : tEXt "prompt"       (JSON graph; CLIPTextEncode.text)
//   - NovelAI                  : tEXt/iTXt "Comment" (JSON with .prompt) or "Description"
//
// JPEG and WebP carry THE SAME TEXT in EXIF, because they have no text chunk
// to put it in (operator, 2026-09-19: "it's only working on pngs. We need to
// be able to extract this same information from .jpg as well"):
//   - A1111 and its forks       : EXIF UserComment (0x9286) = the "parameters" string,
//                                 charset-prefixed (ASCII or UNICODE/UTF-16)
//   - ComfyUI save nodes        : UserComment or ImageDescription (0x010e) holding
//                                 the prompt graph JSON, or an A1111-style string
//   - fourier-sampling          : writes UserComment (ASCII, TIFF type 7) when it
//                                 converts a 4chan PNG to JPEG, so the prompt
//                                 survives the conversion -- and this is where it
//                                 is read back
// WebP is a RIFF container whose "EXIF" chunk holds the same TIFF structure.
// The EXIF text is then routed through the same rawPrompt() as a PNG's chunks:
// a JSON graph is treated as "prompt", JSON with .prompt as "Comment", and
// anything else as "parameters".

const zlib = require("zlib");

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Read tEXt / zTXt / iTXt textual chunks from a PNG buffer -> { keyword: text }.
// CRCs are not validated (we only read metadata, never re-emit the file).
function pngTextChunks(buf) {
  const out = {};
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return out;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const start = off + 8;
    const end = start + len;
    if (end > buf.length) break;
    const data = buf.subarray(start, end);
    try {
      if (type === "tEXt") {
        const z = data.indexOf(0);
        if (z > 0) out[data.toString("latin1", 0, z)] = data.toString("latin1", z + 1);
      } else if (type === "zTXt") {
        const z = data.indexOf(0);
        if (z > 0) out[data.toString("latin1", 0, z)] = zlib.inflateSync(data.subarray(z + 2)).toString("utf8");
      } else if (type === "iTXt") {
        const z = data.indexOf(0);
        if (z > 0) {
          const keyword = data.toString("latin1", 0, z);
          const compressed = data[z + 1] === 1;
          // keyword \0 compFlag compMethod langTag \0 translatedKeyword \0 text
          let p = z + 3;
          p = data.indexOf(0, p) + 1;
          p = data.indexOf(0, p) + 1;
          const text = data.subarray(p);
          out[keyword] = compressed ? zlib.inflateSync(text).toString("utf8") : text.toString("utf8");
        }
      }
    } catch { /* skip a malformed chunk, keep scanning */ }
    if (type === "IEND") break;
    off = end + 4; // + CRC
  }
  return out;
}

// --- EXIF (JPEG, WebP) -------------------------------------------------------

const TAG_EXIFIFD = 0x8769;
const TAG_USERCOMMENT = 0x9286;
const TAG_IMAGEDESCRIPTION = 0x010e;
const EXIF_HEADER = Buffer.from("Exif\0\0", "latin1");

// The TIFF payload of a JPEG's APP1/Exif segment, or undefined. Walks the
// marker chain from SOI; stops at SOS/EOI, because past the scan there are no
// more segments and a scan can be megabytes.
function jpegTiff(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }           // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return undefined;
    if (marker === 0xe1 && buf.subarray(i + 4, i + 10).equals(EXIF_HEADER)) {
      return buf.subarray(i + 10, i + 2 + len);
    }
    i += 2 + len;
  }
  return undefined;
}

// The TIFF payload of a WebP's EXIF chunk, or undefined. RIFF: "RIFF" size
// "WEBP" then fourcc/size chunks, each padded to even length. The EXIF chunk
// may or may not start with "Exif\0\0"; both are seen in the wild.
function webpTiff(buf) {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return undefined;
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.toString("latin1", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const start = i + 8, end = start + size;
    if (end > buf.length) return undefined;
    if (fourcc === "EXIF") {
      const data = buf.subarray(start, end);
      return data.subarray(0, 6).equals(EXIF_HEADER) ? data.subarray(6) : data;
    }
    i = end + (size & 1);
  }
  return undefined;
}

// UserComment is 8 bytes of charset then the body. Generators that write it
// natively use UNICODE with a UTF-16 body (piexif writes big-endian; other
// tools little-endian), fourier-sampling writes ASCII, and a zeroed prefix
// means "undefined". The UTF-16 byte order is decided by looking at the text:
// the wrong order turns every character into a CJK code point, so the decode
// with more plain ASCII in it is the right one.
function decodeUserComment(raw) {
  if (raw.length < 8) return raw.toString("utf8");
  const prefix = raw.subarray(0, 8).toString("latin1");
  const body = raw.subarray(8);
  if (prefix === "UNICODE\0") {
    const le = body.toString("utf16le");
    const swapped = Buffer.from(body); if (swapped.length % 2 === 0) swapped.swap16();
    const be = swapped.toString("utf16le");
    const ascii = (t) => (t.match(/[\x20-\x7e]/g) || []).length;
    return (ascii(be) >= ascii(le) ? be : le).replace(/\0+$/, "");
  }
  if (prefix === "JIS\0\0\0\0\0") return body.toString("latin1");
  return body.toString("utf8").replace(/\0+$/, "");
}

// { UserComment?, ImageDescription? } read from a TIFF payload: IFD0 and the
// ExifIFD it points at, both byte orders, bounds-checked at every step. The
// same walk fourier-sampling's converter verifies its own writes with.
function exifTextFields(t) {
  const out = {};
  if (!t || t.length < 8) return out;
  const order = t.toString("latin1", 0, 2);
  if (order !== "MM" && order !== "II") return out;
  const be = order === "MM";
  const u16 = (o) => (be ? t.readUInt16BE(o) : t.readUInt16LE(o));
  const u32 = (o) => (be ? t.readUInt32BE(o) : t.readUInt32LE(o));
  const value = (e, cnt) => {
    const off = cnt <= 4 ? e + 8 : u32(e + 8);
    if (off + cnt > t.length) return undefined;
    return t.subarray(off, off + cnt);
  };
  const walk = (off, depth) => {
    if (depth > 2 || off + 2 > t.length) return;
    const n = u16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      if (e + 12 > t.length) return;
      const tag = u16(e), cnt = u32(e + 4);
      if (tag === TAG_EXIFIFD) walk(u32(e + 8), depth + 1);
      else if (tag === TAG_USERCOMMENT && out.UserComment === undefined) {
        const raw = value(e, cnt); if (raw) out.UserComment = decodeUserComment(raw);
      } else if (tag === TAG_IMAGEDESCRIPTION && out.ImageDescription === undefined) {
        const raw = value(e, cnt); if (raw) out.ImageDescription = raw.toString("utf8").replace(/\0+$/, "");
      }
    }
  };
  walk(u32(4), 0);
  return out;
}

// EXIF text has no keyword to say which embedding it is, so the SHAPE decides:
// a JSON graph of class_type nodes is ComfyUI's "prompt"; JSON carrying a
// .prompt is NovelAI's "Comment" (or a saver that nested the graph under
// .prompt, which rawPrompt reads the same way once unwrapped); anything else
// is A1111's "parameters".
function exifChunks(fields) {
  const chunks = {};
  for (const text of [fields.UserComment, fields.ImageDescription]) {
    if (typeof text !== "string" || !text.trim()) continue;
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      try {
        const j = JSON.parse(trimmed);
        const isGraph = (g) => g && typeof g === "object" && Object.values(g).some((n) => n && typeof n === "object" && "class_type" in n);
        if (isGraph(j)) { chunks.prompt = chunks.prompt || trimmed; continue; }
        if (j && isGraph(j.prompt)) { chunks.prompt = chunks.prompt || JSON.stringify(j.prompt); continue; }
        if (j && typeof j.prompt === "string") { chunks.Comment = chunks.Comment || trimmed; continue; }
      } catch { /* not JSON: fall through to parameters */ }
    }
    chunks.parameters = chunks.parameters || trimmed;
  }
  return chunks;
}

// Pull the positive-prompt string out of whatever embedding is present.
function rawPrompt(chunks) {
  if (typeof chunks.parameters === "string") {
    const t = chunks.parameters;
    const neg = t.indexOf("\nNegative prompt:");
    const steps = t.indexOf("\nSteps:");
    const end = neg >= 0 ? neg : (steps >= 0 ? steps : t.length);
    return t.slice(0, end).trim();
  }
  if (typeof chunks.prompt === "string") {
    try {
      const graph = JSON.parse(chunks.prompt);
      const texts = [];
      for (const k in graph) {
        const node = graph[k];
        if (node && /CLIPTextEncode/i.test(node.class_type || "") &&
            node.inputs && typeof node.inputs.text === "string") {
          texts.push(node.inputs.text);
        }
      }
      // The longest CLIP text block is almost always the positive prompt.
      texts.sort((a, b) => b.length - a.length);
      if (texts.length) return texts[0].trim();
    } catch { /* not JSON we understand */ }
  }
  for (const key of ["Comment", "Description"]) {
    if (typeof chunks[key] === "string") {
      try {
        const c = JSON.parse(chunks[key]);
        if (c && typeof c.prompt === "string") return c.prompt.trim();
      } catch {
        if (key === "Description") return chunks[key].trim();
      }
    }
  }
  return "";
}

// Curated quality/booster + meta terms. These are KEPT but classified separately
// so the UI can tuck them into a de-emphasised, collapsible "quality & meta"
// section rather than dropping them (separating outright risks breaking a
// legitimate prompt). Curate this list as prompt fashions evolve.
const QUALITY_META = new Set([
  "masterpiece", "best_quality", "high_quality", "normal_quality", "low_quality", "worst_quality",
  "amazing_quality", "great_quality", "best_aesthetic", "high_aesthetic", "aesthetic", "very_aesthetic",
  "ultra-detailed", "ultra_detailed", "highly_detailed", "very_detailed", "extremely_detailed",
  "super_detailed", "intricate_details", "intricate", "detailed",
  "highres", "absurdres", "incredibly_absurdres", "lowres", "hires", "hi_res", "4k", "8k", "2k", "uhd", "16k",
  "official_art", "concept_art", "key_visual", "promotional_art", "game_cg", "cg",
  "award_winning", "award-winning", "trending_on_artstation", "artstation", "pixiv", "featured_on_pixiv",
  "sharp_focus", "professional", "professional_lighting", "studio_quality", "source_quality",
  "jpeg_artifacts", "scan_artifacts", "artifacts", "film_grain",
  "newest", "recent", "oldest", "year_2023", "year_2024", "year_2025", "year_2026",
]);

// One prompt term -> one Danbooru-shaped name, or "" for nothing usable.
//
// THE QUALIFIER SURVIVES. Danbooru names a character with her series in
// parentheses -- hilda_(pokemon), astolfo_(fate) -- and a prompt written for
// a booru-trained model carries exactly that, escaped for the generator:
// "hilda \(pokemon\)". The first cut of this normaliser stripped every
// parenthesis because parentheses are also A1111's emphasis syntax, and so
// "hilda \(pokemon\)" became hilda_pokemon: a name that matches no tag, so
// the booru filed it as a new general tag rather than the character it names
// (operator, 2026-09-19: "prompt metadata tags aren't being recognized as
// having a potential character/series name match an existing tag and are
// being posted as general tags"). Three shapes are told apart:
//   \( ... \)      escaped -- always literal, always kept
//   ( ... :1.2)      a weight -- the parentheses and the weight go, the term stays
//   (( ... ))        emphasis -- the parentheses go, the term stays
//   name (series)    unescaped but TRAILING a name, no weight -- a qualifier
//                    written ComfyUI-style, where nothing needs escaping; kept
// Colons survive too (re:zero, fate/grand_order have them), now that a colon
// followed by a number is the only thing read as a weight.
function normalizeTerm(raw) {
  let t = String(raw).replace(/\\\(/g, "\u0001").replace(/\\\)/g, "\u0002");
  t = t.replace(/:\s*[\d.]+(?=\s*[)\]}]|\s*$)/g, "");          // (tag:1.2) weights
  const q = /^([^()]*[^\s()])\s*\(([^()]+)\)\s*$/.exec(t);           // name (series)
  if (q && !/^[\d.\s]+$/.test(q[2])) t = `${q[1]} \u0001${q[2]}\u0002`;
  t = t.replace(/[()[\]{}]/g, " ").replace(/\\+/g, " ");
  t = t.replace(/\u0001/g, "(").replace(/\u0002/g, ")");
  return t
    .trim()
    .toLowerCase()
    .replace(/\s*\(\s*/g, "_(").replace(/\s*\)/g, ")")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/[^a-z0-9_'./:!?&+*=@~()-]/g, "")
    .replace(/^_+|_+$/g, "");
}

// Normalise a freeform prompt into Danbooru-style tags: comma-split, strip
// weights/brackets/LoRA tokens, lowercase, spaces -> underscores, dedupe. Returns
// { tags, meta } -- content tags vs quality/meta terms (kept, de-emphasised).
function promptToTags(prompt, opts) {
  const max = (opts && opts.max) || 60;
  const out = { tags: [], meta: [] };
  if (!prompt) return out;
  const seen = new Set();
  const cleaned = String(prompt).replace(/<[^>]*>/g, " ").replace(/\bBREAK\b/g, ",");
  for (const raw of cleaned.split(",")) {
    const t = normalizeTerm(raw);
    if (t.length < 2 || t.length > 60) continue;
    if (/^[\d_.]+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    if (QUALITY_META.has(t)) out.meta.push(t);
    else out.tags.push(t);
    if (out.tags.length >= max) break;
  }
  return out;
}

// The embedded text of an image, keyed the way a PNG keys it, whatever the
// container. THE BYTES DECIDE, not the declared type: a Matrix upload's
// content-type is whatever the sender's client said, and a PNG called
// image/jpeg is still a PNG.
function embeddedChunks(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return {};
  if (buffer.subarray(0, 8).equals(PNG_SIG)) return pngTextChunks(buffer);
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return exifChunks(exifTextFields(jpegTiff(buffer)));
  if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return exifChunks(exifTextFields(webpTiff(buffer)));
  // Unrecognised magic: trust the declared type once, for a PNG whose
  // signature was damaged but whose chunks may still read.
  if (contentType && /png/i.test(contentType)) return pngTextChunks(buffer);
  return {};
}

// Public: image bytes -> creator (prompt-derived) tags. Never throws.
function extractCreatorTags(buffer, contentType, opts) {
  try {
    return promptToTags(rawPrompt(embeddedChunks(buffer, contentType)), opts);
  } catch { /* fail soft */ }
  return { tags: [], meta: [] };
}

module.exports = { extractCreatorTags, normalizeTerm, embeddedChunks, pngTextChunks, exifTextFields, jpegTiff, webpTiff, decodeUserComment, rawPrompt, promptToTags, QUALITY_META };
