// Last Man Standing: the hourly job, run by GitHub Actions (see .github/workflows/sync.yml).
// 1. Installs the database rules (when firestore.rules changes or you run it by hand)
// 2. Saves the organiser passcode
// 3. Loads every Premier League fixture and result for the season from football-data.org
// 4. Locks picks once a gameweek's deadline passes
// 5. Knocks players out once every match in a gameweek has finished

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

/* ---------------------------------------------------------------- game logic */
// A match moved more than this long after the round's deadline counts as postponed.
const RESCHEDULE_GRACE_MS = 4 * 24 * 60 * 60 * 1000;

function mapStatus(s) {
  switch (s) {
    case "FINISHED": case "AWARDED": return "finished";
    case "IN_PLAY": case "PAUSED": case "LIVE": return "live";
    case "POSTPONED": case "SUSPENDED": case "CANCELLED": return "postponed";
    default: return "scheduled";
  }
}
function toMillis(t) {
  if (!t) return NaN;
  if (typeof t === "string") return Date.parse(t);
  if (typeof t.toMillis === "function") return t.toMillis();
  if (t instanceof Date) return t.getTime();
  if (typeof t.seconds === "number") return t.seconds * 1000;
  return NaN;
}
function effectiveStatus(f, deadlineMs) {
  if (f.status === "finished" || f.status === "postponed") return f.status;
  const ko = toMillis(f.kickoff);
  if (deadlineMs && ko && ko - deadlineMs > RESCHEDULE_GRACE_MS) return "postponed";
  return f.status;
}
function roundComplete(round) {
  const fx = round.fixtures || [];
  if (!fx.length) return false;
  const dl = toMillis(round.deadline);
  return fx.every((f) => ["finished", "postponed"].includes(effectiveStatus(f, dl)));
}
// W win, D draw, L loss, P postponed (survive), N no pick, X team not playing, ? not played yet
function outcome(round, team) {
  if (!team) return "N";
  const f = (round.fixtures || []).find((x) => x.home === team || x.away === team);
  if (!f) return "X";
  const s = effectiveStatus(f, toMillis(round.deadline));
  if (s === "postponed") return "P";
  if (s !== "finished") return "?";
  const gf = f.home === team ? f.hg : f.ag, ga = f.home === team ? f.ag : f.hg;
  if (gf == null || ga == null) return "?";
  return gf > ga ? "W" : gf === ga ? "D" : "L";
}
const survives = (res) => res === "W" || res === "P";
function settleRound(round, alive, picks) {
  const results = {}, fallen = [];
  for (const id of alive) {
    const team = picks[id] || null, res = outcome(round, team);
    results[id] = { team, res };
    if (!survives(res)) fallen.push(id);
  }
  const everyoneSurvived = alive.length > 0 && fallen.length === alive.length;
  return { results, out: everyoneSurvived ? [] : fallen, everyoneSurvived };
}
function firstKickoff(fixtures) {
  const t = fixtures.map((f) => toMillis(f.kickoff)).filter((n) => !Number.isNaN(n));
  return t.length ? new Date(Math.min(...t)).toISOString() : null;
}

/* ---------------------------------------------------------------- database */
let db, Timestamp, FieldValue;
function connect() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("The FIREBASE_SERVICE_ACCOUNT secret is missing. Add it in GitHub: Settings > Secrets and variables > Actions.");
  let sa;
  try { sa = JSON.parse(raw); } catch { throw new Error("The FIREBASE_SERVICE_ACCOUNT secret isn't valid. Paste the whole key file, from the first { to the last }."); }
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
  db = admin.firestore();
  ({ Timestamp, FieldValue } = admin.firestore);
  return sa.project_id;
}

async function deployRules() {
  const source = fs.readFileSync(path.join(__dirname, "firestore.rules"), "utf8");
  await admin.securityRules().releaseFirestoreRulesetFromSource(source);
  return "installed";
}

async function savePasscode() {
  const pass = (process.env.ADMIN_PASSCODE || "").trim();
  if (!pass) return "missing";
  const ref = db.doc("private/admin"), snap = await ref.get();
  if (snap.exists && snap.data().pass === pass) return "unchanged";
  await ref.set({ pass, at: FieldValue.serverTimestamp() });
  return "saved";
}

async function getConfig() {
  const snap = await db.doc("config/game").get();
  const c = snap.exists ? snap.data() : {};
  return { exists: snap.exists && !!c.startGw, startGw: Number(c.startGw) || 1, entryFee: Number(c.entryFee) || 0, winner: c.winner || null };
}
async function allRounds() {
  const snap = await db.collection("rounds").get();
  return snap.docs.map((d) => d.data()).filter((r) => typeof r.gw === "number").sort((a, b) => a.gw - b.gw);
}

async function fetchSeason() {
  const key = (process.env.FOOTBALL_DATA_KEY || "").trim();
  if (!key) throw new Error("The FOOTBALL_DATA_KEY secret is missing.");
  const res = await fetch("https://api.football-data.org/v4/competitions/PL/matches", { headers: { "X-Auth-Token": key } });
  if (res.status === 400 || res.status === 403) throw new Error(`football-data.org refused the key (${res.status}). Check the FOOTBALL_DATA_KEY secret.`);
  if (!res.ok) throw new Error(`football-data.org returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).matches || [];
}

async function syncFixtures() {
  const matches = await fetchSeason();
  const byGw = new Map();
  for (const m of matches) {
    if (!m.matchday) continue;
    if (!byGw.has(m.matchday)) byGw.set(m.matchday, []);
    byGw.get(m.matchday).push(m);
  }
  if (!byGw.size) throw new Error("football-data.org returned no fixtures.");

  const now = Date.now();
  const cfg = await getConfig();
  // First run: start the game at the next gameweek that hasn't kicked off.
  if (!cfg.exists) {
    const next = [...byGw.entries()]
      .map(([gw, ms]) => [gw, Math.min(...ms.map((m) => Date.parse(m.utcDate)))])
      .filter(([, t]) => t > now).sort((a, b) => a[0] - b[0])[0];
    if (next) {
      cfg.startGw = next[0];
      await db.doc("config/game").set({ startGw: next[0], entryFee: cfg.entryFee }, { merge: true });
    }
  }

  const existing = new Map((await allRounds()).map((r) => [r.gw, r]));
  const gws = [...byGw.keys()].filter((g) => g >= cfg.startGw).sort((a, b) => a - b);
  const merged = new Map();
  let changed = 0;

  for (const gw of gws) {
    const old = existing.get(gw);
    if (old && old.processed) { merged.set(gw, old); continue; }
    const oldById = new Map(((old && old.fixtures) || []).map((f) => [f.id, f]));
    const fixtures = byGw.get(gw).map((m) => {
      const f = {
        id: m.id,
        home: m.homeTeam.tla, homeName: m.homeTeam.shortName || m.homeTeam.name,
        away: m.awayTeam.tla, awayName: m.awayTeam.shortName || m.awayTeam.name,
        kickoff: m.utcDate,
        status: mapStatus(m.status),
        hg: m.score && m.score.fullTime ? m.score.fullTime.home : null,
        ag: m.score && m.score.fullTime ? m.score.fullTime.away : null,
      };
      if (f.status !== "finished" && f.status !== "live") { f.hg = null; f.ag = null; }
      const prev = oldById.get(m.id);
      if (prev && prev.manual) return { ...f, status: prev.status, hg: prev.hg, ag: prev.ag, manual: true };
      return f;
    }).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));

    // Deadline = first kick-off (ignoring postponed matches). Never moved once it has passed.
    const oldDl = old ? toMillis(old.deadline) : NaN;
    const active = fixtures.filter((f) => f.status !== "postponed");
    const deadline = !Number.isNaN(oldDl) && oldDl < now ? old.deadline : Timestamp.fromDate(new Date(firstKickoff(active.length ? active : fixtures)));
    const teams = [...new Set(fixtures.flatMap((f) => [f.home, f.away]))];

    const next = { ...(old || {}), gw, fixtures, deadline, teams };
    merged.set(gw, next);
    const same = old && JSON.stringify(old.fixtures) === JSON.stringify(fixtures)
      && toMillis(old.deadline) === toMillis(deadline) && JSON.stringify(old.teams || []) === JSON.stringify(teams);
    if (same) continue;
    await db.doc(`rounds/${gw}`).set(
      { gw, fixtures, deadline, teams, updatedAt: FieldValue.serverTimestamp(), ...(old ? {} : { processed: false, locked: false, open: false }) },
      { merge: true }
    );
    changed++;
  }

  // Only the next gameweek to kick off is open for picks.
  const openGw = [...merged.values()].filter((r) => !r.processed && toMillis(r.deadline) > now).sort((a, b) => a.gw - b.gw)[0]?.gw ?? null;
  for (const r of merged.values()) {
    const want = r.gw === openGw;
    if ((r.open === true) !== want) await db.doc(`rounds/${r.gw}`).set({ open: want }, { merge: true });
  }
  return { gameweeks: gws.length, roundsChanged: changed, open: openGw, startGw: cfg.startGw };
}

// After a deadline: close the round and record each player's team as used.
async function lockRounds() {
  const cfg = await getConfig(), now = Date.now(), done = [];
  for (const r of await allRounds()) {
    if (r.gw < cfg.startGw || r.locked || !(toMillis(r.deadline) <= now)) continue;
    const picks = await db.collection(`rounds/${r.gw}/picks`).get();
    const batch = db.batch();
    picks.forEach((p) => batch.set(db.doc(`players/${p.id}`), { used: FieldValue.arrayUnion(p.data().team) }, { merge: true }));
    batch.set(db.doc(`rounds/${r.gw}`), { locked: true, open: false, lockedAt: FieldValue.serverTimestamp() }, { merge: true });
    await batch.commit();
    done.push({ gw: r.gw, picks: picks.size });
  }
  return done;
}

// Knock players out for every finished round, in order.
async function processRounds() {
  const cfg = await getConfig();
  if (cfg.winner) return [];
  const done = [];
  for (const r of (await allRounds()).filter((x) => x.gw >= cfg.startGw)) {
    if (r.processed) continue;
    if (!r.locked || !roundComplete(r)) break;
    const result = await db.runTransaction(async (tx) => {
      const ref = db.doc(`rounds/${r.gw}`), fresh = await tx.get(ref);
      if (!fresh.exists || fresh.data().processed) return null;
      const round = fresh.data();
      if (!roundComplete(round)) return null;
      const playersSnap = await tx.get(db.collection("players"));
      const picksSnap = await tx.get(db.collection(`rounds/${r.gw}/picks`));
      const counted = playersSnap.docs.filter((d) => d.data().status !== "removed");
      const alive = counted.filter((d) => d.data().status === "alive").map((d) => d.id);
      const picks = {};
      picksSnap.docs.forEach((d) => (picks[d.id] = d.data().team));
      const s = settleRound(round, alive, picks);
      for (const id of s.out) tx.update(db.doc(`players/${id}`), { status: "out", outGw: r.gw, outResult: s.results[id] });
      tx.update(ref, { processed: true, processedAt: FieldValue.serverTimestamp(), results: s.results, everyoneSurvived: s.everyoneSurvived });
      const left = alive.filter((id) => !s.out.includes(id));
      if (left.length === 1 && counted.length > 1) {
        tx.set(db.doc("config/game"), { winner: left[0], wonGw: r.gw }, { merge: true });
        return { gw: r.gw, winner: left[0] };
      }
      return { gw: r.gw, out: s.out.length };
    });
    if (!result) break;
    done.push(result);
    if (result.winner) break;
  }
  return done;
}

/* ---------------------------------------------------------------- run */
async function main() {
  const project = connect();
  console.log(`Firebase project: ${project}`);
  const report = { at: FieldValue.serverTimestamp() };
  let failed = false;

  if (process.env.DEPLOY_RULES === "true") {
    try { report.rules = await deployRules(); console.log("Database rules installed."); }
    catch (e) { failed = true; report.rules = `failed: ${e.message}`; console.error("::error::Couldn't install the database rules:", e.message); }
  }
  report.passcode = await savePasscode();
  if (report.passcode === "missing") console.warn("::warning::ADMIN_PASSCODE secret is missing, so the organiser screen can't be opened.");

  try { report.fixtures = await syncFixtures(); console.log("Fixtures:", report.fixtures); }
  catch (e) { failed = true; report.fixtures = { error: String(e.message || e) }; console.error("::error::Fixture update failed:", e.message); }

  report.locked = await lockRounds();
  report.knockouts = { processed: await processRounds() };
  console.log("Locked:", report.locked, "Knock-outs:", report.knockouts.processed);

  await db.doc("config/sync").set(report);
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => { console.error("::error::", e.message || e); process.exit(1); });
}
module.exports = { mapStatus, effectiveStatus, roundComplete, outcome, settleRound, firstKickoff, toMillis };
