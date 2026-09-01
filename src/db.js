// Minimal IndexedDB layer. Songs store the original audio blob so everything
// works offline; loops and per-song settings are keyed by song id.
const DB_NAME = 'slowdowner';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('songs')) {
        db.createObjectStore('songs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('loops')) {
        const loops = db.createObjectStore('loops', { keyPath: 'id' });
        loops.createIndex('bySong', 'songId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        Promise.resolve(fn(s)).then((v) => (out = v));
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- Songs ----
export async function addSong({ name, blob, duration }) {
  const now = Date.now();
  const song = {
    id: uid(),
    name,
    blob,
    duration,
    addedAt: now,
    updatedAt: now,
    driveFileId: null,
    settings: { speed: 1, pitch: 0, volume: 1 },
    markers: [],
  };
  await tx('songs', 'readwrite', (s) => s.put(song));
  return song;
}

export function setMarkers(id, markers) {
  return tx('songs', 'readwrite', async (s) => {
    const song = await reqP(s.get(id));
    if (!song) return;
    song.markers = markers;
    song.updatedAt = Date.now();
    s.put(song);
  });
}

// Direct upsert (used by sync to import remote songs, preserving their id).
export function putSongRaw(song) {
  return tx('songs', 'readwrite', (s) => s.put(song));
}

export function setSongBlob(id, blob) {
  return tx('songs', 'readwrite', async (s) => {
    const song = await reqP(s.get(id));
    if (!song) return;
    song.blob = blob;
    s.put(song);
  });
}

export function setSongDrive(id, driveFileId) {
  return tx('songs', 'readwrite', async (s) => {
    const song = await reqP(s.get(id));
    if (!song) return;
    song.driveFileId = driveFileId;
    song.updatedAt = Date.now();
    s.put(song);
  });
}

export function getSongs() {
  return tx('songs', 'readonly', (s) => reqP(s.getAll())).then((rows) =>
    rows.sort((a, b) => b.addedAt - a.addedAt)
  );
}

export function getSong(id) {
  return tx('songs', 'readonly', (s) => reqP(s.get(id)));
}

export function getSongByDriveId(driveFileId) {
  return getSongs().then((rows) => rows.find((s) => s.driveFileId === driveFileId) || null);
}

export function setSongDuration(id, duration) {
  return tx('songs', 'readwrite', async (s) => {
    const song = await reqP(s.get(id));
    if (!song || song.duration === duration) return;
    song.duration = duration;
    s.put(song);
  });
}

export function updateSongSettings(id, settings) {
  return tx('songs', 'readwrite', async (s) => {
    const song = await reqP(s.get(id));
    if (!song) return;
    song.settings = { ...song.settings, ...settings };
    song.updatedAt = Date.now();
    s.put(song);
  });
}

export function renameSong(id, name) {
  return tx('songs', 'readwrite', async (s) => {
    const song = await reqP(s.get(id));
    if (!song) return;
    song.name = name;
    s.put(song);
  });
}

export async function deleteSong(id) {
  await tx('songs', 'readwrite', (s) => s.delete(id));
  const loops = await getLoops(id);
  await Promise.all(loops.map((l) => deleteLoop(l.id)));
}

export function touchSong(id) {
  return tx('songs', 'readwrite', async (s) => {
    const song = await reqP(s.get(id));
    if (!song) return;
    song.updatedAt = Date.now();
    s.put(song);
  });
}

// ---- Loops ----
export async function addLoop({ songId, name, start, end }) {
  const loop = { id: uid(), songId, name, start, end, createdAt: Date.now() };
  await tx('loops', 'readwrite', (s) => s.put(loop));
  await touchSong(songId);
  return loop;
}

export function getLoops(songId) {
  return tx('loops', 'readonly', (s) =>
    reqP(s.index('bySong').getAll(songId))
  ).then((rows) => rows.sort((a, b) => a.start - b.start));
}

export function updateLoop(loop) {
  return tx('loops', 'readwrite', (s) => s.put(loop)).then(() => touchSong(loop.songId));
}

export async function deleteLoop(id) {
  const loop = await tx('loops', 'readonly', (s) => reqP(s.get(id)));
  await tx('loops', 'readwrite', (s) => s.delete(id));
  if (loop) await touchSong(loop.songId);
}

// Replace all loops for a song with the given list (used by sync import).
export async function replaceLoops(songId, loops) {
  const existing = await getLoops(songId);
  await Promise.all(existing.map((l) => tx('loops', 'readwrite', (s) => s.delete(l.id))));
  await Promise.all(
    (loops || []).map((l) =>
      tx('loops', 'readwrite', (s) => s.put({ id: l.id || uid(), songId, name: l.name, start: l.start, end: l.end, createdAt: l.createdAt || Date.now() }))
    )
  );
}
