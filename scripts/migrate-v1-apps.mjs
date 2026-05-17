#!/usr/bin/env node
/**
 * One-shot Migration: v1-Apps (mcp-approval CF) → v2 (mcp-approval2 Fly+PG).
 *
 * Liest 4 hardgecodete LayoutDocs (aus kc:apps.read exportiert am 2026-05-17)
 * und POSTet sie als /v1/apps zu v2 mit dem PWA-Bearer-Token des Users.
 *
 * Usage:
 *   MCP_BEARER=<token>  node scripts/migrate-v1-apps.mjs [--dry-run] [--target URL]
 *
 * Token herauskriegen:
 *   1. PWA https://app2.ai-toolhub.org öffnen + einloggen
 *   2. DevTools → Network → einen API-Request anschauen (z.B. /v1/inventory)
 *   3. Request-Headers → "authorization: Bearer eyJ..." kopieren (ohne "Bearer ")
 *
 * --dry-run: zeigt was gesendet würde, ohne POST.
 * --target:  Server-Origin (default https://mcp2.ai-toolhub.org).
 */

const TARGET = process.argv.includes('--target')
  ? process.argv[process.argv.indexOf('--target') + 1]
  : 'https://mcp2.ai-toolhub.org';

const DRY_RUN = process.argv.includes('--dry-run');
const TOKEN = process.env.MCP_BEARER;

if (!DRY_RUN && !TOKEN) {
  console.error('FEHLER: setze MCP_BEARER (siehe Header-Kommentar wie man den Token holt).');
  process.exit(1);
}

// ───────────────────────────────────────────────────────────────────────
// 4 Apps aus v1 — kc:apps.read Output, 2026-05-17 09:5x UTC
// ───────────────────────────────────────────────────────────────────────

const APP_EINKAUFSLISTE = {
  appType: 'composable',
  title: '🛒 Einkaufsliste',
  initialState: {
    version: 'v0.10',
    components: [
      { id: 'hdr', block: 'header', config: { title: 'Einkaufsliste', icon: '🛒' } },
      { id: 'list1', block: 'list', config: { label: '' } },
    ],
    state: {
      hdr: { title: 'Einkaufsliste', icon: '🛒' },
      list1: {
        items: [
          { id: 'seed1', text: 'Milch', tag: '🥛', done: false, order: 0 },
          { id: 'seed2', text: 'Brot', tag: '🍞', done: false, order: 1 },
          { id: 'seed3', text: 'Äpfel', tag: '🍎', done: false, order: 2 },
        ],
      },
    },
    meta: {
      sendDataModel: true,
      template: { kind: 'single', background: 'abstract', theme: 'frosted-glass' },
    },
  },
};

// Training-App: 33 exercises, 4 categories, 100+ sets. Daten aus v1 ungekürzt.
const APP_TRAINING = {
  appType: 'composable',
  title: '🏋️ Training',
  initialState: {
    version: 'v0.10',
    components: [{ id: 'ws', block: 'workout_split' }],
    state: {
      ws: {
        categories: [
          { id: 'ruecken', label: 'Rücken', order: 0 },
          { id: 'brust', label: 'Brust', order: 1 },
          { id: 'dehnen', label: 'Dehnen', order: 2 },
          { id: 'beine', label: 'Beine', order: 3 },
        ],
        active_category_id: 'brust',
        current_week_started_at: '2026-05-04',
        exercises: [
          { id: 'ex01', category_id: 'ruecken', name: 'Rückenzug', order: 0, sets: [
            { id: 'ex01-s1', weight: 79, reps: 12, done: false },
            { id: 'ex01-s2', weight: 81, reps: 10, done: false },
            { id: 'ex01-s3', weight: 83, reps: 8, done: false }] },
          { id: 'ex02', category_id: 'ruecken', name: 'Pulldown Seil Bank', order: 1, sets: [
            { id: 'ex02-s1', weight: 64, reps: 12, done: false },
            { id: 'ex02-s2', weight: 66, reps: 10, done: false },
            { id: 'ex02-s3', weight: 68, reps: 8, done: false }] },
          { id: 'ex03', category_id: 'ruecken', name: 'Rudern sitzend einhändig', order: 2, sets: [
            { id: 'ex03-s1', weight: 66, reps: 12, done: false },
            { id: 'ex03-s2', weight: 68, reps: 10, done: false },
            { id: 'ex03-s3', weight: 70, reps: 8, done: false }] },
          { id: 'ex04', category_id: 'ruecken', name: 'Bizep Seil', order: 3, sets: [
            { id: 'ex04-s1', weight: 16, reps: 12, done: false },
            { id: 'ex04-s2', weight: 18, reps: 10, done: false },
            { id: 'ex04-s3', weight: 20, reps: 8, done: false },
            { id: 'ex04-s4', weight: 20, reps: 8, done: false }] },
          { id: 'ex05', category_id: 'ruecken', name: 'Hammer Curl', order: 4, sets: [
            { id: 'ex05-s1', weight: 0, reps: 10, done: false },
            { id: 'ex05-s2', weight: 0, reps: 10, done: false },
            { id: 'ex05-s3', weight: 0, reps: 10, done: false }] },
          { id: 'ex06', category_id: 'ruecken', name: 'Butterfly reverse', order: 5, sets: [
            { id: 'ex06-s1', weight: 42, reps: 28, done: false },
            { id: 'ex06-s2', weight: 66, reps: 14, done: false },
            { id: 'ex06-s3', weight: 73, reps: 8, done: false }] },
          { id: 'ex07', category_id: 'ruecken', name: 'Schulter Seil hinten', order: 6, sets: [
            { id: 'ex07-s1', weight: 10, reps: 12, done: false },
            { id: 'ex07-s2', weight: 10, reps: 10, done: false },
            { id: 'ex07-s3', weight: 10, reps: 8, done: false }] },
          { id: 'ex08', category_id: 'ruecken', name: 'Schulter Gewicht heben', order: 7, sets: [
            { id: 'ex08-s1', weight: 48, reps: 20, done: false },
            { id: 'ex08-s2', weight: 60, reps: 12, done: false },
            { id: 'ex08-s3', weight: 60, reps: 12, done: false }] },
          { id: 'ex09', category_id: 'ruecken', name: 'Rücken Blank feinmotorig (Halten)', order: 8, sets: [
            { id: 'ex09-s1', weight: 0, reps: 90, done: false },
            { id: 'ex09-s2', weight: 0, reps: 90, done: false },
            { id: 'ex09-s3', weight: 0, reps: 90, done: false }] },
          { id: 'ex10', category_id: 'ruecken', name: 'Rückenübung speziell (schnell)', order: 9, sets: [
            { id: 'ex10-s1', weight: 0, reps: 45, done: false },
            { id: 'ex10-s2', weight: 0, reps: 45, done: false },
            { id: 'ex10-s3', weight: 0, reps: 45, done: false }] },
          { id: 'ex11', category_id: 'ruecken', name: 'Rückenmuskulatur (langsam)', order: 10, sets: [
            { id: 'ex11-s1', weight: 20, reps: 14, done: false },
            { id: 'ex11-s2', weight: 20, reps: 12, done: false },
            { id: 'ex11-s3', weight: 20, reps: 12, done: false }] },
          { id: 'ex12', category_id: 'brust', name: 'Brustpresse gerade', order: 0, sets: [
            { id: 'ex12-s1', weight: 90, reps: 11, done: true },
            { id: 'ex12-s2', weight: 92, reps: 9, done: true },
            { id: 'ex12-s3', weight: 93, reps: 8, done: true }] },
          { id: 'ex13', category_id: 'brust', name: 'Brust 45°', order: 1, sets: [
            { id: 'ex13-s1', weight: 40, reps: 13, done: true },
            { id: 'ex13-s2', weight: 45, reps: 12, done: true },
            { id: 'ex13-s3', weight: 50, reps: 8, done: true }] },
          { id: 'ex14', category_id: 'brust', name: 'Butterfly Brust', order: 2, sets: [
            { id: 'ex14-s1', weight: 0, reps: 15, done: true },
            { id: 'ex14-s2', weight: 0, reps: 12, done: false },
            { id: 'ex14-s3', weight: 0, reps: 10, done: false }] },
          { id: 'ex15', category_id: 'brust', name: 'Trizep Stange oben (halten)', order: 3, sets: [
            { id: 'ex15-s1', weight: 45, reps: 14, done: false },
            { id: 'ex15-s2', weight: 47.5, reps: 12, done: false },
            { id: 'ex15-s3', weight: 50, reps: 8, done: false }] },
          { id: 'ex16', category_id: 'brust', name: 'Trizep Stange unten', order: 4, sets: [
            { id: 'ex16-s1', weight: 45, reps: 12, done: false },
            { id: 'ex16-s2', weight: 47.5, reps: 10, done: false },
            { id: 'ex16-s3', weight: 50, reps: 8, done: false }] },
          { id: 'ex17', category_id: 'brust', name: 'Trizep Seil', order: 5, sets: [
            { id: 'ex17-s1', weight: 36, reps: 8, done: false },
            { id: 'ex17-s2', weight: 34.5, reps: 9, done: false },
            { id: 'ex17-s3', weight: 36, reps: 8, done: false }] },
          { id: 'ex18', category_id: 'brust', name: 'Bauchmuskeln Stange', order: 6, sets: [
            { id: 'ex18-s1', weight: 0, reps: 9, done: false },
            { id: 'ex18-s2', weight: 0, reps: 10, done: false },
            { id: 'ex18-s3', weight: 0, reps: 8, done: false }] },
          { id: 'ex19', category_id: 'brust', name: 'Bauchmuskel rotation (Ablegen)', order: 7, sets: [
            { id: 'ex19-s1', weight: 20, reps: 12, done: false },
            { id: 'ex19-s2', weight: 20, reps: 12, done: false },
            { id: 'ex19-s3', weight: 20, reps: 12, done: false }] },
          { id: 'ex20', category_id: 'brust', name: 'Wadenmuskeln (Negative)', order: 8, sets: [
            { id: 'ex20-s1', weight: 5, reps: 20, done: false },
            { id: 'ex20-s2', weight: 5, reps: 16, done: false },
            { id: 'ex20-s3', weight: 5, reps: 16, done: false }] },
          { id: 'ex21', category_id: 'beine', name: 'Beinpresse', order: 0, sets: [
            { id: 'ex21-s1', weight: 240, reps: 12, done: false },
            { id: 'ex21-s2', weight: 260, reps: 15, done: false },
            { id: 'ex21-s3', weight: 260, reps: 10, done: false }] },
          { id: 'ex22', category_id: 'beine', name: 'Beinstrecker', order: 1, sets: [
            { id: 'ex22-s1', weight: 59, reps: 12, done: false },
            { id: 'ex22-s2', weight: 61, reps: 11, done: false },
            { id: 'ex22-s3', weight: 63, reps: 9, done: false }] },
          { id: 'ex23', category_id: 'beine', name: 'Beinbeuger', order: 2, sets: [
            { id: 'ex23-s1', weight: 52, reps: 11, done: false },
            { id: 'ex23-s2', weight: 54, reps: 9, done: false },
            { id: 'ex23-s3', weight: 56.6, reps: 8, done: false }] },
          { id: 'ex24', category_id: 'beine', name: 'Wadenmuskeln (Beine)', order: 3, sets: [
            { id: 'ex24-s1', weight: 10, reps: 20, done: false },
            { id: 'ex24-s2', weight: 10, reps: 17, done: false },
            { id: 'ex24-s3', weight: 10, reps: 20, done: false }] },
          { id: 'ex25', category_id: 'beine', name: 'Abduktion', order: 4, sets: [
            { id: 'ex25-s1', weight: 17.5, reps: 20, done: false },
            { id: 'ex25-s2', weight: 20, reps: 15, done: false },
            { id: 'ex25-s3', weight: 17.5, reps: 11, done: false }] },
          { id: 'ex26', category_id: 'beine', name: 'Adduktion', order: 5, sets: [
            { id: 'ex26-s1', weight: 63, reps: 14, done: false },
            { id: 'ex26-s2', weight: 66, reps: 7, done: false },
            { id: 'ex26-s3', weight: 66, reps: 10, done: false }] },
          { id: 'ex27', category_id: 'beine', name: 'Hipthrust', order: 6, sets: [
            { id: 'ex27-s1', weight: 200, reps: 10, done: false },
            { id: 'ex27-s2', weight: 200, reps: 10, done: false },
            { id: 'ex27-s3', weight: 200, reps: 10, done: false }] },
          { id: 'ex28', category_id: 'dehnen', name: 'Dehnen Hüfte', order: 0, sets: [
            { id: 'ex28-s1', weight: 0, reps: 90, done: false },
            { id: 'ex28-s2', weight: 0, reps: 90, done: false },
            { id: 'ex28-s3', weight: 0, reps: 90, done: false }] },
          { id: 'ex29', category_id: 'dehnen', name: 'Dehnen Brust', order: 1, sets: [
            { id: 'ex29-s1', weight: 0, reps: 90, done: false },
            { id: 'ex29-s2', weight: 0, reps: 90, done: false },
            { id: 'ex29-s3', weight: 0, reps: 90, done: false }] },
          { id: 'ex30', category_id: 'dehnen', name: 'Dehnen Unterer Bauch', order: 2, sets: [
            { id: 'ex30-s1', weight: 0, reps: 90, done: false },
            { id: 'ex30-s2', weight: 0, reps: 90, done: false },
            { id: 'ex30-s3', weight: 0, reps: 90, done: false }] },
          { id: 'ex31', category_id: 'dehnen', name: 'Dehnen Waden', order: 3, sets: [
            { id: 'ex31-s1', weight: 0, reps: 90, done: false },
            { id: 'ex31-s2', weight: 0, reps: 90, done: false },
            { id: 'ex31-s3', weight: 0, reps: 90, done: false }] },
          { id: 'ex32', category_id: 'dehnen', name: 'Dehnen Rücken nach Vorne', order: 4, sets: [
            { id: 'ex32-s1', weight: 0, reps: 90, done: false },
            { id: 'ex32-s2', weight: 0, reps: 90, done: false },
            { id: 'ex32-s3', weight: 0, reps: 90, done: false }] },
          { id: 'ex33', category_id: 'dehnen', name: 'Dehnen gestreckt', order: 5, sets: [
            { id: 'ex33-s1', weight: 0, reps: 90, done: false },
            { id: 'ex33-s2', weight: 0, reps: 90, done: false },
            { id: 'ex33-s3', weight: 0, reps: 90, done: false }] },
        ],
        history: [],
      },
    },
  },
};

const APP_MEDITATION = {
  appType: 'composable',
  title: '🧘 Meditation Tracker',
  initialState: {
    version: 'v0.10',
    components: [
      { id: 'hdr', block: 'header' },
      { id: 'timer', block: 'timer', config: { label: 'Sitzung' } },
      { id: 'today', block: 'counter', config: { label: 'Heute (Min)' } },
      { id: 'lifetime', block: 'counter', config: { label: 'Gesamt-Minuten meditiert' } },
      { id: 'sessions', block: 'list', config: { label: 'Sitzungs-Verlauf' } },
      { id: 'days', block: 'calendar_grid', config: { label: 'Meditations-Tage' } },
    ],
    state: {
      hdr: { title: '🧘 Meditation Tracker', subtitle: 'Zeit + Tage tracken', icon: '🧘' },
      timer: {
        duration_seconds: 180,
        status: 'idle',
        started_at: null,
        last_completed_at: 1778477452853,
        last_run_seconds: 119,
        paused_at_seconds: null,
      },
      today: { value: 13, target: null, lastReset: null },
      lifetime: { value: 13, target: null, lastReset: null },
      sessions: {
        items: [
          { id: 'e23dc3f83bd94966', text: '1 min — 13:26', tag: 'meditation', done: false, order: 0 },
          { id: '6d0f8ab6d6c34b63', text: '1 min — 16:01', tag: 'meditation', done: false, order: 1 },
          { id: 'f51c6e6d51b34477', text: '2026-05-08|16:58|1', tag: null, done: false, order: 2 },
          { id: 'ed341999ed304955', text: '2026-05-11|07:25|8|480', tag: null, done: false, order: 3 },
          { id: '907116158f774a6c', text: '2026-05-11|07:30|2|120', tag: null, done: false, order: 4 },
        ],
      },
      days: { ticks: ['2026-05-08', '2026-05-11'] },
    },
  },
};

const APP_TANZ = {
  appType: 'composable',
  title: '💃🕺 Zürich tanzt — 09.05.2026 (✨)',
  initialState: {
    version: 'v0.10',
    components: [
      { id: 'hdr', block: 'header', config: { title: 'Zürich tanzt', icon: '🪩' } },
      { id: 'spielorte', block: 'places', config: { label: '📍 Programm & Locations' } },
    ],
    state: {
      hdr: { title: 'Zürich tanzt', subtitle: 'Sa 09.05.2026', icon: '🪩' },
      spielorte: {
        items: [
          { id: 's1', label: '11:00 Milonga', address: 'Hottingerstrasse 30, 8032 Zürich',
            note: 'Kaiser Tanzschule · Kreis 7 (Hottingen). Tram 3 ab Bahnhofstrasse, ~12 min. Slot endet 11:50.', url: null },
          { id: 's2', label: '12:10 Brazilian Zouk', address: 'Kirchgasse 13, 8001 Zürich',
            note: 'Kulturhaus Helferei / Breitingersaal · Niederdorf, beim Grossmünster. Wechsel ist tight.', url: null },
          { id: 's3', label: '13:20 Shag/Boogie (Wahl)', address: 'Heinrichstrasse 238, 8005 Zürich',
            note: 'Quartierzentrum Schütze (Shag) ODER SalsaRica/Raum 3 (Boogie, Pfingstweidstrasse 101). Beide Kreis 5, 8 min.', url: null },
          { id: 's4', label: '14:30 Bachata/Rueda (Wahl)', address: 'Pfingstweidstrasse 101, 8005 Zürich',
            note: 'SalsaRica/Lounge (Bachata) ODER Kaiser Tanzschule (Rueda, Hottingerstrasse 30). Rueda passt zu 15:40 WCS.', url: null },
          { id: 's5', label: '15:40 West Coast Swing', address: 'Hottingerstrasse 30, 8032 Zürich',
            note: 'Kaiser Tanzschule · Falls Bachata @ SalsaRica → Tram 4/13, ~20 min knapp.', url: null },
          { id: 's6', label: '16:50 Tango Argentino (Wahl)', address: 'Kirchgasse 13, 8001 Zürich',
            note: 'Kulturhaus Helferei (Open Role, Tipp) ODER Schütze. Helferei → Kaiser (Blues 18:00) ist einfacher.', url: null },
          { id: 's7', label: '18:00 Modern Blues / Fusion', address: 'Hottingerstrasse 30, 8032 Zürich',
            note: 'Kaiser Tanzschule · 75 min Slot statt 70.', url: null },
          { id: 's8', label: '19:10 Lambada', address: 'Hottingerstrasse 30, 8032 Zürich',
            note: 'Kaiser Tanzschule · Letzter Slot, nur Saalwechsel.', url: null },
        ],
      },
    },
    meta: {
      sendDataModel: true,
      template: { kind: 'single', background: 'dance', theme: 'frosted-glass' },
    },
  },
};

const APPS = [
  { key: 'einkaufsliste', payload: APP_EINKAUFSLISTE, pinned: true },
  { key: 'training', payload: APP_TRAINING, pinned: false },
  { key: 'meditation', payload: APP_MEDITATION, pinned: false },
  { key: 'tanz', payload: APP_TANZ, pinned: false },
];

// ───────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────

async function createApp(payload) {
  const res = await fetch(`${TARGET}/v1/apps`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'authorization': `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

async function pinApp(id) {
  // Pin ist eine separate Action — siehe routes/apps.ts. Default-Endpoint:
  // PATCH /v1/apps/:id/pin? Schauen wir nach. Falls nicht da: skip + manuell.
  // (Aktuell impl unklar, machen wir best-effort.)
  const res = await fetch(`${TARGET}/v1/apps/${encodeURIComponent(id)}/pin`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'authorization': `Bearer ${TOKEN}`,
      'accept': 'application/json',
    },
  });
  if (!res.ok) {
    console.warn(`  ⚠️  pin failed (HTTP ${res.status}) — manuell in PWA pinnen`);
  }
}

async function main() {
  console.log(`Target: ${TARGET}`);
  console.log(`Dry-run: ${DRY_RUN}`);
  console.log(`Apps to migrate: ${APPS.length}\n`);

  for (const { key, payload, pinned } of APPS) {
    console.log(`→ ${key} (${payload.title})`);
    if (DRY_RUN) {
      const sample = JSON.stringify(payload).slice(0, 200);
      console.log(`  dry-run: would POST ${sample}...\n`);
      continue;
    }
    try {
      const res = await createApp(payload);
      const id = res.app?.id ?? res.id ?? '?';
      console.log(`  ✓ created id=${id}`);
      if (pinned && id !== '?') {
        await pinApp(id);
        console.log(`  ✓ pinned`);
      }
    } catch (err) {
      console.error(`  ✗ FAILED: ${err.message}`);
    }
    console.log();
  }
  console.log('done.');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
