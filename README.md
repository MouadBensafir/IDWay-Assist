# Local Government e-Services Assistant

This project has two parts:

- an Expo mobile app in the repo root
- a FastAPI backend in `backend/` that talks to a local Ollama server
- a minimal Flask web client in `webapp/` for text chat plus file attachments

The mobile app records speech, can upload documents or camera photos, sends everything to the backend, and speaks the backend response back to the user. The assistant flow is aimed at guiding users through government e-services such as ID renewal, visa appointments, and driving license renewal.

## Backend

Install dependencies:

```bash
cd backend
py -3 -m pip install -r requirements.txt
```

Run the API:

```bash
ollama pull qwen3.5
cd backend
py -3 run.py
```

The backend expects a local Ollama instance on `http://127.0.0.1:11434`. Default settings live in [backend/config.json](backend/config.json).

Useful environment overrides:

```bash
set OLLAMA_URL=http://127.0.0.1:11434
set OLLAMA_MODEL=qwen3.5
set OLLAMA_NUM_CTX=8192
```

## Mobile app

Install dependencies and start Expo:

```bash
npm install
npm start
```

Run on Android:

```bash
npm run android
```

The Android app can:

- record speech
- take a document photo with the camera
- compress captured images before upload
- upload image or PDF files to the backend

Backend URL defaults live in [config.json](config.json). To override them temporarily:

```bash
set EXPO_PUBLIC_API_URL=http://192.168.1.10:8001
```

Use your machine LAN IP if the app is running on a phone or emulator and the backend is local.

## Flask web app

Install and run:

```bash
cd webapp
py -3 -m pip install -r requirements.txt
py -3 app.py
```

The Flask page runs on `http://127.0.0.1:5050` and proxies to the same backend API. It compresses image attachments in the browser before upload and sends PDFs unchanged.
