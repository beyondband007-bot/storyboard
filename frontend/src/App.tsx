import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  FilePlus2,
  FileText,
  LoaderCircle,
  Menu,
  Plus,
  SendHorizontal,
  Trash2,
  Upload,
} from "lucide-react";
import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

marked.setOptions({ gfm: true, breaks: true });

type UiTheme = "light" | "tech";
type AssetStatus = "uploaded" | "processing" | "ready" | "failed";
type GenerationMode = "none" | "proposal" | "full";
type MessageType = "chat" | "need_card" | "streaming_status" | "asset" | `document_result:${GenerationMode}` | string;

type SidebarUser = {
  name: string;
  email: string;
  avatarText: string;
};

type ProjectSummary = {
  id: string;
  project_name: string;
  video_type: string;
  updated_at: string;
};

type WorkflowStep = {
  key: string;
  label: string;
  status: "completed" | "active" | "upcoming";
};

type MissingCardData = {
  title: string;
  body: string;
  tone: string;
};

type AssetOverview = {
  total: number;
  ready: number;
  processing: number;
  failed: number;
  highlighted: string[];
};

type ActiveOutput = {
  version: string;
  label: string;
  focus_title: string;
  focus_summary: string;
  status: string;
};

type InsightProjectSummary = {
  positioning: string;
  audience: string;
  style: string;
  duration: string;
  version_target: string;
};

type InsightPanelData = {
  stage: string;
  stage_label: string;
  stage_summary: string;
  badge: string;
  project_summary: InsightProjectSummary;
  assumptions: string[];
  asset_summary: string[];
  current_output: ActiveOutput;
  shot_highlights: string[];
  tags: string[];
};

type ChatMessage = {
  id: string;
  role: string;
  content: string;
  message_type: MessageType;
  streaming: boolean;
  created_at: string;
};

type ContentUnit = {
  name: string;
  selling_points: string;
  naming: string;
};

type ExecutionAssumption = {
  source: string;
  title: string;
  detail: string;
};

type ProjectMeta = {
  project_name: string;
  client_type: string;
  video_type: string;
  duration: string;
  aspect_ratio: string;
  style: string;
  version: string;
  brand_assets: string;
  reference_samples: string;
};

type ProjectAsset = {
  id: string;
  filename: string;
  original_filename: string;
  content_type: string;
  asset_type: "reference" | "brand" | "other";
  size: number;
  summary: string;
  status: AssetStatus;
  error: string;
  created_at: string;
  updated_at: string;
};

type ProjectState = {
  id: string;
  meta: ProjectMeta;
  content_units: ContentUnit[];
  steps: Record<string, { key: string; title: string; content: string; confirmed: boolean; updated_at: string | null }>;
  messages: ChatMessage[];
  execution_assumptions: ExecutionAssumption[];
  stage: string;
  workflow_stage: string;
  workflow_steps: WorkflowStep[];
  stage_summary: string;
  missing_card: MissingCardData | null;
  asset_overview: AssetOverview;
  active_output: ActiveOutput;
  insight_panel: InsightPanelData;
  selection_state: Record<string, unknown>;
  last_export: Record<string, string>;
  active_version: "proposal" | "full";
  proposal_markdown: string;
  full_markdown: string;
  final_markdown: string;
  exports: Record<string, string>;
  assets: ProjectAsset[];
  created_at: string;
  updated_at: string;
};

type AssetUploadResponse = {
  project: ProjectState;
  asset: ProjectAsset;
};

type ExportResponse = {
  project: ProjectState;
  filename: string;
  path: string;
  download_url: string;
};

type PendingUpload = {
  id: string;
  original_filename: string;
  size: number;
  content_type: string;
  status: "processing" | "failed";
  error: string;
  created_at: string;
};

type StreamState = {
  active: boolean;
  statusText: string;
  generationMode: GenerationMode;
};

type TimelineItem =
  | { kind: "message"; order: number; createdAt: string; message: ChatMessage };

type InsightAssetItem =
  | { kind: "asset"; createdAt: string; asset: ProjectAsset }
  | { kind: "pending_asset"; createdAt: string; asset: PendingUpload };

const themeStorageKey = "storyboard_ui_theme";

const sidebarUser: SidebarUser = {
  name: "DaFei",
  email: "dafei@example.com",
  avatarText: "DA",
};

const fallbackWorkflowSteps: WorkflowStep[] = [
  { key: "requirements", label: "需求采集", status: "active" },
  { key: "assets", label: "素材理解", status: "upcoming" },
  { key: "judgement", label: "项目判断", status: "upcoming" },
  { key: "proposal", label: "提案版生成", status: "upcoming" },
  { key: "full", label: "完整版生成", status: "upcoming" },
  { key: "export", label: "导出交付", status: "upcoming" },
];

const openingPrompts = [
  {
    label: "企业宣传片",
    text: "我想制作一个企业宣传片，请先带我补齐项目定位、风格、片长和目标受众。",
  },
  {
    label: "产品介绍分镜",
    text: "我想做一支产品介绍分镜，重点突出产品卖点、使用场景和镜头表达。",
  },
  {
    label: "政务科技风",
    text: "请按政务科技感帮我推进一支宣传片分镜，先判断还缺哪些资料。",
  },
  {
    label: "城市管家方案",
    text: "我想做城市管家一体化方案宣传片，请先帮我梳理项目定位、目标受众和内容单元。",
  },
  {
    label: "品牌形象片",
    text: "我想做品牌形象片，请从需求采集开始，帮我确认片长、风格基调和品牌口径。",
  },
];

function createEmptyProject(): ProjectState {
  const now = new Date().toISOString();
  return {
    id: "",
    meta: {
      project_name: "未命名项目",
      client_type: "企业",
      video_type: "宣传片",
      duration: "3分钟",
      aspect_ratio: "16:9 横版",
      style: "",
      version: "完整版",
      brand_assets: "",
      reference_samples: "",
    },
    content_units: [],
    steps: {},
    messages: [],
    execution_assumptions: [],
    stage: "chat",
    workflow_stage: "requirements",
    workflow_steps: [],
    stage_summary: "",
    missing_card: null,
    asset_overview: {
      total: 0,
      ready: 0,
      processing: 0,
      failed: 0,
      highlighted: [],
    },
    active_output: {
      version: "",
      label: "",
      focus_title: "",
      focus_summary: "",
      status: "idle",
    },
    insight_panel: {
      stage: "requirements",
      stage_label: "需求采集",
      stage_summary: "",
      badge: "等待开始",
      project_summary: {
        positioning: "",
        audience: "",
        style: "",
        duration: "",
        version_target: "",
      },
      assumptions: [],
      asset_summary: [],
      current_output: {
        version: "",
        label: "",
        focus_title: "",
        focus_summary: "",
        status: "idle",
      },
      shot_highlights: [],
      tags: [],
    },
    selection_state: {},
    last_export: {},
    active_version: "full",
    proposal_markdown: "",
    full_markdown: "",
    final_markdown: "",
    exports: {},
    assets: [],
    created_at: now,
    updated_at: now,
  };
}

function readPreferredTheme(): UiTheme {
  try {
    const saved = window.localStorage.getItem(themeStorageKey);
    if (saved === "light" || saved === "tech") {
      return saved;
    }
  } catch {
    return "light";
  }
  return "light";
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail);
  }

  return (await response.json()) as T;
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string };
    return payload.detail || `请求失败 (${response.status})`;
  } catch {
    return `请求失败 (${response.status})`;
  }
}

function formatRelativeTime(value: string): string {
  if (!value) return "刚刚";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "刚刚";
  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  return `${Math.floor(diff / day)} 天前`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function fileTypeLabel(contentType: string): string {
  if (contentType.includes("pdf")) return "PDF";
  if (contentType.includes("word") || contentType.includes("document")) return "Word";
  if (contentType.startsWith("image/")) return "图片";
  if (contentType.startsWith("video/")) return "视频";
  return "资料";
}

function renderMarkdown(content: string): string {
  return DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
}

function buildTimeline(project: ProjectState | null): TimelineItem[] {
  if (!project) {
    return [];
  }

  const items: TimelineItem[] = [
    ...project.messages.map((message, index) => ({
      kind: "message" as const,
      order: index,
      createdAt: message.created_at || "",
      message,
    })),
  ];

  return items.sort((left, right) => {
    if (left.createdAt && right.createdAt && left.createdAt !== right.createdAt) {
      return left.createdAt.localeCompare(right.createdAt);
    }
    return left.order - right.order;
  });
}

function buildInsightAssets(project: ProjectState | null, pendingUploads: PendingUpload[]): InsightAssetItem[] {
  const items: InsightAssetItem[] = [
    ...(project?.assets.map((asset) => ({
      kind: "asset" as const,
      createdAt: asset.created_at || "",
      asset,
    })) ?? []),
    ...pendingUploads.map((asset) => ({
      kind: "pending_asset" as const,
      createdAt: asset.created_at,
      asset,
    })),
  ];

  return items.sort((left, right) => {
    if (left.createdAt && right.createdAt && left.createdAt !== right.createdAt) {
      return left.createdAt.localeCompare(right.createdAt);
    }
    return 0;
  });
}

function createLocalUserMessage(content: string): ChatMessage {
  return {
    id: `local-${crypto.randomUUID()}`,
    role: "user",
    content,
    message_type: "chat",
    streaming: false,
    created_at: new Date().toISOString(),
  };
}

function stageLabel(project: ProjectState | null): string {
  if (!project) return "需求采集";
  return project.workflow_steps.find((step) => step.key === project.workflow_stage)?.label || project.insight_panel.stage_label || "需求采集";
}

function versionLabel(mode: string): string {
  return mode === "proposal" ? "提案版" : "完整版";
}

function projectLoadedText(project: ProjectState | null, streamState: StreamState): string {
  if (!project) return "等待建立项目";
  const stage = stageLabel(project);
  if (streamState.active) {
    return `${streamState.statusText} · 当前阶段：${stage}`;
  }
  if (project.asset_overview.total > 0) {
    return `已识别 ${project.asset_overview.total} 份素材 · 当前阶段：${stage}`;
  }
  return `当前阶段：${stage}`;
}

function documentLabel(message: ChatMessage, activeVersion: ProjectState["active_version"]): string {
  if (message.message_type === "document_result:proposal") return "提案版";
  if (message.message_type === "document_result:full") return "完整版";
  return activeVersion === "proposal" ? "提案版" : "完整版";
}

function workflowProgress(project: ProjectState | null): { current: number; total: number; percent: number } {
  const steps = project?.workflow_steps.length ? project.workflow_steps : fallbackWorkflowSteps;
  const total = steps.length || 1;
  const activeIndex = Math.max(steps.findIndex((step) => step.key === project?.workflow_stage), 0);
  return {
    current: activeIndex + 1,
    total,
    percent: ((activeIndex + 1) / total) * 100,
  };
}

function LoadingBubble({ text }: { text: string }) {
  return (
    <div className="message assistant loading-message">
      <span>分镜助理</span>
      <div className="loading-bubble">
        <LoaderCircle className="loading-spinner" size={18} />
        <span>{text}</span>
        <span className="loading-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="message user">
      <span>你</span>
      <pre>{message.content}</pre>
    </div>
  );
}

function AssistantChatMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="message assistant">
      <span>AI 导演</span>
      <div className="bubble assistant-bubble">
        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content || " ") }} />
      </div>
    </div>
  );
}

function WelcomeBubble({ onSelectPrompt }: { onSelectPrompt: (message: string) => void }) {
  return (
    <section className="opening-screen" aria-label="分镜工作台开场">
      <div className="opening-orbit" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="opening-copy">
        <span className="opening-kicker">AI DIRECTOR WORKBENCH</span>
        <h2>今天想把什么做成分镜？</h2>
        <p>一句想法、一个产品名，或一份资料都可以。我会先收集关键信息，再带你生成提案版和完整版。</p>
      </div>
      <div className="opening-prompts" aria-label="快捷开始">
        {openingPrompts.map((prompt) => (
          <button key={prompt.label} type="button" onClick={() => onSelectPrompt(prompt.text)}>
            {prompt.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function StreamingDocumentMessage({
  content,
  label,
  streaming = false,
  onExportMarkdown,
  onExportWord,
}: {
  content: string;
  label: string;
  streaming?: boolean;
  onExportMarkdown?: () => void;
  onExportWord?: () => void;
}) {
  const isProposal = label === "提案版";
  return (
    <div className="message assistant document-message">
      <span>{streaming ? `${label}生成中` : `${label}文档`}</span>
      <div
        className={`message-rich markdown-body ${streaming ? "streaming" : ""}`}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(content || " ") }}
      />
      {!streaming && onExportMarkdown && onExportWord ? (
        <div className="document-next-card">
          <div>
            <strong>{isProposal ? "提案版已生成，可以先交付方向稿" : "完整版已生成，可以进入交付"}</strong>
            <p>{isProposal ? "你可以导出给团队确认方向，也可以继续补充意见后生成完整版。" : "你可以导出文档，或继续补充修改意见再重生成。"}</p>
          </div>
          <div className="document-next-actions">
            <button type="button" onClick={onExportMarkdown}>
              <FileText size={14} />
              Markdown
            </button>
            <button type="button" onClick={onExportWord}>
              <FilePlus2 size={14} />
              Word
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NeedCard({ card }: { card: MissingCardData }) {
  return (
    <article className={`need-card tone-${card.tone}`}>
      <strong>{card.title}</strong>
      <p>{card.body}</p>
    </article>
  );
}

function AssetCard({
  asset,
  expanded,
  onToggle,
  onDelete,
}: {
  asset: ProjectAsset | PendingUpload;
  expanded: boolean;
  onToggle?: () => void;
  onDelete?: () => void;
}) {
  const status = asset.status;
  const isPending = !("filename" in asset);
  const summary = "summary" in asset ? asset.summary || asset.error || "解析中" : asset.error || "正在解析资料…";
  const statusText =
    status === "ready"
      ? "已解析，将用于生成"
      : status === "failed"
        ? "解析失败，但文件已保留，可继续输入需求"
        : "正在解析资料…";

  return (
    <article className={`asset-item asset-card ${status}`}>
      <div className="asset-item-head">
        <div>
          <strong title={asset.original_filename}>{asset.original_filename}</strong>
          <small>
            {fileTypeLabel(asset.content_type)} · {formatBytes(asset.size)}
          </small>
        </div>
        <span className={`asset-status ${status}`}>
          {status === "processing" ? (
            <>
              <LoaderCircle className="loading-spinner" size={14} />
              <span>解析中</span>
            </>
          ) : status === "ready" ? (
            "用于生成"
          ) : (
            "保留可用"
          )}
        </span>
      </div>
      <p className="asset-status-line">{statusText}</p>
      <div className="asset-summary">
        <p>{expanded ? summary || "暂无可预览内容。" : "摘要已收起，展开后查看。"}</p>
      </div>
      <div className="asset-actions">
        {"summary" in asset && summary ? (
          <button type="button" onClick={onToggle}>
            {expanded ? "收起" : "展开全文"}
          </button>
        ) : (
          <span className="asset-hint">等待解析完成后可展开预览</span>
        )}
        <button type="button" onClick={onDelete} className="asset-delete">
          删除素材
        </button>
      </div>
      {isPending ? null : <p className="asset-generated-tip">此素材会优先用于后续生成。</p>}
    </article>
  );
}

function InsightSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="insight-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function InsightPanelView({
  project,
  pendingUploads,
  expandedAssets,
  onToggleAsset,
  onDeleteAsset,
  onRemovePendingUpload,
  open,
  onClose,
}: {
  project: ProjectState | null;
  pendingUploads: PendingUpload[];
  expandedAssets: Record<string, boolean>;
  onToggleAsset: (assetId: string) => void;
  onDeleteAsset: (assetId: string) => void;
  onRemovePendingUpload: (assetId: string) => void;
  open: boolean;
  onClose: () => void;
}) {
  const insight = project?.insight_panel;
  const progress = workflowProgress(project);
  const steps = project?.workflow_steps.length ? project.workflow_steps : fallbackWorkflowSteps;
  const assets = buildInsightAssets(project, pendingUploads);

  return (
    <aside className={`insight-panel workbench-insight ${open ? "open" : ""}`} aria-label="当前生成洞察">
        <button type="button" className="mobile-only insight-close insight-close-floating" onClick={onClose}>
          收起
        </button>

      <div className="insight-scroll">
        <div className="match-card status-card workflow-progress-card">
          <div className="workflow-progress-head">
            <div>
              <b>{insight?.stage_label || "需求采集"}</b>
              <span>{insight?.badge || "等待开始"}</span>
            </div>
            <strong>
              {progress.current}/{progress.total}
            </strong>
          </div>
          <div className="workflow-progress-track" aria-hidden="true">
            <i style={{ width: `${progress.percent}%` }} />
          </div>
          <p className="stage-brief">{project?.stage_summary || "上传资料或直接描述需求，系统会按流程推进。"} </p>
          <div className="workflow-progress-steps">
            {steps.map((step, index) => (
              <div key={step.key} className={`workflow-progress-step ${step.status}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <b>{step.label}</b>
              </div>
            ))}
          </div>
        </div>

        <InsightSection title="当前项目判断">
          <div className="insight-list">
            <div>
              <b>项目定位</b>
              <p>{insight?.project_summary.positioning || "待系统判断"}</p>
            </div>
            <div>
              <b>目标受众</b>
              <p>{insight?.project_summary.audience || "待系统判断"}</p>
            </div>
            <div>
              <b>风格基调</b>
              <p>{insight?.project_summary.style || "待补充"}</p>
            </div>
            <div>
              <b>片长与版本</b>
              <p>
                {(insight?.project_summary.duration || "待补充") + " · " + (insight?.project_summary.version_target || "待确定")}
              </p>
            </div>
          </div>
        </InsightSection>

        <InsightSection title="素材使用概览">
          <ul className="insight-bullets">
            {(insight?.asset_summary.length ? insight.asset_summary : ["暂无上传素材。"]).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="insight-assets">
            {assets.length ? (
              assets.map((item) =>
                item.kind === "asset" ? (
                  <AssetCard
                    key={item.asset.id}
                    asset={item.asset}
                    expanded={Boolean(expandedAssets[item.asset.id])}
                    onToggle={() => onToggleAsset(item.asset.id)}
                    onDelete={() => onDeleteAsset(item.asset.id)}
                  />
                ) : (
                  <AssetCard key={item.asset.id} asset={item.asset} expanded onDelete={() => onRemovePendingUpload(item.asset.id)} />
                ),
              )
            ) : (
              <div className="insight-empty">
                <p>还没有上传素材，你可以在底部上传 PDF、Word、图片或视频。</p>
              </div>
            )}
          </div>
        </InsightSection>
      </div>
    </aside>
  );
}

function WorkflowHeader({
  project,
  streamState,
  theme,
  onThemeChange,
  onExport,
  onToggleSidebar,
  onToggleInsight,
}: {
  project: ProjectState | null;
  streamState: StreamState;
  theme: UiTheme;
  onThemeChange: (theme: UiTheme) => void;
  onExport: (version: "proposal" | "full", kind: "markdown" | "docx") => void;
  onToggleSidebar: () => void;
  onToggleInsight: () => void;
}) {
  const canExportProposal = Boolean(project?.proposal_markdown);
  const canExportFull = Boolean(project?.full_markdown || project?.final_markdown);

  return (
    <header className="chat-header workflow-header">
      <div>
        <p className="eyebrow">AI DIRECTOR CHAT</p>
        <h1>{project?.meta.project_name || "未命名项目"}</h1>
        <p>{project?.stage_summary || "上传资料或直接输入需求，系统会按工作流推进分镜生成。"} </p>
      </div>

      <div className="header-actions">
        <button type="button" className="mobile-only" onClick={onToggleSidebar}>
          <Menu size={16} />
        </button>
        <button type="button" className="mobile-only" onClick={onToggleInsight}>
          洞察
        </button>

        <div className="theme-switch" role="group" aria-label="风格切换">
          <button
            type="button"
            className={`theme-switch-btn ${theme === "light" ? "active" : ""}`}
            onClick={() => onThemeChange("light")}
          >
            白色版
          </button>
          <button
            type="button"
            className={`theme-switch-btn ${theme === "tech" ? "active" : ""}`}
            onClick={() => onThemeChange("tech")}
          >
            科技感
          </button>
        </div>

        <span className="pill ok">{streamState.active ? streamState.statusText : project?.insight_panel.badge || "等待开始"}</span>

        {canExportProposal ? (
          <>
            <button type="button" onClick={() => onExport("proposal", "markdown")}>
              <FileText size={14} />
              导出提案 Markdown
            </button>
            <button type="button" onClick={() => onExport("proposal", "docx")}>
              <FilePlus2 size={14} />
              导出提案 Word
            </button>
          </>
        ) : null}

        {canExportFull ? (
          <>
            <button type="button" onClick={() => onExport("full", "markdown")}>
              <FileText size={14} />
              导出完整版 Markdown
            </button>
            <button type="button" onClick={() => onExport("full", "docx")}>
              <FilePlus2 size={14} />
              导出完整版 Word
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}

function Composer({
  value,
  statusText,
  onChange,
  onSubmit,
  onPickFiles,
  onKeyDown,
  disabled,
}: {
  value: string;
  statusText: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onPickFiles: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
}) {
  return (
    <div className="composer workbench-composer">
      <div className="upload-row">
        <button type="button" className="upload-btn" onClick={onPickFiles}>
          上传素材
        </button>
        <div className="upload-hint">支持 PDF、Word、图片、视频和参考分镜表</div>
      </div>

      <div className="input-box-shell">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="composer-input workbench-input"
          placeholder="输入项目想法或修改意见，例如：补充命名口径、调整画面风格、直接生成完整版。"
          rows={3}
        />
        <button type="button" className="send workbench-send" onClick={onSubmit} disabled={disabled}>
          <SendHorizontal size={16} />
          发送
        </button>
        <div className="loaded">{statusText}</div>
      </div>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<UiTheme>(readPreferredTheme);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectState | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [composerValue, setComposerValue] = useState("");
  const [expandedAssets, setExpandedAssets] = useState<Record<string, boolean>>({});
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [streamState, setStreamState] = useState<StreamState>({ active: false, statusText: "", generationMode: "none" });
  const [streamingContent, setStreamingContent] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [insightOpen, setInsightOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [visibleNeedCard, setVisibleNeedCard] = useState<MissingCardData | null>(null);

  const messagesRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeProjectRef = useRef<ProjectState | null>(null);

  useEffect(() => {
    activeProjectRef.current = activeProject;
  }, [activeProject]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // Ignore localStorage failures.
    }
  }, [theme]);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    const node = messagesRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [activeProject, streamingContent, streamState]);

  const timeline = useMemo(() => buildTimeline(activeProject), [activeProject]);

  async function bootstrap() {
    try {
      const summaries = await apiJson<ProjectSummary[]>("/api/projects");
      setProjects(summaries);
      if (summaries.length > 0) {
        await openProject(summaries[0].id, false);
      } else {
        await createProject(false);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "初始化失败");
    } finally {
      setBootstrapping(false);
    }
  }

  async function refreshProjects(preferredId?: string) {
    const summaries = await apiJson<ProjectSummary[]>("/api/projects");
    startTransition(() => {
      setProjects(summaries);
    });
    if (preferredId) {
      setSelectedProjectId(preferredId);
    }
  }

  function clearStreamState() {
    setStreamState({ active: false, statusText: "", generationMode: "none" });
    setStreamingContent("");
  }

  function abortActiveStream() {
    abortRef.current?.abort();
    abortRef.current = null;
    clearStreamState();
  }

  async function createProject(select = true): Promise<ProjectState> {
    abortActiveStream();
    const project = await apiJson<ProjectState>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ project: createEmptyProject() }),
    });
    if (select) {
      setActiveProject(project);
      setSelectedProjectId(project.id);
      setComposerValue("");
      setPendingUploads([]);
      setExpandedAssets({});
      setVisibleNeedCard(null);
    }
    await refreshProjects(project.id);
    return project;
  }

  async function ensureProject(): Promise<ProjectState> {
    const current = activeProjectRef.current;
    if (current?.id) {
      return current;
    }
    return createProject(true);
  }

  async function openProject(projectId: string, closeSidebar = true) {
    abortActiveStream();
    const project = await apiJson<ProjectState>(`/api/projects/${projectId}`);
    setActiveProject(project);
    setSelectedProjectId(projectId);
    setComposerValue("");
    setPendingUploads([]);
    setExpandedAssets({});
    setVisibleNeedCard(null);
    if (closeSidebar) {
      setSidebarOpen(false);
    }
  }

  async function removeProject(projectId: string) {
    if (!window.confirm("确认删除这个项目吗？")) {
      return;
    }
    abortActiveStream();
    const response = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
    if (!response.ok) {
      throw new Error(await readErrorDetail(response));
    }
    const summaries = await apiJson<ProjectSummary[]>("/api/projects");
    setProjects(summaries);
    if (summaries.length > 0) {
      await openProject(summaries[0].id);
    } else {
      await createProject(true);
    }
  }

  async function exportDocument(version: "proposal" | "full", kind: "markdown" | "docx") {
    const project = activeProjectRef.current;
    if (!project) return;
    const markdown = version === "proposal" ? project.proposal_markdown : project.full_markdown || project.final_markdown;
    const response = await apiJson<ExportResponse>(`/api/export/${version}/${kind}`, {
      method: "POST",
      body: JSON.stringify({ project, markdown, version }),
    });
    setActiveProject(response.project);
    const url = new URL(response.download_url, window.location.origin).toString();
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function deleteAsset(assetId: string) {
    const project = activeProjectRef.current;
    if (!project) return;
    const nextProject = await apiJson<ProjectState>(`/api/projects/${project.id}/assets/${assetId}`, {
      method: "DELETE",
    });
    setActiveProject(nextProject);
  }

  async function uploadFiles(fileList: File[]) {
    if (!fileList.length) return;
    const project = await ensureProject();

    for (const file of fileList) {
      const tempId = `pending-${crypto.randomUUID()}`;
      const pendingAsset: PendingUpload = {
        id: tempId,
        original_filename: file.name,
        size: file.size,
        content_type: file.type,
        status: "processing",
        error: "",
        created_at: new Date().toISOString(),
      };

      setPendingUploads((current) => [...current, pendingAsset]);

      const body = new FormData();
      body.append("file", file);
      body.append("asset_type", "other");

      try {
        const response = await fetch(`/api/projects/${project.id}/assets/upload`, {
          method: "POST",
          body,
        });
        if (!response.ok) {
          throw new Error(await readErrorDetail(response));
        }
        const payload = (await response.json()) as AssetUploadResponse;
        setActiveProject(payload.project);
        await refreshProjects(payload.project.id);
        setPendingUploads((current) => current.filter((item) => item.id !== tempId));
      } catch (error) {
        const message = error instanceof Error ? error.message : "上传失败";
        setPendingUploads((current) =>
          current.map((item) => (item.id === tempId ? { ...item, status: "failed", error: message } : item)),
        );
      }
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void uploadFiles(files);
  }

  async function streamConversation(project: ProjectState, message: string) {
    abortActiveStream();
    const controller = new AbortController();
    abortRef.current = controller;
    setStreamState({ active: true, statusText: "正在思考…", generationMode: "none" });
    setStreamingContent("");

    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, message }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(await readErrorDetail(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const line = chunk
          .split("\n")
          .find((entry) => entry.trim().startsWith("data:"));
        if (!line) continue;
        const payload = JSON.parse(line.replace(/^data:\s*/, "")) as {
          type: string;
          project?: ProjectState;
          content?: string;
          status_text?: string;
          generation_mode?: GenerationMode;
          message?: string;
        };

        if (payload.type === "asset_status") {
          continue;
        }

        if (payload.type === "project_update" && payload.project) {
          setActiveProject(payload.project);
          setSelectedProjectId(payload.project.id);
          setVisibleNeedCard(payload.project.missing_card || null);
          setStreamState({
            active: true,
            statusText: payload.status_text || "正在思考…",
            generationMode: payload.generation_mode || "none",
          });
          continue;
        }

        if (payload.type === "delta" && payload.content) {
          setStreamingContent((current) => current + payload.content);
          continue;
        }

        if (payload.type === "done" && payload.project) {
          setActiveProject(payload.project);
          setSelectedProjectId(payload.project.id);
          setVisibleNeedCard(payload.project.missing_card || null);
          clearStreamState();
          await refreshProjects(payload.project.id);
          continue;
        }

        if (payload.type === "error") {
          throw new Error(payload.message || "生成失败");
        }
      }
    }

    abortRef.current = null;
  }

  async function submitMessage(rawMessage: string) {
    const message = rawMessage.trim();
    if (!message) return;

    const project = await ensureProject();
    const optimisticMessage = createLocalUserMessage(message);
    setActiveProject((current) => (current ? { ...current, messages: [...current.messages, optimisticMessage] } : current));
    setVisibleNeedCard(null);
    setComposerValue("");
    setErrorMessage("");

    try {
      await streamConversation(project, message);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      clearStreamState();
      setErrorMessage(error instanceof Error ? error.message : "生成失败");
    }
  }

  async function handleSubmit() {
    await submitMessage(composerValue);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit();
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length > 0) {
      void uploadFiles(files);
    }
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node)) {
      return;
    }
    setDragActive(false);
  }

  function removePendingUpload(id: string) {
    setPendingUploads((current) => current.filter((asset) => asset.id !== id));
  }

  if (bootstrapping) {
    return (
      <div className="app-layout">
        <main className="chat-main">
          <div className="chat-header">
            <div>
              <p className="eyebrow">AI DIRECTOR CHAT</p>
              <h1>对话式分镜工作台</h1>
              <p>正在准备项目空间，请稍等。</p>
            </div>
          </div>
          <div className="chat-workspace">
            <section className="chat-panel workbench-chat">
              <div className="messages">
                <LoadingBubble text="正在加载项目" />
              </div>
            </section>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-head">
          <strong>Storyboard</strong>
        </div>

        <button type="button" className="new-chat" onClick={() => void createProject(true)}>
          <Plus size={16} />
          新建项目
        </button>

        <div className="history-list">
          {projects.map((project) => (
            <div key={project.id} className={`history-row ${selectedProjectId === project.id ? "active" : ""}`}>
              <button type="button" className="history-item" onClick={() => void openProject(project.id)}>
                <span>{project.project_name || "未命名项目"}</span>
                <small>
                  {project.video_type || "宣传片"} · {formatRelativeTime(project.updated_at)}
                </small>
              </button>
              <button type="button" className="history-delete" onClick={() => void removeProject(project.id)} aria-label="删除项目">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-user">
          <div className="sidebar-user-main">
            <span className="sidebar-user-avatar">{sidebarUser.avatarText}</span>
            <div className="sidebar-user-meta">
              <strong className="sidebar-user-name">{sidebarUser.name}</strong>
              <span className="sidebar-user-email">{sidebarUser.email}</span>
            </div>
          </div>
        </div>
      </aside>

      <main className={`chat-main ${dragActive ? "drag-active" : ""}`} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
        {timeline.length > 0 ? (
          <WorkflowHeader
            project={activeProject}
            streamState={streamState}
            theme={theme}
            onThemeChange={setTheme}
            onExport={(version, kind) => void exportDocument(version, kind)}
            onToggleSidebar={() => setSidebarOpen((current) => !current)}
            onToggleInsight={() => setInsightOpen((current) => !current)}
          />
        ) : null}

        <div className="chat-workspace">
          <section className={`chat-panel workbench-chat ${timeline.length === 0 ? "opening-mode" : ""}`}>
            <div className="prompt-hero">
              <div>
                <h2>把想法聊成可执行分镜</h2>
                <p>系统会按工作流推进需求采集、素材理解、项目判断，再进入提案版与完整版生成。</p>
              </div>
              <div className="hero-orb" aria-hidden="true" />
            </div>

            <div className="workflow-strip" aria-label="工作流阶段">
              {(activeProject?.workflow_steps.length ? activeProject.workflow_steps : fallbackWorkflowSteps).map((step) => (
                <span key={step.key} className={step.status}>
                  {step.label}
                </span>
              ))}
            </div>

            <div className="messages" ref={messagesRef}>
              {timeline.length === 0 ? (
                <WelcomeBubble onSelectPrompt={(message) => void submitMessage(message)} />
              ) : null}

              {timeline.map((item) => {
                if (item.kind === "message") {
                  if (item.message.role === "user") {
                    return <UserMessage key={item.message.id} message={item.message} />;
                  }
                  if (item.message.message_type.startsWith("document_result")) {
                    const version = item.message.message_type === "document_result:proposal" ? "proposal" : "full";
                    return (
                      <StreamingDocumentMessage
                        key={item.message.id}
                        content={item.message.content}
                        label={documentLabel(item.message, activeProject?.active_version || "full")}
                        onExportMarkdown={() => void exportDocument(version, "markdown")}
                        onExportWord={() => void exportDocument(version, "docx")}
                      />
                    );
                  }
                  return <AssistantChatMessage key={item.message.id} message={item.message} />;
                }

                return null;
              })}

              {visibleNeedCard && streamState.generationMode === "none" ? <NeedCard card={visibleNeedCard} /> : null}
              {streamState.active && !streamingContent ? <LoadingBubble text={streamState.statusText} /> : null}
              {streamingContent ? <StreamingDocumentMessage content={streamingContent} label={versionLabel(streamState.generationMode)} streaming /> : null}
            </div>

            <Composer
              value={composerValue}
              statusText={projectLoadedText(activeProject, streamState)}
              onChange={setComposerValue}
              onSubmit={() => void handleSubmit()}
              onPickFiles={() => fileInputRef.current?.click()}
              onKeyDown={handleComposerKeyDown}
              disabled={!composerValue.trim()}
            />
          </section>

          <InsightPanelView
            project={activeProject}
            pendingUploads={pendingUploads}
            expandedAssets={expandedAssets}
            onToggleAsset={(assetId) =>
              setExpandedAssets((current) => ({
                ...current,
                [assetId]: !current[assetId],
              }))
            }
            onDeleteAsset={(assetId) => void deleteAsset(assetId)}
            onRemovePendingUpload={removePendingUpload}
            open={insightOpen}
            onClose={() => setInsightOpen(false)}
          />
        </div>

        {dragActive ? (
          <div className="drag-overlay">
            <Upload size={24} />
            <strong>松开即可上传资料</strong>
            <p>支持 PDF、Word、图片、视频和参考分镜表，上传后会自动进入素材理解阶段。</p>
          </div>
        ) : null}

        {errorMessage ? <div className="status-toast visible">{errorMessage}</div> : null}

        <input ref={fileInputRef} type="file" hidden multiple accept=".pdf,.doc,.docx,image/*,video/*" onChange={handleFileInput} />
      </main>
    </div>
  );
}
