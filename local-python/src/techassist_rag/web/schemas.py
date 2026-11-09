from typing import Literal
from pydantic import BaseModel, Field

Status = Literal['collecting_context', 'awaiting_step_result', 'resolved', 'escalated']


class Device(BaseModel):
    os: str = Field(default='', max_length=100)
    model: str = Field(default='', max_length=120)
    application: str = Field(default='', max_length=120)
    admin_access: bool = False


class TurnRequest(BaseModel):
    request_id: str = Field(min_length=8, max_length=80, pattern=r'^[a-zA-Z0-9_-]+$')
    message: str = Field(min_length=1, max_length=4000)
    action: Literal['message', 'worked', 'failed', 'cannot', 'escalate'] = 'message'
    device: Device | None = None
    # Enables safe rejection of outcomes for an obsolete displayed step.
    step_id: str | None = Field(default=None, max_length=100)


class Step(BaseModel):
    id: str
    instruction: str = Field(max_length=2000)
    expected_result: str = Field(max_length=1000)
    source_ids: list[str]


class Source(BaseModel):
    id: str
    title: str
    url: str
    relevance: float


class AssistantResponse(BaseModel):
    status: Status
    summary: str = Field(max_length=3000)
    category: str
    mode: Literal['guided', 'ollama', 'nebius']
    question: str | None = None
    choices: list[str] = Field(default_factory=list)
    steps: list[Step] = Field(default_factory=list)
    sources: list[Source] = Field(default_factory=list)
    escalation: str | None = None
    progress: dict = Field(default_factory=dict)
