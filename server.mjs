// DM-2026 Production Backend (Replicate ONLY) — v4
// Fixes:
// 1) "Invalid image data" -> detect real image mime (iOS often sends application/octet-stream)
// 2) WAN video schema keys -> uses num_frames + frames_per_second (not seconds/fps)
// 3) Budget guardrails -> default 480p, 81 frames (~5s @16fps), interpolate_output=false

import express from "express";
import multer from "multer";

const app = express();
app.disable("x-powered-by");

app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: false, limit: "12mb" }));

const upload = multer({ limits: { fileSize: 12 * 1024 * 1024 } });

const env = (k, d = undefined) => (process.env[k] ?? d);

const REPLICATE_API_TOKEN = env("REPLICATE_API_TOKEN");
if (!REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN is required");

// Image model (Flux etc.)
const REPLICATE_IMAGE_OWNER = env("REPLICATE_IMAGE_OWNER");
const REPLICATE_IMAGE_MODEL = env("REPLICATE_IMAGE_MODEL");

// Video model (WAN)
const REPLICATE_VIDEO_OWNER = env("REPLICATE_VIDEO_OWNER", env("REPLICATE_OWNER"));
const REPLICATE_VIDEO_MODEL = env("REPLICATE_VIDEO_MODEL", env("REPLICATE_MODEL"));

// Input keys
const IMG_INPUT_KEY = env("IMG_INPUT_KEY", "image_prompt"); // for FLUX Ultra i2i: image_prompt
const VIDEO_INPUT_KEY = env("VIDEO_INPUT_KEY", "image");    // for WAN i2v: image

// Prompt keys
const IMG_PROMPT_KEY = env("IMG_PROMPT_KEY", "prompt");
const IMG_NEG_PROMPT_KEY = env("IMG_NEG_PROMPT_KEY", "negative_prompt");
const VIDEO_PROMPT_KEY = env("VIDEO_PROMPT_KEY", "prompt"); // REQUIRED for WAN

// Image tuning (keep moderate for cost)
const IMAGE_STEPS = Number(env("IMAGE_STEPS", "24"));
const IMAGE_GUIDANCE = Number(env("IMAGE_GUIDANCE", "4.5"));
const IMAGE_ASPECT_RATIO = env("IMAGE_ASPECT_RATIO", "3:2");
const IMAGE_PROMPT_STRENGTH = Number(env("IMAGE_PROMPT_STRENGTH", "0.25")); // Flux Ultra has image_prompt_strength

// Video tuning (WAN schema)
const VIDEO_RESOLUTION = env("VIDEO_RESOLUTION", "480p");
const VIDEO_FPS = clampInt(env("VIDEO_FPS", "16"), 5, 30, 16);
const VIDEO_NUM_FRAMES = clampInt(env("VIDEO_NUM_FRAMES", "81"), 81, 121, 81); // ~5s @16fps
const VIDEO_GO_FAST = env("VIDEO_GO_FAST", "true") === "true";
const VIDEO_INTERPOLATE = env("VIDEO_INTERPOLATE", "false") === "true";

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ---- MIME sniffing (critical for iOS uploads) ----
function sniffMime(buf) {
  if (!buf || buf.length < 12) return "application/octet-stream";
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const pngSig = [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a];
  let isPng = true;
  for (let i=0;i<pngSig.length;i++) if (buf[i] !== pngSig[i]) { isPng = false; break; }
  if (isPng) return "image/png";
  // GIF: "GIF87a" or "GIF89a"
  const h6 = buf.subarray(0, 6).toString("ascii");
  if (h6 === "GIF87a" || h6 === "GIF89a") return "image/gif";
  // WEBP: "RIFF....WEBP"
  const riff = buf.subarray(0, 4).toString("ascii");
  const webp = buf.subarray(8, 12).toString("ascii");
  if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  return "application/octet-stream";
}

function toDataUrl(file) {
  const mime = sniffMime(file.buffer) || file.mimetype || "application/octet-stream";
  const b64 = file.buffer.toString("base64");
  return `data:${mime};base64,${b64}`;
}

// ---- Prompt helpers ----
function stylePrompt(styleId) {
  switch ((styleId || "").toLowerCase()) {
    case "anime":
      return "clean kid-friendly anime style, crisp lineart, smooth cel shading, bright but premium colors";
    case "pixar":
      return "premium kid-friendly 3d animation look, soft gradients, clean edges, gentle lighting, no realism";
    default:
      return "premium kids illustration style, crisp clean lineart, smooth clean fills, gentle shading, vibrant but tasteful colors";
  }
}

function baseStructureLock() {
  return [
    "Keep the exact same composition and framing as the input drawing.",
    "Do NOT zoom, do NOT crop, do NOT rotate, do NOT shift the subject.",
    "Do NOT add new objects, characters, text, borders, or stickers.",
    "Fill the canvas fully, no white margins, no empty paper areas.",
    "Preserve the child drawing identity (same pose, silhouette, proportions).",
    "Improve quality only: clean lines, better colors, neat shading."
  ].join(" ");
}

// ---- Replicate HTTP ----
async function replicateCreatePrediction(owner, model, input) {
  if (!owner || !model) throw new Error("Replicate model env is missing (owner/model)");
  const url = `https://api.replicate.com/v1/models/${owner}/${model}/predictions`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ input })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Replicate create failed: ${t}`);
  }
  return r.json();
}

async function replicateGetPrediction(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Replicate status failed: ${t}`);
  }
  return r.json();
}

// ---- Routes ----
app.get("/", (req, res) => res.status(200).send("DM-2026 backend: OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));
app.get("/me", (req, res) =>
  res.status(200).json({
    service: "backend",
    mode: "replicate",
    ok: true,
    image: { owner: REPLICATE_IMAGE_OWNER || null, model: REPLICATE_IMAGE_MODEL || null, img_input_key: IMG_INPUT_KEY },
    video: { owner: REPLICATE_VIDEO_OWNER || null, model: REPLICATE_VIDEO_MODEL || null, video_input_key: VIDEO_INPUT_KEY },
    video_defaults: { resolution: VIDEO_RESOLUTION, frames_per_second: VIDEO_FPS, num_frames: VIDEO_NUM_FRAMES, go_fast: VIDEO_GO_FAST, interpolate_output: VIDEO_INTERPOLATE }
  })
);

// IMAGE start (returns id)
app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "image required" });
    const styleId = String(req.body.styleId || "");

    const imageDataUrl = toDataUrl(req.file);
    const prompt = `${baseStructureLock()} ${stylePrompt(styleId)}`;

    const input = {
      [IMG_INPUT_KEY]: imageDataUrl,
      [IMG_PROMPT_KEY]: prompt,
      [IMG_NEG_PROMPT_KEY]: "zoomed in, cropped, out of frame, extra objects, text, watermark, border, white margin, empty paper",
      steps: IMAGE_STEPS,
      guidance: IMAGE_GUIDANCE,
      aspect_ratio: IMAGE_ASPECT_RATIO,
      image_prompt_strength: IMAGE_PROMPT_STRENGTH
    };

    const pred = await replicateCreatePrediction(REPLICATE_IMAGE_OWNER, REPLICATE_IMAGE_MODEL, input);
    res.status(200).json({ ok: true, id: pred.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// IMAGE status
app.get("/magic/status", async (req, res) => {
  try {
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const pred = await replicateGetPrediction(id);
    res.status(200).json({ ok: true, status: pred.status, output: pred.output ?? null, error: pred.error ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// VIDEO start (WAN schema)
app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "image required" });
    const styleId = String(req.body.styleId || "");

    const imageDataUrl = toDataUrl(req.file);
    const prompt = `${baseStructureLock()} ${stylePrompt(styleId)} subtle smooth motion, gentle camera drift, tiny magical particles`;

    const input = {
      [VIDEO_INPUT_KEY]: imageDataUrl,
      [VIDEO_PROMPT_KEY]: prompt,
      num_frames: VIDEO_NUM_FRAMES,
      frames_per_second: VIDEO_FPS,
      resolution: VIDEO_RESOLUTION,
      go_fast: VIDEO_GO_FAST,
      interpolate_output: VIDEO_INTERPOLATE
    };

    const pred = await replicateCreatePrediction(REPLICATE_VIDEO_OWNER, REPLICATE_VIDEO_MODEL, input);
    res.status(200).json({
      ok: true,
      id: pred.id,
      resolution: VIDEO_RESOLUTION,
      frames_per_second: VIDEO_FPS,
      num_frames: VIDEO_NUM_FRAMES
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// VIDEO status
app.get("/video/status", async (req, res) => {
  try {
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const pred = await replicateGetPrediction(id);
    res.status(200).json({ ok: true, status: pred.status, output: pred.output ?? null, error: pred.error ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`DM-2026 Replicate backend listening on 0.0.0.0:${PORT}`);
});
