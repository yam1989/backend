// DM-2026 backend (OpenAI Image + Replicate Video) — Node 20 + Express
// Endpoints MUST stay:
// GET  /, /health, /me
// POST /magic (multipart: image + styleId) -> { ok:true, id }
// GET  /magic/status?id=... -> { ok:true, status, outputUrl, error }
// GET  /magic/result?id=... -> image bytes
// POST /video/start (multipart: image + optional prompt) -> { ok:true, id }
// GET  /video/status?id=... -> { ok:true, status, outputUrl, error }
//
// FIXES:
// - OpenAI edits endpoint requires model "dall-e-2" (gpt-image-1 is not accepted for images.edit in this SDK/API).
// - OpenAI images.edit: removed unsupported params (quality/output_format).
// - Video endpoints restored (Replicate wan-2.2-i2v-fast).

import express from "express";
import multer from "multer";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");

const PORT = parseInt(process.env.PORT || "8080", 10);

// ---------- ENV ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
// IMPORTANT: images.edit currently expects dall-e-2
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "dall-e-2";
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1024"; // edits generally use fixed sizes

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
const MAGIC_MAX_BYTES = parseInt(process.env.MAGIC_MAX_BYTES || String(6 * 1024 * 1024), 10);
const magicJobs = new Map();

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
  const timer = setInterval(cleanupMagicJobs, 30 * 1000);
  if (timer && typeof timer.unref === "function") timer.unref();
} catch {}

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

  let styleExtra = "";
  if (STYLE_PROMPTS_JSON) {
    try {
      const map = JSON.parse(STYLE_PROMPTS_JSON);
      if (map && typeof map === "object" && styleId && map[styleId]) styleExtra = String(map[styleId]);
    } catch {}
  } else if (styleId) {
    styleExtra = `Style hint: ${styleId}.`;
  }

  return `${base} ${styleExtra}`.trim();
}

// ---------- OpenAI lazy loader ----------
let OpenAIClient = null;
async function getOpenAIClient() {
  if (!OpenAIClient) {
    const mod = await import("openai");
    OpenAIClient = mod.default;
  }
  return new OpenAIClient({ apiKey: OPENAI_API_KEY });
}

// ---------- OpenAI image pipeline (async) ----------
async function runOpenAIImageEdit({ jobId, inputBuffer, styleId }) {
  try {
    const client = await getOpenAIClient();

    const prompt = getStylePrompt(styleId);

    const result = await client.images.edit({
      model: OPENAI_IMAGE_MODEL, // dall-e-2
      image: inputBuffer,
      prompt,
      size: OPENAI_IMAGE_SIZE,
    });

    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) throw new Error("OpenAI returned no image data (missing b64_json)");

    const bytes = Buffer.from(b64, "base64");
    if (!bytes.length) throw new Error("OpenAI returned empty image bytes");
    if (bytes.length > MAGIC_MAX_BYTES) throw new Error(`Image too large (${bytes.length} bytes)`);

    magicJobs.set(jobId, {
      status: "succeeded",
      mime: "image/png",
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
    image: { provider: "openai", model: OPENAI_IMAGE_MODEL, size: OPENAI_IMAGE_SIZE },
    video: { provider: "replicate", owner: REPLICATE_VIDEO_OWNER, model: REPLICATE_VIDEO_MODEL },
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

    magicJobs.set(id, { status: "processing", createdAt: now() });

    runOpenAIImageEdit({ jobId: id, inputBuffer: file.buffer, styleId });

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
  if (!job) return res.status(200).json({ ok: true, status: "failed", outputUrl: null, error: "Unknown id or expired" });

  const status = job.status || "unknown";
  const outputUrl = status === "succeeded" ? `/magic/result?id=${encodeURIComponent(id)}` : null;

  return res.status(200).json({ ok: true, status, outputUrl, error: job.error || null });
});

// GET /magic/result
app.get("/magic/result", (req, res) => {
  const id = (req.query?.id || "").toString().trim();
  if (!id) return res.status(400).send("Missing id");

  const job = magicJobs.get(id);
  if (!job) return res.status(404).send("Not found");
  if (job.status !== "succeeded" || !job.bytes) return res.status(409).send(job.error || "Not ready");

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

    return res.status(200).json({ ok: true, status, outputUrl, error: p?.error || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ DM-2026 backend listening on http://0.0.0.0:${PORT}`);
});
