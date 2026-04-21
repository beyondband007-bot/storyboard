from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ContentUnit(BaseModel):
    name: str = ""
    selling_points: str = ""
    naming: str = ""


class ProjectMeta(BaseModel):
    project_name: str = "未命名项目"
    client_type: str = "企业"
    video_type: str = "宣传片"
    duration: str = "3分钟"
    aspect_ratio: str = "16:9横版"
    style: str = ""
    version: str = "完整版"
    brand_assets: str = ""
    reference_samples: str = ""


class StepResult(BaseModel):
    key: str
    title: str
    content: str = ""
    confirmed: bool = False
    updated_at: str | None = None


class ChatMessage(BaseModel):
    role: str
    content: str
    streaming: bool = False


class ProjectAsset(BaseModel):
    id: str
    filename: str
    original_filename: str
    content_type: str = ""
    asset_type: str = "other"
    size: int = 0
    path: str = ""
    summary: str = ""
    extracted_text: str = ""
    status: str = "uploaded"
    error: str = ""
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class ProjectState(BaseModel):
    id: str
    meta: ProjectMeta = Field(default_factory=ProjectMeta)
    content_units: list[ContentUnit] = Field(default_factory=list)
    steps: dict[str, StepResult] = Field(default_factory=dict)
    messages: list[ChatMessage] = Field(default_factory=list)
    stage: str = "0"
    selection_state: dict[str, Any] = Field(default_factory=dict)
    last_export: dict[str, str] = Field(default_factory=dict)
    active_version: str = "full"
    proposal_markdown: str = ""
    full_markdown: str = ""
    final_markdown: str = ""
    exports: dict[str, str] = Field(default_factory=dict)
    assets: list[ProjectAsset] = Field(default_factory=list)
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))


class ProjectSummary(BaseModel):
    id: str
    project_name: str
    video_type: str
    updated_at: str


class SaveProjectRequest(BaseModel):
    project: ProjectState


class GenerateStepRequest(BaseModel):
    project: ProjectState
    step_key: str


class GenerateFullRequest(BaseModel):
    project: ProjectState


class GenerateVersionedRequest(BaseModel):
    project: ProjectState
    version: str = "full"


class PreviewResponse(BaseModel):
    project: ProjectState
    content: str


class GenerateStepResponse(BaseModel):
    step: StepResult
    project: ProjectState


class ExportRequest(BaseModel):
    project: ProjectState
    markdown: str | None = None
    version: str = "full"


class ExportResponse(BaseModel):
    project: ProjectState
    filename: str
    path: str
    download_url: str


class AssetUploadResponse(BaseModel):
    project: ProjectState
    asset: ProjectAsset


class ConfigResponse(BaseModel):
    kimi_configured: bool
    base_url: str
    model: str


class ErrorResponse(BaseModel):
    detail: str
    meta: dict[str, Any] = Field(default_factory=dict)
