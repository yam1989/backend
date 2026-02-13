// server.mjs
// DM-2026 Backend — Replicate ONLY (stable for Cloud Run / Node 20)
//
// Endpoints (DO NOT CHANGE):
//   GET  /, /health, /me
//   POST /magic            (multipart: image + styleId [+ optional prompt])
//   POST /video/start
//   GET  /video/status?id=...
//
// Notes:
// - OpenAI is intentionally NOT used here (to avoid unexpected charges).
// - /magic returns image/png bytes (same contract as before).
// - Video uses Replicate i2v (async prediction id + status polling).
//
// Required env:
//   REPLICATE_API_TOKEN
//
// Image env (i2i):
//   REPLICATE_IMAGE_OWNER, REPLICATE_IMAGE_MODEL
//   REPLICATE_IMAGE_VERSION_ID (optional; if set, uses /v1/predictions with version)
//   IMG_INPUT_KEY (default "image")  <-- important: some models use init_image / image_prompt / input_image
//   REPLICATE_IMAGE_ASPECT_RATIO (default "3:2")
//   REPLICATE_IMAGE_STEPS (default 24)
//   REPLICATE_IMAGE_GUIDANCE (default 3.5)
//
// Video env (i2v):
//   REPLICATE_OWNER, REPLICATE_MODEL
//   REPLICATE_VERSION_ID (optional; if set, uses /v1/predictions with version)

import express from "express";
import cors from "cors";
import multer from "multer";

const VERSION = "dm-2026 replicate-only v1.0";
const PORT = Number(process.env.PORT || 8080);

// ---------- ENV ----------
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 10);

// Image (i2i)
const REPLICATE_IMAGE_OWNER = process.env.REPLICATE_IMAGE_OWNER || "black-forest-labs";
const REPLICATE_IMAGE_MODEL = process.env.REPLICATE_IMAGE_MODEL || "flux-dev";
const REPLICATE_IMAGE_VERSION_ID = process.env.REPLICATE_IMAGE_VERSION_ID || "";
const IMG_INPUT_KEY = process.env.IMG_INPUT_KEY || "image";
const REPLICATE_IMAGE_ASPECT_RATIO = process.env.REPLICATE_IMAGE_ASPECT_RATIO || "3:2";
const REPLICATE_IMAGE_STEPS = clampInt(process.env.REPLICATE_IMAGE_STEPS, 24, 5, 60);
const REPLICATE_IMAGE_GUIDANCE = clampNumber(process.env.REPLICATE_IMAGE_GUIDANCE, 3.5, 0, 20);
const REPLICATE_IMAGE_TIMEOUT_MS = clampInt(process.env.REPLICATE_IMAGE_TIMEOUT_MS, 120000, 20000, 300000);

// Video (i2v)
const REPLICATE_VIDEO_OWNER = process.env.REPLICATE_OWNER || "wan-video";
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_MODEL || "wan-2.2-i2v-fast";
const REPLICATE_VIDEO_VERSION_ID = process.env.REPLICATE_VERSION_ID || "";
const VIDEO_STATUS_TIMEOUT_MS = clampInt(process.env.VIDEO_STATUS_TIMEOUT_MS, 45000, 10000, 120000);

// ---------- app ----------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// ---------- safety logs ----------
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

// ---------- helpers ----------
function errJson(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

function clampNumber(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(v, fallback, min, max) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function fixedMime(mime) {
  if (!mime || mime === "application/octet-stream") return "image/png";
  if (mime === "image/jpg") return "image/jpeg";
  return mime;
}

function bufferToDataUri(buf, mime) {
  const m = fixedMime(mime);
  return `data:${m};base64,${Buffer.from(buf).toString("base64")}`;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const json = await resp.json().catch(() => ({}));
    return { resp, json };
  } finally {
    clearTimeout(t);
  }
}

function pickFirstOutput(output) {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output[0] || null;
  if (typeof output === "object") {
    const urls = output?.images || output?.image || output?.url;
    if (typeof urls === "string") return urls;
    if (Array.isArray(urls)) return urls[0] || null;
  }
  return null;
}

async function replicateCreatePrediction({ versionId, modelOwner, modelName, input, preferWaitSec = 60, timeoutMs = 120000 }) {
  if (!REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN is not set");

  const headers = {
    Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
    "Content-Type": "application/json",
  };
  if (preferWaitSec && preferWaitSec > 0) headers.Prefer = `wait=${preferWaitSec}`;

  let url = "https://api.replicate.com/v1/predictions";
  let body = {};

  if (versionId) {
    body = { version: versionId, input };
  } else {
    url = `https://api.replicate.com/v1/models/${modelOwner}/${modelName}/predictions`;
    body = { input };
  }

  const { resp, json } = await fetchJson(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    timeoutMs
  );

  if (!resp.ok) {
    const detail = json?.detail || json;
    const msg = `Replicate create prediction failed (${resp.status})`;
    const err = new Error(msg);
    err.detail = detail;
    throw err;
  }

  return json;
}

async function replicateGetPrediction(id, timeoutMs = 45000) {
  const { resp, json } = await fetchJson(
    `https://api.replicate.com/v1/predictions/${encodeURIComponent(id)}`,
    { method: "GET", headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` } },
    timeoutMs
  );
  if (!resp.ok) {
    const msg = `Replicate get prediction failed (${resp.status})`;
    const err = new Error(msg);
    err.detail = json?.detail || json;
    throw err;
  }
  return json;
}

async function replicateWaitForResult(id, { timeoutMs = 120000, pollMs = 1500 } = {}) {
  const start = Date.now();
  while (true) {
    const pred = await replicateGetPrediction(id, VIDEO_STATUS_TIMEOUT_MS);
    const status = pred?.status;
    if (status === "succeeded") return pred;
    if (status === "failed" || status === "canceled") return pred;
    if (Date.now() - start > timeoutMs) {
      const err = new Error("Replicate prediction timed out");
      err.prediction = pred;
      throw err;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ---------- prompts ----------
function baseStructureLock() {
  return `KEEP EXACT STRUCTURE (NO ZOOM / NO CROP):
- Keep the same subject and identity (if it is a bear, it stays the SAME bear).
- Keep the same pose, silhouette, proportions, and placement.
- Keep the same composition and framing (NO zoom, NO crop, NO camera change).
- Keep the same number of objects and elements.
- Keep background layout the same.

VERY IMPORTANT:
- Output MUST fill the entire canvas edge-to-edge.
- NO empty white margins.
- If there is extra space, EXTEND the existing background (sky/sea/ground) naturally to the edges.
- Keep the drawing upright (correct orientation).

DO:
- Redraw cleanly with confident outlines.
- Add clear vibrant colors and soft shading.
- Remove sketch noise and dirt.

DO NOT:
- Add/remove objects, text, watermark.
- Change character identity/species.
- Change framing or crop.`;
}

function stylePrompt(styleId = "magic") {
  const lock = baseStructureLock();
  const map = {
    magic: "STYLE: premium kids magical illustration, subtle glow, smooth gradients, clean line art.",
    watercolor: "STYLE: high-end watercolor illustration, controlled washes, clean edges, no drips.",
    cartoon: "STYLE: premium modern cartoon, soft cel shading, kid-friendly palette, crisp outlines.",
    clay: "STYLE: stylized clay-toy look (not realistic), soft studio lighting, smooth surfaces.",
    three_d: "STYLE: stylized 3D animated movie look (not realistic), smooth materials, soft lighting.",
  };
  return `${lock}\n${map[String(styleId || "magic")] || map.magic}`;
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "doodle-magic-backend",
    version: VERSION,
    image: {
      provider: "replicate",
      model: `${REPLICATE_IMAGE_OWNER}/${REPLICATE_IMAGE_MODEL}`,
      version_id: REPLICATE_IMAGE_VERSION_ID || null,
      aspect_ratio: REPLICATE_IMAGE_ASPECT_RATIO,
      img_input_key: IMG_INPUT_KEY,
      steps: REPLICATE_IMAGE_STEPS,
      guidance: REPLICATE_IMAGE_GUIDANCE,
    },
    video: {
      provider: "replicate",
      model: `${REPLICATE_VIDEO_OWNER}/${REPLICATE_VIDEO_MODEL}`,
      version_id: REPLICATE_VIDEO_VERSION_ID || null,
    },
  });
});

app.get("/health", (req, res) => res.json({ ok: true, version: VERSION }));

app.get("/me", (req, res) => {
  res.json({
    ok: true,
    service: "doodle-magic-backend",
    version: VERSION,
    env: {
      has_replicate_token: Boolean(REPLICATE_API_TOKEN),
      image_model: `${REPLICATE_IMAGE_OWNER}/${REPLICATE_IMAGE_MODEL}`,
      image_version_id: REPLICATE_IMAGE_VERSION_ID || null,
      img_input_key: IMG_INPUT_KEY,
      video_model: `${REPLICATE_VIDEO_OWNER}/${REPLICATE_VIDEO_MODEL}`,
      video_version_id: REPLICATE_VIDEO_VERSION_ID || null,
    },
  });
});

// POST /magic
// multipart/form-data: image + styleId (+ optional prompt)
app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) return errJson(res, 400, 'No file uploaded. Use field name "image".');
    if (!REPLICATE_API_TOKEN) return errJson(res, 500, "REPLICATE_API_TOKEN is not set on the server");

    const styleId = String(req.body?.styleId || "magic");
    const imageInput = bufferToDataUri(req.file.buffer, req.file.mimetype);

    const input = {
      prompt: stylePrompt(styleId),
      aspect_ratio: REPLICATE_IMAGE_ASPECT_RATIO,
      steps: REPLICATE_IMAGE_STEPS,
      guidance: REPLICATE_IMAGE_GUIDANCE,
      output_format: "png",
    };
    // dynamic image field name
    input[IMG_INPUT_KEY] = imageInput;

    const pred = await replicateCreatePrediction({
      versionId: REPLICATE_IMAGE_VERSION_ID,
      modelOwner: REPLICATE_IMAGE_OWNER,
      modelName: REPLICATE_IMAGE_MODEL,
      input,
      preferWaitSec: 60,
      timeoutMs: REPLICATE_IMAGE_TIMEOUT_MS,
    });

    const predId = pred?.id;
    const status = pred?.status;

    let finalPred = pred;
    if (predId && status !== "succeeded" && status !== "failed" && status !== "canceled") {
      finalPred = await replicateWaitForResult(predId, { timeoutMs: REPLICATE_IMAGE_TIMEOUT_MS, pollMs: 1200 });
    }

    if (finalPred?.status !== "succeeded") {
      return errJson(res, 500, "Replicate image generation failed", { status: finalPred?.status, detail: finalPred });
    }

    const outUrl = pickFirstOutput(finalPred?.output);
    if (!outUrl) return errJson(res, 500, "Replicate output missing", { detail: finalPred });

    const imgResp = await fetch(outUrl);
    if (!imgResp.ok) {
      const t = (await imgResp.text()).slice(0, 1000);
      return errJson(res, 500, "Failed to download Replicate image", { status: imgResp.status, detail: t });
    }

    const arr = new Uint8Array(await imgResp.arrayBuffer());
    const imgBuf = Buffer.from(arr);

    res.setHeader("X-DM-Image-Provider", "replicate");
    res.setHeader("X-DM-StyleId", styleId);
    res.setHeader("X-DM-Replicate-Model", `${REPLICATE_IMAGE_OWNER}/${REPLICATE_IMAGE_MODEL}`);
    res.setHeader("X-DM-Replicate-Aspect-Ratio", REPLICATE_IMAGE_ASPECT_RATIO);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(imgBuf);
  } catch (e) {
    console.error("/magic error:", e?.detail || e);
    return errJson(res, 500, "Magic failed", { detail: e?.detail || String(e?.message || e) });
  }
});

// POST /video/start
// multipart/form-data: image + styleId (+ optional prompt)
app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) return errJson(res, 400, 'No file uploaded. Use field name "image".');
    if (!REPLICATE_API_TOKEN) return errJson(res, 500, "REPLICATE_API_TOKEN is not set on the server");

    const styleId = String(req.body?.styleId || "magic");
    const imageInput = bufferToDataUri(req.file.buffer, req.file.mimetype);

    // Keep keys generic; many i2v models accept "image" + "prompt".
    const input = {
      image: imageInput,
      prompt: `Create a short 5-second kid-friendly animation based on the drawing. Keep same composition and identity. Style: ${styleId}.`,
      num_frames: 120, // safe hint; ignored if unsupported
    };

    const pred = await replicateCreatePrediction({
      versionId: REPLICATE_VIDEO_VERSION_ID,
      modelOwner: REPLICATE_VIDEO_OWNER,
      modelName: REPLICATE_VIDEO_MODEL,
      input,
      preferWaitSec: 0,
      timeoutMs: 60000,
    });

    return res.json({ ok: true, id: pred?.id, status: pred?.status || "starting" });
  } catch (e) {
    console.error("/video/start error:", e?.detail || e);
    return errJson(res, 500, "Video start failed", { detail: e?.detail || String(e?.message || e) });
  }
});

// GET /video/status?id=...
app.get("/video/status", async (req, res) => {
  try {
    const id = String(req.query?.id || "").trim();
    if (!id) return errJson(res, 400, "Missing id");
    if (!REPLICATE_API_TOKEN) return errJson(res, 500, "REPLICATE_API_TOKEN is not set on the server");

    const pred = await replicateGetPrediction(id, VIDEO_STATUS_TIMEOUT_MS);
    const status = pred?.status || "unknown";

    const outUrl = pickFirstOutput(pred?.output);
    return res.json({
      ok: true,
      id,
      status,
      output: outUrl || null,
      detail: status === "failed" ? pred : undefined,
    });
  } catch (e) {
    console.error("/video/status error:", e?.detail || e);
    return errJson(res, 500, "Video status failed", { detail: e?.detail || String(e?.message || e) });
  }
});

// Start listening (Cloud Run needs 0.0.0.0 + PORT)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[DM-2026] ${VERSION} listening on 0.0.0.0:${PORT}`);
  console.log(`[DM-2026] Image: ${REPLICATE_IMAGE_OWNER}/${REPLICATE_IMAGE_MODEL} (version=${REPLICATE_IMAGE_VERSION_ID || "model"}) key=${IMG_INPUT_KEY}`);
  console.log(`[DM-2026] Video: ${REPLICATE_VIDEO_OWNER}/${REPLICATE_VIDEO_MODEL} (version=${REPLICATE_VIDEO_VERSION_ID || "model"})`);
});
