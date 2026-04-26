import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  FolderPlus,
  Loader2,
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
};

type LogicOption = {
  type: string;
  fit: string;
  description: string;
};

const nowIso = () => new Date().toISOString().slice(0, 19);
const optionLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const genericLogicTitles = new Set(["内容逻辑推荐", "动态内容逻辑推荐", "内容逻辑", "逻辑推荐", "叙事逻辑推荐"]);
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
  { type: "company_intro", title: "公司介绍", hint: "PDF / Word / 图片", accept: ".pdf,.docx,.png,.jpg,.jpeg,.webp" },
  { type: "reference", title: "视频参考素材", hint: "视频 / PDF / 图片", accept: ".mp4,.mov,.webm,.m4v,.pdf,.png,.jpg,.jpeg,.webp" },
  { type: "content_unit", title: "内容单元素材", hint: "产品、场景、业务资料", accept: ".pdf,.docx,.png,.jpg,.jpeg,.webp,.mp4,.mov,.webm,.m4v" },
  { type: "brand", title: "品牌资产（可选）", hint: "Logo / VI / 旧物料", accept: ".pdf,.docx,.png,.jpg,.jpeg,.webp", optional: true }
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

function formatTime(value: string): string {
  if (!value) return "";
  return value.replace("T", " ").slice(0, 16);
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

function App() {
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
  const [logicRevision, setLogicRevision] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [uploadingAssetCounts, setUploadingAssetCounts] = useState<Record<string, number>>({});
  const [pendingUploads, setPendingUploads] = useState<ProjectAsset[]>([]);
  const [documentTasks, setDocumentTasks] = useState<Record<string, DocumentTask>>({});
  const [logicTasks, setLogicTasks] = useState<Record<string, LogicTask>>({});
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<number | null>(null);
  const savedSignature = useRef("");
  const booted = useRef(false);

  const logicMarkdown = activeProject?.selection_state.logicRecommendations || activeProject?.selection_state.intakeSummary || "";
  const logicOptions = useMemo(() => extractLogicOptions(logicMarkdown), [logicMarkdown]);
  const logicHistory = useMemo(() => parseLogicHistory(activeProject), [activeProject?.selection_state.logicRecommendationHistory]);
  const selectedLogic = activeProject?.selection_state.selectedLogic || "";
  const activeDocumentTask = activeProject ? documentTasks[activeProject.id] : undefined;
  const activeLogicTask = activeProject ? logicTasks[activeProject.id] : undefined;
  const latestLogicHistory = !activeLogicTask && logicHistory.length ? logicHistory[logicHistory.length - 1] : undefined;
  const logicHistoryBeforeMessages = activeLogicTask ? logicHistory : logicHistory.slice(0, -1);
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
  );
  const logicInputActive = Boolean(logicMarkdown && !selectedLogic);
  const generateInputActive = Boolean(selectedLogic && !activeProject?.full_markdown && !isGeneratingDocument);
  const logicChoiceText = logicOptions.length ? optionLetters.slice(0, logicOptions.length).join("/") : "修改意见";
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
      : hasGeneratedDocument
        ? "输入补充意见后会自动重新生成当前版本，例如：整体 AI 元素再浓一些。"
        : "输入补充想法或修改意见，例如：希望整体更像政府汇报，不要太广告化。";
  const canStart = Boolean(
    activeProject?.meta.project_name.trim()
    && activeProject.meta.client_type.trim()
    && activeProject.meta.video_type.trim()
    && activeProject.meta.duration.trim()
    && activeProject.meta.style.trim()
    && activeProject.meta.aspect_ratio.trim()
  );

  useEffect(() => {
    loadProjects().catch((err) => setError(err instanceof Error ? err.message : "项目加载失败"));
  }, []);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [draftMarkdown, documentTasks, logicTasks, busy, activeProject?.messages?.length, activeProject?.selection_state.intakeSummary, activeProject?.selection_state.logicRecommendations, activeProject?.selection_state.logicRecommendationHistory]);

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

  async function deleteProject(id: string) {
    if (!window.confirm("确定删除这个项目吗？")) return;
    await apiRequest(`/api/projects/${id}`, { method: "DELETE" });
    if (activeProject?.id === id) setActiveProject(null);
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

  async function startIntakeSummary() {
    if (!activeProject || !canStart) return;
    setBusy("正在整理资料并推荐内容逻辑");
    setBusyProjectId(activeProject.id);
    setError("");
    patchSelection("selectedLogic", "");
    try {
      const saved = await saveProject({ ...activeProject, selection_state: { ...activeProject.selection_state, selectedLogic: "" } });
      setBusyProjectId(saved.id);
      let content = "";
      const finalProject = await streamProject("/api/generate/intake-summary/stream", saved, (delta) => {
        content += delta;
        setActiveProject((project) => project?.id === saved.id ? {
          ...project,
          selection_state: { ...project.selection_state, intakeSummary: content, logicRecommendations: content }
        } : project);
      });
      setActiveProject((project) => project?.id === saved.id ? normalizeProject(finalProject) : project);
      const list = await apiRequest<ProjectSummary[]>("/api/projects");
      setProjects(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "资料整理失败");
    } finally {
      setBusy("");
      setBusyProjectId("");
    }
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
          selectedLogic: ""
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
        selection_state: { ...project.selection_state, selectedLogic: "" }
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
          selectedLogic: ""
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

  async function confirmLogic(value: string) {
    if (!activeProject || !value.trim()) return;
    const project = await saveProject({
      ...activeProject,
      selection_state: { ...activeProject.selection_state, selectedLogic: value.trim() }
    });
    setActiveProject(project);
  }

  async function generateDocument(mode: GenerationMode, projectOverride?: ProjectState) {
    const sourceProject = projectOverride || activeProject;
    const sourceSelectedLogic = sourceProject?.selection_state.selectedLogic || selectedLogic;
    if (!sourceProject || !sourceSelectedLogic) return;
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
      ...activeProject,
      messages: [
        ...(activeProject.messages || []),
        { role: "user", content },
        { role: "assistant", content: assistantReply }
      ],
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
        await confirmLogic(selectedOption);
        return;
      }
      setLogicRevision(content);
      const nextProject = await saveRevisionMessage(content, "已收到，我会按这条修改意见重新推荐内容逻辑。");
      if (!nextProject) return;
      await rerunLogicRecommendation(content, nextProject);
      return;
    }

    if (generateInputActive) {
      if (normalizedChoice === "A") {
        await generateDocument("proposal_first");
        return;
      }
      if (normalizedChoice === "B") {
        await generateDocument("full_direct");
        return;
      }
      if (normalizedChoice === "C" && activeProject.proposal_markdown) {
        await generateFullAfterProposal();
        return;
      }
      setError(`请输入 ${activeProject.proposal_markdown ? "A、B 或 C" : "A 或 B"} 选择生成方式。`);
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

  return (
    <div className="director-app">
      <aside className={`project-sidebar ${leftOpen ? "open" : ""}`}>
        <div className="brand-row">
          <strong>AI导演工作台</strong>
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
              <button className="delete-history" type="button" onClick={() => deleteProject(project.id)} aria-label="删除项目">
                <Trash2 size={15} />
              </button>
            </article>
          ))}
          {!projects.length && <p className="empty-copy">还没有项目，先新建一个。</p>}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button className="icon-btn mobile-only" type="button" onClick={() => setLeftOpen(true)} aria-label="打开项目栏">
            <PanelLeft size={20} />
          </button>
          <div>
            <span>AI DIRECTOR WORKBENCH</span>
            <h1>{activeProject?.meta.project_name || "今天想把什么做成分镜？"}</h1>
          </div>
          <button className="icon-btn mobile-only" type="button" onClick={() => setRightOpen(true)} aria-label="打开资料栏">
            <PanelRight size={20} />
          </button>
        </header>

        <section className="conversation">
          <div className="conversation-column">
          {loading && <div className="center-note">正在加载项目...</div>}
          {!loading && !activeProject && (
            <div className="welcome-card">
              <p>先新建项目，然后在右侧填资料、上传素材。我会先汇总信息，再推荐内容逻辑。</p>
              <button className="primary" type="button" onClick={createProject}>新建项目</button>
            </div>
          )}
          {activeProject && (
            <>
              <div className="assistant-message">
                <span>AI导演</span>
                <p>
                  {assistantBusy && <Loader2 size={16} className="spin inline-spin" />}
                  {assistantBusy ? busy : "右侧填写基础信息和素材后，点击“开始整理资料”。系统会一次性返回项目信息汇总、内容单元概览和动态内容逻辑推荐。"}
                </p>
              </div>

              {activeProject.selection_state.intakeSummary && (
                <MarkdownBlock title="资料整理与内容逻辑推荐" markdown={activeProject.selection_state.intakeSummary} />
              )}

              {logicHistoryBeforeMessages.map((item, index) => (
                <MarkdownBlock
                  key={item.id}
                  title={`${item.title || "重新推荐内容逻辑"} ${index + 1}`}
                  markdown={item.markdown}
                />
              ))}

              <MessageList messages={activeProject.messages || []} />

              {latestLogicHistory && (
                <MarkdownBlock
                  title={latestLogicHistory.title || "重新推荐内容逻辑"}
                  markdown={latestLogicHistory.markdown}
                />
              )}

              {activeLogicTask && (
                <MarkdownBlock title={activeLogicTask.title} markdown={activeLogicTask.markdown || activeLogicTask.message} busy />
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
                  <ol className="choice-list" aria-label="内容逻辑选项">
                    {logicOptions.map((option, index) => (
                      <li className={selectedLogic === option.type ? "active" : ""} key={option.type}>
                        <strong>{optionLetters[index]}.</strong>
                        <span className="logic-choice-body">
                          <b>{option.type}</b>
                          {option.fit && <em>{option.fit}</em>}
                          {option.description && <small>{option.description}</small>}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {!logicOptions.length && (
                    <p className="required-tip">暂未解析到可选项，可以继续输入修改意见，我会重新推荐。</p>
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
                        <strong>{choice.slice(0, 2)}</strong>
                        <span>{choice.slice(3)}</span>
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
    </div>
  );
}

function MessageList({ messages }: { messages: ChatMessage[] }) {
  if (!messages.length) return null;
  return (
    <section className="dialogue-log" aria-label="对话记录">
      {messages.map((message, index) => (
        <article className={`dialogue-bubble ${message.role}`} key={`${message.role}-${index}`}>
          <span>{message.role === "user" ? "你" : "AI导演"}</span>
          <p>{message.content}</p>
        </article>
      ))}
    </section>
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
      <textarea
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") onSend();
        }}
        placeholder={placeholder}
      />
      <button className="primary" type="button" onClick={onSend} disabled={disabled || !value.trim()}>
        <Send size={16} />
        发送
      </button>
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
        <ComboInput label="风格基调" value={project.meta.style} presets={fieldPresets.style} onChange={(value) => onMetaChange("style", value)} />
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

      <button className="start-btn" type="button" onClick={onStart} disabled={!canStart || Boolean(busy)}>
        <MessageSquareText size={18} />
        开始整理资料
      </button>
      {!canStart && <p className="required-tip">请先补齐项目名称、客户类型、影片类型、时长、风格基调、成片比例。</p>}
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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
