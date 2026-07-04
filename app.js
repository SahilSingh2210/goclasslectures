/* ================================================================
   CourseHub — Application Logic  (v2 — fixed uploads + PDF notes)
   ================================================================ */
'use strict';

/* ============================================================
   1. INDEXED DB — stores video + PDF Blobs
   ============================================================ */
const VideoDB = (() => {
  const DB_NAME = 'courseHubAssets';
  const STORE   = 'assets';          // one store for videos AND pdfs
  let db = null;

  async function open() {
    if (db) return;
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = e => {
        const idb = e.target.result;
        if (!idb.objectStoreNames.contains(STORE)) idb.createObjectStore(STORE);
      };
      req.onsuccess = e => { db = e.target.result; res(); };
      req.onerror   = () => rej(req.error);
    });
  }

  async function save(id, blob) {
    await open();
    return new Promise((res, rej) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(blob, id);
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  }

  async function get(id) {
    await open();
    return new Promise((res, rej) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => rej(req.error);
    });
  }

  async function remove(id) {
    await open();
    return new Promise((res, rej) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = () => res();
      req.onerror   = () => rej(req.error);
    });
  }

  return { save, get, remove };
})();

/* ============================================================
   1b. GOOGLE DRIVE — auth + upload/download
   ============================================================ */
const GDRIVE_API    = 'https://www.googleapis.com/drive/v3';
const GDRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const DriveAuth = {
  getClientId()      { return localStorage.getItem('ch_gdrive_cid') || ''; },
  setClientId(id)    { localStorage.setItem('ch_gdrive_cid', id.trim()); },

  _tokenData()       { try { return JSON.parse(localStorage.getItem('ch_gdrive_tok') || 'null'); } catch { return null; } },
  getToken()         { const d = this._tokenData(); return (d && Date.now() < d.exp - 120000) ? d.tok : null; },
  saveToken(t, exp)  { localStorage.setItem('ch_gdrive_tok', JSON.stringify({ tok: t, exp: Date.now() + exp * 1000 })); },
  clearToken()       { localStorage.removeItem('ch_gdrive_tok'); localStorage.removeItem('ch_gdrive_folder'); _driveFolderId = null; },
  isConnected()      { return !!this.getToken(); },

  async requestToken() {
    const cid = this.getClientId();
    if (!cid) throw new Error('No Client ID set. Open ⚙️ Settings first.');
    if (typeof google === 'undefined' || !google?.accounts?.oauth2)
      throw new Error('Google Identity Services not loaded. Make sure you opened the app via http://localhost and not file://');
    return new Promise((res, rej) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: cid,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: r => {
          if (r.error) { rej(new Error(r.error_description || r.error)); return; }
          this.saveToken(r.access_token, r.expires_in || 3600);
          res(r.access_token);
        }
      });
      client.requestAccessToken({ prompt: '' });
    });
  },

  async getValidToken() {
    return this.getToken() || this.requestToken();
  },

  async disconnect() {
    const t = this.getToken();
    if (t && typeof google !== 'undefined') google.accounts.oauth2.revoke(t, () => {});
    this.clearToken();
    updateDriveNavBadge();
  }
};

let _driveFolderId = null;

const DriveStorage = {
  async getFolder(token) {
    if (_driveFolderId) return _driveFolderId;
    const cached = localStorage.getItem('ch_gdrive_folder');
    if (cached) { _driveFolderId = cached; return _driveFolderId; }

    const q   = encodeURIComponent("name='CourseHub' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    const res = await fetch(`${GDRIVE_API}/files?q=${q}&fields=files(id)&spaces=drive`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.files?.length) {
      _driveFolderId = data.files[0].id;
    } else {
      const cr = await fetch(`${GDRIVE_API}/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'CourseHub', mimeType: 'application/vnd.google-apps.folder' })
      });
      _driveFolderId = (await cr.json()).id;
    }
    localStorage.setItem('ch_gdrive_folder', _driveFolderId);
    return _driveFolderId;
  },

  async upload(file, token, onProgress) {
    const folderId  = await this.getFolder(token);
    const mimeType  = file.type || 'application/octet-stream';
    if (file.size <= 5 * 1024 * 1024) return this._simple(file, mimeType, folderId, token);
    return this._resumable(file, mimeType, folderId, token, onProgress);
  },

  async _simple(file, mime, folderId, token) {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name: file.name, parents: [folderId] })], { type: 'application/json' }));
    form.append('file', file);
    const res = await fetch(`${GDRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
    });
    if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text()}`);
    return (await res.json()).id;
  },

  async _resumable(file, mime, folderId, token, onProgress) {
    const init = await fetch(`${GDRIVE_UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': file.size
      },
      body: JSON.stringify({ name: file.name, parents: [folderId] })
    });
    if (!init.ok) throw new Error(`Drive init ${init.status}`);
    const uploadUrl = init.headers.get('location');

    const CHUNK = 8 * 1024 * 1024;
    let offset = 0;
    while (offset < file.size) {
      const end   = Math.min(offset + CHUNK, file.size);
      const res   = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${end-1}/${file.size}`, 'Content-Type': mime },
        body: file.slice(offset, end)
      });
      if (res.status === 200 || res.status === 201) { onProgress?.(1); return (await res.json()).id; }
      if (res.status === 308) {
        const rng = res.headers.get('range');
        offset = rng ? parseInt(rng.split('-')[1]) + 1 : end;
        onProgress?.(offset / file.size);
      } else throw new Error(`Drive chunk ${res.status} at ${offset}`);
    }
    throw new Error('Resumable upload ended without 200/201');
  },

  async getBlob(driveFileId, token) {
    const res = await fetch(`${GDRIVE_API}/files/${driveFileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Drive download ${res.status}`);
    return res.blob();
  },

  async deleteFile(driveFileId, token) {
    await fetch(`${GDRIVE_API}/files/${driveFileId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
    }).catch(() => {});
  }
};

/* ── Nav badge helper (updated after connect/disconnect) ── */
function updateDriveNavBadge() {
  const btn = document.getElementById('nav-drive-btn');
  if (!btn) return;
  const connected = DriveAuth.isConnected();
  btn.title = connected ? 'Google Drive connected — click to manage' : 'Connect Google Drive';
  btn.querySelector('.drive-dot')?.classList.toggle('drive-dot-on', connected);
}

/* ============================================================
   1c. DRIVE METADATA SYNC
   Stores course list as coursehub_courses.json in Google Drive
   so ALL devices share the same course library.
   ============================================================ */
const DriveMeta = {
  FILE_NAME: 'coursehub_courses.json',
  _fileId:   null,

  async _findFileId(token) {
    if (this._fileId) return this._fileId;
    const cached = localStorage.getItem('ch_gdrive_meta_id');
    if (cached) { this._fileId = cached; return this._fileId; }

    const q   = encodeURIComponent(`name='${this.FILE_NAME}' and trashed=false`);
    const res = await fetch(`${GDRIVE_API}/files?q=${q}&fields=files(id)&spaces=drive`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.files?.length) {
      this._fileId = data.files[0].id;
      localStorage.setItem('ch_gdrive_meta_id', this._fileId);
    }
    return this._fileId;
  },

  /* Pull latest courses.json from Drive → returns array or null */
  async load(token) {
    try {
      const fid = await this._findFileId(token);
      if (!fid) return null;
      const res = await fetch(`${GDRIVE_API}/files/${fid}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  },

  /* Push courses array to Drive (create or update courses.json) */
  async save(token, courses) {
    const folderId = await DriveStorage.getFolder(token);
    const fileId   = await this._findFileId(token);
    const blob     = new Blob([JSON.stringify(courses)], { type: 'application/json' });
    const form     = new FormData();
    const meta     = fileId ? {} : { name: this.FILE_NAME, parents: [folderId] };
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', blob);

    const res = await fetch(
      fileId
        ? `${GDRIVE_UPLOAD}/files/${fileId}?uploadType=multipart&fields=id`
        : `${GDRIVE_UPLOAD}/files?uploadType=multipart&fields=id`,
      { method: fileId ? 'PATCH' : 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form }
    );
    if (!res.ok) throw new Error(`Meta save ${res.status}`);
    if (!fileId) {
      this._fileId = (await res.json()).id;
      localStorage.setItem('ch_gdrive_meta_id', this._fileId);
    }
  }
};

/* Service Worker promise — resolves to the active SW for Drive streaming */
let _swPromise = null;

/* ============================================================
   2. LOCAL STORAGE — course metadata, progress, history
   ============================================================ */
const Store = {
  getCourses() {
    try { return JSON.parse(localStorage.getItem('ch_courses') || '[]'); }
    catch { return []; }
  },
  saveCourses(arr) {
    localStorage.setItem('ch_courses', JSON.stringify(arr));
    // Background-sync to Drive so other devices see the change
    if (DriveAuth.isConnected()) {
      DriveAuth.getValidToken()
        .then(tok => DriveMeta.save(tok, arr))
        .catch(e  => console.warn('[DriveMeta] sync failed:', e));
    }
  },
  getCourse(id)    { return this.getCourses().find(c => c.id === id) || null; },
  addCourse(c)     { const arr = this.getCourses(); arr.unshift(c); this.saveCourses(arr); },
  async deleteCourse(id) {
    const c = this.getCourse(id);
    if (c) {
      const driveToken = DriveAuth.isConnected() ? await DriveAuth.getValidToken().catch(() => null) : null;
      for (const l of c.lessons) {
        if (l.storageMode === 'gdrive') {
          if (driveToken) {
            await DriveStorage.deleteFile(l.driveVideoId, driveToken).catch(() => {});
            if (l.drivePdfId) await DriveStorage.deleteFile(l.drivePdfId, driveToken).catch(() => {});
          }
        } else {
          await VideoDB.remove(l.videoId).catch(() => {});
          if (l.pdfId) await VideoDB.remove(l.pdfId).catch(() => {});
        }
      }
    }
    this.saveCourses(this.getCourses().filter(c => c.id !== id));
    Object.keys(localStorage)
      .filter(k => k.startsWith(`ch_prog_${id}`))
      .forEach(k => localStorage.removeItem(k));
    this.saveHistory(this.getHistory().filter(h => h.courseId !== id));
  },

  getProgress(courseId, lessonId) {
    try { return JSON.parse(localStorage.getItem(`ch_prog_${courseId}_${lessonId}`) || 'null'); }
    catch { return null; }
  },
  saveProgress(courseId, lessonId, data) {
    localStorage.setItem(`ch_prog_${courseId}_${lessonId}`, JSON.stringify(data));
  },
  getCourseProgress(courseId) {
    const c = this.getCourse(courseId);
    if (!c || !c.lessons.length) return { completed: 0, total: 0, pct: 0 };
    const total     = c.lessons.length;
    const completed = c.lessons.filter(l => {
      const p = this.getProgress(courseId, l.id);
      return p && p.completed;
    }).length;
    return { completed, total, pct: Math.round((completed / total) * 100) };
  },

  getHistory() {
    try { return JSON.parse(localStorage.getItem('ch_history') || '[]'); }
    catch { return []; }
  },
  saveHistory(arr) { localStorage.setItem('ch_history', JSON.stringify(arr.slice(0, 200))); },
  addToHistory(entry) {
    const arr = this.getHistory().filter(
      h => !(h.courseId === entry.courseId && h.lessonId === entry.lessonId)
    );
    arr.unshift({ ...entry, watchedAt: new Date().toISOString() });
    this.saveHistory(arr);
  },
  clearHistory() { localStorage.removeItem('ch_history'); }
};

/* ============================================================
   3. UTILITIES
   ============================================================ */
function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`
    : `${m}:${String(sc).padStart(2,'0')}`;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 6e4), h = Math.floor(diff / 36e5), d = Math.floor(diff / 864e5);
  if (m < 1)  return 'Just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7)  return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function dateLabel(iso) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

const GRADIENTS = [
  'linear-gradient(135deg,#667eea,#764ba2)',
  'linear-gradient(135deg,#f093fb,#f5576c)',
  'linear-gradient(135deg,#4facfe,#00f2fe)',
  'linear-gradient(135deg,#43e97b,#38f9d7)',
  'linear-gradient(135deg,#fa709a,#fee140)',
  'linear-gradient(135deg,#a18cd1,#fbc2eb)',
  'linear-gradient(135deg,#ffecd2,#fcb69f)',
  'linear-gradient(135deg,#2af598,#009efd)',
];

function gradientFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

function thumbHTML(course, cls = '') {
  if (course.thumbnailDataUrl) {
    return `<img src="${course.thumbnailDataUrl}" class="${cls}" alt="${esc(course.title)}" loading="lazy">`;
  }
  const initials = course.title.trim().split(/\s+/).slice(0,2).map(w => w[0].toUpperCase()).join('');
  return `<div class="${cls} course-thumb-placeholder" style="background:${gradientFor(course.title)}">${initials}</div>`;
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function showToast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  const icons = { success: '✓', error: '✕', info: 'i' };
  t.innerHTML = `<span class="toast-icon">${icons[type] || 'i'}</span><span>${esc(msg)}</span>`;
  container.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast-show'));
  setTimeout(() => {
    t.classList.remove('toast-show');
    setTimeout(() => t.remove(), 350);
  }, 3500);
}

/* ── File-picker helper ──────────────────────────────────────── */
function pickFile(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    let resolved = false;
    input.addEventListener('change', () => {
      resolved = true;
      resolve(input.files[0] || null);
      document.body.removeChild(input);
    });
    window.addEventListener('focus', function onFocus() {
      window.removeEventListener('focus', onFocus);
      setTimeout(() => { if (!resolved) { resolve(null); document.body.removeChild(input); } }, 400);
    }, { once: true });
    input.click();
  });
}

/* ── Folder-picker helper ─────────────────────────────────────── */
/**
 * Opens a folder picker and returns all video files inside,
 * already sorted in natural (numeric-aware) order.
 */
function pickFolder() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.multiple = true;
    // Keep off-screen but attached so browser can deliver files
    input.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none';
    document.body.appendChild(input);

    // Extension-based detection — covers formats Windows gives no MIME type for
    // (e.g. .mkv, .avi, .wmv, .mov all report type="" on many Windows installs)
    const VIDEO_EXTS = /\.(mp4|m4v|webm|ogg|ogv|mov|avi|mkv|wmv|flv|3gp|m2ts|mts|ts|mpg|mpeg|hevc|divx|xvid|rm|rmvb|asf)$/i;

    // Safety timeout: resolve empty after 5 minutes if change never fires
    // (much safer than focus-based detection which fires too early on Windows)
    let killTimer = setTimeout(() => {
      if (document.body.contains(input)) {
        document.body.removeChild(input);
        resolve([]);
      }
    }, 5 * 60 * 1000);

    input.addEventListener('change', () => {
      clearTimeout(killTimer);
      const all    = Array.from(input.files);
      const videos = all.filter(f =>
        f.type.startsWith('video/') || VIDEO_EXTS.test(f.name)
      );
      if (document.body.contains(input)) document.body.removeChild(input);
      // Debug help: if files were found but none are video, show what was found
      if (all.length > 0 && videos.length === 0) {
        const exts = [...new Set(all.map(f => f.name.split('.').pop().toLowerCase()))].join(', ');
        showToast(`No video files found (got: .${exts}). Try MP4, MKV, AVI, MOV, WebM.`, 'error');
      }
      resolve(naturalSort(videos));
    });

    input.click();
  });
}

/* ── Natural sort (Lecture 2 before Lecture 10) ──────────────── */
function naturalSort(files) {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/* ── Filename → pretty title ─────────────────────────────────── */
function fileNameToTitle(filename) {
  return filename
    .replace(/\.[^/.]+$/, '')        // strip extension
    .replace(/[_]+/g, ' ')           // underscores → spaces
    .replace(/[-]+/g, ' - ')         // dashes → spaced dash
    .trim();
}

/* ── Drag-onto-zone helper ───────────────────────────────────── */
function makeDraggable(zone, accept, onFile) {
  zone.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', e => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
  });
  zone.addEventListener('dragenter', e => { e.preventDefault(); });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    // Loose accept check
    const ok = accept.split(',').some(a => {
      a = a.trim();
      if (a.startsWith('.')) return file.name.toLowerCase().endsWith(a);
      if (a.endsWith('/*')) return file.type.startsWith(a.replace('/*',''));
      return file.type === a;
    });
    if (ok) onFile(file);
    else showToast(`File type not accepted. Expected: ${accept}`, 'error');
  });
}

/* ============================================================
   4. ROUTER
   ============================================================ */
const Router = {
  cleanup: null,
  init() {
    window.addEventListener('hashchange', () => this._route());
    this._route();
    const btn = document.getElementById('hamburger-btn');
    const mob = document.getElementById('mobile-nav');
    btn?.addEventListener('click', () => {
      btn.classList.toggle('open');
      btn.setAttribute('aria-expanded', btn.classList.contains('open'));
      mob.classList.toggle('open');
    });
    document.querySelectorAll('.mobile-nav-link').forEach(a =>
      a.addEventListener('click', () => { btn.classList.remove('open'); mob.classList.remove('open'); })
    );
  },
  _route() {
    if (typeof this.cleanup === 'function') { this.cleanup(); this.cleanup = null; }
    const hash   = window.location.hash || '#home';
    const [page, qs = ''] = hash.slice(1).split('?');
    const params = Object.fromEntries(
      qs ? qs.split('&').map(p => { const [k,v] = p.split('='); return [k, decodeURIComponent(v || '')]; }) : []
    );
    document.querySelectorAll('[data-page]').forEach(el =>
      el.classList.toggle('active', el.dataset.page === page)
    );
    const main = document.getElementById('main-content');
    if (!main) return;
    switch (page) {
      case 'home':    Views.home(main);     break;
      case 'upload':  Views.upload(main);   break;
      case 'player':  Views.player(main, params.courseId, parseInt(params.lesson || '0')); break;
      case 'history': Views.history(main);  break;
      case 'edit':    Views.editCourse(main, params.courseId); break;
      default:        Views.home(main);
    }
  },
  go(url) { window.location.hash = url; }
};

/* ============================================================
   5. VIEWS
   ============================================================ */
const Views = {

  /* ─── GOOGLE DRIVE SETTINGS MODAL ────────────────────────────── */
  openSettings() {
    const modal     = document.getElementById('drive-modal');
    const setup     = document.getElementById('drive-setup-view');
    const connected = document.getElementById('drive-connected-view');
    const input     = document.getElementById('drive-client-id-input');
    const hint      = document.getElementById('drive-input-hint');

    // Show the right panel
    const isConn = DriveAuth.isConnected();
    setup.classList.toggle('hidden', isConn);
    connected.classList.toggle('hidden', !isConn);

    // Pre-fill saved client ID
    if (input && DriveAuth.getClientId()) input.value = DriveAuth.getClientId();

    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.classList.add('drive-modal-visible'));

    function closeModal() {
      modal.classList.remove('drive-modal-visible');
      setTimeout(() => modal.classList.add('hidden'), 250);
    }

    document.getElementById('drive-modal-close').onclick    = closeModal;
    document.getElementById('btn-drive-modal-close2')?.addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); }, { once: true });

    // Connect button
    document.getElementById('btn-drive-connect').onclick = async () => {
      const cid = input.value.trim();
      if (!cid.includes('.apps.googleusercontent.com')) {
        hint.textContent = '⚠️ Paste a valid Client ID ending in .apps.googleusercontent.com';
        hint.style.color = 'var(--danger)';
        return;
      }
      DriveAuth.setClientId(cid);
      hint.textContent = 'Opening Google sign-in…';
      hint.style.color = 'var(--text-3)';
      try {
        await DriveAuth.requestToken();
        updateDriveNavBadge();
        showToast('✅ Google Drive connected! New uploads go to Drive.');
        setup.classList.add('hidden');
        connected.classList.remove('hidden');
        hint.textContent = '';
      } catch (e) {
        hint.textContent = '❌ ' + e.message;
        hint.style.color = 'var(--danger)';
      }
    };

    // Disconnect button
    document.getElementById('btn-drive-disconnect')?.addEventListener('click', async () => {
      await DriveAuth.disconnect();
      showToast('Google Drive disconnected. Uploads will save locally.');
      setup.classList.remove('hidden');
      connected.classList.add('hidden');
    });
  },

  /* ─── HOME ─────────────────────────────────────────────────────── */
  home(main) {
    const courses = Store.getCourses();
    const history = Store.getHistory();

    const inProgress = [];
    const seen = new Set();
    history.forEach(h => {
      if (seen.has(h.courseId)) return;
      const c = Store.getCourse(h.courseId);
      if (!c) return;
      const p = Store.getCourseProgress(h.courseId);
      if (p.pct > 0 && p.pct < 100) { seen.add(h.courseId); inProgress.push({ course: c, history: h, progress: p }); }
    });

    main.innerHTML = `
      <section class="hero">
        <div class="hero-badge">
          <svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#10b981"/></svg>
          Your personal learning platform
        </div>
        <h1>Learn at Your<br>Own Pace</h1>
        <p class="hero-sub">Upload courses, watch videos, and track your progress — all in one beautiful place.</p>
        <div class="hero-actions">
          <a href="#upload" class="btn btn-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Upload a Course
          </a>
          ${courses.length ? `<a href="#history" class="btn btn-secondary">View History</a>` : ''}
        </div>
      </section>

      ${inProgress.length ? `
      <section class="section">
        <div class="section-header">
          <div>
            <div class="section-title">Continue Watching</div>
            <div class="section-sub">${inProgress.length} course${inProgress.length>1?'s':''} in progress</div>
          </div>
          <a href="#history" class="section-link">See all history →</a>
        </div>
        <div class="continue-row">
          ${inProgress.map(item => {
            const { course: c, history: h, progress: p } = item;
            const li = c.lessons.findIndex(l => l.id === h.lessonId);
            const href = `#player?courseId=${c.id}&lesson=${Math.max(0,li)}`;
            return `<div class="continue-card" onclick="Router.go('${href}')" role="button" tabindex="0">
              <div class="continue-thumb-wrap">
                ${thumbHTML(c,'continue-thumb-placeholder')}
                <div class="continue-bar-wrap"><div class="continue-bar-fill" style="width:${p.pct}%"></div></div>
              </div>
              <div class="continue-body">
                <div class="continue-course-name">${esc(c.title)}</div>
                <div class="continue-lesson-name">${esc(h.lessonTitle||'Continue learning')}</div>
              </div>
            </div>`;
          }).join('')}
        </div>
      </section>` : ''}

      <section class="section">
        <div class="section-header">
          <div>
            <div class="section-title">My Courses</div>
            <div class="section-sub">${courses.length} course${courses.length!==1?'s':''} uploaded</div>
          </div>
          <a href="#upload" class="section-link">+ Add course</a>
        </div>
        ${courses.length === 0
          ? `<div class="empty-state">
              <div class="empty-icon">🎓</div>
              <h2>No courses yet</h2>
              <p>Upload your first course to get started.</p>
              <a href="#upload" class="btn btn-primary">Upload Your First Course</a>
            </div>`
          : `<div class="course-grid">${courses.map(c => this._courseCard(c)).join('')}</div>`
        }
      </section>`;

    main.querySelectorAll('.delete-course-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm(`Delete "${btn.dataset.title}"? This cannot be undone.`)) return;
        await Store.deleteCourse(btn.dataset.id);
        showToast('Course deleted');
        Views.home(main);
      });
    });
    main.querySelectorAll('.edit-course-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        Router.go(`#edit?courseId=${btn.dataset.id}`);
      });
    });
  },

  _courseCard(c) {
    const p = Store.getCourseProgress(c.id);
    const updatedLabel = c.updatedAt ? `Updated ${timeAgo(c.updatedAt)}` : `Created ${timeAgo(c.createdAt)}`;
    return `
    <div class="course-card" onclick="Router.go('#player?courseId=${c.id}&lesson=0')" role="button" tabindex="0">
      <div style="position:relative">
        ${thumbHTML(c,'course-thumb')}
        <div class="course-play-overlay">
          <div class="play-circle">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        </div>
        <div class="course-card-actions">
          <button class="card-action-btn edit-course-btn" data-id="${c.id}" title="Add / Edit lessons">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="card-action-btn delete-course-btn" data-id="${c.id}" data-title="${esc(c.title)}" title="Delete course">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
          </button>
        </div>
      </div>
      <div class="course-body">
        <div class="course-title">${esc(c.title)}</div>
        <div class="course-meta">
          <span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            ${c.lessons.length} lesson${c.lessons.length!==1?'s':''}
          </span>
          ${p.completed>0 ? `<span class="pill pill-${p.pct===100?'success':'primary'}">${p.pct===100?'✓ Complete':`${p.pct}%`}</span>`:''}
        </div>
        <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${p.pct}%"></div></div>
        <div class="progress-label"><span>${p.completed}/${p.total} lessons</span><span class="course-updated-label">${updatedLabel}</span></div>
      </div>
    </div>`;
  },

  /* ─── UPLOAD ─────────────────────────────────────────────────
     BUG FIXES:
     • Thumbnail: replaced div+JS-click with pickFile() helper so
       the programmatic .click() doesn't bubble back into the zone.
     • Video zones: same pickFile() approach — no <label for=> double-trigger.
     • Drag-drop: uses makeDraggable() helper with relatedTarget guard.
  ────────────────────────────────────────────────────────────── */
  upload(main) {
    main.innerHTML = `
    <div class="upload-page">
      <h1>📤 Upload a Course</h1>
      <p class="page-sub">Add your videos in order to create a full course. Drag lessons to reorder them.</p>

      <!-- Drive mode banner -->
      ${DriveAuth.isConnected() ? `
      <div class="drive-active-banner">
        <span class="drive-active-icon">
          <svg width="18" height="18" viewBox="0 0 87.3 78"><path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="M43.65 25L29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 00-1.2 4.5h27.5z" fill="#00ac47"/><path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.8l5.85 11.25z" fill="#ea4335"/><path d="M43.65 25L57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="M73.4 26.5l-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25 59.8 53h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg>
        </span>
        <div>
          <div class="drive-active-title">☁️ Google Drive is active</div>
          <div class="drive-active-sub">Videos will be uploaded to your Google Drive — <strong>zero laptop storage</strong> used.</div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="Views.openSettings()" type="button">Manage</button>
      </div>` : `
      <div class="drive-inactive-banner">
        <span>💾 Saving to browser storage (local)</span>
        <button class="btn btn-secondary btn-sm" onclick="Views.openSettings()" type="button">Connect Google Drive</button>
      </div>`}

      <!-- Step 1: Course Info -->
      <div class="form-card">
        <div class="form-card-title"><span class="badge">1</span>Course Information</div>
        <div class="form-group">
          <label class="form-label" for="course-title-input">Course Title *</label>
          <input id="course-title-input" class="form-input" type="text" placeholder="e.g. Complete JavaScript Mastery" maxlength="100" autocomplete="off">
        </div>
        <div class="form-group">
          <label class="form-label" for="course-desc-input">Description</label>
          <textarea id="course-desc-input" class="form-textarea" placeholder="What will students learn in this course?" rows="3"></textarea>
        </div>
      </div>

      <!-- Step 2: Thumbnail -->
      <div class="form-card">
        <div class="form-card-title">
          <span class="badge">2</span>
          Course Thumbnail <span style="font-weight:400;color:var(--text-3);font-size:0.82rem;">(optional)</span>
        </div>
        <!-- Zone is a plain div — click handled via pickFile() to avoid bubbling -->
        <div class="thumb-upload-zone" id="thumb-zone" role="button" tabindex="0" aria-label="Upload thumbnail image">
          <div id="thumb-placeholder">
            <div class="thumb-upload-icon">🖼️</div>
            <p>Drop an image here or <span>click to browse</span></p>
            <p style="font-size:0.76rem;color:var(--text-3);margin-top:5px;">JPG · PNG · WebP — 16:9 recommended</p>
          </div>
          <div class="thumb-preview-wrap" id="thumb-preview-wrap" style="display:none">
            <img id="thumb-preview-img" src="" alt="Thumbnail preview">
            <button class="thumb-preview-remove" id="thumb-remove-btn" type="button" title="Remove thumbnail">✕</button>
          </div>
        </div>
      </div>

      <!-- Step 3: Lessons -->
      <div class="form-card">
        <div class="form-card-title"><span class="badge">3</span>Course Lessons *</div>

        <!-- Folder upload banner -->
        <div class="folder-banner" id="folder-banner">
          <div class="folder-banner-left">
            <span class="folder-banner-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            </span>
            <div>
              <div class="folder-banner-title">Upload an entire folder at once</div>
              <div class="folder-banner-sub">Videos are sorted automatically (Lecture 1 → 2 → 3…) and file names become lesson titles</div>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm folder-pick-btn" id="btn-folder-upload" type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            Choose Folder
          </button>
        </div>

        <div class="lessons-list" id="lessons-list"></div>
        <div class="lesson-btn-row">
          <button class="add-lesson-btn" id="add-lesson-btn" type="button">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Lesson
          </button>
        </div>
      </div>

      <!-- Actions -->
      <div class="upload-actions">
        <a href="#home" class="btn btn-secondary">Cancel</a>
        <button class="btn btn-primary" id="publish-btn" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          Publish Course
        </button>
      </div>
    </div>`;

    /* ── State ── */
    let thumbFile = null;
    const lessonAssets   = {};   // lessonId -> { video: File|null, pdf: File|null }
    const lessonVideoFns = {};   // lessonId -> applyVideo fn (for folder import)
    let lessons = [];

    /* ── Thumbnail Zone ── */
    const thumbZone      = document.getElementById('thumb-zone');
    const thumbPrev      = document.getElementById('thumb-preview-wrap');
    const thumbPrevImg   = document.getElementById('thumb-preview-img');
    const thumbPlaceholder = document.getElementById('thumb-placeholder');

    function setThumb(file) {
      thumbFile = file;
      const reader = new FileReader();
      reader.onload = ev => {
        thumbPrevImg.src = ev.target.result;
        thumbPrev.style.display = 'block';
        thumbPlaceholder.style.display = 'none';
      };
      reader.readAsDataURL(file);
    }
    function clearThumb() {
      thumbFile = null;
      thumbPrevImg.src = '';
      thumbPrev.style.display = 'none';
      thumbPlaceholder.style.display = 'block';
    }

    // Click to pick — uses detached input so click never bubbles back to zone
    thumbZone.addEventListener('click', async e => {
      if (thumbFile) return; // show preview, don't re-open
      const f = await pickFile('image/*');
      if (f) setThumb(f);
    });
    thumbZone.addEventListener('keydown', async e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!thumbFile) { const f = await pickFile('image/*'); if (f) setThumb(f); }
      }
    });

    // Drag & drop onto thumbnail zone
    makeDraggable(thumbZone, 'image/*', setThumb);

    // Remove button — must stop propagation so zone click handler doesn't fire
    document.getElementById('thumb-remove-btn').addEventListener('click', e => {
      e.stopPropagation();
      clearThumb();
    });

    /* ── Lesson Builder ── */
    const lessonsList = document.getElementById('lessons-list');

    function addLesson(titleVal = '') {
      const id  = uid();
      const obj = { id, title: titleVal, videoId: uid(), pdfId: uid(), pdfName: null, duration: 0 };
      lessons.push(obj);
      lessonAssets[id] = { video: null, pdf: null };
      renderLessonItem(obj);
      return obj;
    }

    function renderLessonItem(lesson) {
      const idx = lessons.findIndex(l => l.id === lesson.id);
      const div = document.createElement('div');
      div.className = 'lesson-item';
      div.dataset.id = lesson.id;
      div.draggable = true;

      div.innerHTML = `
        <div class="drag-handle" title="Drag to reorder">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/>
            <circle cx="15" cy="5" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="19" r="1.5"/>
          </svg>
        </div>
        <div class="lesson-number" id="lesson-num-${lesson.id}">${idx + 1}</div>
        <div class="lesson-fields">
          <input class="lesson-title-input" type="text"
            placeholder="Lesson title (e.g. Introduction to Variables)"
            value="${esc(lesson.title)}" maxlength="120">

          <!-- ── Video Zone ── -->
          <div class="file-zone video-zone" id="video-zone-${lesson.id}" role="button" tabindex="0"
               aria-label="Add video for lesson ${idx+1}">
            <span class="file-zone-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>
              </svg>
            </span>
            <span class="file-zone-label" id="video-label-${lesson.id}">
              Click or drag a video here&nbsp;&nbsp;<span class="file-zone-hint">MP4 · WebM · OGG</span>
            </span>
            <span class="file-zone-meta" id="video-dur-${lesson.id}"></span>
            <button class="file-zone-clear hidden" id="video-clear-${lesson.id}" type="button" title="Remove video">✕</button>
          </div>

          <!-- ── PDF / Notes Zone ── -->
          <div class="file-zone pdf-zone" id="pdf-zone-${lesson.id}" role="button" tabindex="0"
               aria-label="Attach notes or PDF for lesson ${idx+1}">
            <span class="file-zone-icon pdf-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
            </span>
            <span class="file-zone-label" id="pdf-label-${lesson.id}">
              Attach notes / PDF <span class="file-zone-hint">(optional)</span>
            </span>
            <span class="file-zone-meta" id="pdf-size-${lesson.id}"></span>
            <button class="file-zone-clear hidden" id="pdf-clear-${lesson.id}" type="button" title="Remove PDF">✕</button>
          </div>

        </div>
        <button class="lesson-remove-btn" title="Remove lesson" aria-label="Remove lesson ${idx+1}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>`;

      /* ── Title sync ── */
      div.querySelector('.lesson-title-input').addEventListener('input', e => {
        lesson.title = e.target.value;
      });

      /* ── Video pick ── */
      const videoZone  = div.querySelector(`#video-zone-${lesson.id}`);
      const videoLabel = div.querySelector(`#video-label-${lesson.id}`);
      const videoDur   = div.querySelector(`#video-dur-${lesson.id}`);
      const videoClear = div.querySelector(`#video-clear-${lesson.id}`);

      function applyVideo(file) {
        lessonAssets[lesson.id].video = file;
        videoZone.classList.add('has-file');
        videoLabel.innerHTML = `<strong>${esc(file.name)}</strong>`;
        videoClear.classList.remove('hidden');
        const tmp  = document.createElement('video');
        tmp.preload = 'metadata';
        const burl  = URL.createObjectURL(file);
        tmp.onloadedmetadata = () => {
          lesson.duration = tmp.duration;
          videoDur.textContent = fmtTime(tmp.duration);
          URL.revokeObjectURL(burl);
        };
        tmp.src = burl;
      }
      // Register so folder-import can call it
      lessonVideoFns[lesson.id] = applyVideo;
      function clearVideo() {
        lessonAssets[lesson.id].video = null;
        lesson.duration = 0;
        videoZone.classList.remove('has-file');
        videoLabel.innerHTML = `Click or drag a video here&nbsp;&nbsp;<span class="file-zone-hint">MP4 · WebM · OGG</span>`;
        videoDur.textContent = '';
        videoClear.classList.add('hidden');
      }

      videoZone.addEventListener('click', async () => {
        const f = await pickFile('video/*');
        if (f) applyVideo(f);
      });
      videoZone.addEventListener('keydown', async e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const f = await pickFile('video/*'); if (f) applyVideo(f); }
      });
      makeDraggable(videoZone, 'video/*', applyVideo);
      videoClear.addEventListener('click', e => { e.stopPropagation(); clearVideo(); });

      /* ── PDF pick ── */
      const pdfZone  = div.querySelector(`#pdf-zone-${lesson.id}`);
      const pdfLabel = div.querySelector(`#pdf-label-${lesson.id}`);
      const pdfSize  = div.querySelector(`#pdf-size-${lesson.id}`);
      const pdfClear = div.querySelector(`#pdf-clear-${lesson.id}`);

      function applyPdf(file) {
        lessonAssets[lesson.id].pdf = file;
        lesson.pdfName = file.name;
        pdfZone.classList.add('has-file');
        pdfLabel.innerHTML = `<strong>${esc(file.name)}</strong>`;
        pdfSize.textContent = `${(file.size/1024).toFixed(0)} KB`;
        pdfClear.classList.remove('hidden');
      }
      function clearPdf() {
        lessonAssets[lesson.id].pdf = null;
        lesson.pdfName = null;
        pdfZone.classList.remove('has-file');
        pdfLabel.innerHTML = `Attach notes / PDF <span class="file-zone-hint">(optional)</span>`;
        pdfSize.textContent = '';
        pdfClear.classList.add('hidden');
      }

      pdfZone.addEventListener('click', async () => {
        const f = await pickFile('.pdf,application/pdf');
        if (f) applyPdf(f);
      });
      pdfZone.addEventListener('keydown', async e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const f = await pickFile('.pdf,application/pdf'); if (f) applyPdf(f); }
      });
      makeDraggable(pdfZone, '.pdf,application/pdf', applyPdf);
      pdfClear.addEventListener('click', e => { e.stopPropagation(); clearPdf(); });

      /* ── Remove lesson ── */
      div.querySelector('.lesson-remove-btn').addEventListener('click', () => {
        if (lessons.length === 1) { showToast('A course needs at least one lesson', 'error'); return; }
        lessons = lessons.filter(l => l.id !== lesson.id);
        delete lessonAssets[lesson.id];
        div.remove();
        renumberLessons();
      });

      /* ── Drag to reorder ── */
      div.addEventListener('dragstart', e => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', lesson.id);
        setTimeout(() => div.classList.add('dragging'), 0);
      });
      div.addEventListener('dragend', () => div.classList.remove('dragging'));
      div.addEventListener('dragover', e => {
        // Only handle if dragging a lesson (not a file)
        if (e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        lessonsList.querySelectorAll('.lesson-item').forEach(el => el.classList.remove('drag-over-above','drag-over-below'));
        const r = div.getBoundingClientRect();
        div.classList.add(e.clientY < r.top + r.height/2 ? 'drag-over-above' : 'drag-over-below');
      });
      div.addEventListener('dragleave', e => {
        if (!div.contains(e.relatedTarget)) div.classList.remove('drag-over-above','drag-over-below');
      });
      div.addEventListener('drop', e => {
        if (e.dataTransfer.types.includes('Files')) return; // let makeDraggable handle files
        e.preventDefault();
        div.classList.remove('drag-over-above','drag-over-below');
        const draggedId  = e.dataTransfer.getData('text/plain');
        if (draggedId === lesson.id) return;
        const fromIdx = lessons.findIndex(l => l.id === draggedId);
        const r       = div.getBoundingClientRect();
        const after   = e.clientY >= r.top + r.height/2;
        const [moved] = lessons.splice(fromIdx, 1);
        const toIdx   = lessons.findIndex(l => l.id === lesson.id);
        lessons.splice(after ? toIdx+1 : toIdx, 0, moved);
        rebuildLessonList();
      });

      lessonsList.appendChild(div);
    }

    function renumberLessons() {
      lessonsList.querySelectorAll('.lesson-item').forEach((el, i) => {
        const num = el.querySelector('[id^="lesson-num-"]');
        if (num) num.textContent = i + 1;
      });
    }
    function rebuildLessonList() {
      lessonsList.innerHTML = '';
      lessons.forEach(l => renderLessonItem(l));
    }

    document.getElementById('add-lesson-btn').addEventListener('click', () => {
      addLesson();
      setTimeout(() => lessonsList.lastElementChild?.scrollIntoView({ behavior:'smooth', block:'nearest' }), 60);
    });

    /* ── Folder Upload ── */
    document.getElementById('btn-folder-upload').addEventListener('click', async () => {
      const files = await pickFolder();
      if (!files.length) { showToast('No video files found in that folder', 'info'); return; }

      // If all current lessons are empty placeholders, wipe them first
      const allEmpty = lessons.every(l => !l.title.trim() && !lessonAssets[l.id]?.video);
      if (allEmpty) {
        lessonsList.innerHTML = '';
        lessons.forEach(l => delete lessonVideoFns[l.id]);
        lessons = [];
      }

      files.forEach(file => {
        const title  = fileNameToTitle(file.name);
        const lesson = addLesson(title);
        // Apply video via the registered fn (DOM is ready after addLesson)
        lessonVideoFns[lesson.id]?.(file);
      });

      showToast(`${files.length} video${files.length > 1 ? 's' : ''} imported and sorted! ✅`);
      setTimeout(() => lessonsList.firstElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
    });

    // Add first lesson (only if not folder-importing)
    addLesson();

    /* ── Publish ── */
    document.getElementById('publish-btn').addEventListener('click', async () => {
      const title = document.getElementById('course-title-input').value.trim();
      const desc  = document.getElementById('course-desc-input').value.trim();

      if (!title)              { showToast('Please enter a course title', 'error'); return; }
      if (!lessons.length)     { showToast('Add at least one lesson', 'error'); return; }

      for (let i = 0; i < lessons.length; i++) {
        if (!lessons[i].title.trim())          { showToast(`Give lesson ${i+1} a title`, 'error'); return; }
        if (!lessonAssets[lessons[i].id]?.video) { showToast(`Add a video to lesson ${i+1}`, 'error'); return; }
      }

      const overlay    = document.getElementById('upload-overlay');
      const overlayMsg  = document.getElementById('upload-overlay-msg');
      const overlayFill = document.getElementById('upload-overlay-fill');
      overlay.classList.remove('hidden');

      const useDrive   = DriveAuth.isConnected();
      let   driveToken = null;
      if (useDrive) {
        overlayMsg.textContent = 'Connecting to Google Drive…';
        try { driveToken = await DriveAuth.getValidToken(); }
        catch (e) { overlay.classList.add('hidden'); showToast('Drive auth failed: ' + e.message, 'error'); return; }
      }

      try {
        /* Thumbnail */
        let thumbnailDataUrl = '';
        if (thumbFile) {
          thumbnailDataUrl = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = e => res(e.target.result);
            r.onerror = rej;
            r.readAsDataURL(thumbFile);
          });
        }

        /* Save videos + PDFs */
        const savedLessons = [];
        for (let i = 0; i < lessons.length; i++) {
          const l      = lessons[i];
          const assets = lessonAssets[l.id];

          overlayMsg.textContent  = useDrive
            ? `☁️ Uploading lesson ${i+1} of ${lessons.length} to Google Drive…`
            : `Saving lesson ${i+1} of ${lessons.length}…`;
          overlayFill.style.width = `${Math.round((i / lessons.length) * 90)}%`;

          if (useDrive) {
            /* ── Google Drive path ── */
            const driveVideoId = await DriveStorage.upload(assets.video, driveToken, pct => {
              overlayFill.style.width = `${Math.round(((i + pct * 0.9) / lessons.length) * 90)}%`;
            });
            let drivePdfId = null;
            if (assets.pdf) drivePdfId = await DriveStorage.upload(assets.pdf, driveToken, null);

            savedLessons.push({
              id: l.id, title: l.title.trim(), duration: l.duration,
              storageMode: 'gdrive', driveVideoId, drivePdfId,
              pdfName: assets.pdf ? l.pdfName : null,
              // keep placeholder fields so old code doesn't break
              videoId: l.videoId, pdfId: null
            });
          } else {
            /* ── Local IndexedDB path ── */
            await VideoDB.save(l.videoId, assets.video);
            let pdfSaved = false;
            if (assets.pdf) { await VideoDB.save(l.pdfId, assets.pdf); pdfSaved = true; }

            savedLessons.push({
              id: l.id, title: l.title.trim(), duration: l.duration,
              storageMode: 'local', videoId: l.videoId,
              pdfId:   pdfSaved ? l.pdfId   : null,
              pdfName: pdfSaved ? l.pdfName : null
            });
          }
        }

        overlayFill.style.width = '100%';
        overlayMsg.textContent  = 'Finalising…';
        await new Promise(r => setTimeout(r, 300));

        Store.addCourse({ id: uid(), title, description: desc, thumbnailDataUrl,
          storageMode: useDrive ? 'gdrive' : 'local',
          createdAt: new Date().toISOString(), lessons: savedLessons });
        overlay.classList.add('hidden');
        showToast(useDrive ? `"☁️ ${title}" saved to Google Drive! 🎉` : `"${title}" published! 🎉`);
        Router.go('#home');

      } catch (err) {
        overlay.classList.add('hidden');
        console.error(err);
        showToast('Failed to save: ' + err.message, 'error');
      }
    });
  },

  /* ─── PLAYER ────────────────────────────────────────────────── */
  async player(main, courseId, lessonIdx) {
    const course = Store.getCourse(courseId);
    if (!course) {
      main.innerHTML = `<div class="empty-state" style="padding-top:100px">
        <div class="empty-icon">🔍</div><h2>Course not found</h2>
        <p>This course may have been deleted.</p>
        <a href="#home" class="btn btn-primary">Back to Home</a>
      </div>`;
      return;
    }

    lessonIdx = Math.max(0, Math.min(lessonIdx, course.lessons.length - 1));
    const lesson = course.lessons[lessonIdx];
    let blobUrl  = null;

    let progressInterval = null;
    let autoNextTimer    = null;

    Router.cleanup = () => {
      clearInterval(progressInterval);
      clearInterval(autoNextTimer);
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    };

    main.innerHTML = `
    <div class="player-page">
      <div class="player-header">
        <a href="#home" class="player-back-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </a>
        <div class="player-course-title">${esc(course.title)}</div>
        <a href="#edit?courseId=${esc(courseId)}" class="player-edit-btn" title="Add or edit lessons">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit Course
        </a>
      </div>

      <div class="player-layout">
        <!-- Main -->
        <div class="player-main">
          <div class="player-video-wrap" id="player-video-wrap">
            <div class="player-loading" id="player-loading"><div class="spinner"></div></div>
            <video id="main-video" preload="metadata" playsinline></video>

            <div class="player-controls-overlay" id="controls-overlay">
              <div class="center-play-indicator" id="center-indicator"></div>
              <div class="controls-seek">
                <input type="range" class="seek-bar" id="seek-bar" min="0" max="100" step="0.05" value="0" aria-label="Seek">
              </div>
              <div class="controls-bar">
                <button class="ctrl-btn" id="btn-skip-back" title="Back 10s (←)">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>
                </button>
                <button class="ctrl-btn play-btn" id="btn-play" title="Play/Pause (Space)">
                  <svg id="play-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  <svg id="pause-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                </button>
                <button class="ctrl-btn" id="btn-skip-fwd" title="Forward 10s (→)">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M18 13c0 3.31-2.69 6-6 6s-6-2.69-6-6 2.69-6 6-6v4l5-5-5-5v4c-4.42 0-8 3.58-8 8s3.58 8 8 8 8-3.58 8-8h-2z"/></svg>
                </button>
                <div class="time-display">
                  <span id="time-current">0:00</span>
                  <span style="opacity:0.5;margin:0 3px">/</span>
                  <span id="time-total">0:00</span>
                </div>
                <div class="controls-spacer"></div>
                <div class="volume-group">
                  <button class="ctrl-btn" id="btn-mute" title="Mute (M)">
                    <svg id="vol-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                      <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>
                    </svg>
                  </button>
                  <input type="range" class="volume-slider" id="vol-slider" min="0" max="1" step="0.02" value="1" aria-label="Volume">
                </div>
                <div class="speed-ctrl" id="speed-ctrl">
                  <button class="ctrl-btn speed-display-btn" id="speed-display" title="Playback speed (click to change)">
                    <span id="speed-label">1×</span>
                  </button>
                  <div class="speed-popup" id="speed-popup" style="display:none">
                    <div class="speed-popup-title">Playback Speed</div>
                    <div class="speed-presets">
                      <button class="speed-preset" data-v="0.5">0.5×</button>
                      <button class="speed-preset" data-v="0.75">0.75×</button>
                      <button class="speed-preset active" data-v="1">Normal</button>
                      <button class="speed-preset" data-v="1.25">1.25×</button>
                      <button class="speed-preset" data-v="1.5">1.5×</button>
                      <button class="speed-preset" data-v="1.75">1.75×</button>
                      <button class="speed-preset" data-v="2">2×</button>
                      <button class="speed-preset" data-v="2.5">2.5×</button>
                    </div>
                    <div class="speed-custom-row">
                      <label class="speed-custom-label">Custom</label>
                      <input type="number" class="speed-custom-input" id="speed-custom-input"
                             min="0.1" max="5" step="0.01" placeholder="e.g. 1.37">
                      <button class="speed-apply-btn" id="speed-apply-btn">Apply</button>
                    </div>
                  </div>
                </div>
                <button class="ctrl-btn" id="btn-fullscreen" title="Fullscreen (F)">
                  <svg id="fs-enter" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
                  <svg id="fs-exit" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="display:none"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/></svg>
                </button>
              </div>
            </div>

            <div class="autonext-bar hidden" id="autonext-bar">
              <div class="autonext-fill" id="autonext-fill"></div>
            </div>
          </div>

          <!-- Lesson Info -->
          <div class="player-info">
            <div class="player-lesson-title">${esc(lesson.title)}</div>
            <div class="player-lesson-meta">
              <span>Lesson ${lessonIdx+1} of ${course.lessons.length}</span>
              ${lesson.duration ? `<span>· ${fmtTime(lesson.duration)}</span>` : ''}
            </div>

            <!-- PDF / Notes Section -->
            ${lesson.pdfId && lesson.pdfName ? `
            <div class="lesson-notes-card" id="lesson-notes-card">
              <div class="notes-icon-wrap">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                  <polyline points="10 9 9 9 8 9"/>
                </svg>
              </div>
              <div class="notes-body">
                <div class="notes-title">Lesson Notes</div>
                <div class="notes-filename">${esc(lesson.pdfName)}</div>
              </div>
              <div class="notes-actions">
                <button class="btn btn-secondary btn-sm" id="btn-view-pdf">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  View PDF
                </button>
                <button class="btn btn-secondary btn-sm" id="btn-download-pdf">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Download
                </button>
              </div>
            </div>` : ''}

            <div class="player-nav-btns">
              ${lessonIdx > 0 ? `<button class="btn btn-secondary btn-sm" onclick="Router.go('#player?courseId=${esc(courseId)}&lesson=${lessonIdx-1}')">← Previous</button>` : ''}
              ${lessonIdx < course.lessons.length-1
                ? `<button class="btn btn-primary btn-sm" id="btn-next-lesson">Next Lesson →</button>`
                : `<span class="pill pill-success">🎉 Course Complete!</span>`}
            </div>
          </div>
        </div>

        <!-- Sidebar -->
        <div class="player-sidebar">
          <div class="sidebar-header">
            <div class="sidebar-course-title">${esc(course.title)}</div>
            <div id="sidebar-progress-wrap"></div>
          </div>
          <div class="sidebar-lessons" id="sidebar-lessons">
            ${course.lessons.map((l, i) => {
              const prog  = Store.getProgress(courseId, l.id);
              const done  = prog && prog.completed;
              const active = i === lessonIdx;
              return `
              <div class="sidebar-lesson-item ${active?'active':''}"
                   onclick="Router.go('#player?courseId=${esc(courseId)}&lesson=${i}')"
                   role="button" tabindex="0">
                <div class="lesson-status-dot ${done?'completed':active?'active':''}">
                  ${done
                    ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`
                    : active ? '▶' : i+1}
                </div>
                <div class="lesson-item-body">
                  <div class="lesson-item-num">Lesson ${i+1}</div>
                  <div class="lesson-item-title">${esc(l.title)}</div>
                  <div class="lesson-item-footer">
                    ${l.duration ? `<span class="lesson-item-duration">${fmtTime(l.duration)}</span>` : ''}
                    ${l.pdfId ? `<span class="lesson-pdf-badge">📄 Notes</span>` : ''}
                  </div>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>
    </div>`;

    this._renderSidebarProgress(courseId);

    main.querySelectorAll('.sidebar-lesson-item').forEach(el => {
      el.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') el.click(); });
    });

    /* ── PDF buttons ── */
    async function loadPdfBlob() {
      if (lesson.storageMode === 'gdrive') {
        try {
          showToast('Fetching notes from Drive…', 'info');
          const token = await DriveAuth.getValidToken();
          return await DriveStorage.getBlob(lesson.drivePdfId, token);
        } catch (e) { showToast('Could not load PDF: ' + e.message, 'error'); return null; }
      }
      const blob = await VideoDB.get(lesson.pdfId);
      if (!blob) { showToast('PDF not found in storage', 'error'); return null; }
      return blob;
    }

    document.getElementById('btn-view-pdf')?.addEventListener('click', async () => {
      const blob = await loadPdfBlob();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });

    document.getElementById('btn-download-pdf')?.addEventListener('click', async () => {
      const blob = await loadPdfBlob();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href = url; a.download = lesson.pdfName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });

    /* ── Load video ── */
    const video     = document.getElementById('main-video');
    const loading   = document.getElementById('player-loading');
    const videoWrap = document.getElementById('player-video-wrap');

    try {
      if (lesson.storageMode === 'gdrive') {
        /* ── Google Drive: stream via Service Worker (no full download!) ── */
        loading.innerHTML = `
          <div style="text-align:center">
            <div class="drive-load-icon">☁️</div>
            <p style="color:var(--text-2);margin:12px 0 6px;font-size:0.9rem">Connecting to Google Drive…</p>
            <div class="drive-load-bar"><div class="drive-load-fill" style="width:65%"></div></div>
          </div>`;

        const token = await DriveAuth.getValidToken();
        const sw    = _swPromise ? await _swPromise : null;

        if (sw) {
          /* Service Worker is active — send token and stream directly.
             The browser handles buffering, seeking, and range requests
             just like any normal video URL. No full download needed. */
          sw.postMessage({ type: 'DRIVE_TOKEN', fileId: lesson.driveVideoId, token });
          video.src = `./_drive/${lesson.driveVideoId}`;
          video.load();
          /* blobUrl stays null — nothing to revoke on cleanup */
        } else {
          /* SW not yet active (first ever page load) — fall back to
             full blob download. Will stream on next page load. */
          showToast('First load: downloading video (streaming on next open)', 'info');
          const blob = await DriveStorage.getBlob(lesson.driveVideoId, token);
          blobUrl    = URL.createObjectURL(blob);
          video.src  = blobUrl;
          video.load();
        }
      } else {
        /* ── Local IndexedDB ── */
        const blob = await VideoDB.get(lesson.videoId);
        if (!blob) throw new Error('Video not found in storage. Please re-upload the course.');
        blobUrl   = URL.createObjectURL(blob);
        video.src = blobUrl;
        video.load();
      }
    } catch (err) {
      loading.innerHTML = `<div style="text-align:center;padding:24px;max-width:340px">
        <p style="color:var(--danger);font-size:1.1rem;margin-bottom:10px">⚠️ Could not load video</p>
        <p style="color:var(--text-2);font-size:0.85rem;line-height:1.6">${esc(err.message)}</p>
        <a href="#home" class="btn btn-secondary btn-sm" style="margin-top:16px;display:inline-flex">← Back to Home</a>
      </div>`;
      return;
    }

    const savedProg = Store.getProgress(courseId, lesson.id);
    let historyAdded = false;

    video.addEventListener('loadedmetadata', () => {
      loading.style.display = 'none';
      document.getElementById('time-total').textContent = fmtTime(video.duration);
      if (savedProg && savedProg.position > 0 && savedProg.position < video.duration - 2) {
        video.currentTime = savedProg.position;
      }
    });
    video.addEventListener('waiting', () => { loading.style.display = 'flex'; });
    video.addEventListener('canplay', () => { loading.style.display = 'none'; });
    video.addEventListener('playing', () => { loading.style.display = 'none'; });

    /* ── Seek bar ── */
    const seekBar     = document.getElementById('seek-bar');
    const timeCurrent = document.getElementById('time-current');
    let isSeeking     = false;

    video.addEventListener('timeupdate', () => {
      if (isSeeking) return;
      const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
      seekBar.value = pct;
      seekBar.style.background = `linear-gradient(to right,var(--primary) ${pct}%,rgba(255,255,255,0.18) ${pct}%)`;
      timeCurrent.textContent  = fmtTime(video.currentTime);
    });
    seekBar.addEventListener('mousedown',  () => { isSeeking = true; });
    seekBar.addEventListener('touchstart', () => { isSeeking = true; }, { passive: true });
    seekBar.addEventListener('input', () => {
      const t = (seekBar.value / 100) * (video.duration || 0);
      video.currentTime = t;
      timeCurrent.textContent = fmtTime(t);
    });
    seekBar.addEventListener('mouseup',  () => { isSeeking = false; });
    seekBar.addEventListener('touchend', () => { isSeeking = false; });

    /* ── Play / Pause ── */
    const playIcon  = document.getElementById('play-icon');
    const pauseIcon = document.getElementById('pause-icon');
    const centerInd = document.getElementById('center-indicator');

    function setPlayState(playing) {
      playIcon.style.display  = playing ? 'none' : '';
      pauseIcon.style.display = playing ? ''     : 'none';
    }
    function flashCenter(playing) {
      centerInd.innerHTML = playing
        ? `<svg width="28" height="28" viewBox="0 0 24 24" fill="#fff"><polygon points="5 3 19 12 5 21"/></svg>`
        : `<svg width="24" height="24" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
      centerInd.classList.remove('flash');
      void centerInd.offsetWidth;
      centerInd.classList.add('flash');
    }

    document.getElementById('btn-play').addEventListener('click', () => {
      video.paused ? video.play().catch(()=>{}) : video.pause();
      flashCenter(!video.paused);
    });
    video.addEventListener('click', () => {
      video.paused ? video.play().catch(()=>{}) : video.pause();
      flashCenter(!video.paused);
    });
    video.addEventListener('play',  () => setPlayState(true));
    video.addEventListener('pause', () => setPlayState(false));

    /* ── Controls auto-hide ── */
    let hideTimer;
    function showControls() {
      videoWrap.classList.add('controls-visible');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (!video.paused) videoWrap.classList.remove('controls-visible'); }, 3000);
    }
    videoWrap.addEventListener('mousemove', showControls);
    videoWrap.addEventListener('touchstart', showControls, { passive: true });
    video.addEventListener('pause', () => videoWrap.classList.add('controls-visible'));

    /* ── Skip ── */
    document.getElementById('btn-skip-back').addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime-10); });
    document.getElementById('btn-skip-fwd').addEventListener('click',  () => { video.currentTime = Math.min(video.duration||0, video.currentTime+10); });

    /* ── Volume ── */
    const volSlider = document.getElementById('vol-slider');
    const volIcon   = document.getElementById('vol-icon');
    let lastVolume  = 1;

    volSlider.addEventListener('input', () => {
      video.volume = parseFloat(volSlider.value);
      video.muted  = video.volume === 0;
      updateVolIcon();
    });
    document.getElementById('btn-mute').addEventListener('click', () => {
      if (video.muted || video.volume===0) { video.muted=false; video.volume=lastVolume||0.8; volSlider.value=video.volume; }
      else { lastVolume=video.volume; video.muted=true; volSlider.value=0; }
      updateVolIcon();
    });
    function updateVolIcon() {
      const muted = video.muted || video.volume===0;
      volIcon.innerHTML = muted
        ? `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15" stroke="currentColor" stroke-width="2"/><line x1="17" y1="9" x2="23" y2="15" stroke="currentColor" stroke-width="2"/>`
        : `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>`;
    }

    /* ── Speed popup ── */
    const speedCtrl    = document.getElementById('speed-ctrl');
    const speedDisplay = document.getElementById('speed-display');
    const speedPopup   = document.getElementById('speed-popup');
    const speedLabel   = document.getElementById('speed-label');

    function setSpeed(val) {
      val = Math.max(0.1, Math.min(5, parseFloat(val.toFixed(2))));
      video.playbackRate = val;
      speedLabel.textContent = val === 1 ? '1×' : `${val}×`;
      speedPopup.querySelectorAll('.speed-preset').forEach(b => {
        b.classList.toggle('active', parseFloat(b.dataset.v) === val);
      });
    }

    speedDisplay.addEventListener('click', e => {
      e.stopPropagation();
      const open = speedPopup.style.display !== 'none';
      speedPopup.style.display = open ? 'none' : 'block';
    });

    speedPopup.querySelectorAll('.speed-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        setSpeed(parseFloat(btn.dataset.v));
        speedPopup.style.display = 'none';
      });
    });

    document.getElementById('speed-apply-btn').addEventListener('click', () => {
      const v = parseFloat(document.getElementById('speed-custom-input').value);
      if (isNaN(v) || v < 0.1 || v > 5) { showToast('Enter a speed between 0.1× and 5×', 'error'); return; }
      setSpeed(v);
      document.getElementById('speed-custom-input').value = '';
      speedPopup.style.display = 'none';
    });
    document.getElementById('speed-custom-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('speed-apply-btn').click();
    });

    // Close popup when clicking outside
    document.addEventListener('click', function closeSpeed(e) {
      if (!speedCtrl.contains(e.target)) speedPopup.style.display = 'none';
    });

    /* ── Fullscreen ── */
    document.getElementById('btn-fullscreen').addEventListener('click', () => {
      if (!document.fullscreenElement) videoWrap.requestFullscreen?.().catch(()=>{});
      else document.exitFullscreen?.();
    });
    document.addEventListener('fullscreenchange', () => {
      const fs = !!document.fullscreenElement;
      document.getElementById('fs-enter').style.display = fs ? 'none' : '';
      document.getElementById('fs-exit').style.display  = fs ? ''     : 'none';
    });

    /* ── Keyboard shortcuts ── */
    function onKey(e) {
      if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault();
          video.paused ? video.play() : video.pause(); flashCenter(!video.paused); break;
        case 'ArrowLeft':  e.preventDefault(); video.currentTime = Math.max(0, video.currentTime-10); break;
        case 'ArrowRight': e.preventDefault(); video.currentTime = Math.min(video.duration||0, video.currentTime+10); break;
        case 'ArrowUp':    e.preventDefault(); video.volume=Math.min(1,video.volume+0.1); volSlider.value=video.volume; updateVolIcon(); break;
        case 'ArrowDown':  e.preventDefault(); video.volume=Math.max(0,video.volume-0.1); volSlider.value=video.volume; updateVolIcon(); break;
        case 'm': case 'M': document.getElementById('btn-mute').click(); break;
        case 'f': case 'F': document.getElementById('btn-fullscreen').click(); break;
      }
    }
    document.addEventListener('keydown', onKey);

    const prevCleanup = Router.cleanup;
    Router.cleanup = () => {
      prevCleanup?.();
      document.removeEventListener('keydown', onKey);
    };

    /* ── Progress saving ── */
    progressInterval = setInterval(() => {
      if (!video.paused && video.currentTime > 0) {
        Store.saveProgress(courseId, lesson.id, { position: video.currentTime, completed: false, lastWatched: new Date().toISOString() });
      }
      if (!historyAdded && video.currentTime > 5) {
        historyAdded = true;
        Store.addToHistory({ courseId, lessonId: lesson.id, courseTitle: course.title, lessonTitle: lesson.title, lessonIndex: lessonIdx });
      }
    }, 4000);

    /* ── Video Ended ── */
    video.addEventListener('ended', () => {
      Store.saveProgress(courseId, lesson.id, { position: 0, completed: true, lastWatched: new Date().toISOString() });
      Store.addToHistory({ courseId, lessonId: lesson.id, courseTitle: course.title, lessonTitle: lesson.title, lessonIndex: lessonIdx });
      this._renderSidebarProgress(courseId);

      // Update dot in sidebar
      const dots = document.querySelectorAll('.lesson-status-dot');
      const dot  = dots[lessonIdx];
      if (dot) { dot.classList.add('completed'); dot.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`; }

      // Auto-advance
      if (lessonIdx < course.lessons.length - 1) {
        const bar  = document.getElementById('autonext-bar');
        const fill = document.getElementById('autonext-fill');
        bar.classList.remove('hidden');
        let pct = 0;
        autoNextTimer = setInterval(() => {
          pct += 2; fill.style.width = `${pct}%`;
          if (pct >= 100) { clearInterval(autoNextTimer); Router.go(`#player?courseId=${courseId}&lesson=${lessonIdx+1}`); }
        }, 100);
      }
    });

    document.getElementById('btn-next-lesson')?.addEventListener('click', () => { Router.go(`#player?courseId=${courseId}&lesson=${lessonIdx+1}`); });

    setTimeout(() => {
      document.querySelector('.sidebar-lesson-item.active')?.scrollIntoView({ behavior:'smooth', block:'center' });
    }, 300);
  },

  _renderSidebarProgress(courseId) {
    const el = document.getElementById('sidebar-progress-wrap');
    if (!el) return;
    const p = Store.getCourseProgress(courseId);
    el.innerHTML = `
      <div class="sidebar-progress-bar"><div class="sidebar-progress-fill" style="width:${p.pct}%"></div></div>
      <div class="sidebar-progress-label">${p.completed}/${p.total} complete — ${p.pct}%</div>`;
  },

  /* ─── EDIT COURSE ──────────────────────────────────────────── */
  async editCourse(main, courseId) {
    const course = Store.getCourse(courseId);
    if (!course) {
      main.innerHTML = `<div class="empty-state" style="padding-top:100px">
        <div class="empty-icon">🔍</div><h2>Course not found</h2>
        <p>This course may have been deleted.</p>
        <a href="#home" class="btn btn-primary">Back to Home</a>
      </div>`;
      return;
    }

    main.innerHTML = `
    <div class="upload-page">
      <div class="edit-page-header">
        <div>
          <h1>✏️ Edit Course</h1>
          <p class="page-sub">Add new lessons, reorder, rename, or remove — changes save instantly to your library.</p>
        </div>
        <div class="edit-page-stats">
          <span class="pill pill-primary">${course.lessons.length} lesson${course.lessons.length!==1?'s':''}</span>
          ${course.updatedAt
            ? `<span class="edit-stat-label">Updated ${timeAgo(course.updatedAt)}</span>`
            : `<span class="edit-stat-label">Created ${timeAgo(course.createdAt)}</span>`}
        </div>
      </div>

      <!-- Course Info -->
      <div class="form-card">
        <div class="form-card-title"><span class="badge">1</span>Course Information</div>
        <div class="form-group">
          <label class="form-label" for="edit-title">Course Title *</label>
          <input id="edit-title" class="form-input" type="text" value="${esc(course.title)}" maxlength="100" autocomplete="off">
        </div>
        <div class="form-group">
          <label class="form-label" for="edit-desc">Description</label>
          <textarea id="edit-desc" class="form-textarea" rows="3">${esc(course.description||'')}</textarea>
        </div>
      </div>

      <!-- Thumbnail -->
      <div class="form-card">
        <div class="form-card-title">
          <span class="badge">2</span>Course Thumbnail
          <span style="font-weight:400;color:var(--text-3);font-size:0.82rem;">(optional)</span>
        </div>
        <div class="thumb-upload-zone" id="thumb-zone" role="button" tabindex="0">
          <div id="thumb-placeholder" ${course.thumbnailDataUrl?'style="display:none"':''}>           
            <div class="thumb-upload-icon">🖼️</div>
            <p>Drop an image here or <span>click to browse</span></p>
            <p style="font-size:0.76rem;color:var(--text-3);margin-top:5px;">JPG · PNG · WebP — 16:9 recommended</p>
          </div>
          <div class="thumb-preview-wrap" id="thumb-preview-wrap" style="${course.thumbnailDataUrl?'':'display:none'}">
            <img id="thumb-preview-img" src="${esc(course.thumbnailDataUrl||'')}" alt="Thumbnail preview">
            <button class="thumb-preview-remove" id="thumb-remove-btn" type="button">✕</button>
          </div>
        </div>
      </div>

      <!-- Lessons -->
      <div class="form-card">
        <div class="form-card-title">
          <span class="badge">3</span>
          All Lessons
          <span class="edit-lesson-count" id="edit-lesson-count"></span>
        </div>
        <div class="edit-legend">
          <span class="legend-chip existing-chip">Existing</span>
          <span class="legend-chip new-chip">New</span>
          <span style="font-size:0.78rem;color:var(--text-3);">Drag to reorder · Click ✕ to remove</span>
        </div>
        <div class="lessons-list" id="lessons-list"></div>
        <button class="add-lesson-btn" id="add-lesson-btn" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add New Lesson
        </button>
      </div>

      <div class="upload-actions">
        <a href="#home" class="btn btn-secondary">Cancel</a>
        <button class="btn btn-primary" id="save-edit-btn" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Save Changes
        </button>
      </div>
    </div>`;

    /* ── State ── */
    // Unified lesson list: existing lessons marked isExisting=true
    let lessons = course.lessons.map(l => ({ ...l, isExisting: true, _delete: false }));
    const lessonAssets  = {};  // new lessons: { video: File, pdf: File|null }
    const newPdfAssets  = {};  // extra PDFs to attach to existing lessons
    lessons.forEach(l => { lessonAssets[l.id] = { video: null, pdf: null }; newPdfAssets[l.id] = null; });

    let thumbFile    = null;
    let thumbChanged = false;
    let thumbDataUrl = course.thumbnailDataUrl || '';

    function updateCount() {
      const visible = lessons.filter(l => !l._delete).length;
      const newCnt  = lessons.filter(l => !l.isExisting && !l._delete).length;
      const el = document.getElementById('edit-lesson-count');
      if (el) el.textContent = `${visible} total · ${newCnt} new`;
    }
    updateCount();

    /* ── Thumbnail ── */
    const thumbZone        = document.getElementById('thumb-zone');
    const thumbPrev        = document.getElementById('thumb-preview-wrap');
    const thumbPlaceholder = document.getElementById('thumb-placeholder');
    const thumbPrevImg     = document.getElementById('thumb-preview-img');

    function setThumb(file) {
      thumbFile = file; thumbChanged = true;
      const r = new FileReader();
      r.onload = ev => { thumbDataUrl = ev.target.result; thumbPrevImg.src = thumbDataUrl; thumbPrev.style.display='block'; thumbPlaceholder.style.display='none'; };
      r.readAsDataURL(file);
    }
    function clearThumb() {
      thumbFile = null; thumbChanged = true; thumbDataUrl = '';
      thumbPrevImg.src = ''; thumbPrev.style.display='none'; thumbPlaceholder.style.display='block';
    }
    thumbZone.addEventListener('click', async e => {
      if (e.target.closest('#thumb-remove-btn')) return;
      const f = await pickFile('image/*'); if (f) setThumb(f);
    });
    makeDraggable(thumbZone, 'image/*', setThumb);
    document.getElementById('thumb-remove-btn').addEventListener('click', e => { e.stopPropagation(); clearThumb(); });

    /* ── Lesson builder ── */
    const lessonsList = document.getElementById('lessons-list');

    function addNewLesson() {
      const id  = uid();
      const obj = { id, title: '', videoId: uid(), pdfId: uid(), pdfName: null, duration: 0, isExisting: false, _delete: false };
      lessons.push(obj);
      lessonAssets[id] = { video: null, pdf: null };
      renderItem(obj);
      updateCount();
    }

    function renderItem(lesson) {
      const div = document.createElement('div');
      div.className = `lesson-item ${lesson.isExisting ? 'existing-lesson-item' : 'new-lesson-item'}`;
      div.dataset.id = lesson.id;
      div.draggable = true;

      const visIdx = () => lessons.filter(l => !l._delete).findIndex(l => l.id === lesson.id) + 1;

      if (lesson.isExisting) {
        /* ── EXISTING lesson ── */
        div.innerHTML = `
          <div class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg></div>
          <div class="lesson-number existing-num" id="lesson-num-${lesson.id}">${visIdx()}</div>
          <div class="lesson-fields">
            <input class="lesson-title-input" type="text" placeholder="Lesson title" value="${esc(lesson.title)}" maxlength="120">
            <div class="existing-badges">
              <span class="existing-badge video-ok-badge">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                Video saved${lesson.duration ? ' · '+fmtTime(lesson.duration) : ''}
              </span>
              ${lesson.pdfId ? `<span class="existing-badge pdf-ok-badge">📄 Notes saved</span>` : ''}
            </div>
            ${!lesson.pdfId ? `
            <div class="file-zone pdf-zone" id="pdf-zone-${lesson.id}" role="button" tabindex="0">
              <span class="file-zone-icon pdf-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/></svg></span>
              <span class="file-zone-label" id="pdf-label-${lesson.id}">Attach notes / PDF <span class="file-zone-hint">(optional)</span></span>
              <span class="file-zone-meta" id="pdf-size-${lesson.id}"></span>
              <button class="file-zone-clear hidden" id="pdf-clear-${lesson.id}" type="button">✕</button>
            </div>` : ''}
          </div>
          <button class="lesson-remove-btn" title="Remove lesson"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;

        div.querySelector('.lesson-title-input').addEventListener('input', e => { lesson.title = e.target.value; });

        if (!lesson.pdfId) {
          const pz = div.querySelector(`#pdf-zone-${lesson.id}`);
          const pl = div.querySelector(`#pdf-label-${lesson.id}`);
          const ps = div.querySelector(`#pdf-size-${lesson.id}`);
          const pc = div.querySelector(`#pdf-clear-${lesson.id}`);
          function applyPdf(f) {
            newPdfAssets[lesson.id] = f; lesson.pdfName = f.name;
            pz.classList.add('has-file'); pl.innerHTML = `<strong>${esc(f.name)}</strong>`;
            ps.textContent = `${(f.size/1024).toFixed(0)} KB`; pc.classList.remove('hidden');
          }
          function clearPdf() {
            newPdfAssets[lesson.id] = null; lesson.pdfName = null;
            pz.classList.remove('has-file');
            pl.innerHTML = `Attach notes / PDF <span class="file-zone-hint">(optional)</span>`;
            ps.textContent=''; pc.classList.add('hidden');
          }
          pz.addEventListener('click', async () => { const f = await pickFile('.pdf,application/pdf'); if(f) applyPdf(f); });
          makeDraggable(pz, '.pdf,application/pdf', applyPdf);
          pc.addEventListener('click', e => { e.stopPropagation(); clearPdf(); });
        }

      } else {
        /* ── NEW lesson ── */
        div.innerHTML = `
          <div class="drag-handle"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg></div>
          <div class="lesson-number new-num" id="lesson-num-${lesson.id}">${visIdx()}</div>
          <div class="lesson-fields">
            <input class="lesson-title-input" type="text" placeholder="New lesson title" maxlength="120">
            <div class="file-zone video-zone" id="video-zone-${lesson.id}" role="button" tabindex="0">
              <span class="file-zone-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg></span>
              <span class="file-zone-label" id="video-label-${lesson.id}">Click or drag a video&nbsp;<span class="file-zone-hint">MP4 · WebM · OGG</span></span>
              <span class="file-zone-meta" id="video-dur-${lesson.id}"></span>
              <button class="file-zone-clear hidden" id="video-clear-${lesson.id}" type="button">✕</button>
            </div>
            <div class="file-zone pdf-zone" id="pdf-zone-${lesson.id}" role="button" tabindex="0">
              <span class="file-zone-icon pdf-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/></svg></span>
              <span class="file-zone-label" id="pdf-label-${lesson.id}">Attach notes / PDF <span class="file-zone-hint">(optional)</span></span>
              <span class="file-zone-meta" id="pdf-size-${lesson.id}"></span>
              <button class="file-zone-clear hidden" id="pdf-clear-${lesson.id}" type="button">✕</button>
            </div>
          </div>
          <button class="lesson-remove-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;

        div.querySelector('.lesson-title-input').addEventListener('input', e => { lesson.title = e.target.value; });

        const vz = div.querySelector(`#video-zone-${lesson.id}`);
        const vl = div.querySelector(`#video-label-${lesson.id}`);
        const vd = div.querySelector(`#video-dur-${lesson.id}`);
        const vc = div.querySelector(`#video-clear-${lesson.id}`);
        function applyVideo(f) {
          lessonAssets[lesson.id].video = f; vz.classList.add('has-file');
          vl.innerHTML = `<strong>${esc(f.name)}</strong>`; vc.classList.remove('hidden');
          const tmp = document.createElement('video'); const bu = URL.createObjectURL(f);
          tmp.onloadedmetadata = () => { lesson.duration=tmp.duration; vd.textContent=fmtTime(tmp.duration); URL.revokeObjectURL(bu); };
          tmp.src = bu;
        }
        function clearVideo() {
          lessonAssets[lesson.id].video=null; lesson.duration=0; vz.classList.remove('has-file');
          vl.innerHTML=`Click or drag a video&nbsp;<span class="file-zone-hint">MP4 · WebM · OGG</span>`;
          vd.textContent=''; vc.classList.add('hidden');
        }
        vz.addEventListener('click', async () => { const f = await pickFile('video/*'); if(f) applyVideo(f); });
        makeDraggable(vz, 'video/*', applyVideo);
        vc.addEventListener('click', e => { e.stopPropagation(); clearVideo(); });

        const pz = div.querySelector(`#pdf-zone-${lesson.id}`);
        const pl = div.querySelector(`#pdf-label-${lesson.id}`);
        const ps = div.querySelector(`#pdf-size-${lesson.id}`);
        const pc = div.querySelector(`#pdf-clear-${lesson.id}`);
        function applyPdf(f) {
          lessonAssets[lesson.id].pdf=f; lesson.pdfName=f.name; pz.classList.add('has-file');
          pl.innerHTML=`<strong>${esc(f.name)}</strong>`; ps.textContent=`${(f.size/1024).toFixed(0)} KB`; pc.classList.remove('hidden');
        }
        function clearPdf() {
          lessonAssets[lesson.id].pdf=null; lesson.pdfName=null; pz.classList.remove('has-file');
          pl.innerHTML=`Attach notes / PDF <span class="file-zone-hint">(optional)</span>`; ps.textContent=''; pc.classList.add('hidden');
        }
        pz.addEventListener('click', async () => { const f = await pickFile('.pdf,application/pdf'); if(f) applyPdf(f); });
        makeDraggable(pz, '.pdf,application/pdf', applyPdf);
        pc.addEventListener('click', e => { e.stopPropagation(); clearPdf(); });
      }

      /* ── Remove ── */
      div.querySelector('.lesson-remove-btn').addEventListener('click', () => {
        const visible = lessons.filter(l => !l._delete).length;
        if (visible <= 1) { showToast('A course needs at least one lesson', 'error'); return; }
        if (lesson.isExisting) {
          if (!confirm(`Remove "${lesson.title||'this lesson'}"? Its video will be permanently deleted.`)) return;
          lesson._delete = true; div.remove();
        } else {
          lessons = lessons.filter(l => l.id !== lesson.id);
          delete lessonAssets[lesson.id];
          div.remove();
        }
        renumber(); updateCount();
      });

      /* ── Drag to reorder (lesson rows only, not files) ── */
      div.addEventListener('dragstart', e => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', lesson.id);
        setTimeout(() => div.classList.add('dragging'), 0);
      });
      div.addEventListener('dragend', () => div.classList.remove('dragging'));
      div.addEventListener('dragover', e => {
        if (e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        lessonsList.querySelectorAll('.lesson-item').forEach(el => el.classList.remove('drag-over-above','drag-over-below'));
        const r = div.getBoundingClientRect();
        div.classList.add(e.clientY < r.top + r.height/2 ? 'drag-over-above' : 'drag-over-below');
      });
      div.addEventListener('dragleave', e => {
        if (!div.contains(e.relatedTarget)) div.classList.remove('drag-over-above','drag-over-below');
      });
      div.addEventListener('drop', e => {
        if (e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        div.classList.remove('drag-over-above','drag-over-below');
        const draggedId = e.dataTransfer.getData('text/plain');
        if (draggedId === lesson.id) return;
        const fromIdx = lessons.findIndex(l => l.id === draggedId);
        const r = div.getBoundingClientRect();
        const after = e.clientY >= r.top + r.height/2;
        const [moved] = lessons.splice(fromIdx, 1);
        const toIdx = lessons.findIndex(l => l.id === lesson.id);
        lessons.splice(after ? toIdx+1 : toIdx, 0, moved);
        rebuild();
      });

      lessonsList.appendChild(div);
    }

    function renumber() {
      let n = 1;
      lessonsList.querySelectorAll('[id^="lesson-num-"]').forEach(el => { el.textContent = n++; });
    }
    function rebuild() {
      lessonsList.innerHTML = '';
      lessons.filter(l => !l._delete).forEach(l => renderItem(l));
      updateCount();
    }

    // Render existing lessons
    lessons.forEach(l => renderItem(l));

    document.getElementById('add-lesson-btn').addEventListener('click', () => {
      addNewLesson();
      setTimeout(() => lessonsList.lastElementChild?.scrollIntoView({ behavior:'smooth', block:'nearest' }), 60);
    });

    /* ── Save ── */
    document.getElementById('save-edit-btn').addEventListener('click', async () => {
      const title = document.getElementById('edit-title').value.trim();
      const desc  = document.getElementById('edit-desc').value.trim();
      if (!title) { showToast('Please enter a course title', 'error'); return; }

      const visible = lessons.filter(l => !l._delete);
      if (!visible.length) { showToast('Add at least one lesson', 'error'); return; }

      for (let i = 0; i < visible.length; i++) {
        const l = visible[i];
        if (!l.title.trim()) { showToast(`Give lesson ${i+1} a title`, 'error'); return; }
        if (!l.isExisting && !lessonAssets[l.id]?.video) { showToast(`Add a video to new lesson ${i+1}`, 'error'); return; }
      }

      const overlay    = document.getElementById('upload-overlay');
      const overlayMsg  = document.getElementById('upload-overlay-msg');
      const overlayFill = document.getElementById('upload-overlay-fill');
      overlay.classList.remove('hidden');

      try {
        // Delete removed lessons from IndexedDB
        const deleted = lessons.filter(l => l._delete && l.isExisting);
        for (const l of deleted) {
          await VideoDB.remove(l.videoId).catch(()=>{});
          if (l.pdfId) await VideoDB.remove(l.pdfId).catch(()=>{});
        }

        // Save new lesson videos + PDFs
        const newLessons = visible.filter(l => !l.isExisting);
        for (let i = 0; i < newLessons.length; i++) {
          const l = newLessons[i];
          overlayMsg.textContent  = `Saving new lesson ${i+1} of ${newLessons.length}…`;
          overlayFill.style.width = `${Math.round((i / Math.max(newLessons.length,1)) * 65)}%`;
          await VideoDB.save(l.videoId, lessonAssets[l.id].video);
          if (lessonAssets[l.id].pdf) await VideoDB.save(l.pdfId, lessonAssets[l.id].pdf);
          else { l.pdfId = null; l.pdfName = null; }
        }

        // Save newly attached PDFs for existing lessons
        overlayMsg.textContent = 'Saving notes…'; overlayFill.style.width = '75%';
        for (const l of visible.filter(l => l.isExisting)) {
          if (newPdfAssets[l.id]) await VideoDB.save(l.pdfId, newPdfAssets[l.id]);
        }

        // Handle thumbnail
        let finalThumb = thumbDataUrl;
        if (thumbChanged && thumbFile) {
          finalThumb = await new Promise((res,rej) => {
            const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(thumbFile);
          });
        } else if (thumbChanged) {
          finalThumb = '';
        }

        overlayMsg.textContent = 'Saving course…'; overlayFill.style.width = '92%';

        const finalLessons = visible.map(l => ({
          id: l.id, title: l.title.trim(), videoId: l.videoId,
          pdfId: l.pdfId||null, pdfName: l.pdfName||null, duration: l.duration
        }));

        const courses = Store.getCourses();
        const idx = courses.findIndex(c => c.id === courseId);
        if (idx !== -1) {
          courses[idx] = { ...courses[idx], title, description: desc, thumbnailDataUrl: finalThumb, lessons: finalLessons, updatedAt: new Date().toISOString() };
          Store.saveCourses(courses);
        }

        overlayFill.style.width = '100%';
        await new Promise(r => setTimeout(r, 300));
        overlay.classList.add('hidden');
        showToast(`Course updated! ${newLessons.length ? newLessons.length+' new lesson'+(newLessons.length>1?'s':'')+' added.' : '✅'}`);
        Router.go('#home');

      } catch(err) {
        overlay.classList.add('hidden');
        console.error(err);
        showToast('Failed to save: ' + err.message, 'error');
      }
    });
  },

  /* ─── HISTORY ───────────────────────────────────────────────── */
  history(main) {
    const history = Store.getHistory();
    main.innerHTML = `
    <div class="history-page">
      <div class="history-page-header">
        <div>
          <h1>Watch History</h1>
          <p style="color:var(--text-2);font-size:0.9rem;margin-top:6px">${history.length} items</p>
        </div>
        ${history.length ? `<button class="btn btn-danger btn-sm" id="clear-history-btn">Clear All</button>` : ''}
      </div>
      ${history.length===0
        ? `<div class="empty-state">
            <div class="empty-icon">🕐</div><h2>No watch history yet</h2>
            <p>Start watching a course and your history will appear here.</p>
            <a href="#home" class="btn btn-primary">Browse Courses</a>
          </div>`
        : this._renderHistoryGroups(history)
      }
    </div>`;
    document.getElementById('clear-history-btn')?.addEventListener('click', () => {
      if (!confirm('Clear all watch history?')) return;
      Store.clearHistory(); showToast('History cleared'); Views.history(main);
    });
  },

  _renderHistoryGroups(history) {
    const groups = {};
    history.forEach(h => {
      const label = dateLabel(h.watchedAt);
      if (!groups[label]) groups[label] = [];
      groups[label].push(h);
    });
    return Object.entries(groups).map(([date, items]) => `
      <div class="history-date-group">
        <div class="history-date-label">${esc(date)}</div>
        ${items.map(h => {
          const c    = Store.getCourse(h.courseId);
          const href = c ? `#player?courseId=${h.courseId}&lesson=${h.lessonIndex??0}` : '#home';
          return `
          <div class="history-item" onclick="Router.go('${href}')" role="button" tabindex="0">
            <div class="history-thumb-wrap">
              ${c ? thumbHTML(c,'history-thumb-placeholder') : `<div class="history-thumb-placeholder" style="background:linear-gradient(135deg,#374151,#1f2937)">?</div>`}
            </div>
            <div class="history-item-body">
              <div class="history-course-name">${esc(h.courseTitle||'Unknown Course')}</div>
              <div class="history-lesson-name">${esc(h.lessonTitle||'Lesson')}</div>
              <div class="history-time">${timeAgo(h.watchedAt)}</div>
            </div>
            <div class="history-play-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
          </div>`;
        }).join('')}
      </div>`).join('');
  }
};

/* ============================================================
   6. INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  VideoDB.get('__warmup__').catch(() => {});
  Router.init();
  updateDriveNavBadge();

  /* —— Pull latest course list from Drive on startup ——
     This is what makes it cross-device:
     upload on laptop → courses.json saved to Drive →
     open on phone    → courses.json loaded here      */
  if (DriveAuth.isConnected()) {
    try {
      const tok     = await DriveAuth.getValidToken();
      const courses = await DriveMeta.load(tok);
      if (courses && Array.isArray(courses)) {
        localStorage.setItem('ch_courses', JSON.stringify(courses));
        // Re-render if we're on the home page
        const page = (window.location.hash || '#home').replace('#','').split('?')[0];
        if (page === 'home' || page === '') {
          const main = document.getElementById('main-content');
          if (main) Views.home(main);
        }
      }
    } catch (e) {
      console.warn('[DriveMeta] load failed:', e);
    }
  }
});
