from __future__ import annotations

import json
import os
import re
from typing import Any

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from openai import APIError, OpenAI

from .models import (
    ActiveOutput,
    AssetOverview,
    ChatMessage,
    ContentUnit,
    ExecutionAssumption,
    InsightPanel,
    InsightProjectSummary,
    MissingCard,
    ProjectState,
    StepResult,
    WorkflowStep,
)
from .storage import ensure_project, load_project, now_iso, save_project


WORKFLOW_DEFINITION: list[tuple[str, str]] = [
    ("requirements", "需求采集"),
    ("assets", "素材理解"),
    ("judgement", "项目判断"),
    ("proposal", "提案版生成"),
    ("full", "完整版生成"),
    ("export", "导出交付"),
]


def llm_client() -> OpenAI:
    api_key = os.getenv("LLM_API_KEY") or os.getenv("KIMI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="LLM_API_KEY is not configured on the server.")
    return OpenAI(
        api_key=api_key,
        base_url=os.getenv("LLM_BASE_URL") or os.getenv("KIMI_BASE_URL", "https://open.bigmodel.cn/api/paas/v4/"),
    )


def version_label(version: str) -> str:
    return "提案版" if version == "proposal" else "完整版"


def compact_text(value: str, limit: int = 240) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    return f"{text[:limit]}..." if len(text) > limit else text


def normalize_generation_mode(value: str | None, project: ProjectState, message: str) -> str:
    text = (value or "").strip().lower()
    if text in {"proposal", "full"}:
        return text

    lowered = message.lower()
    if "完整版" in message or "完整稿" in message or "全文" in message:
        return "full"
    if "提案版" in message or ("提案" in message and "完整版" not in message):
        return "proposal"
    if any(keyword in message for keyword in ["重新生成", "生成", "出稿", "开始写", "开始生成", "继续生成"]):
        return "full" if project.proposal_markdown else "proposal"
    if any(keyword in lowered for keyword in ["full", "proposal"]):
        return "full" if "full" in lowered else "proposal"
    return "none"


def append_message(project: ProjectState, role: str, content: str, message_type: str = "chat") -> ChatMessage:
    message = ChatMessage(role=role, content=content, message_type=message_type)
    project.messages.append(message)
    return message


def extract_json_payload(text: str) -> dict[str, Any]:
    content = (text or "").strip()
    if not content:
        return {}

    fence_match = re.search(r"```(?:json)?\s*(\{.*\})\s*```", content, re.S)
    if fence_match:
        content = fence_match.group(1)
    else:
        start = content.find("{")
        end = content.rfind("}")
        if start >= 0 and end > start:
            content = content[start : end + 1]
    return json.loads(content)


def summarize_assets(project: ProjectState) -> str:
    if not project.assets:
        return "暂无上传素材。"

    labels = {"reference": "参考资料", "brand": "品牌资料", "other": "补充材料"}
    lines: list[str] = []
    for index, asset in enumerate(project.assets, 1):
        summary = asset.summary or asset.error or "暂无摘要"
        lines.append(
            "\n".join(
                [
                    f"{index}. 文件：{asset.original_filename}",
                    f"   类型：{labels.get(asset.asset_type, '补充材料')}",
                    f"   状态：{asset.status}",
                    f"   摘要：{compact_text(summary, 320)}",
                ]
            )
        )
    return "\n".join(lines)


def summarize_units(project: ProjectState) -> str:
    if not project.content_units:
        return "暂无明确内容单元。"
    return "\n".join(
        f"{index}. {unit.name or '未命名'}：卖点={unit.selling_points or '未补充'}；命名口径={unit.naming or '未补充'}"
        for index, unit in enumerate(project.content_units, 1)
    )


def summarize_assumptions(project: ProjectState) -> str:
    if not project.execution_assumptions:
        return "暂无执行假设。"
    source_labels = {"asset": "素材提取", "user": "用户明确说明", "system": "系统合理补全"}
    return "\n".join(
        f"{index}. {item.title or '未命名'}（{source_labels.get(item.source, item.source)}）：{item.detail}"
        for index, item in enumerate(project.execution_assumptions, 1)
    )


def summarize_recent_messages(project: ProjectState, limit: int = 8) -> str:
    if not project.messages:
        return "暂无历史对话。"
    recent = project.messages[-limit:]
    return "\n".join(f"- {message.role}: {compact_text(message.content, 220)}" for message in recent)


def project_snapshot(project: ProjectState) -> str:
    meta = project.meta
    duration_text = infer_duration_from_context(project) or (meta.duration if meta.duration and meta.duration != "3分钟" else "未明确")
    return f"""项目名称：{meta.project_name}
客户类型：{meta.client_type}
影片类型：{meta.video_type}
时长：{duration_text}
画幅比例：{meta.aspect_ratio}
风格基调：{meta.style or "未明确"}
品牌资产：{meta.brand_assets or "未明确"}
参考风格：{meta.reference_samples or "未明确"}

内容单元：
{summarize_units(project)}

素材摘要：
{summarize_assets(project)}

已有执行假设：
{summarize_assumptions(project)}

最近对话：
{summarize_recent_messages(project)}"""


def analyze_user_message(project: ProjectState, message: str) -> dict[str, Any]:
    prompt = f"""你是“对话式分镜生成”的编排助手。请根据项目当前状态、素材摘要和用户最新输入，输出一个 JSON 对象，不要输出任何额外解释。

目标：
1. 自动补齐项目定位、内容单元、风格和修改意见。
2. 当关键信息仍然缺失时，用 should_prompt_missing=true 标记需要补充，具体追问轮次由系统控制。
3. 如果用户已经表达了“生成提案版/完整版/继续生成”的意图，即使资料不完整也要继续。
4. reply 要简洁，像导演助理在推进流程，不要长篇解释。

硬规则：
- 只输出 JSON。
- generation_mode 只能是 "none"、"proposal"、"full"。
- should_prompt_missing 只在你判断当前信息仍缺少关键项时设为 true。
- missing_hint 只写一句自然中文。
- execution_assumptions 最多返回 6 条，source 只能是 "asset"、"user"、"system"。
- 如果无法确定字段，就返回空字符串或空数组，不要编造品牌名、客户名、真实链接。

项目状态：
{project_snapshot(project)}

用户最新输入：
{message}

请输出：
{{
  "project_updates": {{
    "project_name": "",
    "client_type": "",
    "video_type": "",
    "duration": "",
    "aspect_ratio": "",
    "style": "",
    "brand_assets": "",
    "reference_samples": ""
  }},
  "content_units": [
    {{
      "name": "",
      "selling_points": "",
      "naming": ""
    }}
  ],
  "revision_note": "",
  "reply": "",
  "missing_hint": "",
  "should_prompt_missing": false,
  "generation_mode": "none",
  "execution_assumptions": [
    {{
      "source": "system",
      "title": "",
      "detail": ""
    }}
  ]
}}"""

    try:
        response = llm_client().chat.completions.create(
            model=os.getenv("LLM_MODEL") or os.getenv("KIMI_MODEL", "glm-5.1"),
            messages=[
                {"role": "system", "content": "你是严谨的 JSON 输出助手，只能返回 JSON 对象。"},
                {"role": "user", "content": prompt},
            ],
        )
    except APIError as exc:
        raise HTTPException(status_code=502, detail=f"LLM API 调用失败：{exc.message}") from exc

    content = response.choices[0].message.content if response.choices else ""
    try:
        payload = extract_json_payload(content or "")
    except Exception:
        payload = {}

    payload["generation_mode"] = normalize_generation_mode(payload.get("generation_mode"), project, message)
    return payload


def merge_assumptions(project: ProjectState, items: list[dict[str, Any]] | None) -> None:
    if not items:
        return

    known = {(item.source, item.title.strip(), item.detail.strip()) for item in project.execution_assumptions}
    for raw in items:
        source = str(raw.get("source") or "system").strip().lower()
        title = str(raw.get("title") or "").strip()
        detail = str(raw.get("detail") or "").strip()
        if source not in {"asset", "user", "system"} or not detail:
            continue
        key = (source, title, detail)
        if key in known:
            continue
        project.execution_assumptions.append(ExecutionAssumption(source=source, title=title, detail=detail))
        known.add(key)


def has_explicit_duration_text(text: str) -> bool:
    duration_units = r"分钟|秒钟|minutes|minute|seconds|second|mins|secs|min|sec|分|秒|m|s"
    return bool(
        re.search(
            rf"\d+(?:\.\d+)?\s*({duration_units})",
            text or "",
            re.I,
        )
    )


def has_video_duration_context(text: str) -> bool:
    content = text or ""
    duration_units = r"分钟|秒钟|minutes|minute|seconds|second|mins|secs|min|sec|分|秒|m|s"
    pattern = re.compile(
        rf"(片长|时长|总时长|成片|视频|影片|宣传片|分镜|版本)[^\n。；;]{{0,24}}\d+(?:\.\d+)?\s*({duration_units})"
        r"|"
        rf"\d+(?:\.\d+)?\s*({duration_units})[^\n。；;]{{0,24}}(片长|时长|总时长|成片|视频|影片|宣传片|分镜|版本)",
        re.I,
    )
    return bool(pattern.search(content))


def duration_has_source(project: ProjectState, value: str, latest_message: str = "") -> bool:
    if not value or not has_explicit_duration_text(value):
        return False
    if has_explicit_duration_text(latest_message):
        return True
    for asset in project.assets:
        if has_video_duration_context(asset.summary) or has_video_duration_context(asset.extracted_text):
            return True
    for message in project.messages[-8:]:
        if has_explicit_duration_text(message.content):
            return True
    return False


def apply_project_updates(project: ProjectState, payload: dict[str, Any], latest_message: str = "") -> None:
    updates = payload.get("project_updates") or {}
    meta = project.meta
    mapping = {
        "project_name": "project_name",
        "client_type": "client_type",
        "video_type": "video_type",
        "duration": "duration",
        "aspect_ratio": "aspect_ratio",
        "style": "style",
        "brand_assets": "brand_assets",
        "reference_samples": "reference_samples",
    }
    for key, attr in mapping.items():
        value = str(updates.get(key) or "").strip()
        if value:
            if key == "duration" and not duration_has_source(project, value, latest_message):
                continue
            setattr(meta, attr, value)

    units = payload.get("content_units") or []
    normalized_units: list[ContentUnit] = []
    for raw in units:
        name = str(raw.get("name") or "").strip()
        selling_points = str(raw.get("selling_points") or "").strip()
        naming = str(raw.get("naming") or "").strip()
        if name or selling_points or naming:
            normalized_units.append(ContentUnit(name=name, selling_points=selling_points, naming=naming))
    if normalized_units:
        project.content_units = normalized_units

    revision_note = str(payload.get("revision_note") or "").strip()
    if revision_note:
        project.steps["revision"] = StepResult(
            key="revision",
            title="最新修改意见",
            content=revision_note,
            confirmed=True,
            updated_at=now_iso(),
        )
        merge_assumptions(project, [{"source": "user", "title": "最新修改意见", "detail": revision_note}])

    merge_assumptions(project, payload.get("execution_assumptions") or [])
    project.stage = "chat"


def hydrate_project(project: ProjectState) -> ProjectState:
    project = ensure_project(project.model_copy(deep=True))
    if not project.id:
        return project
    try:
        saved = load_project(project.id)
    except FileNotFoundError:
        return project

    if not project.messages:
        project.messages = saved.messages
    if not project.assets:
        project.assets = saved.assets
    if not project.content_units:
        project.content_units = saved.content_units
    if not project.execution_assumptions:
        project.execution_assumptions = saved.execution_assumptions
    if not project.steps:
        project.steps = saved.steps
    if not project.proposal_markdown:
        project.proposal_markdown = saved.proposal_markdown
    if not project.full_markdown:
        project.full_markdown = saved.full_markdown
    if not project.final_markdown:
        project.final_markdown = saved.final_markdown
    if not project.exports:
        project.exports = saved.exports
    if not project.selection_state:
        project.selection_state = saved.selection_state
    return project

def extract_audience_from_text(text: str) -> str:
    content = (text or "").strip()
    if not content:
        return ""

    explicit = re.search(r"(?:目标受众|受众|面向人群)[：:\s]*([^\n，。；;]+)", content)
    if explicit:
        candidate = explicit.group(1).strip()
        if candidate:
            return candidate

    keyword_map = [
        ("消费者", "消费者"),
        ("C端", "消费者"),
        ("用户", "普通用户"),
        ("市民", "市民"),
        ("车主", "车主"),
        ("家庭", "家庭用户"),
        ("客户决策层", "客户决策层"),
        ("决策层", "客户决策层"),
        ("政府", "政务决策者"),
        ("政务", "政务决策者"),
        ("企业管理层", "企业管理层"),
        ("管理层", "企业管理层"),
    ]
    for keyword, label in keyword_map:
        if keyword in content:
            return label
    return ""


def detect_audience(project: ProjectState) -> str:
    candidates = [
        project.steps.get("revision").content if project.steps.get("revision") else "",
        *(message.content for message in project.messages[-8:]),
        *(assumption.detail for assumption in project.execution_assumptions if "受众" in assumption.title or "受众" in assumption.detail),
    ]
    for text in candidates:
        if "管理层" in text:
            return "企业管理层"
        if "政务" in text:
            return "政务决策者"
        if "客户" in text:
            return "客户决策层"
    return "待系统判断"


def detect_missing_items(project: ProjectState) -> list[str]:
    missing: list[str] = []
    if not project.meta.project_name or "未命名" in project.meta.project_name:
        missing.append("项目名称")
    if not project.content_units:
        missing.append("内容单元")
    if not project.meta.style:
        missing.append("风格基调")
    if not project.meta.duration:
        missing.append("片长")
    if not project.meta.brand_assets:
        missing.append("品牌口径")
    if detect_audience(project) == "待系统判断":
        missing.append("目标受众")
    return missing


def build_asset_overview(project: ProjectState) -> AssetOverview:
    ready_assets = [asset for asset in project.assets if asset.status == "ready"]
    processing_assets = [asset for asset in project.assets if asset.status == "processing"]
    failed_assets = [asset for asset in project.assets if asset.status == "failed"]
    highlighted = [asset.original_filename for asset in ready_assets[:3]]
    return AssetOverview(
        total=len(project.assets),
        ready=len(ready_assets),
        processing=len(processing_assets),
        failed=len(failed_assets),
        highlighted=highlighted,
    )


def infer_workflow_stage(project: ProjectState, generation_mode: str) -> str:
    if project.exports:
        return "export"
    if generation_mode == "full" or project.full_markdown:
        return "full"
    if generation_mode == "proposal" or project.proposal_markdown:
        return "proposal"
    if project.assets and (project.content_units or project.meta.style):
        return "judgement"
    if project.assets:
        return "assets"
    return "requirements"


def build_workflow_steps(active_stage: str) -> list[WorkflowStep]:
    steps: list[WorkflowStep] = []
    active_index = next((index for index, item in enumerate(WORKFLOW_DEFINITION) if item[0] == active_stage), 0)
    for index, (key, label) in enumerate(WORKFLOW_DEFINITION):
        if index < active_index:
            status = "completed"
        elif index == active_index:
            status = "active"
        else:
            status = "upcoming"
        steps.append(WorkflowStep(key=key, label=label, status=status))
    return steps


def output_focus_for_stage(project: ProjectState, stage: str, generation_mode: str) -> ActiveOutput:
    if stage == "proposal":
        return ActiveOutput(
            version="proposal",
            label="提案版",
            focus_title="创意主轴与提案结构",
            focus_summary="优先收敛项目定位、创意主轴、总旁白和提案版分镜表。",
            status="generating" if generation_mode == "proposal" else "ready",
        )
    if stage == "full":
        return ActiveOutput(
            version="full",
            label="完整版",
            focus_title="执行级分镜脚本",
            focus_summary="补齐镜头执行细节、拍摄建议、交付分工和可拆条版本。",
            status="generating" if generation_mode == "full" else "ready",
        )
    if stage == "judgement":
        return ActiveOutput(
            version="",
            label="项目判断",
            focus_title="定位、风格与受众归纳",
            focus_summary="正在整理项目定位、目标受众和风格判断，为正式出稿做准备。",
            status="active",
        )
    if stage == "assets":
        return ActiveOutput(
            version="",
            label="素材理解",
            focus_title="素材摘要与可用信息",
            focus_summary="正在分析上传资料的关键信息、风格线索和可用画面。",
            status="active",
        )
    if stage == "export":
        return ActiveOutput(
            version=project.active_version,
            label="导出交付",
            focus_title="文档已具备导出条件",
            focus_summary="当前文档已可导出 Markdown 或 Word，可继续补充后重生成。",
            status="ready",
        )
    return ActiveOutput(
        version="",
        label="需求采集",
        focus_title="收集项目信息",
        focus_summary="先确认项目目标、时长、风格和核心内容单元。",
        status="active",
    )


def build_shot_highlights(project: ProjectState) -> list[str]:
    highlights: list[str] = []
    for unit in project.content_units[:5]:
        if unit.selling_points:
            highlights.append(f"{unit.name or '内容单元'}：突出 {compact_text(unit.selling_points, 36)}")
        elif unit.naming:
            highlights.append(f"{unit.name or '内容单元'}：统一命名为 {compact_text(unit.naming, 28)}")

    if not highlights:
        for asset in project.assets[:3]:
            source = asset.summary or asset.error
            if source:
                highlights.append(f"{asset.original_filename}：{compact_text(source, 42)}")

    if not highlights:
        highlights = [
            "建议先建立项目开场定位镜头，明确品牌场景。",
            "中段突出服务能力或核心卖点，形成记忆点。",
            "结尾收束到品牌价值与统一口径，便于导出成交付版。",
        ]
    return highlights[:5]


def build_tags(project: ProjectState) -> list[str]:
    tags: list[str] = []
    for value in [project.meta.client_type, project.meta.video_type, project.meta.duration]:
        if value:
            tags.append(value)
    if project.meta.style:
        tags.extend([item.strip() for item in re.split(r"[，,、/ ]+", project.meta.style) if item.strip()][:3])
    tags.extend([unit.name for unit in project.content_units[:2] if unit.name])
    deduped: list[str] = []
    for tag in tags:
        if tag not in deduped:
            deduped.append(tag)
    return deduped[:8]


def build_stage_summary(project: ProjectState, stage: str, generation_mode: str) -> str:
    stage_map = {
        "requirements": "正在收集项目基础信息，先把目标、时长、风格和内容单元聊清楚。",
        "assets": "已进入素材理解阶段，系统会优先提取上传资料中的摘要与视觉线索。",
        "judgement": "已进入项目判断阶段，正在归纳定位、受众、风格和执行假设。",
        "proposal": "已进入提案版生成阶段，重点形成创意主轴、旁白和提案级分镜结构。",
        "full": "已进入完整版生成阶段，重点补齐执行级镜头、拍摄建议和交付内容。",
        "export": "当前文档已进入导出交付阶段，可直接导出，也可继续补充后重生成。",
    }
    summary = stage_map.get(stage, stage_map["requirements"])
    if generation_mode in {"proposal", "full"}:
        summary += f" 当前输出：{version_label(generation_mode)}。"
    if detect_missing_items(project) and stage in {"requirements", "assets", "judgement"}:
        summary += f" 仍待补齐：{'、'.join(detect_missing_items(project)[:3])}。"
    return summary


def build_missing_card(project: ProjectState, missing_text: str) -> MissingCard | None:
    if not missing_text:
        return None
    missing_items = detect_missing_items(project)
    title = f"还需补齐：{'、'.join(missing_items[:3])}" if missing_items else "还需补齐少量信息"
    return MissingCard(title=title, body=missing_text, tone="info")


def build_insight_panel(project: ProjectState) -> InsightPanel:
    stage_label = next((label for key, label in WORKFLOW_DEFINITION if key == project.workflow_stage), "需求采集")
    assumptions = [
        f"{item.title or '未命名假设'}：{compact_text(item.detail, 52)}"
        for item in project.execution_assumptions[:4]
    ]
    if not assumptions:
        assumptions = ["暂无明确执行假设，系统会在缺项阶段合理补齐。"]

    asset_summary = [
        f"已上传 {project.asset_overview.total} 份素材，其中可用 {project.asset_overview.ready} 份。"
    ]
    if project.asset_overview.failed:
        asset_summary.append(f"{project.asset_overview.failed} 份素材解析失败，但不影响继续生成。")
    if project.asset_overview.highlighted:
        asset_summary.append(f"当前优先引用：{'、'.join(project.asset_overview.highlighted)}")

    stage_badge = {
        "requirements": "仍需少量信息",
        "assets": "素材解析中",
        "judgement": "正在归纳判断",
        "proposal": "当前输出为提案版",
        "full": "当前输出为完整版",
        "export": "已具备导出条件",
    }.get(project.workflow_stage, "正在处理中")

    return InsightPanel(
        stage=project.workflow_stage,
        stage_label=stage_label,
        stage_summary=project.stage_summary,
        badge=stage_badge,
        project_summary=InsightProjectSummary(
            positioning=f"{project.meta.client_type} · {project.meta.video_type}",
            audience=detect_audience(project),
            style=project.meta.style or "待系统判断",
            duration=project.meta.duration or "待补充",
            version_target=version_label(project.active_output.version) if project.active_output.version else "待确定",
        ),
        assumptions=assumptions,
        asset_summary=asset_summary,
        current_output=project.active_output,
        shot_highlights=build_shot_highlights(project),
        tags=build_tags(project),
    )


def refresh_project_context(project: ProjectState, generation_mode: str, missing_text: str = "") -> ProjectState:
    stage = infer_workflow_stage(project, generation_mode)
    project.workflow_stage = stage
    project.workflow_steps = build_workflow_steps(stage)
    project.asset_overview = build_asset_overview(project)
    project.active_output = output_focus_for_stage(project, stage, generation_mode)
    project.stage_summary = build_stage_summary(project, stage, generation_mode)
    project.missing_card = build_missing_card(project, missing_text)
    project.insight_panel = build_insight_panel(project)
    return project


def resolve_missing_prompt(project: ProjectState, payload: dict[str, Any], generation_mode: str) -> tuple[str, bool]:
    missing_hint = str(payload.get("missing_hint") or "").strip()
    missing_signal = bool(payload.get("should_prompt_missing") and missing_hint)
    round_key = "missing_followup_round"

    if generation_mode != "none":
        project.selection_state.pop(round_key, None)
        return "", False

    if not missing_signal:
        project.selection_state.pop(round_key, None)
        return "", False

    current_round = int(project.selection_state.get(round_key, 0) or 0)
    if current_round <= 0:
        project.selection_state[round_key] = 1
        return missing_hint, False

    if current_round == 1:
        project.selection_state[round_key] = 2
        follow_up = (
            f"{missing_hint}\n\n"
            "如果你这轮方便，补一句相关信息我就能贴得更准；如果这轮还不补，我下一步就按现有资料和合理假设自动补齐。"
        )
        return follow_up, False

    project.selection_state.pop(round_key, None)
    auto_fill_reply = "收到，这部分我不再继续追问了。接下来我会按现有资料和合理假设自动补齐，后续你随时补充我也会一起吸收。"
    return auto_fill_reply, True


def apply_collection_defaults(project: ProjectState) -> None:
    default_assumptions: list[dict[str, str]] = []

    if not project.meta.project_name or "未命名" in project.meta.project_name:
        project.meta.project_name = "智能生成分镜项目"
        default_assumptions.append(
            {"source": "system", "title": "项目名称", "detail": "未提供明确项目名，先以“智能生成分镜项目”作为工作标题。"}
        )

    if not project.meta.style:
        project.meta.style = "政务科技感"
        default_assumptions.append(
            {"source": "system", "title": "风格基调", "detail": "未提供风格方向，先按政务科技感、稳重克制的表达处理。"}
        )

    if not project.meta.brand_assets:
        project.meta.brand_assets = "未提供明确品牌口径，先按统一、可信、专业的品牌表达处理。"
        default_assumptions.append(
            {
                "source": "system",
                "title": "品牌口径",
                "detail": "未提供品牌手册或口径，先按统一、可信、专业的默认品牌表达补齐。",
            }
        )

    if not project.content_units:
        project.content_units = [
            ContentUnit(name="项目背景", selling_points="交代项目场景、建设背景与任务目标", naming="开场建立认知"),
            ContentUnit(name="核心能力", selling_points="突出服务能力、系统能力或执行成效", naming="中段建立信服"),
            ContentUnit(name="价值收束", selling_points="回到品牌价值、社会价值与合作信心", naming="结尾完成收束"),
        ]
        default_assumptions.append(
            {"source": "system", "title": "内容单元", "detail": "未提供内容结构，先按背景、能力、价值收束三段式补齐。"}
        )

    if not project.meta.reference_samples:
        project.meta.reference_samples = "未提供明确参考样片，先按政务企业宣传片常规节奏与镜头语言处理。"
        default_assumptions.append(
            {
                "source": "system",
                "title": "参考风格",
                "detail": "未提供参考样片，先按政务企业宣传片常规节奏、航拍加现场纪实的组合处理。",
            }
        )

    merge_assumptions(project, default_assumptions)


def enforce_collection_gate(project: ProjectState, payload: dict[str, Any], generation_mode: str) -> tuple[str, bool, str]:
    missing_hint = str(payload.get("missing_hint") or "").strip()
    missing_signal = bool(payload.get("should_prompt_missing") and missing_hint)
    round_key = "missing_followup_round"
    pending_mode_key = "pending_generation_mode"

    if generation_mode == "none":
        project.selection_state.pop(pending_mode_key, None)

    if generation_mode != "none" and missing_signal:
        current_round = int(project.selection_state.get(round_key, 0) or 0)
        project.selection_state[pending_mode_key] = generation_mode

        if current_round <= 0:
            project.selection_state[round_key] = 1
            return (
                f"{missing_hint}\n\n先进入“需求采集”这一步。我先把关键信息收一轮，你补一句就行；补完我再继续生成。",
                False,
                "none",
            )

        if current_round == 1:
            project.selection_state[round_key] = 2
            return (
                f"{missing_hint}\n\n我再追问这一轮：你现在只要补一句关键信息即可；如果这轮仍然不补，我下一步就按现有资料和合理假设自动补全，并继续生成。",
                False,
                "none",
            )

        project.selection_state.pop(round_key, None)
        project.selection_state.pop(pending_mode_key, None)
        apply_collection_defaults(project)
        return (
            "这一步我先不继续追问了。接下来会先按现有资料和合理假设自动补齐信息，再继续进入生成。",
            True,
            generation_mode,
        )

    if not missing_signal:
        project.selection_state.pop(round_key, None)
        restored_mode = str(project.selection_state.pop(pending_mode_key, generation_mode) or generation_mode)
        return "", False, restored_mode

    current_round = int(project.selection_state.get(round_key, 0) or 0)
    if current_round <= 0:
        project.selection_state[round_key] = 1
        return missing_hint, False, generation_mode

    if current_round == 1:
        project.selection_state[round_key] = 2
        follow_up = (
            f"{missing_hint}\n\n"
            "如果你这轮方便，补一句相关信息我就能贴得更准；如果这轮还不补，我下一步就按现有资料和合理假设自动补齐。"
        )
        return follow_up, False, generation_mode

    project.selection_state.pop(round_key, None)
    apply_collection_defaults(project)
    auto_fill_reply = "收到，这部分我不再继续追问了。接下来我会按现有资料和合理假设自动补齐，后续你随时补充我也会一起吸收。"
    return auto_fill_reply, True, generation_mode


def build_stage_prefix(project: ProjectState, generation_mode: str) -> str:
    stage_label = next((label for key, label in WORKFLOW_DEFINITION if key == project.workflow_stage), "需求采集")
    if generation_mode in {"proposal", "full"}:
        return f"已进入「{stage_label}」，当前输出目标是{version_label(generation_mode)}。"
    if project.workflow_stage == "judgement":
        return f"已进入「{stage_label}」，我会先把定位、风格和执行假设收拢清楚。"
    if project.workflow_stage == "assets":
        return f"已进入「{stage_label}」，我会优先消化上传资料里的关键信息。"
    if project.workflow_stage == "requirements":
        return f"当前处于「{stage_label}」，先把项目基础信息补齐。"
    if project.workflow_stage == "export":
        return "当前内容已进入「导出交付」，你也可以继续补充后重生成。"
    return f"已进入「{stage_label}」，我会继续往下推进。"


def compose_reply(project: ProjectState, payload: dict[str, Any], generation_mode: str, missing_text: str = "") -> str:
    parts: list[str] = [build_stage_prefix(project, generation_mode)]
    if missing_text:
        parts.append(missing_text)

    reply = str(payload.get("reply") or "").strip()
    if reply:
        parts.append(reply)

    if project.workflow_stage in {"proposal", "full", "export"} and generation_mode == "none":
        parts.append("这条补充我已经记录，会影响后续生成或下一轮重生成。")

    return "\n\n".join(part for part in parts if part).strip()


def extract_audience_from_text_v2(text: str) -> str:
    content = (text or "").strip()
    if not content:
        return ""

    explicit = re.search(r"(?:目标受众|受众|面向人群)[：:\s]*([^\n，。；;]+)", content)
    if explicit:
        candidate = explicit.group(1).strip()
        if candidate:
            return candidate

    keyword_map = [
        ("消费者", "消费者"),
        ("C端", "消费者"),
        ("用户", "普通用户"),
        ("市民", "市民"),
        ("车主", "车主"),
        ("家庭", "家庭用户"),
        ("客户决策层", "客户决策层"),
        ("决策层", "客户决策层"),
        ("政府", "政务决策者"),
        ("政务", "政务决策者"),
        ("企业管理层", "企业管理层"),
        ("管理层", "企业管理层"),
    ]
    for keyword, label in keyword_map:
        if keyword in content:
            return label
    return ""


def detect_audience(project: ProjectState) -> str:
    candidates = [
        project.steps.get("revision").content if project.steps.get("revision") else "",
        *(message.content for message in project.messages[-8:]),
        *(assumption.detail for assumption in project.execution_assumptions if "受众" in assumption.title or "受众" in assumption.detail),
    ]
    for text in candidates:
        explicit = extract_audience_from_text_v2(text)
        if explicit:
            return explicit
    return "待系统判断"


def infer_duration_from_context(project: ProjectState) -> str:
    candidates = [
        project.steps.get("revision").content if project.steps.get("revision") else "",
        *(message.content for message in project.messages[-8:]),
        *(assumption.detail for assumption in project.execution_assumptions if "片长" in assumption.title or "时长" in assumption.title),
    ]
    duration_units = r"分钟|秒钟|minutes|minute|seconds|second|mins|secs|min|sec|分|秒|m|s"
    pattern = re.compile(rf"(\d+(?:\.\d+)?)\s*({duration_units})", re.I)
    for text in candidates:
        match = pattern.search(text or "")
        if not match:
            continue
        value = match.group(1)
        unit = match.group(2).lower()
        if unit in {"分钟", "分", "m", "min", "mins", "minute", "minutes"}:
            return f"{value}分钟"
        return f"{value}秒"
    return ""


def detect_missing_items(project: ProjectState) -> list[str]:
    missing: list[str] = []
    if not project.meta.project_name or "未命名" in project.meta.project_name:
        missing.append("项目名称")
    if not project.content_units:
        missing.append("内容单元")
    if not project.meta.style:
        missing.append("风格基调")
    explicit_duration = infer_duration_from_context(project)
    if not explicit_duration and (not project.meta.duration or project.meta.duration == "3分钟"):
        missing.append("片长")
    if not project.meta.brand_assets:
        missing.append("品牌口径")
    if detect_audience(project) == "待系统判断":
        missing.append("目标受众")
    return missing


def build_missing_prompt(project: ProjectState, second_round: bool = False, gated: bool = False) -> str:
    missing_items = detect_missing_items(project)
    if not missing_items:
        return ""

    joined = "、".join(missing_items)
    prefix = f"当前还缺这些关键信息：{joined}。"
    if gated:
        prefix += "先进入“需求采集”这一步。"

    if second_round:
        suffix = "你可以这一轮一次性补全；如果这轮仍然不补，我下一步就按现有资料和合理假设自动补齐。"
    else:
        suffix = "你可以一次性把这些信息补齐；如果暂时补不全，我会再追问一轮，之后自动补齐。"
    return f"{prefix}{suffix}"


def build_update_receipt(project: ProjectState, payload: dict[str, Any], latest_message: str) -> str:
    updates = payload.get("project_updates") or {}
    labels = {
        "project_name": "项目名称",
        "client_type": "项目定位",
        "video_type": "片型",
        "duration": "片长",
        "style": "风格基调",
        "brand_assets": "品牌口径",
        "reference_samples": "参考风格",
    }

    confirmations: list[str] = []
    for key, label in labels.items():
        value = str(updates.get(key) or "").strip()
        if value:
            if key == "duration" and not duration_has_source(project, value, latest_message):
                continue
            confirmations.append(f"{label}已记录")

    audience = extract_audience_from_text_v2(latest_message)
    if audience:
        confirmations.append(f"目标受众已记录为{audience}")

    if payload.get("content_units"):
        confirmations.append("内容单元已补充")

    revision_note = str(payload.get("revision_note") or "").strip()
    if revision_note:
        confirmations.append("修改意见已记录")

    if not confirmations:
        return ""
    return "收到，" + "；".join(confirmations[:4]) + "。"


def sanitize_reply_text(reply: str, missing_text: str) -> str:
    cleaned = (reply or "").strip()
    if not cleaned:
        return ""
    if missing_text and ("?" in cleaned or "？" in cleaned):
        return ""
    return cleaned


def enforce_collection_gate(project: ProjectState, payload: dict[str, Any], generation_mode: str) -> tuple[str, bool, str]:
    round_key = "missing_followup_round"
    signature_key = "missing_signature"
    pending_mode_key = "pending_generation_mode"
    ready_mode_key = "ready_generation_mode"
    missing_items = detect_missing_items(project)
    missing_signature = "|".join(missing_items)

    if generation_mode != "none":
        project.selection_state.pop(ready_mode_key, None)

    if not missing_items:
        project.selection_state.pop(round_key, None)
        project.selection_state.pop(signature_key, None)
        pending_mode = str(project.selection_state.pop(pending_mode_key, "") or "")
        if generation_mode == "none" and pending_mode in {"proposal", "full"}:
            project.selection_state[ready_mode_key] = pending_mode
            return "", False, "none"
        return "", False, generation_mode

    current_round = int(project.selection_state.get(round_key, 0) or 0)
    project.selection_state[signature_key] = missing_signature

    if generation_mode != "none":
        project.selection_state[pending_mode_key] = generation_mode
        if current_round <= 0:
            project.selection_state[round_key] = 1
            return build_missing_prompt(project, second_round=False, gated=True), False, "none"
        if current_round == 1:
            project.selection_state[round_key] = 2
            return build_missing_prompt(project, second_round=True, gated=True), False, "none"
        project.selection_state.pop(round_key, None)
        project.selection_state.pop(signature_key, None)
        project.selection_state.pop(pending_mode_key, None)
        project.selection_state.pop(ready_mode_key, None)
        apply_collection_defaults(project)
        return "收到，这部分我先按现有资料和合理假设自动补齐。信息已经收拢，下一步你可以在对话框里告诉我“生成提案版”或“生成完整版”。", True, "none"

    if current_round <= 0:
        project.selection_state[round_key] = 1
        return build_missing_prompt(project), False, generation_mode
    if current_round == 1:
        project.selection_state[round_key] = 2
        return build_missing_prompt(project, second_round=True), False, generation_mode

    project.selection_state.pop(round_key, None)
    project.selection_state.pop(signature_key, None)
    apply_collection_defaults(project)
    return "收到，这部分我不再继续追问了。接下来我会按现有资料和合理假设自动补齐，后续你随时补充我也会一起吸收。", True, generation_mode


def compose_reply(project: ProjectState, payload: dict[str, Any], generation_mode: str, missing_text: str = "", latest_message: str = "") -> str:
    receipt = build_update_receipt(project, payload, latest_message)
    reply = sanitize_reply_text(str(payload.get("reply") or ""), missing_text)
    ready_mode = str(project.selection_state.pop("ready_generation_mode", "") or "")
    missing_items = detect_missing_items(project)
    parts: list[str] = []

    if receipt:
        parts.append(receipt)
    elif reply:
        parts.append(reply)

    parts.append(build_stage_prefix(project, generation_mode))

    if missing_text:
        parts.append(missing_text)
    elif ready_mode in {"proposal", "full"}:
        parts.append(f"信息已经收拢，下面可以开始生成{version_label(ready_mode)}。如果确认方向没问题，你在对话框里发送“生成{version_label(ready_mode)}”，我再正式开始出稿。")
    elif not missing_items and generation_mode == "none" and not project.proposal_markdown:
        parts.append("信息已经收拢，现在可以开始生成提案版分镜了。你可以直接发送“生成提案版”，我会先输出一版用于确认创意方向和结构。")
    elif not missing_items and generation_mode == "none" and project.proposal_markdown and not project.full_markdown:
        parts.append("当前提案版信息已经具备。你可以继续补充修改意见，或直接发送“生成完整版”，我会把提案扩展成执行级分镜脚本。")
    elif reply and not receipt and reply not in parts:
        parts.append(reply)

    if project.workflow_stage in {"proposal", "full", "export"} and generation_mode == "none":
        parts.append("这条补充我已经记录，会影响后续生成或下一轮重生成。")

    return "\n\n".join(part for part in parts if part).strip()


def project_source_text(project: ProjectState) -> str:
    parts: list[str] = []
    parts.extend(message.content for message in project.messages[-12:])
    for asset in project.assets:
        parts.append(asset.summary)
        parts.append(asset.extracted_text[:1200])
    parts.extend(assumption.detail for assumption in project.execution_assumptions)
    return "\n".join(part for part in parts if part)


def value_has_source(value: str, project: ProjectState, keywords: list[str] | None = None) -> bool:
    if not value:
        return False
    source_text = project_source_text(project)
    candidates = [value, *(keywords or [])]
    return any(candidate and candidate in source_text for candidate in candidates)


def display_project_positioning(project: ProjectState) -> str:
    client_type = (project.meta.client_type or "").strip()
    video_type = (project.meta.video_type or "").strip()
    parts: list[str] = []

    if client_type and (client_type != "企业" or value_has_source(client_type, project, ["公司", "集团", "品牌", "政务", "政府", "园区"])):
        parts.append(client_type)
    if video_type and (video_type != "宣传片" or value_has_source(video_type, project, ["宣传片", "产品介绍", "产品", "品牌片", "形象片"])):
        parts.append(video_type)

    return " · ".join(parts) if parts else "待系统判断"


def build_insight_panel(project: ProjectState) -> InsightPanel:
    stage_label = next((label for key, label in WORKFLOW_DEFINITION if key == project.workflow_stage), "需求采集")
    assumptions = [
        f"{item.title or '未命名假设'}：{compact_text(item.detail, 52)}"
        for item in project.execution_assumptions[:4]
    ]
    if not assumptions:
        assumptions = ["暂无明确执行假设，系统会在缺项阶段合理补齐。"]

    asset_summary = [
        f"已上传 {project.asset_overview.total} 份素材，其中可用 {project.asset_overview.ready} 份。"
    ]
    if project.asset_overview.failed:
        asset_summary.append(f"{project.asset_overview.failed} 份素材解析失败，但不影响继续生成。")
    if project.asset_overview.highlighted:
        asset_summary.append(f"当前优先引用：{'、'.join(project.asset_overview.highlighted)}")

    stage_badge = {
        "requirements": "仍需少量信息",
        "assets": "素材解析中",
        "judgement": "正在归纳判断",
        "proposal": "当前输出为提案版",
        "full": "当前输出为完整版",
        "export": "已具备导出条件",
    }.get(project.workflow_stage, "正在处理中")

    explicit_duration = infer_duration_from_context(project)
    duration_text = explicit_duration or (project.meta.duration if duration_has_source(project, project.meta.duration) else "待确认")
    version_target = (
        version_label(project.active_output.version)
        if project.active_output.version and project.workflow_stage in {"proposal", "full", "export"}
        else "待确定"
    )

    return InsightPanel(
        stage=project.workflow_stage,
        stage_label=stage_label,
        stage_summary=project.stage_summary,
        badge=stage_badge,
        project_summary=InsightProjectSummary(
            positioning=display_project_positioning(project),
            audience=detect_audience(project),
            style=project.meta.style or "待系统判断",
            duration=duration_text,
            version_target=version_target,
        ),
        assumptions=assumptions,
        asset_summary=asset_summary,
        current_output=project.active_output,
        shot_highlights=build_shot_highlights(project),
        tags=build_tags(project),
    )


def build_document_context(project: ProjectState, latest_input: str) -> str:
    meta = project.meta
    duration_text = infer_duration_from_context(project) or (meta.duration if duration_has_source(project, meta.duration, latest_input) else "未明确")
    return f"""项目基础信息：
- 项目名称：{meta.project_name}
- 客户类型：{meta.client_type}
- 影片类型：{meta.video_type}
- 时长：{duration_text}
- 画幅比例：{meta.aspect_ratio}
- 风格基调：{meta.style or "未明确"}
- 品牌资产：{meta.brand_assets or "未明确"}
- 参考风格：{meta.reference_samples or "未明确"}

内容单元：
{summarize_units(project)}

上传素材摘要：
{summarize_assets(project)}

执行假设：
{summarize_assumptions(project)}

最新修改意见：
{project.steps.get("revision").content if project.steps.get("revision") else "暂无"}

用户最新输入：
{latest_input}"""


def build_proposal_prompt(project: ProjectState, latest_input: str) -> str:
    return f"""你是资深宣传片策划和分镜导演。请输出“提案版”分镜文档，适合用于和客户、甲方、老板沟通方向。

请基于以下信息创作：
{build_document_context(project, latest_input)}

输出要求：
- 使用中文 Markdown。
- 不要解释生成过程，直接输出正文。
- 优先使用素材摘要和用户最新输入，不要反复追问缺项。
- 必须包含“执行假设”模块，并区分：来自素材、来自用户输入、系统合理补全。
- 如果信息不足，也要继续写，并在执行假设中说明默认采用什么方案。
- 必须包含：项目定位、执行假设、参考风格方向、内容逻辑、创意主轴、总旁白、分段文案、分镜脚本表、提案版总结。
- 分镜脚本表必须是 8 列：镜头编号、用途、时长、画面内容、景别/机位/运镜、场景/道具、字幕/旁白、转场。
- 总时长尽量贴近用户要求。
- 如果没有真实品牌资料或参考样片，不要编造真实链接或真实品牌规范，只写方向与替换位说明。
- 文风要专业、适合提案场景。"""


def build_full_prompt(project: ProjectState, latest_input: str) -> str:
    proposal_context = project.proposal_markdown or "暂无既有提案版，请直接基于现有资料完成完整版。"
    return f"""你是资深宣传片总导演和执行策划。请输出“完整版”分镜脚本文档，目标是进入制作执行。

请基于以下信息创作：
{build_document_context(project, latest_input)}

已有提案版参考：
{proposal_context}

输出要求：
- 使用中文 Markdown。
- 不要解释生成过程，直接输出正文。
- 优先使用素材摘要和用户最新输入，不要反复追问缺项。
- 必须包含“执行假设”模块，并区分：来自素材、来自用户输入、系统合理补全。
- 如果已有提案版，请尽量继承其创意主轴、旁白和镜头逻辑，在此基础上补齐执行层面的内容。
- 必须包含：项目信息、执行假设、参考样片方向分析、内容逻辑选择、创作主轴、总旁白、段落文案、分镜脚本表、拍摄方式建议、执行难点预警、交付分工建议、统一表达归纳、可拆条版本建议。
- 分镜脚本表必须是 8 列：镜头编号、用途、时长、画面内容、景别/机位/运镜、场景/道具、字幕/旁白、转场。
- 总时长尽量贴近用户要求。
- 如果信息不足，也要继续写，并在执行假设中说明默认采用什么方案。
- 如果没有真实品牌资料或参考样片，不要编造真实链接或真实品牌规范，只写方向与替换位说明。
- 输出要像真实制片、导演和客户都能直接使用的交付稿。"""


def stream_generation(project: ProjectState, latest_input: str, mode: str):
    prompt = build_proposal_prompt(project, latest_input) if mode == "proposal" else build_full_prompt(project, latest_input)
    client = llm_client()
    try:
        response = client.chat.completions.create(
            model=os.getenv("LLM_MODEL") or os.getenv("KIMI_MODEL", "glm-5.1"),
            messages=[
                {"role": "system", "content": "你是专业视频策划、宣传片导演和分镜脚本顾问。"},
                {"role": "user", "content": prompt},
            ],
            stream=True,
        )
    except APIError as exc:
        raise HTTPException(status_code=502, detail=f"LLM API 调用失败：{exc.message}") from exc
    return response


def chunk_text(text: str, size: int = 28) -> list[str]:
    if not text:
        return []
    return [text[index : index + size] for index in range(0, len(text), size)]


def project_event_payload(project: ProjectState, generation_mode: str) -> dict[str, Any]:
    return {
        "project": project.model_dump(),
        "workflow_stage": project.workflow_stage,
        "workflow_steps": [item.model_dump() for item in project.workflow_steps],
        "stage_summary": project.stage_summary,
        "missing_card": project.missing_card.model_dump() if project.missing_card else None,
        "insight_panel": project.insight_panel.model_dump(),
        "active_output": project.active_output.model_dump(),
        "asset_overview": project.asset_overview.model_dump(),
        "generation_mode": generation_mode,
    }


def sse_event(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def stream_chat(project: ProjectState, message: str) -> StreamingResponse:
    if not (message or "").strip():
        raise HTTPException(status_code=400, detail="Message is required.")

    project = hydrate_project(project)
    user_message = append_message(project, "user", message.strip(), "chat")
    refresh_project_context(project, "none")
    save_project(project)

    def event_stream():
        for asset in project.assets:
            yield sse_event({"type": "asset_status", "asset": asset.model_dump()})

        analysis = analyze_user_message(project, message)
        apply_project_updates(project, analysis, message)

        generation_mode = normalize_generation_mode(analysis.get("generation_mode"), project, message)
        missing_text, auto_filled, generation_mode = enforce_collection_gate(project, analysis, generation_mode)
        refresh_project_context(project, generation_mode, missing_text)

        if auto_filled and generation_mode == "none" and not analysis.get("reply"):
            analysis["reply"] = "你现在也可以直接让我生成提案版或完整版，我会基于当前资料继续往下完成。"

        reply_text = compose_reply(project, analysis, generation_mode, missing_text, message)

        notice_message: ChatMessage | None = None
        if generation_mode != "none" and reply_text:
            notice_message = append_message(project, "assistant", reply_text, "chat")

        save_project(project)
        yield sse_event(
            {
                "type": "project_update",
                "status_text": "正在思考…" if generation_mode == "none" else f"正在生成{version_label(generation_mode)}，请稍等",
                "notice_message": notice_message.model_dump() if notice_message else None,
                "user_message_id": user_message.id,
                **project_event_payload(project, generation_mode),
            }
        )

        if generation_mode == "none":
            final_reply = reply_text or "我已经整理好当前信息，可以继续补充资料，或直接让我生成提案版/完整版。"
            for chunk in chunk_text(final_reply):
                yield sse_event({"type": "delta", "content": chunk})
            append_message(project, "assistant", final_reply, "chat")
            refresh_project_context(project, "none", missing_text)
            save_project(project)
            yield sse_event({"type": "done", **project_event_payload(project, "none")})
            return

        collected: list[str] = []
        try:
            for chunk in stream_generation(project, message, generation_mode):
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    collected.append(delta)
                    yield sse_event({"type": "delta", "content": delta})
        except APIError as exc:
            yield sse_event({"type": "error", "message": f"LLM API 调用失败：{exc.message}"})
            return
        except Exception as exc:
            yield sse_event({"type": "error", "message": str(exc)})
            return

        markdown = "".join(collected).strip()
        if not markdown:
            yield sse_event({"type": "error", "message": "模型没有返回可用内容。"})
            return

        project.meta.version = version_label(generation_mode)
        project.active_version = generation_mode
        if generation_mode == "proposal":
            project.proposal_markdown = markdown
        else:
            project.full_markdown = markdown
            project.final_markdown = markdown

        assistant_message = append_message(project, "assistant", markdown, f"document_result:{generation_mode}")
        refresh_project_context(project, generation_mode, "")
        save_project(project)
        yield sse_event(
            {
                "type": "done",
                "assistant_message": assistant_message.model_dump(),
                **project_event_payload(project, generation_mode),
            }
        )

    return StreamingResponse(event_stream(), media_type="text/event-stream")
