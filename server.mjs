// DM-2026 backend (Replicate-only) — Node 20 + Express
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

const PORT = parseInt(process.env.PORT || "8080", 10);

// ---------- ENV ----------
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";

// Image model (fofr/sdxl-multi-controlnet-lora requires version)
const REPLICATE_IMAGE_OWNER = process.env.REPLICATE_IMAGE_OWNER || "fofr";
const REPLICATE_IMAGE_MODEL = process.env.REPLICATE_IMAGE_MODEL || "sdxl-multi-controlnet-lora";
const REPLICATE_IMAGE_VERSION = process.env.REPLICATE_IMAGE_VERSION || ""; // REQUIRED

const IMG_INPUT_KEY = process.env.IMG_INPUT_KEY || "image";
const IMG_PROMPT_KEY = process.env.IMG_PROMPT_KEY || "prompt";
const IMG_NEG_PROMPT_KEY = process.env.IMG_NEG_PROMPT_KEY || "negative_prompt";

const IMAGE_STEPS = parseInt(process.env.IMAGE_STEPS || "22", 10);
const IMAGE_GUIDANCE = parseFloat(process.env.IMAGE_GUIDANCE || "4.5");
const IMAGE_PROMPT_STRENGTH = parseFloat(process.env.IMAGE_PROMPT_STRENGTH || "0.62");

const IMAGE_CONTROLNET_1 = process.env.IMAGE_CONTROLNET_1 || "soft_edge_hed";
const IMAGE_CONTROLNET_1_SCALE = parseFloat(process.env.IMAGE_CONTROLNET_1_SCALE || "1.0");
const IMAGE_CONTROLNET_1_START = parseFloat(process.env.IMAGE_CONTROLNET_1_START || "0.0");
const IMAGE_CONTROLNET_1_END = parseFloat(process.env.IMAGE_CONTROLNET_1_END || "1.0");

const IMAGE_WIDTH = parseInt(process.env.IMAGE_WIDTH || "0", 10);
const IMAGE_HEIGHT = parseInt(process.env.IMAGE_HEIGHT || "0", 10);
const IMAGE_NUM_OUTPUTS = parseInt(process.env.IMAGE_NUM_OUTPUTS || "1", 10);

const IMAGE_ENABLE_FALLBACK = (process.env.IMAGE_ENABLE_FALLBACK || "true").toLowerCase() === "true";
const IMAGE_FALLBACK_CONTROLNET_1 = process.env.IMAGE_FALLBACK_CONTROLNET_1 || "canny";
const IMAGE_FALLBACK_CONTROLNET_1_SCALE = parseFloat(process.env.IMAGE_FALLBACK_CONTROLNET_1_SCALE || "0.85");
const IMAGE_FALLBACK_PROMPT_STRENGTH = parseFloat(process.env.IMAGE_FALLBACK_PROMPT_STRENGTH || "0.60");

// Video model (some deployments require version; allow pin via env)
const REPLICATE_VIDEO_OWNER = process.env.REPLICATE_VIDEO_OWNER || "wan-video";
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_VIDEO_MODEL || "wan-2.2-i2v-fast";
const REPLICATE_VIDEO_VERSION = process.env.REPLICATE_VIDEO_VERSION || ""; // strongly recommended

const VIDEO_INPUT_KEY = process.env.VIDEO_INPUT_KEY || "image";
const VIDEO_PROMPT_KEY = process.env.VIDEO_PROMPT_KEY || "prompt";

const VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || "480p";
const VIDEO_FPS = parseInt(process.env.VIDEO_FPS || "16", 10);
const VIDEO_NUM_FRAMES = parseInt(process.env.VIDEO_NUM_FRAMES || "81", 10);
const VIDEO_GO_FAST = (process.env.VIDEO_GO_FAST || "true").toLowerCase() === "true";
const VIDEO_INTERPOLATE = (process.env.VIDEO_INTERPOLATE || "false").toLowerCase() === "true";

const STYLE_PROMPTS_JSON = process.env.STYLE_PROMPTS_JSON || "";

// ---------- Upload ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ---------- Helpers ----------
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
  if (!STYLE_PROMPTS_JSON) return `Style hint: ${styleId}.`;
  try {
    const m = JSON.parse(STYLE_PROMPTS_JSON);
    if (m && typeof m === "object" && m[styleId]) return String(m[styleId]);
  } catch {}
  return `Style hint: ${styleId}.`;
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
  if (!r.ok) {
    const msg = json?.detail || json?.error || r.statusText || "Replicate error";
    throw new Error(msg);
  }
  return json;
}

async function replicateGetPrediction(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json?.detail || json?.error || r.statusText || "Replicate error";
    throw new Error(msg);
  }
  return json;
}

function normalizeOutputUrl(output) {
  if (!output) return null;

  // string
  if (typeof output === "string") return output;

  // array
  if (Array.isArray(output) && output.length) {
    const first = output[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      if (typeof first.url === "string") return first.url;
      if (typeof first.uri === "string") return first.uri;
      if (typeof first.image === "string") return first.image;
      if (typeof first.video === "string") return first.video;
      if (typeof first.mp4 === "string") return first.mp4;
      if (typeof first.file === "string") return first.file;
    }
  }

  // object with common keys
  if (typeof output === "object") {
    const keys = [
      "url", "uri", "image", "video", "mp4", "gif", "file",
      "output", "result",
    ];
    for (const k of keys) {
      if (typeof output[k] === "string") return output[k];
    }

    const arrKeys = ["images", "videos", "files", "outputs", "results"];
    for (const k of arrKeys) {
      if (Array.isArray(output[k]) && output[k].length) {
        const v = output[k][0];
        if (typeof v === "string") return v;
        if (v && typeof v === "object") {
          if (typeof v.url === "string") return v.url;
          if (typeof v.uri === "string") return v.uri;
          if (typeof v.video === "string") return v.video;
          if (typeof v.image === "string") return v.image;
          if (typeof v.file === "string") return v.file;
        }
      }
    }

    // Replicate sometimes returns { segments: [{ uri: ... }] }
    if (Array.isArray(output.segments) && output.segments.length) {
      const s = output.segments[0];
      if (s && typeof s === "object") {
        if (typeof s.url === "string") return s.url;
        if (typeof s.uri === "string") return s.uri;
      }
    }
  }

  return null;
}

function outputDebugShape(output) {
  if (output == null) return "null";
  if (typeof output === "string") return "string";
  if (Array.isArray(output)) return `array(len=${output.length})`;
  if (typeof output === "object") return `object(keys=${Object.keys(output).slice(0, 8).join(",")})`;
  return typeof output;
}

// Fallback mapping (id -> fallbackId) with TTL
const magicFallbackById = new Map();
const TTL_MS = 20 * 60 * 1000;
function cacheSet(map, key, value) { map.set(key, { ...value, ts: Date.now() }); }
function cacheGet(map, key) {
  const v = map.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > TTL_MS) { map.delete(key); return null; }
  return v;
}

// ---------- Routes ----------
app.get("/", (_req, res) => res.status(200).send("DM-2026 backend: ok"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

app.get("/me", (_req, res) => {
  res.status(200).json({
    ok: true,
    mode: "replicate",
    image: {
      owner: REPLICATE_IMAGE_OWNER,
      model: REPLICATE_IMAGE_MODEL,
      versionPinned: Boolean(REPLICATE_IMAGE_VERSION),
      controlnet: IMAGE_CONTROLNET_1,
      fallbackEnabled: IMAGE_ENABLE_FALLBACK,
    },
    video: {
      owner: REPLICATE_VIDEO_OWNER,
      model: REPLICATE_VIDEO_MODEL,
      versionPinned: Boolean(REPLICATE_VIDEO_VERSION),
    },
  });
});

// POST /magic (multipart: image + styleId)
app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    if (!okEnv(res)) return;
    if (!REPLICATE_IMAGE_VERSION) {
      return res.status(500).json({ ok: false, error: "REPLICATE_IMAGE_VERSION is not set (required for this image model)" });
    }

    const file = req.file;
    if (!file || !file.buffer || file.buffer.length < 10) {
      return res.status(400).json({ ok: false, error: "Missing image" });
    }

    const styleId = (req.body?.styleId || "").toString().trim();
    const dataUri = bufferToDataUri(file.buffer, file.mimetype);
    const { prompt, negative } = getMagicPrompt(styleId);

    const input = {
      [IMG_PROMPT_KEY]: prompt,
      [IMG_NEG_PROMPT_KEY]: negative,
      [IMG_INPUT_KEY]: dataUri,

      // model params (sdxl-like)
      num_outputs: IMAGE_NUM_OUTPUTS,
      num_inference_steps: IMAGE_STEPS,
      guidance_scale: IMAGE_GUIDANCE,
      prompt_strength: IMAGE_PROMPT_STRENGTH,

      // controlnet
      controlnet_1: IMAGE_CONTROLNET_1,
      controlnet_1_image: dataUri,
      controlnet_1_conditioning_scale: IMAGE_CONTROLNET_1_SCALE,
      controlnet_1_start: IMAGE_CONTROLNET_1_START,
      controlnet_1_end: IMAGE_CONTROLNET_1_END,
    };

    if (IMAGE_WIDTH > 0) input.width = IMAGE_WIDTH;
    if (IMAGE_HEIGHT > 0) input.height = IMAGE_HEIGHT;

    const p = await replicateCreatePrediction({
      owner: REPLICATE_IMAGE_OWNER,
      model: REPLICATE_IMAGE_MODEL,
      version: REPLICATE_IMAGE_VERSION,
      input,
    });

    res.status(200).json({ ok: true, id: p.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /magic/status?id=...
app.get("/magic/status", async (req, res) => {
  try {
    if (!okEnv(res)) return;

    const id = (req.query?.id || "").toString().trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    const fb = cacheGet(magicFallbackById, id);
    const activeId = fb?.fallbackId || id;

    const p = await replicateGetPrediction(activeId);
    const status = p?.status || "unknown";
    let outputUrl = status === "succeeded" ? normalizeOutputUrl(p?.output) : null;

    // If succeeded but output empty -> start fallback using original prediction input from Replicate
    if (IMAGE_ENABLE_FALLBACK && !fb && status === "succeeded" && !outputUrl) {
      const orig = await replicateGetPrediction(id);
      const origInput = orig?.input || {};
      const origImage = origInput?.[IMG_INPUT_KEY] || origInput?.image || origInput?.image_prompt || null;

      if (origImage && REPLICATE_IMAGE_VERSION) {
        const { prompt, negative } = getMagicPrompt("");
        const input = {
          [IMG_PROMPT_KEY]: prompt,
          [IMG_NEG_PROMPT_KEY]: negative,
          [IMG_INPUT_KEY]: origImage,
          num_outputs: 1,
          num_inference_steps: IMAGE_STEPS,
          guidance_scale: IMAGE_GUIDANCE,
          prompt_strength: IMAGE_FALLBACK_PROMPT_STRENGTH,
          controlnet_1: IMAGE_FALLBACK_CONTROLNET_1,
          controlnet_1_image: origImage,
          controlnet_1_conditioning_scale: IMAGE_FALLBACK_CONTROLNET_1_SCALE,
          controlnet_1_start: 0.0,
          controlnet_1_end: 1.0,
        };

        if (IMAGE_WIDTH > 0) input.width = IMAGE_WIDTH;
        if (IMAGE_HEIGHT > 0) input.height = IMAGE_HEIGHT;

        const fp = await replicateCreatePrediction({
          owner: REPLICATE_IMAGE_OWNER,
          model: REPLICATE_IMAGE_MODEL,
          version: REPLICATE_IMAGE_VERSION,
          input,
        });

        cacheSet(magicFallbackById, id, { fallbackId: fp.id });

        return res.status(200).json({
          ok: true,
          status: "processing",
          outputUrl: null,
          error: "Empty output; started fallback prediction",
        });
      }
    }

    if (status === "succeeded" && !outputUrl) {
      return res.status(200).json({
        ok: true,
        status,
        outputUrl: null,
        error: "Prediction succeeded but output is empty",
        debug: { outputShape: outputDebugShape(p?.output) },
      });
    }

    res.status(200).json({
      ok: true,
      status,
      outputUrl,
      error: p?.error || null,
      debug: { outputShape: outputDebugShape(p?.output) },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /video/start (multipart: image + prompt?)
app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    if (!okEnv(res)) return;

    const file = req.file;
    if (!file || !file.buffer || file.buffer.length < 10) {
      return res.status(400).json({ ok: false, error: "Missing image" });
    }

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

    res.status(200).json({ ok: true, id: p.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /video/status?id=...
app.get("/video/status", async (req, res) => {
  try {
    if (!okEnv(res)) return;

    const id = (req.query?.id || "").toString().trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    const p = await replicateGetPrediction(id);
    const status = p?.status || "unknown";
    const outputUrl = status === "succeeded" ? normalizeOutputUrl(p?.output) : null;

    if (status === "succeeded" && !outputUrl) {
      // Make the failure explicit for the client
      return res.status(200).json({
        ok: true,
        status: "failed",
        outputUrl: null,
        error: "Prediction succeeded but output video url is empty",
        debug: { outputShape: outputDebugShape(p?.output) },
      });
    }

    res.status(200).json({
      ok: true,
      status,
      outputUrl,
      error: p?.error || null,
      debug: { outputShape: outputDebugShape(p?.output) },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ DM-2026 backend listening on http://0.0.0.0:${PORT}`);
});
