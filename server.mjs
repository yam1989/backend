// DM-2026 backend (OpenAI Image + Replicate Video) — Node 20 + Express
// FIX: lazy-load OpenAI SDK so container still starts even if dependency is missing.
// IMPORTANT: Keep endpoints EXACTLY:
// GET  /, /health, /me
// POST /magic (multipart: image + styleId) -> { ok:true, id }
// GET  /magic/status?id=... -> { ok:true, status, outputUrl, error }
// POST /video/start (multipart: image + optional prompt) -> { ok:true, id }
// GET  /video/status?id=... -> { ok:true, status, outputUrl, error }
// Added: GET /magic/result?id=... -> returns image bytes

import express from "express";
import multer from "multer";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");

// ---------- Config ----------
const PORT = parseInt(process.env.PORT || "8080", 10);

// OpenAI (Image)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "auto";
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "high";
const OPENAI_IMAGE_OUTPUT_FORMAT = process.env.OPENAI_IMAGE_OUTPUT_FORMAT || "png";
const OPENAI_IMAGE_INPUT_FIDELITY = process.env.OPENAI_IMAGE_INPUT_FIDELITY || "high";

// Replicate (Video)
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

// Optional style prompts mapping:
// STYLE_PROMPTS_JSON='{"styleId1":"...","styleId2":"..."}'
const STYLE_PROMPTS_JSON = process.env.STYLE_PROMPTS_JSON || "";

// In-memory job store for /magic
const MAGIC_TTL_MS = parseInt(process.env.MAGIC_TTL_MS || String(60 * 60 * 1000), 10);
const MAGIC_MAX_BYTES = parseInt(process.env.MAGIC_MAX_BYTES || String(4 * 1024 * 1024), 10);
const magicJobs = new Map(); // id -> { status, mime, bytes, error, createdAt }

// ---------- Middleware ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ---------- Utilities ----------
function now() {
  return Date.now();
}

function cleanupMagicJobs() {
  const t = now();
  for (const [id, job] of magicJobs.entries()) {
    if (!job?.createdAt || t - job.createdAt > MAGIC_TTL_MS) {
      magicJobs.delete(id);
    }
  }
}
try {
  const t = setInterval(cleanupMagicJobs, 30 * 1000);
  if (t && typeof t.unref === "function") t.unref();
} catch {
  // ignore
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

function bufferToDataUri(buf, mime) {
  const safeMime = mime && mime.includes("/") ? mime : "image/png";
  const base64 = Buffer.from(buf).toString("base64");
  return `data:${safeMime};base64,${base64}`;
}

function mimeFromOutputFormat(fmt) {
  const f = (fmt || "png").toLowerCase();
  if (f === "jpeg" || f === "jpg") return "image/jpeg";
  if (f === "webp") return "image/webp";
  return "image/png";
}

function normalizeOutputUrl(output) {
  if (!output) return null;
  if (typeof output === "string") return output;

  if (Array.isArray(output) && output.length) {
    const first = output[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      if (typeof first.url === "string") return first.url;
      if (typeof first.output === "string") return first.output;
    }
  }

  if (output && typeof output === "object") {
    if (typeof output.url === "string") return output.url;
  }

  return null;
}

function getStylePrompt(styleId) {
  const base =
    "You are redrawing a child's drawing as a premium clean illustration for a kids iOS app. " +
    "CRITICAL: Preserve the original drawing structure 1:1: same composition, framing, pose, proportions, shapes, and relative positions. " +
    "Do NOT add new objects. Do NOT remove objects. Do NOT zoom or crop. Do NOT add borders or white margins. " +
    "Make it look expensive: crisp clean lines, smooth solid fills, gentle soft shading, subtle highlights, no paper texture, no noise.";

  const neg =
    "photo, photorealistic, scan, paper texture, grain, blur, watermark, text, letters, numbers, logo, border, frame, " +
    "extra objects, extra limbs, wrong pose, different composition, different framing, cropped, zoomed, low quality";

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
    styleExtra = `Style hint: ${styleId}.`;
  }

  return {
    prompt: `${base} ${styleExtra}`.trim(),
    negative: neg,
  };
}

// ---------- Replicate API ----------
async function replicateCreatePrediction({ owner, model, version, input }) {
  const body = version ? { version, input } : { model: `${owner}/${model}`, input };

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

// ---------- OpenAI image pipeline (async) ----------
// Lazy-load OpenAI SDK so startup doesn't crash if dependency missing.
let _OpenAI = null;
async function getOpenAIClient() {
  if (_OpenAI === null) {
    try {
      const mod = await import("openai");
      _OpenAI = mod?.default || mod?.OpenAI || null;
    } catch (e) {
      _OpenAI = null;
      throw new Error(
        "OpenAI SDK is not installed. Add dependency 'openai' in package.json and redeploy. " +
          (e?.message ? `(${e.message})` : "")
      );
    }
  }
  if (!_OpenAI) throw new Error("OpenAI SDK import failed");
  return new _OpenAI({ apiKey: OPENAI_API_KEY });
}

async function runOpenAIImageEdit({ jobId, inputBuffer, styleId }) {
  try {
    const client = await getOpenAIClient();
    const { prompt, negative } = getStylePrompt(styleId);
    const fullPrompt = `${prompt}\n\nAvoid: ${negative}`;

    const result = await client.images.edit({
      model: OPENAI_IMAGE_MODEL,
      image: inputBuffer,
      prompt: fullPrompt,
      size: OPENAI_IMAGE_SIZE,
      quality: OPENAI_IMAGE_QUALITY,
      output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
      input_fidelity: OPENAI_IMAGE_INPUT_FIDELITY,
    });

    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI returned no image data (missing b64_json)");

    const bytes = Buffer.from(b64, "base64");
    if (!bytes.length) throw new Error("OpenAI returned empty image bytes");
    if (bytes.length > MAGIC_MAX_BYTES) {
      throw new Error(`Image too large (${bytes.length} bytes), cap=${MAGIC_MAX_BYTES}`);
    }

    magicJobs.set(jobId, {
      status: "succeeded",
      mime: mimeFromOutputFormat(OPENAI_IMAGE_OUTPUT_FORMAT),
      bytes,
      error: null,
      createdAt: now(),
    });
  } catch (e) {
    magicJobs.set(jobId, {
      status: "failed",
      mime: null,
      bytes: null,
      error: String(e?.message || e),
      createdAt: now(),
    });
  }
}

// ---------- Routes ----------
app.get("/", (_req, res) => res.status(200).send("DM-2026 backend: ok"));

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    openaiKey: Boolean(OPENAI_API_KEY),
    replicateKey: Boolean(REPLICATE_API_TOKEN),
  });
});

app.get("/me", (_req, res) => {
  res.status(200).json({
    ok: true,
    mode: "openai-image + replicate-video",
    image: {
      provider: "openai",
      model: OPENAI_IMAGE_MODEL,
      size: OPENAI_IMAGE_SIZE,
      quality: OPENAI_IMAGE_QUALITY,
      outputFormat: OPENAI_IMAGE_OUTPUT_FORMAT,
      inputFidelity: OPENAI_IMAGE_INPUT_FIDELITY,
    },
    video: {
      provider: "replicate",
      owner: REPLICATE_VIDEO_OWNER,
      model: REPLICATE_VIDEO_MODEL,
      versionPinned: Boolean(REPLICATE_VIDEO_VERSION),
      resolution: VIDEO_RESOLUTION,
      fps: VIDEO_FPS,
      numFrames: VIDEO_NUM_FRAMES,
      goFast: VIDEO_GO_FAST,
      interpolate: VIDEO_INTERPOLATE,
    },
  });
});

// POST /magic
app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    if (!mustBeOkOpenAI(res)) return;

    const styleId = (req.body?.styleId || "").toString().trim();
    const file = req.file;

    if (!file || !file.buffer || file.buffer.length < 10) {
      return res.status(400).json({ ok: false, error: "Missing image" });
    }

    const id = `m_${crypto.randomUUID()}`;

    magicJobs.set(id, {
      status: "processing",
      mime: null,
      bytes: null,
      error: null,
      createdAt: now(),
    });

    runOpenAIImageEdit({
      jobId: id,
      inputBuffer: file.buffer,
      styleId,
    });

    return res.status(200).json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// GET /magic/status
app.get("/magic/status", (req, res) => {
  const id = (req.query?.id || "").toString().trim();
  if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

  const job = magicJobs.get(id);
  if (!job) {
    return res.status(200).json({
      ok: true,
      status: "failed",
      outputUrl: null,
      error: "Unknown id or expired",
    });
  }

  const status = job.status || "unknown";
  const outputUrl = status === "succeeded" ? `/magic/result?id=${encodeURIComponent(id)}` : null;

  return res.status(200).json({
    ok: true,
    status,
    outputUrl,
    error: job.error || null,
  });
});

// GET /magic/result
app.get("/magic/result", (req, res) => {
  const id = (req.query?.id || "").toString().trim();
  if (!id) return res.status(400).send("Missing id");

  const job = magicJobs.get(id);
  if (!job) return res.status(404).send("Not found");

  if (job.status !== "succeeded" || !job.bytes) {
    return res.status(409).send(job.error || "Not ready");
  }

  res.setHeader("Content-Type", job.mime || "image/png");
  res.setHeader("Cache-Control", "private, max-age=3600");
  return res.status(200).send(job.bytes);
});

// POST /video/start
app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    if (!mustBeOkReplicate(res)) return;

    const file = req.file;
    if (!file || !file.buffer || file.buffer.length < 10) {
      return res.status(400).json({ ok: false, error: "Missing image" });
    }

    const prompt =
      (req.body?.prompt || "").toString().trim() ||
      "Gentle cinematic camera move, subtle motion, preserve the same drawing 1:1, no new objects, no morphing, no zoom/crop.";

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
