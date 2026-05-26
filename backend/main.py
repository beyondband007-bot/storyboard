from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
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
from .assets import asset_download_path, delete_asset, parse_uploaded_asset, upload_asset
from .auth import (
    auth_state,
    current_user,
    login,
    logout,
    password_reset,
    password_reset_challenge,
    register,
    SECURITY_QUESTIONS,
)
from .storage import (
    OUTPUTS_DIR,
    assert_project_owner,
    assign_owner,
    delete_project,
    load_project,
    list_projects,
    project_dir,
    safe_filename,
    save_project,
)
from .storyboard import (
    generate_creative_preview,
    generate_step,
    stream_creative_preview,
    stream_full_document,
    stream_intake_summary,
    stream_logic_recommendation,
    stream_proposal_document,
    stream_style_recommendation,
    write_docx,
    write_html,
    write_markdown,
)


ROOT_DIR = Path(__file__).resolve().parents[1]
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"

app = FastAPI(title="Storyboard Generator", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def owned_project(project_id: str, request: Request) -> ProjectState:
    user = current_user(request)
    project = load_project(project_id)
    assert_project_owner(project, user.id)
    return project


def authorize_project(project: ProjectState, request: Request) -> ProjectState:
    user = current_user(request)
    if project.id:
        try:
            existing = load_project(project.id)
        except FileNotFoundError:
            existing = None
        if existing:
            assert_project_owner(existing, user.id)
        elif project.owner_user_id is not None and project.owner_user_id != user.id:
            raise PermissionError("You do not have access to this project.")
    assign_owner(project, user.id, user.external_id)
    return project


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


@app.get("/api/auth/security-questions")
def get_security_questions():
    return {"questions": SECURITY_QUESTIONS}


@app.get("/api/auth/me")
def get_auth_state(request: Request):
    return auth_state(request)


@app.post("/api/auth/register")
def register_user(payload: dict, request: Request, response: Response):
    return register(payload, request, response)


@app.post("/api/auth/login")
def login_user(payload: dict, request: Request, response: Response):
    return login(payload, request, response)


@app.post("/api/auth/logout")
def logout_user(request: Request, response: Response):
    return logout(request, response)


@app.post("/api/auth/password-reset/challenge")
def create_password_reset_challenge(payload: dict):
    return password_reset_challenge(payload)


@app.post("/api/auth/password-reset")
def reset_user_password(payload: dict):
    return password_reset(payload)


@app.get("/api/projects")
def get_projects(request: Request):
    user = current_user(request)
    return list_projects(user.id)


@app.post("/api/projects", response_model=ProjectState)
def upsert_project(payload: SaveProjectRequest, request: Request) -> ProjectState:
    try:
        project = authorize_project(payload.project, request)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if not project.id:
        project.id = uuid4().hex
    return save_project(project)


@app.get("/api/projects/{project_id}", response_model=ProjectState)
def get_project(project_id: str, request: Request) -> ProjectState:
    try:
        return owned_project(project_id, request)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.delete("/api/projects/{project_id}")
def remove_project(project_id: str, request: Request) -> dict[str, str]:
    try:
        owned_project(project_id, request)
        delete_project(project_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "deleted"}


@app.post("/api/projects/{project_id}/assets/upload", response_model=AssetUploadResponse)
async def upload_project_asset(
    project_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    asset_type: str = Form("other"),
) -> AssetUploadResponse:
    user = current_user(request)
    try:
        project = load_project(project_id)
        assert_project_owner(project, user.id)
    except FileNotFoundError:
        project = assign_owner(ProjectState(id=project_id), user.id, user.external_id)
        save_project(project)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    project, asset = await upload_asset(project, file, asset_type)
    background_tasks.add_task(parse_uploaded_asset, project.id, asset.id)
    return AssetUploadResponse(project=project, asset=asset)


@app.get("/api/projects/{project_id}/assets")
def list_project_assets(project_id: str, request: Request):
    try:
        project = owned_project(project_id, request)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return project.assets


@app.delete("/api/projects/{project_id}/assets/{asset_id}", response_model=ProjectState)
def delete_project_asset(project_id: str, asset_id: str, request: Request) -> ProjectState:
    try:
        project = owned_project(project_id, request)
        return delete_asset(project, asset_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/projects/{project_id}/assets/{asset_id}/download")
def download_project_asset(project_id: str, asset_id: str, request: Request):
    try:
        project = owned_project(project_id, request)
        path = asset_download_path(project, asset_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return FileResponse(path, filename=next(asset.original_filename for asset in project.assets if asset.id == asset_id))


@app.post("/api/generate/step", response_model=GenerateStepResponse)
def generate_storyboard_step(payload: GenerateStepRequest, request: Request) -> GenerateStepResponse:
    try:
        project, step = generate_step(authorize_project(payload.project, request), payload.step_key)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return GenerateStepResponse(project=project, step=step)


@app.post("/api/generate/full/stream")
def generate_full_stream(payload: GenerateFullRequest, request: Request):
    try:
        return stream_full_document(authorize_project(payload.project, request))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.post("/api/generate/proposal/stream")
def generate_proposal_stream(payload: GenerateFullRequest, request: Request):
    try:
        return stream_proposal_document(authorize_project(payload.project, request))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.post("/api/generate/intake-summary/stream")
def generate_intake_summary_stream(payload: GenerateFullRequest, request: Request):
    try:
        return stream_intake_summary(authorize_project(payload.project, request))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.post("/api/generate/logic-recommendation/stream")
def generate_logic_recommendation_stream(payload: GenerateFullRequest, request: Request):
    try:
        return stream_logic_recommendation(authorize_project(payload.project, request))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.post("/api/generate/style-recommendation/stream")
def generate_style_recommendation_stream(payload: GenerateFullRequest, request: Request):
    try:
        return stream_style_recommendation(authorize_project(payload.project, request))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.post("/api/generate/preview", response_model=PreviewResponse)
def generate_preview(payload: GenerateFullRequest, request: Request) -> PreviewResponse:
    try:
        project, content = generate_creative_preview(authorize_project(payload.project, request))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return PreviewResponse(project=project, content=content)


@app.post("/api/generate/preview/stream")
def generate_preview_stream(payload: GenerateFullRequest, request: Request):
    try:
        return stream_creative_preview(authorize_project(payload.project, request))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.post("/api/export/markdown", response_model=ExportResponse)
def export_markdown(payload: ExportRequest, request: Request) -> ExportResponse:
    try:
        project, path = write_markdown(authorize_project(payload.project, request), payload.markdown, payload.version)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return ExportResponse(
        project=project,
        filename=path.name,
        path=str(path),
        download_url=f"/api/download/{project.id}/export/{payload.version}/markdown",
    )


@app.post("/api/export/docx", response_model=ExportResponse)
def export_docx(payload: ExportRequest, request: Request) -> ExportResponse:
    try:
        project, path = write_docx(authorize_project(payload.project, request), payload.markdown, payload.version)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return ExportResponse(
        project=project,
        filename=path.name,
        path=str(path),
        download_url=f"/api/download/{project.id}/export/{payload.version}/docx",
    )


@app.post("/api/export/html", response_model=ExportResponse)
def export_html(payload: ExportRequest, request: Request) -> ExportResponse:
    try:
        project, path = write_html(authorize_project(payload.project, request), payload.markdown, payload.version)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return ExportResponse(
        project=project,
        filename=path.name,
        path=str(path),
        download_url=f"/api/download/{project.id}/export/{payload.version}/html",
    )


@app.post("/api/export/{version}/{kind}", response_model=ExportResponse)
def export_versioned(version: str, kind: str, payload: ExportRequest, request: Request) -> ExportResponse:
    if version not in {"proposal", "full"} or kind not in {"markdown", "docx", "html"}:
        raise HTTPException(status_code=404, detail="Unknown export type")
    try:
        project_payload = authorize_project(payload.project, request)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if kind == "markdown":
        project, path = write_markdown(project_payload, payload.markdown, version)
    elif kind == "docx":
        project, path = write_docx(project_payload, payload.markdown, version)
    else:
        project, path = write_html(project_payload, payload.markdown, version)
    return ExportResponse(
        project=project,
        filename=path.name,
        path=str(path),
        download_url=f"/api/download/{project.id}/export/{version}/{kind}",
    )


@app.get("/api/download/{project_id}/export/{version}/{kind}")
def download_versioned_export(project_id: str, version: str, kind: str, request: Request):
    if version not in {"proposal", "full"} or kind not in {"markdown", "docx", "html"}:
        raise HTTPException(status_code=404, detail="Unknown export type")
    try:
        project = owned_project(project_id, request)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    export_path = project.exports.get(f"{version}_{kind}")
    folder = project_dir(project_id).resolve()
    path = Path(export_path).resolve() if export_path else None
    if not path or folder not in path.parents or not path.exists():
        suffix = ".docx" if kind == "docx" else ".html" if kind == "html" else ".md"
        label = "提案版" if version == "proposal" else "完整版"
        pattern = f"*_{label}*{suffix}" if kind == "html" else f"*_{label}{suffix}"
        candidates = sorted(folder.glob(pattern), key=lambda item: item.stat().st_mtime, reverse=True)
        path = candidates[0].resolve() if candidates else None
    if not path or folder not in path.parents or not path.exists():
        raise HTTPException(status_code=404, detail=f"{version} {kind} export not found")
    return FileResponse(path, filename=path.name)


@app.get("/api/download/{project_id}/export/{kind}")
def download_export(project_id: str, kind: str, request: Request):
    if kind not in {"markdown", "docx", "html"}:
        raise HTTPException(status_code=404, detail="Unknown export type")
    try:
        project = owned_project(project_id, request)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    export_path = project.exports.get(kind)
    folder = project_dir(project_id).resolve()
    path = Path(export_path).resolve() if export_path else None
    if not path or folder not in path.parents or not path.exists():
        suffix = ".docx" if kind == "docx" else ".html" if kind == "html" else ".md"
        candidates = sorted(folder.glob(f"*{suffix}"), key=lambda item: item.stat().st_mtime, reverse=True)
        path = candidates[0].resolve() if candidates else None
    if not path or folder not in path.parents or not path.exists():
        raise HTTPException(status_code=404, detail=f"{kind} export not found")
    return FileResponse(path, filename=path.name)


@app.get("/api/download/{project_id}/{filename}")
def download(project_id: str, filename: str, request: Request):
    try:
        owned_project(project_id, request)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
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
