
// DM-2026 backend — IMAGE v5.0 (FLUX WAU MODE)
// Model: black-forest-labs/flux-dev (Replicate)

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 IMAGE v5.0 FLUX WAU";

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 8080);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_IMAGE_MODEL = "black-forest-labs/flux-dev";

const STEPS = Number(process.env.SD_STEPS || 28);
const GUIDANCE = Number(process.env.SD_GUIDANCE || 3.5);
const SEED = Number(process.env.SD_SEED || 0);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const magicJobs = new Map();

function bufferToDataUri(buf, mime) {
  return `data:${mime || "image/png"};base64,${Buffer.from(buf).toString("base64")}`;
}

async function replicateCreate(input) {
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: REPLICATE_IMAGE_MODEL,
      input
    }),
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
Repaint this child's drawing into a premium Pixar-style 3D illustration.
Allow small proportional beautification.
Rich color, cinematic lighting, global illumination,
soft shadows, depth, smooth gradients.
Clean background. No paper texture. Animated movie quality.
`.trim();
}

app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false });

    const image = bufferToDataUri(req.file.buffer, req.file.mimetype);

    const input = {
      image,
      prompt: buildPrompt(),
      num_inference_steps: STEPS,
      guidance_scale: GUIDANCE,
      seed: SEED,
    };

    const pred = await replicateCreate(input);

    const id = `m_${crypto.randomUUID()}`;
    magicJobs.set(id, { predId: pred.id });

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
  console.log("🔥 FLUX WAU MODE ACTIVE");
});
