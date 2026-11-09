// TBSA-Serveur 3.0 : serveur multimédia (films, séries, IPTV Xtream/M3U), sans dépendance.
// Lancer : node server.js  (Node 18+)  →  http://localhost:8585  (8585 par défaut ; le port 32400 est celui de Plex)
'use strict';
const os = require('os'), crypto = require('crypto'), http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const { spawn, spawnSync, execFile } = require('child_process');
const FORCED_PORT = !!process.env.PORT; let PORT = +process.env.PORT || 8585; const VERSION = '3.5.6', STARTED = Date.now();
const BASE = process.pkg ? path.dirname(process.execPath) : __dirname;
function writable(d) { try { fs.mkdirSync(d, { recursive: true }); const t = path.join(d, '.w' + process.pid); fs.writeFileSync(t, '1'); fs.unlinkSync(t); return true; } catch { return false; } }
function copyDir(a, b) { fs.mkdirSync(b, { recursive: true }); for (const e of fs.readdirSync(a, { withFileTypes: true })) { const x = path.join(a, e.name), y = path.join(b, e.name); if (e.isDirectory()) copyDir(x, y); else fs.copyFileSync(x, y); } }
let DATA_NOTE = '';
function pickDataDir() {
  if (process.env.TBSA_DATA && writable(process.env.TBSA_DATA)) return process.env.TBSA_DATA;
  const legacy = path.join(BASE, 'data');
  // Windows : dossier stable de l'utilisateur (%APPDATA%\TBSA-Serveur), identique que l'on lance le .exe, le .bat ou node
  const stable = process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'TBSA-Serveur') : legacy;
  if (stable !== legacy && writable(stable)) {
    try {   // reprise des réglages des anciennes versions (dossier data à côté du programme)
      if (!fs.existsSync(path.join(stable, 'config.json')) && fs.existsSync(path.join(legacy, 'config.json'))) {
        for (const f of fs.readdirSync(legacy)) if (/\.json(\.bak)?$/.test(f)) fs.copyFileSync(path.join(legacy, f), path.join(stable, f));
        if (fs.existsSync(path.join(legacy, 'custom'))) copyDir(path.join(legacy, 'custom'), path.join(stable, 'custom'));
        DATA_NOTE = 'Réglages repris depuis ' + legacy;
      }
    } catch {}
    return stable;
  }
  if (writable(legacy)) return legacy;
  const home = path.join(os.homedir(), '.tbsa-serveur'); if (writable(home)) { DATA_NOTE = 'Dossier du programme non inscriptible : données dans ' + home; return home; }
  return legacy;
}
const DATA = pickDataDir(), IMGC = path.join(DATA, 'imgcache'), SUBC = path.join(DATA, 'subcache');
[DATA, IMGC, SUBC].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch {} });
const asset = rel => { for (const d of process.pkg ? [path.dirname(process.execPath), __dirname] : [__dirname]) { const f = path.join(d, rel); if (fs.existsSync(f)) return f; } return path.join(__dirname, rel); };
let SRV = null;
// Application Android (stick TV) : placer TBSA-Serveur.apk à côté du programme ; le stick la télécharge via http://IP:port/apk
const apkPath = () => { for (const d of [path.dirname(process.execPath), BASE, DATA, __dirname]) { const f = path.join(d, 'TBSA-Serveur.apk'); if (fs.existsSync(f)) return f; } return null; };
function waitKey(msg) { if (process.env.TBSA_HIDDEN) { console.log(msg); return setTimeout(() => process.exit(1), 300); } console.log('\n' + msg + '\n\nAppuyez sur Entrée pour fermer cette fenêtre…'); process.stdin.resume(); process.stdin.once('data', () => process.exit(1)); setTimeout(() => process.exit(1), 600000); }
function onFatal(e) {
  if (e && e.code === 'EADDRINUSE') {
    fetch('http://localhost:' + PORT + '/api/ping', { signal: AbortSignal.timeout(2500) }).then(r => r.json()).then(j => {
      if (j && j.name === 'TBSA-Serveur') { console.log('TBSA-Serveur est déjà lancé : ouverture de http://localhost:' + PORT); if (process.platform === 'win32') require('child_process').exec('start http://localhost:' + PORT); setTimeout(() => process.exit(0), 1500); }
      else waitKey('Le port ' + PORT + ' est utilisé par un autre programme. Fermez-le ou lancez TBSA-Serveur avec un autre port (variable PORT).');
    }).catch(() => waitKey('Le port ' + PORT + ' est déjà utilisé par un autre programme.'));
  } else waitKey('Erreur au démarrage de TBSA-Serveur : ' + (e && (e.stack || e.message) || e));
}
process.on('uncaughtException', e => { try { console.log('Erreur : ' + (e && e.stack || e)); } catch {} if (!SRV || !SRV.listening) onFatal(e); });
process.on('unhandledRejection', e => { try { console.log('Erreur (promesse) : ' + (e && e.message || e)); } catch {} });
const rid = () => crypto.randomBytes(6).toString('hex');
const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex');
const LOGS = [];
const log = m => { const l = new Date().toLocaleTimeString('fr-FR') + '  ' + m; LOGS.push(l); if (LOGS.length > 300) LOGS.shift(); console.log(l); };

/* ---------- Stockage JSON : écriture atomique, copie de secours (.bak), réglages enregistrés immédiatement ---------- */
const load = (f, d) => { for (const n of [f, f + '.bak']) { try { return JSON.parse(fs.readFileSync(path.join(DATA, n), 'utf8')); } catch {} } return d; };
let WRITE_ERR = '';
function writeJson(f, o) {
  try {
    const p = path.join(DATA, f), t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(o));
    try { if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak'); } catch {}
    fs.renameSync(t, p); WRITE_ERR = ''; return true;
  } catch (e) { WRITE_ERR = e.message; console.log('Écriture impossible : ' + f + ' (' + e.message + ')'); return false; }
}
const IMMEDIATE = new Set(['config.json', 'users.json', 'overrides.json', 'categories.json']), pend = {};
const flush = () => { for (const f in pend) { writeJson(f, pend[f]); delete pend[f]; } };
const save = (f, o) => { if (IMMEDIATE.has(f)) { delete pend[f]; return writeJson(f, o); } pend[f] = o; clearTimeout(save.t); save.t = setTimeout(flush, 400); };
process.on('exit', flush);
['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach(sg => { try { process.on(sg, () => { flush(); process.exit(0); }); } catch {} });

/* ---------- Configuration ---------- */
let cfg = Object.assign({ serverName: 'TBSA-Serveur', libraries: [], xtream: null, m3u: '', tmdb: '', scanMinutes: 10, sagaMin: 2 }, load('config.json', {}));
cfg.transcoder = Object.assign({ hw: 'none', preset: 'veryfast', maxSessions: 3 }, cfg.transcoder || {});
cfg.libraries = (cfg.libraries || []).map(l => ({ ...l, uid: l.uid || rid(), paths: l.paths || (l.path ? [l.path] : []), language: l.language || 'fr-FR' }));
const saveCfg = () => save('config.json', cfg);
saveCfg();

/* ---------- Utilisateurs, sessions, PIN ---------- */
let U = load('users.json', null);
if (!U || !U.users || !U.users.length) U = { users: [{ id: rid(), name: 'Admin', pin: '', admin: true, kid: false, libs: null, iptv: true }], sessions: {} };
U.sessions = U.sessions || {};
const saveU = () => save('users.json', U); saveU();
const hashPin = (pin, salt = rid()) => salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
const checkPin = (pin, h) => { if (!h) return true; const salt = h.split(':')[0], a = Buffer.from(hashPin(pin, salt)), b = Buffer.from(h); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const cookie = (req, n) => { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; };
const userOf = req => { const t = cookie(req, 'tbsa'), s = t && U.sessions[t]; return s ? (U.users.find(u => u.id === s.uid) || null) : null; };
const pubUser = u => ({ id: u.id, name: u.name, kid: !!u.kid, admin: !!u.admin, pin: !!u.pin });
const FAIL = {};
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');

/* ---------- État par utilisateur (progression, listes, favoris) ---------- */
let ST = load('state.json', {}), HIST = load('hist.json', []);
const stOf = u => { const s = ST[u.id] || (ST[u.id] = {}); s.progress = s.progress || {}; s.lists = s.lists || [{ id: 'fav', name: 'Ma liste', items: [] }]; s.favCh = s.favCh || []; s.rates = s.rates || {}; return s; };
const SES = {};   // lectures en cours (battements envoyés par les lecteurs)

/* ---------- Métadonnées, catégories ---------- */
let meta = load('meta.json', {}), cats = load('categories.json', { list: [], map: {} }), OV = load('overrides.json', {}), THEMES = load('themes.json', {}); if (THEMES.__v !== 2) THEMES = { __v: 2 };
const CUST = path.join(DATA, 'custom'); fs.mkdirSync(CUST, { recursive: true });
const itemKey = i => i.type === 'shows' ? 's|' + i.show.toLowerCase() : 'm|' + i.file;
const mkey = i => i.type + '|' + (i.type === 'shows' ? i.show : i.title).toLowerCase() + '|' + (i.year || '') + '|' + (i.lang || '');
const mkey0 = null;
const px = (u, sz) => !u ? '' : u.startsWith('/') ? u : '/img?u=' + encodeURIComponent(sz ? u.replace(/\/w(342|500|780|1280)\//, '/' + sz + '/') : u);
const M = i => { const k = mkey(i); return Object.assign({}, meta[k] || {}, OV[k] || {}); };
const imgHosts = () => { const h = new Set(['image.tmdb.org']); Object.values(OV).forEach(o => [o.poster, o.backdrop].forEach(u => { try { if (u && /^https?:/.test(u)) h.add(new URL(u).host); } catch {} })); return h; };

/* ---------- ffmpeg / ffprobe (optionnels) ---------- */
const exeDir = path.dirname(process.execPath);
function findBin(name) {
  const w = name + (process.platform === 'win32' ? '.exe' : '');
  for (const c of [path.join(exeDir, w), path.join(BASE, w), name]) { try { if (spawnSync(c, ['-version'], { timeout: 4000 }).status === 0) return c; } catch {} }
  return null;
}
let FFMPEG = null, FFPROBE = null, ENC = [];
function detectFF() {
  FFMPEG = findBin('ffmpeg'); FFPROBE = findBin('ffprobe'); ENC = [];
  if (FFMPEG) { try { const o = String(spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { timeout: 8000 }).stdout); ENC = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'].filter(e => o.includes(e)); } catch {} }
}
detectFF();
let FFINST = { state: 'idle', msg: '' };
function installFFmpeg() {   // Windows : télécharge ffmpeg + ffprobe à côté de TBSA-Serveur.exe
  if (process.platform !== 'win32') return false;
  if (FFINST.state === 'running') return true;
  FFINST = { state: 'running', msg: 'Téléchargement de ffmpeg (environ 130 Mo), patientez quelques minutes…' };
  const dest = (process.pkg ? exeDir : BASE).replace(/'/g, "''");
  const ps = `$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; ` +
    `$t=Join-Path $env:TEMP 'tbsa-ffmpeg'; if(Test-Path $t){Remove-Item $t -Recurse -Force}; New-Item -ItemType Directory $t | Out-Null; $z=Join-Path $t 'ff.zip'; ` +
    `Invoke-WebRequest -UseBasicParsing 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' -OutFile $z; ` +
    `Expand-Archive $z -DestinationPath $t -Force; $b=(Get-ChildItem $t -Recurse -Filter ffmpeg.exe | Select-Object -First 1).DirectoryName; ` +
    `Copy-Item (Join-Path $b 'ffmpeg.exe') '${dest}' -Force; Copy-Item (Join-Path $b 'ffprobe.exe') '${dest}' -Force; Remove-Item $t -Recurse -Force`;
  let err = ''; const c = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: ['ignore', 'ignore', 'pipe'] });
  c.stderr.on('data', d => err = (err + d).slice(-300));
  c.on('error', e => { FFINST = { state: 'error', msg: e.message }; });
  c.on('close', code => { if (code === 0) { detectFF(); FFINST = { state: FFMPEG ? 'done' : 'error', msg: FFMPEG ? 'ffmpeg installé : tous les formats sont maintenant lisibles.' : 'Installé mais introuvable, relancez TBSA-Serveur.' }; log('ffmpeg ' + FFINST.state); } else { FFINST = { state: 'error', msg: 'Échec du téléchargement : ' + err.trim().slice(-200) }; log(FFINST.msg); } });
  return true;
}

const lanUrls = () => Object.values(os.networkInterfaces()).reduce((a, x) => a.concat(x || []), [])
  .filter(n => (n.family === 'IPv4' || n.family === 4) && !n.internal && !n.address.startsWith('169.254')).map(n => `http://${n.address}:${PORT}`);

/* ---------- Bibliothèques locales ---------- */
const VIDEO = /\.(3g2|3gp|3gpp|amv|asf|avi|dat|divx|dv|evo|f4v|flc|fli|flv|ivf|m1v|m2t|m2ts|m2v|m4v|mjpeg|mjpg|mk3d|mkv|mod|mov|mp4|mpe|mpeg|mpg|mts|mtv|mxf|nsv|nut|ogg|ogv|qt|ra|rm|rmvb|swf|tod|tp|trp|ts|vob|webm|wmv|xvid)$/i;
const AMBIG = /\.(dat|ogg|ra|mod)$/i;   // extensions qui servent aussi à des fichiers non vidéo : ignorés s'ils sont petits (< 8 Mo)
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.m2t': 'video/mp2t', '.mts': 'video/mp2t', '.tp': 'video/mp2t', '.trp': 'video/mp2t', '.3g2': 'video/3gpp2', '.3gpp': 'video/3gpp', '.qt': 'video/quicktime', '.f4v': 'video/mp4', '.rm': 'application/vnd.rn-realmedia', '.rmvb': 'application/vnd.rn-realmedia-vbr', '.swf': 'application/x-shockwave-flash', '.vob': 'video/mpeg', '.dat': 'video/mpeg', '.m1v': 'video/mpeg', '.m2v': 'video/mpeg', '.mpe': 'video/mpeg', '.asf': 'video/x-ms-asf', '.divx': 'video/divx', '.xvid': 'video/avi', '.mxf': 'application/mxf', '.nut': 'video/x-nut', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.3gp': 'video/3gpp', '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
let index = [], byK = new Map(), ARTC = new Map(), scanning = false, SCANSTAT = { running: false, last: 0, ms: 0 };
function walk(dir, out = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (VIDEO.test(e.name)) out.push(p); }
  return out;
}
const clean = n => n.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
/* Séries : le nom de la série vient du dossier (Série/Saison 1/…) sinon du fichier ; plusieurs écritures
   (S01E01, s01e02, 1x03, Saison 1 Épisode 4, "Série - 05"…) sont reconnues et regroupées sous un même nom. */
const TAGS = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?|hdr|web[ .-]?dl|web[ .-]?rip|webrip|blu[ .-]?ray|bdrip|brrip|hdtv|dvdrip|x264|x265|h[ .]?264|h[ .]?265|hevc|avc|xvid|divx|aac|ac3|eac3|dd5[ .]?1|dts|truehd|atmos|multi|vff|vfq|vfi|vf2|vostfr|vost|subfrench|truefrench|french|proper|repack|internal|amzn|dsnp|hmax|atvp|remux|10bit)\b/i;
const cutTags = x => { const m = x.search(TAGS); return m >= 0 ? x.slice(0, m) : x; };
const normName = x => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\b(?:19|20)\d{2}\b$/, '').trim();
const cleanShow = x => clean(cutTags(String(x).replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ').replace(/\((?:19|20)\d{2}\)/g, ' '))).replace(/[\s\-–—:,.]+$/, '').replace(/^[\s\-–—:,.]+/, '').trim();
function parseEp(n) {
  let m;
  if ((m = n.match(/[sS](\d{1,2})[ ._-]*[eE](\d{1,3})(?:[ ._-]*(?:[eE]|-)[ ._-]*\d{1,3})*/))) return { s: +m[1], e: +m[2], i: m.index, len: m[0].length };
  if ((m = n.match(/(?<![\dA-Za-z])(\d{1,2})[xX](\d{2,3})(?!\d)/))) return { s: +m[1], e: +m[2], i: m.index, len: m[0].length };
  if ((m = n.match(/(?:season|saison|staffel|temporada|stagione)[ ._-]*(\d{1,2})[ ._,-]*(?:episode|épisode|episodio|ep|e)[ ._-]*(\d{1,3})/i))) return { s: +m[1], e: +m[2], i: m.index, len: m[0].length };
  if ((m = n.match(/(?:^|[ ._-])(?:episode|épisode|episodio|ep)[ ._-]*(\d{1,3})(?!\d)/i))) return { s: null, e: +m[1], i: m.index, len: m[0].length };
  if ((m = n.match(/[ ._]-[ ._]*(\d{1,3})(?:v\d)?(?=[ ._\[(-]|$)/))) return { s: null, e: +m[1], i: m.index, len: m[0].length };
  if ((m = n.match(/^(\d{1,3})(?=[ ._-])/))) return { s: null, e: +m[1], i: 0, len: m[0].length };
  return null;
}
const epTitle = (n, ep) => clean(cutTags(n.slice(ep.i + ep.len).replace(/\[[^\]]*\]/g, ' '))).replace(/[\[\]()]/g, '').replace(/^[\s\-–—:,.]+|[\s\-–—:,.]+$/g, '').trim();
const SEASON_DIR = /^(?:season|saison|staffel|temporada|stagione|series|s)[ ._-]*0*(\d{1,2})\b/i;
// « Breaking Bad S01 », « Snowfall S04E03 », « Narcos Mexico Saison 2 », « Série (2019) Intégrale » → nom de série + saison
const SEASON_TAG = /(?:^|[\s\-–—:(\[])(s\d{1,2}(?:\s?e\d{1,3})*|\d{1,2}x\d{2,3}|(?:season|saison|staffel|temporada|stagione)\s*\d{1,2}(?:\s*-\s*\d{1,2})?|int[ée]grale|complete|compl[èe]te|collection)(?![a-z0-9])/i;
function splitSeasonTag(name) {
  const m = SEASON_TAG.exec(name); if (!m) return { name: name, season: null };
  const idx = m.index + (m[0].length - m[1].length), n = (m[1].match(/\d+/) || [])[0];
  return { name: name.slice(0, idx).replace(/[\s\-–—:(\[,.]+$/, '').trim(), season: n != null && !/-/.test(m[1]) && !/^\d{1,2}x/i.test(m[1]) ? +n : (/^\d{1,2}x/i.test(m[1]) ? +m[1].split(/x/i)[0] : null) };
}
function parseShowFile(parts, genre, base) {
  let dirs = parts.slice(0, -1); if (genre) dirs = dirs.slice(1);
  let sdir = null;
  while (dirs.length) {   // dossiers « Saison 1 », « S02 », « Specials »…
    const l = dirs[dirs.length - 1], mm = l.match(SEASON_DIR);
    if (mm) { sdir = +mm[1]; dirs.pop(); } else if (/^(specials?|extras?|hors[ -]?s[ée]rie|bonus)$/i.test(l)) { sdir = 0; dirs.pop(); } else break;
  }
  const name = base.replace(/\.[^.]+$/, ''), ep = parseEp(name); let show = '', year, mseason = null;
  for (let k = dirs.length - 1; k >= 0 && !show; k--) {   // du dossier le plus profond vers le haut : le premier nom utilisable
    const fd = dirs[k], ym = fd.match(/[(\[]((?:19|20)\d{2})[)\]]/), sp = splitSeasonTag(cleanShow(fd));
    if (sp.season != null && mseason == null) mseason = sp.season;
    if (sp.name) { show = sp.name; if (ym) year = +ym[1]; }
  }
  if (!show) {   // pas de dossier exploitable : le nom vient du fichier
    show = ep && ep.i > 0 ? cleanShow(name.slice(0, ep.i)) : cleanShow(name);
    const sp = splitSeasonTag(show); if (sp.name) show = sp.name;
    const ym = name.match(/[(\[]((?:19|20)\d{2})[)\]]/); if (ym) year = +ym[1];
  }
  if (!show) show = cleanShow(name) || name;
  return { show, year, season: ep && ep.s != null ? ep.s : (sdir != null ? sdir : (mseason != null ? mseason : 1)), ep: ep ? ep.e : 0, title: ep ? (epTitle(name, ep) || ('Épisode ' + ep.e)) : clean(name) };
}
function scan() {
  if (scanning) return; scanning = true; SCANSTAT.running = true; const t0 = Date.now();
  try {
    const old = new Map(index.map(i => [i.file, i.id])); const nx = []; let id = 0; ARTC = new Map();
    cfg.libraries.forEach((lib, li) => {
      for (const root of lib.paths) for (const f of walk(root)) {
        let stt; try { stt = fs.statSync(f); } catch { continue; }
        if (AMBIG.test(f) && stt.size < 8e6) continue;
        const base = path.basename(f), parts = path.relative(root, f).split(path.sep);
        if (TRAILER_FILE.test(base.replace(/\.[^.]+$/, '')) || parts.slice(0, -1).some(x => TRAILER_DIR.test(x))) continue;   // bandes-annonces locales : jamais prises pour des films
        const genre = lib.groups === true && parts.length > 1 ? parts[0] : '';
        const it = { id: id++, libId: li, type: lib.type, lib: lib.name, root, file: f, k: 'f|' + sha(f).slice(0, 16), lang: lib.language || 'fr-FR', genre, title: clean(base.replace(/\.[^.]+$/, '')), added: stt.mtimeMs, size: stt.size };
        if (lib.type === 'shows') {
          const r = parseShowFile(parts, genre, base);
          it.show = r.show; it.season = r.season; it.ep = r.ep; it.title = r.title; if (r.year) it.syear = r.year;
        } else {
          const y = base.match(/^(.*?)[ ._(\[]*((?:19|20)\d{2})/);
          if (y && clean(y[1])) { it.title = clean(y[1]); it.year = +y[2]; }
        }
        nx.push(it);
      }
    });
    // même série = même nom pour tous ses épisodes (casse, points, tirets, accents ignorés)
    const grp = new Map();
    for (const it of nx) if (it.type === 'shows') { const k = it.libId + '|' + normName(it.show); let g = grp.get(k); if (!g) grp.set(k, g = { names: new Map(), year: 0 }); g.names.set(it.show, (g.names.get(it.show) || 0) + 1); if (it.syear) g.year = it.syear; }
    for (const g of grp.values()) { let best = '', n = -1; for (const [nm, c] of g.names) if (c > n || (c === n && nm.length > best.length)) { best = nm; n = c; } g.name = best; }
    for (const it of nx) if (it.type === 'shows') { const g = grp.get(it.libId + '|' + normName(it.show)); it.show = g.name; if (g.year) it.syear = g.year; }
    index = nx; byK = new Map(nx.map(i => [i.k, i]));
    log('Scan : ' + index.length + ' fichiers');
  } finally { scanning = false; SCANSTAT = { running: false, last: Date.now(), ms: Date.now() - t0 }; }
  enrich();
}
const allowedLib = (u, l) => !!l && (!u.libs || u.libs.includes(l.uid));
const itemFor = (u, id) => { const i = index[id]; return i && allowedLib(u, cfg.libraries[i.libId]) ? i : null; };

// Pochettes locales (poster.jpg, folder.jpg, fanart.jpg…)
function localArt(it, kind) {
  const names = kind === 'backdrop' ? ['fanart', 'backdrop', 'background', 'art'] : ['poster', 'folder', 'cover', 'thumb'];
  const dirs = [path.dirname(it.file)];
  if (it.type === 'shows') { let d = dirs[0]; for (let n = 0; n < 2; n++) { const p2 = path.dirname(d); if (p2.length > it.root.length && p2 !== d) { dirs.push(p2); d = p2; } else break; } }
  const base = path.basename(it.file, path.extname(it.file)).toLowerCase();
  for (let di = 0; di < dirs.length; di++) {
    const d = dirs[di]; let set = ARTC.get(d);
    if (!set) { set = new Map(); try { fs.readdirSync(d).forEach(x => set.set(x.toLowerCase(), x)); } catch {} ARTC.set(d, set); }
    const cand = []; names.forEach(n => ['jpg', 'jpeg', 'png', 'webp'].forEach(e => cand.push(n + '.' + e)));
    if (di === 0) ['jpg', 'jpeg', 'png', 'webp'].forEach(e => { cand.push(base + (kind === 'backdrop' ? '-fanart.' : '-poster.') + e); if (kind !== 'backdrop') cand.push(base + '.' + e); });
    for (const c of cand) if (set.has(c)) return path.join(d, set.get(c));
  }
  return null;
}

const TRAILER_FILE = /(?:^|[\s._-])(?:trailer|bande[ ._-]?annonce)$/i, TRAILER_DIR = /^(?:trailers?|bandes?[ _-]?annonces?)$/i, VEXT_T = ['mp4', 'mkv', 'webm', 'm4v', 'mov', 'avi', 'ts'];
function localTrailer(it) {
  const dirs = [path.dirname(it.file)];
  if (it.type === 'shows') { let d = dirs[0]; for (let n = 0; n < 2; n++) { const q = path.dirname(d); if (q.length > it.root.length && q !== d) { dirs.push(q); d = q; } else break; } }
  const base = path.basename(it.file, path.extname(it.file));
  for (const d of dirs) {
    let names = []; try { names = fs.readdirSync(d); } catch { continue; }
    const low = new Map(names.map(x => [x.toLowerCase(), x]));
    for (const e of VEXT_T) for (const n of [(it.type === 'shows' ? '' : base.toLowerCase() + '-') + 'trailer.' + e, 'trailer.' + e, 'bande-annonce.' + e]) if (n && low.has(n)) return path.join(d, low.get(n));
    for (const x of names) if (TRAILER_DIR.test(x)) { try { const f = fs.readdirSync(path.join(d, x)).find(y => VEXT_T.includes(path.extname(y).slice(1).toLowerCase())); if (f) return path.join(d, x, f); } catch {} }
  }
  return null;
}
const TRL = load('trailers.json', {});
async function trailerFor(i) {
  const m = M(i), key = i.type === 'shows' ? 'tv' + m.id : 'mv' + m.id, c = TRL[key];
  if (c && (c.yt || Date.now() - c.t < 7 * 864e5)) return c;
  if (!m.id || !cfg.tmdb) return {};
  const kind = i.type === 'shows' ? 'tv' : 'movie', lang = (i.lang || 'fr-FR');
  const pick = r => { const l = (r.results || []).filter(x => x.site === 'YouTube' && x.key); return l.find(x => x.type === 'Trailer' && x.official) || l.find(x => x.type === 'Trailer') || l.find(x => x.type === 'Teaser') || l[0]; };
  let t = null;
  try { t = pick(await tmdb('/' + kind + '/' + m.id + '/videos', {}, lang)); if (!t) t = pick(await tmdb('/' + kind + '/' + m.id + '/videos', {}, 'en-US')); } catch (e) { return {}; }
  const out = t ? { yt: t.key, name: t.name || '', t: Date.now() } : { t: Date.now() }; TRL[key] = out; save('trailers.json', TRL); return out;
}
function localTheme(it) {
  const dirs = [path.dirname(it.file)];
  if (it.type === 'shows') { let d = dirs[0]; for (let n = 0; n < 2; n++) { const q = path.dirname(d); if (q.length > it.root.length && q !== d) { dirs.push(q); d = q; } else break; } }
  for (const d of dirs) for (const n of ['theme.mp3', 'theme.m4a', 'theme.ogg', 'theme.wav', 'theme.flac']) { const f = path.join(d, n); if (fs.existsSync(f)) return f; }
  return null;
}
const nrm = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const BADART = /tribute|karaoke|cover|made famous|originally performed|lullab|piano version|in the style of|vitamin string|rockabye|nightcore|8-?bit|remix|\bdj\b|workout|for kids|baby/i;
const FILL = /\b(soundtrack|original|motion|picture|television|tv|series|score|music|from|the|of|a|and|ost|by|official|deluxe|edition|expanded|special|limited|netflix|amazon|prime|hbo|disney|apple|hulu|film|movie|season|saison|vol|volume|bande|originale|du|de|la|le|les|des|un|une|musique|themes?|\d{1,2}|(?:19|20)\d{2})\b/g;
// Choisit l'album de bande originale qui correspond EXACTEMENT au titre (jamais un titre voisin : « Dark » ≠ « The Dark Knight »)
function pickAlbum(results, title, type, year) {
  const t = nrm(title); if (t.length < 2) return null; let best = null, bs = 0;
  for (const a of results || []) {
    if (BADART.test(a.artistName || '') || BADART.test(a.collectionName || '')) continue;
    const cn = nrm(a.collectionName); if (!(' ' + cn + ' ').includes(' ' + t + ' ')) continue;
    const extra = cn.replace(t, ' ').replace(FILL, ' ').trim().split(/\s+/).filter(Boolean).length; if (extra > 0) continue;
    let s = 1; if (/soundtrack|bande originale|original score|original series|original motion|original television|\bost\b|music from|score/.test(cn)) s += 3; if (/sound|bande|original|score/i.test(a.primaryGenreName || '')) s += 2; if (cn === t || cn.startsWith(t + ' ')) s += 1;
    if (type !== 'shows' && year && a.releaseDate) { if (Math.abs(+year - +String(a.releaseDate).slice(0, 4)) > 2) continue; }
    if (s > bs) { bs = s; best = a; }
  }
  return bs >= 4 ? best : null;
}
async function itunes(title, type, year) {
  try {
    const q = new URLSearchParams({ term: title + (type === 'shows' ? ' original television soundtrack' : ' original motion picture soundtrack'), media: 'music', entity: 'album', limit: '25', country: 'FR' });
    const j = await (await fetch('https://itunes.apple.com/search?' + q, { signal: AbortSignal.timeout(8000) })).json(), best = pickAlbum(j.results, title, type, year);
    if (!best) return '';
    const lk = await (await fetch('https://itunes.apple.com/lookup?id=' + best.collectionId + '&entity=song&country=FR', { signal: AbortSignal.timeout(8000) })).json();
    const tr = (lk.results || []).filter(r => r.wrapperType === 'track' && r.previewUrl); if (!tr.length) return '';
    return (tr.find(r => /main title|main theme|titles?\b|theme|opening|g[ée]n[ée]rique|intro|overture/i.test(r.trackName)) || tr[0]).previewUrl;
  } catch { return null; }
}

/* ---------- TMDB : affiches, résumés, genres, casting ---------- */
const IMG = 'https://image.tmdb.org/t/p/';
let enriching = false, tmdbErr = '';
async function tmdb(p, params, lang) {
  const q = new URLSearchParams({ language: lang || 'fr-FR', ...params }), h = { 'User-Agent': 'TBSA-Serveur' };
  if (cfg.tmdb.length > 40) h.Authorization = 'Bearer ' + cfg.tmdb; else q.set('api_key', cfg.tmdb);
  const r = await fetch('https://api.themoviedb.org/3' + p + '?' + q, { headers: h, signal: AbortSignal.timeout(15000) });
  if (r.status === 401) throw new Error('Clé TMDB invalide');
  if (!r.ok) throw new Error('TMDB ' + r.status);
  return r.json();
}
function shape(j, tv, lang) {
  const cc = (lang || 'fr-FR').slice(3) || 'FR'; let cert = '';
  if (tv) { const r = ((j.content_ratings || {}).results || []); cert = (r.find(x => x.iso_3166_1 === cc) || r.find(x => x.iso_3166_1 === 'US') || {}).rating || ''; }
  else { const r = ((j.release_dates || {}).results || []); const e = r.find(x => x.iso_3166_1 === cc) || r.find(x => x.iso_3166_1 === 'US'); cert = e ? ((e.release_dates || []).find(d => d.certification) || {}).certification || '' : ''; }
  return {
    v: 3, id: j.id, poster: j.poster_path ? IMG + 'w342' + j.poster_path : '', backdrop: j.backdrop_path ? IMG + 'w1280' + j.backdrop_path : '',
    collection: !tv && j.belongs_to_collection ? { id: j.belongs_to_collection.id, name: j.belongs_to_collection.name || '', poster: j.belongs_to_collection.poster_path ? IMG + 'w342' + j.belongs_to_collection.poster_path : '', backdrop: j.belongs_to_collection.backdrop_path ? IMG + 'w1280' + j.belongs_to_collection.backdrop_path : '' } : null,
    overview: j.overview || '', tagline: j.tagline || '', rating: j.vote_average ? +j.vote_average.toFixed(1) : 0, name: j.title || j.name || '',
    year: (j.release_date || j.first_air_date || '').slice(0, 4), genres: (j.genres || []).map(g => g.name), cert,
    runtime: tv ? ((j.episode_run_time || [])[0] || 0) : (j.runtime || 0), status: j.status || '',
    directors: tv ? (j.created_by || []).map(c => c.name).slice(0, 4) : ((j.credits || {}).crew || []).filter(c => c.job === 'Director').map(c => c.name).slice(0, 4),
    writers: ((j.credits || {}).crew || []).filter(c => ['Writer', 'Screenplay', 'Story', 'Novel'].includes(c.job)).map(c => c.name).filter((n, k, a) => a.indexOf(n) === k).slice(0, 5),
    countries: (j.production_countries || []).map(c => c.iso_3166_1).concat(j.origin_country || []).filter((n, k, a) => a.indexOf(n) === k).slice(0, 4),
    cast: ((j.credits || {}).cast || []).slice(0, 14).map(c => ({ n: c.name, c: c.character || '', p: c.profile_path ? IMG + 'w185' + c.profile_path : '' })),
    seasons: tv ? (j.seasons || []).filter(s => s.season_number > 0).map(s => ({ n: s.season_number, name: s.name, count: s.episode_count })) : undefined
  };
}
const APPEND = tv => tv ? 'credits,content_ratings' : 'credits,release_dates';
async function fetchMeta(i) {
  const tv = i.type === 'shows', lang = i.lang || 'fr-FR', q = { query: tv ? i.show : i.title };
  const yr = tv ? i.syear : i.year; if (yr) q[tv ? 'first_air_date_year' : 'year'] = yr;
  let s = await tmdb('/search/' + (tv ? 'tv' : 'movie'), q, lang), x = (s.results || [])[0];
  if (!x && yr) { delete q[tv ? 'first_air_date_year' : 'year']; s = await tmdb('/search/' + (tv ? 'tv' : 'movie'), q, lang); x = (s.results || [])[0]; }
  if (!x) return {};
  return shape(await tmdb('/' + (tv ? 'tv/' : 'movie/') + x.id, { append_to_response: APPEND(tv) }, lang), tv, lang);
}
async function enrich() {
  if (!cfg.tmdb || enriching) return; enriching = true; tmdbErr = '';
  try {
    const todo = new Map();
    for (const i of index) { if (i.type === 'other') continue; const k = mkey(i), m = meta[k]; if ((!m || (m.poster !== undefined && m.v !== 3 && Object.keys(m).length)) && !todo.has(k)) todo.set(k, i); }
    if (todo.size) log('Métadonnées : ' + todo.size + ' titres à récupérer');
    for (const [k, i] of todo) {
      try { meta[k] = await fetchMeta(i); } catch (e) { tmdbErr = e.message; log('TMDB : ' + e.message); break; }
      save('meta.json', meta); await new Promise(r => setTimeout(r, 150));
    }
  } finally { enriching = false; }
}

/* ---------- Sous-titres ---------- */
const LANGN = { fr: 'Français', fre: 'Français', fra: 'Français', en: 'Anglais', eng: 'Anglais', es: 'Espagnol', spa: 'Espagnol', de: 'Allemand', ger: 'Allemand', deu: 'Allemand', it: 'Italien', ita: 'Italien', pt: 'Portugais', por: 'Portugais', nl: 'Néerlandais', dut: 'Néerlandais', nld: 'Néerlandais', ru: 'Russe', rus: 'Russe', ja: 'Japonais', jpn: 'Japonais', ar: 'Arabe', ara: 'Arabe', zh: 'Chinois', chi: 'Chinois', zho: 'Chinois', ko: 'Coréen', kor: 'Coréen', tr: 'Turc', tur: 'Turc', pl: 'Polonais', pol: 'Polonais' };
const langName = c => LANGN[String(c || '').toLowerCase()] || (c && c !== 'und' ? c : '');
function extSubs(file) {
  const dir = path.dirname(file), base = path.basename(file, path.extname(file)).toLowerCase(); let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => /\.(srt|vtt|ass|ssa)$/i.test(n) && n.toLowerCase().startsWith(base)).map((n, i) => {
    const rest = n.slice(base.length, n.length - path.extname(n).length).replace(/^[.\-_ ]+/, '');
    const parts = rest.split(/[.\-_ ]+/).filter(Boolean), forced = parts.some(p => /forced|forcé/i.test(p)), lg = parts.find(p => langName(p));
    return { id: 'x' + i, file: path.join(dir, n), label: (lg ? langName(lg) : rest || 'Externe') + (forced ? ' (forcés)' : ''), lang: lg || '' };
  });
}
const p2 = n => String(n).padStart(2, '0');
const fmtT = t => { const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000); return `${p2(h)}:${p2(m)}:${p2(s)}.${String(ms).padStart(3, '0')}`; };
const TRE = /(?:(\d+):)?(\d+):(\d+)[,.](\d+)/.source, CUE = new RegExp(TRE + '\\s*-->\\s*' + TRE + '(.*)');
const secs = (h, m, s, ms) => (+h || 0) * 3600 + (+m) * 60 + (+s) + (+('0.' + ms));
// SRT ou VTT → VTT, avec décalage (secondes) pour les lectures converties démarrées en cours de film
function toVtt(txt, off) {
  off = off || 0; txt = txt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); const out = ['WEBVTT', ''];
  for (const b of txt.split(/\n{2,}/)) {
    const lines = b.split('\n'), i = lines.findIndex(l => l.includes('-->')); if (i < 0) continue;
    const m = lines[i].match(CUE); if (!m) continue;
    const s = secs(m[1], m[2], m[3], m[4]) - off, e = secs(m[5], m[6], m[7], m[8]) - off; if (e <= 0) continue;
    out.push(fmtT(Math.max(0, s)) + ' --> ' + fmtT(e) + (m[9] || ''), ...lines.slice(i + 1), '');
  }
  return out.join('\n');
}
const decodeText = buf => { const u = buf.toString('utf8'); return u.includes('\uFFFD') ? buf.toString('latin1') : u; };
const CHQ = { n: 0 };
function runFF(args, ms) {
  return new Promise(res => { if (!FFMPEG) return res(null); execFile(FFMPEG, args, { timeout: ms || 120000, maxBuffer: 64e6, encoding: 'buffer' }, (e, out) => res(e ? null : out)); });
}

/* ---------- ffprobe ---------- */
const PROBES = new Map();
function probe(file) {
  return new Promise(res => {
    if (!FFPROBE) return res(null);
    let key; try { key = file + '|' + fs.statSync(file).mtimeMs; } catch { return res(null); }
    if (PROBES.has(key)) return res(PROBES.get(key));
    execFile(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file], { timeout: 20000, maxBuffer: 16e6 }, (e, out) => {
      let r = null; if (!e) { try { r = summarize(JSON.parse(out)); } catch {} }
      if (PROBES.size > 500) PROBES.clear(); PROBES.set(key, r); res(r);
    });
  });
}
function summarize(j) {
  const S = j.streams || [], t = x => (x.tags || {}), pic = x => x.disposition && x.disposition.attached_pic;
  const v = S.find(s => s.codec_type === 'video' && !pic(s)), a = S.filter(s => s.codec_type === 'audio'), sb = S.filter(s => s.codec_type === 'subtitle'), f = j.format || {};
  let fps = 0; if (v && v.r_frame_rate) { const [n, d] = v.r_frame_rate.split('/'); fps = +d ? +(n / d).toFixed(2) : 0; }
  return {
    dur: +f.duration || 0, bitrate: +f.bit_rate || 0, size: +f.size || 0, container: (f.format_name || '').split(',')[0],
    video: v ? { codec: v.codec_name, w: v.width, h: v.height, fps, profile: v.profile || '', hdr: v.color_transfer === 'smpte2084' || v.color_transfer === 'arib-std-b67' } : null,
    audio: a.map((x, n) => ({ n, codec: x.codec_name, ch: x.channels || 0, lang: t(x).language || '', title: t(x).title || '', def: !!(x.disposition && x.disposition.default) })),
    subs: sb.map((x, n) => ({ n, codec: x.codec_name, lang: t(x).language || '', title: t(x).title || '', forced: !!(x.disposition && x.disposition.forced), text: !['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'].includes(x.codec_name) })),
    chapters: (j.chapters || []).map(c => ({ t: +c.start_time || 0, title: t(c).title || '' }))
  };
}

/* ---------- Proxy IPTV (CORS + réécriture HLS) ---------- */
const allowed = new Set();
const allow = u => { try { allowed.add(new URL(u).host); } catch {} };
const xBase = () => cfg.xtream.host.replace(/\/+$/, '');
if (cfg.xtream) allow(cfg.xtream.host);
function proxy(req, res, target, hops = 0) {
  let u; try { u = new URL(target); } catch { res.writeHead(400); return res.end(); }
  if (!allowed.has(u.host) || hops > 5) { res.writeHead(403); return res.end('Hôte non autorisé'); }
  const lib = u.protocol === 'https:' ? https : http, headers = { 'User-Agent': 'Mozilla/5.0' };
  if (req.headers.range) headers.Range = req.headers.range;
  const pr = lib.get(u, { headers }, up => {
    if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location) { const n = new URL(up.headers.location, u).href; allow(n); up.resume(); return proxy(req, res, n, hops + 1); }
    const ct = up.headers['content-type'] || '';
    if (/mpegurl/i.test(ct) || /\.m3u8$/i.test(u.pathname)) {
      let b = ''; up.setEncoding('utf8'); up.on('data', d => b += d);
      up.on('end', () => {
        const rw = x => { const a = new URL(x, u).href; allow(a); return '/proxy?u=' + encodeURIComponent(a); };
        const out = b.split('\n').map(l => { l = l.trim(); if (!l) return l; if (l[0] === '#') return l.replace(/URI="([^"]+)"/g, (_, x) => `URI="${rw(x)}"`); return rw(l); }).join('\n');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end(out);
      });
    } else {
      const h = {}; for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (up.headers[k]) h[k] = up.headers[k];
      res.writeHead(up.statusCode, h); up.pipe(res); res.on('close', () => up.destroy());
    }
  });
  pr.setTimeout(30000, () => pr.destroy());
  pr.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
}

/* ---------- Xtream : API (cache 5 min), EPG, M3U ---------- */
const XC = new Map();
async function xtGet(params) {
  if (!cfg.xtream) throw new Error('Xtream non configuré');
  const q = new URLSearchParams(params); q.set('username', cfg.xtream.user); q.set('password', cfg.xtream.pass);
  const key = q.toString(), c = XC.get(key); if (c && Date.now() - c.t < 300000) return c.v;
  const r = await fetch(xBase() + '/player_api.php?' + key, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
  const v = await r.text(); if (XC.size > 150) XC.clear(); XC.set(key, { t: Date.now(), v }); return v;
}
const b64 = s => { try { return Buffer.from(String(s || ''), 'base64').toString('utf8'); } catch { return ''; } };
let M3 = { t: 0, ch: [] };
async function m3u() {
  if (!cfg.m3u) return [];
  if (Date.now() - M3.t < 600000 && M3.ch.length) return M3.ch;
  const txt = await (await fetch(cfg.m3u, { signal: AbortSignal.timeout(40000) })).text(), ch = []; let cur = null;
  for (const raw of txt.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('#EXTINF')) { const g = k => { const m = l.match(new RegExp(k + '="([^"]*)"')); return m ? m[1] : ''; }; cur = { name: l.slice(l.lastIndexOf(',') + 1).trim() || g('tvg-name'), logo: g('tvg-logo'), group: g('group-title') || 'Divers' }; }
    else if (l && l[0] !== '#' && cur) { cur.url = l; cur.n = ch.length; allow(l); ch.push(cur); cur = null; }
  }
  M3 = { t: Date.now(), ch }; return ch;
}

/* ---------- Lecture directe, conversion ffmpeg ---------- */
function serveFile(req, res, f, dl) {
  fs.stat(f, (e, st) => {
    if (e) { res.writeHead(404); return res.end(); }
    const type = MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', h = { 'Accept-Ranges': 'bytes', 'Content-Type': type };
    if (dl) h['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(f));
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let s = m[1] ? +m[1] : Math.max(0, st.size - +m[2]), en = m[1] && m[2] ? +m[2] : st.size - 1; if (en >= st.size) en = st.size - 1;
      if (s > en) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, { ...h, 'Content-Range': `bytes ${s}-${en}/${st.size}`, 'Content-Length': en - s + 1 });
      fs.createReadStream(f, { start: s, end: en }).on('error', () => res.end()).pipe(res);
    } else { res.writeHead(200, { ...h, 'Content-Length': st.size }); fs.createReadStream(f).on('error', () => res.end()).pipe(res); }
  });
}
const QUAL = { auto: { h: 1080, b: 12000, a: '192k' }, 1080: { h: 1080, b: 8000, a: '192k' }, 720: { h: 720, b: 4000, a: '160k' }, 480: { h: 480, b: 1500, a: '128k' }, 360: { h: 360, b: 800, a: '96k' }, remux: { h: 1080, b: 12000, a: '192k' } };
function videoArgs(q) {
  const Q = QUAL[q] || QUAL.auto, t = cfg.transcoder, vf = `scale=-2:'min(${Q.h},ih)',format=yuv420p`, rate = ['-maxrate', Q.b + 'k', '-bufsize', Q.b * 2 + 'k'];
  if (t.hw === 'nvenc' && ENC.includes('h264_nvenc')) return ['-vf', vf, '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '24', '-b:v', Q.b + 'k', ...rate];
  if (t.hw === 'qsv' && ENC.includes('h264_qsv')) return ['-vf', vf, '-c:v', 'h264_qsv', '-b:v', Q.b + 'k', ...rate];
  if (t.hw === 'amf' && ENC.includes('h264_amf')) return ['-vf', vf, '-c:v', 'h264_amf', '-b:v', Q.b + 'k', ...rate];
  return ['-vf', vf, '-c:v', 'libx264', '-preset', t.preset || 'veryfast', '-crf', '23', ...rate];
}
const ACTIVE = new Set();
async function transcode(req, res, it, q) {
  if (!FFMPEG) { res.writeHead(501); return res.end('ffmpeg absent'); }
  if (ACTIVE.size >= (cfg.transcoder.maxSessions || 3)) { res.writeHead(503); return res.end('Trop de conversions simultanées'); }
  const t = Math.max(0, +q.get('t') || 0), a = Math.max(0, +q.get('a') || 0), qual = q.get('q') || 'auto', Q = QUAL[qual] || QUAL.auto;
  // « remux » : si la vidéo est du H.264 8 bits on la COPIE telle quelle (aucune perte, très léger) et on ne convertit que le son
  let copyV = false;
  if (qual === 'remux' && !/^https?:/.test(it.file)) { const pr = await probe(it.file), v = pr && pr.video; copyV = !!v && v.codec === 'h264' && !/10|4:2:2|4:4:4/.test(v.profile || '') && !v.hdr; }
  if (res.destroyed || res.writableEnded) return;
  const vArgs = copyV ? ['-c:v', 'copy', '-avoid_negative_ts', 'make_zero'] : videoArgs(qual === 'remux' ? 'auto' : qual);
  // Son : mélange stéréo, recalage sur l'image (pas de dérive) + décalage réglable (ms) pour compenser le retard propre à chaque téléviseur
  const dly = Math.max(-3000, Math.min(3000, Math.round(+q.get('d') || 0)));
  const af = ['aformat=channel_layouts=stereo', ...(dly > 0 ? ['adelay=' + dly + '|' + dly] : []), 'aresample=async=1'].join(',');
  if (dly < 0) {   // son à avancer : on retarde l'image d'autant
    const x = (-dly / 1000).toFixed(3), i = vArgs.indexOf('-vf');
    if (copyV) vArgs.push('-bsf:v', 'setts=ts=TS+' + x + '/TB'); else if (i >= 0) vArgs[i + 1] += ',setpts=PTS+' + x + '/TB';
  }
  const ua = /^https?:/.test(it.file) ? ['-user_agent', 'Mozilla/5.0'] : [], tail = ['-write_tmcd', '0', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
  const full = ['-v', 'error', ...ua, ...(copyV && t > 0 ? ['-noaccurate_seek', '-ss', String(t + 0.4)] : ['-ss', String(t)]), '-i', it.file, '-map', '0:v:0', '-map', '0:a:' + a + '?', '-sn', '-dn', ...vArgs, '-af', af, '-c:a', 'aac', '-b:a', Q.a, '-ac', '2', ...tail];
  // Plan B (réglages les plus simples) si cette version de ffmpeg refuse une option ci-dessus : l'image est alors lue sans réglage fin du son
  const vBase = copyV ? ['-c:v', 'copy', '-avoid_negative_ts', 'make_zero'] : videoArgs(qual === 'remux' ? 'auto' : qual);
  const simple = ['-v', 'error', ...ua, '-ss', String(t), '-i', it.file, '-map', '0:v:0', '-map', '0:a:' + a + '?', '-sn', '-dn', ...vBase, '-c:a', 'aac', '-b:a', Q.a, '-ac', '2', ...tail];
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
  let cur = null;
  const launch = (args, last) => {
    const f = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let err = '', sent = 0; cur = f;
    ACTIVE.add(f); f.stderr.on('data', d => err = (err + d).slice(-600));
    f.stdout.on('data', d => { sent += d.length; if (!res.destroyed) res.write(d); });
    f.on('error', e => { log('ffmpeg : ' + e.message); ACTIVE.delete(f); res.end(); });
    f.on('close', code => {
      ACTIVE.delete(f);
      if (code && err.trim()) log('ffmpeg (' + it.title + ') : ' + err.trim().split('\n').pop());
      if (code && !sent && !last && !res.destroyed) { log('Nouvel essai avec des réglages simples'); return launch(simple, true); }
      res.end();
    });
  };
  launch(full, false);
  res.on('close', () => { try { cur && cur.kill('SIGKILL'); } catch {} });
}

/* ---------- Sortie des éléments pour un utilisateur ---------- */
const catsOf = i => cats.map[itemKey(i)] || [];
const cleanSaga = n => String(n || '').replace(/\s*[-–(]\s*(saga|collection|trilogie|trilogy|franchise|filmreihe|colecci[oó]n)\s*\)?\s*$/i, '').replace(/^\s*(saga|collection)\s+/i, '').trim();
// Saga d'un film : choix manuel (Modifier > Général) prioritaire, sinon la collection TMDB. « none » = ne pas regrouper.
function sagaOf(i, m) {
  if (i.type !== 'movies') return null;
  const o = OV[mkey(i)] || {};
  if (o.saga === 'none') return null;
  if (o.saga) return { id: 'u' + normName(o.saga).replace(/ /g, '-'), name: o.saga, p: '', b: '' };
  const c = m.collection; return c && c.id ? { id: 'c' + c.id, name: cleanSaga(c.name) || c.name, p: px(c.poster), b: px(c.backdrop, 'w780') } : null;
}
function itemOut(i, S) {
  const m = M(i), manual = catsOf(i), pr = S.progress[i.k];
  return {
    id: i.id, k: i.k, libId: i.libId, type: i.type, title: i.title, year: (OV[mkey(i)] && OV[mkey(i)].year ? +OV[mkey(i)].year : (i.year || +m.year)) || undefined, show: i.show, season: i.season, ep: i.ep, added: i.added, size: i.size, genre: i.genre,
    col: sagaOf(i, m), snone: (OV[mkey(i)] || {}).saga === 'none', mk: mkey(i), manual, tags: [...new Set([i.genre, ...manual].filter(Boolean))], genres: m.genres || [], rating: m.rating || 0, cert: m.cert || '', runtime: m.runtime || 0, name: m.title || m.name || '',
    poster: OV[mkey(i)] && OV[mkey(i)].poster ? px(OV[mkey(i)].poster) : localArt(i, 'poster') ? '/art/' + i.id : px(m.poster),
    bd: OV[mkey(i)] && OV[mkey(i)].backdrop ? px(OV[mkey(i)].backdrop) : localArt(i, 'backdrop') ? '/art/' + i.id + '?k=backdrop' : px(m.backdrop, 'w500'), prog: pr ? { pos: pr.pos || 0, dur: pr.dur || 0, w: !!pr.w, t: pr.t || 0 } : null
  };
}
function itemFull(i, S) {
  const m = M(i), o = itemOut(i, S);
  return { ...o, overview: m.overview || '', tagline: m.tagline || '', status: m.status || '', tmdb: m.id || 0, year: o.year || +m.year || undefined,
    backdrop: OV[mkey(i)] && OV[mkey(i)].backdrop ? px(OV[mkey(i)].backdrop) : localArt(i, 'backdrop') ? '/art/' + i.id + '?k=backdrop' : px(m.backdrop), theme: (OV[mkey(i)] || {}).theme || '', saga: (OV[mkey(i)] || {}).saga || '', themeLocal: !!localTheme(i), backdropSm: m.backdrop && !(OV[mkey(i)] && OV[mkey(i)].backdrop) ? px(m.backdrop, 'w780') : '', directors: m.directors || [], writers: m.writers || [], countries: m.countries || [], file: path.basename(i.file), dir: i.root, cast: (m.cast || []).map(c => ({ n: c.n, c: c.c, p: px(c.p) })), seasons: m.seasons || [] };
}

/* ---------- Recherche globale ---------- */
async function search(q, me, S) {
  q = q.toLowerCase(); const mine = index.filter(i => allowedLib(me, cfg.libraries[i.libId])), out = { movies: [], shows: [], people: [], live: [], vod: [], series: [] };
  const has = s => String(s || '').toLowerCase().includes(q);
  out.movies = mine.filter(i => i.type !== 'shows' && (has(i.title) || has(M(i).name))).slice(0, 30).map(i => itemOut(i, S));
  const seen = new Set(), ppl = new Map();
  for (const i of mine) {
    if (i.type === 'shows') { if (!seen.has(i.show) && (has(i.show) || has(M(i).name))) { seen.add(i.show); out.shows.push(itemOut(i, S)); } }
    const m = M(i); if (m && m.cast) for (const c of m.cast) if (has(c.n)) { const e = ppl.get(c.n) || { n: c.n, p: px(c.p), items: [], seen: new Set() }; const key = i.type === 'shows' ? 's' + i.show : i.id; if (!e.seen.has(key) && e.items.length < 12) { e.seen.add(key); e.items.push(itemOut(i, S)); } ppl.set(c.n, e); }
  }
  out.shows = out.shows.slice(0, 30); out.people = [...ppl.values()].slice(0, 4).map(({ seen: _s, ...e }) => e);
  if (me.iptv !== false) {
    if (cfg.xtream) for (const [k, a] of [['live', 'get_live_streams'], ['vod', 'get_vod_streams'], ['series', 'get_series']]) {
      try { const l = JSON.parse(await xtGet({ action: a })); if (Array.isArray(l)) out[k] = l.filter(x => has(x.name)).slice(0, 30).map(x => ({ id: x.stream_id || x.series_id, name: x.name, icon: x.stream_icon || x.cover || '', ext: x.container_extension || '' })); } catch {}
    }
    if (cfg.m3u) { try { out.m3u = (await m3u()).filter(c => has(c.name)).slice(0, 30).map(c => ({ n: c.n, name: c.name, logo: c.logo })); } catch {} }
  }
  return out;
}

/* ---------- HTTP ---------- */
const send = (res, code, type, body, extra) => { res.writeHead(code, { 'Content-Type': type, ...(extra || {}) }); res.end(body); };
function J(req, res, o, code = 200) {
  const s = JSON.stringify(o), h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (s.length > 1500 && /gzip/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(code, h); return res.end(zlib.gzipSync(s)); }
  res.writeHead(code, h); res.end(s);
}
const body = (req, lim = 2e6) => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > lim) req.destroy(); }); req.on('end', () => r(b)); req.on('error', () => r('')); });
const normPath = x => String(x || '').trim().replace(/^["']+|["']+$/g, '');

let scanTimer, watchers = [], wt;
function schedule() {
  clearInterval(scanTimer); if (cfg.scanMinutes > 0) scanTimer = setInterval(scan, cfg.scanMinutes * 60000);
  watchers.forEach(w => { try { w.close(); } catch {} }); watchers = [];
  for (const l of cfg.libraries) for (const r of l.paths) { try { watchers.push(fs.watch(r, { recursive: true }, () => { clearTimeout(wt); wt = setTimeout(scan, 4000); })); } catch {} }
}

/* ---------- Similaires dans la bibliothèque ---------- */
function similarLocal(i, me, S, n = 14) {
  const m0 = M(i), gm = new Set(m0.genres || []), cast = new Set((m0.cast || []).map(c => c.n)), seen = new Set(), sc = [];
  for (const j of index) {
    if (j === i || !allowedLib(me, cfg.libraries[j.libId])) continue;
    const key = j.type === 'shows' ? 's' + j.show : j.id; if (seen.has(key) || (i.type === 'shows' && j.type === 'shows' && j.show === i.show)) continue; seen.add(key);
    const m = M(j); let s = 0; (m.genres || []).forEach(g => { if (gm.has(g)) s += 2; }); (m.cast || []).forEach(c => { if (cast.has(c.n)) s += 1; });
    if (j.type === i.type) s += 0.5; if (m.rating) s += m.rating / 20; if (s >= 2.5) sc.push([s, j]);
  }
  return sc.sort((a, b) => b[0] - a[0]).slice(0, n).map(x => itemOut(x[1], S));
}
const RECS = new Map();

/* ---------- Routes ---------- */
SRV = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams, POST = req.method === 'POST';
  const ok = extra => J(req, res, { ok: true, ...(extra || {}) });
  try {
    if (p === '/') { let h; try { h = fs.readFileSync(asset('index.html')); } catch { return send(res, 500, 'text/plain; charset=utf-8', 'index.html introuvable : placez index.html (et le dossier assets) a cote de TBSA-Serveur.exe, puis relancez.'); } return send(res, 200, 'text/html; charset=utf-8', h, { 'Cache-Control': 'no-store' }); }
    if (p === '/apk' || p === '/TBSA-Serveur.apk') {
      const f = apkPath(); if (!f) return send(res, 404, 'text/plain; charset=utf-8', 'Aucun fichier TBSA-Serveur.apk trouve : placez-le a cote de TBSA-Serveur.exe puis rechargez cette page.');
      const st = fs.statSync(f); res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': st.size, 'Content-Disposition': 'attachment; filename="TBSA-Serveur.apk"' }); return fs.createReadStream(f).pipe(res);
    }
    if (p === '/assets/smoke.jpg') return fs.readFile(asset('assets/smoke.jpg'), (e, b) => e ? (res.writeHead(404), res.end()) : send(res, 200, 'image/jpeg', b, { 'Cache-Control': 'public, max-age=86400' }));
    if (p === '/api/ping') return J(req, res, { name: 'TBSA-Serveur', version: VERSION, server: cfg.serverName, port: PORT });
    if (p === '/api/users' && !POST) return J(req, res, { users: U.users.map(pubUser), auto: U.users.length === 1 && !U.users[0].pin ? U.users[0].id : null, server: cfg.serverName });
    if (p === '/api/login' && POST) {
      const b = JSON.parse(await body(req) || '{}'), ip = ipOf(req), f = FAIL[ip], user = U.users.find(x => x.id === b.id);
      if (f && f.n >= 5 && Date.now() < f.until) return J(req, res, { error: 'Trop d’essais, patientez 30 secondes.' }, 429);
      if (f && Date.now() >= f.until) delete FAIL[ip];
      if (!user || !checkPin(b.pin || '', user.pin)) { const c = FAIL[ip] || { n: 0 }; c.n++; c.until = Date.now() + 30000; FAIL[ip] = c; return J(req, res, { error: 'Code PIN incorrect.' }, 401); }
      delete FAIL[ip]; const tok = crypto.randomBytes(24).toString('hex');
      for (const k in U.sessions) if (Date.now() - U.sessions[k].t > 180 * 864e5) delete U.sessions[k];
      U.sessions[tok] = { uid: user.id, t: Date.now() }; saveU();
      res.setHeader('Set-Cookie', `tbsa=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000`); return J(req, res, { user: pubUser(user) });
    }
    if (p === '/api/logout') { const t = cookie(req, 'tbsa'); if (t) { delete U.sessions[t]; saveU(); } res.setHeader('Set-Cookie', 'tbsa=; Path=/; Max-Age=0'); return J(req, res, { ok: true }); }
    const me = userOf(req);
    if (p === '/api/me') return J(req, res, { user: me ? pubUser(me) : null });
    if (!me) { if (p.startsWith('/api/')) return J(req, res, { error: 'auth' }, 401); res.writeHead(401); return res.end(); }
    const S = stOf(me), admin = !!me.admin, iptvOK = me.iptv !== false;
    if (p === '/api/backup' && req.method === 'GET') {
      if (!admin) return J(req, res, { error: 'Réservé à l’administrateur' }, 403);
      flush();
      const files = []; const walkB = (dir, rel) => { for (const n of fs.readdirSync(dir)) { const f = path.join(dir, n), r = rel ? rel + '/' + n : n, st = fs.statSync(f);
        if (st.isDirectory()) { if (rel === '' && n !== 'custom') continue; walkB(f, r); } else if (rel === '' ? /^[\w.-]+\.json$/.test(n) && !/\.(bak|tmp)$/.test(n) : true) files.push({ p: r, b: fs.readFileSync(f).toString('base64') }); } };
      try { walkB(DATA, ''); } catch (e) { return J(req, res, { error: e.message }, 500); }
      const out = JSON.stringify({ tbsa: 1, version: VERSION, date: new Date().toISOString(), files });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="TBSA-sauvegarde-' + new Date().toISOString().slice(0, 10) + '.tbsa"', 'Content-Length': Buffer.byteLength(out) }); return res.end(out);
    }
    if (p === '/api/restore' && req.method === 'POST') {
      if (!admin) return J(req, res, { error: 'Réservé à l’administrateur' }, 403);
      let b; try { b = JSON.parse(await body(req, 4e8)); } catch { return J(req, res, { error: 'Fichier de sauvegarde illisible' }, 400); }
      if (!b || b.tbsa !== 1 || !Array.isArray(b.files) || !b.files.some(f => f.p === 'config.json')) return J(req, res, { error: 'Ce fichier n’est pas une sauvegarde TBSA-Serveur' }, 400);
      let n = 0;
      for (const f of b.files) {
        const rel = String(f.p || '').replace(/\\/g, '/'); if (!(/^[\w.-]+\.json$/.test(rel) || /^custom\/[\w .()\-]+(\/[\w .()\-]+)*$/.test(rel)) || rel.includes('..')) continue;
        const dst = path.join(DATA, rel); try { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, Buffer.from(String(f.b || ''), 'base64')); try { fs.unlinkSync(dst + '.bak'); } catch {} n++; } catch {}
      }
      log('Sauvegarde restaurée (' + n + ' fichiers) : redémarrage du serveur');
      J(req, res, { ok: true, files: n }); return setTimeout(() => process.exit(0), 900);
    }
    const need = () => { if (!admin) { J(req, res, { error: 'Réservé à l’administrateur' }, 403); return false; } return true; };

    /* --- configuration --- */
    if (p === '/api/config' && !POST) {
      const libs = cfg.libraries.map((l, id) => ({ id, uid: l.uid, name: l.name, type: l.type, language: l.language, paths: admin ? l.paths : undefined, groups: l.groups })).filter(l => allowedLib(me, l));
      const o = { serverName: cfg.serverName, version: VERSION, libraries: libs, iptv: { xtream: !!cfg.xtream && iptvOK, m3u: !!cfg.m3u && iptvOK }, ffmpeg: !!FFMPEG, tmdbSet: !!cfg.tmdb, themeMusic: cfg.themeMusic !== false, sagaMin: cfg.sagaMin, me: pubUser(me) };
      if (admin) Object.assign(o, { dataDir: DATA, dataError: WRITE_ERR, dataNote: DATA_NOTE, xtream: cfg.xtream ? { host: cfg.xtream.host, user: cfg.xtream.user } : null, m3u: cfg.m3u, tmdb: { set: !!cfg.tmdb, error: tmdbErr }, scanMinutes: cfg.scanMinutes, transcoder: cfg.transcoder, encoders: ENC, ffprobe: !!FFPROBE, platform: process.platform });
      return J(req, res, o);
    }
    if (p === '/api/config' && POST) {
      if (!need()) return; const b = JSON.parse(await body(req)), skipped = [];
      if (b.libraries) cfg.libraries = b.libraries.map(l => {
        const raw = Array.isArray(l.paths) ? l.paths : [l.path], paths = raw.map(normPath).filter(Boolean).filter(x => { if (fs.existsSync(x)) return true; skipped.push(x); return false; });
        return { uid: l.uid || rid(), name: String(l.name || '').trim() || (paths[0] ? path.basename(paths[0]) : 'Bibliothèque'), type: ['shows', 'other'].includes(l.type) ? l.type : 'movies', language: l.language || 'fr-FR', paths, groups: l.groups === true };
      }).filter(l => l.paths.length);
      if ('xtream' in b) {
        const x = b.xtream;
        if (x && x.host && x.user) { let host = x.host.trim(); if (!/^https?:\/\//.test(host)) host = 'http://' + host; cfg.xtream = { host, user: x.user.trim(), pass: x.pass || (cfg.xtream && cfg.xtream.pass) || '' }; allow(host); } else cfg.xtream = null;
      }
      if ('m3u' in b) { cfg.m3u = String(b.m3u || '').trim(); M3 = { t: 0, ch: [] }; }
      if (b.tmdb && String(b.tmdb).trim()) cfg.tmdb = String(b.tmdb).trim(); if (b.clearTmdb) cfg.tmdb = '';
      if (b.serverName) cfg.serverName = String(b.serverName).trim().slice(0, 40) || 'TBSA-Serveur';
      if (b.scanMinutes !== undefined) cfg.scanMinutes = Math.max(0, Math.min(1440, +b.scanMinutes || 0));
      if ('themeMusic' in b) cfg.themeMusic = !!b.themeMusic;
      if (b.sagaMin !== undefined) cfg.sagaMin = Math.max(0, Math.min(6, Math.round(+b.sagaMin) || 0));
      if (b.transcoder) { const t = b.transcoder; if (['none', 'nvenc', 'qsv', 'amf'].includes(t.hw)) cfg.transcoder.hw = t.hw; if (['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].includes(t.preset)) cfg.transcoder.preset = t.preset; if (t.maxSessions) cfg.transcoder.maxSessions = Math.max(1, Math.min(12, +t.maxSessions || 3)); }
      saveCfg(); XC.clear(); schedule(); if (b.libraries) setImmediate(scan); else if (b.tmdb) setImmediate(enrich);
      return ok({ skipped });
    }

    /* --- bibliothèque --- */
    if (p === '/api/library') return J(req, res, index.filter(i => allowedLib(me, cfg.libraries[i.libId])).map(i => itemOut(i, S)));
    if (p.startsWith('/api/trailer/')) { const i = itemFor(me, +p.slice(13)); if (!i) return J(req, res, {}, 404); const lt = localTrailer(i); if (lt) return J(req, res, { local: true }); const t = await trailerFor(i); return J(req, res, { yt: t.yt || '', name: t.name || '', tmdb: !!cfg.tmdb }); }
    if (p.startsWith('/trailer-file/')) { const i = itemFor(me, +p.slice(14)), f = i && localTrailer(i); if (!f) { res.writeHead(404); return res.end(); } return serveFile(req, res, f, false); }
    if (p.startsWith('/api/item/')) { const i = itemFor(me, +p.slice(10)); return i ? J(req, res, itemFull(i, S)) : J(req, res, { error: 'introuvable' }, 404); }
    if (p.startsWith('/api/chthumb/')) {   // vignette d'un chapitre (image extraite du film, mise en cache)
      const i = itemFor(me, +p.slice(13)), t = Math.max(0, +q.get('t') || 0);
      if (!i || !FFMPEG || /^https?:/.test(i.file)) { res.writeHead(404); return res.end(); }
      try {
        let mt = 0; try { mt = fs.statSync(i.file).mtimeMs; } catch {}
        const f = path.join(IMGC, 'ch_' + crypto.createHash('md5').update(i.file + '|' + mt + '|' + Math.round(t)).digest('hex') + '.jpg');
        if (!fs.existsSync(f)) {
          while (CHQ.n >= 2) await new Promise(r => setTimeout(r, 120));
          CHQ.n++;
          try { const b = await runFF(['-v', 'error', '-ss', String(Math.max(0, t + 1)), '-i', i.file, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '6', '-f', 'image2pipe', '-c:v', 'mjpeg', '-'], 20000); if (b && b.length > 200) { try { fs.mkdirSync(IMGC, { recursive: true }); fs.writeFileSync(f, b); } catch {} } } finally { CHQ.n--; }
        }
        if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
        return send(res, 200, 'image/jpeg', fs.readFileSync(f), { 'Cache-Control': 'private, max-age=86400' });
      } catch { res.writeHead(404); return res.end(); }
    }
    if (p.startsWith('/api/kf/')) {   // image clé juste avant t : en copiant la vidéo, le son et l'image démarrent alors exactement ensemble
      const i = itemFor(me, +p.slice(8)), t = Math.max(0, +q.get('t') || 0); if (!i || !FFPROBE || /^https?:/.test(i.file)) return J(req, res, { t });
      try {
        const out = await new Promise(r => execFile(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', '-read_intervals', Math.max(0, t - 40) + '%' + (t + 0.05), i.file], { timeout: 15000, maxBuffer: 4e6 }, (e, so) => r(String(so || ''))));
        let k = null; for (const ln of out.split('\n')) { const [pt, fl] = ln.split(','); const x = parseFloat(pt); if (/K/.test(fl || '') && x <= t + 0.001 && (k === null || x > k)) k = x; }
        return J(req, res, { t: k === null ? t : Math.max(0, +k.toFixed(3)) });
      } catch { return J(req, res, { t }); }
    }
    if (p.startsWith('/api/info/')) {
      const i = itemFor(me, +p.slice(10)); if (!i) return J(req, res, { error: 'introuvable' }, 404);
      const info = await probe(i.file), ext = extSubs(i.file).map(s => ({ id: s.id, label: s.label, lang: s.lang, src: 'ext' }));
      const emb = info && FFMPEG ? info.subs.filter(s => s.text).map(s => ({ id: 'e' + s.n, label: (langName(s.lang) || 'Piste ' + (s.n + 1)) + (s.title ? ' · ' + s.title : '') + (s.forced ? ' (forcés)' : ''), lang: s.lang, src: 'emb' })) : [];
      return J(req, res, { info, subs: ext.concat(emb), ffmpeg: !!FFMPEG, file: path.basename(i.file) });
    }
    if (p === '/api/season') {
      const mk = q.get('mk') || '', n = +q.get('n') || 0, m = meta[mk]; if (!m || !m.id || !cfg.tmdb) return J(req, res, []);
      const lang = mk.split('|')[3] || 'fr-FR', key = 'sea|' + m.id + '|' + n + '|' + lang;
      if (!meta[key]) { try { const j = await tmdb('/tv/' + m.id + '/season/' + n, {}, lang); meta[key] = (j.episodes || []).map(e => ({ n: e.episode_number, name: e.name, overview: e.overview || '', still: e.still_path ? IMG + 'w300' + e.still_path : '', runtime: e.runtime || 0, air: e.air_date || '' })); save('meta.json', meta); } catch { return J(req, res, []); } }
      return J(req, res, meta[key].map(e => ({ ...e, still: px(e.still) })));
    }
    if (p === '/api/recs') {
      const i = itemFor(me, +q.get('id')); if (!i) return J(req, res, { similar: [], discover: [] });
      const out = { similar: similarLocal(i, me, S), discover: [] }, m = M(i), tv = i.type === 'shows';
      if (cfg.tmdb && m.id) {
        const key = (tv ? 'tv' : 'movie') + m.id + (i.lang || ''); let r = RECS.get(key);
        if (!r || Date.now() - r.t > 6 * 36e5) { try { const j = await tmdb('/' + (tv ? 'tv/' : 'movie/') + m.id + '/recommendations', {}, i.lang); r = { t: Date.now(), v: (j.results || []).slice(0, 20) }; RECS.set(key, r); } catch { r = { v: [] }; } }
        const have = new Set(index.map(x => (meta[mkey(x)] || {}).id).filter(Boolean));
        out.discover = r.v.filter(x => !have.has(x.id) && x.poster_path).slice(0, 14).map(x => ({ id: x.id, title: x.title || x.name, year: (x.release_date || x.first_air_date || '').slice(0, 4), poster: px(IMG + 'w342' + x.poster_path), rating: x.vote_average ? +x.vote_average.toFixed(1) : 0, overview: x.overview || '' }));
      }
      return J(req, res, out);
    }
    if (p === '/api/theme') {
      const i = itemFor(me, +q.get('id')); if (!i) return J(req, res, { url: '' });
      const ovt = (OV[mkey(i)] || {}).theme;
      if (ovt === 'off') return J(req, res, { url: '' });
      if (ovt) return J(req, res, { url: ovt, src: 'custom' });
      if (localTheme(i)) return J(req, res, { url: '/theme/' + i.id, src: 'local' });
      if (cfg.themeMusic === false) return J(req, res, { url: '' });
      const m = M(i), title = m.name || (i.type === 'shows' ? i.show : i.title), key = i.type + '|' + title.toLowerCase() + '|' + (i.type === 'shows' ? '' : (i.year || ''));
      if (THEMES[key] === undefined) { const t = await itunes(title, i.type, i.year); if (t === null) return J(req, res, { url: '' }); THEMES[key] = t; save('themes.json', THEMES); }
      return J(req, res, { url: THEMES[key] || '', src: 'itunes' });
    }
    if (p.startsWith('/theme/')) { const i = itemFor(me, +p.slice(7)), f = i && localTheme(i); if (!f) { res.writeHead(404); return res.end(); } return serveFile(req, res, f); }
    if (p === '/api/search') return J(req, res, await search(String(q.get('q') || '').trim(), me, S));

    /* --- état de l'utilisateur --- */
    if (p === '/api/state') return J(req, res, { progress: S.progress, favCh: S.favCh, lists: S.lists, rates: S.rates });
    if (p === '/api/rate' && POST) { const b = JSON.parse(await body(req)), k = String(b.k || '').slice(0, 120), n = Math.max(0, Math.min(5, Math.round(+b.v || 0))); if (!k) return ok({ rates: S.rates }); if (n) S.rates[k] = n; else delete S.rates[k]; save('state.json', ST); return J(req, res, { rates: S.rates }); }
    if (p === '/api/progress' && POST) {
      const b = JSON.parse(await body(req)), k = String(b.k || '').slice(0, 80); if (!k) return ok();
      const live = b.kind === 'live', e = live ? {} : (S.progress[k] || (S.progress[k] = {})), dur = +b.dur || 0, pos = +b.pos || 0;
      if (dur > 0) { e.pos = pos; e.dur = dur; } e.t = Date.now();
      for (const f of ['title', 'poster', 'src', 'kind']) if (b[f] !== undefined) e[f] = String(b[f]).slice(0, 300);
      if (dur > 0 && pos / dur >= 0.92) { e.w = 1; e.pos = 0; }
      const sk = me.id + '|' + k;
      if (b.state === 'stopped') delete SES[sk];
      else { if (!SES[sk]) { HIST.unshift({ t: Date.now(), u: me.name, title: e.title || k, mode: b.mode || 'direct' }); HIST.length = Math.min(HIST.length, 100); save('hist.json', HIST); }
        SES[sk] = { u: me.name, title: e.title || k, mode: b.mode || 'direct', q: b.q || '', pos, dur, ip: ipOf(req), since: SES[sk] ? SES[sk].since : Date.now(), last: Date.now() }; }
      if (!live) save('state.json', ST); return ok({ w: !!e.w });
    }
    if (p === '/api/watched' && POST) {
      const b = JSON.parse(await body(req));
      for (const k of (b.ks || []).slice(0, 2000)) { const e = S.progress[String(k)] || (S.progress[String(k)] = {}); if (b.w) { e.w = 1; e.pos = 0; e.t = Date.now(); } else { delete e.w; e.pos = 0; } }
      save('state.json', ST); return ok();
    }
    if (p === '/api/lists' && POST) {
      const b = JSON.parse(await body(req)), L = S.lists, l = L.find(x => x.id === b.id);
      if (b.action === 'create') L.push({ id: rid(), name: String(b.name || 'Playlist').slice(0, 40), items: [] });
      else if (b.action === 'rename' && l && l.id !== 'fav') l.name = String(b.name || l.name).slice(0, 40);
      else if (b.action === 'delete' && l && l.id !== 'fav') S.lists = L.filter(x => x.id !== b.id);
      else if (b.action === 'add' && l && b.item && b.item.k && !l.items.some(x => x.k === b.item.k)) l.items.push({ k: String(b.item.k).slice(0, 80), t: String(b.item.t || '').slice(0, 120), p: String(b.item.p || '').slice(0, 300), kind: String(b.item.kind || '').slice(0, 12), id: b.item.id });
      else if (b.action === 'remove' && l) l.items = l.items.filter(x => x.k !== b.k);
      save('state.json', ST); return J(req, res, { lists: S.lists });
    }
    if (p === '/api/favch' && POST) { const b = JSON.parse(await body(req)), id = String(b.id || ''); S.favCh = S.favCh.filter(x => x !== id); if (b.on) S.favCh.unshift(id); save('state.json', ST); return J(req, res, { favCh: S.favCh }); }

    /* --- IPTV --- */
    if (p === '/api/xt') {
      if (!iptvOK || !cfg.xtream) return J(req, res, { error: 'Xtream non configuré (voir Réglages)' }, 400);
      const params = Object.fromEntries(q); delete params.username; delete params.password;
      try { return send(res, 200, 'application/json', await xtGet(params), { 'Cache-Control': 'no-store' }); } catch { return J(req, res, { error: 'Serveur IPTV injoignable' }, 502); }
    }
    if (p === '/api/epg') {
      const sid = q.get('stream_id') || ''; if (!iptvOK || !/^\d+$/.test(sid)) return J(req, res, []);
      try { const j = JSON.parse(await xtGet({ action: 'get_short_epg', stream_id: sid, limit: '6' })); return J(req, res, (j.epg_listings || []).map(e => ({ t: b64(e.title), d: b64(e.description), s: +e.start_timestamp || Date.parse(e.start) / 1000 || 0, e: +e.stop_timestamp || Date.parse(e.end) / 1000 || 0 }))); } catch { return J(req, res, []); }
    }
    if (p === '/api/m3u') { if (!iptvOK) return J(req, res, []); try { return J(req, res, (await m3u()).map(({ url, ...c }) => ({ ...c, hls: /\.m3u8(\?|$)/i.test(url) }))); } catch { return J(req, res, { error: 'Playlist M3U injoignable' }, 502); } }
    let m;
    if ((m = p.match(/^\/xt\/(live|movie|series)\/([\w.-]+)$/))) {
      if (!iptvOK || !cfg.xtream) { res.writeHead(400); return res.end(); }
      const id = m[1] === 'live' ? m[2].replace(/\.\w+$/, '') + '.m3u8' : m[2];
      return proxy(req, res, `${xBase()}/${m[1]}/${encodeURIComponent(cfg.xtream.user)}/${encodeURIComponent(cfg.xtream.pass)}/${id}`);
    }
    if ((m = p.match(/^\/xtconv\/(movie|series)\/([\w.-]+)$/))) {   // films/séries IPTV convertis par ffmpeg (formats non lisibles)
      if (!iptvOK || !cfg.xtream || !FFMPEG) { res.writeHead(501); return res.end(); }
      return transcode(req, res, { file: `${xBase()}/${m[1]}/${encodeURIComponent(cfg.xtream.user)}/${encodeURIComponent(cfg.xtream.pass)}/${m[2]}`, title: 'IPTV ' + m[2] }, q);
    }
    if ((m = p.match(/^\/m3u\/(\d+)$/))) { if (!iptvOK) { res.writeHead(403); return res.end(); } const ch = await m3u(); const c = ch[+m[1]]; if (!c) { res.writeHead(404); return res.end(); } return proxy(req, res, c.url); }
    if ((m = p.match(/^\/livemp4\/(x|m)\/(\w+)$/))) {   // flux IPTV bruts (MPEG-TS…) convertis en direct par ffmpeg
      if (!iptvOK || !FFMPEG) { res.writeHead(501); return res.end(); }
      if (ACTIVE.size >= (cfg.transcoder.maxSessions || 3)) { res.writeHead(503); return res.end(); }
      let src; if (m[1] === 'x') { if (!cfg.xtream || !/^\d+$/.test(m[2])) { res.writeHead(400); return res.end(); } src = `${xBase()}/live/${encodeURIComponent(cfg.xtream.user)}/${encodeURIComponent(cfg.xtream.pass)}/${m[2]}.ts`; }
      else { const c = (await m3u())[+m[2]]; if (!c) { res.writeHead(404); return res.end(); } src = c.url; }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
      const f = spawn(FFMPEG, ['-v', 'error', '-fflags', 'nobuffer+discardcorrupt', '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      ACTIVE.add(f); f.stdout.pipe(res); f.on('error', () => { ACTIVE.delete(f); res.end(); }); f.on('close', () => { ACTIVE.delete(f); res.end(); }); res.on('close', () => { try { f.kill('SIGKILL'); } catch {} });
      return;
    }
    if (p === '/proxy') return iptvOK ? proxy(req, res, q.get('u') || '') : (res.writeHead(403), res.end());

    /* --- lecture --- */
    if (p.startsWith('/stream/')) { const i = itemFor(me, +p.slice(8)); if (!i) { res.writeHead(404); return res.end(); } return serveFile(req, res, i.file, q.get('dl') === '1' && !me.kid); }
    if (p.startsWith('/transcode/')) { const i = itemFor(me, +p.slice(11)); if (!i) { res.writeHead(404); return res.end(); } return transcode(req, res, i, q); }
    if (p.startsWith('/sub/')) {
      const [, , id, sid] = p.split('/'), i = itemFor(me, +id), off = +q.get('off') || 0; if (!i || !sid) { res.writeHead(404); return res.end(); }
      let txt = '';
      if (sid[0] === 'x') {
        const s = extSubs(i.file).find(x => x.id === sid); if (!s) { res.writeHead(404); return res.end(); }
        if (/\.(ass|ssa)$/i.test(s.file)) { const o = await runFF(['-v', 'error', '-i', s.file, '-f', 'webvtt', 'pipe:1']); txt = o ? o.toString('utf8') : ''; } else txt = decodeText(fs.readFileSync(s.file));
      } else {
        const n = +sid.slice(1) || 0, cf = path.join(SUBC, sha(i.file + '|' + i.size + '|' + n) + '.vtt');
        if (!fs.existsSync(cf)) { const o = await runFF(['-v', 'error', '-i', i.file, '-map', '0:s:' + n, '-f', 'webvtt', 'pipe:1'], 300000); if (o && o.length) fs.writeFileSync(cf, o); }
        txt = fs.existsSync(cf) ? fs.readFileSync(cf, 'utf8') : '';
      }
      return send(res, 200, 'text/vtt; charset=utf-8', toVtt(txt, off), { 'Cache-Control': 'no-store' });
    }
    if (p.startsWith('/art/')) { const i = itemFor(me, +p.slice(5)), f = i && localArt(i, q.get('k') === 'backdrop' ? 'backdrop' : 'poster'); if (!f) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'image/jpeg', 'Cache-Control': 'public, max-age=300' }); return fs.createReadStream(f).pipe(res); }
    if (p.startsWith('/custom/')) { const f = path.join(CUST, path.basename(p)); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } if (/\.(mp3|m4a|ogg|wav|flac)$/i.test(f)) return serveFile(req, res, f); res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }); return fs.createReadStream(f).pipe(res); }
    if (p === '/img') {
      let h; const url = q.get('u') || ''; try { h = new URL(url); } catch { res.writeHead(400); return res.end(); }
      if (!imgHosts().has(h.host)) { res.writeHead(403); return res.end(); }
      const f = path.join(IMGC, sha(url) + (path.extname(h.pathname).slice(0, 5) || '.jpg'));
      if (!fs.existsSync(f)) {
        try { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }), b = Buffer.from(await r.arrayBuffer()); if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/') || b.length > 12e6) { res.writeHead(404); return res.end(); } fs.writeFileSync(f, b); }
        catch { res.writeHead(502); return res.end(); }
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'image/jpeg', 'Cache-Control': 'public, max-age=2592000' }); return fs.createReadStream(f).pipe(res);
    }

    /* --- modification des fiches (comme « Modifier » de Plex) --- */
    if (p === '/api/images') {
      if (!need()) return; const mk = q.get('mk') || '', m0 = meta[mk], tv = mk.startsWith('shows|'), kind = q.get('type') === 'backdrop' ? 'backdrops' : 'posters';
      if (!m0 || !m0.id || !cfg.tmdb) return J(req, res, []);
      try {
        const j = await tmdb('/' + (tv ? 'tv/' : 'movie/') + m0.id + '/images', { include_image_language: 'fr,en,null' }, mk.split('|')[3] || 'fr-FR');
        return J(req, res, (j[kind] || []).sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0)).slice(0, 36).map(x => ({ thumb: px(IMG + 'w342' + x.file_path), full: IMG + (kind === 'posters' ? 'w500' : 'w1280') + x.file_path, lang: x.iso_639_1 || '' })));
      } catch { return J(req, res, []); }
    }
    if (p === '/api/saga-ov') { const out = {}; for (const k of Object.keys(OV)) if (k.startsWith('saga|')) out[k.slice(5)] = OV[k]; return J(req, res, out); }
    if (p === '/api/edit' && POST) {
      if (!need()) return; const b = JSON.parse(await body(req)), mk = String(b.mk || ''); if (!mk) return J(req, res, { error: 'mk manquant' }, 400);
      if (b.reset) delete OV[mk];
      else {
        const o = OV[mk] || (OV[mk] = {});
        for (const f of ['title', 'overview', 'poster', 'backdrop', 'theme', 'saga']) if (b[f] !== undefined) { if (String(b[f]).trim()) o[f] = String(b[f]).slice(0, 4000); else delete o[f]; }
        if (b.year !== undefined) { if (String(b.year).trim()) o.year = String(b.year).slice(0, 4); else delete o.year; }
        for (const f of ['genres', 'directors', 'writers', 'countries']) if (Array.isArray(b[f])) o[f] = b[f].map(x => String(x).trim()).filter(Boolean).slice(0, 30);
      }
      save('overrides.json', OV); return ok();
    }
    if (p === '/api/upload-image' && POST) {
      if (!need()) return; const b = JSON.parse(await body(req, 9e6)), mm = /^data:image\/(jpeg|png|webp|gif);base64,(.+)$/s.exec(b.data || '');
      if (!mm) return J(req, res, { error: 'Image invalide' }, 400); const buf = Buffer.from(mm[2], 'base64'); if (buf.length > 6e6) return J(req, res, { error: 'Image trop lourde (6 Mo max)' }, 413);
      const f = sha(buf).slice(0, 16) + '.' + (mm[1] === 'jpeg' ? 'jpg' : mm[1]); fs.writeFileSync(path.join(CUST, f), buf); return J(req, res, { url: '/custom/' + f });
    }
    if (p === '/api/upload-theme' && POST) {
      if (!need()) return; const b = JSON.parse(await body(req, 18e6)), mm = /^data:audio\/(mpeg|mp3|mp4|x-m4a|aac|ogg|wav|x-wav|flac);base64,(.+)$/s.exec(b.data || '');
      if (!mm) return J(req, res, { error: 'Fichier audio invalide (mp3, m4a, ogg ou wav)' }, 400); const buf = Buffer.from(mm[2], 'base64'); if (buf.length > 12e6) return J(req, res, { error: 'Fichier trop lourd (12 Mo maximum)' }, 413);
      const ext = { mpeg: 'mp3', mp3: 'mp3', mp4: 'm4a', 'x-m4a': 'm4a', aac: 'm4a', ogg: 'ogg', wav: 'wav', 'x-wav': 'wav', flac: 'flac' }[mm[1]], f = sha(buf).slice(0, 16) + '.' + ext;
      fs.writeFileSync(path.join(CUST, f), buf); return J(req, res, { url: '/custom/' + f });
    }
    if (p === '/api/theme-search') {
      if (!need()) return; const qq = String(q.get('q') || '').trim(); if (qq.length < 2) return J(req, res, []);
      try {
        const r = await (await fetch('https://itunes.apple.com/search?' + new URLSearchParams({ term: qq, media: 'music', entity: 'song', limit: '30', country: 'FR' }), { signal: AbortSignal.timeout(8000) })).json();
        return J(req, res, (r.results || []).filter(x => x.previewUrl).map(x => ({ name: x.trackName, artist: x.artistName, album: x.collectionName, art: x.artworkUrl60 || '', preview: x.previewUrl })));
      } catch { return J(req, res, { error: 'Recherche indisponible (Internet requis)' }, 502); }
    }
    if (p === '/api/match/search') {
      if (!need()) return; if (!cfg.tmdb) return J(req, res, []);
      const tv = q.get('type') === 'shows', qq = { query: q.get('q') || '' }; if (q.get('year')) qq[tv ? 'first_air_date_year' : 'year'] = q.get('year');
      try { const r = await tmdb('/search/' + (tv ? 'tv' : 'movie'), qq, q.get('lang') || 'fr-FR'); return J(req, res, (r.results || []).slice(0, 10).map(x => ({ id: x.id, title: x.title || x.name, year: (x.release_date || x.first_air_date || '').slice(0, 4), poster: px(x.poster_path ? IMG + 'w185' + x.poster_path : ''), overview: (x.overview || '').slice(0, 220) }))); } catch (e) { return J(req, res, { error: e.message }, 502); }
    }
    if (p === '/api/match/set' && POST) {
      if (!need()) return; const b = JSON.parse(await body(req)), mk = String(b.mk || ''), tv = mk.startsWith('shows|'), lang = mk.split('|')[3] || 'fr-FR';
      try { meta[mk] = shape(await tmdb('/' + (tv ? 'tv/' : 'movie/') + (+b.id), { append_to_response: APPEND(tv) }, lang), tv, lang); save('meta.json', meta); return ok(); } catch (e) { return J(req, res, { error: e.message }, 502); }
    }

    /* --- administration --- */
    if (p === '/api/browse') {
      if (!need()) return; const qq = normPath(q.get('path')), home = os.homedir();
      const FR = { Videos: 'Vidéos', Movies: 'Films', Downloads: 'Téléchargements', Desktop: 'Bureau', Documents: 'Documents' };
      const places = Object.keys(FR).map(n => ({ name: FR[n], path: path.join(home, n) })).filter(x => fs.existsSync(x.path));
      if (!qq && process.platform === 'win32') {
        const t = L => Promise.race([fs.promises.access(L + ':\\').then(() => L), new Promise(r => setTimeout(() => r(null), 1500))]).catch(() => null);
        const found = (await Promise.all([...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map(t))).filter(Boolean);
        return J(req, res, { path: '', parent: null, places, dirs: found.map(L => ({ name: 'Disque ' + L + ':', path: L + ':\\' })) });
      }
      let d = qq || '/'; if (process.platform === 'win32' && /^[a-zA-Z]:$/.test(d)) d += '\\';
      try {
        const dirs = fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && !/^[.$]/.test(e.name)).map(e => ({ name: e.name, path: path.join(d, e.name) })).sort((x, y) => x.name.localeCompare(y.name)), par = path.dirname(d);
        return J(req, res, { path: d, parent: par !== d ? par : (process.platform === 'win32' ? '' : null), places: qq ? [] : places, dirs });
      } catch { return J(req, res, { error: 'Dossier introuvable ou inaccessible' }, 400); }
    }
    if (p === '/api/scan' && POST) { if (!need()) return; setImmediate(scan); return ok(); }
    if (p === '/api/scan-status') {
      let pending = 0; if (cfg.tmdb) { const seen = new Set(); for (const i of index) { if (i.type === 'other') continue; const k = mkey(i); if (!meta[k] && !seen.has(k)) { seen.add(k); pending++; } } }
      return J(req, res, { ...SCANSTAT, count: index.length, enriching, pending, tmdbErr });
    }
    if (p === '/api/library-action' && POST) {
      if (!need()) return; const b = JSON.parse(await body(req));
      if (b.action === 'refresh') { for (const i of index) { if (b.mk ? mkey(i) === b.mk : (!b.uid || (cfg.libraries[i.libId] || {}).uid === b.uid)) delete meta[mkey(i)]; } save('meta.json', meta); setImmediate(enrich); }
      if (b.action === 'clear-cache') { for (const d of [IMGC, SUBC]) try { fs.readdirSync(d).forEach(f => fs.unlinkSync(path.join(d, f))); } catch {} PROBES.clear(); }
      return ok();
    }
    if (p === '/api/categories') {
      if (POST) {
        if (!need()) return; const b = JSON.parse(await body(req)), nm = x => String(x || '').trim().slice(0, 40);
        if (b.action === 'create' && nm(b.name) && !cats.list.includes(nm(b.name))) cats.list.push(nm(b.name));
        if (b.action === 'delete') { cats.list = cats.list.filter(x => x !== b.name); for (const k in cats.map) { cats.map[k] = cats.map[k].filter(x => x !== b.name); if (!cats.map[k].length) delete cats.map[k]; } }
        if (b.action === 'set' && index[b.id]) { const c = (b.cats || []).map(nm).filter(Boolean), k = itemKey(index[b.id]); c.forEach(x => { if (!cats.list.includes(x)) cats.list.push(x); }); if (c.length) cats.map[k] = c; else delete cats.map[k]; }
        cats.list.sort((a, b) => a.localeCompare(b)); save('categories.json', cats);
      }
      return J(req, res, { list: cats.list });
    }
    if (p === '/api/admin/users') {
      if (!need()) return;
      if (POST) {
        const b = JSON.parse(await body(req));
        if (b.action === 'save' && b.user) {
          const d = b.user; let x = d.id && U.users.find(y => y.id === d.id); if (!x) { x = { id: rid(), pin: '' }; U.users.push(x); }
          x.name = String(d.name || '').trim().slice(0, 30) || 'Profil';
          if (d.pin) { if (!/^\d{4,8}$/.test(String(d.pin))) return J(req, res, { error: 'Le PIN doit contenir 4 à 8 chiffres.' }, 400); x.pin = hashPin(d.pin); } else if (d.clearPin) x.pin = '';
          x.kid = !!d.kid; x.admin = !!d.admin && !x.kid; x.iptv = d.iptv !== false; x.libs = Array.isArray(d.libs) ? d.libs : null;
          if (!U.users.some(y => y.admin)) x.admin = true;
        } else if (b.action === 'delete') {
          const x = U.users.find(y => y.id === b.id);
          if (x && !(x.admin && U.users.filter(y => y.admin).length === 1) && U.users.length > 1) { U.users = U.users.filter(y => y.id !== b.id); for (const k in U.sessions) if (U.sessions[k].uid === b.id) delete U.sessions[k]; delete ST[b.id]; save('state.json', ST); }
          else return J(req, res, { error: 'Impossible de supprimer le dernier administrateur.' }, 400);
        }
        saveU();
      }
      return J(req, res, { users: U.users.map(x => ({ ...pubUser(x), libs: x.libs, iptv: x.iptv !== false })) });
    }
    if (p === '/api/activity') {
      if (!need()) return; const st = { movies: 0, episodes: 0, size: 0, other: 0 }, shows = new Set();
      for (const i of index) { st.size += i.size; if (i.type === 'shows') { st.episodes++; shows.add(i.show); } else if (i.type === 'movies') st.movies++; else st.other++; }
      st.shows = shows.size; st.libs = cfg.libraries.length; st.users = U.users.length;
      return J(req, res, { now: Object.values(SES).filter(s => Date.now() - s.last < 45000), hist: HIST.slice(0, 30), stats: st, uptime: Math.round((Date.now() - STARTED) / 1000), transcodes: ACTIVE.size, scan: SCANSTAT, version: VERSION });
    }
    if (p === '/api/logs') { if (!need()) return; return J(req, res, { lines: LOGS.slice(-200) }); }
    if (p === '/api/ffmpeg') { if (!need()) return; return J(req, res, { ffmpeg: !!FFMPEG, ffprobe: !!FFPROBE, encoders: ENC, install: FFINST, platform: process.platform }); }
    if (p === '/api/ffmpeg/install' && POST) { if (!need()) return; return J(req, res, { started: installFFmpeg(), platform: process.platform }); }
    if (p === '/api/network') return J(req, res, { urls: lanUrls(), ffmpeg: !!FFMPEG, port: PORT, apk: !!apkPath() });
    res.writeHead(404); res.end();
  } catch (e) { log('Erreur ' + req.method + ' ' + req.url.slice(0, 80) + ' : ' + e.message); if (!res.headersSent) J(req, res, { error: String(e.message || e) }, 500); else res.end(); }
});
let portTries = 0;
const onListening = () => {
  log(`TBSA-Serveur ${VERSION} prêt → http://localhost:${PORT}`);
  log('Dossier des données (réglages, profils, progression) : ' + DATA + (DATA_NOTE ? ' · ' + DATA_NOTE : ''));
  log('Configuration chargée : ' + cfg.libraries.length + ' bibliothèque(s), ' + U.users.length + ' profil(s)');
  lanUrls().forEach(x => log('Depuis la télé / un autre appareil → ' + x));
  log(FFMPEG ? 'ffmpeg détecté : lecture de tous les formats activée' + (ENC.length ? ' (encodeurs : ' + ENC.join(', ') + ')' : '') : 'ffmpeg non trouvé : Réglages → Transcodeur pour l’installer (formats MKV/AVI/TS…)');
  try { fs.writeFileSync(path.join(DATA, 'port.txt'), String(PORT)); } catch {}
  if (!process.env.TBSA_NOOPEN && (process.pkg || process.env.TBSA_OPEN) && process.platform === 'win32') require('child_process').exec(`start http://localhost:${PORT}`);
};
SRV.on('error', async e => {
  if (e && e.code === 'EADDRINUSE') {
    const own = await fetch(`http://localhost:${PORT}/api/ping`, { signal: AbortSignal.timeout(2500) }).then(r => r.json()).then(j => !!j && j.name === 'TBSA-Serveur').catch(() => false);
    if (own) { console.log('TBSA-Serveur est déjà lancé : ouverture de http://localhost:' + PORT); if (process.platform === 'win32' && !process.env.TBSA_NOOPEN) require('child_process').exec('start http://localhost:' + PORT); return setTimeout(() => process.exit(0), 1500); }
    if (!FORCED_PORT && ++portTries <= 10) { log(`Le port ${PORT} est déjà utilisé par un autre programme (Plex ?). Essai du port ${PORT + 1}…`); PORT++; return SRV.listen(PORT, '0.0.0.0'); }
    return waitKey('Le port ' + PORT + ' est utilisé par un autre programme. Fermez-le ou choisissez un autre port (variable PORT).');
  }
  onFatal(e);
});
SRV.once('listening', onListening);
SRV.listen(PORT, '0.0.0.0');
scan(); schedule();
