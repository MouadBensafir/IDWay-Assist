# Flask Web App

This is a minimal Flask web client for the existing FastAPI backend.

## Install

```bash
cd webapp
py -3 -m pip install -r requirements.txt
```

## Run

```bash
cd webapp
py -3 app.py
```

The page runs on `http://127.0.0.1:5050`.

## Backend target

By default the web app reads `../config.json` and uses `mobile.backendUrl.default`.

To override it:

```bash
set WEB_BACKEND_URL=http://127.0.0.1:8001
```

## Behavior

- Users chat with the backend over plain text.
- Images are compressed in the browser before upload.
- PDFs are sent unchanged.
- The web client preserves the backend `session_id` across requests until the user ends the conversation.
