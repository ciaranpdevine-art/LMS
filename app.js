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
  getFunctions, httpsCallable,
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
  bar.innerHTML = `<p><b>Preview mode.</b> The players, fixtures and results are samples, and nothing you do leaves this phone. To join, use code <b>DEMO-0001</b> with any nickname. Once you've used it, it only works with that same nickname. The organiser passcode is <b>demo</b>.</p><button class="btn small ghost" type="button" id="resetPreview">Start again</button>`;
  document.querySelector(".wrap").prepend(bar);
  $("#resetPreview").onclick = () => F.resetPreview();
  // Stop the phone autofilling a saved password into the preview passcode box.
  const pass = $("#orgPass");
  pass.type = "text"; pass.autocomplete = "off"; pass.setAttribute("autocapitalize", "none"); pass.value = "demo";
}
const call = (name) => httpsCallable(fns, name);

const S = {
  uid: null, session: null, config: null, sync: null,
  players: {}, rounds: [], codes: {},
  picksByGw: {},      // gw -> {playerId: {team, teamName}} for rounds past their deadline
  myOpenPick: null,   // {gw, team, teamName} for the open round
  loaded: { config: false, players: false, rounds: false, session: false },
  view: "game", editingGw: null, lastShare: null,
};
const subs = { picks: {}, myPick: null, myPickGw: null, codes: null, session: null };

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
  onSnapshot(doc(db, "config", "sync"), (s) => { S.sync = s.exists() ? s.data() : null; renderOrg(); }, () => {});
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
function subscribeSession(uid) {
  if (subs.session) subs.session();
  subs.session = onSnapshot(doc(db, "sessions", uid), (s) => {
    S.session = s.exists() ? s.data() : {};
    S.loaded.session = true;
    if (S.session.admin && !subs.codes) {
      subs.codes = onSnapshot(collection(db, "codes"), (c) => { const o = {}; c.forEach((d) => (o[d.id] = d.data())); S.codes = o; renderOrg(); }, () => {});
    }
    syncPickSubs(); render();
  }, () => { S.session = {}; S.loaded.session = true; render(); });
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
  $("#signOutBtn").hidden = !(S.session?.playerId || S.session?.admin);
  const p = me();
  $("#whoBtn").hidden = !p;
  if (p) $("#whoBtn").textContent = p.nickname;
  if (inOrg) { $("#joinPanel").hidden = true; $("#gameArea").hidden = true; renderOrg(); return; }
  if (!p) { $("#joinPanel").hidden = false; $("#gameArea").hidden = true; return; }
  $("#joinPanel").hidden = true; $("#gameArea").hidden = false;
  renderStatus(); renderRound(); renderTable();
}

function renderBoard() {
  const c = cfg(), n = countedPlayers().length, alive = countedPlayers().filter(([, p]) => p.status === "alive").length;
  $("#season").textContent = c.season ? `Premier League survivor game · ${c.season}` : "Premier League survivor game";
  $("#sLeft").textContent = n ? `${alive}/${n}` : "0";
  $("#sPot").textContent = "£" + ((Number(c.entryFee) || 0) * n).toLocaleString("en-GB");
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
  const canPick = p.status === "alive" && !cfg().winner;
  const myPick = S.myOpenPick?.gw === o.gw ? S.myOpenPick : null;
  const used = usedTeams(pid, o.gw);
  const k = fmtWhen(o.deadline);
  const say = !canPick ? "You're not picking any more, but here are this week's games."
    : myPick ? `You've gone with <span class="hand">${esc(myPick.teamName || teamName(o, myPick.team))}</span>. Tap another team to change your mind.`
    : "Tap the team you think will win.";
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

/* ---------------------------------------------------------------- organiser */
function renderOrg() {
  if (S.view !== "org" || !ready()) return;
  const isAdmin = !!S.session?.admin;
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
  const sy = S.sync;
  $("#syncInfo").textContent = sy?.at ? `Last update ${fmtWhen(sy.at).day}, ${fmtWhen(sy.at).time}${sy.fixtures?.error ? " · feed error, see below" : ""}` : "No update has run yet.";
  if (sy?.fixtures?.error && !$("#syncMsg").textContent) { $("#syncMsg").className = "msg err"; $("#syncMsg").textContent = `Results feed problem: ${sy.fixtures.error}`; }

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
function renderRoundAdmin() {
  const el = $("#roundAdmin"), rs = rounds();
  if (!rs.length) { el.innerHTML = `<div class="empty">No fixtures loaded yet. Check your settings, then tap Update now.</div>`; return; }
  const now = Date.now();
  el.innerHTML = `<div class="list">${rs.map((r) => {
    const fx = r.fixtures || [], fin = fx.filter((f) => ["finished", "postponed"].includes(effStatus(f, ms(r.deadline)))).length;
    const picks = S.picksByGw[r.gw] ? Object.keys(S.picksByGw[r.gw]).length : null;
    const state = r.processed ? "finished, knock-outs done" : ms(r.deadline) > now ? `picks open until ${fmtWhen(r.deadline).day} ${fmtWhen(r.deadline).time}` : `${fin}/${fx.length} results in`;
    return `<div class="item"><div class="who-l"><b>GW${r.gw}</b><span class="note">${state}${picks != null ? ` · ${picks} picks` : ""}</span></div>${r.processed ? "" : `<button class="btn small ghost" data-edit="${r.gw}">Fix a result</button>`}</div>`;
  }).join("")}</div>`;
  el.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => editRound(Number(b.dataset.edit))));
}
function editRound(gw) {
  S.editingGw = gw;
  const r = S.rounds.find((x) => x.gw === gw), el = $("#roundAdmin");
  el.innerHTML = `<h3>GW${gw} results</h3><p class="note">Only change a result if the feed has it wrong. Your changes won't be overwritten.</p><div class="list">${(r.fixtures || []).map((f, i) => `
    <div class="item"><div class="who-l"><b>${esc(f.homeName)} v ${esc(f.awayName)}</b>${f.manual ? '<span class="note">set by you</span>' : ""}</div>
    <div class="row" style="align-items:center"><input class="score" id="hg${i}" type="number" min="0" value="${f.hg ?? ""}" aria-label="${esc(f.homeName)} goals"><input class="score" id="ag${i}" type="number" min="0" value="${f.ag ?? ""}" aria-label="${esc(f.awayName)} goals">
    <select id="st${i}" style="width:auto"><option value="scheduled">Not played</option><option value="live">Live</option><option value="finished">Full time</option><option value="postponed">Postponed</option></select></div></div>`).join("")}</div>
    <div class="row" style="margin-top:12px"><button class="btn" id="saveRes" type="button">Save results</button><button class="btn ghost" id="cancelRes" type="button">Cancel</button></div><div class="msg" id="resMsg"></div>`;
  (r.fixtures || []).forEach((f, i) => ($("#st" + i).value = f.status || "scheduled"));
  $("#cancelRes").onclick = () => { S.editingGw = null; renderOrg(); };
  $("#saveRes").onclick = async () => {
    const fixtures = (r.fixtures || []).map((f, i) => {
      const hg = $("#hg" + i).value, ag = $("#ag" + i).value, status = $("#st" + i).value;
      const n = { ...f, hg: hg === "" ? null : Number(hg), ag: ag === "" ? null : Number(ag), status };
      const changed = n.hg !== f.hg || n.ag !== f.ag || n.status !== f.status;
      return changed || f.manual ? { ...n, manual: true } : f;
    });
    if (fixtures.some((f) => f.status === "finished" && (f.hg == null || f.ag == null))) {
      $("#resMsg").className = "msg err"; $("#resMsg").textContent = "Add both scores for every full-time match."; return;
    }
    try { await updateDoc(doc(db, "rounds", String(gw)), { fixtures }); S.editingGw = null; renderOrg(); $("#syncMsg").className = "msg"; $("#syncMsg").textContent = "Saved. Tap Update now to apply any knock-outs straight away."; }
    catch (e) { $("#resMsg").className = "msg err"; $("#resMsg").textContent = "Couldn't save. Check your connection and try again."; }
  };
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
$("#syncBtn").addEventListener("click", async () => {
  const b = $("#syncBtn"), m = $("#syncMsg");
  b.disabled = true; m.className = "msg"; m.textContent = "Updating fixtures and results…";
  try {
    const r = (await call("syncNow")()).data;
    const ko = (r.knockouts?.processed || []).map((x) => (x.winner ? `GW${x.gw} settled, we have a winner` : `GW${x.gw} settled, ${x.out} out`)).join(". ");
    m.className = r.fixtures?.error ? "msg err" : "msg";
    m.textContent = r.fixtures?.error ? `Results feed problem: ${r.fixtures.error}` : `Done. ${r.fixtures.roundsChanged} round${r.fixtures.roundsChanged === 1 ? "" : "s"} updated.${ko ? " " + ko + "." : ""}`;
  } catch (e) { m.className = "msg err"; m.textContent = errText(e, "Update failed. Try again in a minute."); }
  finally { b.disabled = false; }
});

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
