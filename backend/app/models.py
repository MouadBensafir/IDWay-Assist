from pydantic import BaseModel, Field


class PromptRequest(BaseModel):
    session_id: str | None = Field(default=None, description="Existing session id to continue.")
    prompt: str = Field(..., min_length=1, description="User prompt to forward to Ollama")
    reset: bool = Field(default=False, description="Start a fresh session using the provided session id.")


class PromptResponse(BaseModel):
    session_id: str
    response: str
    model: str


class DeleteSessionResponse(BaseModel):
    session_id: str
    deleted: bool
