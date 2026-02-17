// DM-2026 backend — FIXED VERSION (Replicate requires version only)
// ControlNet SDXL — strict structure lock
// ERROR FIX: always sends { version, input } (never { model })

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 IMAGE v2.1 (version-required fix)";

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 8080);

// ===== REPLICATE =====
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";

// IMPORTANT:
// This model REQUIRES version. Do NOT leave empty.
const REPLICATE_IMAGE_VERSION =
  (process.env.REPLICATE_IMAGE_VERSION ||
   "3bb13fe1c33c35987b33792b01b71ed6529d03f165d1c2416375859f09ca9fef").trim();

const SD_STEPS = Number(process.env.SD_STEPS || 22);
const SD_GUIDANCE_SCALE = Number(process.env.SD_GUIDANCE_SCALE || 6.5);
const SD_STRENGTH = Number(process.env.SD_PROMPT_STRENGTH || 0.32);
const SD_CONDITION_SCALE = Number(process.env.SD_CONDITION_SCALE || 0.85);

const SD_NEGATIVE_PROMPT =
  "recomposition, crop, zoom, reframed, different composition, camera change, perspective change, " +
  "new objects, extra objects, extra characters, background replacement, text, watermark, logo, distorted";

// ===== Upload =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ===== Sharp padding (NO crop) =====
let sharpLib = null;
async function loadSharp() {
  if (!sharpLib) {
    const mod = await import("sharp");
    sharpLib = mod.default;
  }
}

async function padSquare(buf) {
  await loadSharp();
  return sharpLib(buf)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({ width: 1024, height: 1024, fit: "contain", background: "#ffffff" })
    .png()
    .toBuffer();
}

function bufferToDataUri(buf) {
  return `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ===== Replicate =====
async function replicateCreatePrediction(input) {
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version: REPLICATE_IMAGE_VERSION,
      input,
    }),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.detail || "Replicate error");
  return json;
}

async function replicateGetPrediction(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Replicate error");
  return json;
}

// ===== Routes =====
app.get("/", (_req, res) => res.send("DM-2026 OK"));

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    version: VERSION,
    versionUsed: REPLICATE_IMAGE_VERSION,
    replicateKey: Boolean(REPLICATE_API_TOKEN),
  })
);

app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN)
      return res.status(500).json({ ok: false, error: "Missing REPLICATE_API_TOKEN" });

    const file = req.file;
    if (!file?.buffer)
      return res.status(400).json({ ok: false, error: "Missing image" });

    const locked = await padSquare(file.buffer);
    const dataUri = bufferToDataUri(locked);

    const prompt =
      "High-quality stylization of a children's drawing. " +
      "Preserve EXACT composition, shapes, proportions. " +
      "Do NOT add or remove objects. Do NOT crop. Do NOT zoom. " +
      "Premium smooth coloring, soft lighting.";

    const prediction = await replicateCreatePrediction({
      prompt,
      image: dataUri,
      img2img: true,
      strength: SD_STRENGTH,
      condition_scale: SD_CONDITION_SCALE,
      guidance_scale: SD_GUIDANCE_SCALE,
      num_inference_steps: SD_STEPS,
      negative_prompt: SD_NEGATIVE_PROMPT,
      num_outputs: 1,
      apply_watermark: false,
      refine: "no_refiner",
    });

    let p = prediction;
    const start = Date.now();

    while (true) {
      if (p.status === "succeeded") break;
      if (p.status === "failed") throw new Error(p.error || "Image failed");
      if (Date.now() - start > 180000)
        throw new Error("Timeout");

      await sleep(1000);
      p = await replicateGetPrediction(p.id);
    }

    const outputUrl = Array.isArray(p.output)
      ? p.output[0]
      : p.output;

    return res.json({ ok: true, outputUrl });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ${VERSION}`);
  console.log(`Using version: ${REPLICATE_IMAGE_VERSION}`);
});
