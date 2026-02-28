// DM-2026 backend — v29.0 (WAN + KLING 1.5 HYBRID PRODUCTION)
// ✅ ПОЛНАЯ СИНХРОНИЗАЦИЯ С CLOUD RUN ENV VARIABLES
// ✅ ВИДЕО: vid_animation (Wan), vid_dance (Kling 1.5)
// ✅ ФОТО: 16 СТИЛЕЙ (БЕЗ МАСЛЯНЫХ КРАСОК)
// ✅ ИСПРАВЛЕНА ОШИБКА СИНТАКСИСА (LN 275)

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 v29.0 (HYBRID)";
const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_IMAGE_VERSION = process.env.REPLICATE_IMAGE_VERSION || "0f1178f5a27e9aa2d2d39c8a43c110f7fa7cbf64062ff04a04cd40899e546065";

// МОДЕЛИ ВИДЕО (Берем строго из твоих переменных Cloud Run)
const WAN_MODEL = process.env.WAN_VIDEO_VERSION || "a4ef959146c98679d6c3c54483750058e5ec29b00e3093223126f562e245a190"; 
const KLING_MODEL = process.env.REPLICATE_VIDEO_VERSION || "69e66597148ef2e28329623e1cf307b22a2754d92e59103c8121f64983050017";

// МОЩНЫЕ ПРОМПТЫ ВИДЕО
const videoStyleMap = {
  "vid_animation": "Cinematic living animation. Subtle breathing, expressive eye blinking. Pixar style, soft lighting.",
  "vid_dance": "High-energy 3D dance animation. The character is performing rhythmic jumping and full-body dancing movements. Dynamic colorful lighting, confetti. Professional 4k motion."
};

// 16 ФОТО-СТИЛЕЙ (Масляные краски удалены полностью)
const styleSpecMap = {
  style_3d_magic: { pos: "Pixar / Disney 3D character. Cinematic lighting.", neg: "flat 2D, watercolor" },
  style_blocks: { pos: "Full LEGO brick reconstruction. Plastic studs.", neg: "fur, paint, pencil" },
  style_pixels: { pos: "TRUE 3D voxel Minecraft reconstruction.", neg: "curves, smooth, paper" },
  style_fairy: { pos: "Disney 1950s gouache illustration. Magical glow.", neg: "3D render, plastic" },
  style_anime: { pos: "2D cel-shaded anime. Clean ink outlines.", neg: "3D shading, realism" },
  style_clay: { pos: "Stop-motion plasticine claymation. Fingerprints.", neg: "smooth digital" },
  style_neon: { pos: "Cyberpunk neon glow, dark background.", neg: "watercolor, paper" },
  style_plush: { pos: "Plush toy. Soft fuzzy microfiber fabric.", neg: "plastic, LEGO" },
  style_princess: { pos: "Princess transformation. Pastel pink, gold.", neg: "cyberpunk, gritty" },
  style_superhero: { pos: "Superhero upgrade. Power stance, cape.", neg: "plush, watercolor" },
  style_dragon: { pos: "Dragon evolution. scale armor, wings, claws.", neg: "fur, LEGO" },
  style_candy: { pos: "Candy jelly. Glossy gelatin body.", neg: "fur, matte" },
  style_ice: { pos: "Ice crystal. Translucent frozen body.", neg: "warm lighting, plush" },
  style_balloon: { pos: "Inflatable balloon. Glossy latex material.", neg: "fur, fabric" },
  style_cardboard: { pos: "Cardboard sculpture. Layered cut-out paper.", neg: "glossy, LEGO" },
  style_comic: { pos: "Pop-art comic. Bold ink outlines, halftone dots.", neg: "3D Pixar, LEGO" }
};

const upload = multer({ storage: multer.memoryStorage() });
const magicJobs = new Map();

function bufferToDataUri(buf) { return `data:image/png;base64,${buf.toString("base64")}`; }

function buildVideoPrompt(styleId) {
  const sid = String(styleId || "").trim();
  const stylePart = videoStyleMap[sid] || videoStyleMap["vid_animation"];
  return `STRICT: Keep exact character. ${stylePart} No morphing, no extra limbs.`.trim();
}

function buildKontextPrompt(styleId) {
  const sid = String(styleId || "").trim();
  const stylePos = styleSpecMap[sid]?.pos || "Premium 3D cartoon.";
  const styleNeg = styleSpecMap[sid]?.neg || "";
  return `Masterpiece illustration. Convert drawing to high-end art. STYLE: ${stylePos} STRICT NEGATIVE: ${styleNeg}`.trim();
}

// --- API ЭНДПОИНТЫ ---

app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    const styleId = (req.body?.styleId || "").toString().trim();
    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: REPLICATE_IMAGE_VERSION, input: { prompt: buildKontextPrompt(styleId), input_image: bufferToDataUri(req.file.buffer), aspect_ratio: "match_input_image", output_format: "png" } })
    });
    const pred = await r.json();
    const id = `m_${crypto.randomUUID()}`;
    magicJobs.set(id, { status: "processing", predId: pred.id });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ ok: false }); }
});

app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    const styleId = (req.body?.styleId || "").toString().trim();
    const isDance = (styleId === "vid_dance");
    
    // ГИБРИДНАЯ ЛОГИКА: Танцы -> Kling, Остальное -> Wan
    const model = isDance ? KLING_MODEL : WAN_MODEL;
    const prompt = buildVideoPrompt(styleId);

    const input = isDance 
      ? { image: bufferToDataUri(req.file.buffer), prompt: prompt, duration: "5", cfg_scale: 0.5 }
      : { image: bufferToDataUri(req.file.buffer), prompt: prompt };

    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: model, input })
    });
    const pred = await r.json();
    const id = `v_${crypto.randomUUID()}`;
    magicJobs.set(id, { status: "processing", predId: pred.id });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ ok: false }); }
});

app.get("/video/status", async (req, res) => {
  try {
    const job = magicJobs.get(req.query.id);
    const r = await fetch(`https://api.replicate.com/v1/predictions/${job?.predId || req.query.id}`, {
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` }
    });
    const p = await r.json();
    res.json({ ok: true, status: p.status, outputUrl: p.output });
  } catch (e) { res.status(500).json({ ok: false }); }
});

app.get("/magic/status", async (req, res) => {
  try {
    const job = magicJobs.get(req.query.id);
    const r = await fetch(`https://api.replicate.com/v1/predictions/${job.predId}`, {
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` }
    });
    const p = await r.json();
    if (p.status === "succeeded") { job.status = "succeeded"; job.rawUrl = p.output; }
    res.json({ ok: true, status: p.status, outputUrl: p.status === "succeeded" ? `${req.protocol}://${req.get("host")}/magic/result?id=${req.query.id}` : null });
  } catch (e) { res.status(500).json({ ok: false }); }
});

app.get("/magic/result", async (req, res) => {
  try {
    const job = magicJobs.get(req.query.id);
    const r = await fetch(job.rawUrl);
    res.setHeader("Content-Type", "image/png");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).send("Error"); }
});

app.get("/", (req, res) => res.send(`DM-2026 Backend OK (${VERSION})`));
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 ${VERSION} active on port ${PORT}`));
