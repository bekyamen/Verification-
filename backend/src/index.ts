import dotenv from 'dotenv';
dotenv.config();   // ← must run BEFORE any module that reads process.env at load time

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import apiRoutes from './routes/api.routes';
import authRoutes from './routes/auth.routes';
import miniappRoutes from './routes/miniapp.routes';
import { warmOcrWorkers, warmOcr } from './services/receiptParser.service';
import { warmPdf } from './services/verifyCBE';
import { startBot } from './telegram/bot';


const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health check (used by uptime monitors to keep service alive)
app.get('/api/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Mount API routes
app.use('/api', apiRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/miniapp', miniappRoutes);

// Serve Mini App static files
// In production (compiled): __dirname is dist/  so miniapp is at dist/miniapp
// In dev (tsx):             __dirname is src/    so miniapp is at src/miniapp

const miniappDir = path.join(__dirname, 'miniapp');
app.use('/miniapp', express.static(miniappDir));

// SPA fallback: serve index.html for any other /miniapp route
app.use('/miniapp', (_req, res) => {
  res.sendFile(path.join(miniappDir, 'index.html'));
});

// Unhandled error management
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', details: err.message });
});

app.listen(port, () => {
  console.log(`CheckFlow ET Backend Engine running on port ${port}`);
  // Pre-warm Tesseract workers in background so first image request doesn't wait
  warmOcrWorkers();
  warmOcr();
  warmPdf();
  // Start Telegram bot (long-polling) alongside Express
  startBot();

  // ── Keep-alive ping (prevents Render free-tier spin-down) ────────────────
  // Render spins down free services after ~15 min of inactivity.
  // When the service sleeps the Telegram long-poll stops too.
  // We self-ping /api/health every 10 min to stay awake.
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    const pingUrl = `${RENDER_URL}/api/health`;
    setInterval(async () => {
      try {
        const http = await import('node:http');
        const https = await import('node:https');
        const mod = pingUrl.startsWith('https') ? https : http;
        mod.get(pingUrl, (res) => {
          console.log(`[keep-alive] ping → ${res.statusCode}`);
        }).on('error', (e) => {
          console.warn(`[keep-alive] ping failed: ${e.message}`);
        });
      } catch { /* ignore */ }
    }, 10 * 60 * 1000); // every 10 minutes
    console.log(`[keep-alive] Self-ping enabled → ${pingUrl}`);
  }
});





