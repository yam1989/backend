// DM-2026 backend (Replicate-only) — Node 20 + Express
// IMPORTANT: Keep existing endpoints:
// POST /magic (multipart: image + styleId)
// POST /video/start
// GET  /video/status?id=...
// GET  /, /health, /me
//
// This server also exposes GET /magic/status?id=... which Flutter uses for polling.

import express from "express";
import multer from "multer";

const app = express();
app.disable("x-powered-by");

// ---------- Config ----------
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
if (!REPLICATE_API_TOKEN) {
  // Don’t throw at import-time; Cloud Run still starts and /health will show the issue.
  console.warn("⚠️  REPLICATE_API_TOKEN is not set");
}

// Image model (recommended default: fofr/sdxl-multi-controlnet-lora)
const REPLICATE_IMAGE_OWNER = process.env.REPLICATE_IMAGE_OWNER || "fofr";
const REPLICATE_IMAGE_MODEL = process.env.REPLICATE_IMAGE_MODEL || "sdxl-multi-controlnet-lora";
const REPLICATE_IMAGE_VERSION = process.env.REPLICATE_IMAGE_VERSION || ""; // optional pin

// Input keys (kept env-driven; defaults match sdxl-multi-controlnet-lora)
const IMG_INPUT_KEY = process.env.IMG_INPUT_KEY || "image";
const IMG_PROMPT_KEY = process.env.IMG_PROMPT_KEY || "prompt";
const IMG_NEG_PROMPT_KEY = process.env.IMG_NEG_PROMPT_KEY || "negative_prompt";

// Quality/cost knobs (sdxl-multi-controlnet-lora schema)
const IMAGE_STEPS = parseInt(process.env.IMAGE_STEPS || "20", 10); // num_inference_steps
const IMAGE_GUIDANCE = parseFloat(process.env.IMAGE_GUIDANCE || "5.0"); // guidance_scale
const IMAGE_PROMPT_STRENGTH = parseFloat(process.env.IMAGE_PROMPT_STRENGTH || "0.45"); // prompt_strength (lower = preserve input more)

// ControlNet defaults (help keep structure + avoid “empty texture”)
const IMAGE_CONTROLNET_1 = process.env.IMAGE_CONTROLNET_1 || "lineart"; // canny | lineart | soft_edge_hed | ...
const IMAGE_CONTROLNET_1_SCALE = parseFloat(process.env.IMAGE_CONTROLNET_1_SCALE || "1.15");
const IMAGE_CONTROLNET_1_START = parseFloat(process.env.IMAGE_CONTROLNET_1_START || "0.0");
const IMAGE_CONTROLNET_1_END = parseFloat(process.env.IMAGE_CONTROLNET_1_END || "1.0");

// Output sizing (optional; if omitted the model will choose defaults)
const IMAGE_WIDTH = parseInt(process.env.IMAGE_WIDTH || "0", 10);   // 0 => omit
const IMAGE_HEIGHT = parseInt(process.env.IMAGE_HEIGHT || "0", 10); // 0 => omit

// Video model (kept as you described)
const REPLICATE_VIDEO_OWNER = process.env.REPLICATE_VIDEO_OWNER || "wan-video";
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_VIDEO_MODEL || "wan-2.2-i2v-fast";
const REPLICATE_VIDEO_VERSION = process.env.REPLICATE_VIDEO_VERSION || ""; // optional pin

const VIDEO_INPUT_KEY = process.env.VIDEO_INPUT_KEY || "image";
const VIDEO_PROMPT_KEY = process.env.VIDEO_PROMPT_KEY || "prompt";

const VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || "480p";
const VIDEO_FPS = parseInt(process.env.VIDEO_FPS || "16", 10);
const VIDEO_NUM_FRAMES = parseInt(process.env.VIDEO_NUM_FRAMES || "81", 10);
const VIDEO_GO_FAST = (process.env.VIDEO_GO_FAST || "true").toLowerCase() === "true";
const VIDEO_INTERPOLATE = (process.env.VIDEO_INTERPOLATE || "false").toLowerCase() === "true";

// Optional style prompts mapping:
// STYLE_PROMPTS_JSON='{"styleId1":"...","styleId2":"..."}'
const STYLE_PROMPTS_JSON = process.env.STYLE_PROMPTS_JSON || "";

// ---------- Middleware ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

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
    },
    video: {
      owner: REPLICATE_VIDEO_OWNER,
      model: REPLICATE_VIDEO_MODEL,
      versionPinned: Boolean(REPLICATE_VIDEO_VERSION),
    },
  });
});

// ---------- Helpers ----------
function mustBeOkEnv(res) {
  if (!REPLICATE_API_TOKEN) {
    res.status(500).json({ ok: false, error: "REPLICATE_API_TOKEN is not set" });
    return false;
  }
  return true;
}

function bufferToDataUri(buf, mime) {
  const safeMime = mime && mime.includes("/") ? mime : "image/png";
  const base64 = buf.toString("base64");
  return `data:${safeMime};base64,${base64}`;
}

function getStylePrompt(styleId) {
  const base =
    "Premium kid-friendly illustration redraw. Keep the exact composition, pose, proportions, and shapes from the input drawing. " +
    "Clean crisp lines, smooth solid color fills, gentle soft shading, no paper texture, no noise, no blur. " +
    "Do NOT add new objects, do NOT remove objects, do NOT change background framing. Center the drawing, no zoom, no crop.";
  const neg =
    "photorealistic, photo, paper texture, scan artifacts, watermark, text, letters, numbers, logo, border, frame, " +
    "extra objects, extra limbs, dramatic new background, heavy grain, low quality, blurry, out of focus";

  let styleExtra = "";
  if (STYLE_PROMPTS_JSON) {
    try {
      const map = JSON.parse(STYLE_PROMPTS_JSON);
      if (map && typeof map === "object" && styleId && map[styleId]) {
        styleExtra = String(map[styleId]);
      }
    } catch {
      // ignore invalid JSON
    }
  } else if (styleId) {
    // Fallback: treat styleId as a lightweight hint (won't break if it's an internal id)
    styleExtra = `Style hint: ${styleId}.`;
  }

  return {
    prompt: `${base} ${styleExtra}`.trim(),
    negative: neg,
  };
}

async function replicateCreatePrediction({ owner, model, version, input }) {
  const body = version
    ? { version, input }
    : { model: `${owner}/${model}`, input };

  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
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
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length) {
    // some models return array of URLs
    const first = output[0];
    if (typeof first === "string") return first;
  }
  // some models return object/array of objects; ignore
  return null;
}

// ---------- Endpoints ----------

// POST /magic (multipart: image + styleId)
// Returns { ok:true, id }
app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    if (!mustBeOkEnv(res)) return;

    const styleId = (req.body?.styleId || "").toString().trim();
    const file = req.file;

    if (!file || !file.buffer || file.buffer.length < 10) {
      return res.status(400).json({ ok: false, error: "Missing image" });
    }

    const dataUri = bufferToDataUri(file.buffer, file.mimetype);
    const { prompt, negative } = getStylePrompt(styleId);

    const input = {
      [IMG_PROMPT_KEY]: prompt,
      [IMG_NEG_PROMPT_KEY]: negative,
      [IMG_INPUT_KEY]: dataUri,

      // SDXL i2i knobs
      num_inference_steps: IMAGE_STEPS,
      guidance_scale: IMAGE_GUIDANCE,
      prompt_strength: IMAGE_PROMPT_STRENGTH,

      // Strong structure lock (ControlNet)
      controlnet_1: IMAGE_CONTROLNET_1,
      controlnet_1_image: dataUri,
      controlnet_1_conditioning_scale: IMAGE_CONTROLNET_1_SCALE,
      controlnet_1_start: IMAGE_CONTROLNET_1_START,
      controlnet_1_end: IMAGE_CONTROLNET_1_END,

      // Ensure img2img mode
      // (model uses `image` presence to pick img2img)
    };

    if (IMAGE_WIDTH > 0) input.width = IMAGE_WIDTH;
    if (IMAGE_HEIGHT > 0) input.height = IMAGE_HEIGHT;

    const prediction = await replicateCreatePrediction({
      owner: REPLICATE_IMAGE_OWNER,
      model: REPLICATE_IMAGE_MODEL,
      version: REPLICATE_IMAGE_VERSION || undefined,
      input,
    });

    return res.status(200).json({ ok: true, id: prediction.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /magic/status?id=...
// Returns { ok:true, status, outputUrl, error? }
app.get("/magic/status", async (req, res) => {
  try {
    if (!mustBeOkEnv(res)) return;

    const id = (req.query?.id || "").toString().trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    const p = await replicateGetPrediction(id);

    const status = p?.status || "unknown";
    const outputUrl = status === "succeeded" ? normalizeOutputUrl(p?.output) : null;

    return res.status(200).json({
      ok: true,
      status,
      outputUrl,
      error: p?.error || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /video/start (multipart: image + prompt?)
// Returns { ok:true, id }
app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    if (!mustBeOkEnv(res)) return;

    const file = req.file;
    if (!file || !file.buffer || file.buffer.length < 10) {
      return res.status(400).json({ ok: false, error: "Missing image" });
    }

    const prompt = (req.body?.prompt || "").toString().trim() ||
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

// GET /video/status?id=...
// Returns { ok:true, status, outputUrl, error? }
app.get("/video/status", async (req, res) => {
  try {
    if (!mustBeOkEnv(res)) return;

    const id = (req.query?.id || "").toString().trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    const p = await replicateGetPrediction(id);
    const status = p?.status || "unknown";
    const outputUrl = status === "succeeded" ? normalizeOutputUrl(p?.output) : null;

    return res.status(200).json({
      ok: true,
      status,
      outputUrl,
      error: p?.error || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ DM-2026 backend listening on http://0.0.0.0:${PORT}`);
});
