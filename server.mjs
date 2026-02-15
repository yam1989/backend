// DM-2026 backend (Replicate-only) — Node 20 + Express
// Keeps endpoints (DO NOT BREAK):
// POST /magic (multipart: image + styleId)
// GET  /magic/status?id=...
// POST /video/start
// GET  /video/status?id=...
// GET  /, /health, /me
//
// Fix v7:
// - Image output selection: some models return control images (control-0.png) alongside final output.
//   /magic/status now prefers a NON-control image URL when multiple URLs exist.

import express from "express";
import multer from "multer";

const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";

// Image model (requires version for some models like fofr/sdxl-multi-controlnet-lora)
const REPLICATE_IMAGE_OWNER = process.env.REPLICATE_IMAGE_OWNER || "fofr";
const REPLICATE_IMAGE_MODEL = process.env.REPLICATE_IMAGE_MODEL || "sdxl-multi-controlnet-lora";
const REPLICATE_IMAGE_VERSION = process.env.REPLICATE_IMAGE_VERSION || "";

const IMG_INPUT_KEY = process.env.IMG_INPUT_KEY || "image";
const IMG_PROMPT_KEY = process.env.IMG_PROMPT_KEY || "prompt";
const IMG_NEG_PROMPT_KEY = process.env.IMG_NEG_PROMPT_KEY || "negative_prompt";

const IMAGE_STEPS = parseInt(process.env.IMAGE_STEPS || "28", 10);
const IMAGE_GUIDANCE = parseFloat(process.env.IMAGE_GUIDANCE || "5.0");
const IMAGE_PROMPT_STRENGTH = parseFloat(process.env.IMAGE_PROMPT_STRENGTH || "0.55");
const IMAGE_CONTROLNET_1 = process.env.IMAGE_CONTROLNET_1 || "soft_edge_hed";
const IMAGE_CONTROLNET_1_SCALE = parseFloat(process.env.IMAGE_CONTROLNET_1_SCALE || "1.1");

// Video model
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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function okEnv(res) {
  if (!REPLICATE_API_TOKEN) {
    res.status(500).json({ ok: false, error: "REPLICATE_API_TOKEN is not set" });
    return false;
  }
  return true;
}

function bufferToDataUri(buf, mime) {
  const safeMime = mime && mime.includes("/") ? mime : "image/png";
  return `data:${safeMime};base64,${buf.toString("base64")}`;
}

function parseStyleExtra(styleId) {
  if (!styleId) return "";
  if (!STYLE_PROMPTS_JSON) return "";
  try {
    const m = JSON.parse(STYLE_PROMPTS_JSON);
    if (m && typeof m === "object" && m[styleId]) return String(m[styleId]);
  } catch {}
  return "";
}

function getMagicPrompt(styleId) {
  const base =
    "Premium kid-friendly illustration redraw. Keep the exact composition, pose, proportions, and shapes from the input drawing. " +
    "Clean crisp lines, smooth solid color fills, gentle soft shading, no paper texture, no noise, no blur. " +
    "Do NOT add new objects, do NOT remove objects, do NOT change framing. Center the drawing, no zoom, no crop.";
  const negative =
    "photorealistic, photo, paper texture, scan artifacts, watermark, text, letters, numbers, logo, border, frame, " +
    "extra objects, extra limbs, dramatic new background, heavy grain, low quality, blurry, out of focus";
  const extra = parseStyleExtra(styleId);
  return { prompt: `${base} ${extra}`.trim(), negative };
}

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

function collectUrls(output, out = []) {
  if (!output) return out;
  if (typeof output === "string") {
    if (output.startsWith("http://") || output.startsWith("https://")) out.push(output);
    return out;
  }
  if (Array.isArray(output)) {
    for (const item of output) collectUrls(item, out);
    return out;
  }
  if (typeof output === "object") {
    for (const v of Object.values(output)) collectUrls(v, out);
    return out;
  }
  return out;
}

function pickBestImageUrl(output) {
  const urls = collectUrls(output, []);
  if (!urls.length) return null;

  // keep only likely image files
  const imageUrls = urls.filter((u) => /\.(png|jpg|jpeg|webp)(\?|$)/i.test(u));
  const pool = imageUrls.length ? imageUrls : urls;

  // Prefer "final" output names and avoid control/conditioning maps
  const good = pool.filter((u) => !/control-|conditioning|canny|hed|lineart|soft_edge|depth|mask/i.test(u));
  const bestPool = good.length ? good : pool;

  // Prefer url containing "output" or "result"
  const preferred = bestPool.find((u) => /output|result|final/i.test(u));
  return preferred || bestPool[0] || null;
}

function pickBestUrl(output) {
  // generic (video or others)
  const urls = collectUrls(output, []);
  return urls[0] || null;
}

app.get("/", (_req, res) => res.status(200).send("DM-2026 backend: ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.get("/me", (_req, res) => res.status(200).json({
  ok: true,
  mode: "replicate",
  image: { owner: REPLICATE_IMAGE_OWNER, model: REPLICATE_IMAGE_MODEL, versionPinned: Boolean(REPLICATE_IMAGE_VERSION), controlnet: IMAGE_CONTROLNET_1 },
  video: { owner: REPLICATE_VIDEO_OWNER, model: REPLICATE_VIDEO_MODEL, versionPinned: Boolean(REPLICATE_VIDEO_VERSION) },
}));

app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    if (!okEnv(res)) return;
    if (!REPLICATE_IMAGE_VERSION) return res.status(500).json({ ok: false, error: "REPLICATE_IMAGE_VERSION is not set" });

    const file = req.file;
    if (!file?.buffer?.length) return res.status(400).json({ ok: false, error: "Missing image" });

    const styleId = (req.body?.styleId || "").toString().trim();
    const dataUri = bufferToDataUri(file.buffer, file.mimetype);
    const { prompt, negative } = getMagicPrompt(styleId);

    const input = {
      [IMG_PROMPT_KEY]: prompt,
      [IMG_NEG_PROMPT_KEY]: negative,
      [IMG_INPUT_KEY]: dataUri,
      num_outputs: 1,
      num_inference_steps: IMAGE_STEPS,
      guidance_scale: IMAGE_GUIDANCE,
      prompt_strength: IMAGE_PROMPT_STRENGTH,
      controlnet_1: IMAGE_CONTROLNET_1,
      controlnet_1_image: dataUri,
      controlnet_1_conditioning_scale: IMAGE_CONTROLNET_1_SCALE,
    };

    const p = await replicateCreatePrediction({ owner: REPLICATE_IMAGE_OWNER, model: REPLICATE_IMAGE_MODEL, version: REPLICATE_IMAGE_VERSION, input });
    console.log("[DM-2026] /magic id", p.id);
    res.status(200).json({ ok: true, id: p.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/magic/status", async (req, res) => {
  try {
    if (!okEnv(res)) return;
    const id = (req.query?.id || "").toString().trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    const p = await replicateGetPrediction(id);
    const status = p?.status || "unknown";
    const outputUrl = status === "succeeded" ? pickBestImageUrl(p?.output) : null;

    res.status(200).json({
      ok: true,
      status,
      outputUrl,
      error: p?.error || null,
      debug: status === "succeeded" ? { urlCount: collectUrls(p?.output, []).length } : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    if (!okEnv(res)) return;

    const file = req.file;
    if (!file?.buffer?.length) return res.status(400).json({ ok: false, error: "Missing image" });

    const prompt =
      (req.body?.prompt || "").toString().trim() ||
      "Gentle cinematic camera move, subtle motion, keep the same drawing, no new objects.";

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

    const p = await replicateCreatePrediction({
      owner: REPLICATE_VIDEO_OWNER,
      model: REPLICATE_VIDEO_MODEL,
      version: REPLICATE_VIDEO_VERSION || undefined,
      input,
    });

    console.log("[DM-2026] /video/start id", p.id);
    res.status(200).json({ ok: true, id: p.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/video/status", async (req, res) => {
  try {
    if (!okEnv(res)) return;

    const id = (req.query?.id || "").toString().trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    const p = await replicateGetPrediction(id);
    const status = p?.status || "unknown";
    const outputUrl = status === "succeeded" ? pickBestUrl(p?.output) : null;

    res.status(200).json({
      ok: true,
      status,
      outputUrl,
      error: p?.error || null,
      debug: status === "succeeded" ? { outputType: typeof p?.output } : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`✅ DM-2026 backend listening on http://0.0.0.0:${PORT}`));
