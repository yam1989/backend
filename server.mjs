// DM-2026 backend — Cloud Run (Node 20 + Express)
// ✅ Stable startup, listens on PORT
// ✅ Endpoints (unchanged): /, /health, /me, /magic, /magic/status, /magic/result, /video/start, /video/status
//
// IMAGE: Replicate — black-forest-labs/flux-kontext-pro (img2img edit-with-words)
// VIDEO: Replicate — wan-video/wan-2.2-i2v-fast (i2v)
//
// Notes:
// - Image uses a pinned VERSION hash to avoid Replicate schema mismatches.
// - Video can use a pinned VERSION hash (recommended) or model path.

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 IMAGE v7.0 (FLUX KONTEXT PRO) + replicate video";

const app = express();
app.disable("x-powered-by");
const PORT = Number(process.env.PORT || 8080);

// ---------- ENV ----------
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";

// IMAGE (Kontext Pro)
const REPLICATE_IMAGE_OWNER = process.env.REPLICATE_IMAGE_OWNER || "black-forest-labs";
const REPLICATE_IMAGE_MODEL = process.env.REPLICATE_IMAGE_MODEL || "flux-kontext-pro";

// Kontext requires VERSION (hash). Default known working version. Override via env if needed.
const DEFAULT_IMAGE_VERSION =
  "0a1381936934845a14efcc9f309ce7d031cb905867878b5c5830280e00e97606";
const REPLICATE_IMAGE_VERSION = (process.env.REPLICATE_IMAGE_VERSION || DEFAULT_IMAGE_VERSION).trim();

const KONTEXT_PROMPT_UPSAMPLING =
  String(process.env.KONTEXT_PROMPT_UPSAMPLING || "false").toLowerCase() === "true";
const KONTEXT_SAFETY_TOLERANCE = Number(process.env.KONTEXT_SAFETY_TOLERANCE || 2);
const KONTEXT_OUTPUT_FORMAT = (process.env.KONTEXT_OUTPUT_FORMAT || "png").trim();
const KONTEXT_SEED = Number(process.env.KONTEXT_SEED || 0);

// Optional style map JSON: {"pixar_3d":"...","watercolor":"..."}
const STYLE_PROMPTS_JSON = process.env.STYLE_PROMPTS_JSON || "";

// VIDEO (WAN)
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

// ---------- Upload ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------- In-memory jobs for /magic ----------
const MAGIC_TTL_MS = Number(process.env.MAGIC_TTL_MS || 60 * 60 * 1000);
const magicJobs = new Map(); // id -> {status, predId, rawOutputUrl, error, createdAt}

// ---------- In-memory jobs for /video ----------
const VIDEO_TTL_MS = Number(process.env.VIDEO_TTL_MS || 60 * 60 * 1000);
const videoJobs = new Map(); // id -> {status, predId, rawOutputUrl, error, createdAt}

function now() { return Date.now(); }

function cleanupJobs(map, ttlMs) {
  const t = now();
  for (const [id, job] of map.entries()) {
    if (!job?.createdAt || (t - job.createdAt) > ttlMs) map.delete(id);
  }
}
try {
  const timer = setInterval(() => {
    cleanupJobs(magicJobs, MAGIC_TTL_MS);
    cleanupJobs(videoJobs, VIDEO_TTL_MS);
  }, 30_000);
  timer?.unref?.();
} catch {}

// ---------- Utilities ----------
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

function isHex64(s) {
  return /^[0-9a-f]{64}$/i.test(String(s || "").trim());
}

function mustBeOkReplicate(res) {
  if (!REPLICATE_API_TOKEN) {
    res.status(500).json({ ok:false, error:"REPLICATE_API_TOKEN is not set" });
    return false;
  }
  return true;
}

// ---------- Style + Prompt ----------
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
    "Edit this image: transform the child’s drawing into a premium Pixar-like 3D cartoon illustration. " +
    "Keep the same framing and composition. Do NOT crop. Do NOT zoom. Do NOT change camera. " +
    "Keep the same objects and their positions (minor beautification allowed). " +
    "Make it FULL COLOR, high-end, clean, smooth. Add cinematic lighting, soft shadows, global illumination, depth. " +
    "Remove paper texture and scan artifacts. Background should be clean and simple. " +
    "No text, no watermark.";
  const extra = getStyleExtra(styleId);
  return `${base} ${extra}`.trim();
}

function buildVideoPrompt(userPrompt) {
  // Keep stable default. App may send its own prompt; we enrich softly.
  const p = String(userPrompt || "").trim();
  if (p) return p;
  return "Animate this children's drawing into a smooth, magical short clip. Preserve composition and identity. Gentle motion, subtle parallax, clean cartoon style.";
}

// ---------- Replicate API ----------
async function replicateCreatePrediction({ owner, model, version, input }) {
  const body = version
    ? { version, input }
    : { model: `${owner}/${model}`, input };

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
  image: {
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
  video: {
    provider:"replicate",
    owner: REPLICATE_VIDEO_OWNER,
    model: REPLICATE_VIDEO_MODEL,
    version: REPLICATE_VIDEO_VERSION || null,
  }
}));

// ---------- IMAGE: POST /magic ----------
app.post("/magic", upload.single("image"), async (req,res)=>{
  try {
    if (!mustBeOkReplicate(res)) return;

    const file = req.file;
    const styleId = String(req.body?.styleId || "").trim();
    if (!file?.buffer || file.buffer.length < 10) {
      return res.status(400).json({ ok:false, error:"Missing image" });
    }

    const input_image = bufferToDataUri(file.buffer, file.mimetype);

    const input = {
      prompt: buildKontextPrompt(styleId),
      input_image,
      aspect_ratio: "match_input_image",
      prompt_upsampling: KONTEXT_PROMPT_UPSAMPLING,
      seed: Number.isFinite(KONTEXT_SEED) ? KONTEXT_SEED : 0,
      output_format: KONTEXT_OUTPUT_FORMAT,
      safety_tolerance: Math.max(0, Math.min(6, KONTEXT_SAFETY_TOLERANCE)),
    };

    const pred = await replicateCreatePrediction({
      owner: REPLICATE_IMAGE_OWNER,
      model: REPLICATE_IMAGE_MODEL,
      version: (REPLICATE_IMAGE_VERSION && isHex64(REPLICATE_IMAGE_VERSION)) ? REPLICATE_IMAGE_VERSION : undefined,
      input,
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

    const id = String(req.query?.id || "").trim();
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
        error:null,
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
    const id = String(req.query?.id || "").trim();
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

    if ((!REPLICATE_VIDEO_VERSION || !isHex64(REPLICATE_VIDEO_VERSION)) && (!REPLICATE_VIDEO_OWNER || !REPLICATE_VIDEO_MODEL)) {
      return res.status(500).json({ ok:false, error:"Video model is not configured. Set REPLICATE_VIDEO_VERSION or REPLICATE_VIDEO_OWNER/REPLICATE_VIDEO_MODEL." });
    }

    const file = req.file;
    if (!file?.buffer || file.buffer.length < 10) return res.status(400).json({ ok:false, error:"Missing image" });

    const userPrompt = String(req.body?.prompt || req.body?.[VIDEO_PROMPT_KEY] || "").trim();
    const prompt = buildVideoPrompt(userPrompt);

    const imageDataUri = bufferToDataUri(file.buffer, file.mimetype);

    const input = {
      [VIDEO_INPUT_KEY]: imageDataUri,
      [VIDEO_PROMPT_KEY]: prompt,
      fps: VIDEO_FPS,
      num_frames: VIDEO_NUM_FRAMES,
      resolution: VIDEO_RESOLUTION,
      go_fast: VIDEO_GO_FAST,
      interpolate: VIDEO_INTERPOLATE,
    };

    const pred = await replicateCreatePrediction({
      owner: REPLICATE_VIDEO_OWNER,
      model: REPLICATE_VIDEO_MODEL,
      version: (REPLICATE_VIDEO_VERSION && isHex64(REPLICATE_VIDEO_VERSION)) ? REPLICATE_VIDEO_VERSION : undefined,
      input,
    });

    const id = `v_${crypto.randomUUID()}`;
    videoJobs.set(id, { status:"processing", predId: pred.id, rawOutputUrl:null, error:null, createdAt: now() });

    return res.status(200).json({ ok:true, id });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// ---------- VIDEO: GET /video/status ----------
app.get("/video/status", async (req,res)=>{
  try {
    if (!mustBeOkReplicate(res)) return;

    const id = String(req.query?.id || "").trim();
    if (!id) return res.status(400).json({ ok:false, error:"Missing id" });

    const job = videoJobs.get(id);
    if (!job) {
      return res.status(200).json({ ok:true, status:"failed", outputUrl:null, error:"Unknown id or expired" });
    }

    if (job.status === "succeeded") {
      return res.status(200).json({ ok:true, status:"succeeded", outputUrl: job.rawOutputUrl, error:null });
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
      videoJobs.set(id, job);
    } else if (st === "failed" || st === "canceled") {
      job.status = "failed";
      job.error = p?.error || `Replicate video failed (${st})`;
      videoJobs.set(id, job);
    }

    return res.status(200).json({ ok:true, status: job.status, outputUrl: job.rawOutputUrl || null, error: job.error || null });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// ---------- Crash visibility ----------
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ${VERSION}`);
  console.log(`✅ Listening on 0.0.0.0:${PORT}`);
  console.log(`✅ IMAGE: ${REPLICATE_IMAGE_OWNER}/${REPLICATE_IMAGE_MODEL} version=${REPLICATE_IMAGE_VERSION}`);
  console.log(`✅ VIDEO: ${REPLICATE_VIDEO_OWNER}/${REPLICATE_VIDEO_MODEL} version=${REPLICATE_VIDEO_VERSION || "(model path)"}`);
});
