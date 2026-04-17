import uvicorn
from app.config import CONFIG, DEFAULT_CONFIG


if __name__ == "__main__":
    server = CONFIG.get("server", DEFAULT_CONFIG["server"])
    uvicorn.run(
        "app.server:app",
        host=str(server.get("host", DEFAULT_CONFIG["server"]["host"])),
        port=int(server.get("port", DEFAULT_CONFIG["server"]["port"])),
        reload=False,
    )