import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

const PORT = process.env.PORT || 8080;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

if (!REPLICATE_API_TOKEN) {
  console.error("REPLICATE_API_TOKEN is not set");
  process.exit(1);
}

// ==========================
// HEALTH
// ==========================
app.get("/", (req, res) => {
  res.json({ ok: true });
});

// ==========================
// IMAGE MAGIC (FLUX)
// ==========================
app.post("/magic", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.json({ ok: false, error: "No image provided" });
    }

    const base64Image = req.file.buffer.toString("base64");

    const prompt =
      "Turn this children's drawing into a clean colorful cartoon illustration. Keep composition and identity exactly the same. Do NOT change objects. Improve lines and colors only.";

    const response = await fetch(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: {
            prompt,
            image_prompt: `data:image/png;base64,${base64Image}`,
            aspect_ratio: "1:1",
            output_format: "png",
            safety_tolerance: 2,
            prompt_upsampling: false,
          },
        }),
      }
    );

    const prediction = await response.json();

    if (!prediction.id) {
      return res.json({ ok: false, error: prediction });
    }

    res.json({ ok: true, id: prediction.id });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ==========================
// IMAGE STATUS
// ==========================
app.get("/magic/status", async (req, res) => {
  try {
    const id = req.query.id;

    const response = await fetch(
      `https://api.replicate.com/v1/predictions/${id}`,
      {
        headers: {
          Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        },
      }
    );

    const prediction = await response.json();

    if (prediction.status === "succeeded") {
      return res.json({
        ok: true,
        status: "succeeded",
        outputUrl: prediction.output,
      });
    }

    res.json({
      ok: true,
      status: prediction.status,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ==========================
// VIDEO MAGIC (WAN)
// ==========================
app.post("/video/start", upload.single("file"), async (req, res) => {
  try {
    const base64Image = req.file.buffer.toString("base64");

    const response = await fetch(
      "https://api.replicate.com/v1/models/wan-video/wan-2.2-i2v-fast/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: {
            image: `data:image/png;base64,${base64Image}`,
            prompt:
              "Animate this drawing slightly in cartoon style. Keep identity exactly the same.",
          },
        }),
      }
    );

    const prediction = await response.json();

    res.json({ ok: true, id: prediction.id });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ==========================
// VIDEO STATUS
// ==========================
app.get("/video/status", async (req, res) => {
  try {
    const id = req.query.id;

    const response = await fetch(
      `https://api.replicate.com/v1/predictions/${id}`,
      {
        headers: {
          Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        },
      }
    );

    const prediction = await response.json();

    if (prediction.status === "succeeded") {
      return res.json({
        ok: true,
        status: "succeeded",
        outputUrl: prediction.output,
      });
    }

    res.json({
      ok: true,
      status: prediction.status,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
