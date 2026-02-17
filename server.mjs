// DM-2026 backend — Cloud Run (Node 20 + Express)
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

const VERSION = "server.mjs DM-2026 STARTUP_FIXED v1.0 (openai+replicate img, replicate video)";
const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 8080);

// ---------- ENV ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1024";
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "medium"; // low|medium|high
const OPENAI_OUTPUT_FORMAT = process.env.OPENAI_OUTPUT_FORMAT || "png"; // png|jpeg|webp

const IMAGE_PROVIDER = (process.env.IMAGE_PROVIDER || "openai").toLowerCase(); // openai|replicate

// Replicate (shared token)
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";

// Replicate Image (SD/SDXL)
const REPLICATE_IMAGE_OWNER = process.env.REPLICATE_IMAGE_OWNER || "stability-ai";
const REPLICATE_IMAGE_MODEL = process.env.REPLICATE_IMAGE_MODEL || "sdxl";
const REPLICATE_IMAGE_VERSION = process.env.REPLICATE_IMAGE_VERSION || ""; // optional pinned version
const SD_PROMPT_STRENGTH = Number(process.env.SD_PROMPT_STRENGTH || 0.38); // 0.25–0.5
const SD_GUIDANCE_SCALE = Number(process.env.SD_GUIDANCE_SCALE || 7);
const SD_STEPS = Number(process.env.SD_STEPS || 18);
const SD_NEGATIVE_PROMPT =
  process.env.SD_NEGATIVE_PROMPT ||
  "blurry, low quality, distorted, extra objects, text, watermark, logo, frame";
const SD_FRAMELOCK_SCALE = Number(process.env.SD_FRAMELOCK_SCALE || 0.84); // lower => more padding (0.75–0.9)

// Replicate Video (wan)
const REPLICATE_VIDEO_OWNER = process.env.REPLICATE_VIDEO_OWNER || "wan-video";
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_VIDEO_MODEL || "wan-2.2-i2v-fast";
const REPLICATE_VIDEO_VERSION = process.env.REPLICATE_VIDEO_VERSION || "";

const VIDEO_INPUT_KEY = process.env.VIDEO_INPUT_KEY || "image";
const VIDEO_PROMPT_KEY = process.env.VIDEO_PROMPT_KEY || "prompt";
const VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || "480p";
const VIDEO_FPS = Number(process.env.VIDEO_FPS || 16);
const VIDEO_NUM_FRAMES = Number(process.env.VIDEO_NUM_FRAMES || 81);
const VIDEO_GO_FAST = String(process.env.VIDEO_GO_FAST || "true").toLowerCase() === "true";
const VIDEO_INTERPOLATE = String(process.env.VIDEO_INTERPOLATE || "false").toLowerCase() === "true";

// Styles (optional JSON map)
const STYLE_PROMPTS_JSON = process.env.STYLE_PROMPTS_JSON || "";

// In-memory async jobs for /magic
const MAGIC_TTL_MS = Number(process.env.MAGIC_TTL_MS || 60 * 60 * 1000);
const MAGIC_MAX_BYTES = Number(process.env.MAGIC_MAX_BYTES || 10 * 1024 * 1024);
const magicJobs = new Map();

// ---------- Upload ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------- Tiny utils ----------
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanupMagicJobs() {
  const t = now();
  for (const [id, job] of magicJobs.entries()) {
    if (!job?.createdAt || t - job.createdAt > MAGIC_TTL_MS) magicJobs.delete(id);
  }
}
try {
  const timer = setInterval(cleanupMagicJobs, 30_000);
  timer?.unref?.();
} catch {}

function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.get("host") || "").toString().split(",")[0].trim();
  return `${proto}://${host}`;
}

function normalizeOutputUrl(output) {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length) return typeof output[0] === "string" ? output[0] : (output[0]?.url || null);
  if (typeof output === "object") return output.url || null;
  return null;
}

function bufferToDataUri(buf, mime) {
  const safeMime = mime && mime.includes("/") ? mime : "image/png";
  return `data:${safeMime};base64,${Buffer.from(buf).toString("base64")}`;
}

function bufferToDataUriPng(buf) {
  return `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
}

function mustBeOkOpenAI(res) {
  if (!OPENAI_API_KEY) {
    res.status(500).json({ ok: false, error: "OPENAI_API_KEY is not set" });
    return false;
  }
  return true;
}
function mustBeOkReplicate(res) {
  if (!REPLICATE_API_TOKEN) {
    res.status(500).json({ ok: false, error: "REPLICATE_API_TOKEN is not set" });
    return false;
  }
  return true;
}

function getStylePrompt(styleId) {
  const base =
    "Redraw this child's drawing as a premium colorful illustration for a kids iOS app. " +
    "CRITICAL STRUCTURE 1:1: keep the same composition, shapes, and relative positions. " +
    "CRITICAL: Do NOT add new objects. Do NOT remove objects. " +
    "Make it look expensive: clean crisp lines, smooth color fills, gentle soft shading, subtle highlights. " +
    "No paper texture, no scan artifacts, no noise, no blur. " +
    "Avoid zoom/crop/reframe; keep the full drawing visible.";
  let extra = "";
  if (STYLE_PROMPTS_JSON) {
    try {
      const map = JSON.parse(STYLE_PROMPTS_JSON);
      if (map && typeof map === "object" && styleId && map[styleId]) extra = String(map[styleId]);
    } catch {}
  } else if (styleId) {
    extra = `Style hint: ${styleId}.`;
  }
  return `${base} ${extra}`.trim();
}

// ---------- Lazy loaders ----------
let _OpenAI = null;
let _toFile = null;
let _sharp = null;

async function loadOpenAI() {
  if (_OpenAI && _toFile) return;
  const mod = await import("openai");
  _OpenAI = mod.default;
  if (mod.toFile) {
    _toFile = mod.toFile;
    return;
  }
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

async function bufferToOpenAIFile(buf, filename, mime) {
  await loadOpenAI();
  return await _toFile(buf, filename, { type: mime });
}

async function toPngBufferMax1024(inputBuf) {
  await loadSharp();
  return await _sharp(inputBuf)
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

async function makeFrameLockedSquare1024(pngBuf, scale = 0.84) {
  // 1024x1024 blur background + centered contain foreground.
  await loadSharp();
  const fgSize = Math.max(256, Math.round(1024 * Math.min(0.95, Math.max(0.55, scale))));
  const fg = await _sharp(pngBuf)
    .resize({ width: fgSize, height: fgSize, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const bg = await _sharp(pngBuf)
    .resize({ width: 1024, height: 1024, fit: "cover" })
    .blur(18)
    .modulate({ brightness: 1.05, saturation: 1.05 })
    .png()
    .toBuffer();
  return await _sharp(bg).composite([{ input: fg, gravity: "center" }]).png().toBuffer();
}

async function fetchBytesFromUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to download image URL: ${r.status} ${r.statusText}`);
  return Buffer.from(await r.arrayBuffer());
}

// ---------- OpenAI magic ----------
async function runOpenAIImageMagic({ jobId, file, styleId }) {
  try {
    const client = await getOpenAIClient();
    const prompt = getStylePrompt(styleId);

    const pngBuf = await toPngBufferMax1024(file.buffer);
    const openaiImage = await bufferToOpenAIFile(pngBuf, "input.png", "image/png");

    const result = await client.images.edit({
      model: OPENAI_IMAGE_MODEL,
      image: openaiImage,
      prompt,
      size: OPENAI_IMAGE_SIZE,
      quality: OPENAI_IMAGE_QUALITY,
      output_format: OPENAI_OUTPUT_FORMAT,
    });

    const item = result?.data?.[0];
    let bytes = null;
    if (item?.b64_json) bytes = Buffer.from(item.b64_json, "base64");
    else if (item?.url) bytes = await fetchBytesFromUrl(item.url);

    if (!bytes?.length) throw new Error("OpenAI returned no image data");
    if (bytes.length > MAGIC_MAX_BYTES) throw new Error(`Image too large (${bytes.length} bytes)`);

    const mime =
      OPENAI_OUTPUT_FORMAT === "jpeg" ? "image/jpeg" :
      OPENAI_OUTPUT_FORMAT === "webp" ? "image/webp" :
      "image/png";

    magicJobs.set(jobId, { status: "succeeded", mime, bytes, error: null, createdAt: now() });
  } catch (e) {
    magicJobs.set(jobId, { status: "failed", mime: null, bytes: null, error: String(e?.message || e), createdAt: now() });
  }
}

// ---------- Replicate API helpers ----------
async function replicateCreatePrediction({ owner, model, version, input }) {
  const body = version ? { version, input } : { model: `${owner}/${model}`, input };
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.detail || json?.error || r.statusText || "Replicate error");
  return json;
}

async function replicateGetPrediction(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.detail || json?.error || r.statusText || "Replicate error");
  return json;
}

// ---------- Replicate image magic (SDXL/SD) ----------
async function runReplicateImageMagic({ jobId, file, styleId }) {
  try {
    const promptBase = getStylePrompt(styleId);
    const prompt = `${promptBase}\n\nPreserve full composition. Do not zoom/crop/reframe. Do not add objects.`;
    const pngBuf = await toPngBufferMax1024(file.buffer);
    const locked = await makeFrameLockedSquare1024(pngBuf, SD_FRAMELOCK_SCALE);

    const input = {
      prompt,
      negative_prompt: SD_NEGATIVE_PROMPT,
      image: bufferToDataUriPng(locked),
      prompt_strength: SD_PROMPT_STRENGTH,
      guidance_scale: SD_GUIDANCE_SCALE,
      num_inference_steps: SD_STEPS,
      width: 1024,
      height: 1024,
      num_outputs: 1,
    };

    const pred = await replicateCreatePrediction({
      owner: REPLICATE_IMAGE_OWNER,
      model: REPLICATE_IMAGE_MODEL,
      version: REPLICATE_IMAGE_VERSION || undefined,
      input,
    });

    let cur = pred;
    const t0 = Date.now();
    while (true) {
      const status = cur?.status;
      if (status === "succeeded") break;
      if (status === "failed" || status === "canceled") throw new Error(cur?.error || `Replicate image failed (${status})`);
      if (Date.now() - t0 > 120_000) throw new Error("Replicate image timeout");
      await sleep(900);
      cur = await replicateGetPrediction(cur.id);
    }

    const outUrl = Array.isArray(cur?.output) ? cur.output[0] : cur?.output;
    if (!outUrl || typeof outUrl !== "string") throw new Error("Replicate image missing output URL");

    const r = await fetch(outUrl);
    if (!r.ok) throw new Error(`Failed to download image output (${r.status})`);
    const mime = r.headers.get("content-type") || "image/png";
    const bytes = Buffer.from(await r.arrayBuffer());

    if (!bytes?.length) throw new Error("Empty output bytes");
    if (bytes.length > MAGIC_MAX_BYTES) throw new Error(`Image too large (${bytes.length} bytes)`);

    magicJobs.set(jobId, { status: "succeeded", mime, bytes, error: null, createdAt: now() });
  } catch (e) {
    magicJobs.set(jobId, { status: "failed", mime: null, bytes: null, error: String(e?.message || e), createdAt: now() });
  }
}

// ---------- Routes ----------
app.get("/", (_req, res) => res.status(200).send("DM-2026 backend: ok"));

app.get("/health", (_req, res) =>
  res.status(200).json({ ok: true, openaiKey: Boolean(OPENAI_API_KEY), replicateKey: Boolean(REPLICATE_API_TOKEN) })
);

app.get("/me", (_req, res) =>
  res.status(200).json({
    ok: true,
    version: VERSION,
    image: {
      provider: IMAGE_PROVIDER,
      openai: { model: OPENAI_IMAGE_MODEL, size: OPENAI_IMAGE_SIZE, quality: OPENAI_IMAGE_QUALITY, output_format: OPENAI_OUTPUT_FORMAT, key: Boolean(OPENAI_API_KEY) },
      replicate: { owner: REPLICATE_IMAGE_OWNER, model: REPLICATE_IMAGE_MODEL, versionPinned: Boolean(REPLICATE_IMAGE_VERSION), prompt_strength: SD_PROMPT_STRENGTH, steps: SD_STEPS, key: Boolean(REPLICATE_API_TOKEN) },
    },
    video: { provider: "replicate", owner: REPLICATE_VIDEO_OWNER, model: REPLICATE_VIDEO_MODEL, versionPinned: Boolean(REPLICATE_VIDEO_VERSION) },
  })
);

// POST /magic
app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    const provider = String(req.body?.provider || IMAGE_PROVIDER || "openai").toLowerCase();
    if (provider === "replicate") {
      if (!mustBeOkReplicate(res)) return;
    } else {
      if (!mustBeOkOpenAI(res)) return;
    }

    const file = req.file;
    if (!file?.buffer || file.buffer.length < 10) return res.status(400).json({ ok: false, error: "Missing image" });

    const styleId = String(req.body?.styleId || "").trim();
    const id = `m_${crypto.randomUUID()}`;

    magicJobs.set(id, { status: "processing", createdAt: now() });

    if (provider === "replicate") runReplicateImageMagic({ jobId: id, file, styleId });
    else runOpenAIImageMagic({ jobId: id, file, styleId });

    return res.status(200).json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /magic/status
app.get("/magic/status", (req, res) => {
  const id = String(req.query?.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

  const job = magicJobs.get(id);
  if (!job) return res.status(200).json({ ok: true, status: "failed", outputUrl: null, error: "Unknown id or expired" });

  const status = job.status || "unknown";
  const outputUrl = status === "succeeded" ? `${getBaseUrl(req)}/magic/result?id=${encodeURIComponent(id)}` : null;
  return res.status(200).json({ ok: true, status, outputUrl, error: job.error || null });
});

// GET /magic/result
app.get("/magic/result", (req, res) => {
  const id = String(req.query?.id || "").trim();
  if (!id) return res.status(400).send("Missing id");

  const job = magicJobs.get(id);
  if (!job) return res.status(404).send("Not found");
  if (job.status !== "succeeded" || !job.bytes) return res.status(409).send(job.error || "Not ready");

  res.setHeader("Content-Type", job.mime || "image/png");
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).send(job.bytes);
});

// POST /video/start
app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    if (!mustBeOkReplicate(res)) return;

    const file = req.file;
    if (!file?.buffer || file.buffer.length < 10) return res.status(400).json({ ok: false, error: "Missing image" });

    const prompt =
      String(req.body?.prompt || "").trim() ||
      `
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
• Small ambient motion everywhere

STRICTLY no new objects or details.
Loop-friendly. Smooth. Clean.
`.trim();

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

    return res.status(200).json({ ok: true, id: prediction.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /video/status
app.get("/video/status", async (req, res) => {
  try {
    if (!mustBeOkReplicate(res)) return;

    const id = String(req.query?.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    const p = await replicateGetPrediction(id);
    const status = p?.status || "unknown";
    const outputUrl = status === "succeeded" ? normalizeOutputUrl(p?.output) : null;
    return res.status(200).json({ ok: true, status, outputUrl, error: p?.error || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Boot ----------
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ DM-2026 backend listening on http://0.0.0.0:${PORT}`);
  console.log(`VERSION: ${VERSION}`);
});
