// Plain-text notes library. Every note is a normal .txt/.md file; categories are plain sub-folders (one level).
// A note is addressed by a "ref": "name.txt" (unsorted) or "Category/name.txt".
// Every ref is validated and rebuilt from checked parts, so nothing can reach outside the notes folder.
const fs = require('fs');
const path = require('path');

const EXTS = ['.txt', '.md'];
const MAX_NOTE = 5 * 1024 * 1024;   // largest note we will open or save
const MAX_VIEW = 2 * 1024 * 1024;   // largest chunk shown from an outside file
const TRASH_DAYS = 30;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const BAD = /[<>:"/\\|?*\u0000-\u001f]/;

function sanitizeTitle(t) {
  let s = String(t || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (s.length > 100) s = s.slice(0, 100).trim();
  if (!s) return 'Untitled';
  if (RESERVED.test(s)) return s + ' note';
  return s;
}

const isDirPath = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const makeRef = (cat, file) => (cat ? cat + '/' + file : file);

module.exports = function createNotes(getDir) {
  function dir() {
    const d = getDir();
    if (!isDirPath(d)) throw new Error('NOFOLDER');
    return d;
  }

  function checkCat(c) {
    if (typeof c !== 'string' || !c || BAD.test(c) || c.startsWith('.') || c !== c.trim()) {
      throw new Error('Invalid category name.');
    }
    return c;
  }

  function catDir(c) {
    checkCat(c);
    const d = path.join(dir(), c);
    if (!isDirPath(d)) throw new Error('That category no longer exists.');
    return d;
  }

  function checkFile(f) {
    if (typeof f !== 'string' || !f || BAD.test(f) || f.startsWith('.') || !EXTS.includes(path.extname(f).toLowerCase())) {
      throw new Error('Invalid note name.');
    }
    return f;
  }

  // Turn a ref into a real path. The note must exist.
  function resolve(ref) {
    if (typeof ref !== 'string') throw new Error('Invalid note name.');
    const parts = ref.split('/');
    if (parts.length > 2) throw new Error('Invalid note name.');
    const file = checkFile(parts[parts.length - 1]);
    const cat = parts.length === 2 ? parts[0] : '';
    const d = cat ? catDir(cat) : dir();
    const p = path.join(d, file);
    if (!fs.existsSync(p)) throw new Error('That note no longer exists.');
    return { p, d, cat, file };
  }

  function uniqueName(d, base, ext) {
    let n = base + ext, i = 2;
    while (fs.existsSync(path.join(d, n))) n = base + ' ' + (i++) + ext;
    return n;
  }

  function categories() {
    return fs.readdirSync(dir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  }

  function scan(d, cat, q, out) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith('.') || !EXTS.includes(path.extname(e.name).toLowerCase())) continue;
      const p = path.join(d, e.name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      const title = e.name.replace(/\.[^.]+$/, '');
      let snippet = '';
      if (q) {
        let hit = title.toLowerCase().includes(q);
        if (!hit && st.size <= 1024 * 1024) {
          try {
            const txt = fs.readFileSync(p, 'utf8');
            const i = txt.toLowerCase().indexOf(q);
            if (i >= 0) { hit = true; snippet = txt.slice(Math.max(0, i - 30), i + 70).replace(/\s+/g, ' ').trim(); }
          } catch { /* unreadable: skip */ }
        }
        if (!hit) continue;
      }
      out.push({ ref: makeRef(cat, e.name), cat, name: e.name, title, mtime: st.mtimeMs, snippet });
    }
  }

  function list(query) {
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    scan(dir(), '', q, out);
    for (const c of categories()) scan(path.join(dir(), c), c, q, out);
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  function read(ref) {
    const { p } = resolve(ref);
    if (fs.statSync(p).size > MAX_NOTE) throw new Error('That note is too large to open here (over 5 MB).');
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  }

  function save(ref, text) {
    const { p, d, file } = resolve(ref);
    if (typeof text !== 'string') throw new Error('Nothing to save.');
    if (Buffer.byteLength(text) > MAX_NOTE) throw new Error('Note is over the 5 MB limit.');
    const tmp = path.join(d, '.' + file + '.tmp');
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, p);          // replace in one step so a crash never leaves half a note
  }

  function create(title, cat) {
    const d = cat ? catDir(cat) : dir();
    const name = uniqueName(d, sanitizeTitle(title), '.txt');
    fs.writeFileSync(path.join(d, name), '');
    return makeRef(cat || '', name);
  }

  function rename(ref, newTitle) {
    const r = resolve(ref);
    const newFile = sanitizeTitle(newTitle) + path.extname(r.file);
    if (newFile === r.file) return ref;
    const target = path.join(r.d, newFile);
    if (fs.existsSync(target) && newFile.toLowerCase() !== r.file.toLowerCase()) {
      throw new Error('A note with that name already exists.');
    }
    fs.renameSync(r.p, target);
    return makeRef(r.cat, newFile);
  }

  function move(ref, targetCat) {
    const r = resolve(ref);
    const td = targetCat ? catDir(targetCat) : dir();
    if (td === r.d) return ref;
    const ext = path.extname(r.file);
    const name = uniqueName(td, r.file.slice(0, -ext.length), ext);
    fs.renameSync(r.p, path.join(td, name));
    return makeRef(targetCat || '', name);
  }

  function remove(ref) {
    const r = resolve(ref);
    const trash = path.join(dir(), '.trash');
    fs.mkdirSync(trash, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(r.p, path.join(trash, stamp + '_' + (r.cat ? r.cat + '__' : '') + r.file));
  }

  function catCreate(name) {
    const n = sanitizeTitle(name);
    const d = path.join(dir(), n);
    if (fs.existsSync(d)) throw new Error('A category with that name already exists.');
    fs.mkdirSync(d);
    return n;
  }

  function catRename(oldName, newName) {
    const od = catDir(oldName);
    const n = sanitizeTitle(newName);
    if (n === oldName) return oldName;
    const td = path.join(dir(), n);
    if (fs.existsSync(td) && n.toLowerCase() !== oldName.toLowerCase()) {
      throw new Error('A category with that name already exists.');
    }
    fs.renameSync(od, td);
    return n;
  }

  function catDelete(name) {
    const d = catDir(name);
    if (fs.readdirSync(d).length) throw new Error('Move or delete the notes in this category first.');
    fs.rmdirSync(d);
  }

  function purgeTrash() {
    const trash = path.join(dir(), '.trash');
    if (!isDirPath(trash)) return;
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    for (const f of fs.readdirSync(trash)) {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(f);
      if (!m) continue;               // not named by us: never touch it
      const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
      if (t < cutoff) { try { fs.rmSync(path.join(trash, f), { force: true }); } catch { /* skip */ } }
    }
  }

  function readExternal(p) {
    const st = fs.statSync(p);
    if (!st.isFile()) throw new Error('Not a file.');
    const len = Math.min(st.size, MAX_VIEW);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
    return { text: buf.toString('utf8').replace(/^\uFEFF/, ''), truncated: st.size > MAX_VIEW };
  }

  function importText(src) {
    const st = fs.statSync(src);
    if (!st.isFile() || st.size > MAX_NOTE) throw new Error('That file is too large to import (over 5 MB).');
    const text = fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
    const ext = path.extname(src).toLowerCase() === '.md' ? '.md' : '.txt';
    const name = uniqueName(dir(), sanitizeTitle(path.basename(src, path.extname(src))), ext);
    fs.writeFileSync(path.join(dir(), name), text);
    return name;
  }

  return { list, categories, read, save, create, rename, move, remove, catCreate, catRename, catDelete, purgeTrash, readExternal, importText };
};
module.exports.sanitizeTitle = sanitizeTitle;
