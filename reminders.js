// Last Man Standing: reminder sender, run by GitHub Actions every 15 minutes
// (.github/workflows/reminders.yml). When the next gameweek's picks close within 2 hours,
// it sends a push notification to every player who is still in and hasn't picked yet.
// Each gameweek is reminded once. Run it by hand with "test" to send a test to everyone
// who has reminders turned on.

const admin = require("firebase-admin");

const WINDOW_MS = 2 * 60 * 60 * 1000;
const ms = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : typeof t === "string" ? Date.parse(t) : NaN);
const ukTime = (t) => new Date(t).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
const ukDay = (t) => new Date(t).toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "long" });

function connect() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  // Copying on a phone can add line breaks, curly quotes or stray text around the key: undo that.
  let t = raw.replace(/^\uFEFF/, "").replace(/[\u201C\u201D\u201E\u2033]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/[\r\n\u2028\u2029]+/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  let sa;
  try { sa = JSON.parse(t); } catch (e) {
    // Describe the problem without printing any of the secret (the log is public).
    const checks = [
      `${raw.length} characters long (a full key is about 2,300)`,
      a < 0 ? "no { found" : "starts with {",
      b < 0 ? "no closing } found" : "ends with }",
      /"private_key"/.test(t) ? "has private_key" : "private_key missing",
      /"client_email"/.test(t) ? "has client_email" : "client_email missing",
    ];
    throw new Error(`The FIREBASE_SERVICE_ACCOUNT secret isn't a complete key file. What it looks like: ${checks.join(", ")}. Copy the whole file again, from the first { to the last }, and update the secret.`);
  }
  if (!sa.private_key || !sa.client_email || !sa.project_id) throw new Error("The FIREBASE_SERVICE_ACCOUNT secret is missing parts of the key (private_key, client_email or project_id). Copy the whole file again and update the secret.");
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
  return admin.firestore();
}

async function send(db, tokens, title, body) {
  if (!tokens.length) return { sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const site = chunk[0].site;
    const webpush = { notification: { title, body, tag: "lms-reminder", renotify: true } };
    if (site) { webpush.notification.icon = new URL("icon-192.png", site).href; webpush.fcmOptions = { link: site }; }
    const data = { title, body, link: site || "" };
    const res = await admin.messaging().sendEachForMulticast({ tokens: chunk.map((t) => t.id), notification: { title, body }, data, webpush: { ...webpush, headers: { Urgency: "high", TTL: "7200" } } });
    res.responses.forEach((r, j) => {
      if (r.success) { sent++; return; }
      failed++;
      const code = r.error && r.error.code;
      // The phone turned notifications off or the app was removed: forget that token.
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        db.doc(`pushTokens/${chunk[j].id}`).delete().catch(() => {});
      } else console.warn("Send failed:", code, r.error && r.error.message);
    });
  }
  return { sent, failed };
}

async function main() {
  const db = connect();
  if (!db) {
    if (process.env.TEST === "true") throw new Error("The FIREBASE_SERVICE_ACCOUNT secret is missing. Add it in GitHub: Settings > Secrets and variables > Actions.");
    console.log("Reminders aren't set up yet: add the FIREBASE_SERVICE_ACCOUNT secret to start sending them.");
    return;
  }
  const tokens = (await db.collection("pushTokens").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  console.log(`${tokens.length} phone(s) have reminders on.`);

  if (process.env.TEST === "true") {
    const r = await send(db, tokens, "Last Man Standing", "Test reminder: notifications are working.");
    console.log(`Test sent to ${r.sent} phone(s), ${r.failed} failed.`);
    return;
  }

  const cfgSnap = await db.doc("config/game").get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  if (cfg.winner) { console.log("The game is over: no reminders."); return; }
  const startGw = Number(cfg.startGw) || 1;
  const now = Date.now();
  const rounds = (await db.collection("rounds").get()).docs.map((d) => d.data())
    .filter((r) => typeof r.gw === "number" && r.gw >= startGw && ms(r.deadline) > now)
    .sort((a, b) => a.gw - b.gw);
  const next = rounds[0];
  if (!next) { console.log("No upcoming gameweek."); return; }
  const left = ms(next.deadline) - now;
  console.log(`Next: Gameweek ${next.gw}, picks close in ${Math.round(left / 60000)} minutes.`);
  if (left > WINDOW_MS) { console.log("More than 2 hours to go: nothing to send yet."); return; }
  if (next.reminded2h) { console.log("Already reminded for this gameweek."); return; }

  const players = (await db.collection("players").get()).docs;
  const alive = new Set(players.filter((d) => d.data().status === "alive").map((d) => d.id));
  const picked = new Set((await db.collection(`rounds/${next.gw}/picks`).get()).docs.map((d) => d.id));
  const missing = new Set([...alive].filter((id) => !picked.has(id)));
  const targets = tokens.filter((t) => missing.has(t.playerId));
  const body = `Picks for Gameweek ${next.gw} close at ${ukTime(ms(next.deadline))} ${ukDay(ms(next.deadline))}. You haven't picked yet.`;
  const r = await send(db, targets, "Last Man Standing: 2 hours to go", body);
  await db.doc(`rounds/${next.gw}`).set({ reminded2h: true, remindedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  console.log(`${missing.size} player(s) still to pick. Reminder sent to ${r.sent} phone(s), ${r.failed} failed.`);
}

main().catch((e) => { console.error("::error::", e.message || e); process.exit(1); });
