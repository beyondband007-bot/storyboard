import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  ArrowRight,
  FolderPlus,
  Loader2,
  MessageCircle,
  MessageSquareText,
  PanelLeft,
  PanelRight,
  Send,
  Trash2,
  UploadCloud,
  X
} from "lucide-react";
import "./styles.css";

type AssetType = "company_intro" | "reference" | "content_unit" | "brand" | "other";
type GenerationMode = "proposal_first" | "full_direct";
type ExportVersion = "proposal" | "full";

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

type ContentUnit = {
  name: string;
  selling_points: string;
  naming: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  meta?: {
    kind?: "intake_restart";
    runId?: string;
  };
};

type StepResult = {
  key: string;
  title: string;
  content: string;
  confirmed: boolean;
  updated_at?: string | null;
};

type ProjectAsset = {
  id: string;
  filename: string;
  original_filename: string;
  content_type: string;
  asset_type: AssetType | string;
  size: number;
  path: string;
  summary: string;
  extracted_text: string;
  status: "uploaded" | "processing" | "ready" | "failed";
  error: string;
  created_at: string;
  updated_at: string;
};

type ProjectState = {
  id: string;
  meta: ProjectMeta;
  content_units: ContentUnit[];
  steps: Record<string, StepResult>;
  messages: ChatMessage[];
  stage: string;
  selection_state: Record<string, string>;
  last_export: Record<string, string>;
  active_version: ExportVersion;
  proposal_markdown: string;
  full_markdown: string;
  final_markdown: string;
  exports: Record<string, string>;
  assets: ProjectAsset[];
  created_at: string;
  updated_at: string;
};

type ProjectSummary = {
  id: string;
  project_name: string;
  video_type: string;
  updated_at: string;
};

type ExportResponse = {
  project: ProjectState;
  filename: string;
  path: string;
  download_url: string;
};

type DocumentTask = {
  message: string;
  markdown: string;
  version: ExportVersion;
};

type LogicTask = {
  id: string;
  title: string;
  message: string;
  markdown: string;
};

type LogicHistoryItem = {
  id: string;
  title: string;
  markdown: string;
  created_at: string;
  runId?: string;
};

type IntakeHistoryItem = LogicHistoryItem;

type TimelineItem =
  | { type: "message"; message: ChatMessage; key: string }
  | { type: "status"; text: string; key: string }
  | { type: "intake"; title?: string; markdown: string; key: string; busy?: boolean }
  | { type: "logic"; item: LogicHistoryItem; key: string };

type LogicOption = {
  type: string;
  fit: string;
  description: string;
};

const chinaTimeZone = "Asia/Shanghai";
const optionLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const genericLogicTitles = new Set(["内容逻辑推荐", "动态内容逻辑推荐", "内容逻辑", "逻辑推荐", "叙事逻辑推荐"]);
const genericStyleTitles = new Set(["文风推荐", "推荐文风", "文风确认", "文案风格推荐", "文案风格"]);
const processingRank: Record<ProjectAsset["status"], number> = {
  uploaded: 0,
  processing: 1,
  failed: 2,
  ready: 3
};

const defaultMeta = (): ProjectMeta => ({
  project_name: "",
  client_type: "",
  video_type: "",
  duration: "",
  aspect_ratio: "",
  style: "",
  version: "完整版",
  brand_assets: "",
  reference_samples: ""
});

const createEmptyProject = (): ProjectState => ({
  id: "",
  meta: defaultMeta(),
  content_units: [{ name: "", selling_points: "", naming: "" }],
  steps: {},
  messages: [],
  stage: "draft",
  selection_state: {},
  last_export: {},
  active_version: "full",
  proposal_markdown: "",
  full_markdown: "",
  final_markdown: "",
  exports: {},
  assets: [],
  created_at: nowIso(),
  updated_at: nowIso()
});

const fieldPresets: Record<keyof Pick<ProjectMeta, "client_type" | "video_type" | "duration" | "style" | "aspect_ratio">, string[]> = {
  client_type: ["政府客户", "国企客户", "企业客户", "园区客户", "消费品牌", "文旅单位"],
  video_type: ["宣传片", "产品介绍片", "汇报片", "招商片", "品牌形象片", "案例片", "短视频"],
  duration: ["30秒", "60秒", "90秒", "2分钟", "3分钟", "5分钟"],
  style: ["科技感、政务感、真实感", "高端专业、稳重可信", "温暖真实、生活化", "年轻轻快、节奏鲜明", "大气汇报、方案感"],
  aspect_ratio: ["16:9 横版", "9:16 竖版", "1:1 方版", "4:3 汇报屏", "21:9 宽银幕"]
};

const assetConfigs: Array<{ type: AssetType; title: string; hint: string; accept: string; optional?: boolean }> = [
  { type: "company_intro", title: "拍摄需求", hint: "PDF / Word / 图片", accept: ".pdf,.docx,.png,.jpg,.jpeg,.webp" },
  { type: "reference", title: "拍摄必要元素", hint: "视频 / PDF / 图片", accept: ".mp4,.mov,.webm,.m4v,.pdf,.png,.jpg,.jpeg,.webp" },
  { type: "content_unit", title: "参考样片", hint: "产品、场景、业务资料", accept: ".pdf,.docx,.png,.jpg,.jpeg,.webp,.mp4,.mov,.webm,.m4v" },
  { type: "brand", title: "公司资料", hint: "Logo / VI / 旧物料", accept: ".pdf,.docx,.png,.jpg,.jpeg,.webp", optional: true }
];

async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(data.detail || response.statusText);
  }
  return response.json() as Promise<T>;
}

async function streamProject(
  url: string,
  project: ProjectState,
  onDelta: (delta: string) => void
): Promise<ProjectState> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project })
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(data.detail || response.statusText);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalProject = project;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === "delta") onDelta(event.content);
      if (event.type === "done") finalProject = event.project;
      if (event.type === "error") throw new Error(event.message);
    }
  }

  return finalProject;
}

function getChinaDateParts(date: Date): Record<string, string> {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: chinaTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })
    .formatToParts(date)
    .reduce((parts, part) => {
      if (part.type !== "literal") parts[part.type] = part.value;
      return parts;
    }, {} as Record<string, string>);
}

const nowIso = () => {
  const parts = getChinaDateParts(new Date());
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
};

function parseStoredDate(value: string): Date | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;

  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)) {
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    const fallback = new Date(normalized);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, year, month, day, hour, minute, second = "00"] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
}

function formatTime(value: string): string {
  if (!value) return "";
  const parsed = parseStoredDate(value);
  if (!parsed) return value.replace("T", " ").slice(0, 16);
  const parts = getChinaDateParts(parsed);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function formatSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function markdownToHtml(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown || "", { async: false }) as string);
}

function projectSignature(project: ProjectState): string {
  const { updated_at: _updatedAt, created_at: _createdAt, ...rest } = project;
  return JSON.stringify(rest);
}

function mergeProjects(current: ProjectState | null, incoming: ProjectState): ProjectState {
  if (!current || current.id !== incoming.id) return incoming;
  const assets = new Map<string, ProjectAsset>();
  for (const asset of current.assets || []) assets.set(asset.id, asset);
  for (const asset of incoming.assets || []) {
    const existing = assets.get(asset.id);
    if (!existing || processingRank[asset.status] >= processingRank[existing.status]) {
      assets.set(asset.id, asset);
    }
  }
  return {
    ...current,
    ...incoming,
    assets: Array.from(assets.values())
  };
}

function extractLogicOptions(markdown: string): LogicOption[] {
  const options = new Map<string, LogicOption>();
  const recommended = (markdown.match(/推荐逻辑[：:]\s*([^\n]+)/)?.[1] || "").replace(/\*\*/g, "").trim();
  const addStructuredOption = (type: string, fit = "", description = "") => {
    const normalized = type.replace(/\*\*/g, "").replace(/^[✅✔]\s*/, "").trim();
    if (!normalized || genericLogicTitles.has(normalized) || /逻辑类型|---/.test(normalized)) return;
    options.set(normalized, {
      type: normalized,
      fit: fit.replace(/\*\*/g, "").trim(),
      description: description.replace(/\*\*/g, "").trim()
    });
  };
  const lines = (markdown || "").split(/\r?\n/);
  let inLogicSection = false;
  let inLogicTable = false;
  for (const line of lines) {
    if (/^\s*#{1,6}\s*.*内容逻辑推荐/.test(line) || /Phase\s*2[：:\s、-]*内容逻辑推荐/i.test(line)) {
      inLogicSection = true;
      inLogicTable = false;
      continue;
    }
    if (inLogicSection && /^\s*#{1,6}\s*/.test(line) && !/内容逻辑推荐/.test(line)) {
      inLogicSection = false;
      inLogicTable = false;
      continue;
    }
    if (!inLogicSection) continue;

    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length >= 3 && /逻辑类型/.test(cells[0]) && /适用性/.test(cells[1])) {
      inLogicTable = true;
      continue;
    }
    if (inLogicTable && /^\s*\|?\s*:?-{3,}/.test(line)) continue;
    if (inLogicTable && cells.length >= 3) {
      addStructuredOption(cells[0], cells[1], cells.slice(2).join("｜"));
      continue;
    }
    if (inLogicTable && line.trim() && !line.includes("|")) break;
  }
  return Array.from(options.values());
}

function parseLogicHistory(project?: ProjectState | null): LogicHistoryItem[] {
  const raw = project?.selection_state.logicRecommendationHistory;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as LogicHistoryItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.id === "string" && typeof item.markdown === "string");
  } catch {
    return [];
  }
}

function withAppendedLogicHistory(project: ProjectState, item: LogicHistoryItem): ProjectState {
  const history = parseLogicHistory(project);
  return {
    ...project,
    selection_state: {
      ...project.selection_state,
      logicRecommendationHistory: JSON.stringify([...history, item])
    },
    updated_at: nowIso()
  };
}

function parseIntakeHistory(project?: ProjectState | null): IntakeHistoryItem[] {
  const raw = project?.selection_state.intakeSummaryHistory;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as IntakeHistoryItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.id === "string" && typeof item.markdown === "string");
  } catch {
    return [];
  }
}

function withAppendedIntakeHistory(project: ProjectState, item: IntakeHistoryItem): ProjectState {
  const history = parseIntakeHistory(project);
  return {
    ...project,
    selection_state: {
      ...project.selection_state,
      intakeSummaryHistory: JSON.stringify([...history, item])
    },
    updated_at: nowIso()
  };
}

function withArchivedLiveIntake(project: ProjectState): ProjectState {
  const markdown = (project.selection_state.intakeSummary || project.selection_state.logicRecommendations || "").trim();
  if (!markdown) return project;
  const history = parseIntakeHistory(project);
  if (history.some((item) => item.markdown.trim() === markdown)) return project;
  return withAppendedIntakeHistory(project, {
    id: `intake-archived-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: "上一次资料整理与内容逻辑推荐",
    markdown,
    created_at: nowIso()
  });
}

function extractStyleOptions(markdown: string): LogicOption[] {
  const options = new Map<string, LogicOption>();
  const addStructuredOption = (type: string, fit = "", description = "") => {
    const normalized = type
      .replace(/\*\*/g, "")
      .replace(/^[✅✔•\-*\dA-ZＡ-Ｚ]+[.、\s]*/i, "")
      .replace(/^推荐文风[：:]\s*/, "")
      .trim();
    if (!normalized || genericStyleTitles.has(normalized) || /文风类型|文案风格|---/.test(normalized)) return;
    options.set(normalized, {
      type: normalized,
      fit: fit.replace(/\*\*/g, "").trim(),
      description: description.replace(/\*\*/g, "").trim()
    });
  };
  const lines = (markdown || "").split(/\r?\n/);
  let inStyleSection = false;
  let inStyleTable = false;
  let tableIndexes: { type: number; fit: number; description: number[] } | null = null;
  for (const line of lines) {
    const recommended = line.match(/推荐文风[：:]\s*([^\n，。；;|]+)/);
    if (recommended?.[1]) {
      addStructuredOption(recommended[1], "最佳匹配", "系统推荐");
      continue;
    }

    if (/^\s*#{1,6}\s*.*(文风|文案风格).*推荐/.test(line) || /Phase\s*3[：:\s、-]*(文风|文案风格)/i.test(line)) {
      inStyleSection = true;
      inStyleTable = false;
      tableIndexes = null;
      continue;
    }
    if (inStyleSection && /^\s*#{1,6}\s*/.test(line) && !/(文风|文案风格).*推荐/.test(line)) {
      inStyleSection = false;
      inStyleTable = false;
      tableIndexes = null;
      continue;
    }

    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    const mightBeStyleTable = cells.length >= 2 && cells.some((cell) => /文风|文案风格|风格|类型/.test(cell));
    if ((inStyleSection || mightBeStyleTable) && cells.length >= 2 && /文风|文案风格|风格|类型/.test(cells.join(" "))) {
      inStyleTable = true;
      inStyleSection = true;
      const typeIndex = cells.findIndex((cell) => /文风|文案风格|风格|类型/.test(cell));
      const fitIndex = cells.findIndex((cell) => /适用|匹配|推荐|定位/.test(cell));
      const descriptionIndexes = cells.map((_, index) => index).filter((index) => index !== typeIndex && index !== fitIndex);
      tableIndexes = {
        type: Math.max(typeIndex, 0),
        fit: fitIndex >= 0 ? fitIndex : 1,
        description: descriptionIndexes.length ? descriptionIndexes : [1]
      };
      continue;
    }
    if (inStyleTable && /^\s*\|?\s*:?-{3,}/.test(line)) continue;
    if (inStyleTable && tableIndexes && cells.length >= 2) {
      addStructuredOption(
        cells[tableIndexes.type] || cells[0],
        cells[tableIndexes.fit] || "",
        tableIndexes.description.map((index) => cells[index]).filter(Boolean).join("｜")
      );
      continue;
    }
    if (inStyleTable && line.trim() && !line.includes("|")) break;

    if (inStyleSection) {
      const listMatch = line.match(/^\s*(?:[-*]|\d+[.、]|[A-ZＡ-Ｚ][.、])\s*(?:\*\*)?([^：:：\-|（(]{2,18}(?:文风|风|感|调|式)?)(?:\*\*)?[：:：\-（(]?\s*(.*)$/i);
      if (listMatch?.[1] && /(风|感|调|式|简洁|温柔|可爱|活泼|正式|严谨|治愈|诗意|写实|留白|烟火|热血|轻快)/.test(listMatch[1])) {
        addStructuredOption(listMatch[1], "", listMatch[2] || "");
      }
    }
  }
  return Array.from(options.values());
}

function appendConversationMessages(
  project: ProjectState,
  content: string,
  assistantReply: string,
  meta?: ChatMessage["meta"]
): ProjectState {
  return {
    ...project,
    messages: [
      ...(project.messages || []),
      { role: "user", content, meta },
      { role: "assistant", content: assistantReply, meta }
    ],
    updated_at: nowIso()
  };
}

function buildConversationTimeline(
  messages: ChatMessage[],
  logicHistory: LogicHistoryItem[],
  intakeHistory: IntakeHistoryItem[],
  intakeMarkdown: string,
  statusText: string,
  activeIntakeRunId = ""
): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  let historyIndex = 0;
  let liveIntakeInserted = false;
  let legacyIntakeInserted = false;
  const intakeByRunId = new Map(intakeHistory.filter((item) => item.runId).map((item) => [item.runId, item]));
  const anchoredRunIds = new Set<string>();
  const legacyIntakeHistory = intakeHistory.filter((item) => !item.runId);
  const appendIntakeHistory = (item: IntakeHistoryItem) => {
    timeline.push({
      type: "intake",
      title: item.title,
      markdown: item.markdown,
      key: `intake-${item.id}`
    });
  };
  const appendLiveIntake = (runId = activeIntakeRunId) => {
    if (intakeMarkdown.trim()) {
      timeline.push({
        type: "intake",
        title: runId ? "重新整理资料与内容逻辑推荐" : "资料整理与内容逻辑推荐",
        markdown: intakeMarkdown,
        key: runId ? `intake-live-${runId}` : "intake-live",
        busy: Boolean(statusText)
      });
    } else if (statusText) {
      timeline.push({ type: "status", text: statusText, key: runId ? `status-intake-${runId}` : "status-intake" });
    }
    liveIntakeInserted = true;
  };
  const appendLegacyIntakeHistory = () => {
    if (legacyIntakeInserted) return;
    legacyIntakeHistory.forEach(appendIntakeHistory);
    legacyIntakeInserted = true;
  };

  messages.forEach((message, index) => {
    if (!legacyIntakeInserted && message.role === "user" && message.meta?.kind === "intake_restart") {
      appendLegacyIntakeHistory();
    }
    timeline.push({ type: "message", message, key: `message-${index}` });
    if (message.role === "assistant") {
      const restartRunId = message.meta?.kind === "intake_restart"
        ? message.meta.runId
        : "";
      if (restartRunId) {
        anchoredRunIds.add(restartRunId);
        const historyItem = intakeByRunId.get(restartRunId);
        if (historyItem) {
          appendIntakeHistory(historyItem);
        } else if (activeIntakeRunId === restartRunId && statusText) {
          appendLiveIntake(restartRunId);
        }
      }
      if (message.content.includes("重新推荐内容逻辑") && logicHistory[historyIndex]) {
        const item = logicHistory[historyIndex];
        timeline.push({ type: "logic", item, key: `logic-${item.id}` });
        historyIndex += 1;
      }
    }
  });

  if (statusText && !liveIntakeInserted) {
    appendLiveIntake();
  }

  appendLegacyIntakeHistory();

  intakeHistory.forEach((item) => {
    if (item.runId && !anchoredRunIds.has(item.runId)) appendIntakeHistory(item);
  });

  logicHistory.slice(historyIndex).forEach((item) => {
    timeline.push({ type: "logic", item, key: `logic-${item.id}` });
  });

  return timeline;
}

function ConfirmModal({
  project,
  onConfirm,
  onCancel
}: {
  project: ProjectSummary;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="confirm-modal-overlay" onClick={onCancel}>
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="confirm-modal-title">确认删除么？</h3>
        <p className="confirm-modal-message">
          这会删除「<strong>{project.project_name || "未命名项目"}</strong>」的历史记录和记忆。
        </p>
        <div className="confirm-modal-actions">
          <button className="confirm-modal-cancel" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="confirm-modal-delete" type="button" onClick={onConfirm}>
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

function OpeningPage({ onEnter }: { onEnter: () => void }) {
  const [isExiting, setIsExiting] = useState(false);

  const handleEnter = () => {
    setIsExiting(true);
    setTimeout(onEnter, 600);
  };

  return (
    <div className={`opening-page ${isExiting ? "fade-out" : ""}`}>
      <div className="opening-film-bars top" />
      <div className="opening-film-bars bottom" />
      <div className="opening-grain" />
      <div className="opening-corner tl" />
      <div className="opening-corner tr" />
      <div className="opening-corner bl" />
      <div className="opening-corner br" />
      <div className="opening-content">
        <span className="opening-label">AI Video Production</span>
        <h1 className="opening-title">AI<strong>导演</strong>工作台</h1>
        <p className="opening-subtitle">智能分镜生成 · 宣传片创作助手</p>
        <div className="opening-divider" />
        <button className="opening-enter-btn" type="button" onClick={handleEnter}>
          <span>进入工作台</span>
          <ArrowRight size={16} />
        </button>
      </div>
      <span className="opening-version">v1.0</span>
    </div>
  );
}

function App() {
  const [showOpening, setShowOpening] = useState(true);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [busyProjectId, setBusyProjectId] = useState("");
  const [error, setError] = useState("");
  const [draftMarkdown, setDraftMarkdown] = useState("");
  const [streamingMarkdown, setStreamingMarkdown] = useState("");
  const [rightOpen, setRightOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [recentHistoryOpen, setRecentHistoryOpen] = useState(false);
  const [logicRevision, setLogicRevision] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [uploadingAssetCounts, setUploadingAssetCounts] = useState<Record<string, number>>({});
  const [pendingUploads, setPendingUploads] = useState<ProjectAsset[]>([]);
  const [documentTasks, setDocumentTasks] = useState<Record<string, DocumentTask>>({});
  const [logicTasks, setLogicTasks] = useState<Record<string, LogicTask>>({});
  const [styleTasks, setStyleTasks] = useState<Record<string, LogicTask>>({});
  const [deleteConfirmProject, setDeleteConfirmProject] = useState<ProjectSummary | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const recentHistoryRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<number | null>(null);
  const savedSignature = useRef("");
  const booted = useRef(false);

  const logicMarkdown = activeProject?.selection_state.logicRecommendations || activeProject?.selection_state.intakeSummary || "";
  const logicOptions = useMemo(() => extractLogicOptions(logicMarkdown), [logicMarkdown]);
  const styleMarkdown = activeProject?.selection_state.styleRecommendations || "";
  const styleOptions = useMemo(() => extractStyleOptions(styleMarkdown), [styleMarkdown]);
  const logicHistory = useMemo(() => parseLogicHistory(activeProject), [activeProject?.selection_state.logicRecommendationHistory]);
  const intakeHistory = useMemo(() => parseIntakeHistory(activeProject), [activeProject?.selection_state.intakeSummaryHistory]);
  const selectedLogic = activeProject?.selection_state.selectedLogic || "";
  const selectedWritingStyle = activeProject?.selection_state.selectedWritingStyle || "";
  const activeDocumentTask = activeProject ? documentTasks[activeProject.id] : undefined;
  const activeLogicTask = activeProject ? logicTasks[activeProject.id] : undefined;
  const activeStyleTask = activeProject ? styleTasks[activeProject.id] : undefined;
  const activeBusy = Boolean(busy && activeProject?.id && busyProjectId === activeProject.id);
  const isGeneratingDocument = Boolean(activeDocumentTask);
  const activeDocumentMarkdown = activeProject
    ? activeProject.active_version === "proposal"
      ? activeProject.proposal_markdown
      : activeProject.full_markdown || activeProject.final_markdown
    : "";
  const assistantBusy = activeBusy && !isGeneratingDocument && (
    busy === "正在整理资料并推荐内容逻辑"
    || (busy === "正在重新推荐内容逻辑" && !activeLogicTask)
    || (busy === "正在推荐文风" && !activeStyleTask)
    || (busy === "正在重新推荐文风" && !activeStyleTask)
  );
  const conversationTimeline = useMemo(
    () => buildConversationTimeline(
      activeProject?.messages || [],
      logicHistory,
      intakeHistory,
      activeProject?.selection_state.intakeSummary || "",
      assistantBusy ? busy : "",
      activeProject?.selection_state.activeIntakeRunId || ""
    ),
    [activeProject?.messages, logicHistory, intakeHistory, activeProject?.selection_state.intakeSummary, activeProject?.selection_state.activeIntakeRunId, assistantBusy, busy]
  );
  const logicInputActive = Boolean(logicMarkdown && !selectedLogic);
  const styleInputActive = Boolean(selectedLogic && !selectedWritingStyle && !activeProject?.full_markdown && !isGeneratingDocument && !activeStyleTask);
  const generateInputActive = Boolean(selectedLogic && selectedWritingStyle && !activeProject?.full_markdown && !isGeneratingDocument);
  const recentProjects = projects.slice(0, 10);
  const logicChoiceText = logicOptions.length ? optionLetters.slice(0, logicOptions.length).join("/") : "修改意见";
  const styleChoiceText = styleOptions.length ? optionLetters.slice(0, styleOptions.length).join("/") : "修改意见";
  const generationChoices = activeProject?.proposal_markdown
    ? ["A. 先生成提案版", "B. 直接生成完整版", "C. 由提案版生成完整版"]
    : ["A. 先生成提案版", "B. 直接生成完整版"];
  const hasGeneratedDocument = Boolean(activeProject?.proposal_markdown || activeProject?.full_markdown);
  const composerPlaceholder = logicInputActive
    ? logicOptions.length
      ? `输入 ${logicChoiceText} 确认逻辑，或直接输入修改意见。`
      : "没有解析到可选方案，请直接输入修改意见。"
    : generateInputActive
      ? `输入 ${activeProject?.proposal_markdown ? "A/B/C" : "A/B"} 选择生成方式。`
      : styleInputActive
        ? styleOptions.length
          ? `输入 ${styleChoiceText} 确认文风，或直接输入修改意见。`
          : "没有解析到可选文风，请直接输入修改意见。"
        : hasGeneratedDocument
          ? "输入补充意见后会自动重新生成当前版本，例如：整体 AI 元素再浓一些。"
          : "输入补充想法或修改意见，例如：希望整体更像政府汇报，不要太广告化。";
  const canStart = Boolean(
    activeProject?.meta.project_name.trim()
    && activeProject.meta.client_type.trim()
    && activeProject.meta.video_type.trim()
    && activeProject.meta.duration.trim()
    && activeProject.meta.aspect_ratio.trim()
  );

  const isEmptyState = activeProject && (
    !activeBusy
    && !activeProject.selection_state.intakeSummary
    && !activeProject.messages?.length
    && !activeProject.selection_state.logicRecommendations
    && !activeProject.proposal_markdown
    && !activeProject.full_markdown
  );

  useEffect(() => {
    loadProjects().catch((err) => setError(err instanceof Error ? err.message : "项目加载失败"));
  }, []);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [draftMarkdown, documentTasks, logicTasks, styleTasks, busy, activeProject?.messages?.length, activeProject?.selection_state.intakeSummary, activeProject?.selection_state.intakeSummaryHistory, activeProject?.selection_state.logicRecommendations, activeProject?.selection_state.logicRecommendationHistory, activeProject?.selection_state.styleRecommendations]);

  useEffect(() => {
    if (!activeProject?.id || !activeProject.assets.some((asset) => asset.status === "processing")) return;
    const timer = window.setInterval(async () => {
      try {
        const project = await apiRequest<ProjectState>(`/api/projects/${activeProject.id}`);
        const normalized = normalizeProject(project);
        setActiveProject((current) => mergeProjects(current, normalized));
      } catch {
        // Keep polling quiet; the visible upload/error flows handle user-facing failures.
      }
    }, 1800);
    return () => window.clearInterval(timer);
  }, [activeProject?.id, activeProject?.assets]);

  useEffect(() => {
    if (!activeProject || !booted.current) return;
    const signature = projectSignature(activeProject);
    if (signature === savedSignature.current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveProject(activeProject, false).catch(() => undefined);
    }, 700);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [activeProject]);

  useEffect(() => {
    if (!activeProject) return;
    if (isGeneratingDocument) return;
    const markdown = activeProject.active_version === "proposal"
      ? activeProject.proposal_markdown
      : activeProject.full_markdown || activeProject.final_markdown;
    setDraftMarkdown(markdown || "");
  }, [activeProject?.id, activeProject?.active_version, activeProject?.proposal_markdown, activeProject?.full_markdown, activeProject?.final_markdown, isGeneratingDocument]);

  useEffect(() => {
    if (!leftCollapsed) setRecentHistoryOpen(false);
  }, [leftCollapsed]);

  useEffect(() => {
    if (!recentHistoryOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!recentHistoryRef.current?.contains(event.target as Node)) {
        setRecentHistoryOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [recentHistoryOpen]);

  async function loadProjects(preferredId?: string) {
    setLoading(true);
    const list = await apiRequest<ProjectSummary[]>("/api/projects");
    setProjects(list);
    const nextId = preferredId || activeProject?.id || list[0]?.id;
    if (nextId) {
      const project = await apiRequest<ProjectState>(`/api/projects/${nextId}`);
      const normalized = normalizeProject(project);
      savedSignature.current = projectSignature(normalized);
      setActiveProject(normalized);
    } else {
      setActiveProject(null);
      savedSignature.current = "";
    }
    booted.current = true;
    setLoading(false);
  }

  function normalizeProject(project: ProjectState): ProjectState {
    return {
      ...createEmptyProject(),
      ...project,
      meta: { ...defaultMeta(), ...project.meta },
      content_units: project.content_units?.length ? project.content_units : [{ name: "", selling_points: "", naming: "" }],
      selection_state: project.selection_state || {},
      assets: project.assets || []
    };
  }

  async function saveProject(project: ProjectState, refreshList = true, updateActive = true): Promise<ProjectState> {
    const saved = await apiRequest<ProjectState>("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project })
    });
    const normalized = normalizeProject(saved);
    savedSignature.current = projectSignature(normalized);
    if (updateActive) setActiveProject(normalized);
    if (refreshList) {
      const list = await apiRequest<ProjectSummary[]>("/api/projects");
      setProjects(list);
    }
    return normalized;
  }

  async function createProject() {
    setError("");
    const project = await saveProject(createEmptyProject());
    await loadProjects(project.id);
  }

  async function confirmDeleteProject() {
    if (!deleteConfirmProject) return;
    await apiRequest(`/api/projects/${deleteConfirmProject.id}`, { method: "DELETE" });
    if (activeProject?.id === deleteConfirmProject.id) setActiveProject(null);
    setDeleteConfirmProject(null);
    await loadProjects();
  }

  function patchProject(patch: Partial<ProjectState>) {
    setActiveProject((project) => project ? normalizeProject({ ...project, ...patch, updated_at: nowIso() }) : project);
  }

  function patchMeta(key: keyof ProjectMeta, value: string) {
    setActiveProject((project) => project ? { ...project, meta: { ...project.meta, [key]: value }, updated_at: nowIso() } : project);
  }

  function patchSelection(key: string, value: string) {
    setActiveProject((project) => project ? {
      ...project,
      selection_state: { ...project.selection_state, [key]: value },
      updated_at: nowIso()
    } : project);
  }

  function bumpUploadingAsset(type: AssetType, delta: 1 | -1) {
    setUploadingAssetCounts((current) => {
      const nextCount = Math.max((current[type] || 0) + delta, 0);
      const next = { ...current };
      if (nextCount) next[type] = nextCount;
      else delete next[type];
      return next;
    });
  }

  function createPendingUpload(type: AssetType, file: File): ProjectAsset {
    const now = nowIso();
    return {
      id: `pending-${type}-${file.name}-${file.size}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      filename: file.name,
      original_filename: file.name,
      content_type: file.type,
      asset_type: type,
      size: file.size,
      path: "",
      summary: "正在上传，完成后会自动进入解析。",
      extracted_text: "",
      status: "processing",
      error: "",
      created_at: now,
      updated_at: now
    };
  }

  async function uploadAsset(type: AssetType, files: FileList | null) {
    if (!activeProject || !files?.length) return;
    setError("");
    try {
      const project = activeProject.id ? activeProject : await saveProject(activeProject);
      const selectedFiles = Array.from(files);
      const pendingItems = selectedFiles.map((file) => createPendingUpload(type, file));
      setPendingUploads((current) => [...current, ...pendingItems]);
      const uploadOne = async (file: File, pendingId: string) => {
        bumpUploadingAsset(type, 1);
        const body = new FormData();
        body.append("file", file);
        body.append("asset_type", type);
        try {
          const data = await apiRequest<{ project: ProjectState; asset: ProjectAsset }>(`/api/projects/${project.id}/assets/upload`, {
            method: "POST",
            body
          });
          const normalized = normalizeProject(data.project);
          setPendingUploads((current) => current.filter((asset) => asset.id !== pendingId));
          setActiveProject((current) => mergeProjects(current, normalized));
          return { ok: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : "上传失败";
          setPendingUploads((current) => current.map((asset) => asset.id === pendingId ? {
            ...asset,
            status: "failed",
            error: message,
            summary: `上传失败：${message}`,
            updated_at: nowIso()
          } : asset));
          return { ok: false, message };
        } finally {
          bumpUploadingAsset(type, -1);
        }
      };
      const results = await Promise.all(selectedFiles.map((file, index) => uploadOne(file, pendingItems[index].id)));
      const failures = results.filter((result) => !result.ok);
      if (failures.length) setError(`${failures.length} 个素材上传失败，请检查网络后重试。`);
      const list = await apiRequest<ProjectSummary[]>("/api/projects");
      setProjects(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传失败");
    }
  }

  async function deleteAsset(assetId: string) {
    if (!activeProject) return;
    const project = await apiRequest<ProjectState>(`/api/projects/${activeProject.id}/assets/${assetId}`, { method: "DELETE" });
    setActiveProject(normalizeProject(project));
  }

  async function startIntakeSummary(projectOverride?: ProjectState) {
    const sourceProject = projectOverride || activeProject;
    if (!sourceProject || !canStart) return;
    const shouldAppendRestartMessage = Boolean(
      sourceProject.selection_state.intakeSummary
      || sourceProject.selection_state.logicRecommendations
      || sourceProject.selection_state.selectedLogic
      || sourceProject.selection_state.styleRecommendations
      || sourceProject.proposal_markdown
      || sourceProject.full_markdown
      || sourceProject.final_markdown
    );
    setBusy("正在整理资料并推荐内容逻辑");
    setBusyProjectId(sourceProject.id);
    setError("");
    patchSelection("selectedLogic", "");
    try {
      const intakeRunId = `intake-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const baseProject = shouldAppendRestartMessage ? withArchivedLiveIntake(sourceProject) : sourceProject;
      const restartProject = shouldAppendRestartMessage
        ? appendConversationMessages(
          baseProject,
          "重新整理资料",
          "已收到新的项目材料，我会基于最新资料重新整理资料并推荐内容逻辑。",
          { kind: "intake_restart", runId: intakeRunId }
        )
        : baseProject;
      const saved = await saveProject({
        ...restartProject,
        selection_state: {
          ...restartProject.selection_state,
          activeIntakeRunId: intakeRunId,
          intakeSummary: "",
          logicRecommendations: "",
          selectedLogic: "",
          styleRecommendations: "",
          selectedWritingStyle: "",
          logicRevisionNote: "",
          styleRevisionNote: "",
          generationMode: ""
        },
        proposal_markdown: "",
        full_markdown: "",
        final_markdown: ""
      });
      setBusyProjectId(saved.id);
      let content = "";
      const finalProject = await streamProject("/api/generate/intake-summary/stream", saved, (delta) => {
        content += delta;
        setActiveProject((project) => project?.id === saved.id ? {
          ...project,
          selection_state: { ...project.selection_state, intakeSummary: content, logicRecommendations: content }
        } : project);
      });
      const historyItem: IntakeHistoryItem = {
        id: intakeRunId,
        title: shouldAppendRestartMessage ? "重新整理资料与内容逻辑推荐" : "资料整理与内容逻辑推荐",
        markdown: content,
        created_at: nowIso(),
        runId: intakeRunId
      };
      const finalWithHistory = withAppendedIntakeHistory(normalizeProject({
        ...finalProject,
        selection_state: { ...finalProject.selection_state, activeIntakeRunId: "" }
      }), historyItem);
      setActiveProject((project) => project?.id === saved.id ? finalWithHistory : project);
      await saveProject(finalWithHistory, false, false);
      const list = await apiRequest<ProjectSummary[]>("/api/projects");
      setProjects(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "资料整理失败");
    } finally {
      setBusy("");
      setBusyProjectId("");
    }
  }

  async function startIntakeFromOpeningInput() {
    if (!activeProject || !canStart) return;
    const content = chatInput.trim();
    if (!content) {
      await startIntakeSummary();
      return;
    }

    setChatInput("");
    const nextProject = await saveRevisionMessage(content, "已收到，我会把这条补充意见作为后续资料整理、逻辑推荐或生成文档时的参考。");
    if (!nextProject) return;
    setActiveProject(nextProject);
    await startIntakeSummary(nextProject);
  }

  async function rerunLogicRecommendation(revisionNote = logicRevision, projectOverride?: ProjectState) {
    const sourceProject = projectOverride || activeProject;
    if (!sourceProject) return;
    setBusy("正在重新推荐内容逻辑");
    setBusyProjectId(sourceProject.id);
    setError("");
    try {
      const saved = await saveProject({
        ...sourceProject,
        selection_state: {
          ...sourceProject.selection_state,
          logicRevisionNote: revisionNote,
          selectedLogic: "",
          styleRecommendations: "",
          selectedWritingStyle: ""
        }
      });
      setBusyProjectId(saved.id);
      let content = "";
      const taskId = `logic-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const taskTitle = "正在重新推荐内容逻辑";
      setLogicTasks((current) => ({
        ...current,
        [saved.id]: { id: taskId, title: taskTitle, message: taskTitle, markdown: "" }
      }));
      setActiveProject((project) => project?.id === saved.id ? {
        ...project,
        selection_state: {
          ...project.selection_state,
          selectedLogic: "",
          styleRecommendations: "",
          selectedWritingStyle: ""
        }
      } : project);
      const finalProject = await streamProject("/api/generate/logic-recommendation/stream", saved, (delta) => {
        content += delta;
        setLogicTasks((current) => ({
          ...current,
          [saved.id]: { id: taskId, title: taskTitle, message: taskTitle, markdown: content }
        }));
      });
      const historyItem: LogicHistoryItem = {
        id: taskId,
        title: "重新推荐内容逻辑",
        markdown: content,
        created_at: nowIso()
      };
      const normalizedFinal = normalizeProject({
        ...finalProject,
        selection_state: {
          ...finalProject.selection_state,
          logicRecommendations: content,
          selectedLogic: "",
          styleRecommendations: "",
          selectedWritingStyle: ""
        }
      });
      const finalWithHistory = withAppendedLogicHistory(normalizedFinal, historyItem);
      setActiveProject((project) => project?.id === saved.id ? finalWithHistory : project);
      await saveProject(finalWithHistory, false, false);
      setLogicTasks((current) => {
        const next = { ...current };
        delete next[saved.id];
        return next;
      });
      setLogicRevision("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "重新推荐失败");
      setLogicTasks((current) => {
        const next = { ...current };
        if (sourceProject.id) delete next[sourceProject.id];
        return next;
      });
    } finally {
      setBusy("");
      setBusyProjectId("");
    }
  }

  async function confirmLogic(value: string, userInput?: string) {
    if (!activeProject || !value.trim()) return;
    const confirmedProject: ProjectState = {
      ...activeProject,
      selection_state: {
        ...activeProject.selection_state,
        selectedLogic: value.trim(),
        styleRecommendations: "",
        selectedWritingStyle: ""
      }
    };
    const project = await saveProject(userInput
      ? appendConversationMessages(confirmedProject, userInput, `已确认内容逻辑：${value.trim()}。接下来我会根据这个逻辑推荐文风。`)
      : confirmedProject
    );
    setActiveProject(project);
    await rerunStyleRecommendation("", project);
  }

  async function rerunStyleRecommendation(revisionNote = "", projectOverride?: ProjectState) {
    const sourceProject = projectOverride || activeProject;
    if (!sourceProject?.selection_state.selectedLogic) return;
    setBusy(revisionNote ? "正在重新推荐文风" : "正在推荐文风");
    setBusyProjectId(sourceProject.id);
    setError("");
    try {
      const saved = await saveProject({
        ...sourceProject,
        selection_state: {
          ...sourceProject.selection_state,
          styleRevisionNote: revisionNote,
          selectedWritingStyle: ""
        }
      });
      setBusyProjectId(saved.id);
      let content = "";
      const taskId = `style-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const taskTitle = revisionNote ? "正在重新推荐文风" : "正在推荐文风";
      setStyleTasks((current) => ({
        ...current,
        [saved.id]: { id: taskId, title: taskTitle, message: taskTitle, markdown: "" }
      }));
      setActiveProject((project) => project?.id === saved.id ? {
        ...project,
        selection_state: { ...project.selection_state, selectedWritingStyle: "" }
      } : project);
      const finalProject = await streamProject("/api/generate/style-recommendation/stream", saved, (delta) => {
        content += delta;
        setStyleTasks((current) => ({
          ...current,
          [saved.id]: { id: taskId, title: taskTitle, message: taskTitle, markdown: content }
        }));
      });
      const normalizedFinal = normalizeProject({
        ...finalProject,
        selection_state: {
          ...finalProject.selection_state,
          styleRecommendations: content,
          selectedWritingStyle: ""
        }
      });
      setActiveProject((project) => project?.id === saved.id ? normalizedFinal : project);
      await saveProject(normalizedFinal, false, false);
      setStyleTasks((current) => {
        const next = { ...current };
        delete next[saved.id];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "文风推荐失败");
      setStyleTasks((current) => {
        const next = { ...current };
        if (sourceProject.id) delete next[sourceProject.id];
        return next;
      });
    } finally {
      setBusy("");
      setBusyProjectId("");
    }
  }

  async function confirmWritingStyle(value: string, userInput?: string) {
    if (!activeProject || !value.trim()) return;
    const confirmedProject: ProjectState = {
      ...activeProject,
      selection_state: { ...activeProject.selection_state, selectedWritingStyle: value.trim() }
    };
    const project = await saveProject(userInput
      ? appendConversationMessages(confirmedProject, userInput, `已确认文风：${value.trim()}。请选择生成提案版或完整版。`)
      : confirmedProject
    );
    setActiveProject(project);
  }

  async function generateDocument(mode: GenerationMode, projectOverride?: ProjectState) {
    const sourceProject = projectOverride || activeProject;
    const sourceSelectedLogic = sourceProject?.selection_state.selectedLogic || selectedLogic;
    const sourceSelectedWritingStyle = sourceProject?.selection_state.selectedWritingStyle || selectedWritingStyle;
    if (!sourceProject || !sourceSelectedLogic || !sourceSelectedWritingStyle) return;
    const isProposal = mode === "proposal_first";
    setBusy(isProposal ? "正在生成提案版" : "正在生成完整版");
    setBusyProjectId(sourceProject.id);
    setError("");
    setDraftMarkdown("");
    setStreamingMarkdown("");
    try {
      const saved = await saveProject({
        ...sourceProject,
        active_version: isProposal ? "proposal" : "full",
        selection_state: { ...sourceProject.selection_state, generationMode: mode }
      });
      setBusyProjectId(saved.id);
      setDocumentTasks((current) => ({
        ...current,
        [saved.id]: {
          message: isProposal ? "正在生成提案版" : "正在生成完整版",
          markdown: "",
          version: isProposal ? "proposal" : "full"
        }
      }));
      let content = "";
      const url = isProposal ? "/api/generate/proposal/stream" : "/api/generate/full/stream";
      const finalProject = await streamProject(url, saved, (delta) => {
        content += delta;
        setDraftMarkdown(content);
        setStreamingMarkdown(content);
        setDocumentTasks((current) => ({
          ...current,
          [saved.id]: {
            message: isProposal ? "正在生成提案版" : "正在生成完整版",
            markdown: content,
            version: isProposal ? "proposal" : "full"
          }
        }));
        setActiveProject((project) => project?.id === saved.id ? {
          ...project,
          active_version: isProposal ? "proposal" : "full",
          proposal_markdown: isProposal ? content : project.proposal_markdown,
          full_markdown: isProposal ? project.full_markdown : content,
          final_markdown: isProposal ? project.final_markdown : content
        } : project);
      });
      setActiveProject((project) => project?.id === saved.id ? normalizeProject(finalProject) : project);
      const finalMarkdown = isProposal ? finalProject.proposal_markdown : finalProject.full_markdown;
      setDraftMarkdown(finalMarkdown);
      setStreamingMarkdown("");
      setDocumentTasks((current) => {
        const next = { ...current };
        delete next[saved.id];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败");
      setDocumentTasks((current) => {
        const next = { ...current };
        if (sourceProject.id) delete next[sourceProject.id];
        return next;
      });
    } finally {
      setBusy("");
      setBusyProjectId("");
    }
  }

  async function generateFullAfterProposal() {
    if (!activeProject) return;
    await generateDocument("full_direct");
  }

  async function chooseGenerationPath(choice: string, userInput = choice) {
    if (!activeProject) return;
    if (choice === "A") {
      const nextProject = await saveProject(appendConversationMessages(activeProject, userInput, "已确认，我会先生成提案版。"));
      setActiveProject(nextProject);
      await generateDocument("proposal_first", nextProject);
      return;
    }
    if (choice === "B") {
      const nextProject = await saveProject(appendConversationMessages(activeProject, userInput, "已确认，我会直接生成完整版。"));
      setActiveProject(nextProject);
      await generateDocument("full_direct", nextProject);
      return;
    }
    if (choice === "C" && activeProject.proposal_markdown) {
      const nextProject = await saveProject(appendConversationMessages(activeProject, userInput, "已确认，我会由提案版生成完整版。"));
      setActiveProject(nextProject);
      await generateDocument("full_direct", nextProject);
      return;
    }
    setError(`请输入 ${activeProject.proposal_markdown ? "A、B 或 C" : "A 或 B"} 选择生成方式。`);
  }

  async function exportDocument(version: ExportVersion, kind: "html" | "docx") {
    if (!activeProject) return;
    setBusy(`正在导出 ${kind.toUpperCase()}`);
    setBusyProjectId(activeProject.id);
    setError("");
    try {
      const markdown = version === "proposal" ? activeProject.proposal_markdown : activeProject.full_markdown;
      const data = await apiRequest<ExportResponse>(`/api/export/${version}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: activeProject, markdown, version })
      });
      setActiveProject(normalizeProject(data.project));
      window.open(data.download_url, "_blank");
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setBusy("");
      setBusyProjectId("");
    }
  }

  async function saveRevisionMessage(content: string, assistantReply: string): Promise<ProjectState | null> {
    if (!activeProject) return null;
    const revision = activeProject.steps.revision?.content
      ? `${activeProject.steps.revision.content}\n\n${content}`
      : content;
    return saveProject({
      ...appendConversationMessages(activeProject, content, assistantReply),
      steps: {
        ...activeProject.steps,
        revision: {
          key: "revision",
          title: "用户补充意见",
          content: revision,
          confirmed: true,
          updated_at: nowIso()
        }
      }
    });
  }

  async function sendChatMessage() {
    if (!activeProject || !chatInput.trim()) return;
    const content = chatInput.trim();
    setChatInput("");
    const normalizedChoice = content.toUpperCase();

    if (logicInputActive) {
      const choiceIndex = optionLetters.indexOf(normalizedChoice);
      if (choiceIndex >= 0) {
        const selectedOption = logicOptions[choiceIndex]?.type || "";
        if (!selectedOption) {
          setError(`当前没有 ${normalizedChoice} 选项，请输入可见选项字母或直接写修改意见。`);
          return;
        }
        await confirmLogic(selectedOption, content);
        return;
      }
      setLogicRevision(content);
      const nextProject = await saveRevisionMessage(content, "已收到，我会按这条修改意见重新推荐内容逻辑。");
      if (!nextProject) return;
      await rerunLogicRecommendation(content, nextProject);
      return;
    }

    if (styleInputActive) {
      const choiceIndex = optionLetters.indexOf(normalizedChoice);
      if (choiceIndex >= 0) {
        const selectedOption = styleOptions[choiceIndex]?.type || "";
        if (!selectedOption) {
          setError(`当前没有 ${normalizedChoice} 选项，请输入可见选项字母或直接写修改意见。`);
          return;
        }
        await confirmWritingStyle(selectedOption, content);
        return;
      }
      const nextProject = await saveRevisionMessage(content, "已收到，我会按这条修改意见重新推荐文风。");
      if (!nextProject) return;
      await rerunStyleRecommendation(content, nextProject);
      return;
    }

    if (generateInputActive) {
      await chooseGenerationPath(normalizedChoice, content);
      return;
    }

    if (hasGeneratedDocument) {
      const nextProject = await saveRevisionMessage(content, activeProject.full_markdown ? "已收到，我会按这条补充意见重新生成完整版。" : "已收到，我会按这条补充意见重新生成提案版。");
      if (!nextProject) return;
      await generateDocument(activeProject.full_markdown ? "full_direct" : "proposal_first", nextProject);
      return;
    }

    const nextProject = await saveRevisionMessage(content, "已收到，我会把这条补充意见作为后续资料整理、逻辑推荐或生成文档时的参考。");
    if (nextProject) setActiveProject(nextProject);
  }

  if (showOpening) {
    return <OpeningPage onEnter={() => setShowOpening(false)} />;
  }

    return (
    <div className={`director-app ${leftCollapsed ? "left-collapsed" : ""}`}>
      <aside className={`project-sidebar ${leftOpen ? "open" : ""} ${leftCollapsed ? "collapsed" : ""}`}>
        <div className="sidebar-header">
          <img src="/logo123.png" alt="" className="brand-logo" />
          <button
            className="icon-btn sidebar-toggle desktop-only"
            type="button"
            onClick={() => setLeftCollapsed((current) => !current)}
            aria-label={leftCollapsed ? "展开项目栏" : "折叠项目栏"}
            title={leftCollapsed ? "展开项目栏" : "折叠项目栏"}
          >
            {leftCollapsed ? <PanelRight size={18} /> : <PanelLeft size={18} />}
          </button>
          <button className="icon-btn mobile-only" type="button" onClick={() => setLeftOpen(false)} aria-label="关闭项目栏">
            <X size={18} />
          </button>
        </div>
        <button className="new-project-btn" type="button" onClick={createProject}>
          <FolderPlus size={18} />
          新建项目
        </button>
        <div className="history-title">历史记录</div>
        <div className="history-list">
          {projects.map((project) => (
            <article className={`history-card ${activeProject?.id === project.id ? "active" : ""}`} key={project.id}>
              <button type="button" onClick={() => loadProjects(project.id)}>
                <strong>{project.project_name || "未命名项目"}</strong>
                <span>{project.video_type || "影片"} · {formatTime(project.updated_at)}</span>
              </button>
              <button className="delete-history" type="button" onClick={() => setDeleteConfirmProject(project)} aria-label="删除项目">
                <Trash2 size={15} />
              </button>
            </article>
          ))}
          {!projects.length && <p className="empty-copy">还没有项目，先新建一个。</p>}
        </div>
        <div className="collapsed-sidebar-tools desktop-only" ref={recentHistoryRef}>
          <button
            className={`icon-btn collapsed-chat-trigger ${recentHistoryOpen ? "active" : ""}`}
            type="button"
            onClick={() => setRecentHistoryOpen((current) => !current)}
            aria-label="显示最近历史记录"
            title="显示最近历史记录"
          >
            <MessageCircle size={18} />
          </button>
          {recentHistoryOpen && (
            <div className="collapsed-history-popover">
              <div className="collapsed-history-head">最近历史</div>
              <div className="collapsed-history-list">
                {recentProjects.map((project) => (
                  <button
                    className={`collapsed-history-item ${activeProject?.id === project.id ? "active" : ""}`}
                    key={project.id}
                    type="button"
                    onClick={() => {
                      setRecentHistoryOpen(false);
                      loadProjects(project.id);
                    }}
                  >
                    {project.project_name || "未命名项目"}
                  </button>
                ))}
                {!recentProjects.length && <p className="collapsed-history-empty">还没有历史项目</p>}
              </div>
            </div>
          )}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button
            className="icon-btn sidebar-toggle sidebar-toggle-docked desktop-only"
            type="button"
            onClick={() => setLeftCollapsed((current) => !current)}
            aria-label={leftCollapsed ? "展开项目栏" : "折叠项目栏"}
            title={leftCollapsed ? "展开项目栏" : "折叠项目栏"}
          >
            {leftCollapsed ? <PanelRight size={18} /> : <PanelLeft size={18} />}
          </button>
          <div className="topbar-leading">
            <button className="icon-btn mobile-only" type="button" onClick={() => setLeftOpen(true)} aria-label="打开项目栏">
              <PanelLeft size={20} />
            </button>
          </div>
          <div className="topbar-title">
            <span>AI DIRECTOR WORKBENCH</span>
            <h1>{activeProject?.meta.project_name || "今天想把什么做成分镜？"}</h1>
          </div>
          <div className="topbar-trailing">
            <button className="icon-btn mobile-only" type="button" onClick={() => setRightOpen(true)} aria-label="打开资料栏">
              <PanelRight size={20} />
            </button>
          </div>
        </header>

        <section className="conversation">
          <div className="conversation-column">
          {loading && <div className="center-note">正在加载项目...</div>}
          {!loading && !activeProject && (
            <div className="welcome-empty">
              <div className="welcome-empty-content">
                <h2>AI导演工作台</h2>
                <p>智能分镜生成 · 宣传片创作助手</p>
                <button className="primary start-new-btn" type="button" onClick={createProject}>
                  开始创作
                </button>
              </div>
            </div>
          )}
          {!loading && activeProject && isEmptyState && (
            <div className="chat-empty-state">
              <div className="chat-empty-header">
                <h2>{activeProject.meta.project_name || "新项目"}</h2>
                <p>填写右侧项目信息，开始创作你的分镜脚本</p>
              </div>
              <div className="chat-suggestions">
                <button className="suggestion-btn" type="button" onClick={() => {
                  if (canStart) startIntakeFromOpeningInput();
                }} disabled={!canStart || Boolean(busy)}>
                  <MessageSquareText size={18} />
                  <span>整理资料并推荐内容逻辑</span>
                </button>
              </div>
              <div className="chat-empty-input">
                <ComposerField
                  value={chatInput}
                  disabled={Boolean(busy)}
                  placeholder={canStart ? "输入补充想法或直接点击上方按钮开始..." : "请先在右侧填写项目基础信息..."}
                  onChange={setChatInput}
                  onSend={sendChatMessage}
                />
              </div>
              {!canStart && <p className="empty-hint">请先填写项目名称、客户类型、影片类型、时长、成片比例</p>}
            </div>
          )}
          {!loading && activeProject && !isEmptyState && (
            <>
              <ConversationTimeline items={conversationTimeline} />

              {!assistantBusy && !conversationTimeline.length && !activeProject.selection_state.intakeSummary && (
                <div className="assistant-message">
                  <span>AI导演</span>
                  <p>右侧填写基础信息和素材后，点击"开始整理资料"。系统会一次性返回项目信息汇总、内容单元概览和动态内容逻辑推荐。</p>
                </div>
              )}

              {activeLogicTask && (
                <MarkdownBlock title={activeLogicTask.title} markdown={activeLogicTask.markdown || activeLogicTask.message} busy />
              )}

              {activeStyleTask && (
                <MarkdownBlock title={activeStyleTask.title} markdown={activeStyleTask.markdown || activeStyleTask.message} busy />
              )}

              {logicMarkdown && !activeLogicTask && (
                <section className="logic-panel">
                  <div className="panel-head">
                    <div>
                      <span>内容逻辑确认</span>
                      <h2>{selectedLogic ? "已确认内容逻辑" : "输入选项字母确认，或直接写修改意见"}</h2>
                    </div>
                    {selectedLogic && <strong className="confirmed-pill">{selectedLogic}</strong>}
                  </div>
                  <ol className="choice-list logic-choice-list" aria-label="内容逻辑选项">
                    {logicOptions.map((option, index) => (
                      <li className={selectedLogic === option.type ? "active" : ""} key={option.type}>
                        <button
                          className="choice-option"
                          type="button"
                          onClick={() => confirmLogic(option.type, optionLetters[index])}
                          disabled={Boolean(activeBusy || selectedLogic)}
                        >
                          <strong>{optionLetters[index]}.</strong>
                          <span className="logic-choice-body">
                            <b>{option.type}</b>
                            {option.fit && <em>{option.fit}</em>}
                            {option.description && <small>{option.description}</small>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                  {!logicOptions.length && (
                    <p className="required-tip">暂未解析到可选项，可以继续输入修改意见，我会重新推荐。</p>
                  )}
                </section>
              )}

              {selectedLogic && styleMarkdown && !activeStyleTask && (
                <MarkdownBlock title="文风推荐" markdown={styleMarkdown} />
              )}

              {selectedLogic && styleMarkdown && !activeStyleTask && (
                <section className="logic-panel">
                  <div className="panel-head">
                    <div>
                      <span>文风确认</span>
                      <h2>{selectedWritingStyle ? "已确认文风" : "输入选项字母确认，或直接写修改意见"}</h2>
                    </div>
                    {selectedWritingStyle && <strong className="confirmed-pill">{selectedWritingStyle}</strong>}
                  </div>
                  <ol className="choice-list logic-choice-list" aria-label="文风选项">
                    {styleOptions.map((option, index) => (
                      <li className={selectedWritingStyle === option.type ? "active" : ""} key={option.type}>
                        <button
                          className="choice-option"
                          type="button"
                          onClick={() => confirmWritingStyle(option.type, optionLetters[index])}
                          disabled={Boolean(activeBusy || selectedWritingStyle)}
                        >
                          <strong>{optionLetters[index]}.</strong>
                          <span className="logic-choice-body">
                            <b>{option.type}</b>
                            {option.fit && <em>{option.fit}</em>}
                            {option.description && <small>{option.description}</small>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                  {!styleOptions.length && (
                    <p className="required-tip">暂未解析到可选文风，可以继续输入修改意见，我会重新推荐。</p>
                  )}
                </section>
              )}

              {generateInputActive && (
                <section className="generate-panel">
                  <div className="panel-head">
                    <div>
                      <span>生成路径</span>
                      <h2>在输入框中输入选项字母</h2>
                    </div>
                  </div>
                  <ol className="choice-list generate-choice-list" aria-label="生成路径选项">
                    {generationChoices.map((choice) => (
                      <li key={choice}>
                        <button
                          className="choice-option"
                          type="button"
                          onClick={() => chooseGenerationPath(choice.slice(0, 1))}
                          disabled={Boolean(activeBusy)}
                        >
                          <strong>{choice.slice(0, 2)}</strong>
                          <span>{choice.slice(3)}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {activeDocumentTask && (
                <div className="assistant-message generated-message">
                  <span>AI导演 · {activeDocumentTask.version === "proposal" ? "提案版" : "完整版"}</span>
                  <div
                    className="assistant-stream markdown-body"
                    dangerouslySetInnerHTML={{ __html: markdownToHtml(activeDocumentTask.markdown || activeDocumentTask.message) }}
                  />
                </div>
              )}

              {activeDocumentMarkdown && !isGeneratingDocument && (
                <GeneratedDocument
                  project={activeProject}
                  markdown={activeDocumentMarkdown}
                  onSwitchVersion={(version) => {
                    patchProject({ active_version: version });
                    setDraftMarkdown(version === "proposal" ? activeProject.proposal_markdown : activeProject.full_markdown);
                  }}
                  onExport={exportDocument}
                />
              )}

              <ChatComposer
                value={chatInput}
                disabled={Boolean(activeBusy)}
                placeholder={composerPlaceholder}
                onChange={setChatInput}
                onSend={sendChatMessage}
              />
              <div ref={conversationEndRef} aria-hidden="true" />
            </>
          )}
          </div>
        </section>
      </main>

      <aside className={`brief-panel ${rightOpen ? "open" : ""}`}>
        <div className="brief-head">
          <div>
            <span>PROJECT BRIEF</span>
            <h2>项目信息与素材</h2>
          </div>
          <button className="icon-btn mobile-only" type="button" onClick={() => setRightOpen(false)} aria-label="关闭资料栏">
            <X size={18} />
          </button>
        </div>

        {activeProject ? (
          <ProjectBriefPanel
            project={activeProject}
            canStart={canStart}
            busy={busy}
            uploadingAssetCounts={uploadingAssetCounts}
            pendingUploads={pendingUploads}
            onMetaChange={patchMeta}
            onUnitsChange={(content_units) => patchProject({ content_units })}
            onUpload={uploadAsset}
            onDeleteAsset={deleteAsset}
            onStart={startIntakeSummary}
          />
        ) : (
          <p className="empty-copy">新建或选择项目后开始填写。</p>
        )}
      </aside>

      {busy && !assistantBusy && (
        <div className="busy-toast">
          <Loader2 size={16} className="spin" />
          {busy}
        </div>
      )}
      {error && (
        <button className="error-toast" type="button" onClick={() => setError("")}>
          {error}
        </button>
      )}
      {deleteConfirmProject && (
        <ConfirmModal
          project={deleteConfirmProject}
          onConfirm={confirmDeleteProject}
          onCancel={() => setDeleteConfirmProject(null)}
        />
      )}
    </div>
  );
}

function ConversationTimeline({ items }: { items: TimelineItem[] }) {
  if (!items.length) return null;
  return (
    <section className="dialogue-log" aria-label="对话记录">
      {items.map((entry, index) => {
        if (entry.type === "status") {
          return (
            <div className="assistant-message" key={entry.key}>
              <span>AI导演</span>
              <p>
                <Loader2 size={16} className="spin inline-spin" />
                {entry.text}
              </p>
            </div>
          );
        }
        if (entry.type === "intake") {
          return (
            <MarkdownBlock
              key={entry.key}
              title={entry.title || "资料整理与内容逻辑推荐"}
              markdown={entry.markdown}
              busy={entry.busy}
            />
          );
        }
        if (entry.type === "logic") {
          return (
            <MarkdownBlock
              key={entry.key}
              title={entry.item.title || `重新推荐内容逻辑 ${index + 1}`}
              markdown={entry.item.markdown}
            />
          );
        }
        const { message } = entry;
        return (
          <article className={`dialogue-bubble ${message.role}`} key={entry.key}>
            <span>{message.role === "user" ? "你" : "AI导演"}</span>
            <p>{message.content}</p>
          </article>
        );
      })}
    </section>
  );
}

function ComposerField(props: {
  value: string;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  const { value, disabled, placeholder, onChange, onSend } = props;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 280)}px`;
  }, [value]);

  return (
    <div className="composer-field">
      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!disabled && value.trim()) onSend();
          }
        }}
        placeholder={placeholder}
        rows={1}
      />
      <div className="composer-actions">
        <button className="composer-send-btn primary" type="button" onClick={onSend} disabled={disabled || !value.trim()} aria-label="发送消息">
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}

function ChatComposer(props: {
  value: string;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  const { value, disabled, placeholder, onChange, onSend } = props;
  return (
    <section className="chat-composer" aria-label="项目对话框">
      <ComposerField
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={onChange}
        onSend={onSend}
      />
    </section>
  );
}

function ProjectBriefPanel(props: {
  project: ProjectState;
  canStart: boolean;
  busy: string;
  uploadingAssetCounts: Record<string, number>;
  pendingUploads: ProjectAsset[];
  onMetaChange: (key: keyof ProjectMeta, value: string) => void;
  onUnitsChange: (units: ContentUnit[]) => void;
  onUpload: (type: AssetType, files: FileList | null) => void;
  onDeleteAsset: (assetId: string) => void;
  onStart: () => void;
}) {
  const { project, canStart, busy, uploadingAssetCounts, pendingUploads, onMetaChange, onUnitsChange, onUpload, onDeleteAsset, onStart } = props;
  return (
    <div className="brief-scroll">
      <section className="brief-section">
        <h3>开始前必填</h3>
        <ComboInput label="项目名称" value={project.meta.project_name} presets={["城市管家一体化方案", "企业品牌宣传片", "产品介绍分镜"]} onChange={(value) => onMetaChange("project_name", value)} />
        <ComboInput label="客户类型" value={project.meta.client_type} presets={fieldPresets.client_type} onChange={(value) => onMetaChange("client_type", value)} />
        <ComboInput label="影片类型" value={project.meta.video_type} presets={fieldPresets.video_type} onChange={(value) => onMetaChange("video_type", value)} />
        <ComboInput label="时长" value={project.meta.duration} presets={fieldPresets.duration} onChange={(value) => onMetaChange("duration", value)} />
        <ComboInput label="风格基调（选填）" value={project.meta.style} presets={fieldPresets.style} onChange={(value) => onMetaChange("style", value)} />
        <ComboInput label="成片比例" value={project.meta.aspect_ratio} presets={fieldPresets.aspect_ratio} onChange={(value) => onMetaChange("aspect_ratio", value)} />
      </section>

      <section className="brief-section">
        <h3>上传素材</h3>
        {assetConfigs.map((config) => (
          <AssetUploader
            key={config.type}
            config={config}
            assets={[
              ...project.assets.filter((asset) => asset.asset_type === config.type),
              ...pendingUploads.filter((asset) => asset.asset_type === config.type)
            ]}
            uploadingCount={uploadingAssetCounts[config.type] || 0}
            onUpload={onUpload}
            onDelete={onDeleteAsset}
          />
        ))}
      </section>

      <section className="brief-section">
        <h3>补充内容单元：（选填）</h3>
        <ContentUnitEditor units={project.content_units} onChange={onUnitsChange} />
      </section>

      <button className="start-btn" type="button" onClick={() => onStart()} disabled={!canStart || Boolean(busy)}>
        <MessageSquareText size={18} />
        开始整理资料
      </button>
      {!canStart && <p className="required-tip">请先补齐项目名称、客户类型、影片类型、时长、成片比例。</p>}
    </div>
  );
}

function ComboInput({ label, value, presets, onChange }: { label: string; value: string; presets: string[]; onChange: (value: string) => void }) {
  const id = `preset-${label}`;
  return (
    <label className="field">
      <span>{label}</span>
      <input list={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder={`选择或输入${label}`} />
      <datalist id={id}>
        {presets.map((preset) => <option value={preset} key={preset} />)}
      </datalist>
    </label>
  );
}

function AssetUploader(props: {
  config: { type: AssetType; title: string; hint: string; accept: string; optional?: boolean };
  assets: ProjectAsset[];
  uploadingCount: number;
  onUpload: (type: AssetType, files: FileList | null) => void;
  onDelete: (assetId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [expandedAssetIds, setExpandedAssetIds] = useState<Record<string, boolean>>({});
  const { config, assets, uploadingCount, onUpload, onDelete } = props;
  return (
    <article className="asset-box">
      <div className="asset-box-head">
        <div>
          <strong>{config.title}</strong>
          <span>{config.hint}</span>
        </div>
        <button type="button" onClick={() => inputRef.current?.click()}>
          <UploadCloud size={15} />
          上传
        </button>
        <input ref={inputRef} type="file" multiple accept={config.accept} hidden onChange={(event) => {
          onUpload(config.type, event.target.files);
          event.target.value = "";
        }} />
      </div>
      <div className="asset-list">
        {uploadingCount > 0 && !assets.some((asset) => asset.id.startsWith("pending-") && asset.status === "processing") && (
          <div className="asset-row asset-row-loading">
            <div>
              <strong>正在上传 {uploadingCount} 个素材</strong>
              <small><Loader2 size={13} className="spin" /> 上传完成后会自动进入解析，解析结果会在这里更新。</small>
            </div>
          </div>
        )}
        {assets.map((asset) => (
          <div className="asset-row" key={asset.id}>
            <div>
              <strong>{asset.original_filename}</strong>
              <small>
                {asset.status === "ready" ? "已解析" : asset.status === "failed" ? "解析失败" : "解析中"} · {formatSize(asset.size)}
                {asset.status === "processing" && <Loader2 size={13} className="spin" />}
              </small>
              {expandedAssetIds[asset.id] && <p>{asset.summary || asset.error || "等待解析摘要。"}</p>}
            </div>
            <div className="asset-row-actions">
              <button type="button" onClick={() => setExpandedAssetIds((current) => ({ ...current, [asset.id]: !current[asset.id] }))}>
                {expandedAssetIds[asset.id] ? "收起" : "展开"}
              </button>
              <button className="ghost-danger" type="button" onClick={() => onDelete(asset.id)} aria-label="删除素材">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
        {!assets.length && <p className="asset-empty">{config.optional ? "可留空。" : "还没有上传。"}</p>}
      </div>
    </article>
  );
}

function ContentUnitEditor({ units, onChange }: { units: ContentUnit[]; onChange: (units: ContentUnit[]) => void }) {
  const firstUnit = units[0] || { name: "", selling_points: "", naming: "" };
  const value = firstUnit.selling_points || [firstUnit.name, firstUnit.naming].filter(Boolean).join("\n");
  return (
    <div className="unit-editor">
      <textarea
        value={value}
        onChange={(event) => onChange([{ name: "", selling_points: event.target.value, naming: "" }])}
        placeholder="可补充本片必须出现的产品、场景、人物、业务模块、核心卖点或表达禁忌。没有也可以留空。"
      />
    </div>
  );
}

function MarkdownBlock({ title, markdown, busy = false }: { title: string; markdown: string; busy?: boolean }) {
  return (
    <section className="markdown-card">
      <div className="panel-head">
        <div>
          <span>AI导演</span>
          <h2>{title}</h2>
        </div>
        {busy && (
          <span className="inline-status">
            <Loader2 size={14} className="spin" />
            生成中
          </span>
        )}
      </div>
      <div className="markdown-body" dangerouslySetInnerHTML={{ __html: markdownToHtml(markdown) }} />
    </section>
  );
}

function GeneratedDocument(props: {
  project: ProjectState;
  markdown: string;
  onSwitchVersion: (version: ExportVersion) => void;
  onExport: (version: ExportVersion, kind: "html" | "docx") => void;
}) {
  const { project, markdown, onSwitchVersion, onExport } = props;
  const version = project.active_version;
  return (
    <section className="generated-document">
      <div className="document-actions">
        <div className="tabs">
          <button className={version === "proposal" ? "active" : ""} type="button" onClick={() => onSwitchVersion("proposal")} disabled={!project.proposal_markdown}>提案版</button>
          <button className={version === "full" ? "active" : ""} type="button" onClick={() => onSwitchVersion("full")} disabled={!project.full_markdown}>完整版</button>
        </div>
      </div>
      <div className="assistant-message generated-message">
        <span>AI导演 · {version === "proposal" ? "提案版" : "完整版"}</span>
        <div className="assistant-stream markdown-body" dangerouslySetInnerHTML={{ __html: markdownToHtml(markdown) }} />
      </div>
      <div className="document-actions document-actions-bottom">
        <div className="export-actions">
          <button type="button" onClick={() => onExport(version, "html")}>导出 HTML</button>
          <button type="button" onClick={() => onExport(version, "docx")}>导出 Word</button>
        </div>
      </div>
    </section>
  );
}

const rootElement = document.getElementById("root")!;
const rootHost = rootElement as HTMLElement & { __directorRoot?: ReturnType<typeof createRoot> };
const root = rootHost.__directorRoot ?? createRoot(rootElement);
rootHost.__directorRoot = root;

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
