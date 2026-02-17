// DM-2026 backend — Image Mode v4.0 (WAU mode, 95% structure, Pixar-like repaint)
//
// Strategy change:
// - Less strict ControlNet (condition_scale lower)
// - Strong repaint via more steps
// - NO paper-photo look
// - Accept ~3–5% geometric drift for MUCH higher visual quality
//
// Model: lucataco/sdxl-controlnet
// Target: Premium colorful Pixar-style result under ~20s

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 IMAGE v4.0 WAU MODE";

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 8080);

// ===== REPLICATE =====
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const DEFAULT_IMAGE_VERSION = "db2ffdbdc7f6cb4d6dab512434679ee3366ae7ab84f89750f8947d5594b79a47";
const REPLICATE_IMAGE_VERSION = (process.env.REPLICATE_IMAGE_VERSION || DEFAULT_IMAGE_VERSION).trim();

// ===== TUNING (WAU MODE) =====
const SD_STEPS = Number(process.env.SD_STEPS || 26);              // more detail
const SD_CONDITION_SCALE = Number(process.env.SD_CONDITION_SCALE || 0.60); // allow repaint
const SD_SEED = Number(process.env.SD_SEED || 0);
const PAD_SIZE = Number(process.env.SD_PAD_SIZE || 768);

const SD_NEGATIVE_PROMPT =
  "low quality, grayscale, monochrome, sketch, pencil, paper texture, photo, noise, artifacts, blurry, flat lighting";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const magicJobs = new Map();

function bufferToDataUri(buf, mime) {
  return `data:${mime || "image/png"};base64,${Buffer.from(buf).toString("base64")}`;
}

async function replicateCreate({ version, input }) {
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ version, input }),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json?.detail || "Replicate error");
  return json;
}

async function replicateGet(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json?.detail || "Replicate error");
  return json;
}

// ===== PROMPT =====
function buildPrompt() {
  return `
Transform this child’s drawing into a high-end Pixar-style 3D illustration.

Preserve main structure and object positions approximately.
Minor proportional improvements are allowed for aesthetics.

Add rich color, cinematic lighting, soft shadows,
smooth gradients, global illumination, depth,
clean background, premium rendering quality.

Make it look like a frame from a modern animated movie.
`.trim();
}

// ===== ROUTES =====
app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false });

    const image = bufferToDataUri(req.file.buffer, req.file.mimetype);

    const input = {
      image,
      prompt: buildPrompt(),
      negative_prompt: SD_NEGATIVE_PROMPT,
      num_inference_steps: SD_STEPS,
      condition_scale: SD_CONDITION_SCALE,
      seed: SD_SEED,
    };

    const pred = await replicateCreate({
      version: REPLICATE_IMAGE_VERSION,
      input,
    });

    const id = `m_${crypto.randomUUID()}`;
    magicJobs.set(id, { predId: pred.id, status: "processing" });

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/magic/status", async (req, res) => {
  try {
    const id = req.query.id;
    const job = magicJobs.get(id);
    if (!job) return res.json({ ok: true, status: "failed" });

    const p = await replicateGet(job.predId);

    if (p.status === "succeeded") {
      const outputUrl = Array.isArray(p.output) ? p.output[0] : p.output;
      return res.json({ ok: true, status: "succeeded", outputUrl });
    }

    res.json({ ok: true, status: p.status });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("🔥 WAU MODE ACTIVE");
});
