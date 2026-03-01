// DM-2026 backend — Cloud Run (Node 20 + Express)
// ✅ PHOTO + VIDEO endpoints preserved
// ✅ STYLE ENFORCEMENT + NEGATIVE CONSTRAINTS
// ✅ VIDEO ACTION MAP + STRONG VIDEO GUARDRAILS

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 FULL v13.1 (VIDEO ACTION MAP + STRONG VIDEO GUARDRAILS)";

const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_IMAGE_VERSION = (
  process.env.REPLICATE_IMAGE_VERSION ||
  "0f1178f5a27e9aa2d2d39c8a43c110f7fa7cbf64062ff04a04cd40899e546065"
).trim();
const REPLICATE_VIDEO_VERSION = (process.env.REPLICATE_VIDEO_VERSION || "").trim();

// --- STYLE DICTIONARY (POS + NEG) ---
const styleSpecMap = {
  style_3d_magic: {
    pos:
      "Ultra high-end Pixar / Disney 3D character redesign. Cinematic global illumination, volumetric light rays, subsurface scattering. " +
      "Premium animated movie rendering. Real depth in fur and materials, physically based rendering. " +
      "Glossy expressive eyes with detailed reflections. Clean studio background, masterpiece animation frame.",
    neg:
      "NO flat 2D. NO anime lines. NO halftone. NO comic dots. NO cardboard craft. NO LEGO studs. NO voxel blocks. " +
      "NO watercolor bleeding. NO paper texture. NO text."
  },

  style_blocks: {
    pos:
      "Full LEGO brick reconstruction. Character MUST be entirely built from glossy interlocking plastic bricks with visible studs. " +
      "Injection-molded toy plastic material, vibrant primary colors, clean modular geometry. Studio toy photography lighting.",
    neg:
      "NO fur. NO paint strokes. NO watercolor. NO paper texture. NO pencil lines. NO organic skin. " +
      "NO neon glow outlines. NO halftone comic print. NO clay fingerprints. NO voxels without studs. NO text."
  },

  style_pixels: {
    pos:
      "TRUE 3D voxel Minecraft reconstruction. The monster MUST be rebuilt entirely from cubic voxel blocks. " +
      "All forms are square. Pixel-perfect block detail. Sandbox game aesthetic, simple game lighting, crisp edges.",
    neg:
      "NO curves. NO smooth surfaces. NO fur strands. NO pencil strokes. NO paper. NO watercolor. " +
      "NO LEGO studs. NO cardboard fibers. NO halftone comic dots. NO neon glowing outlines. NO text."
  },

  style_fairy: {
    pos:
      "Golden age Disney 1950s fairytale illustration. Fully hand-painted gouache artwork. Soft romantic pastel palette. " +
      "Magical glow aura, storybook lighting, warm rim light, rich painted textures. Character completely repainted.",
    neg:
      "NO 3D render look. NO plastic shine. NO LEGO. NO voxels. NO comic halftone. NO cyber neon. " +
      "NO modern anime cel shading. NO visible pencil lines or paper photo artifacts. NO text."
  },

  style_anime: {
    pos:
      "Authentic 2D cel-shaded Japanese anime style. Clean hand-drawn ink outlines, flat vibrant color fills, " +
      "minimal cel shading. Whimsical painted background. Studio Ghibli inspired cinematic frame.",
    neg:
      "NO 3D shading. NO PBR realism. NO plastic toy look. NO LEGO. NO voxels. NO comic halftone dots. " +
      "NO watercolor bleed-heavy diffusion. NO neon cyber outlines. NO text."
  },

  style_clay: {
    pos:
      "Ultra-thick stop-motion plasticine claymation. Chunky handmade sculpted shapes. Deep visible fingerprints and tool marks. " +
      "Soft volumetric 3D lighting. Glossy oily clay reflections. Real film prop aesthetic.",
    neg:
      "NO smooth digital 3D render. NO anime lines. NO watercolor paint. NO paper texture. NO LEGO studs. " +
      "NO voxel blocks. NO halftone comic dots. NO neon outline-only rendering. NO text."
  },

  style_neon: {
    pos:
      "Cyberpunk neon glow, futuristic synthwave aesthetic, glowing outlines, high contrast, dark background. " +
      "Bright luminous outlines tracing silhouette, holographic glow, subtle glitch energy. High contrast, reflective surface.",
    neg:
      "NO watercolor. NO paper texture. NO pencil lines. NO LEGO. NO cardboard craft. NO halftone comic print. " +
      "NO clay fingerprints. NO voxel Minecraft blocks. NO soft Disney 1950s storybook paint. NO text."
  },

  style_plush: {
    pos:
      "Ultra premium plush toy product photo. " +
      "Soft fuzzy microfiber fur texture with visible fibers. " +
      "Hand-sewn stitched seams and embroidery details. " +
      "Stuffed toy proportions with rounded limbs, slightly squishy. " +
      "Warm cozy indoor studio lighting, soft shadow on fabric surface. " +
      "High-end toy photography look, shallow depth of field. " +
      "TOTAL REBUILD as a real plush toy. Remove pencil texture completely.",
    neg:
      "NO plastic material. NO hard shiny surface. NO voxel blocks. NO LEGO studs. " +
      "NO comic ink lines. NO watercolor. NO neon glow. NO flat cel shading. NO text."
  },

  style_princess: {
    pos:
      "Legendary magical princess transformation. " +
      "Pastel pink and lavender with warm gold accents. " +
      "Strong magical glow aura around the character. " +
      "Glitter sparkles and shimmering stardust particles filling the scene. " +
      "Soft glowing rim light and dreamy fairytale lighting. " +
      "Elegant golden crown integrated naturally into the character design. " +
      "Premium kids fantasy illustration, magical bokeh, clean composition. " +
      "TOTAL REPAINT FROM SCRATCH. Remove all pencil texture completely.",
    neg:
      "NO plain drawing look. NO visible crayon/pencil texture. NO flat shading. " +
      "NO dark cyberpunk. NO LEGO blocks. NO voxel cubes. NO Minecraft pixels. " +
      "NO gritty realism. NO comic halftone dots. NO text."
  },

  style_superhero: {
    pos:
      "Ultimate superhero upgrade transformation. " +
      "Heroic power stance. " +
      "Flowing cape with dynamic motion. " +
      "Bright glowing energy aura and lightning sparks. " +
      "High-contrast dramatic heroic lighting (game splash art). " +
      "Clean premium character render, powerful silhouette. " +
      "TOTAL REBUILD FROM SCRATCH into a superhero version. Remove pencil texture completely.",
    neg:
      "NO plush fabric. NO gummy candy. NO ice crystal. NO balloon latex. " +
      "NO LEGO. NO voxel blocks. NO watercolor. NO flat cel shading. NO realistic photo look. NO text."
  },

  // 🍬 GUMMY CANDY (marmalade bears / worms)
  style_candy: {
    pos:
      "Gummy candy creature transformation (gummy bears / gummy worms aesthetic). " +
      "Translucent gelatin candy body with soft internal light scattering. " +
      "Sugary crystal coating on surface (granulated sugar). " +
      "Sticky glossy highlights, candy-shop product look. " +
      "Bright candy colors with layered translucency. " +
      "Smooth rounded gummy shapes, slightly squishy. " +
      "TOTAL REBUILD as real store-bought gummy candy texture. Remove pencil texture completely.",
    neg:
      "NO fur strands. NO fabric seams. NO matte surface. NO plastic toy. " +
      "NO ice crystal edges. NO LEGO. NO voxels. NO comic halftone. " +
      "NO text, NO letters, NO words, NO typography."
  },

  // 🧊 ICE (hard NO TEXT)
  style_ice: {
    pos:
      "Ice crystal creature transformation. " +
      "Translucent frozen body with internal refraction and caustics. " +
      "Sharp crystalline edges and frost patterns. " +
      "Cold blue/cyan rim lighting, icy sparkle glints. " +
      "Subtle frozen mist particles around character. " +
      "TOTAL REBUILD into ice crystal monster. Remove pencil texture completely.",
    neg:
      "NO warm lighting. NO plush fur. NO balloon latex. NO gummy candy. " +
      "NO LEGO. NO voxel blocks. NO comic halftone. NO paper photo. " +
      "ABSOLUTELY NO TEXT, NO LETTERS, NO WORDS, NO TYPOGRAPHY, NO LOREM IPSUM, NO CAPTIONS, NO WATERMARK."
  },

  // 🎈 BALLOON ANIMAL (twisted)
  style_balloon: {
    pos:
      "Balloon animal / party balloon toy transformation. " +
      "Twisted long balloon segments, visible knots and pinch points. " +
      "Inflatable latex balloon material with strong shiny reflections. " +
      "Over-inflated rounded forms connected by twist joints. " +
      "Bright party colors, playful balloon sculpture look. " +
      "Simple clean background, studio flash-like lighting. " +
      "TOTAL REBUILD as a twisted balloon figure (balloon animal style). Remove pencil texture completely.",
    neg:
      "NO plush fur. NO fabric seams. NO ice crystal. NO gummy candy. " +
      "NO hard plastic toy. NO Pixar cinematic render. NO LEGO. NO voxels. " +
      "NO text, NO letters, NO words, NO typography, NO paragraphs."
  },

  // 🎨 (kept) soft children oil painting
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
      "NO LEGO plastic. NO voxel blocks. NO halftone comic dots. NO text."
  },

  style_cardboard: {
    pos:
      "Handcrafted corrugated cardboard sculpture. Layered cut-out brown paper sheets. Visible fluted inner texture. " +
      "Rough torn edges, handmade glue seams. Multi-layer 3D diorama look. Realistic tabletop craft photography.",
    neg:
      "NO watercolor paint. NO glossy plastic. NO LEGO studs. NO voxel blocks. NO neon glow outlines. " +
      "NO halftone comic dots. NO smooth digital 3D render. NO anime cel shading. NO text."
  },

  style_comic: {
    pos:
      "1960s vintage pop-art comic style. Bold thick black ink outlines. Strong halftone dot shading. " +
      "Limited CMYK print palette. Retro paper print texture. Slight color misregistration. Graphic high contrast.",
    neg:
      "NO watercolor bleed. NO 3D Pixar look. NO LEGO. NO voxels. NO clay fingerprints. NO cardboard fibers. " +
      "NO neon sci-fi glow lines. NO text."
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

function buildKontextPrompt(styleId) {
  const sid = String(styleId || "").trim();

  const baseGeneric =
    "Masterpiece art transformation. Convert the child's drawing into a high-end, colorful illustration. " +
    "STRICT: Keep original composition. Do NOT zoom. Do NOT crop. Do NOT rotate. Keep full character in frame. " +
    "Maintain the original silhouette and pose but TOTALLY replace materials/texture in the target style. " +
    "Remove all paper artifacts, handwriting, and pencil lines. " +
    "No frames, no borders, no UI, no stickers, no watermark, no text. " +
    "Professional commercial artwork look. Clean output.";

  // We keep this text for legacy; style_watercolor is oil paint now, but base is still safe.
  const baseWatercolor =
    "Masterpiece art transformation. Convert the child's drawing into a high-end fine art painting. " +
    "STRICT: Keep original composition. Do NOT zoom. Do NOT crop. Do NOT rotate. Keep full character in frame. " +
    "Maintain the original silhouette and pose but TOTALLY repaint. " +
    "REMOVE notebook/photo artifacts, remove graphite/pencil and handwriting. " +
    "No frames, no borders, no UI, no stickers, no watermark, no text. " +
    "Fine art painting look. Clean output.";

  const globalNegativeGeneric =
    "STRICT NEGATIVE: no photo of paper, no notebook background, no graphite, no sketch lines, " +
    "no blur crop, no cut-off body parts, no extra limbs, no duplicated faces, no extra characters, " +
    "no random objects, no text, no logos, no watermarks.";

  const globalNegativePaint =
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
  const globalNegative = sid === "style_watercolor" ? globalNegativePaint : globalNegativeGeneric;

  return `${base} ${styleEnforcement} ${stylePos} ${globalNegative} ${negBlock}`.trim();
}

// -------------------- VIDEO: ACTION MAP + GUARDRAILS --------------------
const videoActionPromptMap = {
  act_happy_dance:
    "small joyful dance in place, playful side-to-side steps, tiny arm motion ONLY if arms already exist, natural body bounce, cute and premium, loopable",
  act_big_laugh:
    "big cheerful laugh expression, shoulders bounce slightly, eyes squint naturally, subtle body motion only, loopable",
  act_jump_spin:
    "small vertical jump followed by gentle 360 spin in place, lands softly, motion stays centered, loopable",
  act_cheer:
    "excited celebration pose, happy bounce upward, raise arms ONLY if arms already exist, joyful expression, loopable",
  act_shy_wave:
    "small shy wave with slight head tilt, gentle body sway, soft friendly emotion, use ONLY existing limbs, loopable",
  act_power_pose:
    "confident power pose, slight chest lift and subtle energy bounce, heroic but child-friendly, no added elements, loopable",
  act_float_bounce:
    "gentle floating upward and soft bounce down, subtle squash-and-stretch within original silhouette, background stays still, loopable",
  act_peek_hide:
    "leans slightly to one side as if peeking, then returns to center playfully, minimal body movement, loopable",
  act_spin_in_place:
    "slow smooth spin in place, centered rotation, natural balance, no distortion, loopable",
  act_sparkle_glow:
    "soft premium glow aura gently pulses around the character edges, subtle cinematic shimmer, NO emoji particles, loopable"
};

function buildVideoPrompt(userPrompt) {
  const raw = String(userPrompt || "").trim();

  const mapped = videoActionPromptMap[raw] || "";
  const actionText = mapped || raw;

  const fallback =
    "gentle alive motion only: subtle breathing and tiny friendly micro-movements, loopable";
  const chosen = actionText || fallback;

  const guardrails =
    "VIDEO ANIMATION TASK: animate ONLY the existing subject in the provided drawing. " +
    "STRICT: preserve original composition and framing. Do NOT zoom, crop, rotate, or change camera. " +
    "Keep background static. Do NOT add any new objects, props, particles, stickers, logos, or UI. " +
    "Do NOT invent new limbs/faces/characters. Do NOT change the character identity. " +
    "ABSOLUTELY NO TEXT, NO LETTERS, NO WORDS, NO TYPOGRAPHY, NO LOREM IPSUM. " +
    "Motion must be smooth, premium, child-friendly, subtle, and loopable. ";

  return `${guardrails}${chosen}`.trim();
}
// ----------------------------------------------------------------------

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

    // Guard: if Replicate returns error, don't enqueue broken job
    if (!pred?.id) {
      return res.status(500).json({
        ok: false,
        error: pred?.detail || pred?.error || "Replicate prediction failed"
      });
    }

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

  if (job.status === "succeeded") {
    return res.json({
      ok: true,
      status: "succeeded",
      outputUrl: `${req.protocol}://${req.get("host")}/magic/result?id=${id}`
    });
  }

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

    if (!REPLICATE_VIDEO_VERSION) {
      return res.status(500).json({ ok: false, error: "Missing REPLICATE_VIDEO_VERSION env" });
    }

    const prompt = buildVideoPrompt(req.body?.prompt);

    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: REPLICATE_VIDEO_VERSION,
        input: {
          image: bufferToDataUri(file.buffer, file.mimetype),
          prompt
        }
      })
    });

    const pred = await r.json();

    if (!pred?.id) {
      return res.status(500).json({
        ok: false,
        error: pred?.detail || pred?.error || "Replicate video prediction failed"
      });
    }

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

app.get("/", (req, res) => res.send(`DM-2026 Backend OK (${VERSION})`));
app.listen(PORT, "0.0.0.0", () => console.log(`✅ ${VERSION} on port ${PORT}`));
