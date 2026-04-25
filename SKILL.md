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

### Phase 3: Generate Proposal Version

**3.1 Output Mode Selection**

Ask user:
```
输出方式：
A. 先出提案版 → 确认后出完整版（推荐）
B. 直接出完整版
```

**3.2 Generate Proposal Version (If user selects "A")**

Proposal version is designed to **persuade stakeholders**, not just simplify content.

**Key principles:**
- **不缩减核心内容**：完整保留总旁白、段落文案、分镜脚本表
- **新增说服力内容**：创意策略、核心表达、成片价值、视觉风格设定、音乐音效设计
- **省略执行细节**：拍摄方式建议、交付分工建议

**Proposal structure:**

| 模块 | 说明 |
|---|---|
| 封面信息 | 项目名称、提报单位、日期 |
| 目录 | 章节导航 |
| 创作前提 | 项目定位 + 成片目标 + 成片价值 |
| **创意策略** | 创意理念 + 策略依据 + 差异化亮点 + 创意洞察 + 传播策略 |
| 创意主轴 | 核心表达 + 情绪曲线 + 观众感受预期 |
| **视觉风格设定**（新增） | 画面风格 + 色彩体系 + 镜头语言 + 视觉符号 + 参考对标 |
| 总旁白 | 完整不缩减 |
| 段落文案 | 完整不缩减 |
| 分镜脚本表 | 完整不缩减 |
| **音乐音效设计**（新增） | 音乐风格规划 + 关键音效 + 情绪节奏曲线 |
| 统一表达归纳 | 强化呈现 |
| **省略** | 拍摄方式建议、交付分工建议 |

**3.3 Generate Complete Version (If user selects "B")**

Output all sections including execution details:

| Step | Output Content |
|---|---|
| 1 | 创作前提 + 创意主轴 |
| 2 | 总旁白 + 段落文案 |
| 3 | 分镜脚本表 |
| 4 | 拍摄方式建议 + 交付分工建议 + 统一表达归纳 |

### Phase 4: Confirm and Generate Full Version

**4.1 Proposal Confirmation**

After proposal version is generated:
```
提案版已输出，请确认创意方向是否满意：
- 满意 → 自动生成完整版（补充执行细节）
- 需调整 → 请说明需要调整的内容
```

**4.2 Auto-generate Complete Version**

When proposal is confirmed, automatically generate complete version by adding:
- 拍摄方式建议 (Production Method Recommendations)
- 交付分工建议 (Delivery Assignment)

### Phase 5: Generate Document Files

After all content is finalized, generate output files:

1. First, write Markdown file to `{output_path}/{项目名称}_{版本}.md`
2. Then, generate Word document using Python script:

```bash
python "${SKILL_DIR}/scripts/generate_docx.py" "{input_md}" "{output_docx}" --title "{项目名称}" --version "{版本}"
```

Output files:
- `{项目名称}_提案版.md/.docx` - Proposal version
- `{项目名称}_完整版.md/.docx` - Complete version

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

| Version | Purpose | Reader | Content |
|---|---|---|---|
| **提案版** | 说服决策、确认方向 | 需求方（决策者/项目负责人） | 创意策略 + 完整文案分镜 + 省略执行细节 |
| **完整版** | 执行指导 | 制作团队 | 全部内容，含拍摄方式、交付分工 |

**提案版 ≠ 精简版**

提案版的本质是**说服**，不是"少"。核心原则：
- 不缩减打动人的核心内容（文案、分镜）
- 增加说服力内容（创意策略、核心表达、成片价值）
- 省略执行细节（拍摄方式、交付分工）

## 提案版新增内容模板

### 创意策略 (Creative Strategy)

**自动推导依据：**
- 项目定位（客户类型、影片类型）
- 内容单元特征
- 参考样片风格
- 用户偏好

**输出结构：**
```
### 创意策略

**创意理念**
[一句话概括为什么选择这个创意方向]

**策略依据**
- 基于[项目定位/内容特征/受众洞察]
- 参考[样片风格/行业案例]
- 符合[传播目标/品牌调性]

**差异化亮点**
[与常规方案的差异点，让需求方看到独特价值]

### 创意洞察

**目标受众画像**
- [受众群体描述]
- 年龄：[年龄段]
- 痛点：[核心痛点]
- 情感需求：[深层需求]

**核心发现**
> [从调研中提炼的关键洞察]

### 传播策略

**内容策略**
- [内容方向]

**情绪策略**
- [情绪节奏设计]

**叙事策略**
- [叙事方式选择]
```

### 核心表达 (Core Expression)

**在创意主轴中强化呈现：**
```
### 创意主轴

**核心表达**
[一句话概括创意核心，便于决策者快速理解]

**情绪曲线**
[描述情绪起伏，如：开场吸引 → 中段深入 → 高潮震撼 → 结尾升华]

**观众感受预期**
[看完片子后观众会有什么感受/印象]
```

### 成片价值 (Value Proposition)

**在创作前提中补充：**
```
### 创作前提

**项目定位**
[客户类型 + 影片类型]

**成片目标**
[传播目标 + 预期效果]

**成片价值**
- 传达什么：[核心信息]
- 触达什么：[情感层面]
- 达到什么：[传播层面]
```

### 视觉风格设定 (Visual Style)

**让客户"看见"最终效果，降低想象门槛：**
```
### 视觉风格设定

**整体调性关键词**
- [关键词1] × [关键词2]
- [关键词3] × [关键词4]

**色彩体系**

| 色彩角色 | 色值 | 应用场景 |
|---------|------|---------|
| 主色 | #[色值] | [应用场景] |
| 辅助色 | #[色值] | [应用场景] |
| 点缀色 | #[色值] | [应用场景] |

**光影质感**
- [各阶段的光影设计]

**镜头语言**
- 运镜风格：[各阶段的运镜特点]
- 构图特点：[构图方式]
- 剪辑节奏：[节奏变化]

**视觉符号**
- 核心视觉元素：[元素描述]
- 符号演变逻辑：[变化过程]

**参考风格对标**
| 风格来源 | 借鉴要点 |
|---------|---------|
| [参考对象] | [借鉴内容] |
```

### 音乐音效设计 (Music & Sound)

**完善听觉体验规划：**
```
### 音乐风格规划

| 阶段 | 音乐风格 | 情绪表达 | 节奏特征 |
|-----|---------|---------|---------|
| [篇章名] | [风格] | [情绪] | [节奏] |

### 关键音效设计

| 时间点 | 音效类型 | 功能说明 |
|-------|---------|---------|
| [时间] | [音效] | [功能] |

### 情绪节奏曲线

[用图示表达音量、情绪、节奏的变化]
```

## 提案撰写黄金法则

### 黄金比例

```
封面+目录     5-10%
背景理解     15-20%
创意策略     15-20%
视觉风格     10-15%
分镜脚本     40-50%
音乐音效     5-10%
```

### 逻辑链条

```
背景分析 → 洞察提炼 → 创意生成 → 视觉转化 → 内容落地
```

每一环节都要有逻辑承接，形成闭环。

### 信息层级

```
一级信息：核心创意概念（1个）
二级信息：支撑要点（3-5个）
三级信息：细节内容（展开说明）
```

### 情感曲线

提案阅读过程要有情绪起伏：
```
开篇：好奇/期待
背景：认同/信任
创意：惊喜/赞叹
分镜：沉浸/感动
结尾：信任/行动意愿
```

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
