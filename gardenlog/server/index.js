import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { openDb } from './db.js';
import catalogRouter from './routes/catalog.js';
import observationRouter from './routes/observations.js';
import articleRouter from './routes/articles.js';
import syncRouter from './routes/sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(dataDir) {
  const db = openDb(dataDir);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '6mb' }));

  app.use('/api', (req, res, next) => {
    const token = process.env.ADMIN_TOKEN || 'devtoken';
    const got = req.get('x-admin-token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    req.admin = !!got && got.length === token.length &&
      (() => { try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token)); } catch { return false; } })();
    next();
  });
  app.use('/api/admin', (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  const obsApi = observationRouter(db, dataDir);
  app.use('/api', catalogRouter(db));
  app.use('/api', obsApi);
  app.use('/api', articleRouter(db));
  app.use('/api', syncRouter(db, obsApi));

  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    console.error(err);
    res.status(500).json({ error: 'server_error', message: err.message });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  return { app, db };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const DATA_DIR = process.env.GARDENLOG_DATA || path.join(__dirname, '..', 'data');
  const PORT = +(process.env.PORT || 3000);
  const { app } = createApp(DATA_DIR);
  app.listen(PORT, () => console.log(`gardenlog listening on http://localhost:${PORT} (data: ${DATA_DIR})`));
}
