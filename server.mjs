// DM-2026 backend (OpenAI Image + Replicate Video)
// FIXED: removed unsupported 'quality' parameter from images.edit

import express from "express";
import multer from "multer";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");

const PORT = parseInt(process.env.PORT || "8080", 10);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || "auto";
const OPENAI_IMAGE_OUTPUT_FORMAT = process.env.OPENAI_IMAGE_OUTPUT_FORMAT || "png";

const magicJobs = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

let OpenAIClient = null;
async function getOpenAI() {
  if (!OpenAIClient) {
    const mod = await import("openai");
    OpenAIClient = mod.default;
  }
  return new OpenAIClient({ apiKey: OPENAI_API_KEY });
}

function buildPrompt() {
  return `
Redraw this child's drawing as a premium clean illustration.
CRITICAL:
- Preserve structure 1:1
- Do NOT change pose
- Do NOT zoom or crop
- Do NOT add objects
- No borders or white margins
Clean lines, smooth fills, soft subtle shading.
`;
}

app.get("/", (_req, res) => res.send("DM-2026 backend running"));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    openaiKey: Boolean(OPENAI_API_KEY)
  });
});

app.post("/magic", upload.single("image"), async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: "OPENAI_API_KEY missing" });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ ok: false, error: "No image" });
  }

  const id = crypto.randomUUID();
  magicJobs.set(id, { status: "processing" });

  (async () => {
    try {
      const openai = await getOpenAI();

      const result = await openai.images.edit({
        model: OPENAI_IMAGE_MODEL,
        image: file.buffer,
        prompt: buildPrompt(),
        size: OPENAI_IMAGE_SIZE,
        output_format: OPENAI_IMAGE_OUTPUT_FORMAT
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

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server listening on", PORT);
});
