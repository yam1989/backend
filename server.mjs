// DM-2026 backend (OpenAI Image via images.generate + Replicate Video)
// Stable version — no images.edit, no dall-e-2, no file-type errors

import express from "express";
import multer from "multer";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");

const PORT = parseInt(process.env.PORT || "8080", 10);

// ===== ENV =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "1024x1024";

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_VIDEO_OWNER = process.env.REPLICATE_VIDEO_OWNER || "wan-video";
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_VIDEO_MODEL || "wan-2.2-i2v-fast";
const REPLICATE_VIDEO_VERSION = process.env.REPLICATE_VIDEO_VERSION || "";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ===== UTIL =====
function bufferToBase64(buffer) {
  return buffer.toString("base64");
}

function bufferToDataUri(buffer, mime) {
  const safeMime = mime && mime.includes("/") ? mime : "image/png";
  return `data:${safeMime};base64,${bufferToBase64(buffer)}`;
}

let OpenAIClient = null;
async function getOpenAI() {
  if (!OpenAIClient) {
    const mod = await import("openai");
    OpenAIClient = mod.default;
  }
  return new OpenAIClient({ apiKey: OPENAI_API_KEY });
}

const magicJobs = new Map();

// ===== BASIC ROUTES =====
app.get("/", (_req, res) => res.send("DM-2026 backend running"));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    openaiKey: Boolean(OPENAI_API_KEY),
    replicateKey: Boolean(REPLICATE_API_TOKEN),
  });
});

app.get("/me", (_req, res) => {
  res.json({
    ok: true,
    imageModel: OPENAI_IMAGE_MODEL,
    videoModel: REPLICATE_VIDEO_MODEL,
  });
});

// ===== IMAGE MAGIC (OpenAI images.generate) =====
app.post("/magic", upload.single("image"), async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: "OPENAI_API_KEY missing" });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ ok: false, error: "No image provided" });
  }

  const id = crypto.randomUUID();
  magicJobs.set(id, { status: "processing" });

  (async () => {
    try {
      const openai = await getOpenAI();

      const prompt = `
Redraw this child's drawing as a premium clean illustration.
CRITICAL:
- Preserve structure 1:1
- Do NOT change pose
- Do NOT zoom or crop
- Do NOT add objects
- No borders or white margins
Clean lines, smooth fills, soft subtle shading.
`;

      const base64Image = bufferToBase64(file.buffer);

      const result = await openai.images.generate({
        model: OPENAI_IMAGE_MODEL,
        prompt,
        size: OPENAI_IMAGE_SIZE,
        image: base64Image
      });

      const b64 = result.data[0].b64_json;
      const buffer = Buffer.from(b64, "base64");

      magicJobs.set(id, {
        status: "succeeded",
        buffer,
      });
    } catch (e) {
      magicJobs.set(id, {
        status: "failed",
        error: e.message,
      });
    }
  })();

  res.json({ ok: true, id });
});

app.get("/magic/status", (req, res) => {
  const id = req.query.id;
  const job = magicJobs.get(id);

  if (!job) {
    return res.json({ ok: true, status: "failed", error: "Not found" });
  }

  if (job.status === "succeeded") {
    return res.json({
      ok: true,
      status: "succeeded",
      outputUrl: `/magic/result?id=${id}`,
    });
  }

  if (job.status === "failed") {
    return res.json({
      ok: true,
      status: "failed",
      error: job.error,
    });
  }

  res.json({ ok: true, status: "processing" });
});

app.get("/magic/result", (req, res) => {
  const id = req.query.id;
  const job = magicJobs.get(id);

  if (!job || job.status !== "succeeded") {
    return res.status(404).send("Not ready");
  }

  res.setHeader("Content-Type", "image/png");
  res.send(job.buffer);
});

// ===== VIDEO MAGIC (Replicate wan-2.2-i2v-fast) =====
async function replicateCreatePrediction(input) {
  const body = REPLICATE_VIDEO_VERSION
    ? { version: REPLICATE_VIDEO_VERSION, input }
    : { model: `${REPLICATE_VIDEO_OWNER}/${REPLICATE_VIDEO_MODEL}`, input };

  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await r.json();
  if (!r.ok) throw new Error(json.detail || json.error || "Replicate error");
  return json;
}

async function replicateGetPrediction(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
  });

  const json = await r.json();
  if (!r.ok) throw new Error(json.detail || json.error || "Replicate error");
  return json;
}

app.post("/video/start", upload.single("image"), async (req, res) => {
  if (!REPLICATE_API_TOKEN) {
    return res.status(500).json({ ok: false, error: "REPLICATE_API_TOKEN missing" });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ ok: false, error: "No image provided" });
  }

  try {
    const dataUri = bufferToDataUri(file.buffer, file.mimetype);

    const prediction = await replicateCreatePrediction({
      image: dataUri,
      prompt: "Subtle cinematic animation, preserve original drawing 1:1"
    });

    res.json({ ok: true, id: prediction.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/video/status", async (req, res) => {
  try {
    const prediction = await replicateGetPrediction(req.query.id);

    const status = prediction.status;
    const output = prediction.output;

    const outputUrl = Array.isArray(output)
      ? output[0]
      : output?.url || output || null;

    res.json({
      ok: true,
      status,
      outputUrl,
      error: prediction.error || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server listening on", PORT);
});
