// DM-2026 backend — Cloud Run (Node 20 + Express)
// ✅ ВСЕ ФУНКЦИИ (ВИДЕО + ФОТО) СОХРАНЕНЫ
// ✅ ПРОМПТЫ УСИЛЕНЫ: АКВАРЕЛЬ, ПИКСЕЛЬ (MINECRAFT), СКАЗКА

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 FULL v12.0 (FINAL STYLE TUNING)";

const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_IMAGE_VERSION = (process.env.REPLICATE_IMAGE_VERSION || "0f1178f5a27e9aa2d2d39c8a43c110f7fa7cbf64062ff04a04cd40899e546065").trim();
const REPLICATE_VIDEO_VERSION = (process.env.REPLICATE_VIDEO_VERSION || "").trim();

// --- ОБНОВЛЕННЫЙ СЛОВАРЬ СТИЛЕЙ ---
const styleMap = {
  // ЭТИ РАБОТАЮТ ХОРОШО - НЕ ТРОГАЕМ
  "style_3d_magic": "Transform into a premium Pixar-style 3D animation, Disney character aesthetic, volumetric lighting, masterpiece.",
  "style_blocks": "Lego photography style, made of plastic interlocking bricks, toy world, vibrant colors, studio lighting.",
  "style_neon": "Cyberpunk neon glow, futuristic synthwave aesthetic, glowing outlines, high contrast, dark background.",
  "style_comic": "Vintage comic book art, halftone dot patterns, bold black ink outlines, pop art style, vibrant colors.",
  "style_cardboard": "Handmade cardboard craft. The monster must be made of cut-out layered brown corrugated paper. Rough edges, 3D diorama look.",

  // ИСПРАВЛЕННЫЙ ПИКСЕЛЬ (Minecraft Edition)
  "style_pixels": "Minecraft blocky aesthetic. Total 3D Voxel art reconstruction. The monster MUST be built entirely from CUBIC BLOCKS. NO smooth lines, NO pencil strokes, NO paper. Every detail is a pixel-perfect square block. Vibrant solid colors.",
  
  // ИСПРАВЛЕННОЕ АНИМЕ (Настоящее 2D)
  "style_anime": "Classic 2D flat cel-shaded anime style. Studio Ghibli aesthetic, bold hand-drawn ink outlines, flat vibrant colors, NO 3D shading, whimsical hand-painted background.",
  
  // ИСПРАВЛЕННАЯ СКАЗКА (Disney Classic)
  "style_fairy": "Golden age of Disney animation (1950s). Hand-painted gouache illustration, magical glow, soft storybook textures, high-end masterpiece. Character must be fully repainted, ignore pencil lines.",
  
  // ИСПРАВЛЕННАЯ АКВАРЕЛЬ (Максимальное усиление)
  "style_watercolor": "Professional fluid watercolor painting. EXTREME paint bleeding, wet-on-wet technique, artistic pigment blooms, heavy water saturation. MUST HIDE ALL ORIGINAL PENCIL LINES and handwriting under layers of paint. Masterpiece fluid art.",
  
  // ИСПРАВЛЕННЫЙ ПЛАСТИЛИН (Более жирный)
  "style_clay": "Ultra-thick plasticine claymation. Chunky handmade shapes, deep fingerprints, glossy clay reflections, soft volumetric 3D shapes, stop-motion film prop aesthetic."
};

function getStyleExtra(styleId) {
  return styleMap[styleId] || "Transform into a premium 3D cartoon illustration.";
}

function buildKontextPrompt(styleId) {
  const base = 
    "Masterpiece art transformation. Convert the child's drawing into a high-end, colorful illustration. " +
    "STRICT: Keep original composition. Do NOT zoom. Do NOT crop. " +
    "Maintain the shapes but TOTALLY change the texture. Remove all paper artifacts, handwriting, and pencil lines. " +
    "Professional commercial artwork look.";
  return `${base} ${getStyleExtra(styleId)}`.trim();
}

function buildVideoPrompt(userPrompt) {
  const p = String(userPrompt || "").trim();
  if (p) return p;
  return `Animate ALL existing objects in the drawing. Smooth, premium Pixar-style animation. Soft dimensional lighting. No new objects.`;
}

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

app.get("/", (req,res)=>res.send("DM-2026 Backend Full OK"));
app.listen(PORT, "0.0.0.0", () => console.log(`✅ ${VERSION} on port ${PORT}`));
