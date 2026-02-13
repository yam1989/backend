
// DM-2026 Production Backend (Replicate ONLY)
// Image: /magic start + /magic/status polling
// Video: /video/start + /video/status polling

import express from 'express';
import multer from 'multer';

const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

const upload = multer({ limits: { fileSize: 12 * 1024 * 1024 } });

const env = (k, d = undefined) => (process.env[k] ?? d);

// Required
const REPLICATE_API_TOKEN = env('REPLICATE_API_TOKEN');
if (!REPLICATE_API_TOKEN) throw new Error('REPLICATE_API_TOKEN is required');

// Image model
const REPLICATE_IMAGE_OWNER = env('REPLICATE_IMAGE_OWNER');
const REPLICATE_IMAGE_MODEL = env('REPLICATE_IMAGE_MODEL');

// Video model
const REPLICATE_VIDEO_OWNER = env('REPLICATE_VIDEO_OWNER', env('REPLICATE_OWNER'));
const REPLICATE_VIDEO_MODEL = env('REPLICATE_VIDEO_MODEL', env('REPLICATE_MODEL'));

// Input keys
const IMG_INPUT_KEY = env('IMG_INPUT_KEY', 'image');
const VIDEO_INPUT_KEY = env('VIDEO_INPUT_KEY', 'image');

// Image quality/bounds
const IMAGE_STEPS = Number(env('IMAGE_STEPS', '24'));
const IMAGE_GUIDANCE = Number(env('IMAGE_GUIDANCE', '4.5'));
const IMAGE_ASPECT_RATIO = env('IMAGE_ASPECT_RATIO', '3:2');

// Video quality/bounds
const VIDEO_FPS = Number(env('VIDEO_FPS', '18'));
const VIDEO_RESOLUTION = env('VIDEO_RESOLUTION', '480p');
const VIDEO_DEFAULT_SECONDS = Number(env('VIDEO_DEFAULT_SECONDS', '4'));
const VIDEO_MAX_SECONDS = Number(env('VIDEO_MAX_SECONDS', '5'));

// Optional prompt keys (many image models require prompt)
const IMG_PROMPT_KEY = env('IMG_PROMPT_KEY', 'prompt');
const IMG_NEG_PROMPT_KEY = env('IMG_NEG_PROMPT_KEY', 'negative_prompt');

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function toDataUrl(file) {
  const b64 = file.buffer.toString('base64');
  return `data:${file.mimetype};base64,${b64}`;
}

function stylePrompt(styleId) {
  switch ((styleId || '').toLowerCase()) {
    case 'anime':
      return 'clean kid-friendly anime style, crisp lineart, smooth cel shading, bright but premium colors';
    case 'pixar':
      return 'premium kid-friendly 3d animation look, soft gradients, clean edges, gentle lighting, no realism';
    default:
      return 'premium kids illustration style, crisp clean lineart, smooth clean fills, gentle shading, vibrant but tasteful colors';
  }
}

function baseStructureLock() {
  return [
    'Keep the exact same composition and framing as the input drawing.',
    'Do NOT zoom, do NOT crop, do NOT rotate, do NOT shift the subject.',
    'Do NOT add new objects, characters, text, borders, or stickers.',
    'Fill the canvas fully, no white margins, no empty paper areas.',
    'Preserve the child drawing identity (same pose, silhouette, proportions).',
    'Improve quality only: clean lines, better colors, neat shading.'
  ].join(' ');
}

async function replicateCreatePrediction(owner, model, input) {
  if (!owner || !model) throw new Error('Replicate model env is missing (owner/model)');
  const url = `https://api.replicate.com/v1/models/${owner}/${model}/predictions`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Replicate create failed: ${t}`);
  }
  return r.json();
}

async function replicateGetPrediction(id) {
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Replicate status failed: ${t}`);
  }
  return r.json();
}

app.get('/', (req, res) => res.status(200).send('DM-2026 backend: OK'));
app.get('/health', (req, res) => res.status(200).json({ ok: true }));
app.get('/me', (req, res) =>
  res.status(200).json({
    service: 'backend',
    mode: 'replicate',
    ok: true,
    image: { owner: REPLICATE_IMAGE_OWNER || null, model: REPLICATE_IMAGE_MODEL || null, img_input_key: IMG_INPUT_KEY },
    video: { owner: REPLICATE_VIDEO_OWNER || null, model: REPLICATE_VIDEO_MODEL || null, video_input_key: VIDEO_INPUT_KEY }
  })
);

// IMAGE start
app.post('/magic', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'image required' });
    const styleId = String(req.body.styleId || '');

    const imageDataUrl = toDataUrl(req.file);
    const prompt = `${baseStructureLock()} ${stylePrompt(styleId)}`;

    const input = {
      [IMG_INPUT_KEY]: imageDataUrl,
      [IMG_PROMPT_KEY]: prompt,
      [IMG_NEG_PROMPT_KEY]: 'zoomed in, cropped, out of frame, extra objects, text, watermark, border, white margin, empty paper',
      steps: IMAGE_STEPS,
      guidance: IMAGE_GUIDANCE,
      aspect_ratio: IMAGE_ASPECT_RATIO
    };

    const pred = await replicateCreatePrediction(REPLICATE_IMAGE_OWNER, REPLICATE_IMAGE_MODEL, input);
    res.status(200).json({ ok: true, id: pred.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// IMAGE status
app.get('/magic/status', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });

    const pred = await replicateGetPrediction(id);

    res.status(200).json({
      ok: true,
      status: pred.status,
      output: pred.output ?? null,
      error: pred.error ?? null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// VIDEO start
app.post('/video/start', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'image required' });

    const styleId = String(req.body.styleId || '');
    const seconds = clampInt(req.body.seconds ?? VIDEO_DEFAULT_SECONDS, 4, VIDEO_MAX_SECONDS, VIDEO_DEFAULT_SECONDS);

    const imageDataUrl = toDataUrl(req.file);

    const VIDEO_PROMPT_KEY = env('VIDEO_PROMPT_KEY', '');
    const baseVideoInput = {
      [VIDEO_INPUT_KEY]: imageDataUrl,
      seconds,
      fps: VIDEO_FPS,
      resolution: VIDEO_RESOLUTION
    };

    if (VIDEO_PROMPT_KEY) {
      baseVideoInput[VIDEO_PROMPT_KEY] = `${baseStructureLock()} ${stylePrompt(styleId)} subtle smooth motion, gentle camera drift, tiny magical particles`;
    }

    const pred = await replicateCreatePrediction(REPLICATE_VIDEO_OWNER, REPLICATE_VIDEO_MODEL, baseVideoInput);

    res.status(200).json({ ok: true, id: pred.id, seconds, fps: VIDEO_FPS, resolution: VIDEO_RESOLUTION });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// VIDEO status
app.get('/video/status', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });

    const pred = await replicateGetPrediction(id);

    res.status(200).json({
      ok: true,
      status: pred.status,
      output: pred.output ?? null,
      error: pred.error ?? null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`DM-2026 Replicate backend listening on 0.0.0.0:${PORT}`);
});
