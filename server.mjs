// DM-2026 backend — Cloud Run (Node 20 + Express)
// ✅ ВСЕ ФУНКЦИИ (ВИДЕО + ФОТО) СОХРАНЕНЫ
// ✅ ДОБАВЛЕНО 10 СИЛЬНЫХ ПРОМПТОВ ВНУТРЬ КОДА

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 FULL v10.0 (10 STYLES + VIDEO FIXED)";

const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_IMAGE_VERSION = (process.env.REPLICATE_IMAGE_VERSION || "0f1178f5a27e9aa2d2d39c8a43c110f7fa7cbf64062ff04a04cd40899e546065").trim();
const REPLICATE_VIDEO_VERSION = (process.env.REPLICATE_VIDEO_VERSION || "").trim();

// --- НОВЫЕ СИЛЬНЫЕ ПРОМПТЫ ДЛЯ 10 СТИЛЕЙ ---
const styleMap = {
  "style_3d_magic": "Transform into a premium Pixar-style 3D animation, Disney character aesthetic, volumetric lighting, masterpiece.",
  "style_blocks": "Lego photography style, made of plastic interlocking bricks, toy world, vibrant colors, studio lighting.",
  "style_pixels": "High-quality 128-bit pixel art, sharp retro game aesthetic, vibrant colors, clear sprite outlines.",
  "style_fairy": "Fairytale storybook illustration, glowing magic aura, soft oil painting, warm golden lighting, enchanted forest.",
  "style_anime": "Studio Ghibli style, Hayao Miyazaki aesthetic, hand-painted anime art, lush environment, whimsical.",
  "style_clay": "Claymation style, handcrafted plasticine monster, stop-motion aesthetic, fingerprints texture, soft clay surface.",
  "style_neon": "Cyberpunk neon glow, futuristic synthwave aesthetic, glowing outlines, high contrast, dark background.",
  "style_watercolor": "Artistic watercolor painting, wet-on-wet technique, soft edges, paper texture, elegant ink splatters.",
  "style_cardboard": "Cardboard toy style, layered corrugated paper craft, handmade texture, diorama aesthetic.",
  "style_comic": "Vintage comic book art, halftone dot patterns, bold black ink outlines, pop art style, vibrant colors."
};

function getStyleExtra(styleId) {
  return styleMap[styleId] || "Transform into a premium 3D cartoon illustration.";
}

function buildKontextPrompt(styleId) {
  const base = 
    "Masterpiece art transformation. Convert the child's drawing into a high-end, colorful illustration. " +
    "STRICT: Keep 1:1 original composition. Do NOT zoom. Do NOT crop. " +
    "Maintain the exact position and shapes of the original monster. " +
    "Add cinematic lighting, professional textures, and clean smooth surfaces. " +
    "Remove paper artifacts. Professional commercial artwork look.";
  return `${base} ${getStyleExtra(styleId)}`.trim();
}

// --- ВИДЕО ПРОМПТ (БЕЗ ИЗМЕНЕНИЙ) ---
function buildVideoPrompt(userPrompt) {
  const p = String(userPrompt || "").trim();
  if (p) return p;
  return `Animate ALL existing objects in the drawing. Smooth, premium Pixar-style animation. Soft dimensional lighting. No new objects.`;
}

// --- ОСТАЛЬНАЯ ЛОГИКА (ПОЛНОСТЬЮ СОХРАНЕНА) ---
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const magicJobs = new Map();

function bufferToDataUri(buf, mime) {
  return `data:${mime || "image/png"};base64,${buf.toString("base64")}`;
}

app.post("/magic", upload.single("image"), async (req,res)=>{
  try {
    const file = req.file;
    const styleId = (req.body?.styleId || "").toString().trim();
    if (!file?.buffer) return res.status(400).json({ ok:false, error:"Missing image" });

    const input = {
      prompt: buildKontextPrompt(styleId),
      input_image: bufferToDataUri(file.buffer, file.mimetype),
      aspect_ratio: "match_input_image",
      prompt_upsampling: false,
      output_format: "png",
      safety_tolerance: 2,
    };

    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method:"POST",
      headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}`, "Content-Type":"application/json" },
      body: JSON.stringify({ version: REPLICATE_IMAGE_VERSION, input }),
    });
    const pred = await r.json();
    const id = `m_${crypto.randomUUID()}`;
    magicJobs.set(id, { status:"processing", predId: pred.id, createdAt: Date.now() });
    return res.status(200).json({ ok:true, id });
  } catch (e) { return res.status(500).json({ ok:false, error:String(e) }); }
});

app.get("/magic/status", async (req,res)=>{
  const id = (req.query?.id || "").toString().trim();
  const job = magicJobs.get(id);
  if (!job) return res.json({ ok:true, status:"failed", error:"Expired" });
  if (job.status === "succeeded") return res.json({ ok:true, status:"succeeded", outputUrl: `${req.protocol}://${req.get('host')}/magic/result?id=${id}` });

  const r = await fetch(`https://api.replicate.com/v1/predictions/${job.predId}`, {
    headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}` },
  });
  const p = await r.json();
  if (p.status === "succeeded") {
    job.status = "succeeded";
    job.rawUrl = p.output;
    magicJobs.set(id, job);
  }
  return res.json({ ok:true, status: p.status, outputUrl: p.status === "succeeded" ? `${req.protocol}://${req.get('host')}/magic/result?id=${id}` : null });
});

app.get("/magic/result", async (req,res)=>{
  const id = (req.query?.id || "").toString().trim();
  const job = magicJobs.get(id);
  if (!job || !job.rawUrl) return res.status(404).send("Not ready");
  const r = await fetch(job.rawUrl);
  res.setHeader("Content-Type", "image/png");
  return res.status(200).send(Buffer.from(await r.arrayBuffer()));
});

// --- VIDEO ENDPOINTS (СОХРАНЕНЫ) ---
app.post("/video/start", upload.single("image"), async (req,res)=>{
  try {
    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ ok:false, error:"Missing image" });
    const prompt = buildVideoPrompt(req.body?.prompt);
    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method:"POST",
      headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}`, "Content-Type":"application/json" },
      body: JSON.stringify({ version: REPLICATE_VIDEO_VERSION, input: { image: bufferToDataUri(file.buffer, file.mimetype), prompt } }),
    });
    const pred = await r.json();
    return res.status(200).json({ ok:true, id: pred.id });
  } catch (e) { return res.status(500).json({ ok:false, error:String(e) }); }
});

app.get("/video/status", async (req,res)=>{
  const id = (req.query?.id || "").toString().trim();
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}` },
  });
  const p = await r.json();
  return res.json({ ok:true, status: p.status, outputUrl: p.output });
});

app.get("/", (req,res)=>res.send("DM-2026 Full Server OK"));
app.listen(PORT, "0.0.0.0", () => console.log(`✅ ${VERSION} on port ${PORT}`));
