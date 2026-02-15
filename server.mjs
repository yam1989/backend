// DM-2026 backend (Replicate-only) — Node 20 + Express
// FIX: Replicate API has two create endpoints:
//   - By VERSION: POST https://api.replicate.com/v1/predictions  { version, input }
//   - By MODEL:   POST https://api.replicate.com/v1/models/{owner}/{model}/predictions { input }
// Some models (like flux-1.1-pro) must be called via the MODEL endpoint (no version exposed).
//
// Endpoints (DO NOT BREAK):
// POST /magic (multipart: image + styleId)
// GET  /magic/status?id=...
// POST /video/start
// GET  /video/status?id=...
// GET  /, /health, /me

import express from "express";
import multer from "multer";

const app = express();
app.disable("x-powered-by");
const PORT = Number(process.env.PORT || 8080);

// ---------- AUTH ----------
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";

// ---------- IMAGE (FLUX 1.1 PRO) ----------
const REPLICATE_IMAGE_OWNER = process.env.REPLICATE_IMAGE_OWNER || "black-forest-labs";
const REPLICATE_IMAGE_MODEL = process.env.REPLICATE_IMAGE_MODEL || "flux-1.1-pro";

const IMAGE_ASPECT_RATIO = process.env.IMAGE_ASPECT_RATIO || "3:2";
const IMAGE_OUTPUT_FORMAT = process.env.IMAGE_OUTPUT_FORMAT || "png";
const IMAGE_SAFETY_TOLERANCE = parseInt(process.env.IMAGE_SAFETY_TOLERANCE || "2", 10);
const IMAGE_PROMPT_UPSAMPLING = (process.env.IMAGE_PROMPT_UPSAMPLING || "false").toLowerCase() === "true";

// Optional style map (stringified JSON: {"styleId":"extra prompt"})
const STYLE_PROMPTS_JSON = process.env.STYLE_PROMPTS_JSON || "";

// ---------- VIDEO (WAN) ----------
const REPLICATE_VIDEO_OWNER = process.env.REPLICATE_VIDEO_OWNER || "wan-video";
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_VIDEO_MODEL || "wan-2.2-i2v-fast";
const REPLICATE_VIDEO_VERSION = process.env.REPLICATE_VIDEO_VERSION || ""; // if set -> pinned by version

const VIDEO_INPUT_KEY = process.env.VIDEO_INPUT_KEY || "image";
const VIDEO_PROMPT_KEY = process.env.VIDEO_PROMPT_KEY || "prompt";

const VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || "480p";
const VIDEO_FPS = parseInt(process.env.VIDEO_FPS || "16", 10);
const VIDEO_NUM_FRAMES = parseInt(process.env.VIDEO_NUM_FRAMES || "81", 10);
const VIDEO_GO_FAST = (process.env.VIDEO_GO_FAST || "true").toLowerCase() === "true";
const VIDEO_INTERPOLATE = (process.env.VIDEO_INTERPOLATE || "false").toLowerCase() === "true";

// ---------- Upload ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ---------- Helpers ----------
function mustHaveToken(res) {
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
  if (!styleId || !STYLE_PROMPTS_JSON) return "";
  try {
    const m = JSON.parse(STYLE_PROMPTS_JSON);
    if (m && typeof m === "object" && m[styleId]) return String(m[styleId]);
  } catch {}
  return "";
}

function fluxPrompt(styleId) {
  // Flux has no negative_prompt and no strength knobs. Prompt must be explicit.
  const base =
    "Premium kids illustration redraw. Preserve the exact composition, pose, proportions, and shapes from the input drawing. " +
    "Keep the same objects and positions 1:1. Clean crisp outlines, smooth solid color fills, gentle soft shading. " +
    "Keep background simple and clean. No paper texture. No scan noise. No blur. No zoom. No crop. No new objects.";
  const extra = parseStyleExtra(styleId);
  return `${base} ${extra}`.trim();
}

async function replicateCreateByVersion(version, input) {
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ version, input }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.detail || json?.error || r.statusText || "Replicate error");
  return json;
}

async function replicateCreateByModel(owner, model, input) {
  const url = `https://api.replicate.com/v1/models/${encodeURIComponent(owner)}/${encodeURIComponent(model)}/predictions`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
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
  const preferred = urls.find((u) => /out-|output|result|final/i.test(u));
  return preferred || urls[0] || null;
}

function pickBestUrl(output) {
  const urls = collectUrls(output, []);
  return urls[0] || null;
}

// ---------- Routes ----------
app.get("/", (_req, res) => res.status(200).send("DM-2026 backend: ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

app.get("/me", (_req, res) =>
  res.status(200).json({
    ok: true,
    mode: "replicate",
    image: {
      owner: REPLICATE_IMAGE_OWNER,
      model: REPLICATE_IMAGE_MODEL,
      versionPinned: false, // Flux called by model endpoint
      approxCostUsd: 0.04,
    },
    video: {
      owner: REPLICATE_VIDEO_OWNER,
      model: REPLICATE_VIDEO_MODEL,
      versionPinned: Boolean(REPLICATE_VIDEO_VERSION),
    },
  })
);

// ---------- IMAGE MAGIC (FLUX via MODEL endpoint) ----------
app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    if (!mustHaveToken(res)) return;

    const file = req.file;
    if (!file?.buffer?.length) return res.status(400).json({ ok: false, error: "Missing image" });

    const styleId = (req.body?.styleId || "").toString().trim();
    const dataUri = bufferToDataUri(file.buffer, file.mimetype);

    const input = {
      prompt: fluxPrompt(styleId),
      image_prompt: dataUri,
      aspect_ratio: IMAGE_ASPECT_RATIO,
      output_format: IMAGE_OUTPUT_FORMAT,
      safety_tolerance: IMAGE_SAFETY_TOLERANCE,
      prompt_upsampling: IMAGE_PROMPT_UPSAMPLING,
    };

    const p = await replicateCreateByModel(REPLICATE_IMAGE_OWNER, REPLICATE_IMAGE_MODEL, input);

    console.log("[DM-2026] /magic id", p.id);
    res.status(200).json({ ok: true, id: p.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/magic/status", async (req, res) => {
  try {
    if (!mustHaveToken(res)) return;

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
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- VIDEO MAGIC ----------
app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    if (!mustHaveToken(res)) return;

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

    const p = REPLICATE_VIDEO_VERSION
      ? await replicateCreateByVersion(REPLICATE_VIDEO_VERSION, input)
      : await replicateCreateByModel(REPLICATE_VIDEO_OWNER, REPLICATE_VIDEO_MODEL, input);

    console.log("[DM-2026] /video/start id", p.id);
    res.status(200).json({ ok: true, id: p.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/video/status", async (req, res) => {
  try {
    if (!mustHaveToken(res)) return;

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
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`✅ DM-2026 backend listening on http://0.0.0.0:${PORT}`));
