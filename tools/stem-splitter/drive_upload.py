"""Google Drive upload for the stem splitter.

Uploads stem MP3s straight into your "Slowdowner" folder via the Drive API, so
you don't need Google Drive for Desktop. First run opens a browser once to sign
in; the token is cached in token.json next to the app.

Needs a Desktop OAuth client (client_secrets.json) — see README.md.
"""
import os

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

# Full Drive scope so we can find the SAME "Slowdowner" folder the Slowdowner web
# app created and write into it (drive.file would only see files this tool made,
# which would make a second folder).
SCOPES = ['https://www.googleapis.com/auth/drive']
FOLDER_NAME = 'Slowdowner'


def get_service(creds_path='client_secrets.json', token_path='token.json'):
    creds = None
    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(creds_path):
                raise FileNotFoundError(
                    f'Missing {os.path.basename(creds_path)} — download a Desktop OAuth '
                    'client from Google Cloud and put it next to the app (see README).')
            flow = InstalledAppFlow.from_client_secrets_file(creds_path, SCOPES)
            creds = flow.run_local_server(port=0)  # opens a browser to sign in, once
        with open(token_path, 'w', encoding='utf-8') as f:
            f.write(creds.to_json())
    return build('drive', 'v3', credentials=creds, cache_discovery=False)


def ensure_folder(service):
    q = (f"name='{FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' "
         "and trashed=false")
    res = service.files().list(q=q, fields='files(id,name)', spaces='drive').execute()
    files = res.get('files', [])
    if files:
        return files[0]['id']
    meta = {'name': FOLDER_NAME, 'mimeType': 'application/vnd.google-apps.folder'}
    return service.files().create(body=meta, fields='id').execute()['id']


def _find_in_folder(service, folder_id, name):
    safe = name.replace("'", "\\'")
    q = f"name='{safe}' and '{folder_id}' in parents and trashed=false"
    return service.files().list(q=q, fields='files(id,name)', spaces='drive').execute().get('files', [])


def upload(service, folder_id, path, replace=True):
    """Upload one file into the folder; by default replaces a same-named file."""
    name = os.path.basename(path)
    if replace:
        for f in _find_in_folder(service, folder_id, name):
            service.files().delete(fileId=f['id']).execute()
    media = MediaFileUpload(path, mimetype='audio/mpeg', resumable=True)
    service.files().create(body={'name': name, 'parents': [folder_id]},
                           media_body=media, fields='id').execute()


def delete_singles(service, folder_id, base):
    """Remove a single-file version of the song (so the stems replace it)."""
    for ext in ('.mp3', '.flac', '.wav', '.m4a'):
        for f in _find_in_folder(service, folder_id, base + ext):
            service.files().delete(fileId=f['id']).execute()
