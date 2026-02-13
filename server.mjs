
// DM-2026 Production Backend (Replicate Only)
// Image ≤5¢ | Video 480p 4–5 sec ≤15¢

import express from 'express';
import multer from 'multer';

const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' }));

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

const {
  REPLICATE_API_TOKEN,
  REPLICATE_IMAGE_OWNER,
  REPLICATE_IMAGE_MODEL,
  REPLICATE_VIDEO_OWNER,
  REPLICATE_VIDEO_MODEL,
  IMG_INPUT_KEY = "image",
  VIDEO_INPUT_KEY = "image",
  IMAGE_STEPS = "24",
  IMAGE_GUIDANCE = "4.5",
  IMAGE_ASPECT_RATIO = "3:2",
  VIDEO_FPS = "18",
  VIDEO_RESOLUTION = "480p",
  VIDEO_DEFAULT_SECONDS = "4",
  VIDEO_MAX_SECONDS = "5"
} = process.env;

if (!REPLICATE_API_TOKEN) {
  throw new Error("REPLICATE_API_TOKEN is required");
}

const PORT = Number(process.env.PORT || 8080);

app.get('/', (req, res) => res.status(200).send('DM-2026 backend: OK'));
app.get('/health', (req, res) => res.status(200).json({ ok: true }));
app.get('/me', (req, res) =>
  res.status(200).json({ service: 'backend', mode: 'replicate', ok: true })
);

async function replicateRun(owner, model, input) {
  const response = await fetch(`https://api.replicate.com/v1/models/${owner}/${model}/predictions`, {
    method: "POST",
    headers: {
      "Authorization": `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ input })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(err);
  }

  return response.json();
}

app.post('/magic', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image required" });

    const base64 = req.file.buffer.toString('base64');
    const imageUrl = `data:${req.file.mimetype};base64,${base64}`;

    const input = {
      [IMG_INPUT_KEY]: imageUrl,
      steps: Number(IMAGE_STEPS),
      guidance: Number(IMAGE_GUIDANCE),
      aspect_ratio: IMAGE_ASPECT_RATIO
    };

    const result = await replicateRun(REPLICATE_IMAGE_OWNER, REPLICATE_IMAGE_MODEL, input);

    res.json({ ok: true, id: result.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/video/start', upload.single('image'), async (req, res) => {
  try {
    const seconds = Math.min(
      Number(req.body.seconds || VIDEO_DEFAULT_SECONDS),
      Number(VIDEO_MAX_SECONDS)
    );

    if (!req.file) return res.status(400).json({ error: "image required" });

    const base64 = req.file.buffer.toString('base64');
    const imageUrl = `data:${req.file.mimetype};base64,${base64}`;

    const input = {
      [VIDEO_INPUT_KEY]: imageUrl,
      seconds,
      fps: Number(VIDEO_FPS),
      resolution: VIDEO_RESOLUTION
    };

    const result = await replicateRun(REPLICATE_VIDEO_OWNER, REPLICATE_VIDEO_MODEL, input);

    res.json({ ok: true, id: result.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/video/status', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "id required" });

    const response = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` }
    });

    const data = await response.json();

    res.json({
      ok: true,
      status: data.status,
      output: data.output || null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DM-2026 Replicate backend running on port ${PORT}`);
});
