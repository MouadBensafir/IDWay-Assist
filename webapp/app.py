from __future__ import annotations

import json
import os
from io import BytesIO
from pathlib import Path
from typing import Any

import requests
from flask import Flask, jsonify, render_template, request


WEBAPP_DIR = Path(__file__).resolve().parent
ROOT_DIR = WEBAPP_DIR.parent
CONFIG_PATH = ROOT_DIR / "config.json"

DEFAULT_BACKEND_URL = "http://127.0.0.1:8001"
DEFAULT_WORKFLOW_ID = "us_nonimmigrant_visa"
REQUEST_TIMEOUT_SECONDS = 180


def load_root_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        return {}

    with CONFIG_PATH.open("r", encoding="utf-8") as config_file:
        data = json.load(config_file)

    if not isinstance(data, dict):
        return {}
    return data


def get_backend_url() -> str:
    explicit = os.getenv("WEB_BACKEND_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")

    root_config = load_root_config()
    mobile = root_config.get("mobile")
    if not isinstance(mobile, dict):
        return DEFAULT_BACKEND_URL

    backend_url = mobile.get("backendUrl")
    if not isinstance(backend_url, dict):
        return DEFAULT_BACKEND_URL

    web_url = str(backend_url.get("web") or "").strip()
    if web_url:
        return web_url.rstrip("/")

    default_url = str(backend_url.get("default") or "").strip()
    return default_url.rstrip("/") or DEFAULT_BACKEND_URL


def get_workflow_id() -> str:
    explicit = os.getenv("WEB_WORKFLOW_ID", "").strip()
    if explicit:
        return explicit

    root_config = load_root_config()
    mobile = root_config.get("mobile")
    if not isinstance(mobile, dict):
        return DEFAULT_WORKFLOW_ID

    workflow_id = str(mobile.get("workflowId") or "").strip()
    return workflow_id or DEFAULT_WORKFLOW_ID


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024


@app.get("/")
def index() -> str:
    return render_template(
        "index.html",
        backend_url=get_backend_url(),
        workflow_id="Auto-detect",
    )


@app.get("/api/workflows")
def list_workflows() -> Any:
    backend_url = f"{get_backend_url()}/workflows/catalog"
    try:
        response = requests.get(backend_url, timeout=REQUEST_TIMEOUT_SECONDS)
    except requests.RequestException as exc:
        return jsonify({"detail": f"Unable to reach backend: {exc}"}), 502

    try:
        backend_payload = response.json()
    except ValueError:
        backend_payload = {"detail": response.text or "The backend returned an invalid response."}

    return jsonify(backend_payload), response.status_code


@app.post("/api/chat")
def chat() -> Any:
    if request.is_json:
        payload = request.get_json(silent=True) or {}
        session_id = str(payload.get("workflow_session_id") or payload.get("session_id") or "").strip()
        prompt = str(payload.get("prompt") or "")
    else:
        session_id = str(request.form.get("workflow_session_id") or request.form.get("session_id") or "").strip()
        prompt = str(request.form.get("prompt") or "")

    backend_url = f"{get_backend_url()}/workflows/chat"

    uploaded_files = request.files.getlist("file")
    has_files = any(file_storage.filename for file_storage in uploaded_files)

    try:
        if has_files:
            data = {
                "prompt": prompt,
            }
            if session_id:
                data["workflow_session_id"] = session_id

            files_payload: list[tuple[str, tuple[str, BytesIO, str]]] = []
            for file_storage in uploaded_files:
                if not file_storage.filename:
                    continue
                filename = file_storage.filename
                content_type = file_storage.mimetype or "application/octet-stream"
                file_bytes = file_storage.read()
                files_payload.append(
                    (
                        "file",
                        (
                            filename,
                            BytesIO(file_bytes),
                            content_type,
                        ),
                    )
                )

            response = requests.post(
                backend_url,
                data=data,
                files=files_payload,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        else:
            payload: dict[str, Any] = {"prompt": prompt}
            if session_id:
                payload["workflow_session_id"] = session_id

            response = requests.post(
                backend_url,
                json=payload,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
    except requests.RequestException as exc:
        return jsonify({"detail": f"Unable to reach backend: {exc}"}), 502

    try:
        backend_payload = response.json()
    except ValueError:
        backend_payload = {"detail": response.text or "The backend returned an invalid response."}

    return jsonify(backend_payload), response.status_code


@app.delete("/api/sessions/<session_id>")
def delete_session(session_id: str) -> Any:
    backend_url = f"{get_backend_url()}/workflows/sessions/{session_id}"

    try:
        response = requests.delete(
            backend_url,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        return jsonify({"detail": f"Unable to reach backend: {exc}"}), 502

    try:
        backend_payload = response.json()
    except ValueError:
        backend_payload = {"detail": response.text or "The backend returned an invalid response."}

    return jsonify(backend_payload), response.status_code


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=True)
