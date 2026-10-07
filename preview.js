// Preview mode: runs the whole app in your browser with sample data, no Firebase needed.
// It's used automatically until you paste your Firebase settings into firebase-config.js.
// Everything you do here is saved only on this phone. Nothing is shared with anyone.

const KEY = "lms-preview-v1";
const UID = "preview-phone";
const iso = (days, hours = 0) => new Date(Date.now() + (days * 24 + hours) * 3600e3).toISOString();
// Sample kick-offs on a normal weekend: next Saturday (at least a day away) and the one before.
const SAT = (() => { const d = new Date(Date.now() + 864e5); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7)); return d; })();
const at = (weekOffset, dayOffset, hhmm) => {
  const d = new Date(SAT); d.setDate(d.getDate() + weekOffset * 7 + dayOffset);
  const [h, m] = hhmm.split(":").map(Number); d.setHours(h, m, 0, 0); return d.toISOString();
};

const N = {
  ARS: "Arsenal", AVL: "Aston Villa", BOU: "Bournemouth", BRE: "Brentford", BHA: "Brighton",
  CHE: "Chelsea", COV: "Coventry", CRY: "Crystal Palace", EVE: "Everton", FUL: "Fulham",
  HUL: "Hull City", IPS: "Ipswich", LEE: "Leeds", LIV: "Liverpool", MCI: "Man City",
  MUN: "Man United", NEW: "Newcastle", NFO: "Nott'm Forest", SUN: "Sunderland", TOT: "Spurs",
};
const fx = (home, away, kickoff, hg = null, ag = null) => ({
  home, homeName: N[home], away, awayName: N[away], kickoff,
  status: hg == null ? "scheduled" : "finished", hg, ag,
});

function seed() {
  const gw6 = [
    fx("ARS", "LEE", at(-1, 0, "12:30"), 2, 0), fx("AVL", "BRE", at(-1, 0, "15:00"), 1, 1), fx("CHE", "BOU", at(-1, 0, "15:00"), 0, 1),
    fx("IPS", "FUL", at(-1, 0, "15:00"), 2, 2), fx("SUN", "BHA", at(-1, 0, "15:00"), 1, 0), fx("MUN", "TOT", at(-1, 0, "17:30"), 3, 1),
    fx("CRY", "NFO", at(-1, 1, "14:00"), 0, 0), fx("HUL", "EVE", at(-1, 1, "14:00"), 1, 2), fx("LIV", "MCI", at(-1, 1, "16:30"), 2, 1),
    fx("COV", "NEW", at(-1, 2, "20:00"), 0, 2),
  ];
  const gw7 = [
    fx("BOU", "ARS", at(0, 0, "12:30")), fx("BRE", "CHE", at(0, 0, "15:00")), fx("BHA", "LIV", at(0, 0, "15:00")),
    fx("EVE", "SUN", at(0, 0, "15:00")), fx("FUL", "MUN", at(0, 0, "15:00")), fx("LEE", "CRY", at(0, 0, "17:30")),
    fx("MCI", "HUL", at(0, 1, "14:00")), fx("NEW", "AVL", at(0, 1, "14:00")), fx("NFO", "IPS", at(0, 1, "16:30")),
    fx("TOT", "COV", at(0, 2, "20:00")),
  ];
  const players = [
    ["p1", "Big Dave", "ARS", "W"], ["p2", "Sian", "MUN", "W"], ["p3", "Mo", "CHE", "L"],
    ["p4", "Kezza", "LIV", "W"], ["p5", "Jonno", "AVL", "D"], ["p6", "Priya", "NEW", "W"],
  ];
  const db = {
    "config/game": { startGw: 6, entryFee: 20, season: "2026/27" },
    "config/sync": { at: iso(0, -1), fixtures: { roundsChanged: 0 } },
    "rounds/6": { gw: 6, deadline: gw6[0].kickoff, processed: true, fixtures: gw6, results: {} },
    "rounds/7": { gw: 7, deadline: gw7[0].kickoff, processed: false, fixtures: gw7 },
    "codes/DEMO0001": { label: "You: try joining with this one", playerId: "pyou", claimed: false, createdAt: iso(0) },
  };
  players.forEach(([id, nick, team, res], i) => {
    const out = res !== "W";
    db[`players/${id}`] = {
      nickname: nick, nicknameLower: nick.toLowerCase(), status: out ? "out" : "alive",
      ...(out ? { outGw: 6, outResult: { team, res } } : {}),
    };
    db[`rounds/6/picks/${id}`] = { team, teamName: N[team] };
    db["rounds/6"].results[id] = { team, res };
    db[`codes/DEMO${String(i + 2).padStart(4, "0")}`] = { label: `${nick} (sample)`, playerId: id, claimed: true, nickname: nick, createdAt: iso(-8) };
  });
  db["rounds/7/picks/p2"] = { team: "LIV", teamName: N.LIV };
  db["rounds/7/picks/p4"] = { team: "ARS", teamName: N.ARS };

  // Sample fixtures for the rest of the season (GW8 to GW38), one round a week.
  const teams = Object.keys(N), slots = [[0, "12:30"], [0, "15:00"], [0, "15:00"], [0, "15:00"], [0, "15:00"], [0, "17:30"], [1, "14:00"], [1, "14:00"], [1, "16:30"], [2, "20:00"]];
  const fixed = teams[0], rot = teams.slice(1);
  for (let gw = 8; gw <= 38; gw++) {
    const k = gw - 8, ring = rot.slice(k % 19).concat(rot.slice(0, k % 19)), all = [fixed, ...ring];
    const fixtures = [];
    for (let i = 0; i < 10; i++) {
      let a = all[i], b = all[19 - i];
      if ((k + i) % 2) [a, b] = [b, a];
      fixtures.push(fx(a, b, at(gw - 7, slots[i][0], slots[i][1])));
    }
    db[`rounds/${gw}`] = { gw, deadline: fixtures[0].kickoff, processed: false, fixtures };
  }
  return db;
}

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && d["rounds/38"] && Date.parse(d["rounds/7"]?.deadline) > Date.now()) return d;
  } catch {}
  return seed();
}
let DB = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch {} };
export function resetPreview() { try { localStorage.removeItem(KEY); } catch {} location.reload(); }

/* ---------- tiny stand-in for the database ---------- */
const listeners = new Set();
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
function snap(ref) {
  if (ref.col) {
    const depth = ref.path.split("/").length + 1;
    const docs = Object.keys(DB)
      .filter((p) => p.startsWith(ref.path + "/") && p.split("/").length === depth)
      .sort()
      .map((p) => ({ id: p.split("/").pop(), data: () => clone(DB[p]) }));
    return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
  }
  return { id: ref.path.split("/").pop(), exists: () => ref.path in DB, data: () => clone(DB[ref.path]) };
}
function changed() { save(); listeners.forEach((l) => l.next(snap(l.ref))); }

export const initializeApp = () => ({});
export const getFirestore = () => ({});
export const doc = (_db, ...segs) => ({ path: segs.join("/") });
export const collection = (_db, ...segs) => ({ path: segs.join("/"), col: true });
export const onSnapshot = (ref, next) => {
  const l = { ref, next }; listeners.add(l);
  setTimeout(() => listeners.has(l) && next(snap(ref)), 0);
  return () => listeners.delete(l);
};
export const setDoc = async (ref, data, opt) => { DB[ref.path] = opt?.merge ? { ...(DB[ref.path] || {}), ...clone(data) } : clone(data); changed(); };
export const updateDoc = async (ref, data) => {
  if (!(ref.path in DB)) throw new Error("Not found");
  DB[ref.path] = { ...DB[ref.path], ...clone(data) }; changed();
};
export const deleteDoc = async (ref) => { delete DB[ref.path]; changed(); };
export const serverTimestamp = () => new Date().toISOString();

/* ---------- sign-in ---------- */
export const getAuth = () => ({});
export const signInAnonymously = async () => {};
export const onAuthStateChanged = (_a, cb) => { setTimeout(() => cb({ uid: UID }), 0); return () => {}; };
export const signOut = async () => { delete DB[`sessions/${UID}`]; save(); };

/* ---------- the server checks, done locally ---------- */
const fail = (message) => { const e = new Error(message); e.code = "functions/failed-precondition"; return e; };
const norm = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const used = (pid, gw) => Object.keys(DB)
  .filter((p) => /^rounds\/\d+\/picks\//.test(p) && p.endsWith("/" + pid) && Number(p.split("/")[1]) < gw)
  .map((p) => DB[p].team);

const FNS = {
  async login({ code, nickname }) {
    const c = norm(code), nick = String(nickname || "").trim().replace(/\s+/g, " ");
    if (c.length !== 8) throw fail("Codes are 8 characters, like ABCD-2345.");
    if (!nick) throw fail("Enter a nickname.");
    const rec = DB[`codes/${c}`];
    if (!rec) throw fail("That code isn't recognised. Check it with the organiser.");
    if (!rec.claimed) {
      if (nick.length < 2 || nick.length > 20) throw fail("Pick a nickname between 2 and 20 characters.");
      if (!/^[\p{L}\p{N} '._-]+$/u.test(nick)) throw fail("Nicknames can use letters, numbers, spaces and . _ - ' only.");
      if (Object.keys(DB).some((p) => p.startsWith("players/") && DB[p].nicknameLower === nick.toLowerCase())) {
        throw fail("Someone already has that nickname. Try another.");
      }
      DB[`players/${rec.playerId}`] = { nickname: nick, nicknameLower: nick.toLowerCase(), status: "alive", joinedAt: serverTimestamp() };
      DB[`codes/${c}`] = { ...rec, claimed: true, nickname: nick };
    } else {
      const p = DB[`players/${rec.playerId}`];
      if (!p || p.status === "removed") throw fail("This code has been switched off. Speak to the organiser.");
      if (p.nicknameLower !== nick.toLowerCase()) throw fail("That code is already in use. Enter the nickname you chose with it.");
    }
    DB[`sessions/${UID}`] = { ...(DB[`sessions/${UID}`] || {}), playerId: rec.playerId };
    changed();
    return { playerId: rec.playerId };
  },
  async adminLogin({ passcode }) {
    if (String(passcode || "").trim().toLowerCase() !== "demo") throw fail("That passcode isn't right. In preview it's demo.");
    DB[`sessions/${UID}`] = { ...(DB[`sessions/${UID}`] || {}), admin: true };
    changed();
    return { ok: true };
  },
  async makePick({ gw, team }) {
    const pid = DB[`sessions/${UID}`]?.playerId;
    if (!pid) throw fail("Enter your code first.");
    if (DB[`players/${pid}`]?.status !== "alive") throw fail("You're out of this game, so you can't pick.");
    const r = DB[`rounds/${gw}`];
    if (!r || Date.parse(r.deadline) <= Date.now()) throw fail("Picks for that gameweek have closed.");
    const f = r.fixtures.find((x) => x.home === team || x.away === team);
    if (!f) throw fail("That team doesn't play this gameweek.");
    const name = f.home === team ? f.homeName : f.awayName;
    if (used(pid, gw).includes(team)) throw fail(`You've already used ${name}.`);
    DB[`rounds/${gw}/picks/${pid}`] = { team, teamName: name, at: serverTimestamp() };
    changed();
    return { gw, team, teamName: name };
  },
  async syncNow() {
    DB["config/sync"] = { at: serverTimestamp(), fixtures: { roundsChanged: 0 } };
    changed();
    return { fixtures: { roundsChanged: 0 }, knockouts: { processed: [] } };
  },
};
export const getFunctions = () => ({});
export const httpsCallable = (_f, name) => async (data) => {
  await new Promise((r) => setTimeout(r, 250));
  return { data: await FNS[name](data || {}) };
};
