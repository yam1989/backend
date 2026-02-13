// server.mjs
// DM-2026 Backend v9.0 (Full endpoints, cheaper images)
// Image Magic:
//   - Default: Replicate image model (cheap, ~2–5¢), keeps aspect ratio 3:2 to avoid zoom/crop
//   - Optional Premium: OpenAI Responses image_generation (expensive, can be enabled per-style via env)
// Video Magic: Replicate i2v (wan-2.2-i2v-fast)
//
// Endpoints (unchanged):
//   GET  /, /health, /me
//   POST /magic
//   POST /video/start
//   GET  /video/status?id=...

import express from "express";
import cors from "cors";
import multer from "multer";

const VERSION = "server.mjs v9.1-dm26 (Replicate default, OpenAI gated, fill canvas)";
const PORT = Number(process.env.PORT || 8080);

// ---------- ENV ----------
// OpenAI (optional, premium)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const RESP_MODEL = process.env.RESP_MODEL || "gpt-4.1-mini";
const OA_IMG_SIZE = process.env.IMG_SIZE || "1536x1024";
const OA_IMG_QUALITY = process.env.IMG_QUALITY || "medium";
const OA_IMG_INPUT_FIDELITY = process.env.IMG_INPUT_FIDELITY || "high";
const OA_IMG_ACTION = process.env.IMG_ACTION || "edit";
const MAGIC_TIMEOUT_MS = Number(process.env.MAGIC_TIMEOUT_MS || 180000);

// Which styles should use OpenAI (comma-separated). Example: "magic,watercolor"
const OPENAI_IMAGE_STYLES = (process.env.OPENAI_IMAGE_STYLES || "").split(",").map(s => s.trim()).filter(Boolean);
const ENABLE_OPENAI_IMAGE = String(process.env.ENABLE_OPENAI_IMAGE || "").toLowerCase() === "true";

// Replicate (shared token)
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";

// Replicate video (unchanged)
const REPLICATE_VIDEO_OWNER = process.env.REPLICATE_OWNER || "wan-video";
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_MODEL || "wan-2.2-i2v-fast";
const REPLICATE_VIDEO_VERSION_ID = process.env.REPLICATE_VERSION_ID || ""; // optional
const VIDEO_TIMEOUT_MS = Number(process.env.VIDEO_TIMEOUT_MS || 60000);

// Replicate image (cheap) — used by default for ALL image styles unless style is in OPENAI_IMAGE_STYLES
const REPLICATE_IMAGE_OWNER = process.env.REPLICATE_IMAGE_OWNER || "black-forest-labs";
const REPLICATE_IMAGE_MODEL = process.env.REPLICATE_IMAGE_MODEL || "flux-dev";
// ask model to keep wide canvas, avoids “left zoom”
const REPLICATE_IMAGE_ASPECT_RATIO = process.env.REPLICATE_IMAGE_ASPECT_RATIO || "3:2"; // wide
// optional: if model supports it; safe to include (ignored if unsupported)
const REPLICATE_IMAGE_NUM_OUTPUTS = Number(process.env.REPLICATE_IMAGE_NUM_OUTPUTS || 1);
const REPLICATE_IMAGE_GUIDANCE = Number(process.env.REPLICATE_IMAGE_GUIDANCE || 3.5);
const REPLICATE_IMAGE_STEPS = Number(process.env.REPLICATE_IMAGE_STEPS || 24);
const REPLICATE_IMAGE_TIMEOUT_MS = Number(process.env.REPLICATE_IMAGE_TIMEOUT_MS || 90000);

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 10);

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// ---------- helpers ----------
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

// ----- prompts -----
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

`;
}

function stylePromptReplicate(styleId = "magic") {
  const lock = baseStructureLock();
  const map = {
    magic: `STYLE: premium kids magical illustration, subtle glow, smooth gradients.`,
    watercolor: `STYLE: high-end watercolor illustration, controlled washes, clean edges.`,
    cartoon: `STYLE: premium modern cartoon, soft cel shading, kid-friendly palette.`,
    clay: `STYLE: stylized clay-toy look (not realistic), soft studio lighting.`,
    three_d: `STYLE: stylized 3D animated movie look, smooth materials, soft studio lighting.`,
  };
  return `${lock}\n${map[String(styleId || "magic")] || map.magic}`;
}

function stylePromptOpenAI(styleId = "magic", userPrompt = "") {
  // Keep it short (cheaper tokens)
  const base = `Premium children's book illustrator. Redraw the input drawing into a clean, colorful, high-quality illustration.
Keep exact structure, pose, composition, and identity. No zoom/crop. Do not add/remove objects. Not photorealistic.`;
  const styleHints = {
    magic: "Magical premium kids illustration, subtle glow, smooth gradients.",
    watercolor: "High-end watercolor illustration, controlled washes.",
    cartoon: "Premium modern cartoon, soft cel shading.",
    clay: "Stylized clay-toy look (not realistic).",
    three_d: "Stylized 3D animated film look (not realistic).",
  };
  const extra = userPrompt ? `\nExtra request: ${userPrompt}` : "";
  return `${base}\n${styleHints[String(styleId || "magic")] || styleHints.magic}${extra}`;
}

// ----- replicate output normalize -----
function pickFirstOutput(output) {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output[0] || null;
  // sometimes output is { images: [...] } or similar
  if (typeof output === "object") {
    const urls = output?.images || output?.image || output?.url;
    if (typeof urls === "string") return urls;
    if (Array.isArray(urls)) return urls[0] || null;
  }
  return null;
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "doodle-magic-backend",
    version: VERSION,
    image: {
      default_provider: "replicate",
      openai_styles: OPENAI_IMAGE_STYLES,
      replicate_model: `${REPLICATE_IMAGE_OWNER}/${REPLICATE_IMAGE_MODEL}`,
      replicate_aspect_ratio: REPLICATE_IMAGE_ASPECT_RATIO,
    },
    video: { replicate_model: `${REPLICATE_VIDEO_OWNER}/${REPLICATE_VIDEO_MODEL}` },
  });
});

app.get("/health", (req, res) => res.json({ ok: true, version: VERSION }));

app.get("/me", (req, res) => {
  res.json({
    ok: true,
    service: "doodle-magic-backend",
    version: VERSION,
    openai: {
      enabled: Boolean(OPENAI_API_KEY),
      responses_model: RESP_MODEL,
      tool: {
        type: "image_generation",
        size: OA_IMG_SIZE,
        quality: OA_IMG_QUALITY,
        input_fidelity: OA_IMG_INPUT_FIDELITY,
        action: OA_IMG_ACTION,
      },
      styles: OPENAI_IMAGE_STYLES,
      timeout_ms: MAGIC_TIMEOUT_MS,
    },
    replicate: {
      enabled: Boolean(REPLICATE_API_TOKEN),
      image_model: `${REPLICATE_IMAGE_OWNER}/${REPLICATE_IMAGE_MODEL}`,
      image_aspect_ratio: REPLICATE_IMAGE_ASPECT_RATIO,
      video_model: `${REPLICATE_VIDEO_OWNER}/${REPLICATE_VIDEO_MODEL}`,
      video_timeout_ms: VIDEO_TIMEOUT_MS,
      video_version_id: REPLICATE_VIDEO_VERSION_ID || null,
    },
    limits: { max_upload_mb: MAX_UPLOAD_MB },
  });
});

// POST /magic
// multipart/form-data: image + styleId (+ optional prompt)
app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) return errJson(res, 400, 'No file uploaded. Use field name "image".');

    const styleId = String(req.body?.styleId || "magic");
    const userPrompt = getText(req, "prompt").trim();

    const useOpenAI = ENABLE_OPENAI_IMAGE && OPENAI_IMAGE_STYLES.includes(styleId);

    // ---------- Replicate (default, cheap) ----------
    if (!useOpenAI) {
      if (!REPLICATE_API_TOKEN) return errJson(res, 500, "REPLICATE_API_TOKEN is not set on the server");

      const imageInput = bufferToDataUri(req.file.buffer, req.file.mimetype);

      const payload = {
        input: {
          image: imageInput,
          prompt: stylePromptReplicate(styleId),
          // common optional params (ignored if unsupported)
          aspect_ratio: REPLICATE_IMAGE_ASPECT_RATIO,
          num_outputs: REPLICATE_IMAGE_NUM_OUTPUTS,
          guidance: REPLICATE_IMAGE_GUIDANCE,
          steps: REPLICATE_IMAGE_STEPS,
          output_format: "png",
        },
      };

      const startUrl = `https://api.replicate.com/v1/models/${REPLICATE_IMAGE_OWNER}/${REPLICATE_IMAGE_MODEL}/predictions`;
      const resp = await fetchWithTimeout(
        startUrl,
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
      res.setHeader("X-DM-Replicate-Aspect-Ratio", REPLICATE_IMAGE_ASPECT_RATIO);

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(imgBuf);
    }

    // ---------- OpenAI (premium, expensive) ----------
    if (!OPENAI_API_KEY) return errJson(res, 500, "OPENAI_API_KEY is not set on the server");

    const imageUrl = bufferToDataUri(req.file.buffer, req.file.mimetype);

    const payload = {
      model: RESP_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: stylePromptOpenAI(styleId, userPrompt) },
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ],
      tools: [
        {
          type: "image_generation",
          size: OA_IMG_SIZE,
          quality: OA_IMG_QUALITY,
          input_fidelity: OA_IMG_INPUT_FIDELITY,
          action: OA_IMG_ACTION,
          output_format: "png",
        },
      ],
    };

    const oaResp = await fetchWithTimeout(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      MAGIC_TIMEOUT_MS
    );

    if (!oaResp.ok) {
      const detail = (await oaResp.text()).slice(0, 4000);
      return errJson(res, oaResp.status, "OpenAI Responses image_generation failed", { detail });
    }

    const json = await oaResp.json();
    const imgBase64 = json?.output?.find?.((o) => o?.type === "image_generation_call")?.result || null;
    if (!imgBase64) return errJson(res, 500, "OpenAI response missing image result");

    const imgBuf = Buffer.from(imgBase64, "base64");

    res.setHeader("X-DM-Image-Provider", "openai");
    res.setHeader("X-DM-StyleId", styleId);
    res.setHeader("X-DM-Responses-Model", RESP_MODEL);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(imgBuf);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Timeout while generating image" : String(e?.message || e);
    return errJson(res, 500, msg);
  }
});

// ---------- Video (unchanged) ----------
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
      : `https://api.replicate.com/v1/models/${REPLICATE_VIDEO_OWNER}/${REPLICATE_VIDEO_MODEL}/predictions`;

    const input = {
      image: imageInput,
      prompt,
      negative_prompt: negativePrompt,
      num_frames: numFrames,
      frames_per_second: fps,
      sample_steps: steps,
      sample_guide_scale: guidance,
    };

    const payload = isCommunity
      ? { version: `${modelFull}:${REPLICATE_VIDEO_VERSION_ID}`, input }
      : { input };

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
    if (!resp.ok) {
      return errJson(res, resp.status, "Replicate start failed", { status: resp.status, detail: data });
    }

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
    if (!resp.ok) {
      return errJson(res, resp.status, "Replicate status failed", { status: resp.status, detail: data });
    }

    if (data?.status === "succeeded") {
      const output = Array.isArray(data.output) ? (data.output[0] || null) : (data.output || null);
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
