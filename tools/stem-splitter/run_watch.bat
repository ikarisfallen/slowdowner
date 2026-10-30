@echo off
REM ============================================================
REM  Slowdowner stem splitter - watch mode (Windows)
REM  Edit the two paths below, then double-click this file.
REM ============================================================

REM Folder you drop songs into (created automatically if missing):
set "IN=%USERPROFILE%\SlowdownerSplit\in"

REM Your Google-Drive-synced "Slowdowner" folder (Google Drive for Desktop).
REM Change G: to wherever your Google Drive is mounted.
set "OUT=G:\My Drive\Slowdowner"

python "%~dp0slowdowner_split.py" --watch --in "%IN%" --out "%OUT%" --replace
pause
