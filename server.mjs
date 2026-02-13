// server.mjs
// DM-2026 Backend v10.0 — Replicate ONLY (Image + Video), Cloud Run stable
//
// Endpoints (unchanged):
//   GET  /, /health, /me
//   POST /magic           (multipart/form-data: image + styleId [+ prompt])
//   POST /video/start     (multipart/form-data: image OR body.imageUrl + optional prompt)
//   GET  /video/status?id=...

import express from "express";
import cors from "cors";
import multer from "multer";

const VERSION = "server.mjs v10.0-dm26 (Replicate ONLY, cloud-run stable)";
const PORT = Number(process.env.PORT || 8080);

// ---------- ENV ----------
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 10);

// Replicate token (required)
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";

// Replicate Image model
// You can set either:
// A) Official model endpoint:
//   REPLICATE_IMAGE_OWNER + REPLICATE_IMAGE_MODEL
// B) Community version (recommended when model inputs differ a lot):
//   REPLICATE_IMAGE_VERSION_ID + REPLICATE_IMAGE_OWNER + REPLICATE_IMAGE_MODEL  (used via /v1/predictions)
const REPLICATE_IMAGE_OWNER = process.env.REPLICATE_IMAGE_OWNER || "black-forest-labs";
const REPLICATE_IMAGE_MODEL = process.env.REPLICATE_IMAGE_MODEL || "flux-dev";
const REPLICATE_IMAGE_VERSION_ID = process.env.REPLICATE_IMAGE_VERSION_ID || "";

// IMPORTANT: different Replicate image models use different input keys for the image.
// Common keys: "image", "image_prompt", "init_image", "input_image".
// Put what YOUR model expects into IMG_INPUT_KEY.
// Default tries "image".
const IMG_INPUT_KEY = process.env.IMG_INPUT_KEY || "image";

// Optional: some models accept "action" (e.g. "edit", "inpaint"). Leave empty if unknown.
const IMG_ACTION = process.env.IMG_ACTION || "";

// Output framing control (helps avoid zoom/crop and white margins)
const REPLICATE_IMAGE_ASPECT_RATIO = process.env.REPLICATE_IMAGE_ASPECT_RATIO || "3:2"; // wide
const REPLICATE_IMAGE_STEPS = Number(process.env.REPLICATE_IMAGE_STEPS || 24);
const REPLICATE_IMAGE_GUIDANCE = Number(process.env.REPLICATE_IMAGE_GUIDANCE || 3.5);
const REPLICATE_IMAGE_TIMEOUT_MS = Number(process.env.REPLICATE_IMAGE_TIMEOUT_MS || 120000);

// Replicate Video model (your current i2v)
const REPLICATE_VIDEO_OWNER = process.env.REPLICATE_OWNER || "wan-video";
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_MODEL || "wan-2.2-i2v-fast";
const REPLICATE_VIDEO_VERSION_ID = process.env.REPLICATE_VERSION_ID || ""; // optional
const VIDEO_TIMEOUT_MS = Number(process.env.VIDEO_TIMEOUT_MS || 60000);

// ---------- app ----------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

function errJson(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

function getText(req, key) {
  const v = req.body?.[key];
  if (v === undefined || v === null) return "";
  return String(v);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
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

// ---------- prompts (Replicate) ----------
function baseStructureLock() {
  return (
    "This is a child's drawing photo. Transform it into a clean, colorful, premium finished illustration, " +
    "but KEEP EXACT STRUCTURE and identity.\n\n" +
    "ABSOLUTE MUST KEEP (structure lock):\n" +
    "- Same subject and identity (if it's a bear, it stays the SAME bear).\n" +
    "- Same pose, silhouette, proportions, and placement.\n" +
    "- Same composition and framing (NO zoom, NO crop, NO camera change).\n" +
    "- Same number of objects/elements.\n" +
    "- Keep background layout the same.\n\n" +
    "FILL CANVAS:\n" +
    "- Output must fill the entire canvas edge-to-edge.\n" +
    "- NO empty white margins.\n" +
    "- If there is extra space, EXTEND existing background (sky/sea/ground) naturally.\n\n" +
    "DO:\n" +
    "- Redraw with confident clean outlines.\n" +
    "- Add vibrant kid-friendly colors, smooth shading, subtle highlights.\n" +
    "- Remove paper texture, dirt, blur, glare.\n\n" +
    "DO NOT:\n" +
    "- Add/remove objects, text, watermark.\n" +
    "- Change identity/species.\n" +
    "- Change framing."
  );
}

function stylePromptReplicate(styleId = "magic") {
  const base = baseStructureLock();
  const styles = {
    magic: "STYLE: premium kids magical illustration, subtle glow, smooth gradients, expensive iOS look.",
    watercolor: "STYLE: high-end watercolor illustration, controlled washes, clean edges, soft paper feel.",
    cartoon: "STYLE: premium modern cartoon, clean edges, soft cel shading, warm palette.",
    clay: "STYLE: stylized clay-toy look (not realistic), soft studio lighting, rounded forms.",
    three_d: "STYLE: stylized 3D animated movie look (not realistic), smooth materials, soft lighting.",
  };
  const s = styles[String(styleId || "magic")] || styles.magic;
  return `${base}\n\n${s}`;
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "doodle-magic-backend",
    version: VERSION,
    openai: { enabled: false },
    replicate: {
      enabled: Boolean(REPLICATE_API_TOKEN),
      image: {
        owner: REPLICATE_IMAGE_OWNER,
        model: REPLICATE_IMAGE_MODEL,
        version_id: REPLICATE_IMAGE_VERSION_ID || null,
        img_input_key: IMG_INPUT_KEY,
        aspect_ratio: REPLICATE_IMAGE_ASPECT_RATIO,
        steps: REPLICATE_IMAGE_STEPS,
        guidance: REPLICATE_IMAGE_GUIDANCE,
        action: IMG_ACTION || null,
      },
      video: {
        owner: REPLICATE_VIDEO_OWNER,
        model: REPLICATE_VIDEO_MODEL,
        version_id: REPLICATE_VIDEO_VERSION_ID || null,
      },
    },
  });
});

app.get("/health", (req, res) => res.json({ ok: true, version: VERSION }));

app.get("/me", (req, res) => {
  res.json({
    ok: true,
    service: "doodle-magic-backend",
    version: VERSION,
    openai: { enabled: false },
    replicate: {
      enabled: Boolean(REPLICATE_API_TOKEN),
      image_model: `${REPLICATE_IMAGE_OWNER}/${REPLICATE_IMAGE_MODEL}`,
      image_version_id: REPLICATE_IMAGE_VERSION_ID || null,
      img_input_key: IMG_INPUT_KEY,
      image_timeout_ms: REPLICATE_IMAGE_TIMEOUT_MS,
      video_model: `${REPLICATE_VIDEO_OWNER}/${REPLICATE_VIDEO_MODEL}`,
      video_version_id: REPLICATE_VIDEO_VERSION_ID || null,
      video_timeout_ms: VIDEO_TIMEOUT_MS,
    },
    limits: { max_upload_mb: MAX_UPLOAD_MB },
  });
});

// ---------- POST /magic (Replicate ONLY) ----------
app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) return errJson(res, 500, "REPLICATE_API_TOKEN is not set on the server");
    if (!req.file?.buffer) return errJson(res, 400, 'No file uploaded. Use field name "image".');

    const styleId = String(req.body?.styleId || "magic");
    const userPrompt = getText(req, "prompt").trim();
    const prompt = userPrompt ? `${stylePromptReplicate(styleId)}\n\nExtra request: ${userPrompt}` : stylePromptReplicate(styleId);

    const imageData = bufferToDataUri(req.file.buffer, req.file.mimetype);

    // Build input with configurable image key
    const input = {
      prompt,
      aspect_ratio: REPLICATE_IMAGE_ASPECT_RATIO,
      steps: REPLICATE_IMAGE_STEPS,
      guidance: REPLICATE_IMAGE_GUIDANCE,
      output_format: "png",
    };

    // put image into the key model expects
    input[IMG_INPUT_KEY] = imageData;

    // optional action
    if (IMG_ACTION) input["action"] = IMG_ACTION;

    // Start URL (official vs community)
    const isCommunity = Boolean(REPLICATE_IMAGE_VERSION_ID);
    const url = isCommunity
      ? "https://api.replicate.com/v1/predictions"
      : `https://api.replicate.com/v1/models/${encodeURIComponent(REPLICATE_IMAGE_OWNER)}/${encodeURIComponent(REPLICATE_IMAGE_MODEL)}/predictions`;

    const payload = isCommunity
      ? { version: `${REPLICATE_IMAGE_OWNER}/${REPLICATE_IMAGE_MODEL}:${REPLICATE_IMAGE_VERSION_ID}`, input }
      : { input };

    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
          Prefer: "wait=60",
        },
        body: JSON.stringify(payload),
      },
      REPLICATE_IMAGE_TIMEOUT_MS
    );

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return errJson(res, resp.status, "Replicate image failed", { detail: data });

    const outUrl = pickFirstOutput(data?.output);
    if (!outUrl) return errJson(res, 500, "Replicate image output missing", { detail: data });

    const imgResp = await fetchWithTimeout(outUrl, { method: "GET" }, 60000);
    if (!imgResp.ok) {
      const t = (await imgResp.text()).slice(0, 1000);
      return errJson(res, 500, "Failed to download Replicate image", { status: imgResp.status, detail: t });
    }

    const arr = new Uint8Array(await imgResp.arrayBuffer());
    const imgBuf = Buffer.from(arr);

    res.setHeader("X-DM-Image-Provider", "replicate");
    res.setHeader("X-DM-StyleId", styleId);
    res.setHeader("X-DM-Replicate-Model", `${REPLICATE_IMAGE_OWNER}/${REPLICATE_IMAGE_MODEL}`);
    res.setHeader("X-DM-Img-Input-Key", IMG_INPUT_KEY);
    res.setHeader("X-DM-Aspect-Ratio", REPLICATE_IMAGE_ASPECT_RATIO);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(imgBuf);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Timeout while generating image" : String(e?.message || e);
    return errJson(res, 500, msg);
  }
});

// ---------- Video ----------
// POST /video/start
app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) return errJson(res, 500, "REPLICATE_API_TOKEN is not set on the server");

    const imageUrl = getText(req, "imageUrl").trim();
    let imageInput = "";

    if (imageUrl) {
      imageInput = imageUrl;
    } else if (req.file?.buffer) {
      imageInput = bufferToDataUri(req.file.buffer, req.file.mimetype || "image/png");
    } else {
      return errJson(res, 400, 'Send imageUrl OR upload file with field name "image".');
    }

    const prompt = getText(req, "prompt").trim() || "Subtle gentle animation, keep composition, smooth 5 second motion.";
    const negativePrompt = getText(req, "negativePrompt").trim() || "nsfw, nude, violence, scary, horror";

    const seconds = clampNumber(getText(req, "seconds") || 5, 1, 6, 5);
    const fps = clampInt(getText(req, "fps") || 16, 5, 24, 16);
    const numFrames = clampInt(Math.round(seconds * fps), 5, 120, Math.round(5 * 16));

    const steps = clampInt(getText(req, "steps") || 20, 1, 40, 20);
    const guidance = clampNumber(getText(req, "guidance") || 5, 0, 10, 5);

    const modelFull = `${REPLICATE_VIDEO_OWNER}/${REPLICATE_VIDEO_MODEL}`;
    const isCommunity = Boolean(REPLICATE_VIDEO_VERSION_ID);

    const url = isCommunity
      ? "https://api.replicate.com/v1/predictions"
      : `https://api.replicate.com/v1/models/${encodeURIComponent(REPLICATE_VIDEO_OWNER)}/${encodeURIComponent(REPLICATE_VIDEO_MODEL)}/predictions`;

    const input = {
      image: imageInput,
      prompt,
      negative_prompt: negativePrompt,
      num_frames: numFrames,
      frames_per_second: fps,
      sample_steps: steps,
      sample_guide_scale: guidance,
    };

    const payload = isCommunity ? { version: `${modelFull}:${REPLICATE_VIDEO_VERSION_ID}`, input } : { input };

    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
          Prefer: "wait=10",
        },
        body: JSON.stringify(payload),
      },
      VIDEO_TIMEOUT_MS
    );

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return errJson(res, resp.status, "Replicate start failed", { status: resp.status, detail: data });

    return res.json({ ok: true, id: data?.id, status: data?.status });
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Timeout while calling Replicate start" : String(e?.message || e);
    return errJson(res, 500, msg);
  }
});

// GET /video/status?id=...
app.get("/video/status", async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN) return errJson(res, 500, "REPLICATE_API_TOKEN is not set on the server");

    const id = String(req.query?.id || "").trim();
    if (!id) return errJson(res, 400, "Missing id");

    const url = `https://api.replicate.com/v1/predictions/${encodeURIComponent(id)}`;
    const resp = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` } }, 30000);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return errJson(res, resp.status, "Replicate status failed", { status: resp.status, detail: data });

    if (data?.status === "succeeded") {
      const output = Array.isArray(data.output) ? data.output[0] || null : data.output || null;
      return res.json({ ok: true, status: "succeeded", output });
    }

    return res.json({ ok: true, status: data?.status || "processing" });
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Timeout while calling Replicate status" : String(e?.message || e);
    return errJson(res, 500, msg);
  }
});

// Cloud Run: listen on 0.0.0.0:PORT
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[${VERSION}] listening on ${PORT}`);
});
