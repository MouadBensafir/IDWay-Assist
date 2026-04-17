# Local Qwen Voice App

This project records speech in the Expo app, sends the final transcript to a separate FastAPI backend project, forwards that prompt to Ollama running Qwen on your machine through the Python `ollama` library, and then speaks Qwen's reply back to the user.

The mobile app URL defaults live in [config.json](/abs/path/c:/Users/Mouad/Desktop/Expo_Test/config.json). The backend project has its own config in [backend/config.json](/abs/path/c:/Users/Mouad/Desktop/Expo_Test/backend/config.json).

## Backend

The backend is a separate project under [backend/README.md](/abs/path/c:/Users/Mouad/Desktop/Expo_Test/backend/README.md).

Install Python dependencies inside `backend/`:

```bash
cd backend
pip install -r requirements.txt
```

Run the API from `backend/`:

```bash
python run.py
```

Default backend settings come from `backend/config.json`. Optional environment variables still override them:

```bash
set OLLAMA_MODEL=qwen2.5:latest
set OLLAMA_URL=http://127.0.0.1:11434
set OLLAMA_NUM_CTX=4096
```

The backend exposes:

- `GET /health`
- `POST /chat` with `{ "prompt": "..." }`

## Mobile app

Install dependencies and start Expo:

```bash
npm install
npx expo start
```

Mobile backend URL defaults come from `config.json`:

- `mobile.basePrompt`
- `mobile.backendUrl.android`
- `mobile.backendUrl.ios`
- `mobile.backendUrl.default`

If you want to override that temporarily, set `EXPO_PUBLIC_API_URL`, for example:

```bash
set EXPO_PUBLIC_API_URL=http://192.168.1.10:8000
```

Make sure Ollama is running locally and the configured Qwen model is already pulled before using the app.
