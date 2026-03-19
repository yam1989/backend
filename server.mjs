// DM-2026 backend — Cloud Run (Node 20 + Express)
// ✅ PHOTO + VIDEO endpoints preserved
// ✅ STYLE ENFORCEMENT + NEGATIVE CONSTRAINTS
// ✅ VIDEO ACTION MAP + STRONG VIDEO GUARDRAILS
// ✅ SAFE IMAGE PROMPT UPGRADE (STRUCTURE LOCK, VIDEO UNCHANGED)

import express from "express";
import multer from "multer";
import crypto from "crypto";

const VERSION = "DM-2026 FULL v13.2 (SAFE IMAGE PROMPTS + VIDEO ACTION MAP + STRONG VIDEO GUARDRAILS)";

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
      "Premium soft Pixar / Disney inspired 3D cartoon restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Use rounded soft forms, gentle global illumination, clean soft materials, subtle expressive eyes, and polished family-animation rendering. " +
      "Keep the character simple, childlike, and clearly recognizable as the same drawing. " +
      "Only change rendering, material, and lighting style.",
    neg:
      "NO character redesign. NO anatomy improvement. NO realistic human proportions. NO extra limbs. NO extra fingers. " +
      "NO pose change. NO new character details that alter structure. NO flat 2D anime lines. NO halftone. NO comic dots. " +
      "NO cardboard craft. NO LEGO studs. NO voxel blocks. NO watercolor bleeding. NO paper texture. NO text."
  },

  style_blocks: {
    pos:
      "LEGO brick toy restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and overall shape. " +
      "Rebuild the SAME character using simple glossy interlocking toy bricks with visible studs, vibrant toy colors, and clean studio toy lighting. " +
      "Keep the result minimal, readable, child-friendly, and clearly based on the original drawing rather than a new toy character.",
    neg:
      "NO shape redesign. NO anatomy changes. NO new character identity. NO realistic skin. NO fur. NO paint strokes. " +
      "NO watercolor. NO paper texture. NO pencil lines. NO organic skin. NO neon glow outlines. NO halftone comic print. " +
      "NO clay fingerprints. NO voxels without studs. NO text."
  },

  style_pixels: {
    pos:
      "True voxel pixel-block restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and body layout. " +
      "Recreate the SAME character using simple cubic voxel blocks, crisp square forms, pixel-block surface breakup, and clean game-style lighting. " +
      "Keep it child-friendly, simple, and recognizable as the original drawing translated into voxel form, not a different monster or game mob.",
    neg:
      "NO redesign into a Minecraft mob. NO new creature anatomy. NO monster reinterpretation. NO pose change. NO extra body parts. " +
      "NO curves beyond the original intent. NO smooth realistic surfaces. NO fur strands. NO pencil strokes. NO paper. NO watercolor. " +
      "NO LEGO studs. NO cardboard fibers. NO halftone comic dots. NO neon glowing outlines. NO text."
  },

  style_fairy: {
    pos:
      "Golden-age fairytale illustration restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Use soft storybook painting, romantic pastel palette, magical glow aura, warm fairytale lighting, and rich painted texture. " +
      "Keep the character naive, gentle, childlike, and clearly the same original drawing, only transformed in material and paint style.",
    neg:
      "NO character redesign. NO anatomy improvements. NO realistic proportions. NO 3D render look. NO plastic shine. NO LEGO. NO voxels. " +
      "NO comic halftone. NO cyber neon. NO modern anime cel shading. NO visible pencil lines or paper photo artifacts. NO text."
  },

  style_anime: {
    pos:
      "Authentic soft 2D anime restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Use clean hand-drawn outlines, flat vibrant fills, minimal cel shading, and a whimsical painted atmosphere. " +
      "Keep the character simple, childlike, and recognizably the same drawing rather than redesigning it into a new anime character.",
    neg:
      "NO redesign. NO anatomy enhancement. NO realistic face proportions. NO 3D shading. NO PBR realism. NO plastic toy look. " +
      "NO LEGO. NO voxels. NO comic halftone dots. NO watercolor bleed-heavy diffusion. NO neon cyber outlines. NO text."
  },

  style_clay: {
    pos:
      "Stop-motion plasticine claymation restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Use chunky handmade clay forms, visible soft fingerprints, tool marks, gentle volumetric lighting, and glossy clay reflections. " +
      "Keep the result simple, cute, and clearly the same original child drawing translated into clay.",
    neg:
      "NO redesign. NO anatomy changes. NO realistic sculpting. NO smooth digital 3D render. NO anime lines. NO watercolor paint. " +
      "NO paper texture. NO LEGO studs. NO voxel blocks. NO halftone comic dots. NO neon outline-only rendering. NO text."
  },

  style_neon: {
    pos:
      "Cyber neon glow restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Apply glowing outlines, futuristic synthwave atmosphere, high-contrast lighting, holographic glow accents, and reflective neon mood. " +
      "Keep the character itself simple and unchanged in structure, only restyled with luminous materials and light.",
    neg:
      "NO redesign. NO anatomy changes. NO new accessories that alter shape. NO watercolor. NO paper texture. NO pencil lines. " +
      "NO LEGO. NO cardboard craft. NO halftone comic print. NO clay fingerprints. NO voxel Minecraft blocks. " +
      "NO soft Disney 1950s storybook paint. NO text."
  },

  style_plush: {
    pos:
      "Ultra premium plush toy restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Use soft fuzzy microfiber fur texture, stitched seams, embroidered features, stuffed toy softness, cozy warm lighting, and a high-end toy photo feel. " +
      "Keep the character rounded, simple, childlike, and clearly the same drawing translated into plush material. " +
      "Remove pencil texture and paper artifacts without changing structure.",
    neg:
      "NO character redesign. NO anatomy changes. NO hard shiny plastic look. NO voxel blocks. NO LEGO studs. " +
      "NO comic ink lines. NO watercolor. NO neon glow. NO flat cel shading. NO text."
  },

  style_princess: {
    pos:
      "Legendary magical princess restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Use pastel pink and lavender, warm gold accents, magical glow aura, glitter sparkles, dreamy fairytale lighting, and an elegant crown integrated gently without changing character structure. " +
      "Keep the drawing naive, childlike, and recognizable as the same original figure, only restyled into a princess fantasy mood. " +
      "Remove paper and pencil artifacts without redesigning the character.",
    neg:
      "NO redesign. NO anatomy changes. NO realistic face. NO mature proportions. NO plain rough drawing artifacts. " +
      "NO visible crayon or pencil texture. NO flat boring shading. NO dark cyberpunk. NO LEGO blocks. NO voxel cubes. " +
      "NO Minecraft pixels. NO gritty realism. NO comic halftone dots. NO text."
  },

  style_superhero: {
    pos:
      "Ultimate superhero restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Add heroic costume styling, a cape if compatible with the original shape, bright energy aura, lightning accents, and dramatic kid-friendly heroic lighting. " +
      "Keep the character clearly the same original drawing and do not redesign body structure, muscles, or proportions. " +
      "Remove paper and pencil artifacts while preserving simplicity.",
    neg:
      "NO muscular redesign. NO anatomy changes. NO realistic hero body. NO new body structure. NO plush fabric. NO gummy candy. " +
      "NO ice crystal. NO balloon latex. NO LEGO. NO voxel blocks. NO watercolor. NO flat cel shading. " +
      "NO realistic photo look. NO text."
  },

  // 🍬 GUMMY CANDY (marmalade bears / worms)
  style_candy: {
    pos:
      "Gummy candy creature restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Use translucent gelatin candy material, soft internal light scattering, sugary crystal coating, sticky glossy highlights, bright candy colors, and rounded squishy forms. " +
      "Keep the result simple, playful, and clearly the same original drawing translated into gummy candy material. " +
      "Remove paper and pencil artifacts without changing structure.",
    neg:
      "NO redesign. NO anatomy changes. NO realistic creature body. NO fur strands. NO fabric seams. NO matte surface. NO plastic toy. " +
      "NO ice crystal edges. NO LEGO. NO voxels. NO comic halftone. NO text. NO letters. NO words. NO typography."
  },

  // 🧊 ICE (hard NO TEXT)
  style_ice: {
    pos:
      "Ice crystal restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Use translucent frozen material, internal refraction, soft caustic glow, gentle crystalline surfaces, frost patterns, cold blue rim light, and subtle icy sparkle. " +
      "Keep the character child-friendly, simple, and clearly the same original drawing, not a new monster. " +
      "Remove paper and pencil artifacts without changing structure.",
    neg:
      "NO monster redesign. NO aggressive creature reinterpretation. NO major sharp armor-like geometry that changes the shape. " +
      "NO anatomy changes. NO extra claws. NO extra teeth. NO warm lighting. NO plush fur. NO balloon latex. NO gummy candy. " +
      "NO LEGO. NO voxel blocks. NO comic halftone. NO paper photo. ABSOLUTELY NO TEXT, NO LETTERS, NO WORDS, " +
      "NO TYPOGRAPHY, NO LOREM IPSUM, NO CAPTIONS, NO WATERMARK."
  },

  // 🎈 BALLOON ANIMAL (twisted)
  style_balloon: {
    pos:
      "Balloon animal / party balloon toy restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Translate the same character into twisted inflatable balloon segments with visible knots, glossy latex reflections, rounded inflated forms, and playful party colors. " +
      "Keep the character readable as the original drawing and do not redesign the body into a different balloon sculpture.",
    neg:
      "NO redesign. NO anatomy changes. NO plush fur. NO fabric seams. NO ice crystal. NO gummy candy. " +
      "NO hard plastic toy. NO Pixar cinematic render. NO LEGO. NO voxels. NO text. NO letters. NO words. " +
      "NO typography. NO paragraphs."
  },

  // 🎨 (kept) soft children oil painting
  style_watercolor: {
    pos:
      "Soft children's oil painting restyle on canvas. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Use thick but gentle impasto brush strokes, creamy blended oil paint texture, warm pastel palette, visible canvas texture, rounded soft edges, and painterly depth. " +
      "Keep the drawing simple, childlike, and recognizable as the same original figure while replacing only paint material and surface treatment.",
    neg:
      "NO redesign. NO anatomy changes. NO watercolor bleeding. NO paper texture. NO pencil lines. NO crisp black outlines. " +
      "NO vector style. NO LEGO plastic. NO voxel blocks. NO halftone comic dots. NO text."
  },

  style_cardboard: {
    pos:
      "Handcrafted corrugated cardboard sculpture restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Use layered cut-out cardboard sheets, visible corrugated inner texture, rough torn edges, handmade glue seams, and a tabletop craft look. " +
      "Keep the result simple, readable, and clearly based on the original drawing rather than a redesigned paper creature.",
    neg:
      "NO redesign. NO anatomy changes. NO watercolor paint. NO glossy plastic. NO LEGO studs. NO voxel blocks. " +
      "NO neon glow outlines. NO halftone comic dots. NO smooth digital 3D render. NO anime cel shading. NO text."
  },

  style_comic: {
    pos:
      "1960s vintage pop-art comic restyle. " +
      "Preserve the exact original child drawing proportions, pose, silhouette, and simple anatomy. " +
      "Use bold black ink outlines, strong halftone dot shading, retro print texture, slight color misregistration, and a graphic high-contrast CMYK look. " +
      "Keep the character clearly the same original drawing, only translated into comic print language.",
    neg:
      "NO redesign. NO anatomy changes. NO watercolor bleed. NO 3D Pixar look. NO LEGO. NO voxels. " +
      "NO clay fingerprints. NO cardboard fibers. NO neon sci-fi glow lines. NO text."
  }
};

function getStyleExtra(styleId) {
  const k = String(styleId || "").trim();
  return styleSpecMap[k]?.pos || "Transform into a premium stylized illustration while preserving the exact original child drawing structure.";
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
    "ULTRA STRICT STRUCTURE LOCK: Preserve EXACT original drawing proportions, pose, silhouette, head size, body shape, limb length, limb angles, and character identity. " +
    "Do NOT redesign anatomy. Do NOT reinterpret the character. Do NOT improve proportions. Do NOT make the body more realistic. Do NOT add muscles, creature anatomy, armor anatomy, or complex redesign elements. " +
    "This must still look like the SAME child's drawing, only restyled in material, lighting, and rendering. " +
    "Only replace MATERIAL, SURFACE, and RENDERING STYLE according to the selected style. " +
    "Keep the drawing simple, naive, childlike, and recognizable. " +
    "Remove all paper artifacts, handwriting, notebook traces, camera/photo artifacts, and pencil lines. " +
    "No frames, no borders, no UI, no stickers, no watermark, no text. " +
    "Professional commercial artwork look. Clean output.";

  // We keep this text for legacy; style_watercolor is oil paint now, but base is still safe.
  const baseWatercolor =
    "Masterpiece art transformation. Convert the child's drawing into a high-end fine art painting. " +
    "STRICT: Keep original composition. Do NOT zoom. Do NOT crop. Do NOT rotate. Keep full character in frame. " +
    "ULTRA STRICT STRUCTURE LOCK: Preserve EXACT original drawing proportions, pose, silhouette, head size, body shape, limb length, limb angles, and character identity. " +
    "Do NOT redesign anatomy. Do NOT reinterpret the character. Do NOT improve proportions. " +
    "This must still look like the SAME child's drawing, only repainted in the selected fine art surface style. " +
    "Only replace PAINT MATERIAL, TEXTURE, and RENDERING STYLE. " +
    "Keep the drawing simple, naive, childlike, and recognizable. " +
    "REMOVE notebook/photo artifacts, remove graphite/pencil and handwriting. " +
    "No frames, no borders, no UI, no stickers, no watermark, no text. " +
    "Fine art painting look. Clean output.";

  const globalNegativeGeneric =
    "STRICT NEGATIVE: no photo of paper, no notebook background, no graphite, no sketch lines, no handwriting, " +
    "no blur crop, no cut-off body parts, no extra limbs, no duplicated faces, no extra characters, " +
    "no random objects, no anatomy redesign, no proportion changes, no pose changes, no monster reinterpretation, " +
    "no text, no logos, no watermarks.";

  const globalNegativePaint =
    "STRICT NEGATIVE: no notebook lines, no ruled paper, no photo glare, no camera shadows, " +
    "no graphite, no sketch lines, no handwriting, " +
    "no blur crop, no cut-off body parts, no extra limbs, no duplicated faces, no extra characters, " +
    "no random objects, no anatomy redesign, no proportion changes, no pose changes, " +
    "no text, no logos, no watermarks.";

  const stylePos = getStyleExtra(sid);
  const styleNeg = getStyleNegative(sid);

  const styleEnforcement =
    "STYLE ENFORCEMENT: The final result must match ONLY the requested style materials and rendering while preserving the exact original child drawing structure. " +
    "If anything conflicts with the structure, remove it. If anything conflicts with the selected style, remove it.";

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
