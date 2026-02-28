// DM-2026 backend — v32.0 (WAN + KLING HYBRID)
// ✅ ПОЛНАЯ СИНХРОНИЗАЦИЯ: ПЕРВЫЙ СТИЛЬ -> WAN, ОСТАЛЬНЫЕ -> KLING
// ✅ БЕЗ МАЛЫХ КРАСОК. БЕЗ СТАРОЙ ЛОГИКИ ОШИБОК.

import express from "express";
import multer from "multer";

const VERSION = "DM-2026 v32.0 (HYBRID STABLE)";
const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.PORT || "8080", 10);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
const REPLICATE_IMAGE_VERSION = process.env.REPLICATE_IMAGE_VERSION || "0f1178f5a27e9aa2d2d39c8a43c110f7fa7cbf64062ff04a04cd40899e546065";

// МОДЕЛИ ВИДЕО (Берем из ENV или используем жесткие хэши)
const WAN_MODEL = process.env.WAN_VIDEO_VERSION || "a4ef959146c98679d6c3c54483750058e5ec29b00e3093223126f562e245a190"; 
const KLING_MODEL = process.env.KLING_VIDEO_VERSION || "69e66597148ef2e28329623e1cf307b22a2754d92e59103c8121f64983050017";

const upload = multer({ storage: multer.memoryStorage() });
const magicJobs = new Map();

function bufferToDataUri(buf) { return `data:image/png;base64,${buf.toString("base64")}`; }

// --- API ЭНДПОИНТЫ ---

app.post("/video/start", upload.single("image"), async (req, res) => {
  try {
    const styleId = (req.body?.styleId || "").toString().trim();
    const userPrompt = (req.body?.prompt || "").toString().trim();
    
    // ЛОГИКА: Если это первый стиль (Animation) -> Wan, иначе -> Kling
    const isWan = (styleId === "vid_animation");
    const model = isWan ? WAN_MODEL : KLING_MODEL;

    // Формируем промпт: если есть текст от юзера — берем его, иначе стандарт
    const finalPrompt = userPrompt || (isWan 
      ? "Cinematic living animation. Subtle breathing, eye blinking. Pixar style." 
      : "High-energy 3D dance animation. Rhythmic jumping and dancing. Dynamic lighting.");

    const input = isWan 
      ? { image: bufferToDataUri(req.file.buffer), prompt: finalPrompt }
      : { image: bufferToDataUri(req.file.buffer), prompt: finalPrompt, duration: "5", cfg_scale: 0.5 };

    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: model, input })
    });

    const pred = await r.json();
    if (pred.error) return res.status(422).json({ ok: false, error: pred.error });
    
    // Возвращаем ID от Replicate напрямую
    return res.status(200).json({ ok: true, id: pred.id });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e) }); }
});

app.get("/video/status", async (req, res) => {
  try {
    const r = await fetch(`https://api.replicate.com/v1/predictions/${req.query.id}`, {
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` }
    });
    const p = await r.json();
    return res.json({ ok: true, status: p.status, outputUrl: p.output });
  } catch (e) { return res.status(500).json({ ok: false }); }
});

// ФОТО-РЕЖИМ (Сокращенная стабильная версия)
app.post("/magic", upload.single("image"), async (req, res) => {
  try {
    const styleId = (req.body?.styleId || "").toString().trim();
    const r = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: REPLICATE_IMAGE_VERSION, input: { prompt: `Masterpiece illustration style: ${styleId}`, input_image: bufferToDataUri(req.file.buffer), aspect_ratio: "match_input_image" } })
    });
    const pred = await r.json();
    const id = `m_${crypto.randomUUID()}`;
    magicJobs.set(id, { predId: pred.id });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ ok: false }); }
});

app.get("/magic/status", async (req, res) => {
  const job = magicJobs.get(req.query.id);
  const r = await fetch(`https://api.replicate.com/v1/predictions/${job?.predId || req.query.id}`, { headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` } });
  const p = await r.json();
  res.json({ ok: true, status: p.status, outputUrl: p.output });
});

app.get("/", (req, res) => res.send(`DM-2026 Backend OK (${VERSION})`));
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 ${VERSION} active`));
