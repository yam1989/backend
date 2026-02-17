// DM-2026 backend — Cloud Run (Node 20 + Express)
// IMAGE v4.1 (WAU + CLEAN + APP-COMPAT)

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 IMAGE v4.1";

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 8080);

// ===== REPLICATE =====
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const DEFAULT_IMAGE_VERSION = "db2ffdbdc7f6cb4d6dab512434679ee3366ae7ab84f89750f8947d5594b79a47";
const REPLICATE_IMAGE_VERSION = (process.env.REPLICATE_IMAGE_VERSION || DEFAULT_IMAGE_VERSION).trim();

// ===== TUNING =====
const SD_STEPS = Number(process.env.SD_STEPS || 26);
const SD_CONDITION_SCALE = Number(process.env.SD_CONDITION_SCALE || 0.60);
const SD_SEED = Number(process.env.SD_SEED || 0);
const PAD_SIZE = Number(process.env.SD_PAD_SIZE || 768);

const SD_NEGATIVE_PROMPT =
  "photo, photograph, paper texture, scan, grayscale, monochrome, pencil sketch, low quality, blurry, noise, text, watermark";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const magicJobs = new Map();

function bufferToDataUri(buf, mime) {
  return `data:${mime || "image/png"};base64,${Buffer.from(buf).toString("base64")}`;
}

async function replicateCreate(version, input) {
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

function buildPrompt() {
  return `
Transform this child’s drawing into a high-end Pixar-style 3D illustration.
Preserve main structure approximately (minor beautification allowed).
Make it full color, cinematic lighting, soft shadows, smooth gradients.
Clean background. Premium animated movie quality.
`.trim();
}

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

    const pred = await replicateCreate(REPLICATE_IMAGE_VERSION, input);

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

app.get("/me", (_req,res)=>res.json({
  ok:true,
  version: VERSION
}));

app.listen(PORT, "0.0.0.0", () => {
  console.log("WAU MODE v4.1 ACTIVE");
});
