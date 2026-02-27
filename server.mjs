// DM-2026 backend — Cloud Run (Node 20 + Express)
// ✅ ВСЕ ФУНКЦИИ (ВИДЕО + ФОТО) СОХРАНЕНЫ
// ✅ ОБНОВЛЕНЫ ПРОМПТЫ ДЛЯ ПОЛНОЙ ТРАНСФОРМАЦИИ

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 FULL v11.0 (ULTRA PROMPTS)";

const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_IMAGE_VERSION = (process.env.REPLICATE_IMAGE_VERSION || "0f1178f5a27e9aa2d2d39c8a43c110f7fa7cbf64062ff04a04cd40899e546065").trim();
const REPLICATE_VIDEO_VERSION = (process.env.REPLICATE_VIDEO_VERSION || "").trim();

const styleMap = {
  "style_3d_magic": "Transform into a premium Pixar-style 3D animation, Disney character aesthetic, volumetric lighting, masterpiece.",
  "style_blocks": "Lego photography style, made of plastic interlocking bricks, toy world, vibrant colors, studio lighting.",
  
  // ПИКСЕЛИ: Жесткое требование квадратных пикселей вместо линий
  "style_pixels": "Total digital reconstruction. 8-bit retro video game sprite. The monster must be built from LARGE VISIBLE SQUARE BLOCKS. Pixel-perfect mosaic, aliased edges, no smooth lines, no paper texture.",
  
  // СКАЗКА: Теперь это классический золотой век Диснея
  "style_fairy": "Classic Disney 1950s animation style. Hand-painted gouache illustration, golden age of animation, soft magical glow, lush storybook textures, whimsical and high-end masterpiece.",
  
  // АНИМЕ: Усиливаем контраст и контуры
  "style_anime": "High-contrast Japanese anime, Makoto Shinkai aesthetic, heavy cel-shading, sharp ink outlines, vibrant sky background, professional 2D animation look.",
  
  // ПЛАСТИЛИН: Делаем формы более грубыми и жирными
  "style_clay": "Chunky claymation style. Thick plasticine layers, deep fingerprints, glossy clay reflections, handmade toy aesthetic, soft volumetric shapes, stop-motion masterpiece.",
  
  "style_neon": "Cyberpunk neon glow, futuristic synthwave aesthetic, glowing outlines, high contrast, dark background.",
  
  // АКВАРЕЛЬ: Команда на полное уничтожение карандаша водой
  "style_watercolor": "Professional fluid watercolor art. Extreme paint bleeding, wet-on-wet technique, heavy paper saturation, artistic pigment blooms. NO PENCIL LINES visible, only paint.",
  
  "style_cardboard": "Handmade cardboard craft. The monster must be made of cut-out layered brown corrugated paper. Rough edges, 3D diorama look.",
  
  "style_comic": "Vintage comic book art, halftone dot patterns, bold black ink outlines, pop art style, vibrant colors."
};

function getStyleExtra(styleId) {
  return styleMap[styleId] || "Transform into a premium 3D cartoon illustration.";
}

function buildKontextPrompt(styleId) {
  const base = 
    "Masterpiece art transformation. Convert the child's drawing into a high-end, colorful illustration. " +
    "STRICT: Keep original composition. Do NOT zoom. Do NOT crop. " +
    "Maintain the shapes but TOTALLY change the texture. Remove all paper artifacts and handwriting. " +
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
