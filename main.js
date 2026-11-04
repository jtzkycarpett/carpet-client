const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, Tray, Menu } = require('electron');
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch {}
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');
const { execFile } = cp;
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

const ROOT = path.join(app.getPath('appData'), '.carpetclient');
const LOGS = path.join(ROOT, 'carpet-logs');
const UA = 'jtzkycarpet/carpet-client/0.2.0 (github.com/jtzkycarpet/carpet-client)';
const CFG = path.join(app.getPath('userData'), 'config.json');
let win, mc = null;

const load = () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return {}; } };
const save = (o) => { fs.writeFileSync(CFG, JSON.stringify({ ...load(), ...o })); if ('instances' in o) rebuildQuick(); };
const getJSON = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': UA } }); if (!r.ok) throw new Error(`${u} → ${r.status}`); return r.json(); };
const user = () => (mc ? { name: mc.profile.name, id: mc.profile.id } : null);

// ---------- Microsoft login ----------
async function finishLogin(xbox) {
  mc = await xbox.getMinecraft();
  save({ token: xbox.save() });
  return user();
}
ipcMain.handle('auth:login', async () => finishLogin(await new Auth('select_account').launch('electron')));
ipcMain.handle('auth:restore', async () => {
  const t = load().token;
  if (!t) return null;
  try { return await finishLogin(await new Auth('select_account').refresh(t)); } catch { return null; }
});
ipcMain.handle('auth:logout', () => { mc = null; save({ token: null }); });

// ---------- Config & versions ----------
ipcMain.handle('cfg:get', () => load().cfg || {});
ipcMain.handle('cfg:set', (_, cfg) => save({ cfg }));
ipcMain.handle('versions', async () =>
  (await getJSON('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).versions.map(v => ({ id: v.id, type: v.type })));

// ---------- Fabric ----------
async function ensureFabric(mcv) {
  const loaders = await getJSON(`https://meta.fabricmc.net/v2/versions/loader/${mcv}`);
  if (!loaders.length) throw new Error(`Fabric does not support ${mcv}.`);
  const l = (loaders.find(x => x.loader.stable) || loaders[0]).loader.version;
  const id = `fabric-loader-${l}-${mcv}`;
  const f = path.join(ROOT, 'versions', id, id + '.json');
  if (!fs.existsSync(f)) {
    const j = await getJSON(`https://meta.fabricmc.net/v2/versions/loader/${mcv}/${l}/profile/json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(j));
  }
  return id;
}

// ---------- Instances ----------
const INST = path.join(ROOT, 'instances');
const SUBS = ['mods', 'resourcepacks', 'shaderpacks', 'schematics', 'saves', 'config'];
const KEYS = ['name', 'version', 'type', 'fabric', 'ram', 'lastPlayed', 'servers', 'lastServer'];
const insts = () => load().instances || [];
const find = (id) => insts().find(i => i.id === id);
const idir = (id, sub = '') => path.join(INST, id, sub);
ipcMain.handle('inst:list', () => insts());
function makeInst(o) {
  const name = String(o.name || '').trim();
  if (!name) throw new Error('Please enter a name.');
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'instance';
  let id = base, n = 2;
  while (find(id)) id = `${base}-${n++}`;
  SUBS.forEach(s => fs.mkdirSync(idir(id, s), { recursive: true }));
  const inst = { id, name, version: o.version, type: o.type, fabric: !!o.fabric, ram: o.ram || 4, created: Date.now(), lastPlayed: 0 };
  save({ instances: [...insts(), inst] });
  return inst;
}
const delInst = (id) => { fs.rmSync(idir(id), { recursive: true, force: true }); save({ instances: insts().filter(i => i.id !== id) }); };
ipcMain.handle('inst:create', (_, o) => makeInst(o));
ipcMain.handle('inst:update', (_, id, patch) => {
  if (!find(id)) throw new Error('Instance not found.');
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => KEYS.includes(k)));
  const list = insts().map(i => (i.id === id ? { ...i, ...clean } : i));
  save({ instances: list });
  return list.find(i => i.id === id);
});
ipcMain.handle('inst:delete', (_, id) => {
  if (!find(id)) return;
  fs.rmSync(idir(id), { recursive: true, force: true });
  save({ instances: insts().filter(i => i.id !== id) });
});
ipcMain.handle('inst:files', (_, id, sub) => {
  if (!find(id) || !SUBS.includes(sub)) return [];
  fs.mkdirSync(idir(id, sub), { recursive: true });
  return fs.readdirSync(idir(id, sub), { withFileTypes: true }).map(e => ({ name: e.name, dir: e.isDirectory() }));
});
ipcMain.handle('inst:remove', (_, id, sub, name) => {
  if (!find(id) || !SUBS.includes(sub)) return;
  fs.rmSync(path.join(idir(id, sub), path.basename(name)), { recursive: true, force: true });
});
ipcMain.handle('inst:open', (_, id, sub) => {
  if (!find(id)) return;
  const d = idir(id, SUBS.includes(sub) ? sub : '');
  fs.mkdirSync(d, { recursive: true });
  return shell.openPath(d);
});

// ---------- Modrinth ----------
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const TYPE_DIR = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const PACKS = [
  { id: 'crystal', name: 'Crystal PvP', desc: 'Smooth FPS for crystal fights.', mods: ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'sodium-extra', 'reeses-sodium-options', 'modmenu', 'zoomify'] },
  { id: 'sword', name: 'Sword PvP', desc: 'Light and clean for sword combat.', mods: ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'immediatelyfast', 'sodium-extra', 'modmenu', 'zoomify', 'appleskin'] },
  { id: 'pot', name: 'Pot PvP', desc: 'Performance plus hunger and health info.', mods: ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'appleskin', 'modmenu'] },
  { id: 'fps', name: 'Max FPS', desc: 'Every big performance mod.', mods: ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'modernfix', 'moreculling', 'sodium-extra', 'reeses-sodium-options'] },
  { id: 'builder', name: 'Builder', desc: 'Litematica schematics and build tools.', mods: ['fabric-api', 'sodium', 'litematica', 'malilib', 'minihud', 'tweakeroo', 'mouse-tweaks', 'modmenu'] },
];
ipcMain.handle('preset:list', () => PACKS.map(p => ({ id: p.id, name: p.name, desc: p.desc })));
ipcMain.handle('mods:search', async (_, o) => {
  const type = o.type || 'mod';
  const f = [[`project_type:${type}`]];
  if (type === 'mod' || type === 'modpack') f.push(['categories:fabric']);
  if (type === 'mod') (o.cats || []).forEach(c => f.push([`categories:${c}`]));
  if (type !== 'modpack' && o.mcv) f.push([`versions:${o.mcv}`]);
  const r = await getJSON(`https://api.modrinth.com/v2/search?limit=20&offset=${o.offset || 0}&index=${o.sort || 'relevance'}&query=${encodeURIComponent(o.query || '')}&facets=${encodeURIComponent(JSON.stringify(f))}`);
  return {
    total: r.total_hits,
    hits: r.hits.map(h => ({ id: h.project_id, title: h.title, desc: h.description, icon: h.icon_url, dl: h.downloads, follows: h.follows,
      updated: h.date_modified, author: h.author, cats: h.display_categories || h.categories, client: h.client_side, server: h.server_side })),
  };
});
async function installProject(projectId, type, mcv, dir, seen = new Set()) {
  if (seen.has(projectId)) return [];
  seen.add(projectId);
  const base = `https://api.modrinth.com/v2/project/${projectId}/version`;
  const lo = type === 'mod' ? '["fabric"]' : type === 'shader' ? '["iris"]' : null;
  const q = (ver) => {
    const p = [lo && `loaders=${encodeURIComponent(lo)}`, ver && `game_versions=${encodeURIComponent(JSON.stringify([mcv]))}`].filter(Boolean);
    return p.length ? `${base}?${p.join('&')}` : base;
  };
  let vs = await getJSON(q(true)), loose = false;
  if (!vs.length && type !== 'mod') { vs = await getJSON(q(false)); loose = true; }
  if (!vs.length) throw new Error(`No ${type === 'mod' ? 'Fabric ' : ''}version for ${mcv} found.`);
  const v = vs.find(x => x.version_type === 'release') || vs[0];
  const file = v.files.find(f => f.primary) || v.files[0];
  const out = [];
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file.filename);
  if (!fs.existsSync(dest)) {
    const r = await fetch(file.url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`Download failed (${r.status}).`);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    out.push(file.filename);
    if (loose) out.push(`⚠ ${file.filename} is not marked for ${mcv}`);
  }
  if (type === 'mod') for (const d of v.dependencies || []) {
    if (d.dependency_type !== 'required' || !d.project_id) continue;
    try { out.push(...await installProject(d.project_id, 'mod', mcv, dir, seen)); }
    catch { out.push(`⚠ Required mod (${d.project_id}) not available`); }
  }
  return out;
}
const modsOf = (id) => { const i = find(id); if (!i) throw new Error('Instance not found.'); return i; };
ipcMain.handle('content:install', async (_, instId, projectId, type) => {
  const i = modsOf(instId), dir = TYPE_DIR[type];
  if (!dir) throw new Error('Unknown content type.');
  const out = [];
  if (type === 'shader') {
    try { out.push(...await installProject('iris', 'mod', i.version, idir(instId, 'mods'))); }
    catch { out.push('⚠ Could not install Iris (needed for shaders)'); }
  }
  out.push(...await installProject(projectId, type, i.version, idir(instId, dir)));
  return out;
});
ipcMain.handle('mods:fabricApi', (_, instId) => installProject('fabric-api', 'mod', modsOf(instId).version, idir(instId, 'mods')));
const mcType = async (v) => ((await getJSON(MANIFEST)).versions.find(x => x.id === v) || {}).type || 'release';
const say = (t) => win && win.webContents.send('prog', t);

ipcMain.handle('preset:install', async (_, o) => {
  const p = PACKS.find(x => x.id === o.id);
  if (!p) throw new Error('Unknown pack.');
  const inst = makeInst({ name: p.name, version: o.version, type: await mcType(o.version), fabric: true, ram: 4 });
  const seen = new Set(), skipped = [];
  let n = 0;
  for (const slug of p.mods) {
    say(`Installing ${p.name}… ${++n} of ${p.mods.length} (${slug})`);
    try { await installProject(slug, 'mod', o.version, idir(inst.id, 'mods'), seen); } catch { skipped.push(slug); }
  }
  return { inst, skipped };
});

// Modrinth modpack (.mrpack) -> new instance
ipcMain.handle('modpack:install', async (_, projectId) => {
  const vs = await getJSON(`https://api.modrinth.com/v2/project/${projectId}/version?loaders=${encodeURIComponent('["fabric"]')}`);
  const v = vs.find(x => x.version_type === 'release') || vs[0];
  if (!v) throw new Error('No Fabric version of this modpack found.');
  const f = v.files.find(x => x.primary) || v.files[0];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pack-'));
  let inst;
  try {
    say('Downloading modpack…');
    const archive = path.join(tmp, 'pack.mrpack'), out = path.join(tmp, 'x');
    fs.writeFileSync(archive, Buffer.from(await (await fetch(f.url, { headers: { 'User-Agent': UA } })).arrayBuffer()));
    fs.mkdirSync(out);
    if ((await run('tar', ['-xf', archive, '-C', out], 120000)) === null) throw new Error('Could not unpack the modpack.');
    const idx = JSON.parse(fs.readFileSync(path.join(out, 'modrinth.index.json'), 'utf8')), d = idx.dependencies || {};
    if (!d.minecraft) throw new Error('This modpack has no Minecraft version.');
    if (d.forge || d.neoforge || d['quilt-loader']) throw new Error('This modpack needs a loader other than Fabric.');
    inst = makeInst({ name: idx.name || 'Modpack', version: d.minecraft, type: await mcType(d.minecraft), fabric: !!d['fabric-loader'], ram: 4 });
    const root = path.resolve(idir(inst.id)), files = (idx.files || []).filter(x => !x.env || x.env.client !== 'unsupported');
    let n = 0;
    for (let i = 0; i < files.length; i += 6) {
      await Promise.all(files.slice(i, i + 6).map(async (x) => {
        const dest = path.resolve(root, x.path);
        if (!dest.startsWith(root + path.sep)) return;
        const r = await fetch(x.downloads[0], { headers: { 'User-Agent': UA } });
        if (!r.ok) throw new Error(`Download failed: ${x.path} (${r.status})`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (x.hashes && x.hashes.sha1 && crypto.createHash('sha1').update(buf).digest('hex') !== x.hashes.sha1) throw new Error(`Checksum mismatch: ${x.path}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        say(`Installing modpack… ${++n} of ${files.length}`);
      }));
    }
    for (const o of ['overrides', 'client-overrides']) if (fs.existsSync(path.join(out, o))) fs.cpSync(path.join(out, o), root, { recursive: true });
    return inst;
  } catch (e) { if (inst) delInst(inst.id); throw e; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
ipcMain.handle('logs:open', () => { fs.mkdirSync(LOGS, { recursive: true }); return shell.openPath(LOGS); });

// ---------- Java finden ----------
const run = (cmd, args, t = 8000) => new Promise(r => execFile(cmd, args, { timeout: t }, (e, so, se) => r(e ? null : (se || so))));
async function findJavas() {
  const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const vendors = ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Eclipse Foundation', 'Semeru'];
  const dirs = [];
  for (const b of bases) for (const v of vendors) {
    try { for (const s of fs.readdirSync(path.join(b, v))) dirs.push(path.join(b, v, s, 'bin')); } catch {}
  }
  if (process.env.JAVA_HOME) dirs.push(path.join(process.env.JAVA_HOME, 'bin'));
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const cands = ['java', ...dirs.map(d => path.join(d, exe))].filter(c => c === 'java' || fs.existsSync(c));
  const out = [];
  for (const c of cands) {
    const o = await run(c, ['-version']);
    const m = o && o.match(/version "(\d+)(?:\.(\d+))?/);
    if (m) out.push({ path: c, major: +m[1] === 1 ? +m[2] : +m[1] });
  }
  return out;
}

function findJavaExe(dir) {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const r = findJavaExe(p); if (r) return r; }
      else if (e.name === exe && path.basename(dir) === 'bin') return p;
    }
  } catch {}
  return null;
}
// Downloads a matching Java automatically if none is installed
async function downloadJava(need, send) {
  const dir = path.join(ROOT, 'runtime', `java${need}`);
  let exe = findJavaExe(dir);
  if (exe) return exe;
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const ext = os === 'windows' ? 'zip' : 'tar.gz';
  send('status', `Downloading Java ${need}…`);
  const r = await fetch(`https://api.adoptium.net/v3/binary/latest/${need}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`);
  if (!r.ok) throw new Error(`Could not download Java ${need} (${r.status}).`);
  fs.mkdirSync(dir, { recursive: true });
  const arc = path.join(dir, `jre.${ext}`);
  fs.writeFileSync(arc, Buffer.from(await r.arrayBuffer()));
  send('status', 'Unpacking Java…');
  if ((await run('tar', ['-xf', arc, '-C', dir], 120000)) === null) throw new Error('Could not unpack Java.');
  fs.unlinkSync(arc);
  exe = findJavaExe(dir);
  if (!exe) throw new Error('Java was unpacked, but java.exe was not found.');
  return exe;
}

function needJava(id) {
  const m = id.match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21;
  const x = +m[1], p = +(m[2] || 0);
  return x >= 21 || (x === 20 && p >= 5) ? 21 : x >= 17 ? 17 : 8;
}

// ---------- Launch ----------
ipcMain.handle('launch', async (_, instId, server) => {
  const o = find(instId);
  if (!o) throw new Error('Instance not found.');
  if (!mc) throw new Error('Please sign in with Microsoft first.');
  const send = (c, d) => win.webContents.send(c, d);
  const need = needJava(o.version);
  const javas = await findJavas();
  const java = javas.filter(j => j.major >= need).sort((a, b) => a.major - b.major || (a.path === 'java') - (b.path === 'java'))[0];
  const st = (load().cfg || {}).settings || {};
  const javaPath = st.java && fs.existsSync(st.java) ? st.java : java ? java.path : await downloadJava(need, send);
  const qp = (v) => { const m = v.match(/^1\.(\d+)/); if (m) return +m[1] >= 20; const w = v.match(/^(\d\d)w(\d\d)/); return w ? +w[1] > 23 || (+w[1] === 23 && +w[2] >= 14) : true; };
  const extra = {
    ...(st.jvm ? { customArgs: String(st.jvm).split(/\s+/).filter(Boolean) } : {}),
    ...(st.gw || st.gh || st.fs ? { window: { width: +st.gw || undefined, height: +st.gh || undefined, fullscreen: !!st.fs } } : {}),
  };
  if (server && server.address) {
    const [h, p] = String(server.address).split(':');
    extra.customLaunchArgs = qp(o.version) ? ['--quickPlayMultiplayer', server.address] : ['--server', h, '--port', p || '25565'];
  }
  if ((await run(javaPath, ['-version'])) === null) {
    if (!java) fs.rmSync(path.join(ROOT, 'runtime', `java${need}`), { recursive: true, force: true });
    throw new Error(`Java does not start: ${javaPath}`);
  }
  const version = { number: o.version, type: o.type };
  if (o.fabric) { send('status', 'Preparing Fabric…'); version.custom = await ensureFabric(o.version); }
  SUBS.forEach(x => fs.mkdirSync(idir(o.id, x), { recursive: true }));
  const l = new Client();
  fs.mkdirSync(LOGS, { recursive: true });
  const stream = fs.createWriteStream(path.join(LOGS, `${o.id}-` + new Date().toISOString().replace(/[:.]/g, '-') + '.log'));
  const log = (t) => {
    t = String(t).replace(/(--accessToken\s+)\S+/g, '$1***'); // never write credentials to the log
    stream.write(t.endsWith('\n') ? t : t + '\n');
    send('log', t);
  };
  log(`[Launcher] Starting ${o.name} (${o.version}${o.fabric ? ' with Fabric' : ''}, ${o.ram} GB)`);
  l.on('progress', p => send('progress', p));
  l.on('data', d => { send('running'); log(d); });
  l.on('close', c => { log(`[Launcher] Minecraft closed (code ${c})`); stream.end(); send('closed', c); });
  const lines = [];
  l.on('debug', d => { lines.push(String(d)); if (lines.length > 40) lines.shift(); log('[Launcher] ' + d); });
  // Low-level hook: (1) run MCLC's Java check without cmd.exe, (2) pass launch arguments via a file
  let argLen = 0, last = 'nothing';
  const CP = cp.ChildProcess;
  const origSpawn = CP.prototype.spawn;
  const same = (x, y) => path.resolve(String(x)).toLowerCase() === path.resolve(String(y)).toLowerCase();
  CP.prototype.spawn = function (options) {
    if (/cmd\.exe$/i.test(options.file) && options.args.join(' ').includes('-version')) {
      options.file = javaPath; options.args = [javaPath, '-version']; options.windowsVerbatimArguments = false;
    }
    last = `${path.basename(options.file)} (${options.args.length} Args)`;
    if (same(options.file, javaPath) && !options.args.includes('-version')) {
      argLen = options.args.join(' ').length;
      if (need >= 17) {
        const f = path.join(ROOT, 'launch-args.txt');
        const plain = options.args;
        fs.writeFileSync(f, plain.slice(1).map(a => '"' + String(a).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join('\n'));
        options.args = [plain[0], '@' + f];
        try { return origSpawn.call(this, options); } catch (e) { options.args = plain; }
      }
    }
    return origSpawn.call(this, options);
  };
  let proc;
  try { proc = await l.launch({ authorization: mc.mclc(), root: ROOT, javaPath, ...extra, overrides: { detached: false, gameDirectory: idir(o.id), cwd: idir(o.id) }, version, memory: { max: `${o.ram}G`, min: '1G' } }); } finally { CP.prototype.spawn = origSpawn; }
  if (!proc) throw new Error('Launch failed: ' + (lines.filter(x => /could not|couldn|error|fail|exception|invalid/i.test(x)).pop() || lines.pop() || 'unknown error') + ` (Java: ${javaPath}, args: ${argLen}, last start: ${last})`);
});

// ---------- Wardrobe (skins) ----------
const SKINS = path.join(ROOT, 'skins');
const smeta = () => load().skins || [];
const token = () => { if (!mc) throw new Error('Please sign in with Microsoft first.'); return mc.mclc().access_token; };
const dataPng = (b) => 'data:image/png;base64,' + b.toString('base64');
function addSkin(buf, name, variant) {
  const img = nativeImage.createFromBuffer(buf), sz = img.getSize();
  if (img.isEmpty() || sz.width !== 64 || ![32, 64].includes(sz.height)) throw new Error('A skin must be a 64x64 PNG image.');
  fs.mkdirSync(SKINS, { recursive: true });
  const id = Date.now().toString(36);
  fs.writeFileSync(path.join(SKINS, id + '.png'), buf);
  const sk = { id, name: String(name).slice(0, 30), variant };
  save({ skins: [...smeta(), sk] });
  return sk;
}
ipcMain.handle('skin:list', () => smeta().flatMap(k => { try { return [{ ...k, data: dataPng(fs.readFileSync(path.join(SKINS, k.id + '.png'))) }]; } catch { return []; } }));
ipcMain.handle('skin:add', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Skin (PNG)', extensions: ['png'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  return addSkin(fs.readFileSync(r.filePaths[0]), path.basename(r.filePaths[0], '.png'), 'classic');
});
ipcMain.handle('skin:fromName', async (_, name) => {
  const p = await getJSON(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(String(name).trim())}`).catch(() => { throw new Error('Player not found.'); });
  const prof = await getJSON(`https://sessionserver.mojang.com/session/minecraft/profile/${p.id}`);
  const tex = JSON.parse(Buffer.from(prof.properties.find(x => x.name === 'textures').value, 'base64').toString()).textures.SKIN;
  if (!tex) throw new Error('This player has no custom skin.');
  const buf = Buffer.from(await (await fetch(tex.url)).arrayBuffer());
  return addSkin(buf, p.name, tex.metadata && tex.metadata.model === 'slim' ? 'slim' : 'classic');
});
ipcMain.handle('skin:set', (_, id, variant) => save({ skins: smeta().map(k => (k.id === id ? { ...k, variant: variant === 'slim' ? 'slim' : 'classic' } : k)) }));
ipcMain.handle('skin:delete', (_, id) => { fs.rmSync(path.join(SKINS, path.basename(id) + '.png'), { force: true }); save({ skins: smeta().filter(k => k.id !== id) }); });
ipcMain.handle('skin:apply', async (_, id) => {
  const k = smeta().find(x => x.id === id);
  if (!k) throw new Error('Skin not found.');
  const form = new FormData();
  form.append('variant', k.variant);
  form.append('file', new Blob([fs.readFileSync(path.join(SKINS, id + '.png'))], { type: 'image/png' }), 'skin.png');
  const r = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', { method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'User-Agent': UA }, body: form });
  if (!r.ok) throw new Error(r.status === 401 ? 'Your session expired. Sign out and sign in again.' : `Mojang refused the skin (${r.status}).`);
});
ipcMain.handle('skin:current', async () => {
  const r = await fetch('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: `Bearer ${token()}`, 'User-Agent': UA } });
  if (!r.ok) throw new Error('Could not load your current skin. Sign out and in again.');
  const sk = (await r.json()).skins.find(x => x.state === 'ACTIVE');
  if (!sk) throw new Error('No active skin found.');
  return { data: dataPng(Buffer.from(await (await fetch(sk.url)).arrayBuffer())), variant: String(sk.variant).toLowerCase() };
});

// ---------- Quick access: tray, jump list, shortcuts ----------
let tray, pendingQuick = null;
const launchArg = (argv) => { const a = argv.find(x => x.startsWith('--launch=')); return a ? a.slice(9) : null; };
pendingQuick = launchArg(process.argv);
function quick(id, server) { if (!win) return; win.show(); win.focus(); win.webContents.send('quick', { id, server }); }
function rebuildQuick() {
  if (!app.isReady()) return;
  const list = [...insts()].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
  if (process.platform === 'win32') {
    app.setUserTasks(list.slice(0, 5).map(i => ({ program: process.execPath, arguments: `--launch=${i.id}`, iconPath: process.execPath, iconIndex: 0, title: `Play ${i.name}`, description: i.version })));
  }
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 20, height: 20 }));
    tray.setToolTip('Carpet Client');
    tray.on('click', () => { win.show(); win.focus(); });
  }
  const joins = list.filter(i => i.lastServer).slice(0, 4);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Carpet Client', click: () => { win.show(); win.focus(); } }, { type: 'separator' },
    ...list.slice(0, 8).map(i => ({ label: `Play ${i.name}`, click: () => quick(i.id) })),
    ...(joins.length ? [{ type: 'separator' }, ...joins.map(i => ({ label: `Join ${i.lastServer.name} (${i.name})`, click: () => quick(i.id, i.lastServer) }))] : []),
    { type: 'separator' }, { label: 'Quit', role: 'quit' },
  ]));
}
ipcMain.handle('quick:pending', () => { const p = pendingQuick; pendingQuick = null; return p ? { id: p } : null; });
ipcMain.handle('inst:shortcut', (_, id) => {
  const i = find(id);
  if (!i) throw new Error('Instance not found.');
  const lnk = path.join(app.getPath('desktop'), `${i.name.replace(/[\\/:*?"<>|]/g, '')} - Carpet Client.lnk`);
  const args = (app.isPackaged ? '' : `"${app.getAppPath()}" `) + `--launch=${id}`;
  if (!shell.writeShortcutLink(lnk, 'create', { target: process.execPath, args, cwd: path.dirname(process.execPath), description: `Play ${i.name}`, icon: process.execPath, iconIndex: 0 })) throw new Error('Could not create the shortcut (Windows only).');
  return lnk;
});
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', (_, argv) => { const id = launchArg(argv); if (win) { win.show(); win.focus(); } if (id) quick(id); });

const CBG = () => path.join(app.getPath('userData'), 'custom-bg.jpg');
const bgData = () => (fs.existsSync(CBG()) ? 'data:image/jpeg;base64,' + fs.readFileSync(CBG()).toString('base64') : null);
ipcMain.handle('bg:pick', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  const img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) throw new Error('Could not read that image.');
  fs.writeFileSync(CBG(), (img.getSize().width > 1920 ? img.resize({ width: 1920 }) : img).toJPEG(85));
  return bgData();
});
ipcMain.handle('bg:get', () => bgData());
ipcMain.handle('bg:clear', () => fs.rmSync(CBG(), { force: true }));
ipcMain.handle('update:install', () => autoUpdater && autoUpdater.quitAndInstall());
ipcMain.handle('win', (_, a) => {
  if (!win) return;
  if (a === 'min') win.minimize();
  else if (a === 'max') (win.isMaximized() ? win.unmaximize() : win.maximize());
  else if (a === 'close') win.close();
});

app.whenReady().then(() => {
  if (!gotLock) return;
  win = new BrowserWindow({
    width: 1180, height: 720, minWidth: 980, minHeight: 620, frame: false, backgroundColor: '#14182b',
    autoHideMenuBar: true, title: 'Carpet Client',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
  rebuildQuick();
  if (app.isPackaged && autoUpdater) {
    autoUpdater.on('update-available', i => win.webContents.send('upd', { state: 'available', version: i.version }));
    autoUpdater.on('update-downloaded', i => win.webContents.send('upd', { state: 'ready', version: i.version }));
    autoUpdater.on('error', () => {});
    win.webContents.once('did-finish-load', () => autoUpdater.checkForUpdates().catch(() => {}));
  }
});
app.on('window-all-closed', () => app.quit());
