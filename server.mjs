// DM-2026 backend — Cloud Run (Node 20 + Express)
// Image Mode: OpenAI GPT Image (gpt-image-1) — cheaper + stable framing (square) + color/shading prompt
// Video Mode: Replicate wan-2.2-i2v-fast (UNCHANGED)
//
// Endpoints (DO NOT CHANGE):
//   GET  /, /health, /me
//   POST /magic          (multipart: image + styleId) -> { ok:true, id }
//   GET  /magic/status   -> { ok:true, status, outputUrl, error }
//   GET  /magic/result   -> image bytes
//   POST /video/start    (multipart: image + optional prompt) -> { ok:true, id }
//   GET  /video/status   -> { ok:true, status, outputUrl, error }

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "server.mjs DM-2026 SD+OpenAI v1.0";

const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

// ---------- ENV ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1024"; // keep square to reduce reframing
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "medium"; // low|medium|high
const OPENAI_OUTPUT_FORMAT = process.env.OPENAI_OUTPUT_FORMAT || "png"; // png|jpeg|webp


// Image provider for /magic: "openai" (default) or "replicate"
const IMAGE_PROVIDER = (process.env.IMAGE_PROVIDER || "openai").toLowerCase();

// Replicate (Image) — Stable Diffusion / SDXL (cheap, preserves composition with low strength)
const REPLICATE_IMAGE_OWNER = process.env.REPLICATE_IMAGE_OWNER || "stability-ai";
const REPLICATE_IMAGE_MODEL = process.env.REPLICATE_IMAGE_MODEL || "sdxl";
const REPLICATE_IMAGE_VERSION = process.env.REPLICATE_IMAGE_VERSION || ""; // optional pinned version
const SD_PROMPT_STRENGTH = parseFloat(process.env.SD_PROMPT_STRENGTH || "0.38"); // 0.25–0.5
const SD_GUIDANCE_SCALE = parseFloat(process.env.SD_GUIDANCE_SCALE || "7");
const SD_STEPS = parseInt(process.env.SD_STEPS || "20", 10);
const SD_NEGATIVE_PROMPT = process.env.SD_NEGATIVE_PROMPT || "blurry, low quality, distorted, extra objects, text, watermark, logo";
const SD_FRAMELOCK_SCALE = parseFloat(process.env.SD_FRAMELOCK_SCALE || "0.84"); // 0.75–0.9 (lower => more padding)
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_VIDEO_OWNER = process.env.REPLICATE_VIDEO_OWNER || "wan-video";
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_VIDEO_MODEL || "wan-2.2-i2v-fast";
const REPLICATE_VIDEO_VERSION = process.env.REPLICATE_VIDEO_VERSION || "";

const VIDEO_INPUT_KEY = process.env.VIDEO_INPUT_KEY || "image";
const VIDEO_PROMPT_KEY = process.env.VIDEO_PROMPT_KEY || "prompt";
const VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || "480p";
const VIDEO_FPS = parseInt(process.env.VIDEO_FPS || "16", 10);
const VIDEO_NUM_FRAMES = parseInt(process.env.VIDEO_NUM_FRAMES || "81", 10);
const VIDEO_GO_FAST = (process.env.VIDEO_GO_FAST || "true").toLowerCase() === "true";
const VIDEO_INTERPOLATE = (process.env.VIDEO_INTERPOLATE || "false").toLowerCase() === "true";

const STYLE_PROMPTS_JSON = process.env.STYLE_PROMPTS_JSON || "";

// In-memory async jobs for /magic
const MAGIC_TTL_MS = parseInt(process.env.MAGIC_TTL_MS || String(60 * 60 * 1000), 10);
const MAGIC_MAX_BYTES = parseInt(process.env.MAGIC_MAX_BYTES || String(10 * 1024 * 1024), 10);
const magicJobs = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------- Helpers ----------
function now() { return Date.now(); }

function cleanupMagicJobs() {
  const t = now();
  for (const [id, job] of magicJobs.entries()) {
    if (!job?.createdAt || t - job.createdAt > MAGIC_TTL_MS) magicJobs.delete(id);
  }
}
try { const timer = setInterval(cleanupMagicJobs, 30 * 1000); timer?.unref?.(); } catch {}

function mustBeOkOpenAI(res) {
  if (!OPENAI_API_KEY) { res.status(500).json({ ok:false, error:"OPENAI_API_KEY is not set" }); return false; }
  return true;
}


function mustBeOkReplicate(res) {
  if (!REPLICATE_API_TOKEN) {
    res.status(500).json({ ok:false, error:"Missing REPLICATE_API_TOKEN" });
    return false;
  }
  return true;
}

function mustBeOkReplicate(res) {
  if (!REPLICATE_API_TOKEN) { res.status(500).json({ ok:false, error:"REPLICATE_API_TOKEN is not set" }); return false; }
  return true;
}

function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.get("host") || "").toString().split(",")[0].trim();
  return `${proto}://${host}`;
}

function normalizeOutputUrl(output) {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length) {
    const first = output[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") return first.url || first.output || null;
  }
  if (output && typeof output === "object") return output.url || null;
  return null;
}

function bufferToDataUri(buf, mime) {
  const safeMime = mime && mime.includes("/") ? mime : "image/png";
  const base64 = Buffer.from(buf).toString("base64");
  return `data:${safeMime};base64,${base64}`;
}

function getStylePrompt(styleId) {
  // Goal: keep the SAME framing/margins; avoid "cropped top/bottom" feeling.
  const base =
    "Redraw this child's drawing as a premium, colorful illustration for a kids iOS app. " +
    "CRITICAL STRUCTURE 1:1: keep the SAME composition, pose, proportions, shapes, and relative positions. " +
    "CRITICAL FRAMING 1:1: keep the entire original drawing fully visible with the SAME margins/padding; " +
    "do NOT crop, do NOT zoom, do NOT reframe, do NOT shift the subject up/down; keep top and bottom margins consistent. " +
    "Do NOT add new objects. Do NOT remove objects. " +
    "Make it look expensive: clean crisp lines (not thick outline-only), smooth color fills, gentle soft shading, subtle highlights. " +
    "Keep it fully colored (no monochrome line-art), no paper texture, no scan artifacts, no noise, no blur.";

  const neg =
    "monochrome, line art only, black and white, sketch only, text, letters, numbers, watermark, logo, border, frame, " +
    "crop, zoom, reframe, shifted composition, extra objects, different pose, different composition, photorealistic, paper texture, noise";

  let extra = "";
  if (STYLE_PROMPTS_JSON) {
    try {
      const map = JSON.parse(STYLE_PROMPTS_JSON);
      if (map && typeof map === "object" && styleId && map[styleId]) extra = String(map[styleId]);
    } catch {}
  } else if (styleId) {
    extra = `Style hint: ${styleId}.`;
  }

  return `${base} ${extra}\n\nAvoid: ${neg}`.trim();
}

// ---------- OpenAI lazy loader (client + toFile) ----------
let _OpenAI = null;
let _toFile = null;
let _sharp = null;

async function loadOpenAI() {
  if (_OpenAI && _toFile) return;
  const mod = await import("openai");
  _OpenAI = mod.default;
  if (mod.toFile) { _toFile = mod.toFile; return; }
  const up = await import("openai/uploads");
  _toFile = up.toFile;
}

async function loadSharp() {
  if (_sharp) return;
  const mod = await import("sharp");
  _sharp = mod.default || mod;
}

async function getOpenAIClient() {
  await loadOpenAI();
  return new _OpenAI({ apiKey: OPENAI_API_KEY });
}

async function toPngBufferMax1024(inputBuf) {
  await loadSharp();
  // Keep aspect ratio; do NOT enlarge; max dimension 1024 to preserve framing better than 512.
  return await _sharp(inputBuf)
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}


async function makeFrameLockedSquare1024(pngBuf, scale=0.84) {
  // Returns a 1024x1024 PNG that contains the original image (contain) over a blurred background.
  // This dramatically reduces "zoom/crop" tendencies in generative models.
  await loadSharp();
  const base = _sharp(pngBuf);
  const meta = await base.metadata();
  const w = Number(meta?.width || 1024);
  const h = Number(meta?.height || 1024);

  // Foreground: contain to a smaller box (scale of 1024)
  const fgSize = Math.max(256, Math.round(1024 * Math.min(0.95, Math.max(0.55, scale))));
  const fg = await _sharp(pngBuf)
    .resize({ width: fgSize, height: fgSize, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();

  // Background: cover 1024 + blur
  const bg = await _sharp(pngBuf)
    .resize({ width: 1024, height: 1024, fit: "cover" })
    .blur(18)
    .modulate({ brightness: 1.05, saturation: 1.05 })
    .png()
    .toBuffer();

  // Center composite
  const left = Math.round((1024 - Math.min(1024, Math.round((w/h) >= 1 ? fgSize : fgSize))) / 2);
  // We'll use composite gravity center, so left/top not needed.
  const out = await _sharp(bg)
    .composite([{ input: fg, gravity: "center" }])
    .png()
    .toBuffer();

  return out;
}

function bufferToDataUriPng(buf) {
  return `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
}

async function bufferToOpenAIFile(buf, filename, mime) {
  await loadOpenAI();
  return await _toFile(buf, filename, { type: mime });
}

async function fetchBytesFromUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to download OpenAI image URL: ${r.status} ${r.statusText}`);
  const arr = await r.arrayBuffer();
  return Buffer.from(arr);
}

// ---------- OpenAI image pipeline ----------
async function runOpenAIImageMagic({ jobId, file, styleId }) {
  try {
    const client = await getOpenAIClient();
    const prompt = getStylePrompt(styleId);

    // Convert input to PNG and cap max dimension to 1024 (cheaper than raw, but preserves framing better than 512)
    const pngBuf = await toPngBufferMax1024(file.buffer);
    const openaiImage = await bufferToOpenAIFile(pngBuf, "input.png", "image/png");

    const result = await client.images.edit({
      model: OPENAI_IMAGE_MODEL,          // gpt-image-1 or gpt-image-1-mini
      image: openaiImage,
      prompt,
      size: OPENAI_IMAGE_SIZE,            // keep 1024x1024 for stable framing
      quality: OPENAI_IMAGE_QUALITY,      // low|medium|high
      output_format: OPENAI_OUTPUT_FORMAT // png|jpeg|webp
    });

    const item = result?.data?.[0];
    let bytes = null;
    if (item?.b64_json) bytes = Buffer.from(item.b64_json, "base64");
    else if (item?.url) bytes = await fetchBytesFromUrl(item.url);

    if (!bytes || !bytes.length) throw new Error("OpenAI returned no image data (missing b64_json and url)");
    if (bytes.length > MAGIC_MAX_BYTES) throw new Error(`Image too large (${bytes.length} bytes)`);

    const mime =
      OPENAI_OUTPUT_FORMAT === "jpeg" ? "image/jpeg" :
      OPENAI_OUTPUT_FORMAT === "webp" ? "image/webp" :
      "image/png";

    magicJobs.set(jobId, { status:"succeeded", mime, bytes, error:null, createdAt: now() });
  } catch (e) {
    magicJobs.set(jobId, { status:"failed", mime:null, bytes:null, error:String(e?.message || e), createdAt: now() });
  }
}


async function runReplicateImageMagic({ jobId, file, styleId }) {
  try {
    if (!REPLICATE_API_TOKEN) throw new Error("Missing REPLICATE_API_TOKEN");

    const promptBase = getStylePrompt(styleId);
    const framingGuard = "Preserve the full original drawing and composition. Do NOT zoom in. Do NOT crop. Do NOT move objects. Do NOT add new objects.";
    const prompt = `${promptBase}\n\n${framingGuard}`;

    // Convert input to PNG max 1024, then frame-lock into 1024x1024 square to prevent crop/zoom.
    const pngBuf = await toPngBufferMax1024(file.buffer);
    const locked = await makeFrameLockedSquare1024(pngBuf, SD_FRAMELOCK_SCALE);
    const image = bufferToDataUriPng(locked);

    const input = {
      prompt,
      negative_prompt: SD_NEGATIVE_PROMPT,
      image,
      prompt_strength: SD_PROMPT_STRENGTH,
      guidance_scale: SD_GUIDANCE_SCALE,
      num_inference_steps: SD_STEPS,
      width: 1024,
      height: 1024,
      num_outputs: 1
    };

    const pred = await replicateCreatePrediction({
      owner: REPLICATE_IMAGE_OWNER,
      model: REPLICATE_IMAGE_MODEL,
      version: REPLICATE_IMAGE_VERSION || undefined,
      input
    });

    // Poll Replicate until done
    let cur = pred;
    const t0 = Date.now();
    while (true) {
      const status = cur?.status;
      if (status === "succeeded") break;
      if (status === "failed" || status === "canceled") {
        throw new Error(cur?.error || `Replicate image failed (${status})`);
      }
      if (Date.now() - t0 > 120_000) throw new Error("Replicate image timeout");
      await sleep(900);
      cur = await replicateGetPrediction(cur.id);
    }

    // Output is usually a URL or array of URLs
    const outUrl = Array.isArray(cur?.output) ? cur.output[0] : cur?.output;
    if (!outUrl || typeof outUrl !== "string") throw new Error("Replicate image: missing output URL");

    const r = await fetch(outUrl);
    if (!r.ok) throw new Error(`Failed to download image output (${r.status})`);
    const mime = r.headers.get("content-type") || "image/png";
    const bytes = Buffer.from(await r.arrayBuffer());

    magicJobs.set(jobId, { status:"succeeded", mime, bytes, error:null, createdAt: now() });
  } catch (e) {
    magicJobs.set(jobId, { status:"failed", mime:null, bytes:null, error:String(e?.message || e), createdAt: now() });
  }
}

// ---------- Replicate API (Video) ----------
async function replicateCreatePrediction({ owner, model, version, input }) {
  const body = version ? { version, input } : { model: `${owner}/${model}`, input };
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method:"POST",
    headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}`, "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.detail || json?.error || r.statusText || "Replicate error");
  return json;
}
async function replicateGetPrediction(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(id)}`, {
    headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}` },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.detail || json?.error || r.statusText || "Replicate error");
  return json;
}

// ---------- Routes ----------
app.get("/", (_req,res)=>res.status(200).send("DM-2026 backend: ok"));

app.get("/health", (_req,res)=>res.status(200).json({
  ok:true,
  openaiKey:Boolean(OPENAI_API_KEY),
  replicateKey:Boolean(REPLICATE_API_TOKEN),
}));

app.get("/me", (_req,res)=>res.status(200).json({
  version: VERSION,
  ok:true,
  image:{ provider: IMAGE_PROVIDER, openai:{ model:OPENAI_IMAGE_MODEL, size:OPENAI_IMAGE_SIZE, quality: OPENAI_IMAGE_QUALITY, output_format: OPENAI_OUTPUT_FORMAT }, replicate:{ owner:REPLICATE_IMAGE_OWNER, model:REPLICATE_IMAGE_MODEL, versionPinned:Boolean(REPLICATE_IMAGE_VERSION), prompt_strength: SD_PROMPT_STRENGTH, steps: SD_STEPS } },
  video:{ provider:"replicate", owner:REPLICATE_VIDEO_OWNER, model:REPLICATE_VIDEO_MODEL, versionPinned:Boolean(REPLICATE_VIDEO_VERSION) },
}));

// POST /magic
app.post("/magic", upload.single("image"), async (req,res)=>{
  try {
        const provider = ((req.body?.provider || IMAGE_PROVIDER || "openai").toString().toLowerCase());
    if (provider === "replicate") {
      if (!mustBeOkReplicate(res)) return;
    } else {
      if (!mustBeOkOpenAI(res)) return;
    }
    const styleId = (req.body?.styleId || "").toString().trim();
    const file = req.file;
    if (!file?.buffer || file.buffer.length < 10) return res.status(400).json({ ok:false, error:"Missing image" });

    const id = `m_${crypto.randomUUID()}`;
    magicJobs.set(id, { status:"processing", createdAt: now() });
    if (provider === "replicate") {
      runReplicateImageMagic({ jobId:id, file, styleId }); // async
    } else {
      runOpenAIImageMagic({ jobId:id, file, styleId }); // async
    }
    return res.status(200).json({ ok:true, id });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// GET /magic/status
app.get("/magic/status", (req,res)=>{
  const id = (req.query?.id || "").toString().trim();
  if (!id) return res.status(400).json({ ok:false, error:"Missing id" });

  const job = magicJobs.get(id);
  if (!job) return res.status(200).json({ ok:true, status:"failed", outputUrl:null, error:"Unknown id or expired" });

  const status = job.status || "unknown";
  const outputUrl = status === "succeeded" ? `${getBaseUrl(req)}/magic/result?id=${encodeURIComponent(id)}` : null;
  return res.status(200).json({ ok:true, status, outputUrl, error: job.error || null });
});

// GET /magic/result
app.get("/magic/result", (req,res)=>{
  const id = (req.query?.id || "").toString().trim();
  if (!id) return res.status(400).send("Missing id");
  const job = magicJobs.get(id);
  if (!job) return res.status(404).send("Not found");
  if (job.status !== "succeeded" || !job.bytes) return res.status(409).send(job.error || "Not ready");

  res.setHeader("Content-Type", job.mime || "image/png");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(job.bytes);
});

// POST /video/start
app.post("/video/start", upload.single("image"), async (req,res)=>{
  try {
    if (!mustBeOkReplicate(res)) return;
    const file = req.file;
    if (!file?.buffer || file.buffer.length < 10) return res.status(400).json({ ok:false, error:"Missing image" });

    const prompt = `
This is a child’s hand-drawn picture.

Animate ONLY the objects that already exist in the drawing.
Do NOT add any new objects.
Do NOT remove anything.
Do NOT change composition, framing, proportions, or camera angle.
No zoom. No camera movement.

Preserve the original structure 1:1.
Keep all shapes and positions exactly the same.

Bring the drawing to life in a premium Pixar-style animation:

• Add soft dimensional lighting and gentle depth
• Subtle shadows consistent with drawn light sources
• Smooth, high-quality motion with natural easing
• Each existing object moves logically and expressively
• Water flows smoothly
• Clouds drift softly
• Sun rays shimmer gently
• Flags or sails react to invisible wind
• Small ambient motion everywhere

STRICTLY no new objects or details.
Loop-friendly. Smooth. Clean.
`;

    const dataUri = bufferToDataUri(file.buffer, file.mimetype);
    const input = {
      [VIDEO_INPUT_KEY]: dataUri,
      [VIDEO_PROMPT_KEY]: prompt,
      resolution: VIDEO_RESOLUTION,
      frames_per_second: VIDEO_FPS,
      num_frames: VIDEO_NUM_FRAMES,
      go_fast: VIDEO_GO_FAST,
      interpolate: VIDEO_INTERPOLATE,
    };

    const prediction = await replicateCreatePrediction({
      owner: REPLICATE_VIDEO_OWNER,
      model: REPLICATE_VIDEO_MODEL,
      version: REPLICATE_VIDEO_VERSION || undefined,
      input,
    });

    return res.status(200).json({ ok:true, id: prediction.id });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// GET /video/status
app.get("/video/status", async (req,res)=>{
  try {
    if (!mustBeOkReplicate(res)) return;
    const id = (req.query?.id || "").toString().trim();
    if (!id) return res.status(400).json({ ok:false, error:"Missing id" });

    const p = await replicateGetPrediction(id);
    const status = p?.status || "unknown";
    const outputUrl = status === "succeeded" ? normalizeOutputUrl(p?.output) : null;
    return res.status(200).json({ ok:true, status, outputUrl, error: p?.error || null });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ DM-2026 backend listening on http://0.0.0.0:${PORT}`);
});
