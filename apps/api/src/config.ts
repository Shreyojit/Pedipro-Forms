import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootPath = path.resolve(__dirname, '../../..');
const dataPath = process.env.DATA_PATH ?? path.join(rootPath, 'apps', 'data');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  dbPath: process.env.DB_PATH ?? path.join(dataPath, 'pediform.db'),
  // Accepts a comma-separated list of origins: "https://a.com,https://b.com"
  // Falls back to known production origins when the env var is not set.
  corsOrigin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
    : [
        'https://admin.lonestarkidz.com',
        'https://portal.lonestarkidz.com',
        'https://lonestarkidz.com',
        'https://www.lonestarkidz.com',
        'http://localhost:5173',
        'http://localhost:5174',
      ],
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    fromNumber: process.env.TWILIO_FROM_NUMBER ?? '',
  },
  email: {
    smtpHost: process.env.SMTP_HOST ?? '',
    smtpPort: Number(process.env.SMTP_PORT ?? 587),
    smtpUser: process.env.SMTP_USER ?? '',
    smtpPass: process.env.SMTP_PASS ?? '',
    fromAddress: process.env.EMAIL_FROM ?? process.env.SMTP_USER ?? '',
  },
  rootPath,
  dataPath,
};

/**
 * Resolve a stored PDF path to an absolute filesystem path.
 * New paths are stored relative to dataPath (e.g. "templates/source/foo.pdf").
 * Legacy paths are absolute — returned as-is so existing local DBs keep working.
 */
export function resolveDataPath(storedPath: string): string {
  if (path.isAbsolute(storedPath)) return storedPath;
  return path.join(config.dataPath, storedPath);
}

/**
 * Convert an absolute path under dataPath to a relative path for storage.
 * If the path is already relative, return it unchanged.
 */
export function toRelativeDataPath(absolutePath: string): string {
  if (!path.isAbsolute(absolutePath)) return absolutePath;
  const rel = path.relative(config.dataPath, absolutePath);
  // If it somehow resolves outside dataPath, store the absolute path as fallback
  if (rel.startsWith('..')) return absolutePath;
  return rel;
}
