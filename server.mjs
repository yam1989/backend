// DM-2026 backend — v33.2 (WAN 2.2 SINGLE MODEL PRODUCTION)
// ✅ VIDEO: ONE MODEL ONLY (Wan 2.2 i2v A14B via REPLICATE_VIDEO_VERSION)
// ✅ VIDEO: input schema fixed (image + prompt + num_frames + resolution + fps + steps + shift + go_fast)
// ✅ VIDEO: strong guardrails + no-text + no-new-objects
// ✅ IMAGE: /magic unchanged

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 v33.2 (WAN 2.2 SINGLE MODEL + VIDEO GUARDRAILS)";
const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_IMAGE_VERSION =
  process.env.REPLICATE_IMAGE_VERSION ||
  "0f1178f5a27e9aa2d2d39c8a43c110f7fa7cbf64062ff04a04cd40899e546065";

// ✅ ОДНА ВИДЕО-МОДЕЛЬ: Wan 2.2 i2v A14B (hash version)
const REPLICATE_VIDEO_VERSION =
  (process.env.REPLICATE_VIDEO_VERSION || "").toString().trim();

// -------------------- VIDEO PROMPTS --------------------

// Старые styleId (совместимость)
const videoStyleMap = {
  vid_animation:
    "subtle living animation only: gentle breathing, soft sway, tiny blinking, premium kids style, smooth loop",
  vid_dance:
    "joyful dance in place with small rhythmic steps and light body bounce, child-friendly, centered motion, smooth loop"
};

// Новые action id (если клиент шлёт act_*)
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

// Простые безопасные дефолты под цену/стабильность (Wan 2.2)
function getVideoDefaults() {
  // Можно управлять через ENV, но дефолты ок для прод/дешево
  const resolution = (process.env.VIDEO_RESOLUTION || "480p").toString().trim(); // "480p" | "720p"
  const num_frames = parseInt(process.env.VIDEO_NUM_FRAMES || "81", 10); // 81..100
  const frames_per_second = parseInt(process.env.VIDEO_FPS || "16", 10); // 5..24
  const sample_steps = parseInt(process.env.VIDEO_SAMPLE_STEPS || "30", 10); // 1..50 (30 хорошо)
  const sample_shift = Number(process.env.VIDEO_SAMPLE_SHIFT || "5"); // 1..20 (5 дефолт)
  const go_fast = String(process.env.VIDEO_GO_FAST || "false").toLowerCase() === "true";

  return { resolution, num_frames, frames_per_second, sample_steps, sample_shift, go_fast };
}

// --- API ---

app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ ok: false, error: "Missing image" });

    if (!REPLICATE_VIDEO_VERSION) {
      return res.status(500).json({
        ok: false,
        error: "Missing REPLICATE_VIDEO_VERSION env (Wan 2.2 version hash)"
      });
    }

    // Клиент шлёт styleId (vid_* или act_*)
    const styleId = (req.body?.styleId || "").toString().trim();

    const prompt = buildVideoPrompt(styleId);

    const { resolution, num_frames, frames_per_second, sample_steps, sample_shift, go_fast } =
      getVideoDefaults();

    // ✅ Wan 2.2 schema:
    // input: { image, prompt, num_frames, resolution, frames_per_second, sample_steps, sample_shift, go_fast, seed? }
    const input = {
      image: bufferToDataUri(file.buffer),
      prompt,
      num_frames,
      resolution,
      frames_per_second,
      sample_steps,
      sample_shift,
      go_fast
    };

    // optional seed override from client
    const seedRaw = req.body?.seed;
    const seed = seedRaw === undefined || seedRaw === null || seedRaw === "" ? null : parseInt(seedRaw, 10);
    if (Number.isFinite(seed)) input.seed = seed;

    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ version: REPLICATE_VIDEO_VERSION, input })
    });

    const pred = await r.json();

    if (!pred?.id) {
      console.error("Replicate error:", pred);
      return res.status(422).json({ ok: false, error: "Replicate failed to start", details: pred });
    }

    return res.status(200).json({
      ok: true,
      id: pred.id,
      model: "wan-video/wan-2.2-i2v-a14b",
      used: { styleId, resolution, num_frames, frames_per_second, sample_steps, sample_shift, go_fast }
    });
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
