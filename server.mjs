// DM-2026 backend — v33.1 (STABLE HYBRID PRODUCTION)
// ✅ ИСПРАВЛЕНА ОШИБКА "MISSING ID"
// ✅ KLING 1.5 (ТАНЦЫ) + WAN 2.1 (АНИМАЦИЯ)
// ✅ ВИДЕО ПРОМПТЫ УСИЛЕНЫ: guardrails + no-text + no-new-objects
// ✅ БЕЗ МАСЛЯНЫХ КРАСОК

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 v33.1 (STABLE HYBRID + VIDEO GUARDRAILS)";
const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_IMAGE_VERSION =
  process.env.REPLICATE_IMAGE_VERSION ||
  "0f1178f5a27e9aa2d2d39c8a43c110f7fa7cbf64062ff04a04cd40899e546065";

// МОДЕЛИ ВИДЕО
const WAN_MODEL =
  process.env.WAN_VIDEO_VERSION ||
  "a4ef959146c98679d6c3c54483750058e5ec29b00e3093223126f562e245a190";
const KLING_MODEL =
  process.env.REPLICATE_VIDEO_VERSION ||
  "69e66597148ef2e28329623e1cf307b22a2754d92e59103c8121f64983050017";

// -------------------- VIDEO PROMPTS --------------------

// Старые styleId (совместимость)
const videoStyleMap = {
  vid_animation:
    "subtle living animation only: gentle breathing, soft sway, tiny blinking, premium kids style, smooth loop",
  vid_dance:
    "joyful dance in place with small rhythmic steps and light body bounce, child-friendly, centered motion, smooth loop"
};

// Новые action id (если клиент начнёт слать act_* вместо vid_*)
const videoActionPromptMap = {
  act_happy_dance:
    "small joyful dance in place, playful side-to-side steps, tiny arm motion ONLY if arms already exist, loopable",
  act_big_laugh:
    "big cheerful laugh expression, shoulders bounce slightly, eyes squint naturally, subtle body motion only, loopable",
  act_jump_spin:
    "small vertical jump followed by gentle 360 spin in place, lands softly, motion stays centered, loopable",
  act_cheer:
    "excited celebration pose, happy bounce upward, raise arms ONLY if arms already exist, joyful expression, loopable",
  act_shy_wave:
    "small shy wave with slight head tilt, gentle body sway, use ONLY existing limbs, loopable",
  act_power_pose:
    "confident power pose, slight chest lift and subtle energy bounce, heroic but child-friendly, loopable",
  act_float_bounce:
    "gentle floating upward and soft bounce down, subtle squash-and-stretch within original silhouette, background stays still, loopable",
  act_peek_hide:
    "leans slightly to one side as if peeking, then returns to center playfully, minimal body movement, loopable",
  act_spin_in_place:
    "slow smooth spin in place, centered rotation, natural balance, no distortion, loopable",
  act_sparkle_glow:
    "soft premium glow aura gently pulses around the character edges, subtle cinematic shimmer, NO emoji particles, loopable"
};

// Какие actions считать "танцами/сложными" → Kling
const KLING_ACTIONS = new Set([
  "vid_dance",
  "act_happy_dance",
  "act_jump_spin",
  "act_cheer",
  "act_spin_in_place"
]);

function pickVideoModel(styleId) {
  const sid = String(styleId || "").trim();
  return KLING_ACTIONS.has(sid) ? KLING_MODEL : WAN_MODEL;
}

function pickVideoBasePrompt(styleId) {
  const sid = String(styleId || "").trim();
  return (
    videoActionPromptMap[sid] ||
    videoStyleMap[sid] ||
    videoStyleMap.vid_animation
  );
}

// ВАЖНО: для дешёвых моделей лучше коротко, но guardrails обязателен.
function buildVideoPrompt(styleId) {
  const base = pickVideoBasePrompt(styleId);

  const guardrails =
    "VIDEO ANIMATION TASK. Animate ONLY the existing subject in the provided drawing. " +
    "STRICT: preserve original composition and framing. Do NOT zoom, crop, rotate, or change camera. " +
    "Keep background static. " +
    "Do NOT add any new objects, props, particles, stickers, logos, UI, or extra characters. " +
    "Do NOT invent new limbs/faces. No morphing. " +
    "ABSOLUTELY NO TEXT, NO LETTERS, NO WORDS, NO TYPOGRAPHY, NO LOREM IPSUM. " +
    "Motion must be smooth, premium, child-friendly, subtle, and loopable. ";

  return `${guardrails}${base}`.trim();
}

// -------------------- IMAGE STYLES --------------------

// 16 ФОТО-СТИЛЕЙ
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

function bufferToDataUri(buf) {
  return `data:image/png;base64,${buf.toString("base64")}`;
}

// --- API ---

app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ ok: false, error: "Missing image" });

    const styleId = (req.body?.styleId || "").toString().trim();

    const model = pickVideoModel(styleId);
    const prompt = buildVideoPrompt(styleId);

    // Kling обычно лучше слушает prompt при нормальном cfg.
    // Wan оставляем без лишних параметров (дешевле/стабильнее).
    const isKling = model === KLING_MODEL;

    const input = isKling
      ? {
          image: bufferToDataUri(file.buffer),
          prompt,
          duration: 5,
          cfg_scale: 6
        }
      : {
          image: bufferToDataUri(file.buffer),
          prompt
        };

    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ version: model, input })
    });

    const pred = await r.json();

    if (!pred?.id) {
      console.error("Replicate error:", pred);
      return res.status(422).json({ ok: false, error: "Replicate failed to start" });
    }

    return res.status(200).json({ ok: true, id: pred.id, model });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/video/status", async (req, res) => {
  try {
    const id = (req.query?.id || "").toString().trim();
    const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` }
    });
    const p = await r.json();
    return res.json({ ok: true, status: p.status, outputUrl: p.output });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ ok: false, error: "Missing image" });

    const styleId = (req.body?.styleId || "").toString().trim();
    const s = styleSpecMap[styleId] || { pos: "Premium illustration.", neg: "" };

    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: REPLICATE_IMAGE_VERSION,
        input: {
          prompt: `Masterpiece art: ${s.pos}`,
          input_image: bufferToDataUri(file.buffer),
          aspect_ratio: "match_input_image",
          output_format: "png"
        }
      })
    });

    const pred = await r.json();
    const id = `m_${crypto.randomUUID()}`;
    magicJobs.set(id, { predId: pred.id });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.get("/magic/status", async (req, res) => {
  const id = (req.query?.id || "").toString().trim();
  const job = magicJobs.get(id);

  const predId = job?.predId || id;

  const r = await fetch(`https://api.replicate.com/v1/predictions/${predId}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` }
  });
  const p = await r.json();
  res.json({ ok: true, status: p.status, outputUrl: p.output });
});

app.get("/", (req, res) => res.send(`DM-2026 Backend OK (${VERSION})`));
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 ${VERSION} active`));
