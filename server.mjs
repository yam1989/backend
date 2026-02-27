// DM-2026 backend — v17.0 (SMART STYLE STRENGTH)
import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 FULL v17.0 (PER-STYLE STRENGTH)";
const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_IMAGE_VERSION = (process.env.REPLICATE_IMAGE_VERSION || "0f1178f5a27e9aa2d2d39c8a43c110f7fa7cbf64062ff04a04cd40899e546065").trim();
const REPLICATE_VIDEO_VERSION = (process.env.REPLICATE_VIDEO_VERSION || "").trim();

// --- УМНЫЕ НАСТРОЙКИ СИЛЫ ДЛЯ КАЖДОГО СТИЛЯ ---
const styleConfigs = {
  "style_watercolor": { strength: 0.95, guidance: 10, upsampling: true }, // Максимум силы для Акварели
  "style_pixels":     { strength: 0.90, guidance: 8,  upsampling: true }, // Сильно для Пикселей
  "style_fairy":      { strength: 0.85, guidance: 7.5, upsampling: true }, // Для Диснея
  "style_clay":       { strength: 0.85, guidance: 7.5, upsampling: true }, 
  "style_anime":      { strength: 0.80, guidance: 7.5, upsampling: true },
  "default":          { strength: 0.75, guidance: 7.5, upsampling: false } // Стандарт для 3D, Неона и т.д.
};

const styleMap = {
  "style_3d_magic": "Transform into a premium Pixar-style 3D animation, Disney character aesthetic, volumetric lighting, masterpiece.",
  "style_blocks": "Lego photography style, made of plastic interlocking bricks, toy world, vibrant colors, studio lighting.",
  "style_neon": "Cyberpunk neon glow, futuristic synthwave aesthetic, glowing outlines, high contrast, dark background.",
  "style_comic": "Vintage comic book art, halftone dot patterns, bold black ink outlines, pop art style, vibrant colors.",
  "style_cardboard": "Handmade cardboard craft. The monster must be made of cut-out layered brown corrugated paper. Rough edges, 3D diorama look.",
  "style_pixels": "Minecraft blocky aesthetic. Total 3D Voxel art reconstruction. The monster MUST be built entirely from CUBIC BLOCKS. NO smooth lines, NO pencil, NO paper. Every detail is a pixel-perfect square block.",
  "style_anime": "Classic 2D flat cel-shaded anime style. Studio Ghibli aesthetic, bold hand-drawn ink outlines, flat vibrant colors, NO 3D shading.",
  "style_fairy": "Golden age of Disney animation (1950s). Hand-painted gouache illustration, magical glow, soft storybook textures. Complete character repaint.",
  "style_clay": "Ultra-thick plasticine claymation. Chunky handmade shapes, deep fingerprints, glossy clay reflections, soft volumetric 3D shapes.",
  "style_watercolor": "Professional abstract fluid watercolor art on CLEAN WHITE paper. EXTREME paint bleeding, heavy water drops, artistic pigment blooms. ABSOLUTELY NO PENCIL LINES, NO PEN, NO BLACK OUTLINES."
};

function buildKontextPrompt(styleId) {
  const base = "Masterpiece art transformation. Convert the child's drawing into a high-end illustration. STRICT: Keep composition. Totally change the texture. Remove all paper artifacts and pencil lines.";
  return `${base} ${styleMap[styleId] || ""}`.trim();
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const magicJobs = new Map();

function bufferToDataUri(buf, mime) { return `data:${mime || "image/png"};base64,${buf.toString("base64")}`; }

app.post("/magic", upload.single("image"), async (req,res)=>{
  try {
    const file = req.file;
    const styleId = (req.body?.styleId || "").toString().trim();
    if (!file?.buffer) return res.status(400).json({ ok:false });

    // ВЫБИРАЕМ НАСТРОЙКИ ПОД КОНКРЕТНЫЙ СТИЛЬ
    const config = styleConfigs[styleId] || styleConfigs["default"];

    const input = {
      prompt: buildKontextPrompt(styleId),
      input_image: bufferToDataUri(file.buffer, file.mimetype),
      aspect_ratio: "match_input_image",
      output_format: "png",
      safety_tolerance: 5,
      prompt_strength: config.strength,  // Индивидуальная сила!
      guidance: config.guidance,         // Индивидуальное следование промпту!
      prompt_upsampling: config.upsampling
    };

    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method:"POST",
      headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}`, "Content-Type":"application/json" },
      body: JSON.stringify({ version: REPLICATE_IMAGE_VERSION, input }),
    });
    const pred = await r.json();
    const id = `m_${crypto.randomUUID()}`;
    magicJobs.set(id, { status:"processing", predId: pred.id });
    return res.status(200).json({ ok:true, id });
  } catch (e) { return res.status(500).json({ ok:false }); }
});

// Стандартные эндпоинты статуса и видео (без изменений)
app.get("/magic/status", async (req,res)=>{
  const id = req.query.id;
  const job = magicJobs.get(id);
  if (!job) return res.json({ status:"failed" });
  if (job.status === "succeeded") return res.json({ ok:true, status:"succeeded", outputUrl: `${req.protocol}://${req.get('host')}/magic/result?id=${id}` });
  const r = await fetch(`https://api.replicate.com/v1/predictions/${job.predId}`, { headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}` } });
  const p = await r.json();
  if (p.status === "succeeded") { job.status = "succeeded"; job.rawUrl = p.output; magicJobs.set(id, job); }
  return res.json({ ok:true, status: p.status, outputUrl: p.status === "succeeded" ? `${req.protocol}://${req.get('host')}/magic/result?id=${id}` : null });
});

app.get("/magic/result", async (req,res)=>{
  const job = magicJobs.get(req.query.id);
  if (!job?.rawUrl) return res.status(404).send("Not ready");
  const r = await fetch(job.rawUrl);
  res.setHeader("Content-Type", "image/png");
  return res.status(200).send(Buffer.from(await r.arrayBuffer()));
});

app.post("/video/start", upload.single("image"), async (req,res)=>{
  try {
    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ ok:false });
    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method:"POST",
      headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}`, "Content-Type":"application/json" },
      body: JSON.stringify({ version: REPLICATE_VIDEO_VERSION, input: { image: bufferToDataUri(file.buffer, file.mimetype), prompt: "Animate objects smoothly." } }),
    });
    const pred = await r.json();
    return res.status(200).json({ ok:true, id: pred.id });
  } catch (e) { return res.status(500).json({ ok:false }); }
});

app.get("/video/status", async (req,res)=>{
  const r = await fetch(`https://api.replicate.com/v1/predictions/${req.query.id}`, { headers:{ Authorization:`Token ${REPLICATE_API_TOKEN}` } });
  const p = await r.json();
  return res.json({ ok:true, status: p.status, outputUrl: p.output });
});

app.get("/", (req,res)=>res.send("DM-2026 Backend v17.0 OK"));
app.listen(PORT, "0.0.0.0", () => console.log(`✅ ${VERSION} on port ${PORT}`));
