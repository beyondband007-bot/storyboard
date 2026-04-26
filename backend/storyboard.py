from __future__ import annotations

import os
import json
import html
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from openai import APIError, OpenAI

from .models import ContentUnit, ProjectAsset, ProjectState, StepResult
from .storage import ROOT_DIR, ensure_project, load_project, project_dir, safe_filename, save_project


STEP_DEFINITIONS: list[tuple[str, str]] = [
    ("references", "参考样片方向分析"),
    ("logic", "内容逻辑选择"),
    ("axis", "创作前提 + 创意主轴"),
    ("narration", "总旁白 + 段落文案"),
    ("shots", "分镜脚本表"),
    ("production", "拍摄方式建议 + 交付分工 + 统一表达"),
    ("summary", "提案版摘要 + 拆条建议"),
]


def get_step_title(step_key: str) -> str:
    for key, title in STEP_DEFINITIONS:
        if key == step_key:
            return title
    raise HTTPException(status_code=400, detail=f"Unknown step: {step_key}")


def describe_units(units: list[ContentUnit]) -> str:
    if not units:
        return "用户尚未提供明确内容单元，请根据项目定位合理补齐。"
    lines = []
    for index, unit in enumerate(units, 1):
        lines.append(
            f"{index}. 名称：{unit.name or '未填写'}；核心特征/卖点：{unit.selling_points or '未填写'}；"
            f"命名口径：{unit.naming or '未填写'}"
        )
    return "\n".join(lines)


def confirmed_context(project: ProjectState) -> str:
    parts = []
    for key, title in STEP_DEFINITIONS:
        step = project.steps.get(key)
        if step and step.content:
            status = "已确认" if step.confirmed else "已生成未确认"
            parts.append(f"## {title}（{status}）\n{step.content}")
    return "\n\n".join(parts) or "暂无已生成内容。"


def revision_context(project: ProjectState) -> str:
    step = project.steps.get("revision")
    if not step or not step.content:
        return "暂无修改意见。"
    return step.content


def latest_project(project: ProjectState) -> ProjectState:
    if not project.id:
        return project
    try:
        saved = load_project(project.id)
    except Exception:
        return project
    if not project.assets and saved.assets:
        project.assets = saved.assets
    return project


def describe_assets(assets: list[ProjectAsset]) -> str:
    if not assets:
        return "未上传素材。"
    labels = {
        "company_intro": "公司介绍",
        "reference": "视频参考素材",
        "content_unit": "内容单元素材",
        "brand": "品牌资产",
        "other": "其他补充材料",
    }
    lines: list[str] = []
    for index, asset in enumerate(assets, 1):
        label = labels.get(asset.asset_type, "其他补充材料")
        if asset.status == "ready":
            body = asset.summary or "已解析，但暂无摘要。"
        elif asset.status == "failed":
            body = f"解析失败：{asset.error or asset.summary or '未知错误'}"
        else:
            body = "素材已上传，仍在解析中。"
        lines.append(
            f"{index}. 文件：{asset.original_filename}\n"
            f"   类型：{label}\n"
            f"   状态：{asset.status}\n"
            f"   摘要：{body}"
        )
    return "\n".join(lines)


def project_brief(project: ProjectState) -> str:
    project = latest_project(project)
    meta = project.meta
    return f"""项目名称：{meta.project_name}
客户类型：{meta.client_type}
影片类型：{meta.video_type}
成片时长：{meta.duration}
成片比例：{meta.aspect_ratio}
风格基调：{meta.style or "未填写"}
版本：{meta.version}
品牌资产：{meta.brand_assets or "未提供"}
参考样片：{meta.reference_samples or "未提供"}
上传素材：
{describe_assets(project.assets)}
内容单元：
{describe_units(project.content_units)}"""


def build_prompt(project: ProjectState, step_key: str) -> str:
    title = get_step_title(step_key)
    base = f"""你是资深宣传片分镜策划。请严格基于 storyboard skill 流程，为用户生成当前步骤内容。

项目资料：
{project_brief(project)}

前序内容：
{confirmed_context(project)}

当前步骤：{title}

通用要求：
- 使用中文。
- 输出 Markdown。
- 只输出当前步骤内容，不要重复完整方案。
- 语气专业、可交付，适合直接放入分镜脚本文档。
- 如用户上传了素材，请优先使用“上传素材”中的真实信息；如果素材与表单冲突，以表单和最新修改意见为准。
- 如信息缺失，请合理推断并明确写成“执行假设”，不要向用户反问。
"""

    instructions = {
        "references": """请生成“参考样片方向分析”。
若用户提供参考样片，请按链接/描述归纳风格、节奏、转场、语气。
若用户未提供参考样片，请推荐 3-5 个参考方向，不要编造具体不可验证链接；用“参考方向”描述即可。
必须包含表格列：参考方向、可借鉴点、本片转化方式。""",
        "logic": """请生成“内容逻辑选择”。
从空间递进、时间递进、功能递进、人群递进、情绪递进、规模递进、问题解决递进中推荐最适合的主逻辑和辅助逻辑。
必须说明推荐理由，并给出备选逻辑表。""",
        "axis": """请生成“创作前提 + 创意主轴”。
必须包含：项目定位、成片目标、目标受众、核心表达、创意主题、情绪结构、风格关键词、宣传口号建议。""",
        "narration": """请生成“总旁白 + 段落文案”。
必须包含一段完整总旁白，以及按时间段拆分的段落文案表。
旁白要符合项目风格，避免空泛大词。""",
        "shots": """请生成“分镜脚本表”。
必须使用 8 列 Markdown 表格：镜头编号、用途、时长、画面内容、景别/机位/运镜、场景/道具、字幕/旁白、转场。
总时长需贴近用户要求。镜头数量根据时长合理安排，3分钟建议 20-30 个镜头。""",
        "production": """请生成“拍摄方式建议 + 交付分工 + 统一表达”。
必须包含：实拍/动效/AIGC/混合制作分配原则，建议优先 AIGC 或动效的镜头，不建议 AIGC 主做的镜头，推荐制作比例，团队分工，镜头分组，统一表达归纳。""",
        "summary": """请生成“提案版摘要 + 可拆条版本建议”。
提案版摘要要精炼，突出亮点，避免“AI生成”等技术痕迹表达。
可拆条版本建议至少包含 15秒、30秒、60秒、完整版。""",
    }
    return f"{base}\n\n当前步骤细则：\n{instructions[step_key]}"


def call_kimi(prompt: str) -> str:
    api_key = os.getenv("LLM_API_KEY") or os.getenv("KIMI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="LLM_API_KEY is not configured on the server.")
    client = OpenAI(
        api_key=api_key,
        base_url=os.getenv("LLM_BASE_URL") or os.getenv("KIMI_BASE_URL", "https://open.bigmodel.cn/api/paas/v4/"),
    )
    try:
        response = client.chat.completions.create(
            model=os.getenv("LLM_MODEL") or os.getenv("KIMI_MODEL", "glm-5.1"),
            messages=[
                {"role": "system", "content": "你是专业视频策划、宣传片导演和分镜脚本顾问。"},
                {"role": "user", "content": prompt},
            ],
        )
    except APIError as exc:
        raise HTTPException(status_code=502, detail=f"Kimi API 调用失败：{exc.message}") from exc
    content = response.choices[0].message.content
    if not content:
        raise HTTPException(status_code=502, detail="Kimi returned an empty response.")
    return content.strip()


def generate_step(project: ProjectState, step_key: str) -> tuple[ProjectState, StepResult]:
    title = get_step_title(step_key)
    content = call_kimi(build_prompt(project, step_key))
    step = StepResult(
        key=step_key,
        title=title,
        content=content,
        confirmed=False,
        updated_at=datetime.now().isoformat(timespec="seconds"),
    )
    project.steps[step_key] = step
    save_project(project)
    return project, step


def assemble_markdown(project: ProjectState, override: str | None = None) -> str:
    if override:
        return override
    meta = project.meta
    lines = [
        f"# {meta.project_name}分镜脚本",
        "",
        f"版本：{meta.version}",
        f"生成日期：{datetime.now().date().isoformat()}",
        f"客户类型：{meta.client_type}",
        f"影片类型：{meta.video_type}",
        f"成片规格：{meta.duration}，{meta.aspect_ratio}",
        "",
        "## 1. 项目信息",
        "",
        "| 项目 | 内容 |",
        "|---|---|",
        f"| 项目名称 | {meta.project_name} |",
        f"| 风格基调 | {meta.style or '未填写'} |",
        f"| 品牌资产 | {meta.brand_assets or '未提供'} |",
        f"| 参考样片 | {meta.reference_samples or '未提供'} |",
        "",
        "## 2. 内容单元",
        "",
        "| 名称 | 核心特征/卖点 | 命名口径 |",
        "|---|---|---|",
    ]
    for unit in project.content_units or [ContentUnit(name="待补充", selling_points="待补充", naming="待补充")]:
        lines.append(f"| {unit.name or '待补充'} | {unit.selling_points or '待补充'} | {unit.naming or '待补充'} |")
    lines.append("")

    section_number = 3
    for key, title in STEP_DEFINITIONS:
        step = project.steps.get(key)
        if step and step.content:
            lines.extend([f"## {section_number}. {title}", "", step.content.strip(), ""])
            section_number += 1
    return "\n".join(lines).strip() + "\n"


def normalize_version(version: str | None) -> str:
    return "proposal" if version == "proposal" else "full"


def version_label(version: str | None) -> str:
    return "提案版" if normalize_version(version) == "proposal" else "完整版"


def export_key(version: str | None, kind: str) -> str:
    return f"{normalize_version(version)}_{kind}"


def write_markdown(project: ProjectState, markdown: str | None = None, version: str = "full") -> tuple[ProjectState, Path]:
    project = ensure_project(project)
    folder = project_dir(project.id)
    folder.mkdir(parents=True, exist_ok=True)
    version = normalize_version(version)
    content = markdown or (project.proposal_markdown if version == "proposal" else project.full_markdown or project.final_markdown)
    content = assemble_markdown(project, content or None)
    filename = f"{safe_filename(project.meta.project_name)}_{safe_filename(version_label(version))}.md"
    path = folder / filename
    path.write_text(content, encoding="utf-8")
    project.active_version = version
    if version == "proposal":
        project.proposal_markdown = content
    else:
        project.full_markdown = content
        project.final_markdown = content
        project.exports["markdown"] = str(path)
    project.exports[export_key(version, "markdown")] = str(path)
    save_project(project)
    return project, path


def inline_markdown(text: str) -> str:
    escaped = html.escape(text.strip())
    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"`(.+?)`", r"<code>\1</code>", escaped)
    return escaped


def markdown_table_to_html(rows: list[str]) -> str:
    parsed_rows = [[inline_markdown(cell) for cell in row.strip().strip("|").split("|")] for row in rows]
    parsed_rows = [row for row in parsed_rows if row and not all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in row)]
    if not parsed_rows:
        return ""
    header = parsed_rows[0]
    body = parsed_rows[1:]
    head_html = "".join(f"<th>{cell}</th>" for cell in header)
    body_html = "".join("<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>" for row in body)
    return f'<div class="table-card"><div class="table-scroll"><table><thead><tr>{head_html}</tr></thead><tbody>{body_html}</tbody></table></div></div>'


def markdown_to_reading_html(markdown: str) -> str:
    lines = markdown.splitlines()
    blocks: list[str] = []
    paragraph: list[str] = []
    table_rows: list[str] = []
    list_items: list[str] = []

    def flush_paragraph() -> None:
        nonlocal paragraph
        if paragraph:
            blocks.append(f"<p>{inline_markdown(' '.join(paragraph))}</p>")
            paragraph = []

    def flush_table() -> None:
        nonlocal table_rows
        if table_rows:
            blocks.append(markdown_table_to_html(table_rows))
            table_rows = []

    def flush_list() -> None:
        nonlocal list_items
        if list_items:
            items = "".join(f"<li>{inline_markdown(item)}</li>" for item in list_items)
            blocks.append(f'<ul class="bullet-list">{items}</ul>')
            list_items = []

    for raw_line in lines:
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped:
            flush_paragraph()
            flush_table()
            flush_list()
            continue
        if stripped.startswith("|") and stripped.endswith("|"):
            flush_paragraph()
            flush_list()
            table_rows.append(stripped)
            continue
        flush_table()
        heading = re.match(r"^(#{1,4})\s+(.+)$", stripped)
        if heading:
            flush_paragraph()
            flush_list()
            level = min(len(heading.group(1)) + 1, 4)
            blocks.append(f"<h{level}>{inline_markdown(heading.group(2))}</h{level}>")
            continue
        bullet = re.match(r"^[-*]\s+(.+)$", stripped)
        if bullet:
            flush_paragraph()
            list_items.append(bullet.group(1))
            continue
        numbered = re.match(r"^\d+[.、]\s+(.+)$", stripped)
        if numbered:
            flush_paragraph()
            list_items.append(numbered.group(1))
            continue
        paragraph.append(stripped)

    flush_paragraph()
    flush_table()
    flush_list()
    return "\n".join(block for block in blocks if block)


def build_reading_html(project: ProjectState, markdown: str, version: str) -> str:
    meta = project.meta
    title = f"{meta.project_name or '未命名项目'}分镜脚本"
    body = markdown_to_reading_html(markdown)
    generated_at = datetime.now().strftime("%Y-%m-%d")
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)} · {html.escape(version_label(version))}</title>
  <style>
    :root {{
      --bg: #eef3f7;
      --paper: rgba(255,255,255,.84);
      --paper-strong: #ffffff;
      --ink: #102330;
      --muted: #586c79;
      --line: rgba(16,35,48,.12);
      --brand: #0f5d79;
      --brand-soft: #dcebf1;
      --accent: #b88a53;
      --shadow: 0 24px 60px rgba(20,49,66,.12);
      --radius-xl: 28px;
      --radius-lg: 22px;
    }}
    * {{ box-sizing: border-box; }}
    html {{ scroll-behavior: smooth; }}
    body {{
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(184,138,83,.12), transparent 28%),
        radial-gradient(circle at right 10% top 15%, rgba(15,93,121,.12), transparent 24%),
        linear-gradient(180deg, #f4f7fa 0%, #eef3f7 48%, #e9eef3 100%);
      font: 16px/1.85 "Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei UI", sans-serif;
    }}
    .page {{
      width: min(1180px, calc(100vw - 40px));
      margin: 28px auto 56px;
    }}
    .hero {{
      padding: 30px 34px;
      border-radius: var(--radius-xl);
      color: #eff7fa;
      background:
        linear-gradient(135deg, rgba(10,27,41,.96), rgba(16,63,84,.92)),
        linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,0));
      box-shadow: var(--shadow);
      position: relative;
      overflow: hidden;
      isolation: isolate;
    }}
    .hero::after {{
      content: "";
      position: absolute;
      inset: auto -10% -28% auto;
      width: 380px;
      height: 380px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,255,255,.16), transparent 62%);
      z-index: -1;
    }}
    .eyebrow {{
      margin: 0 0 10px;
      letter-spacing: .18em;
      text-transform: uppercase;
      font-size: 12px;
      color: rgba(239,247,250,.68);
    }}
    h1, h2, h3, h4 {{
      margin: 0;
      font-family: "Source Han Serif SC", "Noto Serif CJK SC", "STSong", serif;
      line-height: 1.3;
    }}
    h1 {{
      font-size: clamp(28px, 3vw, 42px);
      line-height: 1.22;
    }}
    .hero-meta {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 18px;
    }}
    .hero-meta span {{
      padding: 6px 12px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 999px;
      background: rgba(255,255,255,.06);
      font-size: 12px;
    }}
    .content-section {{
      margin-top: 24px;
      padding: 32px;
      border-radius: var(--radius-lg);
      background: var(--paper);
      border: 1px solid rgba(255,255,255,.65);
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
    }}
    h2 {{
      margin-top: 34px;
      margin-bottom: 16px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--line);
      font-size: clamp(26px, 2.4vw, 34px);
      color: #102330;
    }}
    h2:first-child {{ margin-top: 0; }}
    h3 {{
      margin-top: 28px;
      margin-bottom: 12px;
      font-size: 23px;
      color: #17384c;
    }}
    h4 {{
      margin-top: 20px;
      margin-bottom: 8px;
      font-size: 18px;
      color: #20495f;
    }}
    p {{
      margin: 0 0 14px;
      color: #203643;
    }}
    .bullet-list {{
      margin: 10px 0 18px;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 10px;
    }}
    .bullet-list li {{
      position: relative;
      padding: 14px 16px 14px 42px;
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(15,93,121,.05), rgba(255,255,255,.68));
      border: 1px solid rgba(15,93,121,.09);
    }}
    .bullet-list li::before {{
      content: "";
      position: absolute;
      left: 16px;
      top: 21px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--brand);
      box-shadow: 0 0 0 5px rgba(15,93,121,.12);
    }}
    .table-card {{
      margin: 16px 0 22px;
      padding: 10px;
      border-radius: 20px;
      background: linear-gradient(180deg, rgba(255,255,255,.82), rgba(235,241,246,.86));
      border: 1px solid rgba(16,35,48,.08);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.8);
    }}
    .table-scroll {{
      overflow: auto;
      border-radius: 14px;
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      min-width: 720px;
      background: rgba(255,255,255,.88);
    }}
    th, td {{
      padding: 12px 14px;
      border-bottom: 1px solid rgba(16,35,48,.09);
      text-align: left;
      vertical-align: top;
    }}
    th {{
      color: #17384c;
      background: var(--brand-soft);
      white-space: nowrap;
    }}
    td {{ color: #2b414f; }}
    code {{
      padding: 2px 6px;
      border-radius: 8px;
      background: rgba(15,93,121,.08);
      color: #0f5d79;
    }}
    .footer {{
      margin-top: 22px;
      color: var(--muted);
      text-align: center;
      font-size: 13px;
    }}
    @media (max-width: 760px) {{
      .page {{ width: min(100vw - 24px, 1180px); margin-top: 12px; }}
      .hero, .content-section {{ padding: 22px; border-radius: 18px; }}
      table {{ min-width: 640px; }}
    }}
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <p class="eyebrow">STORYBOARD READING EDITION</p>
      <h1>{html.escape(title)}</h1>
      <div class="hero-meta">
        <span>{html.escape(version_label(version))}</span>
        <span>{html.escape(meta.video_type or "宣传片")}</span>
        <span>{html.escape(meta.duration or "时长待定")}</span>
        <span>{html.escape(meta.aspect_ratio or "比例待定")}</span>
        <span>{html.escape(generated_at)}</span>
      </div>
    </section>
    <section class="content-section">
      {body}
    </section>
    <p class="footer">Generated by AI Director Workbench</p>
  </main>
</body>
</html>
"""


def write_html(project: ProjectState, markdown: str | None = None, version: str = "full") -> tuple[ProjectState, Path]:
    project = ensure_project(project)
    folder = project_dir(project.id)
    folder.mkdir(parents=True, exist_ok=True)
    version = normalize_version(version)
    content = markdown or (project.proposal_markdown if version == "proposal" else project.full_markdown or project.final_markdown)
    content = assemble_markdown(project, content or None)
    filename = f"{safe_filename(project.meta.project_name)}_{safe_filename(version_label(version))}_阅读版.html"
    path = folder / filename
    path.write_text(build_reading_html(project, content, version), encoding="utf-8")
    project.active_version = version
    if version == "proposal":
        project.proposal_markdown = content
    else:
        project.full_markdown = content
        project.final_markdown = content
        project.exports["html"] = str(path)
    project.exports[export_key(version, "html")] = str(path)
    save_project(project)
    return project, path


def build_creative_preview_prompt(project: ProjectState) -> str:
    return f"""你是资深宣传片策划。请像 Codex 交互式确认一样，在正式生成完整分镜脚本之前，先给用户一份“创作预览与确认项”。

项目资料：
{project_brief(project)}

请输出 Markdown，必须包含：
1. 当前信息归纳
2. 推荐内容逻辑，说明为什么
3. 暂定创意主题，给 1 个主推
4. 暂定宣传口号，给 1 个主推
5. 备选口号表，给 4 个选项，表格列为：编号、口号、气质
6. 请用户确认这一步，明确告诉用户可以选择口号 1/2/3/4 或使用主推口号

如用户上传了素材，请优先使用“上传素材”中的真实信息；如果素材与表单冲突，以用户表单为准。

语气要像正在和用户协作，不要直接生成最终完整文档。"""


def generate_creative_preview(project: ProjectState) -> tuple[ProjectState, str]:
    content = call_kimi(build_creative_preview_prompt(project))
    project = ensure_project(project)
    project.steps["preview"] = StepResult(
        key="preview",
        title="创作预览与确认项",
        content=content,
        confirmed=False,
        updated_at=datetime.now().isoformat(timespec="seconds"),
    )
    save_project(project)
    return project, content


def intake_context(project: ProjectState) -> str:
    intake = project.selection_state.get("intakeSummary") or "暂无资料整理结果。"
    logic = project.selection_state.get("logicRecommendations") or "暂无内容逻辑推荐。"
    selected = project.selection_state.get("selectedLogic") or "用户尚未确认内容逻辑。"
    return f"""资料整理结果：
{intake}

内容逻辑推荐：
{logic}

用户已确认的内容逻辑：
{selected}"""


def build_intake_summary_prompt(project: ProjectState) -> str:
    return f"""你是资深宣传片策划和分镜导演。请基于用户一次性填写的信息、内容单元和上传素材摘要，先为用户做“资料整理与内容逻辑推荐”，不要生成提案版或完整版。

项目资料：
{project_brief(project)}

输出要求：
- 使用中文 Markdown。
- 直接输出给用户看的整理结果，不要解释生成过程。
- 必须先输出“项目信息汇总表”，用表格整理项目名称、客户类型、影片类型、时长、风格基调、成片比例、素材吸收情况等核心信息。
- 必须输出“内容单元概览表”，用表格整理本片要拍什么、讲什么、可用素材、表达重点、备注。
- 必须输出“Phase 2：内容逻辑推荐”，格式固定如下：
  1. 先写一句“基于项目特性（...），推荐以下内容逻辑：”
  2. 单独一行写“推荐逻辑：某某递进”
  3. 单独一行写该逻辑的主线，例如“痛点引入 → 核心能力 → 场景验证 → 成片交付 → 价值升华”
  4. 必须输出 Markdown 表格，表头固定为“逻辑类型｜适用性｜说明”；根据项目实际给 2-5 个候选逻辑，推荐项适用性写“最佳匹配”，其他写“备选”或“不适用”。
  5. 必须输出“建议叙事结构”，用开场/第一篇章/第二篇章/第三篇章/结尾列出时间和内容。
- 必须在最后输出“请确认：内容逻辑是否满意？如需调整，请直接输入修改意见。”
- 如果信息不足，可以写成“待补充”或“执行假设”，不要向用户追问。
"""


def build_logic_recommendation_prompt(project: ProjectState) -> str:
    revision_note = project.selection_state.get("logicRevisionNote") or "用户未提供额外修改意见。"
    current = project.selection_state.get("logicRecommendations") or "暂无既有推荐。"
    return f"""你是资深宣传片策划。请根据当前项目资料和用户修改意见，重新生成“内容逻辑推荐”。

项目资料：
{project_brief(project)}

资料整理结果：
{project.selection_state.get("intakeSummary") or "暂无资料整理结果。"}

当前推荐：
{current}

用户修改意见：
{revision_note}

输出要求：
- 使用中文 Markdown。
- 只输出新的内容逻辑推荐，不要生成提案版或完整版。
- 输出格式必须固定为：
  1. “Phase 2：内容逻辑推荐”
  2. “推荐逻辑：某某递进”
  3. 一条主线箭头链路，例如“痛点引入 → 核心能力 → 场景验证 → 成片交付 → 价值升华”
  4. Markdown 表格，表头固定为“逻辑类型｜适用性｜说明”；根据项目实际给 2-5 个候选逻辑，推荐项适用性写“最佳匹配”，其他写“备选”或“不适用”。
  5. “建议叙事结构”：用开场/第一篇章/第二篇章/第三篇章/结尾列出时间和内容。
  6. “请确认：内容逻辑是否满意？如需调整，请直接输入修改意见。”
- 修改意见优先，但如果修改意见会削弱成片效果，请用温和方式给出更合适的推荐。
"""


def stream_selection_document(project: ProjectState, prompt: str, selection_key: str, step_key: str, step_title: str) -> StreamingResponse:
    api_key = os.getenv("LLM_API_KEY") or os.getenv("KIMI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="LLM_API_KEY is not configured on the server.")

    project = ensure_project(project)

    def event_stream():
        client = OpenAI(
            api_key=api_key,
            base_url=os.getenv("LLM_BASE_URL") or os.getenv("KIMI_BASE_URL", "https://open.bigmodel.cn/api/paas/v4/"),
        )
        collected: list[str] = []
        try:
            response = client.chat.completions.create(
                model=os.getenv("LLM_MODEL") or os.getenv("KIMI_MODEL", "glm-5.1"),
                messages=[
                    {"role": "system", "content": "你是专业视频策划、宣传片导演和分镜脚本顾问。"},
                    {"role": "user", "content": prompt},
                ],
                stream=True,
            )
            for chunk in response:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    collected.append(delta)
                    yield f"data: {json.dumps({'type': 'delta', 'content': delta}, ensure_ascii=False)}\n\n"

            content = "".join(collected)
            project.selection_state[selection_key] = content
            if selection_key == "intakeSummary":
                project.selection_state["logicRecommendations"] = content
            project.steps[step_key] = StepResult(
                key=step_key,
                title=step_title,
                content=content,
                confirmed=False,
                updated_at=datetime.now().isoformat(timespec="seconds"),
            )
            save_project(project)
            yield f"data: {json.dumps({'type': 'done', 'project': project.model_dump()}, ensure_ascii=False)}\n\n"
        except APIError as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'LLM API 调用失败：{exc.message}'}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def stream_intake_summary(project: ProjectState) -> StreamingResponse:
    return stream_selection_document(
        project,
        build_intake_summary_prompt(project),
        "intakeSummary",
        "intake_summary",
        "资料整理与内容逻辑推荐",
    )


def stream_logic_recommendation(project: ProjectState) -> StreamingResponse:
    return stream_selection_document(
        project,
        build_logic_recommendation_prompt(project),
        "logicRecommendations",
        "logic_recommendation",
        "内容逻辑重新推荐",
    )


def stream_creative_preview(project: ProjectState) -> StreamingResponse:
    api_key = os.getenv("LLM_API_KEY") or os.getenv("KIMI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="LLM_API_KEY is not configured on the server.")

    project = ensure_project(project)

    def event_stream():
        client = OpenAI(
            api_key=api_key,
            base_url=os.getenv("LLM_BASE_URL") or os.getenv("KIMI_BASE_URL", "https://open.bigmodel.cn/api/paas/v4/"),
        )
        collected: list[str] = []
        try:
            response = client.chat.completions.create(
                model=os.getenv("LLM_MODEL") or os.getenv("KIMI_MODEL", "glm-5.1"),
                messages=[
                    {"role": "system", "content": "你是专业视频策划、宣传片导演和分镜脚本顾问。"},
                    {"role": "user", "content": build_creative_preview_prompt(project)},
                ],
                stream=True,
            )
            for chunk in response:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    collected.append(delta)
                    yield f"data: {json.dumps({'type': 'delta', 'content': delta}, ensure_ascii=False)}\n\n"

            content = "".join(collected)
            project.steps["preview"] = StepResult(
                key="preview",
                title="创作预览与确认项",
                content=content,
                confirmed=False,
                updated_at=datetime.now().isoformat(timespec="seconds"),
            )
            save_project(project)
            yield f"data: {json.dumps({'type': 'done', 'project': project.model_dump()}, ensure_ascii=False)}\n\n"
        except APIError as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'Kimi API 调用失败：{exc.message}'}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def write_docx(project: ProjectState, markdown: str | None = None, version: str = "full") -> tuple[ProjectState, Path]:
    version = normalize_version(version)
    project, md_path = write_markdown(project, markdown, version)
    docx_name = f"{safe_filename(project.meta.project_name)}_{safe_filename(version_label(version))}.docx"
    docx_path = md_path.with_name(docx_name)
    script_path = ROOT_DIR / "scripts" / "generate_docx.py"
    result = subprocess.run(
        [
            sys.executable,
            str(script_path),
            str(md_path),
            str(docx_path),
            "--title",
            f"{project.meta.project_name}分镜脚本",
            "--version",
            version_label(version),
        ],
        cwd=str(ROOT_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"docx export failed: {result.stderr or result.stdout}")
    if version == "full":
        project.exports["docx"] = str(docx_path)
    project.exports[export_key(version, "docx")] = str(docx_path)
    save_project(project)
    return project, docx_path


def build_proposal_document_prompt(project: ProjectState) -> str:
    return f"""你是资深宣传片提案策划和分镜导演。请基于 storyboard skill 的“提案版”规则，生成一份可以拿给客户/老板/甲方沟通的正式提案版分镜文档。

项目资料：
{project_brief(project)}

资料整理与内容逻辑确认：
{intake_context(project)}

创作预览与用户确认：
{project.steps.get("preview").content if project.steps.get("preview") else "暂无"}

用户最终选择/补充：
{project.steps.get("selection").content if project.steps.get("selection") else "用户未额外补充，请沿用创作预览中的主推方案。"}

最新修改意见：
{revision_context(project)}

输出要求：
- 使用中文 Markdown。
- 不要解释生成过程，直接输出提案正文。
- 这不是摘要，也不是短版，而是用于说服决策者的正式“提案版”。
- 必须保留完整旁白、分段文案和分镜脚本表。
- 必须增强说服模块：创意策略、核心表达、成片价值、视觉风格设定、音乐音效设计。
- 不要输出拍摄方式建议、执行难点预警、交付分工建议等执行细节。
- 文档必须完整包含以下板块：
  1. 项目信息与提案目标
  2. 创意策略
  3. 核心表达
  4. 暂定宣传口号与备选口号
  5. 成片价值
  6. 视觉风格设定
  7. 音乐音效设计
  8. 总旁白
  9. 分段文案
  10. 分镜脚本表
  11. 提案版总结
- 分镜脚本表必须使用 8 列：镜头编号、用途、时长、画面内容、景别/机位/运镜、场景/道具、字幕/旁白、转场。
- 总时长要贴近用户填写的成片时长。
- 如果参考样片为空，不要编造真实链接，只给参考方向。
- 如果品牌资产为空，写明“本轮未提供，预留 Logo/VI/素材替换位置”。
- 语言要有提案感：清晰、专业、能让客户理解为什么这样拍。
- 如果存在最新修改意见，请优先执行修改意见，并在整体文档中自然融合，不要单独解释“我已修改”。
- 如用户上传了素材，请优先使用“上传素材”中的真实信息；如果素材与表单或最新修改意见冲突，以用户表单和最新修改意见为准。
"""


def build_full_document_prompt(project: ProjectState) -> str:
    proposal_context = project.proposal_markdown or "暂无提案版。若缺少提案版，请基于创作预览和用户确认直接生成完整版。"
    return f"""你是资深宣传片分镜策划。请基于 storyboard skill 的完整流程，生成一份可进入制作执行的完整版分镜脚本文档。

项目资料：
{project_brief(project)}

资料整理与内容逻辑确认：
{intake_context(project)}

提案版内容：
{proposal_context}

创作预览与用户确认：
{project.steps.get("preview").content if project.steps.get("preview") else "暂无"}

用户最终选择/补充：
{project.steps.get("selection").content if project.steps.get("selection") else "用户未额外补充，请沿用创作预览中的主推方案。"}

最新修改意见：
{revision_context(project)}

输出要求：
- 使用中文 Markdown。
- 不要解释你如何生成，直接输出文档正文。
- 如果已有提案版，请沿用提案版的创意策略、核心表达、旁白、分段和分镜，不要大幅改写；重点补充执行层面的内容。
- 如果存在最新修改意见，请优先执行修改意见，并在整体文档中自然融合，不要单独解释“我已修改”。
- 文档必须完整包含以下板块：
  1. 项目理解
  2. 已吸收材料（上传的附件解析）
  3. 成片目标，包含时长，成片比例，风格基调，文案气质
  4. 创作前提
  5. 创意主轴，包含核心表达、内容逻辑选择、氛围关键词
  6. 总旁白
  7. 段落文案
  8. 分镜脚本表：1.分镜需要根据段落分成序列 2.对当前序列的成片效果做备注
  9. 拍摄方式建议：1.按照镜头类型分类描述拍摄方式的选择，并逐个给出选择标准。2.要有符合创意主轴的拍摄注意事项 3.要有镜头执行总表 4.交付分工建议
  

- 分镜脚本表必须使用 8 列：镜头编号、用途、时长、画面内容、景别/机位/运镜、场景/道具、字幕/旁白、转场。
- 总时长要贴近用户填写的成片时长。
- 如果参考样片为空，不要编造真实链接，只给参考方向。
- 输出要按照真实制片/导演/客户都能直接看的交付文档。
- 如用户上传了素材，请优先使用“上传素材”中的真实信息；如果素材与表单或最新修改意见冲突，以用户表单和最新修改意见为准。
"""


def stream_proposal_document(project: ProjectState) -> StreamingResponse:
    api_key = os.getenv("LLM_API_KEY") or os.getenv("KIMI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="LLM_API_KEY is not configured on the server.")

    project = ensure_project(project)

    def event_stream():
        client = OpenAI(
            api_key=api_key,
            base_url=os.getenv("LLM_BASE_URL") or os.getenv("KIMI_BASE_URL", "https://open.bigmodel.cn/api/paas/v4/"),
        )
        collected: list[str] = []
        try:
            response = client.chat.completions.create(
                model=os.getenv("LLM_MODEL") or os.getenv("KIMI_MODEL", "glm-5.1"),
                messages=[
                    {"role": "system", "content": "你是专业视频策划、宣传片导演和分镜提案顾问。"},
                    {"role": "user", "content": build_proposal_document_prompt(project)},
                ],
                stream=True,
            )
            for chunk in response:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    collected.append(delta)
                    yield f"data: {json.dumps({'type': 'delta', 'content': delta}, ensure_ascii=False)}\n\n"

            project.proposal_markdown = "".join(collected)
            project.active_version = "proposal"
            save_project(project)
            yield f"data: {json.dumps({'type': 'done', 'project': project.model_dump()}, ensure_ascii=False)}\n\n"
        except APIError as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'LLM API 调用失败：{exc.message}'}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def stream_full_document(project: ProjectState) -> StreamingResponse:
    api_key = os.getenv("LLM_API_KEY") or os.getenv("KIMI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="LLM_API_KEY is not configured on the server.")

    project = ensure_project(project)

    def event_stream():
        client = OpenAI(
            api_key=api_key,
            base_url=os.getenv("LLM_BASE_URL") or os.getenv("KIMI_BASE_URL", "https://open.bigmodel.cn/api/paas/v4/"),
        )
        collected: list[str] = []
        try:
            response = client.chat.completions.create(
                model=os.getenv("LLM_MODEL") or os.getenv("KIMI_MODEL", "glm-5.1"),
                messages=[
                    {"role": "system", "content": "你是专业视频策划、宣传片导演和分镜脚本顾问。"},
                    {"role": "user", "content": build_full_document_prompt(project)},
                ],
                stream=True,
            )
            for chunk in response:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    collected.append(delta)
                    yield f"data: {json.dumps({'type': 'delta', 'content': delta}, ensure_ascii=False)}\n\n"

            project.full_markdown = "".join(collected)
            project.final_markdown = project.full_markdown
            project.active_version = "full"
            save_project(project)
            yield f"data: {json.dumps({'type': 'done', 'project': project.model_dump()}, ensure_ascii=False)}\n\n"
        except APIError as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'Kimi API 调用失败：{exc.message}'}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
