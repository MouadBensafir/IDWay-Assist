from pydantic import BaseModel, Field


class PromptRequest(BaseModel):
    session_id: str | None = Field(default=None, description="Existing session id to continue.")
    prompt: str = Field(default="", description="User prompt to process.")
    reset: bool = Field(default=False, description="Start a fresh session using the provided session id.")


class PromptResponse(BaseModel):
    session_id: str
    response: str
    model: str
    service_name: str | None = None
    submission_path: str | None = None
    completed: bool = False
    missing_fields: list[str] = Field(default_factory=list)
    token_usage: dict[str, int] = Field(default_factory=dict)


class DeleteSessionResponse(BaseModel):
    session_id: str
    deleted: bool
