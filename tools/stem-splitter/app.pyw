#!/usr/bin/env pythonw
"""Slowdowner Stem Splitter — Windows app.

Pick (or drop) MP3/FLAC files → each is split into bass / no_bass with Demucs
(locally, on CPU) → the two stems upload straight to your Slowdowner folder in
Google Drive, named so Slowdowner groups them into one multi-track song.

Click the box to choose files. Drag-and-drop also works *if* the tkinterdnd2
native library is allowed to load (some locked-down machines block it — the app
just uses the file picker instead, no problem).

Run by double-clicking run_app.bat. Setup: see README.md.
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

AUDIO_EXT = splitter.AUDIO_EXT


def try_enable_dnd(root):
    """Best-effort native file drag-and-drop via tkinterdnd2.

    Returns the DND_FILES constant if it loads, else None. On machines where the
    tkdnd DLL is missing or blocked (Application Control / Smart App Control),
    this quietly returns None and the app falls back to the file picker.
    """
    try:
        from tkinterdnd2 import TkinterDnD, DND_FILES
        TkinterDnD._require(root)  # loads the native tkdnd library; may raise/popup
        return DND_FILES
    except Exception:
        return None


class SplitterApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title('Slowdowner Stem Splitter')
        self.geometry('580x470')
        self.minsize(460, 360)
        self.q = queue.Queue()
        self.busy = False
        self.cur_action = ''
        self._build()
        self._wire_dnd()
        self.after(100, self._drain)

    def _build(self):
        self.drop = tk.Label(self, text='Click here to choose a song', relief='ridge',
                             bd=2, height=5, bg='#eef1f7', fg='#333',
                             font=('Segoe UI', 12), cursor='hand2')
        self.drop.pack(fill='x', padx=12, pady=(10, 4))
        self.drop.bind('<Button-1>', lambda e: self._choose())

        row = tk.Frame(self)
        row.pack(fill='x', padx=12)
        ttk.Button(row, text='Choose files…', command=self._choose).pack(side='left')
        self.status = tk.Label(row, text='Ready', anchor='w')
        self.status.pack(side='left', padx=12)

        self.pb = ttk.Progressbar(self, mode='indeterminate')
        self.pb.pack(fill='x', padx=12, pady=6)

        self.log = tk.Text(self, height=14, state='disabled', wrap='word', font=('Consolas', 9))
        self.log.pack(fill='both', expand=True, padx=12, pady=(4, 12))
        self._log('Choose a song to split it and upload the stems to Google Drive.')

    def _wire_dnd(self):
        self.dnd_files = try_enable_dnd(self)
        if not self.dnd_files:
            return
        try:
            self.drop.drop_target_register(self.dnd_files)
            self.drop.dnd_bind('<<Drop>>', self._on_drop)
            self.drop.config(text='Drop songs here, or click to choose')
        except Exception:
            self.dnd_files = None

    def _log(self, msg):
        self.log.config(state='normal')
        self.log.insert('end', msg + '\n')
        self.log.see('end')
        self.log.config(state='disabled')

    def _choose(self):
        if self.busy:
            return
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
                self.q.put(('action', f'[{i}/{len(files)}] Splitting {f.name}'))
                self.q.put(('log', f'Splitting "{f.name}" (a few minutes on CPU)…'))
                self.q.put(('barmode', 'determinate'))
                ok = splitter.split_file(
                    f, tmp,
                    log=lambda m: self.q.put(('log', m)),
                    progress=lambda p: self.q.put(('progress', p)))
                if not ok:
                    self.q.put(('log', f'  !! could not split {f.name}'))
                    continue
                a, b = splitter.out_names(base)
                self.q.put(('action', f'[{i}/{len(files)}] Uploading {base}'))
                self.q.put(('barmode', 'indeterminate'))
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
                elif kind == 'action':
                    self.cur_action = val
                    self.status.config(text=val)
                elif kind == 'progress':
                    try:
                        self.pb['value'] = val
                    except tk.TclError:
                        pass
                    self.status.config(text=f'{self.cur_action} — {val}%')
                elif kind == 'barmode':
                    if val == 'determinate':
                        self.pb.stop()
                        self.pb.config(mode='determinate')
                        self.pb['value'] = 0
                    else:
                        self.pb.config(mode='indeterminate')
                        self.pb.start(12)
                elif kind == 'busy':
                    self.busy = val
                    if val:
                        self.pb.config(mode='indeterminate')
                        self.pb.start(12)
                    else:
                        self.pb.stop()
                        self.pb.config(mode='determinate')
                        self.pb['value'] = 0
                        self.status.config(text='Ready')
        except queue.Empty:
            pass
        self.after(100, self._drain)


if __name__ == '__main__':
    SplitterApp().mainloop()
