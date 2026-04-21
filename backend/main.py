from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .models import (
    AssetUploadResponse,
    ConfigResponse,
    ExportRequest,
    GenerateFullRequest,
    PreviewResponse,
    ExportResponse,
    GenerateStepRequest,
    GenerateStepResponse,
    ProjectState,
    SaveProjectRequest,
)
from .assets import asset_download_path, delete_asset, upload_asset
from .storage import OUTPUTS_DIR, delete_project, load_project, project_dir, safe_filename, save_project, list_projects
from .storyboard import (
    generate_creative_preview,
    generate_step,
    stream_creative_preview,
    stream_full_document,
    stream_proposal_document,
    write_docx,
    write_markdown,
)


ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"

app = FastAPI(title="Storyboard Generator", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config", response_model=ConfigResponse)
def config() -> ConfigResponse:
    api_key = os.getenv("LLM_API_KEY") or os.getenv("KIMI_API_KEY")
    return ConfigResponse(
        kimi_configured=bool(api_key),
        base_url=os.getenv("LLM_BASE_URL") or os.getenv("KIMI_BASE_URL", "https://open.bigmodel.cn/api/paas/v4/"),
        model=os.getenv("LLM_MODEL") or os.getenv("KIMI_MODEL", "glm-5.1"),
    )


@app.get("/api/projects")
def get_projects():
    return list_projects()


@app.post("/api/projects", response_model=ProjectState)
def upsert_project(payload: SaveProjectRequest) -> ProjectState:
    project = payload.project
    if not project.id:
        project.id = uuid4().hex
    return save_project(project)


@app.get("/api/projects/{project_id}", response_model=ProjectState)
def get_project(project_id: str) -> ProjectState:
    try:
        return load_project(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.delete("/api/projects/{project_id}")
def remove_project(project_id: str) -> dict[str, str]:
    try:
        delete_project(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "deleted"}


@app.post("/api/projects/{project_id}/assets/upload", response_model=AssetUploadResponse)
async def upload_project_asset(
    project_id: str,
    file: UploadFile = File(...),
    asset_type: str = Form("other"),
) -> AssetUploadResponse:
    try:
        project = load_project(project_id)
    except FileNotFoundError:
        project = ProjectState(id=project_id)
        save_project(project)
    project, asset = await upload_asset(project, file, asset_type)
    return AssetUploadResponse(project=project, asset=asset)


@app.get("/api/projects/{project_id}/assets")
def list_project_assets(project_id: str):
    try:
        project = load_project(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return project.assets


@app.delete("/api/projects/{project_id}/assets/{asset_id}", response_model=ProjectState)
def delete_project_asset(project_id: str, asset_id: str) -> ProjectState:
    try:
        project = load_project(project_id)
        return delete_asset(project, asset_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/projects/{project_id}/assets/{asset_id}/download")
def download_project_asset(project_id: str, asset_id: str):
    try:
        project = load_project(project_id)
        path = asset_download_path(project, asset_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(path, filename=next(asset.original_filename for asset in project.assets if asset.id == asset_id))


@app.post("/api/generate/step", response_model=GenerateStepResponse)
def generate_storyboard_step(payload: GenerateStepRequest) -> GenerateStepResponse:
    project, step = generate_step(payload.project, payload.step_key)
    return GenerateStepResponse(project=project, step=step)


@app.post("/api/generate/full/stream")
def generate_full_stream(payload: GenerateFullRequest):
    return stream_full_document(payload.project)


@app.post("/api/generate/proposal/stream")
def generate_proposal_stream(payload: GenerateFullRequest):
    return stream_proposal_document(payload.project)


@app.post("/api/generate/preview", response_model=PreviewResponse)
def generate_preview(payload: GenerateFullRequest) -> PreviewResponse:
    project, content = generate_creative_preview(payload.project)
    return PreviewResponse(project=project, content=content)


@app.post("/api/generate/preview/stream")
def generate_preview_stream(payload: GenerateFullRequest):
    return stream_creative_preview(payload.project)


@app.post("/api/export/markdown", response_model=ExportResponse)
def export_markdown(payload: ExportRequest) -> ExportResponse:
    project, path = write_markdown(payload.project, payload.markdown, payload.version)
    return ExportResponse(
        project=project,
        filename=path.name,
        path=str(path),
        download_url=f"/api/download/{project.id}/export/{payload.version}/markdown",
    )


@app.post("/api/export/docx", response_model=ExportResponse)
def export_docx(payload: ExportRequest) -> ExportResponse:
    project, path = write_docx(payload.project, payload.markdown, payload.version)
    return ExportResponse(
        project=project,
        filename=path.name,
        path=str(path),
        download_url=f"/api/download/{project.id}/export/{payload.version}/docx",
    )


@app.post("/api/export/{version}/{kind}", response_model=ExportResponse)
def export_versioned(version: str, kind: str, payload: ExportRequest) -> ExportResponse:
    if version not in {"proposal", "full"} or kind not in {"markdown", "docx"}:
        raise HTTPException(status_code=404, detail="Unknown export type")
    if kind == "markdown":
        project, path = write_markdown(payload.project, payload.markdown, version)
    else:
        project, path = write_docx(payload.project, payload.markdown, version)
    return ExportResponse(
        project=project,
        filename=path.name,
        path=str(path),
        download_url=f"/api/download/{project.id}/export/{version}/{kind}",
    )


@app.get("/api/download/{project_id}/export/{version}/{kind}")
def download_versioned_export(project_id: str, version: str, kind: str):
    if version not in {"proposal", "full"} or kind not in {"markdown", "docx"}:
        raise HTTPException(status_code=404, detail="Unknown export type")
    try:
        project = load_project(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    export_path = project.exports.get(f"{version}_{kind}")
    folder = project_dir(project_id).resolve()
    path = Path(export_path).resolve() if export_path else None
    if not path or folder not in path.parents or not path.exists():
        suffix = ".docx" if kind == "docx" else ".md"
        label = "提案版" if version == "proposal" else "完整版"
        candidates = sorted(folder.glob(f"*_{label}{suffix}"), key=lambda item: item.stat().st_mtime, reverse=True)
        path = candidates[0].resolve() if candidates else None
    if not path or folder not in path.parents or not path.exists():
        raise HTTPException(status_code=404, detail=f"{version} {kind} export not found")
    return FileResponse(path, filename=path.name)


@app.get("/api/download/{project_id}/export/{kind}")
def download_export(project_id: str, kind: str):
    if kind not in {"markdown", "docx"}:
        raise HTTPException(status_code=404, detail="Unknown export type")
    try:
        project = load_project(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    export_path = project.exports.get(kind)
    folder = project_dir(project_id).resolve()
    path = Path(export_path).resolve() if export_path else None
    if not path or folder not in path.parents or not path.exists():
        suffix = ".docx" if kind == "docx" else ".md"
        candidates = sorted(folder.glob(f"*{suffix}"), key=lambda item: item.stat().st_mtime, reverse=True)
        path = candidates[0].resolve() if candidates else None
    if not path or folder not in path.parents or not path.exists():
        raise HTTPException(status_code=404, detail=f"{kind} export not found")
    return FileResponse(path, filename=path.name)


@app.get("/api/download/{project_id}/{filename}")
def download(project_id: str, filename: str):
    folder = project_dir(project_id).resolve()
    candidates = [
        (folder / filename).resolve(),
        (folder / safe_filename(filename)).resolve(),
    ]
    path = next((candidate for candidate in candidates if folder in candidate.parents and candidate.exists()), None)
    if path is None:
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, filename=path.name)


OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
