// DM-2026 backend — v26.0 (WAN + KLING 1.5 HYBRID / NO OIL PAINTS)
import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 HYBRID v26.0 (CLEAN)";
const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_IMAGE_VERSION = "0f1178f5a27e9aa2d2d39c8a43c110f7fa7cbf64062ff04a04cd40899e546065";

// МОДЕЛИ ВИДЕО
const WAN_MODEL = "a4ef959146c98679d6c3c54483750058e5ec29b00e3093223126f562e245a190"; 
const KLING_MODEL = "69e66597148ef2e28329623e1cf307b22a2754d92e59103c8121f64983050017";

// ВИДЕО-СЦЕНАРИИ
const videoStyleMap = {
  "vid_animation": "Cinematic living animation. Subtle breathing, eye blinking. Pixar style.",
  "vid_magic": "Cinematic magic. Breathing, blinking, golden stardust orbit.",
  "vid_hero":  "Epic roar. Fast camera zoom, energy sparks, dramatic lighting.",
  "vid_space": "Zero-gravity. Monster floats and rotates. Bubbles and stardust.",
  "vid_dance": "High-energy dance. Rhythmic jumping and full-body movement. Disco lights.",
  "vid_mood":  "Expressive acting. Detailed eyes, wide smile, Pixar squash and stretch."
};

// ФОТО-СТИЛИ (v13.1 БЕЗ МАСЛА)
const styleSpecMap = {
  style_3d_magic: { pos: "Pixar / Disney 3D character redesign. Cinematic lighting.", neg: "flat 2D, anime, watercolor, paper texture" },
  style_blocks: { pos: "Full LEGO brick reconstruction. Plastic bricks with studs.", neg: "fur, paint, watercolor, pencil lines" },
  style_pixels: { pos: "TRUE 3D voxel Minecraft reconstruction.", neg: "curves, smooth surfaces, paper" },
  style_fairy: { pos: "Disney 1950s illustration. Hand-painted gouache artwork.", neg: "3D render, plastic, LEGO" },
  style_anime: { pos: "2D cel-shaded anime style. Clean ink outlines.", neg: "3D shading, PBR realism" },
  style_clay: { pos: "Stop-motion plasticine claymation. Handmade sculpted shapes.", neg: "smooth digital, anime" },
  style_neon: { pos: "Cyberpunk neon glow, glowing outlines on dark background.", neg: "watercolor, pencil, LEGO" },
  style_plush: { pos: "Plush toy. Soft fuzzy microfiber fabric.", neg: "plastic, voxel, LEGO" },
  style_princess: { pos: "Princess transformation. Pastel pink, lavender, gold.", neg: "cyberpunk, LEGO, gritty" },
  style_superhero: { pos: "Superhero upgrade. Power stance, cape, energy aura.", neg: "plush, jelly, LEGO" },
  style_dragon: { pos: "Dragon evolution. scale armor, wings, claws.", neg: "fur, LEGO, flat cartoon" },
  style_candy: { pos: "Candy jelly. Glossy semi-transparent gelatin.", neg: "fur, matte, LEGO" },
  style_ice: { pos: "Ice crystal. Translucent frozen body, icy sparkle.", neg: "warm lighting, plush, LEGO" },
  style_balloon: { pos: "Inflatable balloon. Glossy latex, rounded limbs.", neg: "fur, fabric, LEGO" },
  style_cardboard: { pos: "Cardboard sculpture. Layered cut-out paper.", neg: "glossy plastic, LEGO, voxel" },
  style_comic: { pos: "Pop-art comic. Bold black ink outlines, halftone.", neg: "3D Pixar, LEGO, voxels" }
};

function buildKontextPrompt(styleId) {
  const sid = String(styleId || "").trim();
  const base = "Masterpiece art transformation. Convert the drawing into a high-end illustration. STRICT: Keep composition, remove all paper artifacts and pencil lines.";
  const stylePos = styleSpecMap[sid]?.pos || "Transform into a premium 3D cartoon.";
  const styleNeg = styleSpecMap[sid]?.neg || "";
  const negBlock = styleNeg ? `STRICT STYLE NEGATIVE: ${styleNeg}` : "";
  return `${base} STYLE: ${stylePos} ${negBlock}`.trim();
}

function buildVideoPrompt(styleId) {
  const sid = String(styleId || "").trim();
  const stylePart = videoStyleMap[sid] || videoStyleMap["vid_animation"];
  return `STRICT: Keep exact character. ${stylePart} Cinematic motion. No morphing.`.trim();
}

const upload = multer({ storage: multer.memoryStorage() });
const magicJobs = new Map();

function bufferToDataUri(buf) { return `data:image/png;base64,${buf.toString("base64")}`; }

// --- API ---

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
    const isBase = (styleId === "vid_animation");
    const model = isBase ? WAN_MODEL : KLING_MODEL;
    const input = isBase 
      ? { image: bufferToDataUri(req.file.buffer), prompt: buildVideoPrompt(styleId) }
      : { image: bufferToDataUri(req.file.buffer), prompt: buildVideoPrompt(styleId), duration: "5", cfg_scale: 0.5 };
    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: model, input })
    });
    const pred = await r.json();
    res.json({ ok: true, id: pred.id });
  } catch (e) { res.status(500).json({ ok: false }); }
});

// Статусы и результаты остаются как были (magic/status, magic/result, video/status)
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 ${VERSION} active`));
