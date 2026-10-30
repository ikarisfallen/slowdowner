#!/usr/bin/env pythonw
"""Slowdowner Stem Splitter — drag-and-drop Windows app.

Drop MP3/FLAC files on the window → each is split into bass / no_bass with Demucs
(locally, on CPU) → the two stems upload straight to your Slowdowner folder in
Google Drive, named so Slowdowner groups them into one multi-track song.

Run by double-clicking run_app.bat (or this file, if .pyw is associated with
pythonw). Setup: see README.md.
"""
import queue
import shutil
import sys
import tempfile
import threading
from pathlib import Path

import tkinter as tk
from tkinter import ttk, filedialog, messagebox

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import slowdowner_split as splitter  # noqa: E402
import drive_upload  # noqa: E402

try:
    from tkinterdnd2 import TkinterDnD, DND_FILES
    BaseTk = TkinterDnD.Tk
    HAS_DND = True
except Exception:
    BaseTk = tk.Tk
    HAS_DND = False

AUDIO_EXT = splitter.AUDIO_EXT


class SplitterApp(BaseTk):
    def __init__(self):
        super().__init__()
        self.title('Slowdowner Stem Splitter')
        self.geometry('580x460')
        self.minsize(460, 360)
        self.q = queue.Queue()
        self.busy = False
        self._build()
        self.after(100, self._drain)

    def _build(self):
        pad = dict(padx=12, pady=(10, 4))
        msg = 'Drop MP3 / FLAC files here' if HAS_DND else 'Click "Choose files…" below'
        self.drop = tk.Label(self, text=msg, relief='ridge', bd=2, height=5,
                             bg='#eef1f7', fg='#333', font=('Segoe UI', 11))
        self.drop.pack(fill='x', **pad)
        if HAS_DND:
            self.drop.drop_target_register(DND_FILES)
            self.drop.dnd_bind('<<Drop>>', self._on_drop)

        row = tk.Frame(self)
        row.pack(fill='x', padx=12)
        ttk.Button(row, text='Choose files…', command=self._choose).pack(side='left')
        self.status = tk.Label(row, text='Ready', anchor='w')
        self.status.pack(side='left', padx=12)

        self.pb = ttk.Progressbar(self, mode='indeterminate')
        self.pb.pack(fill='x', padx=12, pady=6)

        self.log = tk.Text(self, height=14, state='disabled', wrap='word',
                           font=('Consolas', 9))
        self.log.pack(fill='both', expand=True, padx=12, pady=(4, 12))
        self._log('Drop a song to split it and upload the stems to Google Drive.')
        if not HAS_DND:
            self._log('(Drag-and-drop module not installed — use "Choose files…". '
                      'To enable drops: pip install tkinterdnd2)')

    def _log(self, msg):
        self.log.config(state='normal')
        self.log.insert('end', msg + '\n')
        self.log.see('end')
        self.log.config(state='disabled')

    def _choose(self):
        files = filedialog.askopenfilenames(
            title='Choose audio files',
            filetypes=[('Audio', '*.mp3 *.flac *.wav *.m4a *.aac *.ogg'), ('All files', '*.*')])
        if files:
            self._enqueue(files)

    def _on_drop(self, event):
        self._enqueue(self.tk.splitlist(event.data))

    def _enqueue(self, files):
        audio = [f for f in files if Path(f).suffix.lower() in AUDIO_EXT]
        if not audio:
            messagebox.showinfo('Slowdowner', 'No audio files there.')
            return
        if self.busy:
            messagebox.showinfo('Slowdowner', 'Still working — let the current batch finish first.')
            return
        threading.Thread(target=self._work, args=(audio,), daemon=True).start()

    def _work(self, files):
        self.q.put(('busy', True))
        tmp = Path(tempfile.mkdtemp(prefix='slowdowner_'))
        try:
            self.q.put(('log', 'Connecting to Google Drive…'))
            try:
                svc = drive_upload.get_service(str(HERE / 'client_secrets.json'), str(HERE / 'token.json'))
                folder = drive_upload.ensure_folder(svc)
            except Exception as e:
                self.q.put(('log', f'Google Drive sign-in failed: {e}'))
                self.q.put(('busy', False))
                return
            for i, f in enumerate(files, 1):
                f = Path(f)
                base = f.stem
                self.q.put(('status', f'[{i}/{len(files)}] splitting {f.name}'))
                self.q.put(('log', f'Splitting "{f.name}" (a few minutes on CPU)…'))
                ok = splitter.split_file(f, tmp)
                if not ok:
                    self.q.put(('log', f'  !! could not split {f.name}'))
                    continue
                a, b = splitter.out_names(base)
                self.q.put(('status', f'[{i}/{len(files)}] uploading {base}'))
                self.q.put(('log', '  uploading stems to Google Drive…'))
                try:
                    drive_upload.upload(svc, folder, str(tmp / a))
                    drive_upload.upload(svc, folder, str(tmp / b))
                    drive_upload.delete_singles(svc, folder, base)
                    self.q.put(('log', f'  ✓ {base} — done (in your Slowdowner Drive folder)'))
                except Exception as e:
                    self.q.put(('log', f'  !! upload failed: {e}'))
                for nm in (a, b):
                    try:
                        (tmp / nm).unlink()
                    except OSError:
                        pass
            self.q.put(('status', 'Done'))
            self.q.put(('log', 'Finished. Sync Slowdowner to see the new stems.'))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            self.q.put(('busy', False))

    def _drain(self):
        try:
            while True:
                kind, val = self.q.get_nowait()
                if kind == 'log':
                    self._log(val)
                elif kind == 'status':
                    self.status.config(text=val)
                elif kind == 'busy':
                    self.busy = val
                    if val:
                        self.pb.start(12)
                    else:
                        self.pb.stop()
        except queue.Empty:
            pass
        self.after(100, self._drain)


if __name__ == '__main__':
    SplitterApp().mainloop()
