// DM-2026 backend — Cloud Run (Node 20 + Express)
// ✅ ВСЕ ФУНКЦИИ (ВИДЕО + ФОТО) СОХРАНЕНЫ
// ✅ ПРОМПТЫ УСИЛЕНЫ: АКВАРЕЛЬ, ПИКСЕЛЬ (MINECRAFT), СКАЗКА + добавлены style-specific negatives (v13)

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 FULL v13.0 (STYLE ENFORCEMENT + NEGATIVE CONSTRAINTS)";

const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_IMAGE_VERSION = (process.env.REPLICATE_IMAGE_VERSION ||
  "0f1178f5a27e9aa2d2d39c8a43c110f7fa7cbf64062ff04a04cd40899e546065").trim();
const REPLICATE_VIDEO_VERSION = (process.env.REPLICATE_VIDEO_VERSION || "").trim();

// --- ОБНОВЛЕННЫЙ СЛОВАРЬ СТИЛЕЙ (POS + NEG) ---
const styleSpecMap = {
  style_3d_magic: {
    pos:
      "Ultra high-end Pixar / Disney 3D character redesign. Cinematic global illumination, volumetric light rays, subsurface scattering. " +
      "Premium animated movie rendering. Real depth in fur and materials, physically based rendering. " +
      "Glossy expressive eyes with detailed reflections. Clean studio background, masterpiece animation frame.",
    neg:
      "NO flat 2D. NO anime lines. NO halftone. NO comic dots. NO cardboard craft. NO LEGO studs. NO voxel blocks. " +
      "NO watercolor bleeding. NO paper texture."
  },

  style_blocks: {
    pos:
      "Full LEGO brick reconstruction. Character MUST be entirely built from glossy interlocking plastic bricks with visible studs. " +
      "Injection-molded toy plastic material, vibrant primary colors, clean modular geometry. Studio toy photography lighting.",
    neg:
      "NO fur. NO paint strokes. NO watercolor. NO paper texture. NO pencil lines. NO organic skin. " +
      "NO neon glow outlines. NO halftone comic print. NO clay fingerprints. NO voxels without studs."
  },

  style_pixels: {
    pos:
      "TRUE 3D voxel Minecraft reconstruction. The monster MUST be rebuilt entirely from cubic voxel blocks. " +
      "All forms are square. Pixel-perfect block detail. Sandbox game aesthetic, simple game lighting, crisp edges.",
    neg:
      "NO curves. NO smooth surfaces. NO fur strands. NO pencil strokes. NO paper. NO watercolor. " +
      "NO LEGO studs. NO cardboard fibers. NO halftone comic dots. NO neon glowing outlines."
  },

  style_fairy: {
    pos:
      "Golden age Disney 1950s fairytale illustration. Fully hand-painted gouache artwork. Soft romantic pastel palette. " +
      "Magical glow aura, storybook lighting, warm rim light, rich painted textures. Character completely repainted.",
    neg:
      "NO 3D render look. NO plastic shine. NO LEGO. NO voxels. NO comic halftone. NO cyber neon. " +
      "NO modern anime cel shading. NO visible pencil lines or paper photo artifacts."
  },

  style_anime: {
    pos:
      "Authentic 2D cel-shaded Japanese anime style. Clean hand-drawn ink outlines, flat vibrant color fills, " +
      "minimal cel shading. Whimsical painted background. Studio Ghibli inspired cinematic frame.",
    neg:
      "NO 3D shading. NO PBR realism. NO plastic toy look. NO LEGO. NO voxels. NO comic halftone dots. " +
      "NO watercolor bleed-heavy diffusion. NO neon cyber outlines."
  },

  style_clay: {
    pos:
      "Ultra-thick stop-motion plasticine claymation. Chunky handmade sculpted shapes. Deep visible fingerprints and tool marks. " +
      "Soft volumetric 3D lighting. Glossy oily clay reflections. Real film prop aesthetic.",
    neg:
      "NO smooth digital 3D render. NO anime lines. NO watercolor paint. NO paper texture. NO LEGO studs. " +
      "NO voxel blocks. NO halftone comic dots. NO neon outline-only rendering."
  },

  style_neon: {
    pos:
      "Cyberpunk neon glow, futuristic synthwave aesthetic, glowing outlines, high contrast, dark background." +
      "Bright luminous outlines tracing silhouette, holographic glow, subtle glitch energy. High contrast, reflective surface.",
    neg:
      "NO watercolor. NO paper texture. NO pencil lines. NO LEGO. NO cardboard craft. NO halftone comic print. " +
      "NO clay fingerprints. NO voxel Minecraft blocks. NO soft Disney 1950s storybook paint."
  },

    // 🎨 МЯГКАЯ ДЕТСКАЯ МАСЛЯНАЯ ЖИВОПИСЬ
  style_watercolor: {
    pos:
      "Soft children's oil painting on canvas. " +
      "Thick but gentle impasto brush strokes. " +
      "Creamy blended oil paint texture. " +
      "Warm pastel oil palette. " +
      "Visible canvas fabric texture. " +
      "Rounded soft edges. " +
      "Painterly depth with soft light and shadow. " +
      "Completely repaint from scratch in oil paint. " +
      "Replace all original lines with expressive brushwork.",
    neg:
      "NO watercolor bleeding. NO paper texture. NO pencil lines. " +
      "NO crisp black outlines. NO vector style. " +
      "NO LEGO plastic. NO voxel blocks. NO halftone comic dots."
  },

  style_cardboard: {
    pos:
      "Handcrafted corrugated cardboard sculpture. Layered cut-out brown paper sheets. Visible fluted inner texture. " +
      "Rough torn edges, handmade glue seams. Multi-layer 3D diorama look. Realistic tabletop craft photography.",
    neg:
      "NO watercolor paint. NO glossy plastic. NO LEGO studs. NO voxel blocks. NO neon glow outlines. " +
      "NO halftone comic dots. NO smooth digital 3D render. NO anime cel shading."
  },

  style_comic: {
    pos:
      "1960s vintage pop-art comic style. Bold thick black ink outlines. Strong halftone dot shading. " +
      "Limited CMYK print palette. Retro paper print texture. Slight color misregistration. Graphic high contrast.",
    neg:
      "NO watercolor bleed. NO 3D Pixar look. NO LEGO. NO voxels. NO clay fingerprints. NO cardboard fibers. " +
      "NO neon sci-fi glow lines."
  }
};

function getStyleExtra(styleId) {
  const k = String(styleId || "").trim();
  return styleSpecMap[k]?.pos || "Transform into a premium 3D cartoon illustration.";
}

function getStyleNegative(styleId) {
  const k = String(styleId || "").trim();
  return styleSpecMap[k]?.neg || "";
}

// ✅ ИЗМЕНЕНО ТОЛЬКО ДЛЯ АКВАРЕЛИ: убрали конфликт "no paper" vs "watercolor paper"
function buildKontextPrompt(styleId) {
  const sid = String(styleId || "").trim();

  const baseGeneric =
    "Masterpiece art transformation. Convert the child's drawing into a high-end, colorful illustration. " +
    "STRICT: Keep original composition. Do NOT zoom. Do NOT crop. Do NOT rotate. Keep full character in frame. " +
    "Maintain the original silhouette and pose but TOTALLY replace materials/texture in the target style. " +
    "Remove all paper artifacts, handwriting, and pencil lines. " +
    "No frames, no borders, no UI, no stickers, no watermark, no text. " +
    "Professional commercial artwork look. Clean output.";

  const baseWatercolor =
    "Masterpiece art transformation. Convert the child's drawing into a high-end watercolor painting. " +
    "STRICT: Keep original composition. Do NOT zoom. Do NOT crop. Do NOT rotate. Keep full character in frame. " +
    "Maintain the original silhouette and pose but TOTALLY repaint in watercolor. " +
    "REMOVE notebook/photo artifacts, remove graphite/pencil and handwriting, but render on watercolor paper texture. " +
    "No frames, no borders, no UI, no stickers, no watermark, no text. " +
    "Fine art watercolor look. Clean output.";

  const globalNegativeGeneric =
    "STRICT NEGATIVE: no photo of paper, no notebook background, no graphite, no sketch lines, " +
    "no blur crop, no cut-off body parts, no extra limbs, no duplicated faces, no extra characters, " +
    "no random objects, no text, no logos, no watermarks.";

  const globalNegativeWatercolor =
    "STRICT NEGATIVE: no notebook lines, no ruled paper, no photo glare, no camera shadows, " +
    "no graphite, no sketch lines, no handwriting, " +
    "no blur crop, no cut-off body parts, no extra limbs, no duplicated faces, no extra characters, " +
    "no random objects, no text, no logos, no watermarks.";

  const stylePos = getStyleExtra(sid);
  const styleNeg = getStyleNegative(sid);

  const styleEnforcement =
    "STYLE ENFORCEMENT: The final result must match ONLY the requested style materials and rendering. " +
    "If anything conflicts with the style, remove it.";

  const negBlock = styleNeg ? `STRICT STYLE NEGATIVE: ${styleNeg}` : "";

  const base = sid === "style_watercolor" ? baseWatercolor : baseGeneric;
  const globalNegative = sid === "style_watercolor" ? globalNegativeWatercolor : globalNegativeGeneric;

  return `${base} ${styleEnforcement} ${stylePos} ${globalNegative} ${negBlock}`.trim();
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

app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    const file = req.file;
    const styleId = (req.body?.styleId || "").toString().trim();
    if (!file?.buffer) return res.status(400).json({ ok: false, error: "Missing image" });

    const input = {
      prompt: buildKontextPrompt(styleId),
      input_image: bufferToDataUri(file.buffer, file.mimetype),
      aspect_ratio: "match_input_image",
      prompt_upsampling: false,
      output_format: "png",
      safety_tolerance: 2
    };

    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: REPLICATE_IMAGE_VERSION, input })
    });

    const pred = await r.json();
    const id = `m_${crypto.randomUUID()}`;
    magicJobs.set(id, { status: "processing", predId: pred.id, createdAt: Date.now() });
    return res.status(200).json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/magic/status", async (req, res) => {
  const id = (req.query?.id || "").toString().trim();
  const job = magicJobs.get(id);
  if (!job) return res.json({ ok: true, status: "failed", error: "Expired" });
  if (job.status === "succeeded")
    return res.json({ ok: true, status: "succeeded", outputUrl: `${req.protocol}://${req.get("host")}/magic/result?id=${id}` });

  const r = await fetch(`https://api.replicate.com/v1/predictions/${job.predId}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` }
  });
  const p = await r.json();
  if (p.status === "succeeded") {
    job.status = "succeeded";
    job.rawUrl = p.output;
    magicJobs.set(id, job);
  }
  return res.json({
    ok: true,
    status: p.status,
    outputUrl: p.status === "succeeded" ? `${req.protocol}://${req.get("host")}/magic/result?id=${id}` : null
  });
});

app.get("/magic/result", async (req, res) => {
  const id = (req.query?.id || "").toString().trim();
  const job = magicJobs.get(id);
  if (!job || !job.rawUrl) return res.status(404).send("Not ready");
  const r = await fetch(job.rawUrl);
  res.setHeader("Content-Type", "image/png");
  return res.status(200).send(Buffer.from(await r.arrayBuffer()));
});

app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ ok: false, error: "Missing image" });
    const prompt = buildVideoPrompt(req.body?.prompt);
    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: REPLICATE_VIDEO_VERSION, input: { image: bufferToDataUri(file.buffer, file.mimetype), prompt } })
    });
    const pred = await r.json();
    return res.status(200).json({ ok: true, id: pred.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/video/status", async (req, res) => {
  const id = (req.query?.id || "").toString().trim();
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` }
  });
  const p = await r.json();
  return res.json({ ok: true, status: p.status, outputUrl: p.output });
});

app.get("/", (req, res) => res.send("DM-2026 Backend Full OK"));
app.listen(PORT, "0.0.0.0", () => console.log(`✅ ${VERSION} on port ${PORT}`));
