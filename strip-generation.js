"use strict";

// GENERATION DATA COMES OUT OF THE FILE BEFORE THE FILE LEAVES THE TUNNEL.
//
// Operator ruling 2026-09-28: the AI generation data an uploaded image carries
// -- its prompt, its settings, its workflow graph -- must NOT be served in the
// image file. The booru's originals sit on R2 behind Cloudflare, so whatever is
// in the bytes the tunnel uploads is public the moment the post exists, and
// publication is the one thing no later fix undoes. The tunnel therefore strips
// it on ingest and hands the text to the booru, which keeps it privately:
// readable by the post's CREATOR and whoever the creator allows, and nobody
// else (operator ruling 2026-09-29; danbooru.js recordGenerationMetadata).
//
// ONLY GENERATION DATA. Operator, 2026-09-28: "Yes, only generation data." An
// ICC profile, EXIF Orientation, a camera's ImageDescription, GIMP's Comment,
// an XMP copyright, a C2PA manifest -- all of it stays. This is surgery, not
// `exiftool -all=`.
//
// LOSSLESS. Nothing is decoded or re-encoded, and no pixel is touched but in
// the one case below where the generation data IS pixels:
//   PNG   a text chunk that IS generation data is dropped whole. An XMP chunk,
//         an eXIf chunk and an ImageMagick / exiv2 "Raw profile type
//         exif|xmp|iptc|8bim" chunk are rewritten with only the offending
//         property or field emptied, and given a fresh CRC. Every other chunk
//         is copied verbatim.
//         STEALTH: NovelAI, and A1111's stealth-pnginfo extension, write a
//         second copy of the generation data into the least significant bit
//         of every pixel's ALPHA, behind a magic ("stealth_pngcomp"). There
//         the alpha LSBs are all set to 1 -- a fully opaque 255 stays 255,
//         which is what the writer started from -- and IDAT is re-encoded;
//         every colour value is identical and every other chunk is copied
//         verbatim. The same copy in the COLOUR values' LSBs
//         ("stealth_rgbcomp") is REFUSED: clearing it would alter the colours.
//   JPEG  inside the EXIF APP1, the VALUE bytes of a text field holding
//         generation text are zeroed in place -- same length, so no offset in
//         the TIFF structure moves and Orientation and everything else are
//         untouched. In an XMP packet only the offending PROPERTY goes, its
//         bytes overwritten with spaces (blankXmp): same length again, and the
//         packet's copyright, creator and tool survive. In the IPTC block of a
//         Photoshop APP13, a dataset holding generation text is overwritten
//         with spaces the same way. A COM segment carrying generation markers
//         is removed.
//   WebP  the EXIF chunk and the XMP chunk get the same in-place treatment.
//   GIF   a comment extension holding generation text is cut (a GIF records
//         no offsets, so nothing else moves); an XMP application extension
//         gets the per-property treatment. A GIF whose blocks do not walk to
//         the end is REFUSED: what lies past the break cannot be read.
//   Anything else -- AVIF, HEIF, TIFF, a format nobody expected -- cannot be
//   verified here. It goes through ONLY when it carries no metadata carrier at
//   all (carriersIn); a carrier present is a refusal, never a pass.
//
// THE POST-CONDITION IS NOT OPTIONAL, AND IT IS NOT THE STRIPPER MARKING ITS
// OWN WORK. After stripping, the served bytes are checked four ways (residue):
//   1. a byte scan of the WHOLE file -- every chunk, segment and trailing
//      byte, compressed PNG text opened, UTF-16 read as well as ASCII -- for
//      markers only a generator writes, from a list kept apart from the
//      stripper's own classifier (RESIDUE_MARKERS);
//   2. prompt-tags, the reader the rest of the tunnel trusts to find a prompt,
//      judged by prompt-tags' own shapes: a generator's own chunk still
//      present, a ComfyUI graph or a JSON prompt still readable;
//   3. a PNG's pixels, read the way NovelAI's and the extension's readers read
//      them, for ANY of the four stealth signatures in EITHER the alpha or the
//      colour bits -- a wider net than the stripper's, which looks for each
//      signature only where its writer puts it. A PNG whose pixels cannot be
//      read cannot be checked, and is refused;
//   4. a second strip pass, which must find nothing left to remove.
// Any of them failing throws, and the caller refuses to post. A stripper that
// believes it did its job is evidence about the stripper; every expensive
// failure in this org has been a confident green.

const crypto = require("crypto");
const zlib = require("zlib");
const { embeddedChunks, decodeUserComment } = require("./prompt-tags");
const pixels = require("./png-pixels");

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const EXIF_HEADER = Buffer.from("Exif\0\0", "latin1");
const XMP_STD = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1");
const XMP_EXT = Buffer.from("http://ns.adobe.com/xmp/extension/\0", "latin1");
const MPF_HEADER = Buffer.from("MPF\0", "latin1");
const PNG_XMP_KEYWORD = "XML:com.adobe.xmp";
const GIF_XMP_APP = "XMP DataXMP";

// Inflating a zTXt / iTXt is bounded: a hostile image can carry a zip bomb in
// a text chunk as easily as anywhere else.
const MAX_INFLATE = 32 * 1024 * 1024;

// PNG's CRC-32, for a chunk this module rewrites. Written out rather than
// taken from zlib.crc32, which the Node 20 the image pins may predate.
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
  for (let k = 0; k < buf.length; k++) c = CRC_TABLE[(c ^ buf[k]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// --- what counts as generation data -----------------------------------------

// How sure a verdict is. STRONG is a generator's own signal -- its keyword,
// its markers, its prompt syntax -- and is what earns a post the PUBLIC
// "ai-generated" tag (image-plan.js). LOOSE is only the shape of a prompt: it
// is stripped and kept privately all the same, because a caption stripped is
// recoverable and a prompt served is not, but it labels nothing in public.
const NONE = 0, LOOSE = 1, STRONG = 2;

// PNG keywords that ARE generation data whatever they hold. Each is here
// because a named generator writes it, and no other software writes the name:
//   parameters            AUTOMATIC1111, Forge, SD.Next, Fooocus, SwarmUI
//   postprocessing,
//   extras                A1111's extras tab: the upscaler and its settings
//   prompt, workflow      ComfyUI (the API graph and the UI graph)
//   invokeai_metadata,
//   invokeai_graph,
//   invokeai_workflow     InvokeAI 3 and later
//   sd-metadata, Dream    InvokeAI 2 (chanbooru's is_ai_generated? reads both)
//   fooocus_scheme        Fooocus
//   parameters-json,
//   smproj                Stability Matrix, beside its A1111 "parameters": the
//                         same settings as PascalCase JSON (PositivePrompt,
//                         NegativePrompt, ModelName), and the whole project
//                         with its prompt card
//   the rest              Easy Diffusion, which writes ONE CHUNK PER SETTING:
//                         its prompt and negative_prompt, then the model, VAE,
//                         LoRA, sampler, steps, guidance and so on, each under
//                         its own snake_case name
const PNG_EASYDIFFUSION_KEYS = [
  "negative_prompt", "use_stable_diffusion_model", "use_vae_model", "use_text_encoder_model",
  "use_lora_model", "lora_alpha", "use_hypernetwork_model", "hypernetwork_strength",
  "use_embedding_models", "use_embeddings_model", "use_controlnet_model", "control_filter_to_apply",
  "control_alpha", "use_face_correction", "use_upscale", "upscale_amount", "latent_upscaler_steps",
  "num_inference_steps", "guidance_scale", "distilled_guidance_scale", "prompt_strength",
  "sampler_name", "scheduler_name", "clip_skip",
];
const PNG_GENERATOR_KEYS = new Set([
  "parameters", "postprocessing", "extras",
  "prompt", "workflow",
  "invokeai_metadata", "invokeai_graph", "invokeai_workflow",
  "sd-metadata", "Dream", "fooocus_scheme",
  "parameters-json", "smproj",
  ...PNG_EASYDIFFUSION_KEYS,
]);

// A keyword that NAMES generation content -- "sd_prompt", "Workflow",
// "parameters_v2" -- the booru's own filter hides by the same words, and
// generators keep inventing such names. It goes; the value decides whether
// that labels the post (a keyword alone is a name, not a generator's
// signature, so on its own it is LOOSE).
const PNG_GENERATION_NAME = /prompt|workflow|parameters/i;

// Easy Diffusion's settings whose NAMES are ordinary words: generation data in
// an Easy Diffusion file, which is known by the keys above, and nobody else's
// business to have us remove.
const PNG_EASYDIFFUSION_CONTEXT_KEYS = new Set(["seed", "width", "height", "tiling"]);

// Keywords ordinary software writes too -- GIMP's "Comment", a screenshot
// tool's "Description" -- so they go only when they hold a prompt, or when
// the file is NovelAI's, whose Description IS the bare prompt and whose
// Comment is its settings JSON.
const PNG_SHARED_KEYS = new Set(["Comment", "Description"]);

// NovelAI's model name + hash and its timing: generation data in a NovelAI
// file, and nobody else's business to have us remove. "Title" and "Software"
// stay -- they name the tool, not the generation, and they are what the
// booru's own is_ai_generated? reads.
const PNG_NOVELAI_KEYS = new Set(["Source", "Generation time"]);

// "Raw profile type <kind>": ImageMagick's and exiv2's way of carrying a whole
// metadata block in a PNG text chunk, hex-encoded, from before eXIf existed.
// A GIMP export of an A1111 JPEG carries the prompt in one of these, and
// ImageMagick copies a JPEG's IPTC into two more: "iptc" (the datasets) and
// "8bim" (the Photoshop resources holding them).
const RAW_PROFILE = /^Raw profile type (exif|app1|xmp|iptc|8bim)$/i;

// JSON keys only a generator's metadata carries: A1111-in-JSON (SwarmUI),
// ComfyUI's API graph (class_type) and UI graph (widgets_values), NovelAI's
// settings (uc), InvokeAI's metadata, Draw Things' XMP UserComment, and
// Stability Matrix's PascalCase settings and project (PositivePrompt, ...).
const JSON_GENERATION_KEY =
  /"(?:prompt|positive_prompt|negative_prompt|uc|workflow|sui_image_params|class_type|widgets_values|generation_mode|sampler_name|cfg_scale|noise_schedule|invokeai_metadata|PositivePrompt|NegativePrompt|CfgScale)"\s*:/;

// STRONG markers: text no ordinary tool writes. Used for every field that
// ordinary software also uses freely (XMP, COM, an unknown PNG keyword), so a
// photo's metadata is never mistaken for a prompt.
function hasGenerationMarkers(text) {
  if (typeof text !== "string" || !text) return false;
  if (/(?:^|\n)\s*Negative prompt:/.test(text)) return true;                       // A1111
  if (/\bSteps:\s*\d+\s*,/.test(text) && /\b(?:Sampler|CFG scale|Seed|Model hash|Size):\s*\S/.test(text)) return true;
  if (JSON_GENERATION_KEY.test(text)) return true;
  if (/\bJob ID:\s*[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text)) return true;            // Midjourney
  if (/<(?:lora|lyco|hypernet|embedding):[^<>]+>/i.test(text)) return true;         // A1111 network syntax
  if (/(?:^|\n)\s*(?:Include in Image|Exclude from Image):/.test(text)) return true; // Mochi Diffusion
  return false;
}

// A BARE PROMPT, for the fields prompt-tags already reads AS a prompt (EXIF
// UserComment / ImageDescription / XPComment, a PNG Comment or Description, a
// GIF comment, an XMP description, an IPTC caption): STRONG for the markers, a
// decimal A1111 weight or the booru-tag words no caption is written in
// (1girl, 1boy, absurdres); LOOSE for nothing more than a comma-separated
// list of short terms, or the quality words "masterpiece" and "best quality",
// which are ordinary English -- a museum photo captioned "a masterpiece of
// impressionism" is not generated, and must not be LABELLED so in public.
// LOOSE can catch a human caption like "Paris, France, summer, 2019"; that is
// the error chosen on purpose -- a caption stripped is still kept privately on
// the booru, and a prompt served through Cloudflare is published for good --
// and it is why LOOSE never puts "ai-generated" on a post.
function promptStrength(text) {
  if (typeof text !== "string") return NONE;
  const t = text.trim();
  if (!t) return NONE;
  if (hasGenerationMarkers(t)) return STRONG;
  if (/\([^()]{1,80}:\s*-?\d*\.\d+\s*\)/.test(t)) return STRONG;                   // (tag:1.2)
  if (/\b(?:1girl|1boy|absurdres)\b/i.test(t)) return STRONG;
  if (/\b(?:masterpiece|best[ _]quality)\b/i.test(t)) return LOOSE;
  if (/\([^()]{1,80}:\s*-?\d+\s*\)/.test(t)) return LOOSE;                          // (tag:2)
  const terms = t.split(",").map((s) => s.trim()).filter(Boolean);
  if (terms.length >= 4 && terms.every((s) => s.length <= 64 && s.split(/\s+/).length <= 6)) return LOOSE;
  return NONE;
}
function looksLikePrompt(text) {
  return promptStrength(text) > NONE;
}

// Numeric references outside Unicode are left as written: String.fromCodePoint
// throws on them, and a hostile packet must not turn into a refusal to post.
const codePoint = (n, whole) => (n <= 0x10ffff ? String.fromCodePoint(n) : whole);
function xmlUnescape(s) {
  return String(s)
    .replace(/&#x([0-9a-f]{1,8});/gi, (whole, h) => codePoint(parseInt(h, 16), whole))
    .replace(/&#(\d{1,10});/g, (whole, d) => codePoint(Number(d), whole))
    .replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// ImageMagick mirrors EXIF values into PNG text chunks named exif:<Tag>, and
// renders a byte it cannot print as '.': a UNICODE UserComment arrives as
// "UNICODE..m.a.s.t.e.r" -- the charset label, then every character beside
// its zero byte. This reads it back as the text it was.
function demirror(text) {
  let t = String(text).replace(/^(?:UNICODE|ASCII|JIS)[.\0]{0,3}/, "");
  if (t.length >= 4) {
    for (const parity of [0, 1]) {
      let dots = 0, total = 0;
      for (let k = parity; k < t.length; k += 2) { total++; if (t[k] === "." || t[k] === "\0") dots++; }
      if (dots / total >= 0.9) {
        let out = "";
        for (let k = 1 - parity; k < t.length; k += 2) out += t[k];
        t = out;
        break;
      }
    }
  }
  return t.replace(/\0+$/, "");
}

// The mirror of an EXIF field is judged the way the field itself is.
const EXIF_PROMPT_FIELDS = new Set(["UserComment", "ImageDescription", "XPComment"]);
function exifMirrorStrength(keyword, text) {
  const t = demirror(text);
  if (EXIF_PROMPT_FIELDS.has(keyword.slice(5))) return promptStrength(t);
  return hasGenerationMarkers(t) ? STRONG : NONE;
}

// How much of this PNG text chunk is generation data. `text` is null when the
// chunk could not be decoded; a generator's own keyword goes regardless,
// anything else is kept because there is nothing to judge it by (and the
// post-condition refuses a file whose compressed text will not open).
function pngStrength(keyword, text, ctx) {
  if (PNG_GENERATOR_KEYS.has(keyword)) return STRONG;
  if (ctx.easyDiffusion && PNG_EASYDIFFUSION_CONTEXT_KEYS.has(keyword)) return STRONG;
  if (typeof text !== "string") return NONE;
  if (ctx.novelai && (PNG_SHARED_KEYS.has(keyword) || PNG_NOVELAI_KEYS.has(keyword))) return STRONG;
  if (PNG_SHARED_KEYS.has(keyword)) return promptStrength(text);
  if (keyword.startsWith("exif:")) return exifMirrorStrength(keyword, text);
  if (hasGenerationMarkers(text)) return STRONG;
  // ComfyUI's SaveImage writes every extra_pnginfo entry as a chunk of its
  // own, JSON-encoded; a custom node's entry names nothing a marker knows. In
  // a ComfyUI file -- known by its graph -- a chunk of JSON is one of those.
  if (ctx.comfyUI && isJsonStructure(text)) return STRONG;
  return PNG_GENERATION_NAME.test(keyword) && text.trim() ? LOOSE : NONE;
}

function isJsonStructure(text) {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

function isNovelAI(software, source) {
  return /novelai/i.test(software || "") || /novelai/i.test(source || "");
}

// --- the record of what came out --------------------------------------------

// NUL is stripped from recorded text: the booru stores it in Postgres, which
// refuses U+0000 in text and in jsonb alike, and a NUL is never the meaningful
// part of a prompt. Two fields under one key (two XMP properties, a keyword
// repeated) are joined by a newline rather than one silently winning; the
// same text twice (an eXIf and its raw-profile twin) is kept once.
function record(removed, key, text) {
  const clean = String(text).replace(/\0/g, "");
  if (!Object.prototype.hasOwnProperty.call(removed, key)) { removed[key] = clean; return; }
  if (removed[key] === clean) return;
  removed[key] = `${removed[key]}\n${clean}`;
}

// What one strip took, and whether any of it was a STRONG signal.
function newTake() {
  return { removed: {}, confident: false };
}
function note(take, key, text, strength) {
  record(take.removed, key, text);
  if (strength >= STRONG) take.confident = true;
}

// The record key for a PNG text chunk. The booru takes "png:" and 1 to 79
// characters with no control character among them -- the PNG spec's own rule
// for a keyword -- so a hostile keyword is made to fit here rather than have
// the booru refuse the whole record over one key.
function pngKey(keyword) {
  return `png:${String(keyword).replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 79)}`;
}

function unchanged(buffer) {
  return { buffer, removed: {}, changed: false, confident: false };
}
function taken(buffer, take) {
  return { buffer, removed: take.removed, changed: true, confident: take.confident };
}

function startsWith(buf, prefix) {
  return buf.length >= prefix.length && buf.subarray(0, prefix.length).equals(prefix);
}

// --- XMP, property by property ------------------------------------------------

// The XMP properties generation text lives in, and how strictly each is
// judged: the description / comment properties are free text a generator
// fills with its prompt (Midjourney's dc:description, Draw Things'
// exif:UserComment), so the prompt shape is enough; a property named for a
// generator's own field goes whatever it holds; anything else goes only on
// the strong markers.
const XMP_PROMPT_PROPS = new Set(["dc:description", "exif:UserComment", "tiff:ImageDescription"]);
const XMP_GENERATOR_NAMES = new Set(["parameters", "prompt", "negative_prompt", "workflow"]);
function xmpStrength(name, value) {
  const local = name.slice(name.indexOf(":") + 1);
  if (XMP_GENERATOR_NAMES.has(local) && value.trim()) return STRONG;
  if (XMP_PROMPT_PROPS.has(name)) return promptStrength(value);
  return hasGenerationMarkers(value) ? STRONG : NONE;
}

// The index just past `token`, searching from `from`, or -1.
function after(s, token, from) {
  const at = s.indexOf(token, from);
  return at < 0 ? -1 : at + token.length;
}

// Where a tag ends: the '>' not inside a quoted attribute value, or -1.
function tagEnd(s, lt) {
  let quote = null;
  for (let k = lt + 1; k < s.length; k++) {
    const ch = s[k];
    if (quote) { if (ch === quote) quote = null; } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === ">") return k;
    else if (ch === "<") return -1;
  }
  return -1;
}

const XML_ATTR = /(\s+)([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/g;

// Every property of every top-level rdf:Description in an XMP packet, and the
// byte range it occupies: an attribute on the Description (its leading space
// included), or a child element from its '<' to past its end tag. `s` is the
// packet read as latin1, so a string index IS a byte offset. null when the
// markup does not nest; the caller then judges the packet whole.
function xmpProperties(s) {
  const props = [];
  const stack = [];
  let i = 0;
  for (;;) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    let skip = 0;
    if (s.startsWith("<!--", lt)) skip = after(s, "-->", lt + 4);
    else if (s.startsWith("<![CDATA[", lt)) skip = after(s, "]]>", lt + 9);
    else if (s.startsWith("<?", lt)) skip = after(s, "?>", lt + 2);
    else if (s.startsWith("<!", lt)) skip = after(s, ">", lt + 2);
    if (skip < 0) return null;
    if (skip > 0) { i = skip; continue; }
    const gt = tagEnd(s, lt);
    if (gt < 0) return null;
    if (s[lt + 1] === "/") {
      const open = stack.pop();
      if (!open || open.name !== s.slice(lt + 2, gt).trim()) return null;
      if (open.prop) open.prop.end = gt + 1;
      i = gt + 1;
      continue;
    }
    const selfClosing = s[gt - 1] === "/";
    const inner = s.slice(lt + 1, selfClosing ? gt - 1 : gt);
    const nm = /^[^\s/>]+/.exec(inner);
    if (!nm) return null;
    const el = { name: nm[0] };
    const parent = stack[stack.length - 1];
    if (/:Description$/.test(el.name) && parent && /:RDF$/.test(parent.name)) {
      el.description = true;
      for (const m of inner.matchAll(XML_ATTR)) {
        if (/^(?:xmlns(?::|$)|rdf:|xml:)/.test(m[2])) continue;
        const start = lt + 1 + m.index;
        props.push({ name: m[2], start, end: start + m[0].length, value: m[3].slice(1, -1), kind: "attr" });
      }
    } else if (parent && parent.description) {
      el.prop = { name: el.name, start: lt, end: selfClosing ? gt + 1 : -1, kind: "elem" };
      props.push(el.prop);
    }
    if (!selfClosing) stack.push(el);
    i = gt + 1;
  }
  if (stack.length) return null;
  return props;
}

// Empty every generation property of an XMP packet, IN PLACE: its bytes become
// spaces, so the packet keeps its length and stays well-formed XML -- space
// between elements, or between attributes, is nothing. That is what lets a
// JPEG, a WebP, a multi-picture file and a GIF keep every offset they record.
// Returns "changed", "unchanged", or "whole" when generation text is in the
// packet somewhere no property accounts for (or the markup will not parse),
// and the caller must remove the packet whole.
function blankXmp(bytes, key, take) {
  const wholeText = () => xmlUnescape(bytes.toString("utf8"));
  // A UTF-16 or UTF-32 packet (legal; never seen from a generator) does not
  // parse as bytes. It is judged as one piece.
  const props = bytes.includes(0) ? null : xmpProperties(bytes.toString("latin1"));
  if (!props) {
    const text = bytes.includes(0) ? xmlUnescape(bytes.toString("latin1").replace(/\0/g, "")) : wholeText();
    if (!hasGenerationMarkers(text)) return "unchanged";
    note(take, key, bytes.toString("utf8"), STRONG);
    return "whole";
  }
  let changed = false;
  for (const p of props) {
    const source = bytes.toString("utf8", p.start, p.end);
    const value = p.kind === "attr"
      ? xmlUnescape(Buffer.from(p.value, "latin1").toString("utf8"))
      : xmlUnescape(source.replace(/<[^>]*>/g, " ")).trim();
    let strength = xmpStrength(p.name, value);
    if (!strength && hasGenerationMarkers(xmlUnescape(source))) strength = STRONG;
    if (!strength) continue;
    note(take, key, source.trim(), strength);
    bytes.fill(0x20, p.start, p.end);
    changed = true;
  }
  // Whatever the property walk could not attribute -- text between
  // properties, a comment, a second rdf:RDF -- is judged as one.
  const rest = wholeText();
  if (hasGenerationMarkers(rest)) {
    note(take, key, rest, STRONG);
    return "whole";
  }
  return changed ? "changed" : "unchanged";
}

// Empty one named property, unjudged and unrecorded: the pointer a main XMP
// packet keeps to an extension that has been cut.
function blankXmpProperty(bytes, name) {
  const props = bytes.includes(0) ? null : xmpProperties(bytes.toString("latin1"));
  let hit = false;
  for (const p of props || []) if (p.name === name) { bytes.fill(0x20, p.start, p.end); hit = true; }
  return hit;
}

// --- EXIF (JPEG APP1, WebP EXIF chunk, PNG eXIf) -------------------------------

const TAG_EXIFIFD = 0x8769;
const TAG_IPTC_NAA = 0x83bb;
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
const trimNul = (s) => s.replace(/\0+$/, "");

// The text fields generation data lives in, and how strictly each is judged.
// UserComment, ImageDescription and XPComment are free text that prompt-tags
// reads as a prompt, so the prompt shape is enough. Make, Model and
// DocumentName are where ComfyUI's WebP saver puts its graphs
// ("prompt:{...}" in Model, "workflow:{...}" in Make, further keys counting
// down from there); a camera's "Canon" must never match, so only the strong
// markers do -- or ComfyUI's own shape, "<key>:" then JSON, in the four
// fields it counts down through (comfy). A custom node's extra key holds no
// marker at all ("custom_note:{\"text\": ...}"), and no camera or caption is
// written as a label glued to a JSON object.
const COMFY_LABELLED = /^[\w.-]{1,64}:(?:[[{]|null\b)/;
const EXIF_TEXT_TAGS = new Map([
  [0x9286, { key: "exif:UserComment", decode: (raw) => decodeUserComment(raw), prompt: true }],
  [0x010e, { key: "exif:ImageDescription", decode: (raw) => raw.toString("utf8"), prompt: true, comfy: true }],
  [0x9c9c, { key: "exif:XPComment", decode: (raw) => raw.toString("utf16le"), prompt: true }],
  [0x010f, { key: "exif:Make", decode: (raw) => raw.toString("utf8"), prompt: false, comfy: true }],
  [0x0110, { key: "exif:Model", decode: (raw) => raw.toString("utf8"), prompt: false, comfy: true }],
  [0x010d, { key: "exif:DocumentName", decode: (raw) => raw.toString("utf8"), prompt: false, comfy: true }],
]);

// Zero, in place, the value bytes of every EXIF text field holding generation
// text in the TIFF structure at out[tStart, tEnd). IFD0, the IFD1 it chains
// to, and the ExifIFD, both byte orders, bounds-checked at every step, each
// IFD visited once. Returns true when anything was blanked.
function blankTiff(out, tStart, tEnd, take) {
  if (tEnd - tStart < 8) return false;
  const t = out.subarray(tStart, tEnd);
  const order = t.toString("latin1", 0, 2);
  if (order !== "MM" && order !== "II") return false;
  const be = order === "MM";
  const u16 = (o) => (be ? t.readUInt16BE(o) : t.readUInt16LE(o));
  const u32 = (o) => (be ? t.readUInt32BE(o) : t.readUInt32LE(o));
  const visited = new Set();
  let changed = false;
  const walk = (off, depth) => {
    if (depth > 4 || off < 8 || off + 2 > t.length || visited.has(off)) return;
    visited.add(off);
    const n = u16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      if (e + 12 > t.length) return;
      const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      if (tag === TAG_EXIFIFD) { walk(u32(e + 8), depth + 1); continue; }
      const spec = EXIF_TEXT_TAGS.get(tag);
      if (!spec && tag !== TAG_IPTC_NAA) continue;
      // An unknown type is read as bytes, the way prompt-tags reads it: a
      // field it can see is a field this must be able to blank.
      const bytes = (TYPE_SIZE[type] || 1) * cnt;
      if (!bytes || bytes > t.length) continue;
      const at = bytes <= 4 ? e + 8 : u32(e + 8);
      if (at + bytes > t.length) continue;
      const raw = t.subarray(at, at + bytes);
      // A TIFF's IPTC block (a scanner's or a DAM's): its datasets, blanked in
      // place like any other IPTC. What will not parse is left to the
      // post-condition, whose byte scan reads it where it lies.
      if (tag === TAG_IPTC_NAA) { if (blankIptcBlock(raw, take).changed) changed = true; continue; }
      const text = trimNul(spec.decode(raw));
      if (!text.trim()) continue;
      let strength = spec.prompt ? promptStrength(text) : (hasGenerationMarkers(text) ? STRONG : NONE);
      if (!strength && spec.comfy && COMFY_LABELLED.test(text.trim())) strength = STRONG;
      if (!strength) continue;
      note(take, spec.key, text, strength);
      raw.fill(0);
      changed = true;
    }
    const next = off + 2 + n * 12;
    if (depth === 0 && next + 4 <= t.length) walk(u32(next), depth + 1);
  };
  walk(u32(4), 0);
  return changed;
}

// --- IPTC (JPEG APP13, PNG "Raw profile type iptc|8bim", a TIFF's IPTC-NAA) -----

// The IPTC-IIM datasets (record 2) generation text is looked for in, and how
// each is judged. Caption-Abstract is the third copy of a photo's caption --
// the Metadata Working Group has tools keep EXIF ImageDescription, XMP
// dc:description and it in step -- and Mochi Diffusion writes its whole
// generation record there, so it is judged as its two twins are, by the prompt
// shape. The rest go only on the strong markers. A dataset not named here that
// carries markers is refused by the post-condition's byte scan.
const IPTC_DATASETS = new Map([
  [5, { name: "ObjectName", prompt: false }],
  [25, { name: "Keywords", prompt: false }],
  [40, { name: "SpecialInstructions", prompt: false }],
  [105, { name: "Headline", prompt: false }],
  [120, { name: "Caption-Abstract", prompt: true }],
  [122, { name: "Writer-Editor", prompt: false }],
]);
const PHOTOSHOP = Buffer.from("Photoshop 3.0\0", "latin1");
const IRB_SIGNATURES = new Set(["8BIM", "MeSa", "PHUT", "AgHg", "DCSR"]);
const IRB_IPTC = 0x0404, IRB_IPTC_DIGEST = 0x0425;

// IIM text is ISO 8859-1 unless the file says UTF-8; read as UTF-8 whenever
// the bytes ARE valid UTF-8, which is what every generator writes.
function iptcText(raw) {
  const utf8 = raw.toString("utf8");
  return Buffer.from(utf8, "utf8").equals(raw) ? utf8 : raw.toString("latin1");
}
const zeroes = (buf, from, to) => { for (let k = from; k < to; k++) if (buf[k] !== 0) return false; return true; };

// The datasets of an IIM stream in bytes[from, to), each holding generation
// text overwritten IN PLACE with spaces: same length, so no length field and
// no offset around it moves. { ok, changed }: ok false when the stream does
// not walk (what was blanked before the break stays blanked).
function blankIim(bytes, from, to, take) {
  let p = from, changed = false;
  while (p < to) {
    if (bytes[p] !== 0x1c) return { ok: zeroes(bytes, p, to), changed };   // NUL padding ends a block
    if (p + 5 > to) return { ok: false, changed };
    const rec = bytes[p + 1], ds = bytes[p + 2];
    let len = bytes.readUInt16BE(p + 3), q = p + 5;
    if (len & 0x8000) {                                                     // extended length
      const n = len & 0x7fff;
      if (n < 1 || n > 4 || q + n > to) return { ok: false, changed };
      len = 0;
      for (let k = 0; k < n; k++) len = len * 256 + bytes[q + k];
      q += n;
    }
    if (q + len > to) return { ok: false, changed };
    const spec = rec === 2 ? IPTC_DATASETS.get(ds) : undefined;
    if (spec && len) {
      const raw = bytes.subarray(q, q + len);
      const text = iptcText(raw);
      const strength = !text.trim() ? NONE : spec.prompt ? promptStrength(text) : (hasGenerationMarkers(text) ? STRONG : NONE);
      if (strength) {
        note(take, `iptc:${spec.name}`, text, strength);
        raw.fill(0x20);
        changed = true;
      }
    }
    p = q + len;
  }
  return { ok: true, changed };
}

// Photoshop image resource blocks in bytes[from, to): a signature, a 16-bit
// id, a Pascal name padded to even, a 32-bit size, the data padded to even.
// The IPTC datasets are resource 0x0404. Photoshop keeps an MD5 of them in
// 0x0425; when that digest matched the datasets before they were blanked, it
// is brought up to date (same 16 bytes, in place), so the file does not claim
// its IPTC was edited behind Photoshop's back.
function blankIrbs(bytes, from, to, take) {
  const blocks = [];
  let p = from;
  while (p < to) {
    if (p + 12 > to || !IRB_SIGNATURES.has(bytes.toString("latin1", p, p + 4))) {
      if (zeroes(bytes, p, to)) break;
      return { ok: false, changed: false };
    }
    const id = bytes.readUInt16BE(p + 4);
    let q = p + 6 + ((bytes[p + 6] + 2) & ~1);
    if (q + 4 > to) return { ok: false, changed: false };
    const size = bytes.readUInt32BE(q);
    q += 4;
    if (q + size > to) return { ok: false, changed: false };
    blocks.push({ id, start: q, end: q + size });
    p = q + size + (size & 1);
  }
  let changed = false;
  for (const b of blocks) {
    if (b.id !== IRB_IPTC) continue;
    const before = crypto.createHash("md5").update(bytes.subarray(b.start, b.end)).digest();
    const r = blankIim(bytes, b.start, b.end, take);
    if (r.changed) {
      changed = true;
      const after = crypto.createHash("md5").update(bytes.subarray(b.start, b.end)).digest();
      for (const d of blocks) {
        if (d.id === IRB_IPTC_DIGEST && d.end - d.start === 16 && bytes.subarray(d.start, d.end).equals(before)) after.copy(bytes, d.start);
      }
    }
    if (!r.ok) return { ok: false, changed };
  }
  return { ok: true, changed };
}

// An IPTC block in whichever wrapping it came: a Photoshop APP13 payload, a
// bare run of resource blocks (ImageMagick's "8bim" profile), or the IIM
// datasets themselves (its "iptc" profile, a TIFF's IPTC-NAA tag).
function blankIptcBlock(bytes, take) {
  if (startsWith(bytes, PHOTOSHOP)) return blankIrbs(bytes, PHOTOSHOP.length, bytes.length, take);
  if (bytes.length >= 4 && IRB_SIGNATURES.has(bytes.toString("latin1", 0, 4))) return blankIrbs(bytes, 0, bytes.length, take);
  if (bytes[0] === 0x1c) return blankIim(bytes, 0, bytes.length, take);
  return { ok: false, changed: false };
}

// The refusal for an IPTC block that would not parse and carries generation
// markers: it cannot be blanked field by field, and cutting it whole would
// take every other Photoshop resource with it.
function iptcRefusal(where) {
  return {
    why: `${where} carries generation text in an IPTC / Photoshop block that does not parse, so it cannot be blanked field by field`,
    fix: "re-save the image without its IPTC (for example `exiftool -IPTC:all= -Photoshop:all= <file>`) and post that",
  };
}

// --- PNG ----------------------------------------------------------------------

// A tEXt / zTXt / iTXt chunk, read: { keyword, text, bytes, rebuild }. `bytes`
// is the text payload as stored once decompressed, and rebuild(newBytes) gives
// the chunk DATA with that payload put back the same way. text and bytes are
// null when the chunk will not decode. null when there is no keyword at all.
function readPngText(type, data) {
  const z = data.indexOf(0);
  if (z <= 0) return null;
  const keyword = data.toString("latin1", 0, z);
  try {
    if (type === "tEXt") {
      const head = data.subarray(0, z + 1);
      const bytes = data.subarray(z + 1);
      return { keyword, text: bytes.toString("latin1"), bytes, rebuild: (nb) => Buffer.concat([head, nb]) };
    }
    if (type === "zTXt") {
      const head = data.subarray(0, z + 2);
      const bytes = zlib.inflateSync(data.subarray(z + 2), { maxOutputLength: MAX_INFLATE });
      return { keyword, text: bytes.toString("utf8"), bytes, rebuild: (nb) => Buffer.concat([head, zlib.deflateSync(nb)]) };
    }
    // iTXt: keyword \0 compFlag compMethod langTag \0 translatedKeyword \0 text
    const compressed = data[z + 1] === 1;
    const lang = data.indexOf(0, z + 3);
    if (lang < 0) throw new Error("no language tag terminator");
    const trans = data.indexOf(0, lang + 1);
    if (trans < 0) throw new Error("no translated keyword terminator");
    const head = data.subarray(0, trans + 1);
    const body = data.subarray(trans + 1);
    const bytes = compressed ? zlib.inflateSync(body, { maxOutputLength: MAX_INFLATE }) : body;
    return { keyword, text: bytes.toString("utf8"), bytes, rebuild: (nb) => Buffer.concat([head, compressed ? zlib.deflateSync(nb) : nb]) };
  } catch {
    return { keyword, text: null, bytes: null, rebuild: null };
  }
}

// A raw profile's payload: "\n<name>\n<length, padded>\n<hex, 72 to a line>\n".
// { data, positions } -- the bytes it spells, and where in the text each hex
// digit sits, so a byte changed in `data` can be written back in place -- or
// null when the text is not that shape.
function readRawProfile(textBytes) {
  const s = textBytes.toString("latin1");
  const m = /^\s*[^\n]*\n\s*(\d+)\s*\n/.exec(s.startsWith("\n") ? s.slice(1) : s);
  if (!m) return null;
  const from = (s.startsWith("\n") ? 1 : 0) + m[0].length;
  const positions = [];
  for (let k = from; k < s.length; k++) if (/[0-9a-fA-F]/.test(s[k])) positions.push(k);
  const n = Math.min(Number(m[1]), Math.floor(positions.length / 2));
  if (!n) return null;
  const data = Buffer.alloc(n);
  for (let k = 0; k < n; k++) data[k] = parseInt(s[positions[2 * k]] + s[positions[2 * k + 1]], 16);
  return { data, positions };
}

// Blank the generation text inside a raw profile. The new text payload, the
// string "whole" when the profile must go whole, { refusal } when it carries
// generation text that cannot be blanked, or null when nothing changed.
function blankRawProfile(kind, t, take) {
  const profile = readRawProfile(t.bytes);
  if (!profile) return null;
  const { data, positions } = profile;
  const key = pngKey(t.keyword);
  let changed;
  if (kind === "xmp") {
    const verdict = blankXmp(data, key, take);
    if (verdict === "whole") return "whole";
    changed = verdict === "changed";
  } else if (kind === "iptc" || kind === "8bim") {
    const r = blankIptcBlock(data, take);
    if (!r.ok && hasGenerationMarkers(iptcText(data))) return { refusal: iptcRefusal(`The PNG's "${t.keyword}" chunk`) };
    changed = r.changed;
  } else {
    changed = blankTiff(data, startsWith(data, EXIF_HEADER) ? EXIF_HEADER.length : 0, data.length, take);
  }
  if (!changed) return null;
  const out = Buffer.from(t.bytes);
  for (let k = 0; k < data.length; k++) {
    const hex = data[k].toString(16).padStart(2, "0");
    out[positions[2 * k]] = hex.charCodeAt(0);
    out[positions[2 * k + 1]] = hex.charCodeAt(1);
  }
  return out;
}

function pngChunks(buf) {
  const chunks = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const end = off + 12 + len;
    if (end > buf.length) break;
    const type = buf.toString("latin1", off + 4, off + 8);
    chunks.push({ start: off, end, type, data: buf.subarray(off + 8, off + 8 + len) });
    off = end;
    if (type === "IEND") break;
  }
  return { chunks, rest: off };
}

// --- stealth: generation data in the pixels themselves -------------------------
//
// NovelAI writes every PNG's metadata a second time into the least
// significant bit of each pixel's ALPHA, and A1111's stealth-pnginfo
// extension does the same for any Stable Diffusion PNG: column by column from
// the top left, a 15-byte magic, a 32-bit length in bits, then the payload
// (gzip'd for the "comp" magics). NovelAI's published reader and the extension
// both read it straight out of the served image, so the text chunks going
// does not make the prompt private while this stays.
//
// The alpha copy is CLEARED: every alpha LSB set to 1. The extension writes
// into an alpha it has just set to 255 and NovelAI's images are opaque, so
// that puts back exactly the alpha they started from; a translucent pixel
// moves by at most one level in 255. Colour values are not touched. The
// extension's RGB mode writes into the COLOUR values' LSBs instead; clearing
// those would alter the picture, so that is REFUSED (operator decision
// 2026-09-29), as is an alpha copy in a layout this cannot rewrite (a palette
// or colour-key transparency, or an image too large to decode whole).
const STEALTH_ALPHA = new Set(["stealth_pnginfo", "stealth_pngcomp"]);
const STEALTH_RGB = new Set(["stealth_rgbinfo", "stealth_rgbcomp"]);
const STEALTH_MAGIC_BITS = 15 * 8;
const STEALTH_HEADER_BITS = STEALTH_MAGIC_BITS + 32;
// A payload is a few kilobytes; one past a megabyte is kept truncated.
const MAX_STEALTH_BYTES = 1024 * 1024;

// The bytes of one LSB stream, from bit `from`: "alpha" is a bit per pixel,
// "rgb" three (r, g, b), in the readers' order -- down each column, then the
// next column.
function stealthBytes(dec, view, stream, from, n) {
  const { img, data } = dec;
  const out = Buffer.alloc(n);
  let pixel = -1, bits = null;
  for (let k = 0; k < n * 8; k++) {
    const at = from + k;
    const p = stream === "alpha" ? at : Math.floor(at / 3);
    if (p !== pixel) { pixel = p; bits = pixels.lsbAt(img, data, Math.floor(p / img.height), p % img.height, view); }
    out[k >> 3] = (out[k >> 3] << 1) | (stream === "alpha" ? bits[3] : bits[at % 3]);
  }
  return out;
}

// Which of `magics` open which stream, in which view: [{ stream, view, magic }].
// The first 120 pixels in column order must be readable (decode's `pixels`).
function stealthMagics(dec, magics) {
  const found = [];
  const total = dec.img.width * dec.img.height;
  for (const view of pixels.viewsOf(dec.img)) {
    for (const stream of ["alpha", "rgb"]) {
      if ((stream === "alpha" ? total : 3 * total) < STEALTH_MAGIC_BITS) continue;
      const magic = stealthBytes(dec, view, stream, 0, 15).toString("latin1");
      if (magics.has(magic)) found.push({ stream, view, magic });
    }
  }
  return found;
}

// The payload behind an alpha magic, as text, for the private record. What
// will not decode is kept as base64, labelled, rather than lost.
function stealthPayload(dec, view, magic) {
  const room = dec.img.width * dec.img.height - STEALTH_HEADER_BITS;
  if (room < 0) return `[${magic} with no room for a payload]`;
  const declared = stealthBytes(dec, view, "alpha", STEALTH_MAGIC_BITS, 4).readUInt32BE(0);
  const n = Math.min(Math.floor(Math.min(declared, room) / 8), MAX_STEALTH_BYTES);
  const raw = stealthBytes(dec, view, "alpha", STEALTH_HEADER_BITS, n);
  let text = null;
  if (declared <= room) {
    if (magic.endsWith("comp")) {
      try { text = zlib.gunzipSync(raw, { maxOutputLength: MAX_INFLATE }).toString("utf8"); } catch { text = null; }
    } else {
      text = raw.toString("utf8");
    }
  }
  return text !== null ? text : `[undecodable ${magic} payload, ${declared} bits declared, base64] ${raw.toString("base64")}`;
}

// Find the stealth copy in a PNG's pixels. { } when there is none (or the
// pixels cannot be read: the post-condition refuses those), { refusal } when
// there is one this must not or cannot clear, { idat } -- the new, whole
// image data -- when the alpha copy was cleared and recorded.
function stripStealth(buf, take) {
  const head = pixels.decode(buf, { pixels: STEALTH_MAGIC_BITS });
  if (head.error) return {};
  const rgb = stealthMagics(head, STEALTH_RGB).find((f) => f.stream === "rgb");
  if (rgb) {
    return {
      refusal: {
        why: `The PNG carries a "${rgb.magic}" copy of its generation data in the least significant bits of its COLOUR values ` +
          "(A1111's stealth-pnginfo extension, RGB mode), and clearing it would change the picture's colours",
        fix: "re-save it without the stealth copy (the extension's alpha mode, or off) and post that",
      },
    };
  }
  const hit = stealthMagics(head, STEALTH_ALPHA).find((f) => f.stream === "alpha");
  if (!hit) return {};
  if (head.img.colorType !== 4 && head.img.colorType !== 6) {
    return {
      refusal: {
        why: `The PNG carries a "${hit.magic}" copy of its generation data in the transparency its palette or colour key gives its pixels, ` +
          "which cannot be cleared without changing the picture",
        fix: "re-save it as an RGBA PNG and post that; the tunnel clears the copy from an alpha channel",
      },
    };
  }
  const whole = pixels.decode(buf, { whole: true });
  if (whole.error) {
    return {
      refusal: {
        why: `The PNG carries a "${hit.magic}" copy of its generation data in its pixels' alpha, and ${whole.error}, so it cannot be cleared`,
        fix: "re-save it (smaller, if it is very large) and post that",
      },
    };
  }
  note(take, "png:stealth", stealthPayload(whole, hit.view, hit.magic), STRONG);
  // Every alpha sample's low bit to 1: for 16-bit samples both the byte
  // Pillow reads and the sample's own low bit.
  const { img, data } = whole;
  const size = img.depth >> 3;
  for (const pass of img.passes) {
    for (let r = 0; r < pass.h && pass.w; r++) {
      const line = pass.offset + r * (pass.rowBytes + 1) + 1;
      for (let px = 0; px < pass.w; px++) {
        const a = line + (px * img.channels + img.channels - 1) * size;
        data[a] |= 1;
        if (size === 2) data[a + 1] |= 1;
      }
    }
  }
  return { idat: zlib.deflateSync(pixels.refilter(img, data)) };
}

function stripPng(buf) {
  const { chunks, rest } = pngChunks(buf);
  const texts = [];
  for (const c of chunks) {
    if (c.type !== "tEXt" && c.type !== "zTXt" && c.type !== "iTXt") continue;
    const t = readPngText(c.type, c.data);
    if (t) texts.push({ chunk: c, ...t });
  }
  const first = (k) => { const t = texts.find((x) => x.keyword === k && typeof x.text === "string"); return t ? t.text : ""; };
  const ctx = {
    novelai: isNovelAI(first("Software"), first("Source")),
    easyDiffusion: texts.some((t) => PNG_EASYDIFFUSION_KEYS.includes(t.keyword)),
    comfyUI: ["prompt", "workflow"].some((k) => typeof first(k) === "string" && /"class_type"|"nodes"\s*:/.test(first(k))),
  };

  const take = newTake();
  const drop = new Set();
  const replace = new Map();
  for (const t of texts) {
    const key = pngKey(t.keyword);
    if (t.keyword === PNG_XMP_KEYWORD && t.bytes) {
      const bytes = Buffer.from(t.bytes);
      const verdict = blankXmp(bytes, key, take);
      if (verdict === "whole") drop.add(t.chunk);
      else if (verdict === "changed") replace.set(t.chunk, t.rebuild(bytes));
      continue;
    }
    const profile = RAW_PROFILE.exec(t.keyword);
    if (profile && t.bytes) {
      const kind = profile[1].toLowerCase();
      const out = blankRawProfile(["xmp", "iptc", "8bim"].includes(kind) ? kind : "exif", t, take);
      if (out && out.refusal) return { ...unchanged(buf), refusal: out.refusal };
      if (out === "whole") drop.add(t.chunk);
      else if (out) replace.set(t.chunk, t.rebuild(out));
      if (out) continue;
    }
    const strength = pngStrength(t.keyword, t.text, ctx);
    if (!strength) continue;
    drop.add(t.chunk);
    // A generator's chunk that will not decode still goes. Its bytes are kept
    // for the private record, labelled, rather than lost.
    note(take, key, typeof t.text !== "string"
      ? `[undecodable ${t.chunk.type} chunk, base64] ${t.chunk.data.toString("base64")}`
      : t.keyword.startsWith("exif:") ? demirror(t.text) : t.text, strength);
  }
  // eXIf is a TIFF structure, as in a JPEG (a few writers keep the "Exif\0\0"
  // in front). Blanked in place, then given a fresh CRC.
  for (const c of chunks) {
    if (c.type !== "eXIf") continue;
    const data = Buffer.from(c.data);
    if (blankTiff(data, startsWith(data, EXIF_HEADER) ? EXIF_HEADER.length : 0, data.length, take)) replace.set(c, data);
  }
  // The stealth copy in the pixels: cleared from the alpha, refused in the
  // colours. The new image data goes where the first IDAT was; the rest of
  // the IDAT chunks go, since it is one stream split however a writer liked.
  const stealth = stripStealth(buf, take);
  if (stealth.refusal) return { ...unchanged(buf), refusal: stealth.refusal };
  if (stealth.idat) {
    const idats = chunks.filter((c) => c.type === "IDAT");
    replace.set(idats[0], stealth.idat);
    for (const c of idats.slice(1)) drop.add(c);
  }
  if (!drop.size && !replace.size) return unchanged(buf);
  const parts = [buf.subarray(0, 8)];
  for (const c of chunks) {
    if (drop.has(c)) continue;
    parts.push(replace.has(c) ? pngChunk(c.type, replace.get(c)) : buf.subarray(c.start, c.end));
  }
  // Whatever follows IEND, or a remainder that does not walk as chunks, is
  // copied as it came. The post-condition reads it.
  parts.push(buf.subarray(rest));
  return taken(Buffer.concat(parts), take);
}

// --- JPEG -----------------------------------------------------------------------

// Remove (or, see below, neutralise) the given segments from `out`.
//
// A MULTI-PICTURE JPEG IS NOT CUT. An MPF APP2 (phones write one for depth
// maps and HDR gain maps) records its secondary images by offset and size
// relative to itself, so removing bytes anywhere in the first image moves
// them out from under it. There, a segment is instead neutralised in place:
// relabelled COM with a zeroed payload -- same length, nothing moves, and a
// zero-byte comment carries nothing.
function cutSegments(out, segs, multiPicture) {
  if (!segs.length) return out;
  if (multiPicture) {
    for (const s of segs) { out[s.start + 1] = 0xfe; out.fill(0, s.body, s.end); }
    return out;
  }
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const parts = [];
  let at = 0;
  for (const s of sorted) { parts.push(out.subarray(at, s.start)); at = s.end; }
  parts.push(out.subarray(at));
  return Buffer.concat(parts);
}

// Extended XMP's segment header after the namespace: a 32-byte GUID, the full
// length, then this part's offset.
const XMP_EXT_HEAD = 40;

function stripJpeg(buf) {
  // The marker chain from SOI to the first scan. Past SOS there are no more
  // header segments to read, which is also where prompt-tags stops; what lies
  // beyond is the post-condition's to read.
  const segs = [];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }                                     // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
    if (marker === 0xd9 || marker === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) break;
    segs.push({ start: i, end: i + 2 + len, marker, body: i + 4 });
    i += 2 + len;
  }

  const out = Buffer.from(buf);
  const take = newTake();
  const cut = [];
  const extended = [];
  let changed = false, multiPicture = false, mainXmp = null, refusal = null;
  for (const s of segs) {
    const payload = buf.subarray(s.body, s.end);
    if (s.marker === 0xe1 && startsWith(payload, EXIF_HEADER)) {
      if (blankTiff(out, s.body + EXIF_HEADER.length, s.end, take)) changed = true;
    } else if (s.marker === 0xe1 && startsWith(payload, XMP_STD)) {
      mainXmp = s;
      const verdict = blankXmp(out.subarray(s.body + XMP_STD.length, s.end), "xmp", take);
      if (verdict === "whole") cut.push(s);
      else if (verdict === "changed") changed = true;
    } else if (s.marker === 0xe1 && startsWith(payload, XMP_EXT) && payload.length >= XMP_EXT.length + XMP_EXT_HEAD) {
      extended.push(s);
    } else if (s.marker === 0xfe) {
      const text = payload.toString("utf8");
      if (hasGenerationMarkers(text)) { cut.push(s); note(take, "jpeg:COM", text, STRONG); }
    } else if (s.marker === 0xe2 && startsWith(payload, MPF_HEADER)) {
      multiPicture = true;
    } else if (s.marker === 0xed && startsWith(payload, PHOTOSHOP)) {
      // IPTC, inside Photoshop's resource blocks: blanked in place.
      const r = blankIrbs(out, s.body + PHOTOSHOP.length, s.end, take);
      if (r.changed) changed = true;
      if (!r.ok && hasGenerationMarkers(iptcText(payload))) refusal = iptcRefusal("The JPEG's Photoshop APP13 segment");
    }
  }
  if (refusal) return { ...unchanged(buf), refusal };
  // Extended XMP is the overflow of the main packet: one serialised packet
  // split across segments, identified by the MD5 of the whole of it. Blanking
  // a property in place would change that MD5 and orphan it, so an extension
  // carrying any generation property goes WHOLE, and the main packet's
  // pointer to it (xmpNote:HasExtendedXMP) is emptied with it. An extension
  // whose main packet was cut whole is meaningless and goes too.
  if (extended.length) {
    const parts = extended
      .map((s) => ({ s, off: buf.readUInt32BE(s.body + XMP_EXT.length + 36), data: buf.subarray(s.body + XMP_EXT.length + XMP_EXT_HEAD, s.end) }))
      .sort((a, b) => a.off - b.off);
    const whole = Buffer.concat(parts.map((p) => p.data));
    const probe = newTake();
    const mainGone = mainXmp !== null && cut.includes(mainXmp);
    if (mainGone || blankXmp(Buffer.from(whole), "xmp", probe) !== "unchanged") {
      cut.push(...extended);
      note(take, "xmp", whole.toString("utf8"), probe.confident || mainGone ? STRONG : LOOSE);
      if (mainXmp && !mainGone && blankXmpProperty(out.subarray(mainXmp.body + XMP_STD.length, mainXmp.end), "xmpNote:HasExtendedXMP")) changed = true;
    }
  }
  if (!changed && !cut.length) return unchanged(buf);
  return taken(cutSegments(out, cut, multiPicture), take);
}

// --- WebP -----------------------------------------------------------------------

const VP8X_XMP_FLAG = 0x04;

function stripWebp(buf) {
  const riffSize = buf.readUInt32LE(4);
  const riffEnd = 8 + riffSize;
  const out = Buffer.from(buf);
  const take = newTake();
  const cut = [];
  let changed = false, vp8x = -1, xmpChunks = 0;
  // The whole buffer is walked, not just the RIFF's declared extent: bytes
  // past a short RIFF size are still served, and prompt-tags reads them too.
  let i = 12;
  while (i + 8 <= buf.length) {
    const fourcc = buf.toString("latin1", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const start = i + 8, end = start + size;
    if (end > buf.length) break;
    const next = Math.min(end + (size & 1), buf.length);
    if (fourcc === "VP8X" && size >= 1 && vp8x < 0) vp8x = start;
    else if (fourcc === "EXIF") {
      const tStart = startsWith(buf.subarray(start, end), EXIF_HEADER) ? start + EXIF_HEADER.length : start;
      if (blankTiff(out, tStart, end, take)) changed = true;
    } else if (fourcc === "XMP ") {
      xmpChunks++;
      const verdict = blankXmp(out.subarray(start, end), "webp:xmp", take);
      if (verdict === "whole") cut.push({ start: i, end: next });
      else if (verdict === "changed") changed = true;
    }
    i = next;
  }
  if (!changed && !cut.length) return unchanged(buf);
  if (!cut.length) return taken(out, take);

  const parts = [];
  let at = 0, gone = 0, goneBeforeVp8x = 0;
  for (const c of cut) {
    parts.push(out.subarray(at, c.start));
    at = c.end;
    // Only what was INSIDE the declared RIFF comes off the RIFF size. A chunk
    // a careless writer appended past it was never counted in it.
    if (c.start < riffEnd) gone += Math.min(c.end, riffEnd) - c.start;
    if (c.start < vp8x) goneBeforeVp8x += c.end - c.start;
  }
  parts.push(out.subarray(at));
  const result = Buffer.concat(parts);
  result.writeUInt32LE(riffSize >= gone ? riffSize - gone : result.length - 8, 4);
  // The VP8X header says which optional chunks follow. Claiming an XMP chunk
  // that is no longer there is a malformed file to a strict decoder.
  if (vp8x >= 0 && xmpChunks === cut.length) result[vp8x - goneBeforeVp8x] &= ~VP8X_XMP_FLAG & 0xff;
  return taken(result, take);
}

// --- GIF ------------------------------------------------------------------------

// XMP's "magic trailer" in a GIF: 0x01, then 0xFF down to 0x00, then the block
// terminator. It lets a decoder walk raw XMP as if it were sub-blocks and land
// on the terminator from wherever it enters.
function hasMagicTrailer(buf, end) {
  const t = end - 258;
  if (t < 0 || buf[t] !== 0x01 || buf[end - 1] !== 0x00) return false;
  for (let k = 0; k < 256; k++) if (buf[t + 1 + k] !== 0xff - k) return false;
  return true;
}

// Past a run of sub-blocks starting at p: the index after its terminator, and
// each block's payload range. null when the run leaves the buffer.
function subBlocks(buf, p) {
  const ranges = [];
  while (p < buf.length) {
    const n = buf[p];
    if (n === 0) return { end: p + 1, ranges };
    if (p + 1 + n > buf.length) return null;
    ranges.push([p + 1, p + 1 + n]);
    p += 1 + n;
  }
  return null;
}

// A GIF whose blocks stop walking is REFUSED, never passed through as it
// came: a comment or an XMP block this already found -- or one lying past the
// break, never reached -- would be served, and a decoder that resyncs past a
// stray byte (the booru's libvips does) reads it. So an unfinished walk
// carries a carrier of its own, whatever carriersIn sees.
const GIF_UNWALKED = "blocks past the point where its structure stops making sense, where a comment or XMP cannot be checked";

function stripGif(buf) {
  let i = 13;
  const lsd = buf[10];
  if (lsd & 0x80) i += 3 * (1 << ((lsd & 7) + 1));
  const out = Buffer.from(buf);
  const take = newTake();
  const cut = [];
  let changed = false;
  for (;;) {
    // A GIF that simply ends without its trailer byte walked fine up to here.
    if (i >= buf.length) break;
    const b = buf[i];
    if (b === 0x3b) break;                                                     // trailer
    if (b === 0x2c) {                                                          // an image
      if (i + 10 > buf.length) return unverifiable(buf, "a truncated GIF", [GIF_UNWALKED]);
      const packed = buf[i + 9];
      let p = i + 10;
      if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
      const run = subBlocks(buf, p + 1);                                       // after the LZW code size
      if (!run) return unverifiable(buf, "a truncated GIF", [GIF_UNWALKED]);
      i = run.end;
      continue;
    }
    if (b !== 0x21 || i + 2 > buf.length) return unverifiable(buf, "a GIF that does not walk", [GIF_UNWALKED]);
    const label = buf[i + 1];
    const run = subBlocks(buf, i + 2);
    if (!run) return unverifiable(buf, "a truncated GIF", [GIF_UNWALKED]);
    if (label === 0xfe) {
      // A comment. A1111 and Forge write their whole infotext here when they
      // save a GIF; GIMP writes "Created with GIMP".
      const text = Buffer.concat(run.ranges.map(([s, e]) => buf.subarray(s, e))).toString("utf8");
      const strength = promptStrength(text);
      if (strength) { cut.push({ start: i, end: run.end }); note(take, "gif:Comment", text, strength); }
    } else if (label === 0xff && buf[i + 2] === 11 && buf.toString("latin1", i + 3, i + 14) === GIF_XMP_APP) {
      let verdict;
      if (hasMagicTrailer(buf, run.end)) {
        // Raw XMP, as the spec writes it: blanked in place. Spaces are never a
        // terminator, and every path through the magic trailer still lands on
        // its end, so the walk above stays true.
        verdict = blankXmp(out.subarray(i + 14, run.end - 258), "xmp", take);
      } else {
        // XMP written as ordinary sub-blocks: blanked as one packet, then put
        // back byte for byte into the same blocks -- same length, same walk.
        const blocks = run.ranges.slice(1);
        const packet = Buffer.concat(blocks.map(([s, e]) => buf.subarray(s, e)));
        verdict = blankXmp(packet, "xmp", take);
        let at = 0;
        for (const [s, e] of blocks) { packet.copy(out, s, at, at + (e - s)); at += e - s; }
      }
      if (verdict === "whole") cut.push({ start: i, end: run.end });
      else if (verdict === "changed") changed = true;
    }
    i = run.end;
  }
  if (!changed && !cut.length) return unchanged(buf);
  const parts = [];
  let at = 0;
  for (const c of cut) { parts.push(out.subarray(at, c.start)); at = c.end; }
  // Anything after the trailer is copied as it came; the post-condition reads it.
  parts.push(out.subarray(at));
  return taken(Buffer.concat(parts), take);
}

// --- what cannot be verified ----------------------------------------------------

// Byte signatures of a metadata block, found anywhere in a file this module
// does not parse. Long enough that compressed image data does not produce
// them by chance.
const CARRIER_SIGNATURES = [
  ["an Exif block", Buffer.from("Exif\0\0", "latin1")],
  ["an XMP packet", Buffer.from("<x:xmpmeta", "latin1")],
  ["an XMP packet", Buffer.from("<?xpacket", "latin1")],
  ["an XMP packet", Buffer.from("http://ns.adobe.com/xap/1.0/", "latin1")],
  ["an XMP packet", Buffer.from(GIF_XMP_APP, "latin1")],
  ["a TIFF / EXIF directory", Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08])],
  ["a TIFF / EXIF directory", Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])],
];

// The metadata carriers of an ISO base media file (AVIF, HEIF, JPEG XL's
// container, MP4): an Exif or XMP ITEM, which is where A1111 and Forge put
// the infotext when they save AVIF, or a box that holds free text.
const ISO_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf", "edts", "moof", "traf", "iprp", "ipco"]);
function isoCarriers(buf) {
  const found = [];
  const walk = (start, end, depth) => {
    let p = start;
    while (p + 8 <= end && depth < 8) {
      let size = buf.readUInt32BE(p);
      const type = buf.toString("latin1", p + 4, p + 8);
      let head = 8;
      if (size === 1) {
        if (p + 16 > end) return;
        const big = buf.readBigUInt64BE(p + 8);
        if (big > BigInt(end - p)) return;
        size = Number(big);
        head = 16;
      } else if (size === 0) size = end - p;
      if (size < head || p + size > end) return;
      const body = p + head, boxEnd = p + size;
      if (type === "Exif" || type === "xml " || type === "XMP_") found.push(`an "${type.trim()}" box`);
      else if (type === "uuid") found.push("a uuid box (where XMP and vendors' metadata live)");
      else if (type === "udta") found.push("a udta box (user data: comments, titles)");
      else if (type === "meta") walk(body + 4, boxEnd, depth + 1);                  // FullBox
      else if (type === "iinf" && body + 4 <= boxEnd) walk(body + 4 + (buf[body] === 0 ? 2 : 4), boxEnd, depth + 1);
      else if (type === "infe" && body + 4 <= boxEnd) {
        const version = buf[body];
        let q = body + 4;
        if (version >= 2) {
          q += (version === 2 ? 2 : 4) + 2;                                          // item_ID, protection index
          const itemType = buf.toString("latin1", q, q + 4);
          if (itemType === "Exif") found.push("an Exif item");
          else if (itemType === "mime" || itemType === "uri ") {
            const name = buf.indexOf(0, q + 4);
            const ctEnd = name < 0 ? -1 : buf.indexOf(0, name + 1);
            const contentType = ctEnd > name && ctEnd <= boxEnd ? buf.toString("latin1", name + 1, ctEnd) : "";
            found.push(`an item of type "${contentType || itemType.trim()}"`);
          }
        } else {
          found.push("an item described the old way (infe version 0 or 1)");
        }
      } else if (ISO_CONTAINERS.has(type)) walk(body, boxEnd, depth + 1);
      p = boxEnd;
    }
  };
  walk(0, buf.length, 0);
  return found;
}

// Every metadata carrier this module can see in a file it cannot parse.
function carriersIn(buf) {
  const found = new Set();
  if (buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp") for (const c of isoCarriers(buf)) found.add(c);
  const magic = buf.toString("latin1", 0, 4);
  if (magic === "II*\0" || magic === "MM\0*") found.add("TIFF directories (the file is a TIFF)");
  for (const [label, sig] of CARRIER_SIGNATURES) if (buf.indexOf(sig) >= 0) found.add(label);
  return [...found];
}

function unverifiable(buffer, format, extra = []) {
  return { ...unchanged(buffer), format, carriers: [...carriersIn(buffer), ...extra] };
}

function formatOf(buffer) {
  if (buffer.length >= 12 && buffer.toString("latin1", 4, 8) === "ftyp") {
    return `an ISO media file (brand "${buffer.toString("latin1", 8, 12).replace(/[^\x20-\x7e]/g, "?")}": AVIF, HEIF or video)`;
  }
  const magic = buffer.toString("latin1", 0, 4);
  if (magic === "II*\0" || magic === "MM\0*") return "a TIFF";
  return "an image format the tunnel does not parse";
}

// --- the door -------------------------------------------------------------------

// One pass, no post-condition. The bytes decide the format, not the declared
// type -- the same rule prompt-tags reads by. A format this cannot parse comes
// back unchanged with `carriers`: the metadata blocks it can see, which the
// caller must refuse to post.
function stripOnce(buffer) {
  if (buffer.length < 12) return unchanged(buffer);
  if (buffer.subarray(0, 8).equals(PNG_SIG)) return stripPng(buffer);
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return stripJpeg(buffer);
  if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return stripWebp(buffer);
  const sig = buffer.toString("latin1", 0, 6);
  if (sig === "GIF87a" || sig === "GIF89a") return stripGif(buffer);
  return unverifiable(buffer, formatOf(buffer));
}

// --- the post-condition ---------------------------------------------------------

// 1. MARKERS, ANYWHERE. Text only a generator writes, looked for in every byte
// of the served file. Kept apart from hasGenerationMarkers on purpose: the
// point is a judge the stripper's own classifier cannot drag along with it
// when it is wrong. A JSON key may be backslash-escaped (a graph stored as a
// JSON string inside JSON) and its quotes XML-escaped (JSON inside XMP).
const RESIDUE_MARKERS = [
  ["an A1111 \"Negative prompt:\" line", /Negative prompt:/],
  ["an A1111 settings line", /Steps: ?\d+, ?(?:Sampler|CFG scale|Seed|Size|Model hash|Model):/],
  ["a model hash", /Model hash: ?[0-9a-fA-F]{8}/],
  ["a generator's JSON key", /(?:class_type|widgets_values|sui_image_params|negative_prompt|sampler_name|cfg_scale|noise_schedule|invokeai_metadata)\\?"\s*:/],
  ["a generator's JSON key", /\\?"(?:prompt|uc|workflow)\\?"\s*:/],
  ["a LoRA / embedding token", /<(?:lora|lyco|hypernet|embedding):[^<>\s]{1,200}>/i],
  ["a Midjourney job id", /Job ID:\s*[0-9a-f]{8}-[0-9a-f]{4}-/i],
  ["a Stability Matrix JSON key", /\\?"(?:PositivePrompt|NegativePrompt|CfgScale)\\?"\s*:/],
  ["a Mochi Diffusion prompt label", /(?:Include in Image|Exclude from Image):/],
];

// Bytes as text to scan. NUL bytes are dropped first: ASCII stored as UTF-16,
// in either byte order and at either alignment, then reads as plain ASCII.
function scannable(bytes) {
  const o = Buffer.allocUnsafe(bytes.length);
  let n = 0;
  for (let k = 0; k < bytes.length; k++) { const b = bytes[k]; if (b !== 0) o[n++] = b; }
  const s = o.toString("latin1", 0, n);
  return /&(?:quot|apos|lt|gt|amp|#\d+|#x[0-9a-f]+);/i.test(s) ? xmlUnescape(s) : s;
}

// Every text a reader of this file could get at: the bytes themselves, and in
// a PNG, each compressed text chunk opened and each raw profile's hex read as
// the bytes it spells. A compressed chunk that will not open is reported: it
// cannot be read, so it cannot be cleared.
function renderings(buffer) {
  const out = [{ where: "in the file's bytes", text: scannable(buffer) }];
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIG)) return out;
  let off = 8;
  while (off + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(off);
    const type = buffer.toString("latin1", off + 4, off + 8);
    const end = off + 8 + len;
    if (end > buffer.length) break;
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const t = readPngText(type, buffer.subarray(off + 8, end));
      if (t && !t.bytes && type !== "tEXt") out.push({ where: `in a ${type} chunk ("${t.keyword}") that will not decompress`, unreadable: true });
      if (t && t.bytes) {
        if (type !== "tEXt") out.push({ where: `inside the compressed ${type} chunk "${t.keyword}"`, text: scannable(t.bytes) });
        const profile = readRawProfile(t.bytes);
        if (profile) out.push({ where: `inside the hex of the raw profile "${t.keyword}"`, text: scannable(profile.data) });
      }
    }
    off = end + 4;
    if (type === "IEND") break;
  }
  return out;
}

function markerResidue(buffer) {
  for (const r of renderings(buffer)) {
    if (r.unreadable) return `there is text ${r.where}`;
    for (const [label, re] of RESIDUE_MARKERS) if (re.test(r.text)) return `${label} is still ${r.where}`;
  }
  return null;
}

// 2. WHAT PROMPT-TAGS READS, by prompt-tags' own shapes. Not the stripper's
// classifier: a generator's own PNG chunk present at all, a ComfyUI graph or
// a JSON prompt in the EXIF, or A1111 text with the delimiters prompt-tags
// cuts the prompt at. A camera's ImageDescription is none of these.
function jsonWithPrompt(text) {
  if (typeof text !== "string" || !text.trim().startsWith("{")) return false;
  try { const j = JSON.parse(text); return Boolean(j) && typeof j.prompt === "string"; } catch { return false; }
}
function promptTagsResidue(buffer, contentType) {
  const seen = embeddedChunks(buffer, contentType);
  const has = (k) => Object.prototype.hasOwnProperty.call(seen, k);
  const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIG);
  const exif = !png && ((buffer[0] === 0xff && buffer[1] === 0xd8) || buffer.toString("latin1", 0, 4) === "RIFF");
  if (!exif) {
    for (const k of ["parameters", "prompt", "workflow"]) if (has(k)) return `prompt-tags still reads a generator's own PNG chunk "${k}"`;
    if (jsonWithPrompt(seen.Comment)) return "prompt-tags still reads a JSON prompt out of a PNG \"Comment\" chunk";
    return null;
  }
  if (has("prompt")) return "prompt-tags still reads a ComfyUI graph out of the EXIF";
  if (has("Comment")) return "prompt-tags still reads a JSON prompt out of the EXIF";
  if (typeof seen.parameters === "string" && /\n(?:Negative prompt:|Steps:\s*\d)/.test(seen.parameters)) {
    return "prompt-tags still reads A1111 parameters out of the EXIF";
  }
  return null;
}

// 3. A second pass must find nothing left to take.
function secondPassResidue(buffer) {
  const again = stripOnce(buffer);
  return again.changed ? `a second pass still finds ${Object.keys(again.removed).join(", ")}` : null;
}

// What generation text is still in these bytes, as a sentence, or null.
// 3. THE PIXELS, for a stealth copy. Its own reading of the least significant
// bits -- not the stripper's stealthBytes -- over its own list of signatures:
// all four, in the alpha AND in the colours, in every view of the samples, so
// a copy the stripper looked for in the wrong place is still found. A PNG
// whose first rows will not decode cannot be checked, and is refused: its
// pixels are exactly what a stealth reader would read.
const STEALTH_SIGNATURES = ["stealth_pnginfo", "stealth_pngcomp", "stealth_rgbinfo", "stealth_rgbcomp"];
function stealthResidue(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIG)) return null;
  const dec = pixels.decode(buffer, { pixels: 120 });
  if (dec.error) {
    return {
      why: `The PNG's pixels cannot be read to check them for a hidden copy of generation data: ${dec.error}`,
      fix: "re-save it as a PNG any decoder opens, and post that",
    };
  }
  const { img, data } = dec;
  const count = Math.min(120, img.width * img.height);
  for (const view of pixels.viewsOf(img)) {
    const alpha = [], colour = [];
    for (let p = 0; p < count; p++) {
      const [r, g, b, a] = pixels.lsbAt(img, data, Math.floor(p / img.height), p % img.height, view);
      alpha.push(a);
      colour.push(r, g, b);
    }
    for (const [label, bits] of [["alpha", alpha], ["colour", colour]]) {
      if (bits.length < 120) continue;
      let head = "";
      for (let k = 0; k < 120; k += 8) head += String.fromCharCode(bits.slice(k, k + 8).reduce((v, bit) => (v << 1) | bit, 0));
      if (STEALTH_SIGNATURES.includes(head)) return `a "${head}" signature is still in the ${label} values' least significant bits`;
    }
  }
  return null;
}

// What generation text is still in these bytes, as { why, fix }, or null.
function residueFinding(buffer, contentType) {
  const found = markerResidue(buffer) || promptTagsResidue(buffer, contentType) || stealthResidue(buffer) || secondPassResidue(buffer);
  if (!found) return null;
  return typeof found === "string" ? { why: found } : found;
}

// What generation text is still in these bytes, as a sentence, or null.
function residue(buffer, contentType) {
  const found = residueFinding(buffer, contentType);
  return found ? found.why : null;
}

/**
 * Strip the generation data out of one image, losslessly.
 *
 * @param {Buffer} buffer        the image as it arrived
 * @param {string} [contentType] the declared type; the bytes decide, this is
 *                               only handed on to prompt-tags for its check
 * @returns {{buffer: Buffer, removed: Object<string, string>, changed: boolean, confident: boolean}}
 *   `removed` maps a field key ("png:parameters", "exif:UserComment", "xmp",
 *   "jpeg:COM", "webp:xmp", "gif:Comment", "iptc:Caption-Abstract",
 *   "png:stealth", ...) to the original text. Every key it can produce is
 *   pinned in strip-generation.test.js (TUNNEL_FIELD_KEYS), and the same list
 *   in chanbooru's tests holds the booru to accepting them.
 *   `changed` is false, and `buffer` is the very buffer passed in, when there
 *   was nothing to remove. `confident` is true when something removed was a
 *   generator's own signal (STRONG), not only the shape of a prompt.
 * @throws when generation text survives the strip, when a format this
 *   cannot parse carries a metadata block, when generation data sits where
 *   removing it would change the picture (a stealth copy in the colours) or
 *   cannot be done field by field (IPTC that will not parse), or when a PNG's
 *   pixels cannot be read to check them. Nothing may be posted then; each
 *   message names its own fix.
 */
function stripGeneration(buffer, contentType) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("stripGeneration needs the image bytes as a Buffer");
  const result = stripOnce(buffer);
  if (result.carriers && result.carriers.length) {
    throw new Error(
      `${result.format} cannot be checked for generation data here, and this one carries ${result.carriers.join(", ")}. ` +
      "The image was NOT posted and stays in Matrix. Fix: re-save it as PNG, JPEG, WebP or GIF (the tunnel strips those " +
      "losslessly) and post that, or teach strip-generation.js this container, then re-run !backfill in the room.",
    );
  }
  if (result.refusal) {
    throw new Error(`${result.refusal.why}. The image was NOT posted and stays in Matrix. Fix: ${result.refusal.fix}.`);
  }
  const left = residueFinding(result.buffer, contentType);
  if (left) {
    // A finding with a fix of its own is a check that could not be made, not
    // text that survived; it says so, and says what to do instead.
    throw new Error(
      `${left.fix ? "" : "generation data survived the strip: "}${left.why}. The image was NOT posted and stays in Matrix. ` +
      `Fix: ${left.fix || "teach strip-generation.js this embedding, then re-run !backfill in the room (or repost the image)"}.`,
    );
  }
  return { buffer: result.buffer, removed: result.removed, changed: result.changed, confident: result.confident };
}

module.exports = {
  stripGeneration,
  stripOnce,
  residue,
  markerResidue,
  promptTagsResidue,
  stealthResidue,
  carriersIn,
  hasGenerationMarkers,
  looksLikePrompt,
  promptStrength,
  demirror,
  crc32,
  PNG_GENERATOR_KEYS,
  NONE,
  LOOSE,
  STRONG,
};
