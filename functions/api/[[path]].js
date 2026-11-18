// Portale Boneggio – API (Cloudflare Pages Functions + D1)
//
// Indirizzi:
//   GET  /api/portale        pubblico: le sezioni visibili, in ordine
//   POST /api/login          { password, codice } -> { token }
//   POST /api/logout
//   GET  /api/admin          (intestazione X-Sessione) tutte le sezioni, anche nascoste
//   POST /api/admin          (intestazione X-Sessione) { sezioni:[...] } salva stato, ordine e testi
//
// Variabili da impostare su Cloudflare (Settings > Variables and Secrets):
//   PASSWORD_ADMIN   la password della console (segreto)
//   TOTP_SECRET      facoltativo: segreto base32 per il codice a 6 cifre (segreto)
// Database D1 collegato con il nome DB.

// ------------------------------------------------------------------
// ELENCO DELLE SEZIONI (valori iniziali).
// Per aggiungere una nuova app: un nuovo blocco qui + il suo logo in /loghi.
// Nome, descrizione e link si possono poi cambiare dalla console.
// ------------------------------------------------------------------
const SEZIONI = [
  {
    id: "casalaggiu",
    nome: "Casalaggiù",
    descrizione: "Casa vacanze a Cutrofiano, nel Salento. Scegli le date e prenota direttamente.",
    logo: "/loghi/casalaggiu.svg",
    colore: "#0f7b77",
    link: "https://casalaggiu.it/#prenota",
    console: "https://casalaggiu.it/admin.html"
  },
  {
    id: "oviamo",
    nome: "OviAmo",
    descrizione: "Uova fresche delle nostre galline, singole o in confezioni da 6.",
    logo: "/loghi/oviamo.svg",
    colore: "#3f6b2a",
    link: "https://oviamo.boneggio.it/",
    console: "https://oviamo.boneggio.it/report.html"
  },
  {
    id: "oliamo",
    nome: "OliAmo",
    descrizione: "Olio extravergine di Boneggio, in lattine e bottiglie.",
    logo: "/loghi/oliamo.svg",
    colore: "#3D7A0E",
    link: "https://oliamo.boneggio.it/",
    console: "https://oliamo.boneggio.it/report.html"
  },
  {
    id: "castagnacopo",
    nome: "Castagnacopo",
    descrizione: "Castagne di Caprese Michelangelo in sacchi da 1, 2, 3 e 5 kg.",
    logo: "/loghi/castagnacopo.svg",
    colore: "#7b3f1d",
    link: "https://castagnacopo.boneggio.it/",
    console: "https://castagnacopo.boneggio.it/report.html"
  }
];

const STATI = ["attivo", "spento", "arrivo", "nascosto"];
const SESSIONE_GIORNI = 30;
const MAX_TENTATIVI = 10;
const FINESTRA_MIN = 15;

// ------------------------------------------------------------------
export async function onRequest(ctx) {
  const { request, env } = ctx;
  const path = "/" + [].concat(ctx.params.path || []).join("/");
  try {
    await preparaDB(env.DB);
    if (path === "/portale" && request.method === "GET") return pubblico(env);
    if (path === "/login" && request.method === "POST") return login(request, env);
    if (path === "/logout" && request.method === "POST") return logout(request, env);
    if (path === "/admin") {
      const ok = await sessioneValida(request, env);
      if (!ok) return json({ errore: "Accesso scaduto: entra di nuovo." }, 401);
      if (request.method === "GET") return json({ sezioni: await leggiSezioni(env.DB, true) });
      if (request.method === "POST") return salva(request, env);
    }
    return json({ errore: "Indirizzo non trovato" }, 404);
  } catch (e) {
    return json({ errore: "Errore del server: " + (e && e.message ? e.message : e) }, 500);
  }
}

// ------------------------------------------------------------------
async function preparaDB(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS sezioni (id TEXT PRIMARY KEY, ordine INTEGER, stato TEXT, nome TEXT, descrizione TEXT, link TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sessioni (token TEXT PRIMARY KEY, scade INTEGER)"),
    db.prepare("CREATE TABLE IF NOT EXISTS tentativi (ip TEXT, ts INTEGER)")
  ]);
}

async function leggiSezioni(db, admin) {
  const { results } = await db.prepare("SELECT * FROM sezioni").all();
  const salvate = Object.fromEntries((results || []).map(r => [r.id, r]));
  const elenco = SEZIONI.map((s, i) => {
    const r = salvate[s.id] || {};
    return {
      id: s.id,
      nome: r.nome || s.nome,
      descrizione: r.descrizione || s.descrizione,
      link: r.link || s.link,
      logo: s.logo,
      colore: s.colore,
      console: s.console,
      stato: STATI.includes(r.stato) ? r.stato : "attivo",
      ordine: Number.isInteger(r.ordine) ? r.ordine : 1000 + i
    };
  }).sort((a, b) => a.ordine - b.ordine);
  if (admin) return elenco;
  // pubblico: niente nascoste, niente link console, link solo se attiva
  return elenco.filter(s => s.stato !== "nascosto").map(s => ({
    id: s.id, nome: s.nome, descrizione: s.descrizione, logo: s.logo, colore: s.colore, stato: s.stato,
    link: s.stato === "attivo" ? s.link : null
  }));
}

async function pubblico(env) {
  const sezioni = await leggiSezioni(env.DB, false);
  return json({ sezioni }, 200, { "Cache-Control": "no-store" });
}

async function salva(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body.sezioni)) return json({ errore: "Dati mancanti" }, 400);
  const noti = new Set(SEZIONI.map(s => s.id));
  const stmts = [];
  body.sezioni.forEach((s, i) => {
    if (!noti.has(s.id)) return;
    const stato = STATI.includes(s.stato) ? s.stato : "attivo";
    const link = String(s.link || "").trim();
    if (link && !/^https:\/\//i.test(link)) throw new Error("Il link di " + s.id + " deve iniziare con https://");
    stmts.push(env.DB.prepare(
      "INSERT INTO sezioni (id, ordine, stato, nome, descrizione, link) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
      "ON CONFLICT(id) DO UPDATE SET ordine=?2, stato=?3, nome=?4, descrizione=?5, link=?6"
    ).bind(s.id, i, stato, String(s.nome || "").slice(0, 80), String(s.descrizione || "").slice(0, 300), link.slice(0, 500)));
  });
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, sezioni: await leggiSezioni(env.DB, true) });
}

// ------------------------------------------------------------------
// Accesso: password + (se impostato) codice a 6 cifre, blocco dopo 10 errori in 15 minuti
async function login(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const ora = Date.now();
  const db = env.DB;
  await db.prepare("DELETE FROM tentativi WHERE ts < ?").bind(ora - FINESTRA_MIN * 60000).run();
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM tentativi WHERE ip = ?").bind(ip).first();
  if (n >= MAX_TENTATIVI) return json({ errore: "Troppi tentativi sbagliati. Riprova tra 15 minuti." }, 429);

  if (!env.PASSWORD_ADMIN) return json({ errore: "Password non ancora impostata su Cloudflare (PASSWORD_ADMIN)." }, 500);
  const body = await request.json().catch(() => ({}));
  let ok = await uguali(String(body.password || ""), env.PASSWORD_ADMIN);
  if (ok && env.TOTP_SECRET) ok = await verificaTotp(env.TOTP_SECRET, String(body.codice || "").replace(/\s/g, ""));
  if (!ok) {
    await db.prepare("INSERT INTO tentativi (ip, ts) VALUES (?, ?)").bind(ip, ora).run();
    return json({ errore: env.TOTP_SECRET ? "Password o codice non corretti." : "Password non corretta." }, 401);
  }
  const token = casuale(32);
  await db.prepare("DELETE FROM sessioni WHERE scade < ?").bind(ora).run();
  await db.prepare("INSERT INTO sessioni (token, scade) VALUES (?, ?)").bind(token, ora + SESSIONE_GIORNI * 86400000).run();
  return json({ token, giorni: SESSIONE_GIORNI });
}

async function logout(request, env) {
  const t = request.headers.get("X-Sessione");
  if (t) await env.DB.prepare("DELETE FROM sessioni WHERE token = ?").bind(t).run();
  return json({ ok: true });
}

async function sessioneValida(request, env) {
  const t = request.headers.get("X-Sessione");
  if (!t) return false;
  const r = await env.DB.prepare("SELECT scade FROM sessioni WHERE token = ?").bind(t).first();
  return !!(r && r.scade > Date.now());
}

// ------------------------------------------------------------------
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra }
  });
}

function casuale(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function uguali(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function base32(s) {
  const alfa = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, val = 0;
  const out = [];
  for (const ch of clean) {
    val = (val << 5) | alfa.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function verificaTotp(segreto, codice) {
  if (!/^\d{6}$/.test(codice)) return false;
  const key = await crypto.subtle.importKey("raw", base32(segreto), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const passo = Math.floor(Date.now() / 30000);
  for (const d of [-1, 0, 1]) {
    const c = passo + d;
    const buf = new ArrayBuffer(8);
    const v = new DataView(buf);
    v.setUint32(0, Math.floor(c / 2 ** 32));
    v.setUint32(4, c >>> 0);
    const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
    const o = h[h.length - 1] & 15;
    const num = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000;
    if (String(num).padStart(6, "0") === codice) return true;
  }
  return false;
}
