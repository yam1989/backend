// DM-2026 backend — Cloud Run (Node 20 + Express)
// ✅ Endpoints (DO NOT CHANGE):
//   GET  /, /health, /me
//   POST /magic          (multipart: image + styleId) -> { ok:true, id }
//   GET  /magic/status   -> { ok:true, status, outputUrl, error }
//   GET  /magic/result   -> image bytes
//   POST /video/start    (multipart: image + optional prompt) -> { ok:true, id }
//   GET  /video/status   -> { ok:true, status, outputUrl, error }
//
// IMAGE: Replicate — black-forest-labs/flux-kontext-pro (img2img, fast, no crop)
// VIDEO: Replicate — wan-video/wan-2.2-i2v-fast (i2v) — ✅ version REQUIRED (fixes “Additional property model is not allowed”)

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 IMAGE v8.0 (FLUX KONTEXT PRO) + VIDEO FIX (version required)";

const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

// ---------- ENV ----------
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";

// IMAGE (Kontext Pro)
const REPLICATE_IMAGE_OWNER = process.env.REPLICATE_IMAGE_OWNER || "black-forest-labs";
const REPLICATE_IMAGE_MODEL = process.env.REPLICATE_IMAGE_MODEL || "flux-kontext-pro";

// Default pinned version (override via env if you want)
const DEFAULT_IMAGE_VERSION =
  "0f1178f5a27e9aa2d2d39c8a43c110f7fa7cbf64062ff04a04cd40899e546065";
const REPLICATE_IMAGE_VERSION = (process.env.REPLICATE_IMAGE_VERSION || DEFAULT_IMAGE_VERSION).trim();

const KONTEXT_PROMPT_UPSAMPLING =
  String(process.env.KONTEXT_PROMPT_UPSAMPLING || "false").toLowerCase() === "true";
const KONTEXT_SAFETY_TOLERANCE = parseInt(process.env.KONTEXT_SAFETY_TOLERANCE || "2", 10);
const KONTEXT_OUTPUT_FORMAT = (process.env.KONTEXT_OUTPUT_FORMAT || "png").trim();
const KONTEXT_SEED = parseInt(process.env.KONTEXT_SEED || "0", 10);

// Optional: {"pixar":"...","watercolor":"..."}
const STYLE_PROMPTS_JSON = process.env.STYLE_PROMPTS_JSON || "";

// VIDEO (WAN) — IMPORTANT: Replicate now validates payload: "version" is required for your account,
// and "model" field is rejected. So we ALWAYS use version here.
const REPLICATE_VIDEO_OWNER = process.env.REPLICATE_VIDEO_OWNER || "wan-video";
const REPLICATE_VIDEO_MODEL = process.env.REPLICATE_VIDEO_MODEL || "wan-2.2-i2v-fast";
const REPLICATE_VIDEO_VERSION = (process.env.REPLICATE_VIDEO_VERSION || "").trim();

const VIDEO_INPUT_KEY = process.env.VIDEO_INPUT_KEY || "image";
const VIDEO_PROMPT_KEY = process.env.VIDEO_PROMPT_KEY || "prompt";
const VIDEO_RESOLUTION = process.env.VIDEO_RESOLUTION || "480p";
const VIDEO_FPS = parseInt(process.env.VIDEO_FPS || "16", 10);
const VIDEO_NUM_FRAMES = parseInt(process.env.VIDEO_NUM_FRAMES || "81", 10);
const VIDEO_GO_FAST = (process.env.VIDEO_GO_FAST || "true").toLowerCase() === "true";
const VIDEO_INTERPOLATE = (process.env.VIDEO_INTERPOLATE || "false").toLowerCase() === "true";

// ---------- Upload ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------- In-memory jobs for /magic ----------
const MAGIC_TTL_MS = parseInt(process.env.MAGIC_TTL_MS || String(60 * 60 * 1000), 10);
const magicJobs = new Map(); // id -> {status, predId, rawOutputUrl, error, createdAt}

function now() { return Date.now(); }

function cleanupJobs(map, ttlMs) {
  const t = now();
  for (const [id, job] of map.entries()) {
    if (!job?.createdAt || t - job.createdAt > ttlMs) map.delete(id);
  }
}
try {
  const timer = setInterval(() => cleanupJobs(magicJobs, MAGIC_TTL_MS), 30_000);
  timer?.unref?.();
} catch {}

// ---------- Helpers ----------
function mustBeOkReplicate(res) {
  if (!REPLICATE_API_TOKEN) {
    res.status(500).json({ ok:false, error:"REPLICATE_API_TOKEN is not set" });
    return false;
  }
  return true;
}

function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.get("host") || "").toString().split(",")[0].trim();
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
  const safeMime = mime && mime.includes("/") ? mime : "image/png";
  const base64 = Buffer.from(buf).toString("base64");
  return `data:${safeMime};base64,${base64}`;
}

function isHex64(s) { return /^[0-9a-f]{64}$/i.test(String(s || "").trim()); }

function getStyleExtra(styleId) {
  if (!styleId) return "";
  if (STYLE_PROMPTS_JSON) {
    try {
      const map = JSON.parse(STYLE_PROMPTS_JSON);
      if (map && typeof map === "object" && map[styleId]) return String(map[styleId]);
    } catch {}
  }
  return `Style hint: ${styleId}.`;
}

function buildKontextPrompt(styleId) {
  const base =
    "Edit this image: transform the child’s drawing into a premium, colorful Pixar-like 3D cartoon illustration. " +
    "CRITICAL: keep the same framing and composition. Do NOT crop. Do NOT zoom. Do NOT change camera. " +
    "Keep the same objects and their positions (minor beautification allowed). " +
    "Make it FULL COLOR, high-end, clean, smooth. Add cinematic lighting, soft shadows, global illumination, depth. " +
    "Remove paper texture and scan artifacts. Background should be clean and simple. " +
    "No text, no watermark.";
  return `${base} ${getStyleExtra(styleId)}`.trim();
}

function buildVideoPrompt(userPrompt) {
  const p = String(userPrompt || "").trim();
  if (p) return p;
  return (
    "This is a child’s hand-drawn picture.\n\n" +
    "Animate ONLY the objects that already exist in the drawing.\n" +
    "Do NOT add any new objects.\n" +
    "Do NOT remove anything.\n" +
    "Do NOT change composition, framing, proportions, or camera angle.\n" +
    "No zoom. No camera movement.\n\n" +
    "Preserve the original structure 1:1.\n" +
    "Keep all shapes and positions exactly the same.\n\n" +
    "Bring the drawing to life in a premium Pixar-style animation:\n" +
    "• Soft dimensional lighting and gentle depth\n" +
    "• Subtle shadows\n" +
    "• Smooth, high-quality motion with natural easing\n" +
    "• Small ambient motion everywhere\n\n" +
    "STRICTLY no new objects or details.\n" +
    "Loop-friendly. Smooth. Clean."
  );
}

// ---------- Replicate API ----------
async function replicateCreatePredictionWithVersion({ version, input }) {
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method:"POST",
    headers:{
      Authorization:`Token ${REPLICATE_API_TOKEN}`,
      "Content-Type":"application/json"
    },
    body: JSON.stringify({ version, input }),
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

// ---------- Base endpoints ----------
app.get("/", (_req,res)=>res.status(200).send("DM-2026 backend: ok"));

app.get("/health", (_req,res)=>res.status(200).json({
  ok:true,
  version: VERSION,
  replicateKey: Boolean(REPLICATE_API_TOKEN),
}));

app.get("/me", (_req,res)=>res.status(200).json({
  ok:true,
  version: VERSION,
  image:{
    provider:"replicate",
    model:`${REPLICATE_IMAGE_OWNER}/${REPLICATE_IMAGE_MODEL}`,
    replicate:{
      version: REPLICATE_IMAGE_VERSION || null,
      prompt_upsampling: KONTEXT_PROMPT_UPSAMPLING,
      safety_tolerance: KONTEXT_SAFETY_TOLERANCE,
      output_format: KONTEXT_OUTPUT_FORMAT,
      seed: KONTEXT_SEED,
      key: Boolean(REPLICATE_API_TOKEN),
    }
  },
  video:{
    provider:"replicate",
    owner: REPLICATE_VIDEO_OWNER,
    model: REPLICATE_VIDEO_MODEL,
    replicate:{ version: REPLICATE_VIDEO_VERSION || null }
  }
}));

// ---------- IMAGE: POST /magic ----------
app.post("/magic", upload.single("image"), async (req,res)=>{
  try {
    if (!mustBeOkReplicate(res)) return;

    const file = req.file;
    const styleId = (req.body?.styleId || "").toString().trim();

    if (!file?.buffer || file.buffer.length < 10) {
      return res.status(400).json({ ok:false, error:"Missing image" });
    }

    if (!REPLICATE_IMAGE_VERSION || !isHex64(REPLICATE_IMAGE_VERSION)) {
      return res.status(500).json({
        ok:false,
        error:"REPLICATE_IMAGE_VERSION must be set to a 64-hex version hash (Kontext Pro)."
      });
    }

    const input = {
      prompt: buildKontextPrompt(styleId),
      input_image: bufferToDataUri(file.buffer, file.mimetype),
      aspect_ratio: "match_input_image",
      prompt_upsampling: KONTEXT_PROMPT_UPSAMPLING,
      seed: Number.isFinite(KONTEXT_SEED) ? KONTEXT_SEED : 0,
      output_format: KONTEXT_OUTPUT_FORMAT,
      safety_tolerance: Math.max(0, Math.min(6, KONTEXT_SAFETY_TOLERANCE)),
    };

    const pred = await replicateCreatePredictionWithVersion({
      version: REPLICATE_IMAGE_VERSION,
      input
    });

    const id = `m_${crypto.randomUUID()}`;
    magicJobs.set(id, { status:"processing", predId: pred.id, rawOutputUrl:null, error:null, createdAt: now() });

    return res.status(200).json({ ok:true, id });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// ---------- IMAGE: GET /magic/status ----------
app.get("/magic/status", async (req,res)=>{
  try {
    if (!mustBeOkReplicate(res)) return;

    const id = (req.query?.id || "").toString().trim();
    if (!id) return res.status(400).json({ ok:false, error:"Missing id" });

    const job = magicJobs.get(id);
    if (!job) {
      return res.status(200).json({ ok:true, status:"failed", outputUrl:null, error:"Unknown id or expired" });
    }

    if (job.status === "succeeded") {
      return res.status(200).json({
        ok:true,
        status:"succeeded",
        outputUrl: `${getBaseUrl(req)}/magic/result?id=${encodeURIComponent(id)}`,
        error:null
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
        job.rawOutputUrl = out;
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

// ---------- IMAGE: GET /magic/result ----------
app.get("/magic/result", async (req,res)=>{
  try {
    const id = (req.query?.id || "").toString().trim();
    if (!id) return res.status(400).send("Missing id");

    const job = magicJobs.get(id);
    if (!job) return res.status(404).send("Not found");
    if (job.status !== "succeeded" || !job.rawOutputUrl) return res.status(409).send(job.error || "Not ready");

    const r = await fetch(job.rawOutputUrl);
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

// ---------- VIDEO: POST /video/start ----------
app.post("/video/start", upload.single("image"), async (req,res)=>{
  try {
    if (!mustBeOkReplicate(res)) return;

    // ✅ HARD REQUIREMENT (fix your error):
    if (!REPLICATE_VIDEO_VERSION || !isHex64(REPLICATE_VIDEO_VERSION)) {
      return res.status(500).json({
        ok:false,
        error:"REPLICATE_VIDEO_VERSION is required (64-hex). Open the model page -> Versions -> copy the full hash and set it in Cloud Run."
      });
    }

    const file = req.file;
    if (!file?.buffer || file.buffer.length < 10) return res.status(400).json({ ok:false, error:"Missing image" });

    const userPrompt = (req.body?.prompt || "").toString().trim();
    const prompt = buildVideoPrompt(userPrompt);

    const dataUri = bufferToDataUri(file.buffer, file.mimetype);

    // IMPORTANT: use the exact input keys your working setup already had.
    const input = {
      [VIDEO_INPUT_KEY]: dataUri,
      [VIDEO_PROMPT_KEY]: prompt,
      resolution: VIDEO_RESOLUTION,
      num_frames: VIDEO_NUM_FRAMES,
      // some WAN versions use frames_per_second, so we keep it as before:
      frames_per_second: VIDEO_FPS,
      go_fast: VIDEO_GO_FAST,
      interpolate: VIDEO_INTERPOLATE,
    };

    const prediction = await replicateCreatePredictionWithVersion({
      version: REPLICATE_VIDEO_VERSION,
      input
    });

    return res.status(200).json({ ok:true, id: prediction.id });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// ---------- VIDEO: GET /video/status ----------
app.get("/video/status", async (req,res)=>{
  try {
    if (!mustBeOkReplicate(res)) return;

    const id = (req.query?.id || "").toString().trim();
    if (!id) return res.status(400).json({ ok:false, error:"Missing id" });

    const p = await replicateGetPrediction(id);
    const status = p?.status || "unknown";
    const outputUrl = status === "succeeded" ? normalizeOutputUrl(p?.output) : null;

    return res.status(200).json({ ok:true, status, outputUrl, error: p?.error || null });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ${VERSION}`);
  console.log(`✅ Listening on 0.0.0.0:${PORT}`);
  console.log(`✅ IMAGE version=${REPLICATE_IMAGE_VERSION}`);
  console.log(`✅ VIDEO version=${REPLICATE_VIDEO_VERSION || "(MISSING!)"}`);
});
