from __future__ import annotations

import json
import re
import shutil
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from .models import ProjectState, ProjectSummary


ROOT_DIR = Path(__file__).resolve().parents[1]
OUTPUTS_DIR = Path("/app/outputs") if Path("/app").exists() else ROOT_DIR / "outputs"


def safe_filename(value: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\r\n]+', "_", value).strip()
    return cleaned or "未命名项目"


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def project_dir(project_id: str) -> Path:
    return OUTPUTS_DIR / safe_filename(project_id)


def ensure_project(project: ProjectState) -> ProjectState:
    if not project.id:
        project.id = uuid4().hex
    project.updated_at = now_iso()
    return project


def save_project(project: ProjectState) -> ProjectState:
    project = ensure_project(project)
    folder = project_dir(project.id)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "project.json").write_text(
        project.model_dump_json(indent=2),
        encoding="utf-8",
    )
    return project


def compact_text(value: str, limit: int = 420) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    return f"{text[:limit]}..." if len(text) > limit else text


def asset_lines_for_chat(project: ProjectState, asset_type: str, label: str) -> list[str]:
    lines: list[str] = []
    for asset in project.assets:
        if asset.asset_type != asset_type:
            continue
        if asset.status == "ready" and asset.summary:
            lines.append(f"{label}摘要：{compact_text(asset.summary)}")
        elif asset.status == "failed":
            lines.append(f"{label}解析失败：{compact_text(asset.error or asset.summary or '模型未能解析该素材。', 220)}")
        else:
            lines.append(f"{label}解析中，完成后会用于后续生成。")
    return lines


def sync_asset_message(project: ProjectState) -> ProjectState:
    if not project.assets or not project.messages:
        return project

    reference_lines = asset_lines_for_chat(project, "reference", "参考样片")
    brand_lines = asset_lines_for_chat(project, "brand", "品牌资产")
    if not reference_lines and not brand_lines:
        return project

    prefixes = (
        "参考样片：",
        "品牌资产：",
        "已上传参考样片：",
        "已上传品牌资产：",
        "参考样片摘要：",
        "品牌资产摘要：",
        "参考样片解析失败：",
        "品牌资产解析失败：",
        "参考样片解析中",
        "品牌资产解析中",
    )

    for index in range(len(project.messages) - 1, -1, -1):
        message = project.messages[index]
        if message.role != "user" or ("参考样片" not in message.content and "品牌资产" not in message.content):
            continue

        manual_lines = [
            line
            for line in message.content.splitlines()
            if line.strip() and not line.strip().startswith(prefixes)
        ]
        reference_text = project.meta.reference_samples or "无，按项目定位推荐"
        brand_text = project.meta.brand_assets or "暂未提供"
        message.content = "\n".join(
            [
                f"参考样片：{reference_text}",
                *reference_lines,
                f"品牌资产：{brand_text}",
                *brand_lines,
                *manual_lines,
            ]
        )
        break
    return project


def load_project(project_id: str) -> ProjectState:
    path = project_dir(project_id) / "project.json"
    if not path.exists():
        raise FileNotFoundError(f"Project not found: {project_id}")
    return sync_asset_message(ProjectState.model_validate_json(path.read_text(encoding="utf-8")))


def delete_project(project_id: str) -> None:
    folder = project_dir(project_id).resolve()
    outputs = OUTPUTS_DIR.resolve()
    if outputs == folder or outputs not in folder.parents:
        raise ValueError(f"Unsafe project path: {project_id}")
    if not folder.exists():
        raise FileNotFoundError(f"Project not found: {project_id}")
    shutil.rmtree(folder)


def list_projects() -> list[ProjectSummary]:
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    summaries: list[ProjectSummary] = []
    for path in OUTPUTS_DIR.glob("*/project.json"):
        try:
            project = ProjectState.model_validate_json(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        summaries.append(
            ProjectSummary(
                id=project.id,
                project_name=project.meta.project_name,
                video_type=project.meta.video_type,
                updated_at=project.updated_at,
            )
        )
    return sorted(summaries, key=lambda item: item.updated_at, reverse=True)
