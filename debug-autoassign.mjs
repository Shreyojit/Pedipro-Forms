/**
 * Auto-assign debug script — run with: node debug-autoassign.mjs
 * Reads the SQLite DB directly and traces the full algorithm for every test patient.
 * No server needed; no network calls.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, 'apps/data/pediform.db');
const db = new Database(DB_PATH, { readonly: true });

// ─── Algorithm constants (mirror of autoFormAssignment.ts) ───────────────────

const AGE_GROUP_FORMS = {
  newborn:      ['patient_registration'],
  '2_week':     ['epds'],
  '2_month':    ['epds'],
  '4_month':    [],
  '6_month':    ['lead'],
  '9_month':    ['ASQ9Mos', 'lead'],
  '12_month':   ['asq12mos', 'tb_questionnaire', 'lead'],
  '15_month':   ['tb_questionnaire', 'lead'],
  '18_month':   ['asq18mos', 'mchat', 'tb_questionnaire', 'lead'],
  '24_month':   ['asq24mos', 'mchat', 'tb_questionnaire', 'lead'],
  '30_month':   ['ASQ30', 'tb_questionnaire', 'lead'],
  '3_year':     ['asq36mos', 'tb_questionnaire', 'lead'],
  '4_year':     ['asq_48_months', 'tb_questionnaire', 'lead'],
  '5_6_year':   ['tb_questionnaire', 'lead'],
  '7_11_year':  ['tb_questionnaire'],
  '12_18_year': ['PHQ-9'],
};

// Labels in AGE_GROUP_FORMS are exact template_key values; fallback [label.toLowerCase()]
// matches them directly. FORM_KEY_MAP only needed for ambiguous or multi-variant cases.
const FORM_KEY_MAP = {
  ASQ9Mos:  ['asq9mos', 'asq9'],
  asq12mos: ['asq12mos', 'asq12'],
  asq18mos: ['asq18mos', 'asq18'],
  asq24mos: ['asq24mos', 'asq24'],
  ASQ30:    ['asq30'],
  asq36mos: ['asq36mos', 'asq36'],
  'PHQ-9':  ['phq'],
};

const WELL_PHRASES = ['well check','well visit','well child','well-child','wellcare','well care',
  'annual checkup','annual check-up','annual physical','annual exam','preventive',
  'physical exam','checkup','check-up','check up','wellness','wcc'];

function parseDob(dob) {
  const d = new Date(`${dob}T12:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}
function ageMonths(dob, asOf = new Date()) {
  const b = parseDob(dob); if (!b) return null;
  let m = (asOf.getFullYear() - b.getUTCFullYear()) * 12 + (asOf.getMonth() - b.getUTCMonth());
  if (asOf.getUTCDate() < b.getUTCDate()) m--;
  return Math.max(0, m);
}
function getAgeGroup(dob, asOf = new Date()) {
  const b = parseDob(dob); if (!b) return null;
  const diffDays = (asOf - b) / 86_400_000;
  if (diffDays >= 0 && diffDays < 30) return diffDays < 14 ? 'newborn' : '2_week';
  const m = ageMonths(dob, asOf); if (m === null) return null;
  if (m > 216) return '12_18_year';
  const milestones = [
    ['2_month',2],['4_month',4],['6_month',6],['9_month',9],['12_month',12],['15_month',15],
    ['18_month',18],['24_month',24],['30_month',30],['3_year',36],['4_year',48],
    ['5_6_year',66],['7_11_year',108],['12_18_year',180],
  ];
  let best = milestones[0], bestDist = Math.abs(m - best[1]);
  for (const ms of milestones) {
    const d = Math.abs(m - ms[1]);
    if (d < bestDist) { bestDist = d; best = ms; }
  }
  return best[0];
}
function isWellVisit(vt) {
  const v = String(vt ?? '').toLowerCase().trim();
  if (!v) return false;
  if (v === 'well_child' || v === 'well') return true;
  return WELL_PHRASES.some(p => v.includes(p));
}
function templateMatches(name, key, label) {
  const nl = name.toLowerCase(), kl = key.toLowerCase();
  const frags = FORM_KEY_MAP[label] ?? [label.toLowerCase()];
  return frags.some(f => nl.includes(f) || kl.includes(f));
}

// ─── DB queries ───────────────────────────────────────────────────────────────

const practices = db.prepare(`select id, name, slug from practices`).all();
console.log(`\nPractices in DB:`);
practices.forEach(p => console.log(`  [${p.id}] "${p.name}" (${p.slug})`));

// Find all test patients
const testPatients = db.prepare(`
  select p.id, p.child_first_name, p.child_last_name, p.child_dob, p.visit_type, p.patient_acct_no, p.practice_id
  from patients p
  where p.patient_acct_no like 'TEST%'
  order by p.patient_acct_no
`).all();

if (testPatients.length === 0) {
  console.log('\nNo TEST0* patients found in this DB.');
  console.log('These patients are on the production server. Deploy the updated code there and test via the browser.');
  db.close(); process.exit(0);
}

console.log(`\nFound ${testPatients.length} test patient(s).\n`);

// For each test patient, run the algorithm trace
for (const patient of testPatients) {
  const published = db.prepare(`
    select id, name, template_key, status from pdf_templates
    where practice_id = ? and status = 'published'
    order by template_key asc, version desc
  `).all(patient.practice_id);

  // Get latest appointment visit type
  const appt = db.prepare(`
    select visit_type_raw from appointments
    where patient_id = ? order by appointment_date desc, created_at desc limit 1
  `).get(patient.id);
  const visitType = appt?.visit_type_raw ?? patient.visit_type;

  const diffDays = ((new Date()) - parseDob(patient.child_dob)) / 86_400_000;
  const months   = ageMonths(patient.child_dob);
  const group    = getAgeGroup(patient.child_dob);
  const labels   = AGE_GROUP_FORMS[group] ?? [];
  const wellVisit = isWellVisit(visitType);

  console.log(`─── ${patient.patient_acct_no}: ${patient.child_first_name} ${patient.child_last_name}`);
  console.log(`    DOB=${patient.child_dob}  days=${diffDays.toFixed(1)}  months=${months}  group=${group}`);
  console.log(`    visit_type="${visitType}"  isWellVisit=${wellVisit}`);
  console.log(`    Labels: [${labels.join(', ') || 'none'}]`);
  console.log(`    Published templates (${published.length}):`);
  published.forEach(t => console.log(`      ${t.template_key.padEnd(20)} "${t.name}"`));

  if (!wellVisit) {
    console.log(`    ⛔ BLOCKED — visit type is not a well visit`);
  } else {
    const seen = new Set();
    labels.forEach(label => {
      const frags = FORM_KEY_MAP[label] ?? [label.toLowerCase()];
      const match = published.find(t => !seen.has(t.id) && templateMatches(t.name, t.template_key, label));
      if (match) {
        seen.add(match.id);
        console.log(`    ✅ "${label}" [${frags.join(',')}] → "${match.name}" (key=${match.template_key})`);
      } else {
        // show what was checked
        const checked = published.map(t => {
          const nl = t.name.toLowerCase(), kl = t.template_key.toLowerCase();
          const hit = frags.find(f => nl.includes(f) || kl.includes(f));
          return hit ? `${t.template_key}(hit:${hit})` : null;
        }).filter(Boolean);
        console.log(`    ❌ "${label}" [${frags.join(',')}] → NO MATCH (checked: ${checked.join(', ') || 'none'})`);
      }
    });
  }
  console.log('');
}

db.close();
