// DM-2026 backend — IMAGE v6.0 (FLUX Kontext Pro img2img / editing)
// Model: black-forest-labs/flux-kontext-pro (Replicate) — text-guided image editing (accepts input_image)

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 IMAGE v6.0 FLUX KONTEXT PRO";

const app = express();
app.disable("x-powered-by");
const PORT = Number(process.env.PORT || 8080);

// ===== REPLICATE =====
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";

// Default known Kontext Pro version (override via env)
const DEFAULT_KONTEXT_VERSION =
  "0a1381936934845a14efcc9f309ce7d031cb905867878b5c5830280e00e97606";
const REPLICATE_IMAGE_VERSION = (process.env.REPLICATE_IMAGE_VERSION || DEFAULT_KONTEXT_VERSION).trim();

// ===== IMAGE TUNING =====
const KONTEXT_PROMPT_UPSAMPLING =
  String(process.env.KONTEXT_PROMPT_UPSAMPLING || "false").toLowerCase() === "true";
const KONTEXT_SAFETY_TOLERANCE = Number(process.env.KONTEXT_SAFETY_TOLERANCE || 2);
const KONTEXT_OUTPUT_FORMAT = (process.env.KONTEXT_OUTPUT_FORMAT || "png").trim();
const KONTEXT_SEED = Number(process.env.KONTEXT_SEED || 0);

// Optional: style presets JSON: {"pixar_3d":"...","watercolor":"..."}
const STYLE_PROMPTS_JSON = process.env.STYLE_PROMPTS_JSON || "";

// ===== Upload =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ===== In-memory jobs =====
const MAGIC_TTL_MS = Number(process.env.MAGIC_TTL_MS || 60 * 60 * 1000);
const magicJobs = new Map(); // id -> {status, predId, rawOutputUrl, error, createdAt}

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
  if (Array.isArray(output) && output.length) return typeof output[0] === "string" ? output[0] : (output[0]?.url || null);
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
  if (!REPLICATE_IMAGE_VERSION) {
    res.status(500).json({ ok:false, error:"REPLICATE_IMAGE_VERSION is not set" });
    return false;
  }
  return true;
}

// ===== Prompt builder =====
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

// ===== Replicate API =====
async function replicateCreatePredictionVersionOnly({ version, input }) {
  const r = await fetch("https://api.replicate.com/v1/predictions", {
    method:"POST",
    headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}`, "Content-Type":"application/json" },
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
    model: "black-forest-labs/flux-kontext-pro",
    replicate: {
      version: REPLICATE_IMAGE_VERSION || null,
      prompt_upsampling: KONTEXT_PROMPT_UPSAMPLING,
      safety_tolerance: KONTEXT_SAFETY_TOLERANCE,
      output_format: KONTEXT_OUTPUT_FORMAT,
      seed: KONTEXT_SEED,
      key: Boolean(REPLICATE_API_TOKEN),
    }
  }
}));

// POST /magic
app.post("/magic", upload.single("image"), async (req,res)=>{
  try {
    if (!mustBeOkReplicate(res)) return;

    const file = req.file;
    const styleId = String(req.body?.styleId || "").trim();
    if (!file?.buffer || file.buffer.length < 10) return res.status(400).json({ ok:false, error:"Missing image" });

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

    const pred = await replicateCreatePredictionVersionOnly({ version: REPLICATE_IMAGE_VERSION, input });

    const id = `m_${crypto.randomUUID()}`;
    magicJobs.set(id, { status:"processing", predId: pred.id, rawOutputUrl:null, error:null, createdAt: now() });
    return res.status(200).json({ ok:true, id });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// GET /magic/status
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

// GET /magic/result
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

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ${VERSION}`);
  console.log(`✅ Listening on 0.0.0.0:${PORT}`);
  console.log(`✅ IMAGE: flux-kontext-pro version=${REPLICATE_IMAGE_VERSION}`);
});
