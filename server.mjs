// DM-2026 backend — GPT-IMAGE-1 with aspect-ratio preservation
// Image Mode: OpenAI gpt-image-1 (cheaper + dynamic aspect ratio)
// Video Mode: Replicate (UNCHANGED)

import express from "express";
import multer from "multer";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

// ---------- ENV ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || "medium";
const OPENAI_OUTPUT_FORMAT = process.env.OPENAI_OUTPUT_FORMAT || "png";

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_VIDEO_OWNER = process.env.REPLICATE_VIDEO_OWNER || "wan-video";
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_VIDEO_MODEL || "wan-2.2-i2v-fast";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 }});

const magicJobs = new Map();

function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0];
  const host = (req.headers["x-forwarded-host"] || req.get("host")).split(",")[0];
  return `${proto}://${host}`;
}

// ---------- OpenAI loader ----------
let _OpenAI = null;
let _toFile = null;
let _sharp = null;

async function loadOpenAI() {
  if (_OpenAI) return;
  const mod = await import("openai");
  _OpenAI = mod.default;
  _toFile = mod.toFile || (await import("openai/uploads")).toFile;
}

async function loadSharp() {
  if (_sharp) return;
  const mod = await import("sharp");
  _sharp = mod.default || mod;
}

async function getClient() {
  await loadOpenAI();
  return new _OpenAI({ apiKey: OPENAI_API_KEY });
}

// ---------- Image Magic ----------
async function runMagic(jobId, file) {
  try {
    const client = await getClient();
    await loadSharp();

    const meta = await _sharp(file.buffer).metadata();
    const aspect = (meta.width || 1) / (meta.height || 1);

    // Choose closest supported size while preserving ratio
    let size = "1024x1024";
    if (aspect > 1.2) size = "1536x1024";        // landscape
    else if (aspect < 0.8) size = "1024x1536";   // portrait

    const resized = await _sharp(file.buffer)
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();

    const openaiFile = await _toFile(resized, "input.png", { type: "image/png" });

    const prompt = "Redraw this child's drawing as a premium clean illustration. Preserve structure 1:1. No crop, no zoom, no extra objects.";

    const result = await client.images.edit({
      model: OPENAI_IMAGE_MODEL,
      image: openaiFile,
      prompt,
      size,
      quality: OPENAI_IMAGE_QUALITY,
      output_format: OPENAI_OUTPUT_FORMAT,
    });

    const item = result?.data?.[0];
    let bytes = null;
    if (item?.b64_json) bytes = Buffer.from(item.b64_json, "base64");

    magicJobs.set(jobId, { status: "succeeded", bytes, mime: "image/png" });
  } catch (e) {
    magicJobs.set(jobId, { status: "failed", error: String(e) });
  }
}

// ---------- Routes ----------
app.get("/", (_, res) => res.send("DM-2026 backend ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/magic", upload.single("image"), async (req, res) => {
  const id = crypto.randomUUID();
  magicJobs.set(id, { status: "processing" });
  runMagic(id, req.file);
  res.json({ ok: true, id });
});

app.get("/magic/status", (req, res) => {
  const job = magicJobs.get(req.query.id);
  if (!job) return res.json({ ok: true, status: "failed" });
  const outputUrl = job.status === "succeeded"
    ? `${getBaseUrl(req)}/magic/result?id=${req.query.id}`
    : null;
  res.json({ ok: true, status: job.status, outputUrl });
});

app.get("/magic/result", (req, res) => {
  const job = magicJobs.get(req.query.id);
  if (!job?.bytes) return res.status(404).send("Not ready");
  res.setHeader("Content-Type", "image/png");
  res.send(job.bytes);
});

// ---------- VIDEO (unchanged logic) ----------
app.post("/video/start", upload.single("image"), async (req, res) => {
  const response = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: `${REPLICATE_VIDEO_OWNER}/${REPLICATE_VIDEO_MODEL}`,
      input: { image: `data:image/png;base64,${req.file.buffer.toString("base64")}` },
    }),
  });
  const json = await response.json();
  res.json({ ok: true, id: json.id });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("DM-2026 running on port", PORT);
});
