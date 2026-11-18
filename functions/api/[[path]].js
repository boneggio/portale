// Portale Boneggio – API (Cloudflare Pages Functions + D1)
//
// Indirizzi:
//   GET  /api/portale?c=…    le sezioni visibili, in ordine (serve il codice del link o il cookie)
//   POST /api/admin/nuovo-codice  cambia il codice del link da inviare
//   GET  /api/staff?c=…      pagina dello staff (codice separato)
//   GET/POST /api/admin/staff, POST /api/admin/nuovo-codice-staff
//   POST /api/login          { password, codice } -> { token }
//   POST /api/logout
//   GET  /api/admin          (intestazione X-Sessione) tutte le sezioni, anche nascoste
//   POST /api/admin          (intestazione X-Sessione) { sezioni:[...] } salva stato, ordine e testi
//
// Variabili da impostare su Cloudflare (Settings > Variables and Secrets):
//   PASSWORD_ADMIN   la password della console (segreto)
// Il codice a 6 cifre si attiva, disattiva e rigenera dalla console (sezione Sicurezza).
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
  },
  {
    id: "mieliamo",
    nome: "MieliAmo",
    descrizione: "Il miele dei nostri alveari di Boneggio, in vasetti.",
    logo: "/loghi/mieliamo.svg",
    colore: "#8F4E07",
    link: "https://mieliamo-boneggio.pages.dev/",
    console: "https://mieliamo-boneggio.pages.dev/report.html",   // quando ci sarà mieliamo.boneggio.it si cambia qui
    statoIniziale: "nascosto"   // resta nascosta finché non si mette il link con ?c= e la si attiva
  }
];

const STATI = ["attivo", "spento", "arrivo", "nascosto"];
const SESSIONE_GIORNI = 30;
const MAX_TENTATIVI = 10;
const FINESTRA_MIN = 15;

// ------------------------------------------------------------------
export async function onRequest(ctx) {
  try {
    return await gestisci(ctx);
  } catch (e) {
    return json({ errore: (e && e.message) ? e.message : String(e) }, 400);
  }
}

async function gestisci(ctx) {
  const { request, env } = ctx;
  const path = "/" + [].concat(ctx.params.path || []).join("/");
  {
    await preparaDB(env.DB);
    if (path === "/portale" && request.method === "GET") return pubblico(request, env);
    if (path === "/staff" && request.method === "GET") return paginaStaff(request, env);
    if (path === "/login" && request.method === "POST") return login(request, env);
    if (path === "/logout" && request.method === "POST") return logout(request, env);
    if (path === "/admin") {
      const ok = await sessioneValida(request, env);
      if (!ok) return json({ errore: "Accesso scaduto: entra di nuovo." }, 401);
      if (request.method === "GET") return json({ sezioni: await leggiSezioni(env.DB, true), codice: await codiceAccesso(env.DB), versione: (await leggiImp(env.DB, "versione")) || "0" });
      if (request.method === "POST") return salva(request, env);
    }
    if (path.startsWith("/admin/2fa/")) {
      if (!(await sessioneValida(request, env))) return json({ errore: "Accesso scaduto: entra di nuovo." }, 401);
      return dueFattori(path.slice(11), request, env);
    }
    if (path === "/admin/staff" || path === "/admin/nuovo-codice-staff") {
      if (!(await sessioneValida(request, env))) return json({ errore: "Accesso scaduto: entra di nuovo." }, 401);
      if (path === "/admin/nuovo-codice-staff" && request.method === "POST") {
        const codice = casuale(6);
        await scriviImp(env.DB, "codice_staff", codice);
        return json({ codice });
      }
      if (request.method === "GET") return json(await staffAdmin(env.DB));
      if (request.method === "POST") return salvaStaff(request, env);
    }
    if (path === "/admin/nuovo-codice" && request.method === "POST") {
      if (!(await sessioneValida(request, env))) return json({ errore: "Accesso scaduto: entra di nuovo." }, 401);
      const codice = casuale(6);
      await env.DB.prepare("INSERT INTO impostazioni (k, v) VALUES ('codice', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1").bind(codice).run();
      return json({ codice });
    }
    return json({ errore: "Indirizzo non trovato" }, 404);
  }
}

// ------------------------------------------------------------------
async function preparaDB(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS sezioni (id TEXT PRIMARY KEY, ordine INTEGER, stato TEXT, nome TEXT, descrizione TEXT, link TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sessioni (token TEXT PRIMARY KEY, scade INTEGER)"),
    db.prepare("CREATE TABLE IF NOT EXISTS tentativi (ip TEXT, ts INTEGER)"),
    db.prepare("CREATE TABLE IF NOT EXISTS impostazioni (k TEXT PRIMARY KEY, v TEXT)")
  ]);
  try { await db.prepare("ALTER TABLE sezioni ADD COLUMN pulsante TEXT").run(); } catch (e) { /* colonna già presente */ }
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
      pulsante: r.pulsante || "Prenota",
      logo: s.logo,
      colore: s.colore,
      console: s.console,
      stato: STATI.includes(r.stato) ? r.stato : (s.statoIniziale || "attivo"),
      ordine: Number.isInteger(r.ordine) ? r.ordine : 1000 + i
    };
  }).sort((a, b) => a.ordine - b.ordine);
  if (admin) return elenco;
  // pubblico: niente nascoste, niente link console, link solo se attiva
  return elenco.filter(s => s.stato !== "nascosto").map(s => ({
    id: s.id, nome: s.nome, descrizione: s.descrizione, pulsante: s.pulsante, logo: s.logo, colore: s.colore, stato: s.stato,
    link: s.stato === "attivo" ? s.link : null
  }));
}

// Codice del link da inviare (portale.boneggio.it/?c=CODICE). Si crea da solo la prima volta.
async function codiceAccesso(db) {
  const r = await db.prepare("SELECT v FROM impostazioni WHERE k = 'codice'").first();
  if (r && r.v) return r.v;
  const codice = casuale(6);
  await db.prepare("INSERT OR IGNORE INTO impostazioni (k, v) VALUES ('codice', ?)").bind(codice).run();
  return (await db.prepare("SELECT v FROM impostazioni WHERE k = 'codice'").first()).v;
}

function leggiCookie(request, nome) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + nome + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

async function pubblico(request, env) {
  const codice = await codiceAccesso(env.DB);
  const dalLink = new URL(request.url).searchParams.get("c") || "";
  const dalCookie = leggiCookie(request, "portale_c");
  const ok = (dalLink && await uguali(dalLink, codice)) || (dalCookie && await uguali(dalCookie, codice));
  if (!ok) return json({ riservato: true }, 403);
  const extra = {};
  if (dalLink) extra["Set-Cookie"] = "portale_c=" + encodeURIComponent(codice) + "; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax";
  const sezioni = await leggiSezioni(env.DB, false);
  return json({ sezioni }, 200, extra);
}

async function salva(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body.sezioni)) return json({ errore: "Dati mancanti" }, 400);
  const versione = (await leggiImp(env.DB, "versione")) || "0";
  if (String(body.versione ?? "") !== versione) {
    return json({ errore: "Nel frattempo qualcuno ha salvato da un altro dispositivo. Ricarica la pagina e rifai la modifica.", conflitto: true }, 409);
  }
  const noti = new Set(SEZIONI.map(s => s.id));
  const stmts = [];
  body.sezioni.forEach((s, i) => {
    if (!noti.has(s.id)) return;
    const stato = STATI.includes(s.stato) ? s.stato : "attivo";
    const link = String(s.link || "").trim();
    if (link && !/^https:\/\//i.test(link)) throw new Error("Il link di " + s.id + " deve iniziare con https://");
    stmts.push(env.DB.prepare(
      "INSERT INTO sezioni (id, ordine, stato, nome, descrizione, link, pulsante) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
      "ON CONFLICT(id) DO UPDATE SET ordine=?2, stato=?3, nome=?4, descrizione=?5, link=?6, pulsante=?7"
    ).bind(s.id, i, stato, String(s.nome || "").slice(0, 80), String(s.descrizione || "").slice(0, 300), link.slice(0, 500), String(s.pulsante || "").trim().slice(0, 30)));
  });
  const nuova = String(Date.now());
  stmts.push(env.DB.prepare("INSERT INTO impostazioni (k, v) VALUES ('versione', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1").bind(nuova));
  await env.DB.batch(stmts);
  return json({ ok: true, sezioni: await leggiSezioni(env.DB, true), versione: nuova });
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
  const segreto = await leggiImp(db, "totp");
  let ok = await uguali(String(body.password || ""), env.PASSWORD_ADMIN);
  if (ok && segreto) {
    const codice = String(body.codice || "").replace(/[\s-]/g, "");
    ok = (await verificaTotp(segreto, codice)) || (await usaCodiceEmergenza(db, codice));
  }
  if (!ok) {
    await db.prepare("INSERT INTO tentativi (ip, ts) VALUES (?, ?)").bind(ip, ora).run();
    return json({ errore: segreto ? "Password o codice non corretti." : "Password non corretta." }, 401);
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
// PAGINA DELLO STAFF (portale.boneggio.it/staff?c=CODICE)
// Gruppi (es. "Amo", "Jacopo") con i link di lavoro. Tutto nel database:
// i link personali non stanno nel codice, che è pubblico su GitHub.
const APP_STAFF = {
  oviamo:       { nome: "OviAmo",       logo: "/loghi/oviamo.svg",       colore: "#3f6b2a" },
  oliamo:       { nome: "OliAmo",       logo: "/loghi/oliamo.svg",       colore: "#3D7A0E" },
  castagnacopo: { nome: "Castagnacopo", logo: "/loghi/castagnacopo.svg", colore: "#7b3f1d" },
  mieliamo:     { nome: "MieliAmo",     logo: "/loghi/mieliamo.svg",     colore: "#8F4E07" },
  casalaggiu:   { nome: "Casalaggiù",   logo: "/loghi/casalaggiu.svg",   colore: "#0f7b77" },
  altro:        { nome: "Boneggio",     logo: "/img/icona.svg",          colore: "#7a2a22" }
};

async function codiceStaff(db) {
  let c = await leggiImp(db, "codice_staff");
  if (!c) { c = casuale(6); await scriviImp(db, "codice_staff", c); }
  return c;
}
async function leggiStaff(db) {
  try { const d = JSON.parse((await leggiImp(db, "staff")) || "null"); if (d && Array.isArray(d.gruppi)) return d; } catch (e) {}
  return { gruppi: [{ nome: "Amo", voci: [] }, { nome: "Jacopo", voci: [] }] };
}
async function staffAdmin(db) {
  return { staff: await leggiStaff(db), codice: await codiceStaff(db), versione: (await leggiImp(db, "versione_staff")) || "0", app: APP_STAFF };
}
function pulisciStaff(d) {
  const t = (v, n) => String(v ?? "").trim().slice(0, n);
  const gruppi = (Array.isArray(d && d.gruppi) ? d.gruppi : []).slice(0, 20).map(g => ({
    nome: t(g.nome, 40) || "Gruppo",
    voci: (Array.isArray(g.voci) ? g.voci : []).slice(0, 40).map(v => {
      const link = t(v.link, 500);
      if (link && !/^https:\/\//i.test(link)) throw new Error("Il link «" + t(v.titolo, 40) + "» deve iniziare con https://");
      return { app: APP_STAFF[v.app] ? v.app : "altro", titolo: t(v.titolo, 80), descrizione: t(v.descrizione, 300), link, pulsante: t(v.pulsante, 30), visibile: v.visibile !== false };
    })
  }));
  return { gruppi };
}
async function salvaStaff(request, env) {
  const body = await request.json().catch(() => ({}));
  const versione = (await leggiImp(env.DB, "versione_staff")) || "0";
  if (String(body.versione ?? "") !== versione) return json({ errore: "Nel frattempo qualcuno ha salvato da un altro dispositivo. Ricarica la pagina e rifai la modifica.", conflitto: true }, 409);
  const pulito = pulisciStaff(body.staff);
  const nuova = String(Date.now());
  await scriviImp(env.DB, "staff", JSON.stringify(pulito));
  await scriviImp(env.DB, "versione_staff", nuova);
  return json({ ok: true, staff: pulito, versione: nuova });
}
async function paginaStaff(request, env) {
  const codice = await codiceStaff(env.DB);
  const dalLink = new URL(request.url).searchParams.get("c") || "";
  const dalCookie = leggiCookie(request, "staff_c");
  const ok = (dalLink && await uguali(dalLink, codice)) || (dalCookie && await uguali(dalCookie, codice));
  if (!ok) return json({ riservato: true }, 403);
  const extra = {};
  if (dalLink) extra["Set-Cookie"] = "staff_c=" + encodeURIComponent(codice) + "; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax";
  const d = await leggiStaff(env.DB);
  const gruppi = d.gruppi.map(g => ({
    nome: g.nome,
    voci: g.voci.filter(v => v.visibile && v.link).map(v => ({ ...v, logo: APP_STAFF[v.app].logo, colore: APP_STAFF[v.app].colore, appNome: APP_STAFF[v.app].nome }))
  })).filter(g => g.voci.length);
  return json({ gruppi }, 200, extra);
}

// ------------------------------------------------------------------
// Verifica in due passaggi gestita dalla console
async function leggiImp(db, k) {
  const r = await db.prepare("SELECT v FROM impostazioni WHERE k = ?").bind(k).first();
  return r ? r.v : "";
}
async function scriviImp(db, k, v) {
  if (v === null) return db.prepare("DELETE FROM impostazioni WHERE k = ?").bind(k).run();
  return db.prepare("INSERT INTO impostazioni (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2").bind(k, v).run();
}
async function sha(t) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function usaCodiceEmergenza(db, codice) {
  if (!/^[0-9a-f]{10}$/i.test(codice)) return false;
  const lista = JSON.parse((await leggiImp(db, "recupero")) || "[]");
  const h = await sha(codice.toLowerCase());
  const i = lista.indexOf(h);
  if (i < 0) return false;
  lista.splice(i, 1);
  await scriviImp(db, "recupero", JSON.stringify(lista));
  return true;
}
function nuovoSegreto() {
  const alfa = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const b = new Uint8Array(20); crypto.getRandomValues(b);
  let bits = 0, val = 0, out = "";
  for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += alfa[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  return out;
}
async function dueFattori(azione, request, env) {
  const db = env.DB;
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  const codice = String(body.codice || "").replace(/\s/g, "");
  const attivo = !!(await leggiImp(db, "totp"));
  if (azione === "stato") {
    const rec = JSON.parse((await leggiImp(db, "recupero")) || "[]");
    return json({ attivo, codiciEmergenza: rec.length });
  }
  if (azione === "prepara") {
    // per rigenerare serve il codice attuale
    if (attivo && !(await verificaTotp(await leggiImp(db, "totp"), codice))) return json({ errore: "Codice attuale non corretto." }, 400);
    const segreto = nuovoSegreto();
    await scriviImp(db, "totp_nuovo", segreto);
    const uri = "otpauth://totp/" + encodeURIComponent("Portale Boneggio") + ":admin?secret=" + segreto + "&issuer=" + encodeURIComponent("Portale Boneggio");
    return json({ segreto, uri });
  }
  if (azione === "conferma") {
    const nuovo = await leggiImp(db, "totp_nuovo");
    if (!nuovo) return json({ errore: "Premi di nuovo Attiva." }, 400);
    if (!(await verificaTotp(nuovo, codice))) return json({ errore: "Il codice non corrisponde: controlla l'ora del telefono e riprova." }, 400);
    const codici = [], hash = [];
    for (let i = 0; i < 8; i++) { const c = casuale(5); codici.push(c); hash.push(await sha(c)); }
    await scriviImp(db, "totp", nuovo);
    await scriviImp(db, "totp_nuovo", null);
    await scriviImp(db, "recupero", JSON.stringify(hash));
    return json({ ok: true, codiciEmergenza: codici });
  }
  if (azione === "disattiva") {
    if (!attivo) return json({ ok: true });
    if (!(await verificaTotp(await leggiImp(db, "totp"), codice))) return json({ errore: "Codice non corretto." }, 400);
    await scriviImp(db, "totp", null);
    await scriviImp(db, "recupero", null);
    return json({ ok: true });
  }
  return json({ errore: "Azione sconosciuta" }, 404);
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
