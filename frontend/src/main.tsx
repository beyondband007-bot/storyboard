import "./styles.css";

// Use the last known-good compiled app bundle while source is being recovered.
// @ts-ignore Load prebuilt runtime bundle.
import "./runtime-bundle.js";

type SidebarUser = {
  name: string;
  email: string;
  avatarText: string;
};

type UiTheme = "light" | "tech";
type ProjectSummary = { id: string; project_name: string; video_type: string; updated_at: string };
type ProjectAsset = {
  id: string;
  filename: string;
  original_filename: string;
  content_type: string;
  asset_type: "reference" | "brand" | "other";
  size: number;
  summary: string;
  status: "uploaded" | "processing" | "ready" | "failed";
  error: string;
};

const sidebarUser: SidebarUser = {
  name: "DaFei",
  email: "dafei@example.com",
  avatarText: "DA"
};

const statusToastTimers = new WeakMap<HTMLElement, number>();
const themeStorageKey = "storyboard_ui_theme";
const assetTypeLabels: Record<string, string> = {
  reference: "参考样片",
  brand: "品牌资产",
  other: "其他补充材料"
};

function readPreferredTheme(): UiTheme {
  try {
    const saved = window.localStorage.getItem(themeStorageKey);
    if (saved === "light" || saved === "tech") return saved;
  } catch {
    // Ignore localStorage read failures.
  }
  return "light";
}

let activeTheme: UiTheme = readPreferredTheme();
document.documentElement.setAttribute("data-theme", activeTheme);

function syncThemeButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".theme-switch-btn").forEach((button) => {
    const isActive = button.dataset.theme === activeTheme;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function applyTheme(theme: UiTheme): void {
  activeTheme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(themeStorageKey, theme);
  } catch {
    // Ignore localStorage write failures.
  }
  syncThemeButtons();
}

function createThemeSwitcher(): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "theme-switch";
  wrapper.setAttribute("role", "group");
  wrapper.setAttribute("aria-label", "风格切换");
  wrapper.innerHTML = `
    <button class="theme-switch-btn" type="button" data-theme="light" aria-pressed="false">白色版</button>
    <button class="theme-switch-btn" type="button" data-theme="tech" aria-pressed="false">科技感</button>
  `;

  wrapper.querySelectorAll<HTMLButtonElement>(".theme-switch-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const theme: UiTheme = button.dataset.theme === "tech" ? "tech" : "light";
      applyTheme(theme);
    });
  });
  return wrapper;
}

function ensureThemeSwitcher(): void {
  document.querySelectorAll<HTMLElement>(".chat-header .header-actions").forEach((actions) => {
    if (!actions.querySelector(".theme-switch")) {
      const switcher = createThemeSwitcher();
      if (actions.firstChild) {
        actions.insertBefore(switcher, actions.firstChild);
      } else {
        actions.appendChild(switcher);
      }
    }
  });
  syncThemeButtons();
}

function ensureHeaderCopy(): void {
  document.querySelectorAll<HTMLElement>(".chat-header").forEach((header) => {
    header.querySelectorAll<HTMLElement>(".pill.ok, .pill.warn").forEach((pill) => {
      if ((pill.textContent || "").includes("模型")) pill.remove();
    });

    const subtitle = Array.from(header.querySelectorAll<HTMLParagraphElement>("p"))
      .find((node) => (node.textContent || "").includes("Codex 对话"));
    if (subtitle) {
      subtitle.textContent = "把想法聊清楚，再让 AI 导演一次成片。";
    }
  });
}

function initThemeSwitcher(): void {
  const globalFlag = "__storyboardThemeSwitcherInitialized";
  const state = window as unknown as Record<string, unknown>;
  if (state[globalFlag]) return;
  state[globalFlag] = true;

  applyTheme(activeTheme);
  ensureThemeSwitcher();
  ensureHeaderCopy();

  const observer = new MutationObserver(() => {
    ensureThemeSwitcher();
    ensureHeaderCopy();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function closeAllSidebarUserMenus(): void {
  document.querySelectorAll<HTMLElement>(".sidebar-user.open").forEach((node) => {
    node.classList.remove("open");
    const trigger = node.querySelector<HTMLButtonElement>(".sidebar-user-more");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  });
}

function createSidebarUserCard(user: SidebarUser): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "sidebar-user";
  wrapper.innerHTML = `
    <div class="sidebar-user-main">
      <span class="sidebar-user-avatar" aria-hidden="true">${user.avatarText}</span>
      <div class="sidebar-user-meta">
        <strong class="sidebar-user-name">${user.name}</strong>
        <span class="sidebar-user-email">${user.email}</span>
      </div>
    </div>
    <button class="sidebar-user-more" type="button" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">⋯</button>
    <div class="sidebar-user-menu" role="menu" aria-label="用户菜单">
      <button type="button" class="sidebar-user-menu-item" data-action="profile" role="menuitem">
        <span class="sidebar-user-menu-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M20 21a8 8 0 0 0-16 0"></path>
            <circle cx="12" cy="8" r="4"></circle>
          </svg>
        </span>
        <span>个人资料</span>
      </button>
      <button type="button" class="sidebar-user-menu-item danger" data-action="logout" role="menuitem">
        <span class="sidebar-user-menu-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
            <path d="M16 17l5-5-5-5"></path>
            <path d="M21 12H9"></path>
          </svg>
        </span>
        <span>退出登录</span>
      </button>
    </div>
  `;

  const moreButton = wrapper.querySelector<HTMLButtonElement>(".sidebar-user-more");
  if (moreButton) {
    moreButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const shouldOpen = !wrapper.classList.contains("open");
      closeAllSidebarUserMenus();
      if (shouldOpen) {
        wrapper.classList.add("open");
        moreButton.setAttribute("aria-expanded", "true");
      }
    });
  }

  wrapper.querySelectorAll<HTMLButtonElement>(".sidebar-user-menu-item").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      closeAllSidebarUserMenus();
      if (action === "profile") {
        window.alert("个人资料功能即将上线");
      } else if (action === "logout") {
        window.alert("已退出登录");
      }
    });
  });

  wrapper.addEventListener("click", (event) => event.stopPropagation());
  return wrapper;
}

function ensureSidebarUserSection(): void {
  document.querySelectorAll<HTMLElement>(".sidebar").forEach((sidebar) => {
    if (sidebar.querySelector(".sidebar-user")) return;
    sidebar.appendChild(createSidebarUserCard(sidebarUser));
  });
}

function initSidebarUserSection(): void {
  const globalFlag = "__storyboardSidebarUserInitialized";
  const state = window as unknown as Record<string, unknown>;
  if (state[globalFlag]) return;
  state[globalFlag] = true;

  ensureSidebarUserSection();

  document.addEventListener("click", () => closeAllSidebarUserMenus());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAllSidebarUserMenus();
  });

  const observer = new MutationObserver(() => ensureSidebarUserSection());
  observer.observe(document.body, { childList: true, subtree: true });
}

function getStatusToast(node: HTMLElement): HTMLElement | null {
  const nearestChatMain = node.closest<HTMLElement>(".chat-main");
  const fallbackChatMain = document.querySelector<HTMLElement>(".chat-main");
  const host = nearestChatMain || fallbackChatMain;
  if (!host) return null;

  let toast = host.querySelector<HTMLElement>(".status-toast");
  if (!toast) {
    toast = document.createElement("p");
    toast.className = "status-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    host.appendChild(toast);
  }
  return toast;
}

function showStatusToast(node: HTMLElement): void {
  const message = (node.textContent?.trim() || "").replace(/[。.]+$/u, "");
  if (!message) return;

  const toast = getStatusToast(node);
  if (!toast) return;
  toast.textContent = message;

  toast.classList.remove("toast-active", "toast-animate");
  // Force reflow so the animation can replay for identical messages.
  void toast.offsetWidth;
  toast.classList.add("toast-active", "toast-animate");

  const existingTimer = statusToastTimers.get(toast);
  if (existingTimer) window.clearTimeout(existingTimer);

  const timer = window.setTimeout(() => {
    toast.classList.remove("toast-active", "toast-animate");
  }, 2000);
  statusToastTimers.set(toast, timer);
}

function bindStatusLineToast(node: HTMLElement): void {
  if (node.dataset.toastBound === "1") return;
  node.dataset.toastBound = "1";

  const observer = new MutationObserver(() => showStatusToast(node));
  observer.observe(node, { childList: true, characterData: true, subtree: true });
}

function ensureStatusLineToast(): void {
  document.querySelectorAll<HTMLElement>(".status-line").forEach((node) => bindStatusLineToast(node));
}

function initStatusLineToast(): void {
  const globalFlag = "__storyboardStatusToastInitialized";
  const state = window as unknown as Record<string, unknown>;
  if (state[globalFlag]) return;
  state[globalFlag] = true;

  ensureStatusLineToast();

  const observer = new MutationObserver(() => ensureStatusLineToast());
  observer.observe(document.body, { childList: true, subtree: true });
}

async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(data.detail || response.statusText);
  }
  return response.json();
}

async function getCurrentProjectId(): Promise<string | null> {
  const projects = await apiRequest<ProjectSummary[]>("/api/projects");
  if (!projects.length) return null;

  const active = document.querySelector<HTMLElement>(".history-row.active");
  const activeTitle = active?.querySelector("span")?.textContent?.trim();
  const activeMeta = active?.querySelector("small")?.textContent?.trim();
  if (activeTitle) {
    const matched = projects.find((project) => {
      const titleMatches = (project.project_name || "未命名项目") === activeTitle;
      const metaMatches = activeMeta ? activeMeta.includes(project.video_type) && activeMeta.includes(project.updated_at.replace("T", " ")) : true;
      return titleMatches && metaMatches;
    });
    if (matched) return matched.id;
  }

  return projects[0].id;
}

function formatAssetSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function shortText(value: string, max = 180): string {
  const text = (value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function renderAssetList(panel: HTMLElement, assets: ProjectAsset[]): void {
  const list = panel.querySelector<HTMLElement>(".asset-upload-list");
  if (!list) return;
  if (!assets.length) {
    list.innerHTML = `<p class="asset-empty">还没有上传素材。支持 PDF、图片、视频。</p>`;
    return;
  }
  list.innerHTML = assets.map((asset) => `
    <article class="asset-item" data-asset-id="${asset.id}">
      <div class="asset-item-head">
        <strong>${asset.original_filename}</strong>
        <button type="button" class="asset-delete" data-asset-id="${asset.id}">删除</button>
      </div>
      <small>${assetTypeLabels[asset.asset_type] || "其他补充材料"} · ${asset.status === "ready" ? "已解析" : asset.status === "failed" ? "解析失败" : "解析中"} · ${formatAssetSize(asset.size)}</small>
      <p>${shortText(asset.summary || asset.error || "素材已上传，等待解析。")}</p>
    </article>
  `).join("");
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
  descriptor?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

function syncAssetSummaryToTextarea(panel: HTMLElement, assets: ProjectAsset[]): void {
  const type = panel.dataset.assetType;
  if (type !== "reference" && type !== "brand") return;

  const textarea = panel.closest("label")?.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) return;

  const oldPrefix = type === "reference" ? "已上传参考样片：" : "已上传品牌资产：";
  const summaryPrefix = type === "reference" ? "参考样片摘要：" : "品牌资产摘要：";
  const failedPrefix = type === "reference" ? "参考样片解析失败：" : "品牌资产解析失败：";
  const processingText = type === "reference" ? "参考样片解析中，完成后会用于后续生成。" : "品牌资产解析中，完成后会用于后续生成。";
  const manualLines = textarea.value
    .split("\n")
    .filter((line) => {
      const text = line.trim();
      return text
        && !text.startsWith(oldPrefix)
        && !text.startsWith(summaryPrefix)
        && !text.startsWith(failedPrefix)
        && text !== processingText;
    });

  const uploadedLines = assets.map((asset) => {
    if (asset.status === "ready" && asset.summary) return `${summaryPrefix}${shortText(asset.summary, 420)}`;
    if (asset.status === "failed") return `${failedPrefix}${shortText(asset.error || asset.summary || "模型未能解析该素材。", 220)}`;
    return processingText;
  });
  const nextValue = [...manualLines, ...uploadedLines].join("\n");
  if (textarea.value !== nextValue) setNativeTextareaValue(textarea, nextValue);
}

async function refreshAssetPanel(panel: HTMLElement, projectId?: string | null): Promise<void> {
  const status = panel.querySelector<HTMLElement>(".asset-upload-status");
  const id = projectId || await getCurrentProjectId();
  panel.dataset.projectId = id || "";
  if (!id) {
    if (status) status.textContent = "请先完成前面的项目信息，再上传素材。";
    renderAssetList(panel, []);
    return;
  }
  const assets = await apiRequest<ProjectAsset[]>(`/api/projects/${id}/assets`);
  const panelType = panel.dataset.assetType;
  const visibleAssets = panelType ? assets.filter((asset) => asset.asset_type === panelType) : assets;
  renderAssetList(panel, visibleAssets);
  syncAssetSummaryToTextarea(panel, visibleAssets);
  if (status) status.textContent = visibleAssets.length ? `已上传 ${visibleAssets.length} 个素材，摘要会自动进入后续生成。` : "没有可留空。";
}

async function uploadFiles(panel: HTMLElement, files: FileList | File[]): Promise<void> {
  const status = panel.querySelector<HTMLElement>(".asset-upload-status");
  const typeSelect = panel.querySelector<HTMLSelectElement>(".asset-type-select");
  const projectId = await getCurrentProjectId();
  if (!projectId) {
    if (status) status.textContent = "请先完成前面的项目信息，再上传素材。";
    return;
  }
  const fileArray = Array.from(files);
  for (const file of fileArray) {
    const accept = panel.querySelector<HTMLInputElement>(".asset-file-input")?.accept || "";
    const suffix = `.${file.name.split(".").pop()?.toLowerCase() || ""}`;
    if (accept && !accept.split(",").map((item) => item.trim().toLowerCase()).includes(suffix)) {
      if (status) status.textContent = `文件类型不匹配：${file.name}`;
      continue;
    }
    if (status) status.textContent = `正在上传并解析：${file.name}`;
    const body = new FormData();
    body.append("file", file);
    body.append("asset_type", typeSelect?.value || "other");
    await apiRequest(`/api/projects/${projectId}/assets/upload`, { method: "POST", body });
  }
  await refreshAssetPanel(panel, projectId);
}

function bindAssetPanel(panel: HTMLElement): void {
  if (panel.dataset.bound === "1") return;
  panel.dataset.bound = "1";
  const input = panel.querySelector<HTMLInputElement>(".asset-file-input");
  const picker = panel.querySelector<HTMLButtonElement>(".asset-pick-btn");
  const dropzone = panel.querySelector<HTMLElement>(".asset-dropzone");

  picker?.addEventListener("click", () => input?.click());
  input?.addEventListener("change", () => {
    if (input.files?.length) {
      uploadFiles(panel, input.files).catch((error) => {
        const status = panel.querySelector<HTMLElement>(".asset-upload-status");
        if (status) status.textContent = error instanceof Error ? error.message : "上传失败";
      }).finally(() => {
        input.value = "";
      });
    }
  });

  dropzone?.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });
  dropzone?.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
  dropzone?.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
    if (event.dataTransfer?.files.length) {
      uploadFiles(panel, event.dataTransfer.files).catch((error) => {
        const status = panel.querySelector<HTMLElement>(".asset-upload-status");
        if (status) status.textContent = error instanceof Error ? error.message : "上传失败";
      });
    }
  });

  panel.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".asset-delete");
    if (!button) return;
    const assetId = button.dataset.assetId;
    const projectId = panel.dataset.projectId;
    if (!assetId || !projectId) return;
    apiRequest(`/api/projects/${projectId}/assets/${assetId}`, { method: "DELETE" })
      .then(() => refreshAssetPanel(panel, projectId))
      .catch((error) => {
        const status = panel.querySelector<HTMLElement>(".asset-upload-status");
        if (status) status.textContent = error instanceof Error ? error.message : "删除失败";
      });
  });

  refreshAssetPanel(panel).catch(() => undefined);
}

function createAssetUploadPanel(): HTMLElement {
  const panel = document.createElement("section");
  panel.className = "asset-upload-panel";
  panel.innerHTML = `
    <div class="asset-upload-head">
      <strong>上传素材</strong>
      <span>PDF / 图片 / 视频，自动生成素材摘要</span>
    </div>
    <label>素材类型
      <select class="asset-type-select">
        <option value="reference">参考样片</option>
        <option value="brand">品牌资产</option>
        <option value="other">其他补充材料</option>
      </select>
    </label>
    <div class="asset-dropzone">
      <input class="asset-file-input" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.mp4,.mov,.webm,.m4v" hidden />
      <p>拖拽文件到这里，或点击选择上传</p>
      <small>PDF 最大 30MB，图片最大 10MB，视频最大 200MB</small>
      <button type="button" class="asset-pick-btn">选择文件</button>
    </div>
    <p class="asset-upload-status">可上传 PDF、图片或视频素材。</p>
    <div class="asset-upload-list"></div>
  `;
  return panel;
}

function ensureAssetUploadPanel(): void {
  document.querySelectorAll<HTMLElement>(".composer .input-card").forEach((card) => {
    const text = card.textContent || "";
    if (!text.includes("参考样片") || !text.includes("品牌资产")) return;
    card.querySelector<HTMLElement>(".asset-upload-panel")?.remove();
    enhanceReferenceAssetField(card);
    enhanceBrandAssetField(card);
  });
}

function createFieldAssetUploadPanel(config: { kind: "reference" | "brand"; title: string; hint: string; accept: string; empty: string }): HTMLElement {
  const panel = document.createElement("section");
  panel.className = `field-asset-upload ${config.kind}`;
  panel.dataset.assetType = config.kind;
  panel.innerHTML = `
    <div class="field-asset-head">
      <strong>${config.title}</strong>
      <span>${config.hint}</span>
    </div>
    <div class="asset-dropzone compact">
      <input class="asset-file-input" type="file" multiple accept="${config.accept}" hidden />
      <p>${config.empty}</p>
      <button type="button" class="asset-pick-btn">选择文件</button>
      <select class="asset-type-select" hidden>
        <option value="${config.kind}" selected>${assetTypeLabels[config.kind]}</option>
      </select>
    </div>
    <p class="asset-upload-status">没有可留空。</p>
    <div class="asset-upload-list"></div>
  `;
  return panel;
}

function labelText(label: HTMLElement): string {
  return Array.from(label.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || "")
    .join("")
    .trim();
}

function enhanceReferenceAssetField(card: HTMLElement): void {
  const label = Array.from(card.querySelectorAll<HTMLElement>("label")).find((item) => labelText(item).includes("参考样片"));
  if (!label || label.querySelector(".field-asset-upload.reference")) return;
  const textarea = label.querySelector<HTMLTextAreaElement>("textarea");
  if (textarea) textarea.placeholder = "没有可留空；也可以上传参考视频";
  const panel = createFieldAssetUploadPanel({
    kind: "reference",
    title: "上传参考视频",
    hint: "MP4 / MOV / WEBM / M4V",
    accept: ".mp4,.mov,.webm,.m4v",
    empty: "拖拽参考视频到这里，或点击选择"
  });
  label.appendChild(panel);
  bindAssetPanel(panel);
}

function enhanceBrandAssetField(card: HTMLElement): void {
  const label = Array.from(card.querySelectorAll<HTMLElement>("label")).find((item) => labelText(item).includes("品牌资产"));
  if (!label || label.querySelector(".field-asset-upload.brand")) return;
  const textarea = label.querySelector<HTMLTextAreaElement>("textarea");
  if (textarea) textarea.placeholder = "Logo、VI、已有素材等；没有可留空";
  const panel = createFieldAssetUploadPanel({
    kind: "brand",
    title: "上传品牌资产",
    hint: "图片 / PDF / Word",
    accept: ".png,.jpg,.jpeg,.webp,.pdf,.docx",
    empty: "拖拽图片、PDF 或 Word 到这里，或点击选择"
  });
  label.appendChild(panel);
  bindAssetPanel(panel);
}

function initAssetUploadPanel(): void {
  const globalFlag = "__storyboardAssetUploadInitialized";
  const state = window as unknown as Record<string, unknown>;
  if (state[globalFlag]) return;
  state[globalFlag] = true;
  ensureAssetUploadPanel();
  const observer = new MutationObserver(() => ensureAssetUploadPanel());
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    initThemeSwitcher();
    initSidebarUserSection();
    initStatusLineToast();
    initAssetUploadPanel();
  }, { once: true });
} else {
  initThemeSwitcher();
  initSidebarUserSection();
  initStatusLineToast();
  initAssetUploadPanel();
}
