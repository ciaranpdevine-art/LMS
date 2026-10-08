import { firebaseConfig } from "./firebase-config.js";

/* ---------------------------------------------------------------- setup */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Until Firebase settings are pasted into firebase-config.js, run with sample data on this phone.
const PREVIEW = !firebaseConfig || String(firebaseConfig.apiKey || "").startsWith("PASTE");
const FB = "https://www.gstatic.com/firebasejs/10.14.1/";
const F = PREVIEW
  ? await import("./preview.js")
  : Object.assign({}, ...(await Promise.all(["firebase-app", "firebase-auth", "firebase-firestore", "firebase-functions"].map((m) => import(FB + m + ".js")))));
const {
  initializeApp, getAuth, signInAnonymously, onAuthStateChanged, signOut,
  getFirestore, doc, collection, onSnapshot, setDoc, updateDoc, deleteDoc, serverTimestamp,
  getFunctions, httpsCallable, getDoc, getDocs, writeBatch,
} = F;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app, "europe-west2");
if (!PREVIEW && (location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  F.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  F.connectFirestoreEmulator(db, "127.0.0.1", 8080);
  F.connectFunctionsEmulator(fns, "127.0.0.1", 5001);
}
if (PREVIEW) {
  const bar = document.createElement("div");
  bar.className = "preview";
  bar.innerHTML = `<p><b>Preview mode.</b> The players, fixtures and results are samples, and nothing you do leaves this phone. To join as a new player, use code <b>DEMO-0001</b> with any nickname. To see a player with history, use <b>DEMO-0002</b> with the nickname <b>Big Dave</b>. The organiser passcode is <b>demo</b>.</p><button class="btn small ghost" type="button" id="resetPreview">Start again</button>`;
  document.querySelector(".wrap").prepend(bar);
  $("#resetPreview").onclick = () => F.resetPreview();
  // Fill in the preview passcode.
  const pass = $("#orgPass");
  pass.value = "demo";
}
// Preview: stand-in server in preview.js. Real game: write straight to the database,
// where the security rules (firestore.rules) do the checking.
const call = (name) => (PREVIEW ? httpsCallable(fns, name) : async (data) => ({ data: await REAL[name](data || {}) }));
const oops = (message) => Object.assign(new Error(message), { code: "app/friendly" });
const REAL = {
  async login({ code, nickname }) {
    const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const nick = String(nickname || "").trim().replace(/\s+/g, " ");
    if (c.length !== 8) throw oops("Codes are 8 characters, like ABCD-2345.");
    if (!nick) throw oops("Enter a nickname.");
    let snap;
    try { snap = await getDoc(doc(db, "codes", c)); } catch { throw oops("Couldn't check your code. Check your connection and try again."); }
    if (!snap.exists()) throw oops("That code isn't recognised. Check it with the organiser.");
    const rec = snap.data(), session = { playerId: rec.playerId, code: c, at: serverTimestamp() };
    if (!rec.claimed) {
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._'-]{1,19}$/.test(nick)) throw oops("Nicknames are 2 to 20 characters, using letters, numbers, spaces and . _ - ' only.");
      const start = S.rounds.find((r) => r.gw === startGw());
      if (start && ms(start.deadline) < Date.now()) throw oops("This game has already kicked off, so new players can't join. Ask the organiser about the next one.");
      const lower = nick.toLowerCase();
      if ((await getDoc(doc(db, "nicknames", lower))).exists()) throw oops("Someone already has that nickname. Try another.");
      const b = writeBatch(db);
      b.set(doc(db, "sessions", S.uid), session);
      b.set(doc(db, "players", rec.playerId), { nickname: nick, nicknameLower: lower, status: "alive", used: [], joinedAt: serverTimestamp() });
      b.set(doc(db, "nicknames", lower), { playerId: rec.playerId });
      b.update(doc(db, "codes", c), { claimed: true, nickname: nick, claimedAt: serverTimestamp() });
      try { await b.commit(); } catch { throw oops("Couldn't join with that code. Try again, and if it keeps happening ask the organiser for a new code."); }
    } else {
      const ps = await getDoc(doc(db, "players", rec.playerId));
      const p = ps.exists() ? ps.data() : null;
      if (!p || p.status === "removed") throw oops("This code has been switched off. Speak to the organiser.");
      if (p.nicknameLower !== nick.toLowerCase()) throw oops("That code is already in use. Enter the nickname you chose with it.");
      try { await setDoc(doc(db, "sessions", S.uid), session); } catch { throw oops("Couldn't sign you in. Try again."); }
    }
    return { playerId: rec.playerId };
  },
  async adminLogin({ passcode }) {
    const pass = String(passcode || "").trim();
    if (!S.uid) throw oops("Still connecting. Wait a moment and try again.");
    try { await setDoc(doc(db, "admins", S.uid), { pass, at: serverTimestamp() }); }
    catch (e) {
      await new Promise((r) => setTimeout(r, 800));
      if (String(e?.code || "").includes("permission-denied")) throw oops("That passcode isn't right. It must match the pass field in Firebase exactly, including capital letters.");
      throw oops(`Couldn't check the passcode (${e?.code || e?.message || "unknown error"}). Check your connection and try again.`);
    }
    return { ok: true };
  },
  async makePick({ gw, team }) {
    const pid = myId();
    if (!pid) throw oops("Enter your code first.");
    const r = S.rounds.find((x) => x.gw === gw);
    if (!r || ms(r.deadline) <= Date.now()) throw oops("Picks for that gameweek have closed.");
    const f = (r.fixtures || []).find((x) => x.home === team || x.away === team);
    if (!f) throw oops("That team doesn't play this gameweek.");
    const name = f.home === team ? f.homeName : f.awayName;
    if (usedTeams(pid, gw).has(team)) throw oops(`You've already used ${name}.`);
    try { await setDoc(doc(db, "rounds", String(gw), "picks", pid), { team, teamName: name, at: serverTimestamp() }); }
    catch { throw oops("Your pick didn't save. Check your connection and try again."); }
    return { gw, team, teamName: name };
  },
  async syncNow() {
    throw oops("Results update by themselves every hour.");
  },
};


const S = {
  uid: null, session: null, config: null, sync: null,
  players: {}, rounds: [], codes: {},
  picksByGw: {},      // gw -> {playerId: {team, teamName}} for rounds past their deadline
  myOpenPick: null,   // {gw, team, teamName} for the open round
  loaded: { config: false, players: false, rounds: false, session: false },
  view: "game", editingGw: null, lastShare: null,
};
const subs = { picks: {}, myPick: null, myPickGw: null, codes: null, session: null, admin: null };
const amAdmin = () => !!(S.session?.admin || S.adminOk);

/* ---------------------------------------------------------------- utils */
const ms = (t) => (t == null ? NaN : typeof t.toMillis === "function" ? t.toMillis() : typeof t === "string" ? Date.parse(t) : t.seconds * 1000);
const fmtWhen = (t) => {
  const d = new Date(ms(t));
  return {
    day: d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" }),
    time: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }),
  };
};
function untilText(t) {
  const left = ms(t) - Date.now();
  if (!(left > 0)) return "Closed";
  const m = Math.floor(left / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`;
}
const RESCHEDULE_GRACE_MS = 4 * 24 * 3600 * 1000;
function effStatus(f, dl) {
  if (f.status === "finished" || f.status === "postponed") return f.status;
  if (dl && ms(f.kickoff) - dl > RESCHEDULE_GRACE_MS) return "postponed";
  return f.status;
}
function outcome(r, team) {
  if (!team) return "N";
  const f = (r.fixtures || []).find((x) => x.home === team || x.away === team);
  if (!f) return "X";
  const s = effStatus(f, ms(r.deadline));
  if (s === "postponed") return "P";
  if (s === "finished" && f.result) return f.result === "D" ? "D" : (f.result === "H") === (f.home === team) ? "W" : "L";
  if (s !== "finished" || f.hg == null || f.ag == null) return "?";
  const gf = f.home === team ? f.hg : f.ag, ga = f.home === team ? f.ag : f.hg;
  return gf > ga ? "W" : gf === ga ? "D" : "L";
}
const RES_WORD = { W: "won", D: "drew", L: "lost", P: "postponed", N: "no pick", X: "didn't play", "?": "to play" };
function teamName(r, code) {
  const f = (r?.fixtures || []).find((x) => x.home === code || x.away === code);
  return f ? (f.home === code ? f.homeName : f.awayName) : code || "—";
}
function errText(e, fallback) {
  if (!e || !e.message || String(e.code || "").includes("internal") || String(e.code || "").includes("unavailable")) return fallback;
  return String(e.message);
}
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); if (btn) { const o = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = o), 1500); } }
  catch { if (btn) btn.textContent = "Select and copy the text above"; }
}

/* ---------------------------------------------------------------- game state */
function cfg() { return S.config || {}; }
function startGw() { return Number(cfg().startGw) || 1; }
function rounds() { return S.rounds.filter((r) => r.gw >= startGw()).sort((a, b) => a.gw - b.gw); }
function openRound() { const now = Date.now(); return rounds().find((r) => ms(r.deadline) > now) || null; }
function inPlayRound() { const now = Date.now(); return rounds().filter((r) => ms(r.deadline) <= now && !r.processed).pop() || null; }
function countedPlayers() { return Object.entries(S.players).filter(([, p]) => p.status !== "removed"); }
function myId() { return S.session?.playerId || null; }
function me() { return myId() ? S.players[myId()] : null; }
function pickOf(gw, pid) {
  if (S.picksByGw[gw]?.[pid]) return S.picksByGw[gw][pid];
  if (pid === myId() && S.myOpenPick?.gw === gw) return S.myOpenPick;
  return null;
}
function resultOf(r, pid) {
  if (r.processed && r.results?.[pid]) return r.results[pid].res;
  const p = pickOf(r.gw, pid);
  return outcome(r, p?.team);
}
function usedTeams(pid, beforeGw) {
  const s = new Map();
  for (const r of rounds()) if (r.gw < beforeGw) { const p = pickOf(r.gw, pid); if (p?.team) s.set(p.team, r.gw); }
  return s;
}

/* ---------------------------------------------------------------- subscriptions */
function subscribePublic() {
  onSnapshot(doc(db, "config", "game"), (s) => { S.config = s.exists() ? s.data() : null; S.loaded.config = true; render(); }, showLoadError);
  onSnapshot(collection(db, "players"), (s) => { const o = {}; s.forEach((d) => (o[d.id] = d.data())); S.players = o; S.loaded.players = true; render(); }, showLoadError);
  onSnapshot(collection(db, "rounds"), (s) => {
    S.rounds = s.docs.map((d) => d.data()).filter((r) => typeof r.gw === "number");
    S.loaded.rounds = true; syncPickSubs(); render();
  }, showLoadError);
}
function showLoadError() {
  $("#bootPanel").hidden = false;
  $("#bootPanel").innerHTML = `<h2>Can't reach the game</h2><p class="sub">Check your connection and reload. If it keeps happening, tell the organiser.</p>`;
}
// Subscribe to everyone's picks for rounds whose deadline has passed, and to my own pick for the open round.
function syncPickSubs() {
  const now = Date.now();
  for (const r of rounds()) {
    if (ms(r.deadline) <= now && !subs.picks[r.gw]) {
      subs.picks[r.gw] = onSnapshot(collection(db, "rounds", String(r.gw), "picks"), (s) => {
        const o = {}; s.forEach((d) => (o[d.id] = d.data())); S.picksByGw[r.gw] = o; render();
      }, () => {});
    }
  }
  const o = openRound(), pid = myId();
  const want = o && pid ? `${o.gw}/${pid}` : null;
  if (want !== subs.myPickGw) {
    if (subs.myPick) subs.myPick();
    subs.myPick = null; subs.myPickGw = want; S.myOpenPick = null;
    if (want) {
      subs.myPick = onSnapshot(doc(db, "rounds", String(o.gw), "picks", pid), (s) => {
        S.myOpenPick = s.exists() ? { gw: o.gw, ...s.data() } : null; render();
      }, () => {});
    }
  }
}
function watchCodes() {
  if (!amAdmin() || subs.codes) return;
  subs.codes = onSnapshot(collection(db, "codes"), (c) => { const o = {}; c.forEach((d) => (o[d.id] = d.data())); S.codes = o; renderOrg(); }, () => { subs.codes = null; });
}
function subscribeSession(uid) {
  if (subs.session) subs.session();
  subs.session = onSnapshot(doc(db, "sessions", uid), (s) => {
    S.session = s.exists() ? s.data() : {};
    S.loaded.session = true;
    watchCodes(); syncPickSubs(); render();
  }, () => { S.session = {}; S.loaded.session = true; render(); });
  if (!PREVIEW) {
    if (subs.admin) subs.admin();
    subs.admin = onSnapshot(doc(db, "admins", uid), (s) => { S.adminOk = s.exists(); watchCodes(); render(); }, () => {});
  }
}

/* ---------------------------------------------------------------- render */
function ready() { return Object.values(S.loaded).every(Boolean); }

function render() {
  if (!ready()) return;
  $("#bootPanel").hidden = true;
  renderBoard();
  renderWinner();
  const inOrg = S.view === "org";
  $("#orgArea").hidden = !inOrg;
  $("#orgLink").hidden = inOrg;
  $("#backLink").hidden = !inOrg;
  $("#signOutBtn").hidden = !(S.session?.playerId || amAdmin());
  const p = me();
  $("#whoBtn").hidden = !p;
  if (p) $("#whoBtn").textContent = p.nickname;
  if (inOrg) { $("#joinPanel").hidden = true; $("#gameArea").hidden = true; renderOrg(); return; }
  if (!p) { $("#joinPanel").hidden = false; $("#gameArea").hidden = true; return; }
  $("#joinPanel").hidden = true; $("#gameArea").hidden = false;
  renderStatus(); renderRound(); renderTable(); renderHistory(); renderPlan();
}

function renderBoard() {
  const c = cfg(), n = countedPlayers().length, alive = countedPlayers().filter(([, p]) => p.status === "alive").length;
  $("#season").textContent = c.season ? `Premier League survivor game · ${c.season}` : "Premier League survivor game";
  $("#sLeft").textContent = n ? `${alive}/${n}` : "0";
  $("#sPot").textContent = "£" + ((Number(c.entryFee) || 0) * n).toLocaleString("en-GB");
  const fee = Number(c.entryFee) || 0;
  $("#joinFee").textContent = fee ? ` (£${fee.toLocaleString("en-GB")})` : "";
  const o = openRound();
  $("#sRound").textContent = o ? `GW${o.gw}` : "—";
  $("#sClock").textContent = o ? untilText(o.deadline) : "—";
  const clock = document.querySelector("[data-clock]");
  if (clock && o) clock.textContent = untilText(o.deadline) === "Closed" ? "Picks closed" : untilText(o.deadline) + " to go";
}

function renderWinner() {
  const b = $("#winnerBanner"), w = cfg().winner;
  if (!w) { b.hidden = true; return; }
  const n = countedPlayers().length;
  b.hidden = false; b.className = "banner";
  b.innerHTML = `<span class="hand">${esc(S.players[w]?.nickname || "Someone")}</span><h2>Last one standing</h2><p class="sub">Takes the £${((Number(cfg().entryFee) || 0) * n).toLocaleString("en-GB")} pot after Gameweek ${esc(cfg().wonGw)}.</p>`;
}

function renderStatus() {
  const p = me(), sp = $("#statusPanel"), w = cfg().winner;
  const others = countedPlayers().filter(([id, x]) => x.status === "alive" && id !== myId()).length;
  const survived = rounds().filter((r) => r.processed && ["W", "P"].includes(r.results?.[myId()]?.res)).length;
  let stamp, head, line;
  if (w === myId()) { stamp = `<div class="stamp won">WINNER</div>`; head = "You've won it"; line = "Last one standing. Go and collect the pot."; }
  else if (p.status === "removed") { stamp = `<div class="stamp out">OFF</div>`; head = "Your entry's switched off"; line = "Speak to the organiser if that's a mistake."; }
  else if (p.status === "out") {
    const o = p.outResult || {}, r = S.rounds.find((x) => x.gw === p.outGw);
    stamp = `<div class="stamp out">OUT<small>GW${esc(p.outGw)}</small></div>`;
    head = "You're out";
    line = o.team ? `${esc(teamName(r, o.team))} ${o.res === "D" ? "drew" : o.res === "L" ? "lost" : RES_WORD[o.res] || ""} in Gameweek ${esc(p.outGw)}.` : `No pick in Gameweek ${esc(p.outGw)}.`;
    line += " You can still follow the table.";
  } else if (w) { stamp = `<div class="stamp">IN</div>`; head = "Game over"; line = `${esc(S.players[w]?.nickname || "Someone")} won this one.`; }
  else {
    stamp = `<div class="stamp">STILL<br>IN</div>`;
    head = survived ? `Survived ${survived} round${survived > 1 ? "s" : ""}` : "You're in";
    line = `${others} other${others === 1 ? "" : "s"} still in.`;
  }
  sp.innerHTML = `<div class="status"><div class="say"><div class="name">${esc(p.nickname)}</div><h2>${head}</h2><p>${line}</p></div>${stamp}</div>`;
}

const X_SVG = `<svg viewBox="0 0 42 42" aria-hidden="true"><path d="M9 10 C17 18 24 25 33 33"/><path d="M33 9 C25 17 18 25 8 34"/></svg>`;
let freshPick = null;

function renderRound() {
  const rp = $("#roundPanel"), o = openRound(), live = inPlayRound(), pid = myId(), p = me();
  let h = "";
  if (live) {
    const pk = pickOf(live.gw, pid), res = pk ? outcome(live, pk.team) : "N";
    const f = pk && (live.fixtures || []).find((x) => x.home === pk.team || x.away === pk.team);
    const score = f && (f.status === "finished" || f.status === "live") ? `${f.hg}–${f.ag}` : "";
    const vs = f ? ` v ${esc(f.home === pk.team ? f.awayName : f.homeName)}` : "";
    h += `<div class="inplay"><div class="what"><b>Gameweek ${live.gw} is under way</b><span>${pk ? `You went with ${esc(pk.teamName || teamName(live, pk.team))}${vs}${score ? `, ${score}` : ""}` : "You didn't pick this round"}</span></div>${pk ? `<span class="res ${res === "?" ? "q" : res}">${res === "?" ? (f?.status === "live" ? "Live" : "To play") : esc(RES_WORD[res])}</span>` : ""}</div>`;
  }
  if (!o) {
    rp.innerHTML = h + `<div class="sheet"><h2>Next round</h2><div class="empty">The next gameweek's fixtures appear here once they're confirmed.</div></div>`;
    return;
  }
  const waiting = false;
  const canPick = p.status === "alive" && !cfg().winner && !waiting;
  const myPick = S.myOpenPick?.gw === o.gw ? S.myOpenPick : null;
  const used = usedTeams(pid, o.gw);
  const k = fmtWhen(o.deadline);
  const say = waiting && p.status === "alive" ? "Picks for this gameweek open within the hour."
    : !canPick ? "You're not picking any more, but here are this week's games."
    : myPick ? `You've gone with <span class="hand">${esc(myPick.teamName || teamName(o, myPick.team))}</span>. Tap another team to change your mind.`
    : (() => { const pl = getPlan()[o.gw]; return pl ? `You pencilled in <span class="hand">${esc(teamName(o, pl))}</span> for this week. Tap it to make it your pick.` : "Tap the team you think will win."; })();
  h += `<div class="coupon${canPick ? "" : " closed"}"><div class="coupon-head"><h2>Gameweek ${o.gw}</h2><div class="closes">Picks close<b>${esc(k.day)}, ${esc(k.time)}</b><span data-clock>${untilText(o.deadline)} to go</span></div></div><div class="coupon-say">${say}</div>`;
  const side = (code, name, cls) => {
    const picked = myPick?.team === code, u = used.has(code) && !picked;
    const fresh = picked && freshPick === code ? " fresh" : "";
    const label = picked ? `${name}, your pick` : u ? `${name}, used in gameweek ${used.get(code)}` : `Pick ${name}`;
    return `<button class="pick ${cls}${picked ? " picked" : ""}${u ? " used" : ""}${fresh}" data-pick="${esc(code)}" ${!canPick || u ? "disabled" : ""} aria-pressed="${picked}" aria-label="${esc(label)}"><span class="box">${picked ? X_SVG : u ? `<span class="gw">${used.get(code)}</span>` : ""}</span><span class="tn">${esc(name)}</span></button>`;
  };
  [...(o.fixtures || [])].sort((a, b) => ms(a.kickoff) - ms(b.kickoff)).forEach((f, i) => {
    const t = fmtWhen(f.kickoff);
    const mid = f.status === "postponed" ? `P–P<small>postponed</small>` : `${esc(t.time)}<small>${esc(t.day)}</small>`;
    h += `<div class="line"><span class="no">${i + 1}</span>${side(f.home, f.homeName, "home")}<div class="ko">${mid}</div>${side(f.away, f.awayName, "away")}</div>`;
  });
  h += `<div class="coupon-foot msg" id="pickMsg" role="status"></div></div>`;
  rp.innerHTML = h;
  freshPick = null;
  rp.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => makePick(o.gw, b.dataset.pick, b)));
}

async function makePick(gw, team, btn) {
  document.querySelectorAll("[data-pick]").forEach((b) => (b.disabled = true));
  const m = () => $("#pickMsg");
  if (m()) { m().className = "coupon-foot msg"; m().textContent = "Marking your coupon…"; }
  try {
    const r = await call("makePick")({ gw, team });
    S.myOpenPick = { gw, team, teamName: r.data.teamName };
    freshPick = team;
    render();
    if (m()) { m().className = "coupon-foot msg"; m().textContent = `${r.data.teamName} it is. Good luck.`; }
  } catch (e) {
    render();
    if (m()) { m().className = "coupon-foot msg err"; m().textContent = errText(e, "Your pick didn't save. Try again."); }
  }
}

function renderTable() {
  const el = $("#tableBody"), list = countedPlayers();
  if (!list.length) { el.innerHTML = `<div class="empty">Nobody's joined yet.</div>`; return; }
  const now = Date.now(), shown = rounds().filter((r) => ms(r.deadline) <= now), w = cfg().winner;
  list.sort(([, pa], [, pb]) => {
    const oa = pa.status === "alive" ? 999 : pa.outGw || 0, ob = pb.status === "alive" ? 999 : pb.outGw || 0;
    return ob - oa || pa.nickname.localeCompare(pb.nickname);
  });
  const rows = list.map(([id, p]) => {
    const out = p.status === "out", cls = w === id ? "winner" : out ? "out" : "";
    const tag = w === id ? "Winner" : out ? `Out GW${esc(p.outGw)}` : "Standing";
    const hist = shown.map((r) => {
      if (out && r.gw > p.outGw) return "";
      if (r.processed && r.results && !r.results[id]) return "";
      const pk = pickOf(r.gw, id), res = resultOf(r, id);
      if (!pk) return `<span class="res N" title="Gameweek ${r.gw}: no pick">GW${r.gw} –</span>`;
      return `<span class="res ${res === "?" ? "q" : res}" title="Gameweek ${r.gw}: ${esc(pk.teamName || pk.team)}, ${esc(RES_WORD[res])}">${esc(pk.team)}</span>`;
    }).join("");
    return `<li class="${cls}"><span class="nm">${esc(p.nickname)}${id === myId() ? `<span class="you">you</span>` : ""}</span><span class="tag">${tag}</span>${hist ? `<div class="hist">${hist}</div>` : ""}</li>`;
  }).join("");
  const notes = shown.filter((r) => r.everyoneSurvived).map((r) => `<p class="board-note">Gameweek ${r.gw}: everyone left went out, so everyone survived.</p>`).join("");
  el.innerHTML = `<ul class="board">${rows}</ul>${notes}`;
}

function renderHistory() {
  const pid = myId(), p = me(), el = $("#historyBody"), left = $("#teamsLeft");
  if (!pid || !p) return;
  const now = Date.now(), o = openRound();
  const rs = rounds().filter((r) => ms(r.deadline) <= now || (o && r.gw === o.gw));
  const rows = [];
  for (const r of [...rs].reverse()) {
    if (r.processed && r.results && !r.results[pid]) continue; // joined after this round
    if (p.status === "out" && r.gw > p.outGw) continue;
    const pk = pickOf(r.gw, pid), open = o && r.gw === o.gw;
    if (!pk) {
      rows.push(`<li><span class="gwk">GW${r.gw}</span><div class="mp"><b>${open ? "No pick yet" : "No pick"}</b><span>${open ? `Picks close ${esc(fmtWhen(r.deadline).day)}, ${esc(fmtWhen(r.deadline).time)}` : "Missed the deadline"}</span></div>${open ? "" : `<span class="res N">Out</span>`}</li>`);
      continue;
    }
    const f = (r.fixtures || []).find((x) => x.home === pk.team || x.away === pk.team);
    const home = f && f.home === pk.team;
    const opp = f ? `${home ? "v" : "at"} ${esc(home ? f.awayName : f.homeName)}` : "";
    const res = open ? "?" : resultOf(r, pid);
    const played = f && (f.status === "finished" || f.status === "live") && f.hg != null;
    const score = played ? (home ? `${f.hg}–${f.ag}` : `${f.ag}–${f.hg}`) : "";
    const when = f ? `${fmtWhen(f.kickoff).day}, ${fmtWhen(f.kickoff).time}` : "";
    const badge = open ? `<span class="res q">Can change</span>`
      : res === "?" ? `<span class="res q">${f?.status === "live" ? "Live" : "To play"}</span>`
      : `<span class="res ${res}">${res === "W" ? "Won" : res === "D" ? "Drew" : res === "L" ? "Lost" : res === "P" ? "Postponed" : esc(RES_WORD[res])}</span>`;
    rows.push(`<li><span class="gwk">GW${r.gw}</span><div class="mp"><b class="hand">${esc(pk.teamName || teamName(r, pk.team))}</b><span>${opp}${score ? `, ${score}` : when ? `, ${esc(when)}` : ""}</span></div>${badge}</li>`);
  }
  el.innerHTML = rows.length ? `<ul class="mine">${rows.join("")}</ul>` : `<div class="empty">Your picks will build up here, week by week. Make your first one on the Coupon tab.</div>`;

  // every team seen in any fixture this season
  const all = new Map();
  for (const r of S.rounds) for (const f of r.fixtures || []) { all.set(f.home, f.homeName); all.set(f.away, f.awayName); }
  const used = usedTeams(pid, o ? o.gw : Infinity);
  const current = o && S.myOpenPick?.gw === o.gw ? S.myOpenPick.team : null;
  const teams = [...all.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const avail = teams.filter(([c]) => !used.has(c)).length;
  const planned = new Map(Object.entries(getPlan()).map(([g, t]) => [t, g]));
  left.innerHTML = `<p class="note">${avail} of ${teams.length} still available.${planned.size ? ` ${planned.size} pencilled in on your plan.` : ""}</p><div class="chips">${teams.map(([c, n]) => {
    const u = used.has(c), pl = !u && c !== current && planned.get(c);
    return `<span class="chip-t${u ? " gone" : ""}${c === current ? " now" : ""}${pl ? " planned" : ""}">${esc(n)}${u ? `<small>GW${used.get(c)}</small>` : c === current ? "<small>this week</small>" : pl ? `<small>plan GW${pl}</small>` : ""}</span>`;
  }).join("")}</div>`;
}

/* ---------------------------------------------------------------- plan ahead (saved on this phone) */
const planKey = () => `lms-plan-${myId()}`;
function getPlan() { try { return JSON.parse(localStorage.getItem(planKey())) || {}; } catch { return {}; } }
function setPlan(p) { try { localStorage.setItem(planKey(), JSON.stringify(p)); } catch {} }
const planOpen = new Set();

function renderPlan() {
  const pid = myId(), p = me(), box = $("#planRounds"), sum = $("#planSummary");
  if (!pid || !p) return;
  const o = openRound(), now = Date.now();
  const future = rounds().filter((r) => ms(r.deadline) > now && (!o || r.gw > o.gw));
  const plan = getPlan();
  // forget plans for weeks that have arrived or teams already used
  const used = usedTeams(pid, o ? o.gw : Infinity);
  const current = o && S.myOpenPick?.gw === o.gw ? S.myOpenPick.team : null;
  let tidy = false;
  for (const gw of Object.keys(plan)) {
    if (!future.some((r) => r.gw === Number(gw)) || used.has(plan[gw])) { delete plan[gw]; tidy = true; }
  }
  if (tidy) setPlan(plan);
  const plannedAt = new Map(Object.entries(plan).map(([gw, t]) => [t, Number(gw)]));
  const nameOf = (r, c) => teamName(r, c);

  if (p.status !== "alive" || cfg().winner) {
    sum.innerHTML = `<p class="note">You're not in the game any more, but you can still look at what's coming up.</p>`;
  } else {
    const n = Object.keys(plan).length;
    const chips = future.slice(0, 8).map((r) => `<button class="pchip${plan[r.gw] ? " set" : ""}" data-jump="${r.gw}" type="button"><small>GW${r.gw}</small>${plan[r.gw] ? esc(nameOf(r, plan[r.gw])) : "?"}</button>`).join("");
    sum.innerHTML = `<div class="pnow">${o ? `This week (GW${o.gw}): ${current ? `<b class="hand">${esc(S.myOpenPick.teamName || nameOf(o, current))}</b>` : "<b>not picked yet</b>"}` : ""}</div>
      <div class="pchips">${chips}</div>
      <div class="row center"><span class="note">${n ? `${n} week${n === 1 ? "" : "s"} pencilled in.` : "Nothing pencilled in yet. Open a gameweek below and tap a team."}</span>${n ? `<button class="btn small ghost" id="planClear" type="button">Rub it all out</button>` : ""}</div>`;
    sum.querySelectorAll("[data-jump]").forEach((b) => (b.onclick = () => {
      planOpen.add(Number(b.dataset.jump)); renderPlan();
      document.querySelector(`[data-plan-gw="${b.dataset.jump}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    const clr = $("#planClear");
    if (clr) clr.onclick = () => twoTap(clr, () => { setPlan({}); renderPlan(); renderHistory(); });
  }

  if (!future.length) { box.innerHTML = `<div class="sheet"><div class="empty">Fixtures for later gameweeks will appear here once they're published.</div></div>`; return; }
  const canPlan = p.status === "alive" && !cfg().winner;
  box.innerHTML = future.map((r) => {
    const first = fmtWhen(r.deadline), mine = plan[r.gw];
    const lines = [...(r.fixtures || [])].sort((a, b) => ms(a.kickoff) - ms(b.kickoff)).map((f) => {
      const t = fmtWhen(f.kickoff);
      const side = (code, name, cls) => {
        const u = used.has(code), cur = code === current, here = mine === code, other = plannedAt.has(code) && !here ? plannedAt.get(code) : null;
        const tag = u ? `used GW${used.get(code)}` : cur ? "this week" : other ? `GW${other}` : "";
        const dis = !canPlan || u || cur;
        return `<button class="pteam ${cls}${here ? " here" : ""}${u || cur ? " gone" : ""}${other ? " elsewhere" : ""}" data-plan="${r.gw}:${esc(code)}" type="button" ${dis ? "disabled" : ""} aria-pressed="${here}"><span class="tn">${esc(name)}</span>${tag ? `<small>${tag}</small>` : ""}</button>`;
      };
      return `<div class="pline">${side(f.home, f.homeName, "home")}<span class="pko">${esc(t.time)}<small>${esc(t.day)}</small></span>${side(f.away, f.awayName, "away")}</div>`;
    }).join("");
    return `<details class="plan-gw" data-plan-gw="${r.gw}" ${planOpen.has(r.gw) ? "open" : ""}><summary><b>GW${r.gw}</b><span class="pd">${esc(first.day)}</span><span class="pp${mine ? " set" : ""}">${mine ? esc(nameOf(r, mine)) : "not planned"}</span></summary><div class="plines">${lines}</div></details>`;
  }).join("") + `<p class="plan-foot">Kick-off times further ahead are provisional and often move for TV.</p>`;

  box.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", () => { const g = Number(d.dataset.planGw); d.open ? planOpen.add(g) : planOpen.delete(g); }));
  box.querySelectorAll("[data-plan]").forEach((b) => (b.onclick = () => {
    const [gw, team] = b.dataset.plan.split(":"), pl = getPlan();
    if (pl[gw] === team) delete pl[gw];
    else { for (const g of Object.keys(pl)) if (pl[g] === team) delete pl[g]; pl[gw] = team; }
    setPlan(pl); renderPlan(); renderHistory();
  }));
}

/* ---------------------------------------------------------------- organiser */
function renderOrg() {
  if (S.view !== "org" || !ready()) return;
  const isAdmin = amAdmin();
  $("#orgLogin").hidden = isAdmin; $("#orgTools").hidden = !isAdmin;
  if (!isAdmin) return;

  // codes
  const codes = Object.entries(S.codes).sort((a, b) => ms(b[1].createdAt) - ms(a[1].createdAt));
  $("#codeList").innerHTML = codes.length ? `<div class="list">${codes.map(([code, c]) => {
    const p = c.playerId && S.players[c.playerId];
    const state = c.claimed ? `joined as ${esc(p?.nickname || c.nickname)}${p?.status === "removed" ? " (switched off)" : ""}` : "not used yet";
    return `<div class="item"><div class="who-l"><b class="mono">${fmtCode(code)}</b><span class="note">${esc(c.label)} · ${state}</span></div><div class="row">${c.claimed ? "" : `<button class="btn small ghost" data-share="${esc(code)}">Copy message</button><button class="btn small ghost" data-delcode="${esc(code)}">Delete</button>`}</div></div>`;
  }).join("")}</div>` : `<div class="empty">No codes yet. Create one above when someone pays.</div>`;
  $("#codeList").querySelectorAll("[data-share]").forEach((b) => (b.onclick = () => copyText(shareText(b.dataset.share), b)));
  $("#codeList").querySelectorAll("[data-delcode]").forEach((b) => (b.onclick = () => twoTap(b, () => deleteDoc(doc(db, "codes", b.dataset.delcode)))));

  // players
  const ps = Object.entries(S.players).sort((a, b) => a[1].nickname.localeCompare(b[1].nickname));
  const n = countedPlayers().length;
  $("#playerList").innerHTML = ps.length ? `<p class="note">${n} paid player${n === 1 ? "" : "s"} · pot £${((Number(cfg().entryFee) || 0) * n).toLocaleString("en-GB")}</p><div class="list">${ps.map(([id, p]) => {
    const st = p.status === "removed" ? "Switched off" : p.status === "out" ? `Out GW${p.outGw}` : "Standing";
    const action = p.status === "removed" ? `<button class="btn small ghost" data-restore="${id}">Switch back on</button>` : `<button class="btn small ghost" data-remove="${id}">Switch off</button>`;
    return `<div class="item"><div class="who-l"><b>${esc(p.nickname)}</b><span class="note">${st}</span></div>${action}</div>`;
  }).join("")}</div>` : `<div class="empty">Players appear here once they enter their code.</div>`;
  $("#playerList").querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => twoTap(b, () => updateDoc(doc(db, "players", b.dataset.remove), { status: "removed", prevStatus: S.players[b.dataset.remove].status }))));
  $("#playerList").querySelectorAll("[data-restore]").forEach((b) => (b.onclick = () => updateDoc(doc(db, "players", b.dataset.restore), { status: S.players[b.dataset.restore].prevStatus || "alive" })));

  // sync info

  if (S.editingGw == null) renderRoundAdmin();

  // settings (fill once, don't overwrite while typing)
  for (const [id, key] of [["#setSeason", "season"], ["#setStart", "startGw"], ["#setFee", "entryFee"]]) {
    const el = $(id); if (document.activeElement !== el && !el.dataset.touched) el.value = cfg()[key] ?? (key === "startGw" ? "" : "");
  }
}
function twoTap(btn, fn) {
  if (btn.dataset.confirm) { fn(); return; }
  btn.dataset.confirm = "1"; const o = btn.textContent; btn.textContent = "Tap again to confirm";
  setTimeout(() => { if (btn.isConnected) { btn.textContent = o; delete btn.dataset.confirm; } }, 4000);
}
const fmtCode = (c) => (c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);
function shareText(code) {
  return `You're in Last Man Standing, our Premier League last-one-standing game.\n\nYour code: ${fmtCode(code)}\nOpen ${location.origin + location.pathname}, enter the code and choose a nickname. Then pick a team each week. Keep the code to yourself: it's your login.`;
}
function newCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(r, (x) => a[x % a.length]).join("");
}
function newId() {
  const r = crypto.getRandomValues(new Uint8Array(15));
  return Array.from(r, (x) => x.toString(16).padStart(2, "0")).join("");
}
/* ---------------------------------------------------------------- organiser: fixtures and results */
const NAME2CODE = {
  "Arsenal": "ARS", "Aston Villa": "AVL", "Bournemouth": "BOU", "Brentford": "BRE", "Brighton": "BHA",
  "Chelsea": "CHE", "Coventry": "COV", "Crystal Palace": "CRY", "Everton": "EVE", "Fulham": "FUL",
  "Hull": "HUL", "Ipswich": "IPS", "Leeds": "LEE", "Liverpool": "LIV", "Man City": "MCI",
  "Man United": "MUN", "Newcastle": "NEW", "Nott'm Forest": "NFO", "Sunderland": "SUN", "Tottenham": "TOT",
};
// UK clock time <-> exact moment, allowing for British Summer Time.
function londonOffset(t) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t));
  const g = (k) => Number(p.find((x) => x.type === k).value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - Math.floor(t / 60000) * 60000;
}
function londonToIso(local) {
  const [d, tm] = String(local).split("T"), [y, mo, da] = d.split("-").map(Number), [h, mi] = tm.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, da, h, mi);
  let t = wall;
  for (let i = 0; i < 3; i++) t = wall - londonOffset(t);
  return new Date(t).toISOString();
}
function isoToLondon(iso) {
  const t = ms(iso); if (Number.isNaN(t)) return "";
  return new Date(t + londonOffset(t)).toISOString().slice(0, 16);
}
const resolved = (f) => ["finished", "postponed"].includes(f.status);
const firstKick = (fx) => { const live = fx.filter((f) => f.status !== "postponed"); const t = (live.length ? live : fx).map((f) => ms(f.kickoff)); return new Date(Math.min(...t)); };

async function loadSeason(btn) {
  const m = $("#syncMsg");
  btn.disabled = true; m.className = "msg"; m.textContent = "Loading fixtures…";
  try {
    const { FIXTURES, SEASON } = await import("./fixtures.js?v=8");
    const byGw = new Map();
    for (const [gw, when, home, away] of FIXTURES) {
      if (!NAME2CODE[home] || !NAME2CODE[away]) throw oops(`Unknown team in the fixture list: ${!NAME2CODE[home] ? home : away}.`);
      if (!byGw.has(gw)) byGw.set(gw, []);
      byGw.get(gw).push({ id: `${gw}-${byGw.get(gw).length + 1}`, home: NAME2CODE[home], homeName: home, away: NAME2CODE[away], awayName: away, kickoff: londonToIso(when), status: "scheduled", hg: null, ag: null, result: null });
    }
    const now = Date.now(), have = new Set(S.rounds.map((r) => r.gw));
    let start = Number(cfg().startGw) || 0;
    if (!start) start = [...byGw.entries()].filter(([, fx]) => firstKick(fx).getTime() > now).map(([g]) => g).sort((a, b) => a - b)[0];
    if (!start) throw oops("Every gameweek in the fixture list has already started.");
    const b = writeBatch(db);
    let n = 0;
    for (const [gw, fx] of byGw) {
      if (gw < start || have.has(gw)) continue;
      fx.sort((a, z) => ms(a.kickoff) - ms(z.kickoff));
      b.set(doc(db, "rounds", String(gw)), { gw, fixtures: fx, deadline: firstKick(fx), teams: [...new Set(fx.flatMap((f) => [f.home, f.away]))], processed: false });
      n++;
    }
    b.set(doc(db, "config", "game"), { startGw: start, season: cfg().season || SEASON, entryFee: Number(cfg().entryFee) || 0 }, { merge: true });
    await b.commit();
    m.textContent = n ? `Loaded ${n} gameweeks, from Gameweek ${start} to the end of the season.` : "All the fixtures were already loaded.";
  } catch (e) { m.className = "msg err"; m.textContent = errText(e, "Couldn't load the fixtures. Check you're signed in as organiser and try again."); }
  finally { btn.disabled = false; }
}

function renderRoundAdmin() {
  const el = $("#roundAdmin"), now = Date.now();
  if (!S.rounds.length) {
    el.innerHTML = `<div class="empty">No fixtures yet. Load the season to add every gameweek from the next one to Gameweek 38.<div class="row" style="justify-content:center"><button class="btn go" type="button" id="loadSeason">Load season fixtures</button></div></div>`;
    $("#loadSeason").onclick = (e) => loadSeason(e.currentTarget);
    return;
  }
  const all = rounds();
  const todo = all.filter((r) => !r.processed && ms(r.deadline) <= now);
  const upcoming = all.filter((r) => ms(r.deadline) > now);
  const settled = all.filter((r) => r.processed).slice(-2);
  const row = (r) => {
    const fx = r.fixtures || [], fin = fx.filter(resolved).length;
    const picks = S.picksByGw[r.gw] ? Object.keys(S.picksByGw[r.gw]).length : null;
    const k = fmtWhen(r.deadline);
    const state = r.processed ? "Settled" : ms(r.deadline) > now ? `Picks close ${k.day} ${k.time}` : `${fin} of ${fx.length} results in`;
    const btn = r.processed ? "" : ms(r.deadline) > now ? `<button class="btn small ghost" data-edit="${r.gw}" type="button">Change times</button>` : `<button class="btn small go" data-edit="${r.gw}" type="button">Enter results</button>`;
    return `<div class="item"><div class="who-l"><b>GW${r.gw}</b><span class="note">${state}${picks != null ? ` · ${picks} pick${picks === 1 ? "" : "s"}` : ""}</span></div>${btn}</div>`;
  };
  const showAll = S.showAllRounds;
  el.innerHTML = (todo.length ? `<h3>Waiting for results</h3><div class="list">${todo.map(row).join("")}</div>` : "")
    + `<h3>Coming up</h3><div class="list">${(showAll ? upcoming : upcoming.slice(0, 3)).map(row).join("") || `<div class="empty">No more gameweeks.</div>`}</div>`
    + (upcoming.length > 3 ? `<div class="row"><button class="btn small ghost" id="toggleRounds" type="button">${showAll ? "Show fewer" : `Show all ${upcoming.length} gameweeks`}</button></div>` : "")
    + (settled.length ? `<h3>Settled</h3><div class="list">${settled.map(row).join("")}</div>` : "");
  el.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => editRound(Number(b.dataset.edit))));
  const tg = $("#toggleRounds"); if (tg) tg.onclick = () => { S.showAllRounds = !showAll; renderRoundAdmin(); };
}

function editRound(gw) {
  S.editingGw = gw;
  const r = S.rounds.find((x) => x.gw === gw), el = $("#roundAdmin");
  const started = ms(r.deadline) <= Date.now();
  const fx = [...(r.fixtures || [])].sort((a, b) => ms(a.kickoff) - ms(b.kickoff));
  const cur = (f) => (f.status === "postponed" ? "P" : f.result || (f.status === "finished" && f.hg != null ? (f.hg > f.ag ? "H" : f.hg === f.ag ? "D" : "A") : ""));
  el.innerHTML = `<h3>Gameweek ${gw}</h3><p class="note">${started ? "Pick the result of each match once it's finished. When every match has a result, players are knocked out automatically." : "Picks close at the first kick-off. Change a time here if a match moves."}</p>
    <div class="list">${fx.map((f) => `
      <div class="item res-item" data-id="${esc(f.id)}"><div class="who-l"><b>${esc(f.homeName)} v ${esc(f.awayName)}</b>
        <label class="kick">Kick-off (UK time)<input type="datetime-local" data-k="${esc(f.id)}" value="${esc(isoToLondon(f.kickoff))}"></label></div>
        <div class="seg" role="radiogroup" aria-label="Result of ${esc(f.homeName)} v ${esc(f.awayName)}">
          ${[["H", f.homeName], ["D", "Draw"], ["A", f.awayName], ["P", "Postponed"], ["", "Not played"]].map(([v, t]) => `<button type="button" role="radio" data-r="${esc(f.id)}" data-v="${v}" aria-checked="${cur(f) === v}" ${!started && v && v !== "P" ? "disabled" : ""}>${esc(v === "H" || v === "A" ? `${t} win` : t)}</button>`).join("")}
        </div></div>`).join("")}</div>
    <div class="row"><button class="btn go" id="saveRes" type="button">Save</button><button class="btn ghost" id="cancelRes" type="button">Cancel</button></div><div class="msg" id="resMsg" role="status"></div>`;
  el.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => {
    el.querySelectorAll(`[data-r="${CSS.escape(b.dataset.r)}"]`).forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  }));
  $("#cancelRes").onclick = () => { S.editingGw = null; renderOrg(); };
  $("#saveRes").onclick = async () => {
    const msg = $("#resMsg"), save = $("#saveRes");
    const fixtures = (r.fixtures || []).map((f) => {
      const pick = el.querySelector(`[data-r="${CSS.escape(f.id)}"][aria-checked="true"]`)?.dataset.v ?? "";
      const k = el.querySelector(`[data-k="${CSS.escape(f.id)}"]`)?.value;
      const kickoff = k ? londonToIso(k) : f.kickoff;
      const status = pick === "P" ? "postponed" : pick ? "finished" : "scheduled";
      return { ...f, kickoff, status, result: pick && pick !== "P" ? pick : null, hg: null, ag: null };
    });
    const upd = { fixtures };
    if (!started) upd.deadline = firstKick(fixtures);
    save.disabled = true; msg.className = "msg"; msg.textContent = "Saving…";
    try {
      await updateDoc(doc(db, "rounds", String(gw)), upd);
      const fresh = { ...r, ...upd };
      let note = "Saved.";
      if (started && fixtures.every(resolved)) note = await settleRound(fresh);
      else if (started) note = `Saved. ${fixtures.filter((f) => !resolved(f)).length} match${fixtures.filter((f) => !resolved(f)).length === 1 ? "" : "es"} still to go before anyone is knocked out.`;
      S.editingGw = null; renderOrg();
      $("#syncMsg").className = "msg"; $("#syncMsg").textContent = note;
    } catch (e) { msg.className = "msg err"; msg.textContent = errText(e, "Couldn't save. Check your connection and try again."); save.disabled = false; }
  };
}

// Every match has a result: record used teams, knock players out, find a winner.
async function settleRound(r) {
  const earlier = rounds().filter((x) => x.gw < r.gw && !x.processed);
  if (earlier.length) return `Saved. Gameweek ${r.gw} will be settled once Gameweek ${earlier[0].gw} has all its results.`;
  const picksSnap = await getDocs(collection(db, "rounds", String(r.gw), "picks"));
  const picks = {};
  picksSnap.forEach((d) => (picks[d.id] = d.data().team));
  const counted = Object.entries(S.players).filter(([, p]) => p.status !== "removed");
  const alive = counted.filter(([, p]) => p.status === "alive").map(([id]) => id);
  const results = {}, fallen = [];
  for (const id of alive) {
    const team = picks[id] || null, res = outcome(r, team);
    results[id] = { team, res };
    if (!(res === "W" || res === "P")) fallen.push(id);
  }
  const everyone = alive.length > 0 && fallen.length === alive.length;
  const out = everyone ? [] : fallen;
  const b = writeBatch(db);
  for (const [id, p] of counted) {
    const upd = {};
    if (picks[id]) upd.used = [...new Set([...(p.used || []), picks[id]])];
    if (out.includes(id)) Object.assign(upd, { status: "out", outGw: r.gw, outResult: results[id] });
    if (Object.keys(upd).length) b.update(doc(db, "players", id), upd);
  }
  b.update(doc(db, "rounds", String(r.gw)), { processed: true, results, everyoneSurvived: everyone });
  const left = alive.filter((id) => !out.includes(id));
  if (left.length === 1 && counted.length > 1) b.set(doc(db, "config", "game"), { winner: left[0], wonGw: r.gw }, { merge: true });
  await b.commit();
  if (left.length === 1 && counted.length > 1) return `Gameweek ${r.gw} settled. ${S.players[left[0]]?.nickname || "Someone"} is the last one standing!`;
  if (everyone) return `Gameweek ${r.gw} settled. Everyone left went out, so they all survive to the next round.`;
  return `Gameweek ${r.gw} settled. ${out.length} player${out.length === 1 ? "" : "s"} knocked out, ${left.length} still standing.`;
}

/* ---------------------------------------------------------------- forms */
$("#joinForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const m = $("#joinMsg"), btn = $("#joinBtn");
  const code = $("#joinCode").value.trim(), nickname = $("#joinName").value.trim();
  if (!code || !nickname) { m.className = "msg err"; m.textContent = "Enter your code and a nickname."; return; }
  btn.disabled = true; m.className = "msg"; m.textContent = "Checking your code…";
  try { await call("login")({ code, nickname }); m.textContent = ""; }
  catch (e) { m.className = "msg err"; m.textContent = errText(e, "Something went wrong. Try again."); }
  finally { btn.disabled = false; }
});
$("#joinCode").addEventListener("input", (e) => {
  let v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (v.length > 4) v = v.slice(0, 4) + "-" + v.slice(4);
  e.target.value = v;
});
$("#orgForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const m = $("#orgMsg"), btn = $("#orgBtn");
  btn.disabled = true; m.className = "msg"; m.textContent = "Checking…";
  try { await call("adminLogin")({ passcode: $("#orgPass").value }); $("#orgPass").value = ""; m.textContent = ""; }
  catch (e) { m.className = "msg err"; m.textContent = errText(e, "That passcode isn't right."); }
  finally { btn.disabled = false; }
});
$("#codeForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const label = $("#codeLabel").value.trim(), m = $("#codeMsg");
  if (!label) return;
  const code = newCode();
  try {
    await setDoc(doc(db, "codes", code), { label, playerId: newId(), claimed: false, createdAt: serverTimestamp() });
    $("#codeLabel").value = ""; m.className = "msg"; m.textContent = `Code for ${label}: ${fmtCode(code)}. Send them this:`;
    $("#codeShare").innerHTML = `<div class="share" id="shareBox">${esc(shareText(code))}</div><button class="btn small" id="copyShare" type="button" style="margin-top:8px">Copy message</button>`;
    $("#copyShare").onclick = () => copyText(shareText(code), $("#copyShare"));
  } catch (e) { m.className = "msg err"; m.textContent = "That code didn't save. Check you're still signed in as organiser."; }
});
$("#setForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const m = $("#setMsg"), startGw_ = Number($("#setStart").value), entryFee = Number($("#setFee").value), season = $("#setSeason").value.trim();
  if (!(startGw_ >= 1 && startGw_ <= 38)) { m.className = "msg err"; m.textContent = "First gameweek must be between 1 and 38."; return; }
  if (!(entryFee >= 0)) { m.className = "msg err"; m.textContent = "Entry fee must be a number."; return; }
  try {
    await setDoc(doc(db, "config", "game"), { startGw: startGw_, entryFee, season }, { merge: true });
    m.className = "msg"; m.textContent = "Saved.";
    ["#setSeason", "#setStart", "#setFee"].forEach((s) => delete $(s).dataset.touched);
  } catch (e) { m.className = "msg err"; m.textContent = "Settings didn't save. Try again."; }
});
["#setSeason", "#setStart", "#setFee"].forEach((s) => $(s).addEventListener("input", (e) => (e.target.dataset.touched = "1")));
/* ---------------------------------------------------------------- navigation */
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(t) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  document.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== t));
}
function setView(v) { S.view = v; location.hash = v === "org" ? "organiser" : ""; render(); window.scrollTo(0, 0); }
$("#orgLink").onclick = () => setView("org");
$("#backLink").onclick = () => setView("game");
$("#whoBtn").onclick = () => setView("game");
$("#signOutBtn").onclick = (e) => twoTap(e.target, async () => { await signOut(auth); location.hash = ""; location.reload(); });
if (location.hash === "#organiser") S.view = "org";
setInterval(() => { if (ready()) { syncPickSubs(); renderBoard(); } }, 30000);

/* ---------------------------------------------------------------- start */
subscribePublic();
onAuthStateChanged(auth, (user) => {
  if (!user) { signInAnonymously(auth).catch(() => showLoadError()); return; }
  if (S.uid === user.uid) return;
  S.uid = user.uid; subscribeSession(user.uid);
});
