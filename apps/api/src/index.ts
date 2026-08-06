import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { seedDefaults } from './db/seed.js';
import { seedTemplates } from './db/seedTemplates.js';
import { expireStaleSubmissions } from './db/queries.js';
import { publicRouter } from './routes/public.js';
import { parentAuthRouter } from './routes/parentAuth.js';
import { staffRouter } from './routes/staff.js';
import { staffTemplatesRouter } from './routes/staffTemplates.js';
import { staffAssignmentsRouter } from './routes/staffAssignments.js';
import { staffDocumentsRouter } from './routes/staffDocuments.js';
import { patientPortalRouter } from './routes/patientPortal.js';
import { asqStaffRouter, asqPublicRouter } from './routes/asqRoutes.js';
import { pdfMarkerRouter } from './routes/pdfMarkerRoutes.js';
import { authMiddleware } from './middleware/auth.js';
import { fail } from './lib/response.js';
import { expireStaleAssignments } from './db/assignmentQueries.js';

fs.mkdirSync(path.join(config.dataPath, 'templates', 'source'), { recursive: true });
fs.mkdirSync(path.join(config.dataPath, 'patient-documents'), { recursive: true });

runMigrations();
seedDefaults();
seedTemplates();

// Expire stale in_progress sessions on startup and every 6 hours
expireStaleSubmissions(48);
setInterval(() => expireStaleSubmissions(48), 6 * 60 * 60 * 1000);

// Expire stale form assignments on startup and every 6 hours
expireStaleAssignments();
setInterval(() => expireStaleAssignments(), 6 * 60 * 60 * 1000);

const app = express();

// Raw CORS middleware — runs before everything including helmet.
// Reflects the request Origin back so any frontend domain works.
// Auth security is provided by JWT Bearer tokens, not same-origin policy.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
}));
app.use(express.json({ limit: '100mb' }));
app.use(morgan('dev'));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'pediform-api',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api', publicRouter);
app.use('/api/parent', parentAuthRouter);
app.use('/api/staff', staffRouter);
app.use('/api/staff/templates', authMiddleware('staff'), staffTemplatesRouter);
app.use('/api/staff/assignments', authMiddleware('staff'), staffAssignmentsRouter);
app.use('/api/staff/documents', authMiddleware('staff'), staffDocumentsRouter);
app.use('/api/patient-portal', patientPortalRouter);
app.use('/api/staff/asq', asqStaffRouter);
app.use('/api/asq/submissions', asqPublicRouter);
app.use('/api/staff/pdf-marker', authMiddleware('staff'), pdfMarkerRouter);

app.use((_req, res) => {
  fail(res, 'NOT_FOUND', 'Route not found', 404);
});

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`API server running on http://localhost:${config.port}`);
});
