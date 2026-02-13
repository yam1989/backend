// DM-2026 Cloud Run bootstrap server (NO STYLE, NO OpenAI) — 2026-02-13
// Purpose: prove Cloud Run start + PORT binding. Keeps required endpoints.

import express from 'express';

const app = express();
app.disable('x-powered-by');

// Keep payload limits sane
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

app.get('/', (req, res) => res.status(200).send('DM-2026 backend: OK'));
app.get('/health', (req, res) => res.status(200).json({ ok: true }));
app.get('/me', (req, res) => res.status(200).json({ service: 'backend', mode: 'bootstrap', ok: true }));

// Required API surface (stubs). These endpoints must exist for Flutter.
app.post('/magic', (req, res) => {
  res.status(501).json({
    ok: false,
    error: 'MAGIC_NOT_CONFIGURED',
    message: 'Backend is running (Cloud Run OK), but /magic is not configured yet.'
  });
});

app.post('/video/start', (req, res) => {
  res.status(501).json({
    ok: false,
    error: 'VIDEO_NOT_CONFIGURED',
    message: 'Backend is running (Cloud Run OK), but /video/start is not configured yet.'
  });
});

app.get('/video/status', (req, res) => {
  res.status(501).json({
    ok: false,
    error: 'VIDEO_NOT_CONFIGURED',
    message: 'Backend is running (Cloud Run OK), but /video/status is not configured yet.'
  });
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`DM-2026 bootstrap server listening on 0.0.0.0:${PORT}`);
});
