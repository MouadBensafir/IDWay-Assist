# Backend

This is a standalone FastAPI project served separately from the Expo app.

## Files

- `config.json`: backend server host/port and Ollama settings
- `app/config.py`: config loading and shared constants
- `app/idway_data.py`: mock IDWay domain data and validation helpers
- `app/models.py`: request and response schemas
- `app/session_store.py`: in-memory chat session store
- `app/tools.py`: Qwen business tools and tool-call helpers
- `app/ollama_client.py`: raw Ollama HTTP client
- `app/server.py`: FastAPI app and routes
- `main.py`: thin compatibility entrypoint that re-exports `app`
- `run.py`: local runner
- `requirements.txt`: Python dependencies

## Install

```bash
pip install -r requirements.txt
```

## Run

```bash
python run.py
```

Default server port is `8001`, configured in `config.json`.

Chat and memory behavior are configured in `config.json`:

- `chat.maxToolRounds`: maximum assistant/tool loop iterations per request
- `chat.systemPrompt`: the main assistant system prompt
- `chat.memorySummaryPrompt`: the prompt used to compress older conversation history
- `ollama.numCtx`: Ollama `num_ctx` setting. Lower this to reduce VRAM usage.
- `ollama.maxContextChars`: approximate conversation size threshold before history is compacted
- `ollama.compactTriggerChars`: early compaction threshold before the hard history cap is reached
- `ollama.recentMessageCount`: how many recent raw messages remain after older turns are summarized
- `ollama.toolResultMaxChars`: maximum tool-result text retained in history
- `ollama.toolResultMaxItems`: maximum items retained per list/object inside tool results

## Test with curl

Health check:

```bash
curl.exe http://127.0.0.1:8001/health
```

Chat request:

```bash
curl.exe -X POST http://127.0.0.1:8001/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"prompt\":\"I want to renew my AI ID.\"}"
```

To continue the same conversation, send the returned `session_id` back in the next request:

```bash
curl.exe -X POST http://127.0.0.1:8001/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"session_id\":\"<returned-session-id>\",\"prompt\":\"Yes, continue.\"}"
```

## Agent behavior

The `/chat` route now exposes IDWay business tools to Qwen through Ollama function calling so the model can:

- list available services
- fetch ordered service steps
- fetch and validate form fields
- guide country, region, town, center, date, and time selection
- submit a mock request once the user confirms the summary

Sessions are stored in memory, so they reset when the backend process restarts.
When a session grows too large, the backend summarizes older useful context into a compact memory block and keeps only the most recent turns verbatim before continuing.
Tool results are also compacted before they are written back into session history so repeated lookups do not exhaust the model context.
