// Google Drive sync layer.
//
// Uses Google Identity Services (GIS) for an OAuth access token, then plain
// REST calls to the Drive API with that token. Scope is `drive.file`, so the
// app can only see files it creates — a single "Slowdowner" folder holding the
// uploaded MP3s and one JSON manifest (loops/sections/settings). The Client ID
// is supplied by the user (stored in localStorage), never hardcoded.
const CLIENT_ID_KEY = 'gdrive_client_id';
const FOLDER_KEY = 'gdrive_folder_id';
const TOKEN_KEY = 'gdrive_token';
const FOLDER_NAME = 'Slowdowner';
const MANIFEST_NAME = 'slowdowner-library.json';
// drive.readonly lets the app SEE audio files you drop into the folder yourself;
// drive.file lets it create/update its own uploads and the manifest.
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;

// Restore a cached token so a page refresh doesn't force a new sign-in. Tokens
// last ~1h; within that window we reuse it, and after it we try a silent
// refresh before prompting.
(function restoreToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (raw) {
      const t = JSON.parse(raw);
      if (t && t.token && t.expiry > Date.now()) { accessToken = t.token; tokenExpiry = t.expiry; }
    }
  } catch {}
})();

function storeToken() {
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: accessToken, expiry: tokenExpiry })); } catch {}
}
function clearToken() {
  accessToken = null;
  tokenExpiry = 0;
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
}

export function getClientId() {
  try { return localStorage.getItem(CLIENT_ID_KEY) || ''; } catch { return ''; }
}
export function setClientId(id) {
  try { localStorage.setItem(CLIENT_ID_KEY, (id || '').trim()); } catch {}
}
export function isConnected() {
  return !!accessToken && Date.now() < tokenExpiry;
}

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const existing = document.querySelector('script[data-gis]');
    if (existing) { existing.addEventListener('load', () => resolve()); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.dataset.gis = '1';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Google sign-in (offline?)'));
    document.head.appendChild(s);
  });
}

// interactive=true shows the account/consent prompt; false attempts a silent
// refresh (used when a cached session already granted access).
export async function connect({ interactive = true } = {}) {
  const clientId = getClientId();
  if (!clientId) throw new Error('Set your Google Client ID first');
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) { reject(new Error(resp.error)); return; }
        accessToken = resp.access_token;
        tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
        storeToken();
        resolve(resp);
      },
      error_callback: (err) => reject(new Error(err?.type || 'sign-in cancelled')),
    });
    tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}

export function disconnect() {
  try {
    if (accessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(accessToken, () => {});
    }
  } catch {}
  clearToken();
}

async function ensureToken() {
  if (isConnected()) return accessToken;
  await connect({ interactive: false });
  return accessToken;
}

async function api(url, opts = {}, retry = true) {
  const token = await ensureToken();
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    // token expired or revoked — drop it; the user reconnects with one click
    // (a purely client-side app can't silently refresh without popping a window)
    clearToken();
    throw new Error('Drive session expired — click Connect');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

const enc = encodeURIComponent;

export async function ensureFolder() {
  let id = null;
  try { id = localStorage.getItem(FOLDER_KEY); } catch {}
  if (id) {
    try {
      const r = await api(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,trashed`);
      const j = await r.json();
      if (!j.trashed) return id;
    } catch { /* fall through and re-find */ }
    id = null;
  }
  const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r = await api(`https://www.googleapis.com/drive/v3/files?q=${enc(q)}&fields=files(id,name)&spaces=drive`);
  const j = await r.json();
  if (j.files?.length) {
    id = j.files[0].id;
  } else {
    const cr = await api('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    id = (await cr.json()).id;
  }
  try { localStorage.setItem(FOLDER_KEY, id); } catch {}
  return id;
}

export async function uploadFile(name, blob, mimeType = 'audio/mpeg') {
  const folderId = await ensureFolder();
  const metadata = { name, parents: [folderId], mimeType };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);
  const r = await api(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    { method: 'POST', body: form }
  );
  return (await r.json()).id;
}

export async function downloadFile(fileId) {
  const r = await api(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return await r.blob();
}

// List audio files sitting in the Slowdowner folder (both app uploads and files
// the user dropped in manually).
export async function listAudioFiles() {
  const folderId = await ensureFolder();
  const q =
    `'${folderId}' in parents and trashed=false ` +
    `and name != '${MANIFEST_NAME}' ` +
    `and mimeType != 'application/json' ` +
    `and mimeType != 'application/vnd.google-apps.folder' and (` +
    `mimeType contains 'audio/' or name contains '.mp3' or name contains '.m4a' ` +
    `or name contains '.wav' or name contains '.ogg' or name contains '.flac' or name contains '.aac')`;
  const r = await api(
    `https://www.googleapis.com/drive/v3/files?q=${enc(q)}&fields=files(id,name,mimeType,size)&spaces=drive&pageSize=1000`
  );
  // Defensive: never treat the manifest as a song.
  return (await r.json()).files?.filter((f) => f.name !== MANIFEST_NAME) || [];
}

export async function deleteFile(fileId) {
  try { await api(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE' }); } catch {}
}

async function findManifestId() {
  const folderId = await ensureFolder();
  const q = `name='${MANIFEST_NAME}' and '${folderId}' in parents and trashed=false`;
  const r = await api(`https://www.googleapis.com/drive/v3/files?q=${enc(q)}&fields=files(id)&spaces=drive`);
  const j = await r.json();
  return j.files?.[0]?.id || null;
}

export async function readManifest() {
  const id = await findManifestId();
  if (!id) return null;
  const r = await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  return await r.json();
}

export async function writeManifest(obj) {
  const body = JSON.stringify(obj);
  const id = await findManifestId();
  if (id) {
    await api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } else {
    const folderId = await ensureFolder();
    const metadata = { name: MANIFEST_NAME, parents: [folderId], mimeType: 'application/json' };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([body], { type: 'application/json' }));
    await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      body: form,
    });
  }
}
