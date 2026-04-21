---
name: storyboard
description: Generates professional video storyboard scripts for promotional films, product videos, case studies, and tourism videos. Use when user asks for "分镜", "分镜脚本", "storyboard", "拍摄计划", or needs to plan video production.
---

# 分镜脚本生成器

Generate professional video storyboard scripts with complete production planning.

## Overview

This skill helps create comprehensive storyboard scripts for various video types:
- Promotional films (宣传片)
- Product videos (产品片)
- Case studies (案例片)
- Tourism videos (旅游片)

## Workflow

### Phase 1: Collect Inputs

**1.1 Content Units**

Prompt user for content units information:
```
请提供内容单元信息（产品/景点/服务等），包括：
- 名称
- 核心特征/卖点
- 命名口径（如有品牌规范）
```

**1.2 Project Positioning**

Prompt user for project positioning:
```
请提供项目定位：
- 客户类型：政府/企业/消费者
- 影片类型：宣传片/产品片/案例片/其他
```

**1.3 Video Requirements**

Prompt user for video requirements:
```
请提供成片要求：
- 时长：如 3分钟、5分钟
- 风格基调：如 科技感、政务感、真实感
- 成片比例：如 16:9横版、9:16竖版
```

**1.4 Reference Samples**

Ask user about reference samples:
```
是否有参考样片？（提供链接或文件）
如无，将根据项目定位在线搜索推荐
```

**1.5 Brand Assets (Optional)**

Ask user about brand assets:
```
是否有品牌资产需要提供？（可跳过）
- Logo
- VI规范
- 已有视觉素材
```

### Phase 2: Collaborative Confirmation

**2.1 Sample Analysis**

If user provided samples:
1. Analyze sample video
2. Extract reference points (style, transition, pacing, tone)
3. Output analysis report
4. User confirms or adjusts

If user has no samples:
1. Search online for relevant samples based on project positioning
2. Present 3-5 options for user selection
3. Analyze selected sample
4. Output analysis report
5. User confirms or adjusts

**2.2 Content Logic Selection**

Based on content units and project positioning, recommend connection logic types:

| Logic Type | Description | Example |
|---|---|---|
| 空间递进 | Multi-location | Ground → Water → Air → Underground |
| 时间递进 | Time progression | Morning → Noon → Evening → Night |
| 功能递进 | Function chain | Sense → Decide → Execute → Feedback |
| 人群递进 | Audience segments | Children → Youth → Elderly → Family |
| 情绪递进 | Emotional arc | Awakening → Vitality → Reflection → Outlook |
| 规模递进 | Scale shift | City → Community → Family → Individual |
| 问题解决递进 | Problem-solving | Problem → Analysis → Solution → Result |

Auto-recommend best fit + present other options for user selection/adjustment.

### Phase 3: Generate Output

**3.1 Output Mode Selection**

Ask user:
```
输出方式：
A. 一次性输出完整内容
B. 分步确认（每步可调整后继续）
```

**3.2 Generate Complete Version**

If user selects "A", output all sections at once.

If user selects "B", follow step-by-step confirmation:

| Step | Output Content |
|---|---|
| 1 | 创作前提 + 创意主轴 |
| 2 | 总旁白 + 段落文案 |
| 3 | 分镜脚本表 |
| 4 | 拍摄方式建议 + 交付分工建议 + 统一表达归纳 |

Each step: Generate → User confirms/adjusts → Continue

**3.3 Version Selection**

After complete version is generated:
```
是否需要生成其他版本？
- 提案版：精简版，突出亮点，省略技术细节，规避"AI生成"表述
- 其他版本：请说明需求
```

**3.4 Generate Document Files**

After all content is finalized, generate output files:

1. First, write Markdown file to `{output_path}/{项目名称}_{版本}.md`
2. Then, generate Word document using Python script:

```bash
python "${SKILL_DIR}/scripts/generate_docx.py" "{input_md}" "{output_docx}" --title "{项目名称}" --version "{版本}"
```

Output files:
- `{项目名称}_{版本}.md` - Markdown source
- `{项目名称}_{版本}.docx` - Formatted Word document

**Default Path**: `Documents\claude\分镜脚本\`
**User-specified**: Follow user's path

## Script Directory

**Important**: All scripts are located in the `scripts/` subdirectory of this skill.

**Agent Execution Instructions**:
1. Determine this SKILL.md file's directory path as `SKILL_DIR`
2. Script path = `${SKILL_DIR}/scripts/<script-name>.py`
3. Replace all `${SKILL_DIR}` in this document with the actual path

**Script Reference**:
| Script | Purpose |
|--------|---------|
| `scripts/generate_docx.py` | Convert Markdown to formatted Word document |

**Dependencies**:
- Python 3.x
- python-docx library

To install dependencies:
```bash
pip install python-docx
```

## Output Structure

### 1. 创作前提 (Creative Premise)

- 项目定位
- 成片目标

### 2. 创意主轴 (Creative Axis)

- 核心表达：自动提炼
- 情绪结构：根据内容推导
- 氛围关键词：用户可提供，无则推荐
- 风格基调：独立输出项

### 3. 总旁白 (Main Narration)

整体文案，风格根据以下推导：
- 项目定位
- 参考样片风格
- 用户指定偏好

### 4. 段落文案 (Segment Narration)

各内容单元的分文案，适配内容类型（产品/景点/服务等）。

### 5. 分镜脚本表 (Storyboard Table)

Fixed 8 columns:

| 镜头编号 | 用途 | 时长 | 画面内容 | 景别/机位/运镜 | 场景/道具 | 字幕/旁白 | 转场 |
|---|---|---|---|---|---|---|---|

### 6. 拍摄方式建议 (Production Method Recommendations)

- Live Action / AI Generated / Hybrid 分配原则
- 建议优先 AIGC 的镜头清单（编号 + 原因 + 执行建议）
- 不建议 AIGC 主做的镜头清单
- 逐镜头执行方式总表
- 推荐执行比例
- 节奏提醒

Rules adjusted by project type:
- Government: Emphasize authenticity, minimize obvious AI
- Enterprise: Balance professionalism with visual appeal
- Consumer: More creative freedom with AI/hybrid

### 7. 交付分工建议 (Delivery Assignment)

- 团队配置：根据项目调整（如导演组/摄影组/后期组/AIGC组/航拍组等）
- 镜头分组分工：LLM 根据镜头特点分配
- 分工好处说明

### 8. 统一表达归纳 (Unified Expression)

对段落内容的情绪渲染/思想表达层面的统一归纳。

## Version Differences

| Version | Characteristics |
|---|---|
| **完整版（默认）** | Detailed, all sections included, full technical implementation |
| **提案版** | Concise, highlights focused, no technical details, avoid "AI生成" terminology |
| **其他版本** | Customized based on requirements |

## Output Format

- Display in conversation
- Generate Markdown file (`.md`)
- Generate Word document (`.docx`) with formatted styling

## Exception Handling

Skill handles exceptions autonomously:

| Situation | Handling |
|---|---|
| Incomplete content units | Ask for clarification or infer from context |
| Ambiguous positioning | Clarify with user or infer from context |
| No sample search results | Skip sample phase, proceed with workflow |
| User cancellation | Offer to save progress or restart |

## Usage

```
/分镜
/storyboard
```

Or describe your needs:
```
帮我做一个宣传片的分镜脚本
我有一个产品片需要规划拍摄
```
