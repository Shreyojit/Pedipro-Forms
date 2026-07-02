import { randomUUID } from 'node:crypto';
import { db, nowIso, stringifyJson } from './database.js';
import { hashPassword } from '../lib/auth.js';

// Fixed IDs so JWTs remain valid across free-tier restarts (ephemeral DB).
const SEED_PRACTICE_ID = 'a1b2c3d4-0000-4000-8000-100000000001';
const SEED_STAFF_ID    = 'a1b2c3d4-0000-4000-8000-100000000002';

const ADDITIONAL_ADMIN_USERS: Array<{ email: string; password: string }> = [
  { email: 'emily@probeps.com', password: 'Probe@12345' },
  { email: 'cindy@probeps.com', password: 'Probe@12345' },
  { email: 'sadath@probeps.com', password: 'Probe@12345' },
];

function ensureStaffAdmin(email: string, password: string, practiceId: string): void {
  const normalized = email.toLowerCase();
  const existing = db.prepare('select id from staff_users where lower(email) = ?').get(normalized) as
    | { id: string }
    | undefined;
  if (existing) return;

  db.prepare(
    `insert into staff_users (id, email, password_hash, practice_id, role, is_active, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), normalized, hashPassword(password), practiceId, 'admin', 1, nowIso());
}

export function seedDefaults(): void {
  try {
    _seedDefaults();
  } catch (err) {
    console.error('[seed] seedDefaults failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

function _seedDefaults(): void {
  const existingPractice = db.prepare('select id from practices where slug = ?').get('lonestarpediatrics') as
    | { id: string }
    | undefined;

  let practiceId = existingPractice?.id;
  if (!practiceId) {
    practiceId = SEED_PRACTICE_ID;
    db.prepare(
      `insert into practices (id, name, slug, logo_url, settings_json, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    ).run(
      practiceId,
      'Lone Star Pediatrics',
      'lonestarpediatrics',
      null,
      stringifyJson({
        enabled_visit_types: ['new_patient', 'well_child', 'sick', 'follow_up'],
      }),
      nowIso(),
    );
  }

  const existingById = db.prepare('select id from staff_users where id = ?').get(SEED_STAFF_ID) as
    | { id: string }
    | undefined;

  if (existingById) {
    // Migrate email if it was set under an old practice name
    db.prepare('update staff_users set email = ?, practice_id = ? where id = ? and email != ?').run(
      'admin@lonestarkidz.com',
      practiceId,
      SEED_STAFF_ID,
      'admin@lonestarkidz.com',
    );
  } else {
    const existingByEmail = db.prepare('select id from staff_users where email = ?').get(
      'admin@lonestarkidz.com',
    ) as { id: string } | undefined;
    if (!existingByEmail) {
      db.prepare(
        `insert into staff_users (id, email, password_hash, practice_id, role, is_active, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        SEED_STAFF_ID,
        'admin@lonestarkidz.com',
        hashPassword('Admin@12345'),
        practiceId,
        'admin',
        1,
        nowIso(),
      );
    }
  }

  for (const admin of ADDITIONAL_ADMIN_USERS) {
    ensureStaffAdmin(admin.email, admin.password, practiceId);
  }
}
