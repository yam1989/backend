// DM-2026 backend — Cloud Run (Node 20 + Express)
// ✅ Endpoints FIXED (do not change): /, /health, /me, /magic, /magic/status, /magic/result, /video/start, /video/status
//
// Image Mode v2.4 (Structure-Lock Stylizer) — tuned for:
//   ✅ correct framing (no crop) via padding contain
//   ✅ faster default (less steps)
//   ✅ stronger stylization (so it won't return "same image")
//
// Key idea:
// - Cloud Run safe: NO background polling. /magic/status polls Replicate on-demand.
// - ControlNet keeps contours; "strength" controls how much re-render happens.
//   If strength too low -> looks like original. We'll raise default a bit.
// - If you want even faster: reduce SD_STEPS and/or set SD_PAD_SIZE to 768.
//
// Video Mode: Replicate wan-2.2-i2v-fast (unchanged)

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "server.mjs DM-2026 IMAGE v2.4 (faster+more style, no-background-polling) + replicate video";

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 8080);

// ===== REPLICATE =====
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";

// Image version (required by this model)
const DEFAULT_IMAGE_VERSION = "3bb13fe1c33c35987b33792b01b71ed6529d03f165d1c2416375859f09ca9fef";
const REPLICATE_IMAGE_VERSION = (process.env.REPLICATE_IMAGE_VERSION || DEFAULT_IMAGE_VERSION).trim();

// ===== IMAGE TUNING =====
// Faster default than before:
const SD_STEPS = Number(process.env.SD_STEPS || 14);              // was ~20-22
const SD_GUIDANCE_SCALE = Number(process.env.SD_GUIDANCE_SCALE || 7.0);
const SD_STRENGTH = Number(process.env.SD_PROMPT_STRENGTH || 0.40); // was ~0.30 (too identity)
const SD_CONDITION_SCALE = Number(process.env.SD_CONDITION_SCALE || 0.90); // strong structure lock

const SD_NEGATIVE_PROMPT =
  process.env.SD_NEGATIVE_PROMPT ||
  "recomposition, crop, zoom, reframed, different composition, camera change, perspective change, " +
  "new objects, extra objects, extra characters, background replacement, text, watermark, logo, " +
  "distorted, deformed, changed proportions, clutter, messy";

// Padding (NO crop). You can set SD_PAD_SIZE=768 to speed up further (cheaper/faster).
const PAD_SIZE = Number(process.env.SD_PAD_SIZE || 1024);
const PAD_BACKGROUND = (process.env.SD_PAD_BACKGROUND || "#ffffff").trim();

// Optional style map
const STYLE_PROMPTS_JSON = process.env.STYLE_PROMPTS_JSON || "";

// ===== VIDEO (unchanged) =====
const REPLICATE_VIDEO_OWNER = process.env.REPLICATE_VIDEO_OWNER || "wan-video";
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_VIDEO_MODEL || "wan-2.2-i2v-fast";
const REPLICATE_VIDEO_VERSION = (process.env.REPLICATE_VIDEO_VERSION || "").trim();

const VIDEO_INPUT_KEY = process.env.VIDEO_INPUT_KEY || "image";
const VIDEO_PROMPT_KEY = process.env.VIDEO_PROMPT_KEY || "prompt";
const VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || "480p";
const VIDEO_FPS = Number(process.env.VIDEO_FPS || 16);
const VIDEO_NUM_FRAMES = Number(process.env.VIDEO_NUM_FRAMES || 81);
const VIDEO_GO_FAST = String(process.env.VIDEO_GO_FAST || "true").toLowerCase() === "true";
const VIDEO_INTERPOLATE = String(process.env.VIDEO_INTERPOLATE || "false").toLowerCase() === "true";

// ===== Upload =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ===== In-memory jobs =====
const MAGIC_TTL_MS = Number(process.env.MAGIC_TTL_MS || 60 * 60 * 1000);
const magicJobs = new Map(); // id -> {status, predId, outputUrl, error, createdAt}

function now() { return Date.now(); }

function cleanupMagicJobs() {
  const t = now();
  for (const [id, job] of magicJobs.entries()) {
    if (!job?.createdAt || (t - job.createdAt) > MAGIC_TTL_MS) magicJobs.delete(id);
  }
}
try { const timer = setInterval(cleanupMagicJobs, 30_000); timer?.unref?.(); } catch {}

// ===== Utils =====
function getBaseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

function normalizeOutputUrl(output) {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length) {
    const first = output[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") return first.url || first.output || null;
  }
  if (output && typeof output === "object") return output.url || null;
  return null;
}

function bufferToDataUri(buf, mime) {
  const safeMime = (mime && mime.includes("/")) ? mime : "image/png";
  return `data:${safeMime};base64,${Buffer.from(buf).toString("base64")}`;
}

function mustBeOkReplicate(res) {
  if (!REPLICATE_API_TOKEN) {
    res.status(500).json({ ok:false, error:"REPLICATE_API_TOKEN is not set" });
    return false;
  }
  return true;
}

// ===== Style prompt =====
function getStylePrompt(styleId) {
  const base =
    "High-quality clean stylization of a children's drawing. " +
    "CRITICAL: preserve the EXACT composition, shapes, proportions, and linework. " +
    "Do NOT add any new objects. Do NOT remove objects. " +
    "Do NOT change framing or camera. Do NOT crop. Do NOT zoom. " +
    "Premium smooth coloring, gentle gradients, soft global illumination, subtle shadows, clean edges. " +
    "Slightly enhance colors and lighting while keeping structure locked. " +
    "No paper texture, no scan artifacts, no noise.";

  let extra = "";
  if (STYLE_PROMPTS_JSON) {
    try {
      const map = JSON.parse(STYLE_PROMPTS_JSON);
      if (map && typeof map === "object" && styleId && map[styleId]) extra = String(map[styleId]);
    } catch {}
  } else if (styleId) {
    extra = `Style hint: ${styleId}.`;
  }
  return `${base} ${extra}`.trim();
}

// ===== Sharp padding (NO crop) =====
let _sharp = null;
async function loadSharp() {
  if (_sharp) return;
  const mod = await import("sharp");
  _sharp = mod.default || mod;
}

async function padSquarePng(buf, size = 1024, background = "#ffffff") {
  await loadSharp();
  return _sharp(buf, { failOn: "none" })
    .rotate()
    .flatten({ background })
    .resize({ width: size, height: size, fit: "contain", background })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// ===== Replicate API =====
async function replicateCreatePredictionVersionOnly({ version, input }) {
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method:"POST",
    headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}`, "Content-Type":"application/json" },
    body: JSON.stringify({ version, input }), // IMPORTANT: model not allowed
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.detail || json?.error || r.statusText || "Replicate error");
  return json;
}

async function replicateCreatePredictionModelOrVersion({ owner, model, version, input }) {
  const body = version ? { version, input } : { model: `${owner}/${model}`, input };
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method:"POST",
    headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}`, "Content-Type":"application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.detail || json?.error || r.statusText || "Replicate error");
  return json;
}

async function replicateGetPrediction(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(id)}`, {
    headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}` },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.detail || json?.error || r.statusText || "Replicate error");
  return json;
}

// ===== Routes =====
app.get("/", (_req,res)=>res.status(200).send("DM-2026 backend: ok"));

app.get("/health", (_req,res)=>res.status(200).json({
  ok:true,
  version: VERSION,
  replicateKey: Boolean(REPLICATE_API_TOKEN),
}));

app.get("/me", (_req,res)=>res.status(200).json({
  ok:true,
  version: VERSION,
  image: {
    provider: "replicate",
    replicate: {
      version: REPLICATE_IMAGE_VERSION || null,
      steps: SD_STEPS,
      guidance_scale: SD_GUIDANCE_SCALE,
      strength: SD_STRENGTH,
      condition_scale: SD_CONDITION_SCALE,
      pad_size: PAD_SIZE,
      key: Boolean(REPLICATE_API_TOKEN),
    }
  },
  video: { provider:"replicate", owner: REPLICATE_VIDEO_OWNER, model: REPLICATE_VIDEO_MODEL, version: REPLICATE_VIDEO_VERSION || null },
}));

// POST /magic — returns {id} immediately (Cloud Run safe)
app.post("/magic", upload.single("image"), async (req,res)=>{
  try {
    if (!mustBeOkReplicate(res)) return;

    const file = req.file;
    const styleId = String(req.body?.styleId || "").trim();
    if (!file?.buffer || file.buffer.length < 10) return res.status(400).json({ ok:false, error:"Missing image" });

    // preprocess: pad to square WITHOUT CROP
    const lockedPng = await padSquarePng(file.buffer, PAD_SIZE, PAD_BACKGROUND);
    const image = bufferToDataUri(lockedPng, "image/png");

    const prompt = getStylePrompt(styleId);

    // Create prediction (fast request)
    const input = {
      prompt,
      negative_prompt: SD_NEGATIVE_PROMPT,
      image,
      img2img: true,
      strength: Math.max(0.10, Math.min(0.65, SD_STRENGTH)),
      condition_scale: Math.max(0.5, Math.min(2, SD_CONDITION_SCALE)),
      guidance_scale: Math.max(1, Math.min(12, SD_GUIDANCE_SCALE)),
      num_inference_steps: Math.max(8, Math.min(60, SD_STEPS)),
      num_outputs: 1,
      apply_watermark: false,
      refine: "no_refiner",
    };

    const pred = await replicateCreatePredictionVersionOnly({
      version: REPLICATE_IMAGE_VERSION,
      input,
    });

    const id = `m_${crypto.randomUUID()}`;
    magicJobs.set(id, {
      status: "processing",
      predId: pred.id,
      outputUrl: null,
      error: null,
      createdAt: now(),
    });

    return res.status(200).json({ ok:true, id });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// GET /magic/status — polls Replicate on-demand
app.get("/magic/status", async (req,res)=>{
  try {
    const id = String(req.query?.id || "").trim();
    if (!id) return res.status(400).json({ ok:false, error:"Missing id" });

    const job = magicJobs.get(id);
    if (!job) return res.status(200).json({ ok:true, status:"failed", outputUrl:null, error:"Unknown id or expired" });

    if (job.status === "succeeded") {
      return res.status(200).json({
        ok:true,
        status:"succeeded",
        outputUrl: `${getBaseUrl(req)}/magic/result?id=${encodeURIComponent(id)}`,
        error: null,
      });
    }
    if (job.status === "failed") {
      return res.status(200).json({ ok:true, status:"failed", outputUrl:null, error: job.error || "failed" });
    }

    const p = await replicateGetPrediction(job.predId);
    const st = p?.status || "unknown";

    if (st === "succeeded") {
      const out = normalizeOutputUrl(p?.output);
      if (!out) {
        job.status = "failed";
        job.error = "Replicate succeeded but output is missing";
      } else {
        job.status = "succeeded";
        job.outputUrl = out;
        job.error = null;
      }
      magicJobs.set(id, job);
    } else if (st === "failed" || st === "canceled") {
      job.status = "failed";
      job.error = p?.error || `Replicate image failed (${st})`;
      magicJobs.set(id, job);
    }

    const outputUrl = job.status === "succeeded"
      ? `${getBaseUrl(req)}/magic/result?id=${encodeURIComponent(id)}`
      : null;

    return res.status(200).json({ ok:true, status: job.status, outputUrl, error: job.error || null });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// GET /magic/result — fetches from Replicate output URL
app.get("/magic/result", async (req,res)=>{
  try {
    const id = String(req.query?.id || "").trim();
    if (!id) return res.status(400).send("Missing id");

    const job = magicJobs.get(id);
    if (!job) return res.status(404).send("Not found");
    if (job.status !== "succeeded" || !job.outputUrl) return res.status(409).send(job.error || "Not ready");

    const r = await fetch(job.outputUrl);
    if (!r.ok) return res.status(502).send("Failed to fetch image output");
    const mime = r.headers.get("content-type") || "image/png";
    const bytes = Buffer.from(await r.arrayBuffer());

    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(bytes);
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
});

// POST /video/start (unchanged)
app.post("/video/start", upload.single("image"), async (req,res)=>{
  try {
    if (!mustBeOkReplicate(res)) return;
    const file = req.file;
    if (!file?.buffer || file.buffer.length < 10) return res.status(400).json({ ok:false, error:"Missing image" });

    const prompt = `
This is a child’s hand-drawn picture.

Animate ONLY the objects that already exist in the drawing.
Do NOT add any new objects.
Do NOT remove anything.
Do NOT change composition, framing, proportions, or camera angle.
No zoom. No camera movement.

Preserve the original structure 1:1.
Keep all shapes and positions exactly the same.

Bring the drawing to life in a premium kids animation.
`.trim();

    const dataUri = bufferToDataUri(file.buffer, file.mimetype);
    const input = {
      [VIDEO_INPUT_KEY]: dataUri,
      [VIDEO_PROMPT_KEY]: prompt,
      resolution: VIDEO_RESOLUTION,
      frames_per_second: VIDEO_FPS,
      num_frames: VIDEO_NUM_FRAMES,
      go_fast: VIDEO_GO_FAST,
      interpolate: VIDEO_INTERPOLATE,
    };

    const prediction = await replicateCreatePredictionModelOrVersion({
      owner: REPLICATE_VIDEO_OWNER,
      model: REPLICATE_VIDEO_MODEL,
      version: REPLICATE_VIDEO_VERSION || undefined,
      input,
    });

    return res.status(200).json({ ok:true, id: prediction.id });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// GET /video/status
app.get("/video/status", async (req,res)=>{
  try {
    if (!mustBeOkReplicate(res)) return;
    const id = String(req.query?.id || "").trim();
    if (!id) return res.status(400).json({ ok:false, error:"Missing id" });

    const p = await replicateGetPrediction(id);
    const status = p?.status || "unknown";
    const outputUrl = status === "succeeded" ? normalizeOutputUrl(p?.output) : null;
    return res.status(200).json({ ok:true, status, outputUrl, error: p?.error || null });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// Crash visibility
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

// Listen
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ${VERSION}`);
  console.log(`✅ Listening on 0.0.0.0:${PORT}`);
  console.log(`✅ IMAGE (version-only): ${REPLICATE_IMAGE_VERSION}`);
  console.log(`✅ DEFAULTS: PAD_SIZE=${PAD_SIZE} STEPS=${SD_STEPS} STRENGTH=${SD_STRENGTH} CONDITION=${SD_CONDITION_SCALE}`);
});
