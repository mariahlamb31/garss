import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SubscriptionEditorModal } from "./components/SubscriptionEditorModal";
import { io } from "socket.io-client";
import {
  ALL_SOURCES_CATEGORY,
  buildUrlForReaderState,
  buildUrlForRsshubCategory,
  buildUrlForSourcesCategory,
  buildUrlForTab,
  parseAppLocation,
  readAccessCodeFromCurrentUrl,
  writeAccessCodeToCurrentUrl,
} from "./lib/navigation";
import { useAppStore } from "./store/useAppStore";
import type { AppTab, FeedItem, ReaderSourceState, Subscription, SubscriptionsBackup, SubscriptionInput } from "./types";

type SettingsSection = "fetch" | "rsshub" | "ai" | "api" | "account" | "about";
type ReaderBaseNavigationMode = "traditional" | "pure";
type ReaderNavigationMode = ReaderBaseNavigationMode | "search";
type SpeedTestResult = {
  status: "testing" | "success" | "error";
  ms?: number;
};
type ApiDocumentItem = {
  method: string;
  path: string;
  auth: "公开" | "Bearer Token";
  description: string;
};

function formatDateLabel(value: string): string {
  if (!value) {
    return "未标注时间";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatReaderDateGroupLabel(value: string): string {
  if (!value) {
    return "未标注时间";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function buildReaderDateGroupKey(value: string): string {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatRemainingDuration(targetTimestamp: number, nowTimestamp: number): string {
  const remainingMs = Math.max(0, targetTimestamp - nowTimestamp);
  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}小时 ${String(minutes).padStart(2, "0")}分 ${String(seconds).padStart(2, "0")}秒`;
  }

  return `${String(minutes).padStart(2, "0")}分 ${String(seconds).padStart(2, "0")}秒`;
}

function resolveUpcomingTimestamp(targetTimestamp: number, nowTimestamp: number, intervalMinutes: number): number {
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    return 0;
  }

  if (targetTimestamp > nowTimestamp) {
    return targetTimestamp;
  }

  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
  const elapsedIntervalCount = Math.floor((nowTimestamp - targetTimestamp) / intervalMs) + 1;

  return targetTimestamp + elapsedIntervalCount * intervalMs;
}

function formatIntervalLabel(value: number): string {
  if (value < 60) {
    return `${value} 分钟`;
  }

  if (value % 60 === 0) {
    return `${value / 60} 小时`;
  }

  return `${Math.floor(value / 60)} 小时 ${value % 60} 分钟`;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function isKeyboardEventFromEditableTarget(event: KeyboardEvent): boolean {
  const targetElement = event.target instanceof Element ? event.target : null;

  if (!targetElement) {
    return false;
  }

  return Boolean(targetElement.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

function matchesSearchText(value: string, query: string): boolean {
  return normalizeSearchText(value).includes(query);
}

function buildEmptyForm(): SubscriptionInput {
  return {
    category: "",
    categories: [],
    name: "",
    routePath: "",
    routeTemplate: "",
    description: "",
    enabled: true,
  };
}

function normalizeCategoryList(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = (value || "").trim();

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

function getSubscriptionCategories(subscription: Pick<Subscription, "category" | "categories">): string[] {
  return normalizeCategoryList([...(subscription.categories || []), subscription.category]);
}

function getInputCategories(input: SubscriptionInput): string[] {
  return normalizeCategoryList([...(input.categories || []), input.category]);
}

const AUTO_REFRESH_OPTION_VALUES = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
const PARALLEL_FETCH_OPTION_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const DEFAULT_SOURCE_CATEGORY = "未分类";
const SOURCE_DRAFT_STORAGE_KEY = "garss-studio.source-draft";
const ARTICLE_IMAGE_ENHANCEMENT_STORAGE_KEY = "garss-studio.article-image-enhancement";
const INLINE_URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const IMAGE_URL_PATTERN = /https?:\/\/[^\s<>"']+?\.(?:jpe?g|png|gif|webp|avif)(?:\?[^\s<>"']*)?(?:#[^\s<>"']*)?/gi;
const API_DOCUMENT_ITEMS: ApiDocumentItem[] = [
  { method: "GET", path: "/api/docs", auth: "公开", description: "打开 Swagger UI，可交互查看和调试后端接口。" },
  { method: "GET", path: "/api/openapi.json", auth: "公开", description: "获取机器可读的 OpenAPI JSON。" },
  { method: "GET", path: "/api/health", auth: "公开", description: "检查后端健康状态、RSSHub 基础地址和订阅源数量。" },
  { method: "GET", path: "/api/image-proxy?url={imageUrl}", auth: "公开", description: "代理读取远端图片，供文章图片预览使用。" },
  { method: "POST", path: "/api/auth/login", auth: "公开", description: "使用提取码登录，返回后续请求所需的 Bearer token。" },
  { method: "GET", path: "/api/auth/session", auth: "Bearer Token", description: "校验当前 token 并返回会话状态。" },
  { method: "GET", path: "/api/subscriptions", auth: "Bearer Token", description: "获取订阅源列表和合并后的分类列表。" },
  { method: "POST", path: "/api/subscriptions", auth: "Bearer Token", description: "创建一个 RSS 订阅源，routePath 可为 RSSHub 路径或完整 RSS URL。" },
  { method: "POST", path: "/api/subscriptions/test", auth: "Bearer Token", description: "保存前测试订阅源是否可正常拉取，并返回样例标题。" },
  { method: "PUT", path: "/api/subscriptions/{id}", auth: "Bearer Token", description: "更新订阅源名称、分类、路径、描述和启用状态。" },
  { method: "DELETE", path: "/api/subscriptions/{id}", auth: "Bearer Token", description: "删除订阅源，并清理该订阅源的阅读缓存。" },
  { method: "GET", path: "/api/settings", auth: "Bearer Token", description: "读取当前用户桶的自动拉取设置和下一次调度时间。" },
  { method: "PUT", path: "/api/settings", auth: "Bearer Token", description: "更新自动拉取时间间隔和单次并行拉取数量。" },
  { method: "POST", path: "/api/categories", auth: "Bearer Token", description: "创建一个显式分类。" },
  { method: "PUT", path: "/api/categories/{name}", auth: "Bearer Token", description: "重命名分类，并同步更新相关订阅源。" },
  { method: "DELETE", path: "/api/categories/{name}", auth: "Bearer Token", description: "删除分类，相关订阅源会移动到默认分类。" },
  { method: "GET", path: "/api/rsshub/fetch?routePath={path}", auth: "Bearer Token", description: "按 RSSHub 路径直接获取原始 XML。" },
  { method: "GET", path: "/api/reader/items?refresh={boolean}", auth: "Bearer Token", description: "获取所有已启用订阅源的聚合文章；refresh=true 会强制重新拉取。" },
  { method: "GET", path: "/api/reader/subscriptions/{id}?refresh={boolean}", auth: "Bearer Token", description: "获取单个订阅源的文章；refresh=true 会强制刷新该源缓存。" },
  { method: "Socket.IO", path: "/socket.io", auth: "Bearer Token", description: "实时推送后端状态和拉取任务进度，连接时通过 auth.token 传入 token。" },
];

function buildSortedOptions(defaultValues: number[], currentValue: number): number[] {
  return Array.from(new Set([...defaultValues, currentValue])).sort((left, right) => left - right);
}

function readSourceDraft(): SubscriptionInput | null {
  if (typeof window === "undefined") {
    return null;
  }

  const rawDraft = window.sessionStorage.getItem(SOURCE_DRAFT_STORAGE_KEY);

  if (!rawDraft) {
    return null;
  }

  window.sessionStorage.removeItem(SOURCE_DRAFT_STORAGE_KEY);

  try {
    const parsedDraft = JSON.parse(rawDraft) as Partial<SubscriptionInput>;
    return {
      ...buildEmptyForm(),
      category: typeof parsedDraft.category === "string" ? parsedDraft.category : "",
      categories: Array.isArray(parsedDraft.categories)
        ? parsedDraft.categories.filter((entry): entry is string => typeof entry === "string")
        : [],
      name: typeof parsedDraft.name === "string" ? parsedDraft.name : "",
      routePath: typeof parsedDraft.routePath === "string" ? parsedDraft.routePath : "",
      routeTemplate: typeof parsedDraft.routeTemplate === "string" ? parsedDraft.routeTemplate : "",
      description: typeof parsedDraft.description === "string" ? parsedDraft.description : "",
      enabled: typeof parsedDraft.enabled === "boolean" ? parsedDraft.enabled : true,
    };
  } catch {
    return null;
  }
}

function writeSourceDraft(draft: SubscriptionInput): void {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(SOURCE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

function splitIntoParagraphs(value: string): string[] {
  return value
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readStoredArticleImageEnhancementEnabled(): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  return window.localStorage.getItem(ARTICLE_IMAGE_ENHANCEMENT_STORAGE_KEY) !== "off";
}

function writeStoredArticleImageEnhancementEnabled(value: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(ARTICLE_IMAGE_ENHANCEMENT_STORAGE_KEY, value ? "on" : "off");
}

function buildImageProxyUrl(value: string): string {
  if (!value || typeof window === "undefined") {
    return value;
  }

  try {
    const imageUrl = new URL(value, window.location.href);

    if (imageUrl.protocol !== "http:" && imageUrl.protocol !== "https:") {
      return value;
    }

    if (imageUrl.origin === window.location.origin && imageUrl.pathname === "/api/image-proxy") {
      return imageUrl.toString();
    }

    return `/api/image-proxy?url=${encodeURIComponent(imageUrl.toString())}`;
  } catch {
    return value;
  }
}

function normalizeArticleUrlCandidate(value: string): string {
  return value.trim().replace(/[),.;\]}，。；）】]+$/u, "");
}

function isImageUrl(value: string): boolean {
  IMAGE_URL_PATTERN.lastIndex = 0;
  return IMAGE_URL_PATTERN.test(value);
}

function extractImageUrls(value: string): string[] {
  IMAGE_URL_PATTERN.lastIndex = 0;
  const matches = value.match(IMAGE_URL_PATTERN) || [];
  return matches.map(normalizeArticleUrlCandidate);
}

function createArticleImagePreview(documentRef: Document, value: string): HTMLElement {
  const normalizedUrl = normalizeArticleUrlCandidate(value);
  const linkElement = documentRef.createElement("a");
  linkElement.className = "reader-article-image-preview";
  linkElement.href = normalizedUrl;
  linkElement.target = "_blank";
  linkElement.rel = "noreferrer";

  const imageElement = documentRef.createElement("img");
  imageElement.src = buildImageProxyUrl(normalizedUrl);
  imageElement.alt = "文章图片";
  imageElement.loading = "lazy";
  imageElement.decoding = "async";
  imageElement.referrerPolicy = "no-referrer";

  linkElement.appendChild(imageElement);
  return linkElement;
}

function insertImagePreviewsIntoUrlBlocks(template: HTMLTemplateElement): void {
  for (const preElement of Array.from(template.content.querySelectorAll("pre"))) {
    if (preElement.closest("td.gutter")) {
      continue;
    }

    const rawLines = (preElement.textContent || "").split(/\n/);
    const lineImageUrlList = rawLines.map(extractImageUrls);

    if (!lineImageUrlList.some((imageUrls) => imageUrls.length)) {
      continue;
    }

    const fragment = document.createDocumentFragment();

    rawLines.forEach((rawLine, index) => {
      const lineImageUrls = lineImageUrlList[index] || [];

      fragment.appendChild(document.createTextNode(rawLine));

      for (const imageUrl of lineImageUrls) {
        fragment.appendChild(document.createTextNode("\n"));
        fragment.appendChild(createArticleImagePreview(document, imageUrl));
      }

      if (index < rawLines.length - 1) {
        fragment.appendChild(document.createTextNode("\n"));
      }
    });

    while (preElement.firstChild) {
      preElement.firstChild.remove();
    }

    preElement.appendChild(fragment);
  }
}

function enhanceInlineImageUrls(template: HTMLTemplateElement): void {
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];

  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    const parentElement = textNode.parentElement;

    if (
      !parentElement ||
      parentElement.closest("a, code, pre, script, style, textarea, .reader-article-image-list")
    ) {
      continue;
    }

    if (INLINE_URL_PATTERN.test(textNode.nodeValue || "")) {
      textNodes.push(textNode);
    }

    INLINE_URL_PATTERN.lastIndex = 0;
  }

  for (const textNode of textNodes) {
    const textValue = textNode.nodeValue || "";
    const fragment = document.createDocumentFragment();
    let cursor = 0;

    for (const match of textValue.matchAll(INLINE_URL_PATTERN)) {
      const rawUrl = match[0];
      const matchIndex = match.index || 0;

      if (matchIndex > cursor) {
        fragment.appendChild(document.createTextNode(textValue.slice(cursor, matchIndex)));
      }

      const normalizedUrl = normalizeArticleUrlCandidate(rawUrl);

      const linkElement = document.createElement("a");
      linkElement.href = normalizedUrl;
      linkElement.target = "_blank";
      linkElement.rel = "noreferrer";
      linkElement.textContent = normalizedUrl;
      fragment.appendChild(linkElement);

      if (isImageUrl(normalizedUrl)) {
        fragment.appendChild(createArticleImagePreview(document, normalizedUrl));
      }

      cursor = matchIndex + rawUrl.length;

      if (normalizedUrl.length < rawUrl.length) {
        fragment.appendChild(document.createTextNode(rawUrl.slice(normalizedUrl.length)));
      }
    }

    if (cursor < textValue.length) {
      fragment.appendChild(document.createTextNode(textValue.slice(cursor)));
    }

    textNode.replaceWith(fragment);
  }
}

function enhanceArticleHtml(html: string, shouldEnhanceImageUrls: boolean): string {
  if (!html || typeof window === "undefined") {
    return html;
  }

  const template = document.createElement("template");
  template.innerHTML = html;

  for (const imageElement of Array.from(template.content.querySelectorAll("img"))) {
    const source = imageElement.getAttribute("src") || "";
    const proxiedSource = buildImageProxyUrl(source);

    if (proxiedSource) {
      imageElement.setAttribute("src", proxiedSource);
    }

    imageElement.setAttribute("referrerpolicy", "no-referrer");
  }

  if (shouldEnhanceImageUrls) {
    insertImagePreviewsIntoUrlBlocks(template);
    enhanceInlineImageUrls(template);
  }

  return template.innerHTML;
}

function ReaderArticleContent({ html, shouldEnhanceImageUrls }: { html: string; shouldEnhanceImageUrls: boolean }) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [fullscreenImage, setFullscreenImage] = useState<{ src: string; alt: string } | null>(null);
  const enhancedHtml = useMemo(() => enhanceArticleHtml(html, shouldEnhanceImageUrls), [html, shouldEnhanceImageUrls]);

  useEffect(() => {
    const contentElement = contentRef.current;

    if (!contentElement) {
      return;
    }

    const cleanupCallbacks: Array<() => void> = [];

    for (const preElement of Array.from(contentElement.querySelectorAll("pre"))) {
      if (preElement.closest("td.gutter")) {
        continue;
      }

      let copyHost = preElement.closest("td.code") as HTMLElement | null;

      if (!copyHost) {
        const existingHost = preElement.parentElement?.classList.contains("reader-code-copy-host")
          ? preElement.parentElement
          : null;

        if (existingHost) {
          copyHost = existingHost;
        } else {
          const wrapper = document.createElement("div");
          wrapper.className = "reader-code-copy-host";
          preElement.parentElement?.insertBefore(wrapper, preElement);
          wrapper.appendChild(preElement);
          copyHost = wrapper;
        }
      }

      copyHost.classList.add("reader-code-copy-host");

      let copyButton = copyHost.querySelector(":scope > .reader-code-copy-button") as HTMLButtonElement | null;

      if (!copyButton) {
        copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.className = "reader-code-copy-button";
        copyButton.textContent = "复制";
        copyHost.prepend(copyButton);
      }

      const handleCopy = async () => {
        const codeText = preElement.innerText.trimEnd();
        const markCopyResult = (isSuccess: boolean) => {
          copyButton.textContent = isSuccess ? "已复制" : "复制失败";
          window.setTimeout(() => {
            copyButton.textContent = "复制";
          }, 1200);
        };

        try {
          await navigator.clipboard.writeText(codeText);
          markCopyResult(true);
        } catch {
          const fallbackInput = document.createElement("textarea");
          fallbackInput.value = codeText;
          fallbackInput.setAttribute("readonly", "true");
          fallbackInput.style.position = "fixed";
          fallbackInput.style.top = "-9999px";
          document.body.appendChild(fallbackInput);
          fallbackInput.select();
          const didCopy = document.execCommand("copy");
          fallbackInput.remove();
          markCopyResult(didCopy);
        }
      };

      copyButton.addEventListener("click", handleCopy);
      cleanupCallbacks.push(() => copyButton.removeEventListener("click", handleCopy));
    }

    const handleImageClick = (event: MouseEvent) => {
      const targetElement = event.target instanceof Element ? event.target : null;
      const imageElement = targetElement?.closest("img") as HTMLImageElement | null;

      if (!imageElement || !contentElement.contains(imageElement)) {
        return;
      }

      const imageSource = imageElement.currentSrc || imageElement.src;

      if (!imageSource) {
        return;
      }

      event.preventDefault();
      setFullscreenImage({
        src: imageSource,
        alt: imageElement.alt || "文章图片",
      });
    };

    contentElement.addEventListener("click", handleImageClick);
    cleanupCallbacks.push(() => contentElement.removeEventListener("click", handleImageClick));

    return () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup();
      }
    };
  }, [enhancedHtml]);

  useEffect(() => {
    if (!fullscreenImage || typeof window === "undefined") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFullscreenImage(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fullscreenImage]);

  return (
    <>
      <div
        ref={contentRef}
        className="reader-article-content"
        dangerouslySetInnerHTML={{ __html: enhancedHtml }}
      />
      {fullscreenImage && typeof document !== "undefined" ? createPortal(
        <div
          className="reader-image-viewer"
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          onClick={() => setFullscreenImage(null)}
        >
          <div className="reader-image-viewer-actions">
            <a
              className="reader-image-viewer-download"
              href={fullscreenImage.src}
              download
              onClick={(event) => event.stopPropagation()}
            >
              下载
            </a>
            <button
              type="button"
              className="reader-image-viewer-close"
              aria-label="关闭图片预览"
              onClick={() => setFullscreenImage(null)}
            >
              ×
            </button>
          </div>
          <img
            src={fullscreenImage.src}
            alt={fullscreenImage.alt}
            onClick={(event) => event.stopPropagation()}
          />
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function resolveAvailableSourcesCategory(selectedCategory: string, categories: string[]): string {
  if (!categories.length) {
    return "";
  }

  if (selectedCategory && selectedCategory !== ALL_SOURCES_CATEGORY && categories.includes(selectedCategory)) {
    return selectedCategory;
  }

  return categories[0];
}

function isRsshubDocSubscription(subscription: Subscription): boolean {
  return subscription.id.startsWith("rsshub-doc-");
}

function isRsshubDocCategory(category: string): boolean {
  return category.trim().startsWith("RSSHub 文档 /");
}

function buildVisibleCategories(subscriptions: Subscription[], explicitCategories: string[], includeRsshubDocs: boolean): string[] {
  const subscriptionCategories = subscriptions
    .filter((subscription) => isRsshubDocSubscription(subscription) === includeRsshubDocs)
    .flatMap((subscription) => getSubscriptionCategories(subscription));
  const categoryCandidates = includeRsshubDocs
    ? subscriptionCategories
    : [
        ...explicitCategories.filter((category) => !isRsshubDocCategory(category)),
        ...subscriptionCategories,
      ];

  return Array.from(new Set(categoryCandidates)).filter(Boolean);
}

function LoginScreen() {
  const isLoggingIn = useAppStore((state) => state.isLoggingIn);
  const loginError = useAppStore((state) => state.loginError);
  const loginWithAccessCode = useAppStore((state) => state.loginWithAccessCode);
  const [accessCode, setAccessCode] = useState(() => readAccessCodeFromCurrentUrl());

  useEffect(() => {
    setAccessCode(readAccessCodeFromCurrentUrl());
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedAccessCode = accessCode.trim();
    writeAccessCodeToCurrentUrl(normalizedAccessCode);
    await loginWithAccessCode(normalizedAccessCode);
  }

  return (
    <main className="login-screen">
      <section className="login-card">
        <span className="login-eyebrow">GARSS Studio</span>
        <h1>提取码登录</h1>
        <p>
          后端会统一代理 RSSHub 数据，并在进入阅读与订阅管理之前校验访问提取码。
        </p>
        <form className="login-form" onSubmit={handleSubmit}>
          <label className="stack-field">
            <span>提取码</span>
            <input
              type="password"
              autoComplete="current-password"
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
              placeholder="输入后端配置的 ACCESS_CODE"
            />
          </label>
          <button type="submit" className="primary-button" disabled={isLoggingIn || !accessCode.trim()}>
            {isLoggingIn ? "校验中..." : "进入工作台"}
          </button>
        </form>
        {loginError ? <p className="inline-error">{loginError}</p> : null}
      </section>
    </main>
  );
}

function ReaderListCard({
  item,
  isActive,
  onSelect,
}: {
  item: FeedItem;
  isActive: boolean;
  onSelect: (itemId: string) => void;
}) {
  return (
    <article
      className={`reader-note-card${isActive ? " is-active" : ""}`}
      data-reader-nav-item-id={item.id}
      role="button"
      tabIndex={0}
      aria-pressed={isActive}
      onClick={() => onSelect(item.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(item.id);
        }
      }}
    >
      <div className="note-card-head">
        <time>{formatDateLabel(item.publishedAt)}</time>
        <h3>{item.title || "未命名条目"}</h3>
      </div>
    </article>
  );
}

function ReaderPureListCard({
  item,
  isActive,
  onSelect,
}: {
  item: FeedItem;
  isActive: boolean;
  onSelect: (item: FeedItem) => void;
}) {
  return (
    <article
      className={`reader-pure-note-card${isActive ? " is-active" : ""}`}
      data-reader-nav-item-id={item.id}
      role="button"
      tabIndex={0}
      aria-pressed={isActive}
      onClick={() => onSelect(item)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(item);
        }
      }}
    >
      <span className="reader-pure-source-name">{item.subscriptionName || "未知订阅源"}</span>
      <h3>{item.title || "未命名条目"}</h3>
      <time>{formatDateLabel(item.publishedAt)}</time>
    </article>
  );
}

function ReaderArticleCard({
  item,
  isActive,
  articleRef,
  shouldEnhanceImageUrls,
}: {
  item: FeedItem;
  isActive: boolean;
  articleRef?: (node: HTMLElement | null) => void;
  shouldEnhanceImageUrls: boolean;
}) {
  const paragraphs = splitIntoParagraphs(item.contentText || item.excerpt);

  return (
    <article
      ref={articleRef}
      className={`reader-article-sheet${isActive ? " is-active" : ""}`}
      data-item-id={item.id}
    >
      <div className="reader-article-frame reader-article-frame-outer">
        <div className="reader-article-frame reader-article-frame-inner">
          <div className="reader-article-inner">
            <div className="reader-article-head">
              <div className="reader-article-meta">
                <span className="note-chip">{item.subscriptionName}</span>
                <span>{formatDateLabel(item.publishedAt)}</span>
                <span>{item.author || item.routePath}</span>
              </div>
              <a href={item.link} target="_blank" rel="noreferrer" className="reader-article-link">
                原文链接
              </a>
            </div>

            <section className="reader-article-section">
              <h2>{item.title || "未命名条目"}</h2>
              {item.contentHtml ? (
                <ReaderArticleContent html={item.contentHtml} shouldEnhanceImageUrls={shouldEnhanceImageUrls} />
              ) : (
                <div className="reader-article-content is-plain">
                  {paragraphs.length ? (
                    paragraphs.map((paragraph, index) => <p key={`${item.id}-${index}`}>{paragraph}</p>)
                  ) : (
                    <p>这个条目暂时没有可展示的正文，仍然可以通过上方原文链接继续查看。</p>
                  )}
                </div>
              )}
            </section>

            <footer className="reader-article-footer">
              <span className="reader-article-footer-brand">由 GARSS阅读</span>
              <span className="reader-article-footer-via">inspired by Smartisan Notes</span>
            </footer>
          </div>
        </div>
      </div>
    </article>
  );
}

function ReaderSourceCard({
  sourceState,
  isActive,
  isExpanded,
  onSelect,
}: {
  sourceState: ReaderSourceState;
  isActive: boolean;
  isExpanded: boolean;
  onSelect: (subscriptionId: string) => void;
}) {
  const shouldShowError = sourceState.status === "error" && sourceState.message.trim();
  const updatedLabel = sourceState.updatedAt ? formatDateLabel(sourceState.updatedAt) : "尚未更新";

  return (
    <button
      type="button"
      className={`source-status-card source-index-card is-${sourceState.status}${isActive ? " is-active" : ""}${
        isExpanded ? " is-expanded" : ""
      }`}
      aria-pressed={isActive}
      aria-expanded={isExpanded}
      onClick={() => onSelect(sourceState.subscriptionId)}
    >
      <div className="source-index-meta">
        <span>{updatedLabel}</span>
      </div>
      <div className="source-index-main">
        <h3>{sourceState.subscriptionName}</h3>
        <span className="source-index-count">{sourceState.itemCount}</span>
      </div>
      {shouldShowError ? <p className="source-status-error">{sourceState.message}</p> : null}
    </button>
  );
}

function ReaderPanel() {
  const initialReaderLocation = useMemo(
    () => (typeof window === "undefined" ? null : parseAppLocation(window.location.href)),
    [],
  );
  const subscriptions = useAppStore((state) => state.subscriptions);
  const categories = useAppStore((state) => state.categories);
  const items = useAppStore((state) => state.items);
  const readerSourceStates = useAppStore((state) => state.readerSourceStates);
  const loadingReader = useAppStore((state) => state.loadingReader);
  const reloadingSourceId = useAppStore((state) => state.reloadingSourceId);
  const refreshReaderSubscription = useAppStore((state) => state.refreshReaderSubscription);
  const enabledSubscriptions = useMemo(
    () => subscriptions.filter((subscription) => subscription.enabled && !isRsshubDocSubscription(subscription)),
    [subscriptions],
  );
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState("");
  const [expandedSubscriptionId, setExpandedSubscriptionId] = useState("");
  const [selectedItemId, setSelectedItemId] = useState(initialReaderLocation?.readerItemId || "");
  const [pendingReaderItemId, setPendingReaderItemId] = useState(initialReaderLocation?.readerItemId || "");
  const [completedSourceOrder, setCompletedSourceOrder] = useState<string[]>([]);
  const [isSourceDrawerOpen, setIsSourceDrawerOpen] = useState(false);
  const [sourceFilterQuery, setSourceFilterQuery] = useState("");
  const [debouncedSourceFilterQuery, setDebouncedSourceFilterQuery] = useState("");
  const [sourceFilterCategory, setSourceFilterCategory] = useState(initialReaderLocation?.readerCategory || "");
  const [readerNavigationMode, setReaderNavigationMode] = useState<ReaderNavigationMode>(
    initialReaderLocation?.readerMode || "pure",
  );
  const [readerBaseNavigationMode, setReaderBaseNavigationMode] = useState<ReaderBaseNavigationMode>(
    initialReaderLocation?.readerMode || "pure",
  );
  const [expandedReaderDate, setExpandedReaderDate] = useState("");
  const [shouldEnhanceImageUrls, setShouldEnhanceImageUrls] = useState(readStoredArticleImageEnhancementEnabled);
  const articleScrollRef = useRef<HTMLDivElement | null>(null);

  const baseSourceStateList = useMemo(
    () =>
      enabledSubscriptions.map(
        (subscription) =>
          readerSourceStates[subscription.id] || {
            subscriptionId: subscription.id,
            subscriptionName: subscription.name,
            routePath: subscription.routePath,
            status: "idle",
            itemCount: 0,
            message: "等待拉取",
            updatedAt: "",
          },
      ),
    [enabledSubscriptions, readerSourceStates],
  );

  useEffect(() => {
    setCompletedSourceOrder((currentOrder) => {
      const completedIds = baseSourceStateList
        .filter((sourceState) => sourceState.status === "success")
        .map((sourceState) => sourceState.subscriptionId);
      const completedIdSet = new Set(completedIds);
      const retainedOrder = currentOrder.filter((subscriptionId) => completedIdSet.has(subscriptionId));
      const nextOrder = [
        ...retainedOrder,
        ...completedIds.filter((subscriptionId) => !retainedOrder.includes(subscriptionId)),
      ];

      if (nextOrder.length === currentOrder.length && nextOrder.every((subscriptionId, index) => subscriptionId === currentOrder[index])) {
        return currentOrder;
      }

      return nextOrder;
    });
  }, [baseSourceStateList]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSourceFilterQuery(sourceFilterQuery);
    }, 220);

    return () => window.clearTimeout(timer);
  }, [sourceFilterQuery]);

  const sourceStateList = useMemo(() => {
    const completedRankById = new Map(completedSourceOrder.map((subscriptionId, index) => [subscriptionId, index]));
    const sourceRankById = new Map(enabledSubscriptions.map((subscription, index) => [subscription.id, index]));

    return [...baseSourceStateList].sort((left, right) => {
      const isLeftCompleted = left.status === "success";
      const isRightCompleted = right.status === "success";

      if (isLeftCompleted !== isRightCompleted) {
        return isLeftCompleted ? -1 : 1;
      }

      if (isLeftCompleted && isRightCompleted) {
        return (
          (completedRankById.get(left.subscriptionId) ?? Number.MAX_SAFE_INTEGER) -
          (completedRankById.get(right.subscriptionId) ?? Number.MAX_SAFE_INTEGER)
        );
      }

      return (
        (sourceRankById.get(left.subscriptionId) ?? Number.MAX_SAFE_INTEGER) -
        (sourceRankById.get(right.subscriptionId) ?? Number.MAX_SAFE_INTEGER)
      );
    });
  }, [baseSourceStateList, completedSourceOrder, enabledSubscriptions]);

  useEffect(() => {
    if (!enabledSubscriptions.length) {
      setSelectedSubscriptionId("");
      setExpandedSubscriptionId("");
      return;
    }

    if (!enabledSubscriptions.some((subscription) => subscription.id === selectedSubscriptionId)) {
      const fallbackSubscriptionId = enabledSubscriptions[0]?.id || "";
      setSelectedSubscriptionId(fallbackSubscriptionId);
      setExpandedSubscriptionId(fallbackSubscriptionId);
    }
  }, [enabledSubscriptions, selectedSubscriptionId]);

  useEffect(() => {
    if (
      expandedSubscriptionId &&
      !enabledSubscriptions.some((subscription) => subscription.id === expandedSubscriptionId)
    ) {
      setExpandedSubscriptionId("");
    }
  }, [enabledSubscriptions, expandedSubscriptionId]);

  const selectedSourceState = useMemo(
    () => sourceStateList.find((sourceState) => sourceState.subscriptionId === selectedSubscriptionId) || null,
    [selectedSubscriptionId, sourceStateList],
  );

  const filteredItems = useMemo(
    () => items.filter((item) => item.subscriptionId === selectedSubscriptionId),
    [items, selectedSubscriptionId],
  );
  const sortedReaderItems = useMemo(
    () =>
      [...items].sort((left, right) => {
        const leftTime = new Date(left.publishedAt).getTime();
        const rightTime = new Date(right.publishedAt).getTime();
        const normalizedLeftTime = Number.isNaN(leftTime) ? 0 : leftTime;
        const normalizedRightTime = Number.isNaN(rightTime) ? 0 : rightTime;

        return normalizedRightTime - normalizedLeftTime;
      }),
    [items],
  );
  const sourceItemsBySubscriptionId = useMemo(() => {
    const groupedItems = new Map<string, FeedItem[]>();

    for (const item of items) {
      const currentItems = groupedItems.get(item.subscriptionId) || [];
      currentItems.push(item);
      groupedItems.set(item.subscriptionId, currentItems);
    }

    return groupedItems;
  }, [items]);
  const enabledSubscriptionById = useMemo(
    () => new Map(enabledSubscriptions.map((subscription) => [subscription.id, subscription])),
    [enabledSubscriptions],
  );
  const readerFilterCategoryOptions = useMemo(() => {
    const categoryCounts = new Map<string, number>();

    for (const subscription of enabledSubscriptions) {
      for (const category of getSubscriptionCategories(subscription)) {
        categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      }
    }

    const categoryNames = normalizeCategoryList([
      ...categories.filter((category) => !isRsshubDocCategory(category)),
      ...Array.from(categoryCounts.keys()),
    ]);

    return categoryNames.map((category) => ({
      id: category,
      label: category,
      count: categoryCounts.get(category) || 0,
    })).filter((category) => category.count > 0);
  }, [categories, enabledSubscriptions]);
  const normalizedImmediateSourceFilterQuery = normalizeSearchText(sourceFilterQuery);
  const normalizedSourceFilterQuery = normalizeSearchText(debouncedSourceFilterQuery);
  const hasSourceFilterInput = sourceFilterQuery.length > 0;
  const hasSourceCategoryFilter = Boolean(sourceFilterCategory);
  const isSourceFilterPending = normalizedImmediateSourceFilterQuery !== normalizedSourceFilterQuery;

  function isSubscriptionInFilterCategory(subscriptionId: string): boolean {
    if (!sourceFilterCategory) {
      return true;
    }

    const subscription = enabledSubscriptionById.get(subscriptionId);
    return subscription ? getSubscriptionCategories(subscription).includes(sourceFilterCategory) : false;
  }

  useEffect(() => {
    setReaderNavigationMode(hasSourceFilterInput ? "search" : readerBaseNavigationMode);
  }, [hasSourceFilterInput, readerBaseNavigationMode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const syncReaderStateFromHash = () => {
      const locationState = parseAppLocation(window.location.href);

      if (locationState.tab !== "reader") {
        return;
      }

      if (locationState.readerMode) {
        setReaderBaseNavigationMode(locationState.readerMode);

        if (!hasSourceFilterInput) {
          setReaderNavigationMode(locationState.readerMode);
        }
      }

      setSourceFilterCategory(locationState.readerCategory);
      setPendingReaderItemId(locationState.readerItemId);

      if (locationState.readerItemId) {
        setSelectedItemId(locationState.readerItemId);
      }
    };

    window.addEventListener("popstate", syncReaderStateFromHash);
    window.addEventListener("hashchange", syncReaderStateFromHash);

    return () => {
      window.removeEventListener("popstate", syncReaderStateFromHash);
      window.removeEventListener("hashchange", syncReaderStateFromHash);
    };
  }, [hasSourceFilterInput]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const locationState = parseAppLocation(window.location.href);

    if (locationState.tab !== "reader") {
      return;
    }

    const nextUrl = buildUrlForReaderState(window.location.href, {
      mode: readerBaseNavigationMode,
      category: sourceFilterCategory,
      itemId: selectedItemId,
    });
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    if (nextUrl !== currentUrl) {
      window.history.replaceState({}, "", nextUrl);
    }
  }, [readerBaseNavigationMode, selectedItemId, sourceFilterCategory]);

  const readerSearchItems = useMemo(
    () =>
      normalizedSourceFilterQuery
        ? sortedReaderItems.filter(
            (item) =>
              isSubscriptionInFilterCategory(item.subscriptionId) &&
              (
                matchesSearchText(item.title, normalizedSourceFilterQuery) ||
                matchesSearchText(item.subscriptionName, normalizedSourceFilterQuery)
              ),
          )
        : [],
    [enabledSubscriptionById, normalizedSourceFilterQuery, sortedReaderItems, sourceFilterCategory],
  );
  const sourceSearchStates = useMemo(
    () =>
      sourceStateList.filter((sourceState) => {
        if (!normalizedSourceFilterQuery) {
          return false;
        }

        if (!isSubscriptionInFilterCategory(sourceState.subscriptionId)) {
          return false;
        }

        return matchesSearchText(sourceState.subscriptionName, normalizedSourceFilterQuery);
      }),
    [enabledSubscriptionById, normalizedSourceFilterQuery, sourceFilterCategory, sourceStateList],
  );
  const filteredSelectedSourceItems = useMemo(
    () => {
      if (selectedSubscriptionId && !isSubscriptionInFilterCategory(selectedSubscriptionId)) {
        return [];
      }

      return normalizedSourceFilterQuery
        ? filteredItems.filter((item) => matchesSearchText(item.title, normalizedSourceFilterQuery))
        : filteredItems;
    },
    [enabledSubscriptionById, filteredItems, normalizedSourceFilterQuery, selectedSubscriptionId, sourceFilterCategory],
  );
  const visibleSourceStateList = useMemo(() => {
    const categoryFilteredSourceStates = sourceStateList.filter((sourceState) =>
      isSubscriptionInFilterCategory(sourceState.subscriptionId),
    );

    if (!normalizedSourceFilterQuery) {
      return categoryFilteredSourceStates.map((sourceState) => ({
        sourceState,
        matchingItems: [] as FeedItem[],
      }));
    }

    return categoryFilteredSourceStates
      .map((sourceState) => {
        const sourceNameMatched = matchesSearchText(sourceState.subscriptionName, normalizedSourceFilterQuery);
        const matchingItems = (sourceItemsBySubscriptionId.get(sourceState.subscriptionId) || []).filter(
          (item) => sourceNameMatched || matchesSearchText(item.title, normalizedSourceFilterQuery),
        );

        return {
          sourceState,
          matchingItems,
        };
      })
      .filter((entry) => entry.matchingItems.length);
  }, [enabledSubscriptionById, normalizedSourceFilterQuery, sourceFilterCategory, sourceItemsBySubscriptionId, sourceStateList]);
  const visibleReaderDateGroups = useMemo(() => {
    const groupedItems = new Map<string, { dateKey: string; dateLabel: string; items: FeedItem[] }>();

    for (const item of sortedReaderItems) {
      if (!isSubscriptionInFilterCategory(item.subscriptionId)) {
        continue;
      }

      if (
        normalizedSourceFilterQuery &&
        !matchesSearchText(item.title, normalizedSourceFilterQuery) &&
        !matchesSearchText(item.subscriptionName, normalizedSourceFilterQuery)
      ) {
        continue;
      }

      const dateKey = buildReaderDateGroupKey(item.publishedAt);
      const existingGroup = groupedItems.get(dateKey);

      if (existingGroup) {
        existingGroup.items.push(item);
        continue;
      }

      groupedItems.set(dateKey, {
        dateKey,
        dateLabel: formatReaderDateGroupLabel(item.publishedAt),
        items: [item],
      });
    }

    return Array.from(groupedItems.values());
  }, [enabledSubscriptionById, normalizedSourceFilterQuery, sourceFilterCategory, sortedReaderItems]);
  const visibleReaderItems = useMemo(
    () => visibleReaderDateGroups.flatMap((dateGroup) => dateGroup.items),
    [visibleReaderDateGroups],
  );

  useEffect(() => {
    if (readerNavigationMode !== "traditional") {
      return;
    }

    if (!visibleSourceStateList.length) {
      setSelectedSubscriptionId("");
      setExpandedSubscriptionId("");
      return;
    }

    if (!visibleSourceStateList.some(({ sourceState }) => sourceState.subscriptionId === selectedSubscriptionId)) {
      const fallbackSubscriptionId = visibleSourceStateList[0]?.sourceState.subscriptionId || "";
      setSelectedSubscriptionId(fallbackSubscriptionId);
      setExpandedSubscriptionId(fallbackSubscriptionId);
    }
  }, [readerNavigationMode, selectedSubscriptionId, visibleSourceStateList]);

  const activeNavigationItems =
    readerNavigationMode === "search"
      ? isSourceFilterPending
        ? []
        : readerSearchItems
      : readerNavigationMode === "pure"
        ? visibleReaderItems
        : filteredSelectedSourceItems;
  const selectedItem = useMemo(
    () => activeNavigationItems.find((item) => item.id === selectedItemId) || null,
    [activeNavigationItems, selectedItemId],
  );
  const selectedItemIndex = useMemo(
    () => activeNavigationItems.findIndex((item) => item.id === selectedItemId),
    [activeNavigationItems, selectedItemId],
  );
  const previousItem = selectedItemIndex > 0 ? activeNavigationItems[selectedItemIndex - 1] : null;
  const nextItem =
    selectedItemIndex >= 0 && selectedItemIndex < activeNavigationItems.length - 1
      ? activeNavigationItems[selectedItemIndex + 1]
      : null;

  useEffect(() => {
    if (!activeNavigationItems.length) {
      if (!pendingReaderItemId && !loadingReader) {
        setSelectedItemId("");
      }
      return;
    }

    const pendingItem = pendingReaderItemId
      ? activeNavigationItems.find((item) => item.id === pendingReaderItemId)
      : null;

    if (pendingReaderItemId && pendingItem) {
      setSelectedItemId(pendingItem.id);
      setSelectedSubscriptionId(pendingItem.subscriptionId);
      setPendingReaderItemId("");

      if (readerNavigationMode === "pure") {
        setExpandedReaderDate(buildReaderDateGroupKey(pendingItem.publishedAt));
      } else {
        setExpandedSubscriptionId(pendingItem.subscriptionId);
      }
      return;
    }

    if (pendingReaderItemId && !pendingItem) {
      setPendingReaderItemId("");
      const fallbackItem = activeNavigationItems[0];
      setSelectedItemId(fallbackItem?.id || "");

      if ((readerNavigationMode === "pure" || readerNavigationMode === "search") && fallbackItem) {
        setSelectedSubscriptionId(fallbackItem.subscriptionId);
      }
      return;
    }

    if (!activeNavigationItems.some((item) => item.id === selectedItemId)) {
      const fallbackItem = pendingReaderItemId ? null : activeNavigationItems[0];
      setSelectedItemId(fallbackItem?.id || "");

      if ((readerNavigationMode === "pure" || readerNavigationMode === "search") && fallbackItem) {
        setSelectedSubscriptionId(fallbackItem.subscriptionId);
      }
    }
  }, [activeNavigationItems, loadingReader, pendingReaderItemId, readerNavigationMode, selectedItemId]);

  useEffect(() => {
    if (readerNavigationMode !== "pure") {
      return;
    }

    if (!visibleReaderDateGroups.length) {
      setExpandedReaderDate("");
      return;
    }

    if (expandedReaderDate && !visibleReaderDateGroups.some((group) => group.dateKey === expandedReaderDate)) {
      setExpandedReaderDate(visibleReaderDateGroups[0]?.dateKey || "");
    }
  }, [expandedReaderDate, readerNavigationMode, visibleReaderDateGroups]);

  useEffect(() => {
    if (!selectedItemId || typeof window === "undefined") {
      return;
    }

    window.requestAnimationFrame(() => {
      const navigationItem = Array.from(
        document.querySelectorAll<HTMLElement>("[data-reader-nav-item-id]"),
      ).find((element) => element.dataset.readerNavItemId === selectedItemId);

      navigationItem?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "smooth",
      });
    });
  }, [expandedReaderDate, expandedSubscriptionId, readerNavigationMode, selectedItemId]);

  useEffect(() => {
    setIsSourceDrawerOpen(false);
  }, [selectedSubscriptionId]);

  function scrollArticleViewportToTop() {
    if (typeof window === "undefined") {
      return;
    }

    window.requestAnimationFrame(() => {
      articleScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    });
  }

  function handleSelectItem(itemId: string) {
    setPendingReaderItemId("");
    setSelectedItemId(itemId);
    setIsSourceDrawerOpen(false);
    scrollArticleViewportToTop();
  }

  function handleSelectPureItem(item: FeedItem) {
    setPendingReaderItemId("");
    setSelectedSubscriptionId(item.subscriptionId);
    setSelectedItemId(item.id);
    setExpandedReaderDate(buildReaderDateGroupKey(item.publishedAt));
    setIsSourceDrawerOpen(false);
    scrollArticleViewportToTop();
  }

  function handleSelectSearchItem(item: FeedItem) {
    setPendingReaderItemId("");
    setSelectedSubscriptionId(item.subscriptionId);
    setSelectedItemId(item.id);
    setExpandedSubscriptionId(item.subscriptionId);
    setIsSourceDrawerOpen(false);
    scrollArticleViewportToTop();
  }

  function handleSelectSearchSource(subscriptionId: string) {
    setSelectedSubscriptionId(subscriptionId);
    setExpandedSubscriptionId(subscriptionId);
    setIsSourceDrawerOpen(false);
  }

  function handleSelectSource(subscriptionId: string) {
    if (expandedSubscriptionId === subscriptionId) {
      setExpandedSubscriptionId("");
      return;
    }

    setSelectedSubscriptionId(subscriptionId);
    setExpandedSubscriptionId(subscriptionId);
    setIsSourceDrawerOpen(false);
  }

  function handleNavigateArticle(item: FeedItem | null) {
    if (!item) {
      return;
    }

    setPendingReaderItemId("");
    setSelectedItemId(item.id);
    setSelectedSubscriptionId(item.subscriptionId);

    if (readerNavigationMode === "pure") {
      setExpandedReaderDate(buildReaderDateGroupKey(item.publishedAt));
    } else {
      setExpandedSubscriptionId(item.subscriptionId);
    }

    scrollArticleViewportToTop();
  }

  function handleSelectReaderNavigationMode(nextMode: ReaderBaseNavigationMode) {
    setReaderBaseNavigationMode(nextMode);

    if (!hasSourceFilterInput) {
      setReaderNavigationMode(nextMode);
    }

    if (nextMode === "pure") {
      const selectedGroupKey = selectedItem ? buildReaderDateGroupKey(selectedItem.publishedAt) : "";
      const fallbackGroupKey = visibleReaderDateGroups[0]?.dateKey || "";
      setExpandedReaderDate(
        selectedGroupKey && visibleReaderDateGroups.some((group) => group.dateKey === selectedGroupKey)
          ? selectedGroupKey
          : fallbackGroupKey,
      );
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }

      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }

      if (isKeyboardEventFromEditableTarget(event) || document.querySelector(".reader-image-viewer")) {
        return;
      }

      const targetItem = event.key === "ArrowLeft" ? previousItem : nextItem;

      if (!targetItem) {
        return;
      }

      event.preventDefault();
      handleNavigateArticle(targetItem);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nextItem, previousItem, readerNavigationMode]);

  function handleToggleImageEnhancement() {
    setShouldEnhanceImageUrls((currentValue) => {
      const nextValue = !currentValue;
      writeStoredArticleImageEnhancementEnabled(nextValue);
      return nextValue;
    });
  }

  return (
    <section className="content-panel reader-panel">
      <div className="reader-layout">
        <aside className={`reader-sidebar${isSourceDrawerOpen ? " is-open" : ""}`} aria-label="订阅源导航">
          {enabledSubscriptions.length ? (
            <div className="reader-sidebar-filter">
              <div className="reader-filter-field">
                <span className="reader-filter-icon" aria-hidden="true" />
                <input
                  type="search"
                  value={sourceFilterQuery}
                  onChange={(event) => setSourceFilterQuery(event.target.value)}
                  placeholder="快速搜索关键字"
                  aria-label="过滤文章标题和订阅源名称"
                />
                {sourceFilterQuery ? (
                  <button
                    type="button"
                    className="reader-filter-clear"
                    onClick={() => {
                      setSourceFilterQuery("");
                      setDebouncedSourceFilterQuery("");
                    }}
                    aria-label="清空过滤"
                  >
                    ×
                  </button>
                ) : null}
              </div>
              <div className="reader-filter-category-list" role="listbox" aria-label="按类型过滤订阅源">
                <button
                  type="button"
                  className={sourceFilterCategory ? "reader-filter-category-chip" : "reader-filter-category-chip is-active"}
                  aria-selected={!sourceFilterCategory}
                  onClick={() => setSourceFilterCategory("")}
                >
                  全部类型 · {enabledSubscriptions.length}
                </button>
                {readerFilterCategoryOptions.map((category) => (
                  <button
                    type="button"
                    key={category.id}
                    className={
                      sourceFilterCategory === category.id
                        ? "reader-filter-category-chip is-active"
                        : "reader-filter-category-chip"
                    }
                    aria-selected={sourceFilterCategory === category.id}
                    onClick={() => setSourceFilterCategory(category.id)}
                  >
                    {category.label} · {category.count}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {enabledSubscriptions.length && readerNavigationMode === "search" ? (
            <div className="source-status-grid reader-title-search-grid">
              {isSourceFilterPending ? (
                <div className="reader-filter-empty">
                  <span>正在搜索...</span>
                </div>
              ) : null}
              {!isSourceFilterPending
                ? sourceSearchStates.map((sourceState) => (
                    <div className="reader-source-entry" key={`source-${sourceState.subscriptionId}`}>
                      <ReaderSourceCard
                        sourceState={sourceState}
                        isActive={sourceState.subscriptionId === selectedSubscriptionId}
                        isExpanded={false}
                        onSelect={handleSelectSearchSource}
                      />
                    </div>
                  ))
                : null}
              {!isSourceFilterPending
                ? readerSearchItems.map((item) => (
                    <ReaderPureListCard
                      key={item.id}
                      item={item}
                      isActive={item.id === selectedItemId}
                      onSelect={handleSelectSearchItem}
                    />
                  ))
                : null}
              {!isSourceFilterPending && !sourceSearchStates.length && !readerSearchItems.length ? (
                <div className="reader-filter-empty">
                  <span>没有匹配的文章或订阅源</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {enabledSubscriptions.length && readerNavigationMode === "traditional" ? (
            <div className="source-status-grid">
              {visibleSourceStateList.map(({ sourceState, matchingItems }) => {
                const isSourceActive = sourceState.subscriptionId === selectedSubscriptionId;
                const isSourceExpanded = sourceState.subscriptionId === expandedSubscriptionId;
                const shouldShowFilteredSublist = Boolean(normalizedSourceFilterQuery && matchingItems.length);
                const visibleItems = shouldShowFilteredSublist ? matchingItems : isSourceActive ? filteredSelectedSourceItems : [];

                return (
                  <div className="reader-source-entry" key={sourceState.subscriptionId}>
                    <ReaderSourceCard
                      sourceState={sourceState}
                      isActive={isSourceActive}
                      isExpanded={isSourceExpanded || shouldShowFilteredSublist}
                      onSelect={handleSelectSource}
                    />
                    {visibleItems.length ? (
                      <div
                        className={`reader-source-article-sublist${isSourceExpanded || shouldShowFilteredSublist ? " is-expanded" : ""}`}
                        aria-label={`${sourceState.subscriptionName} 文章列表`}
                      >
                        {visibleItems.map((item) => (
                          <ReaderListCard
                            key={item.id}
                            item={item}
                            isActive={item.id === selectedItemId}
                            onSelect={handleSelectItem}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {hasSourceCategoryFilter && !visibleSourceStateList.length ? (
                <div className="reader-filter-empty">
                  <span>没有匹配的订阅源</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {enabledSubscriptions.length && readerNavigationMode === "pure" ? (
            <div className="source-status-grid reader-pure-grid">
              {visibleReaderDateGroups.map((dateGroup) => {
                const isDateExpanded = dateGroup.dateKey === expandedReaderDate;

                return (
                  <div className="reader-source-entry reader-pure-date-entry" key={dateGroup.dateKey}>
                    <button
                      type="button"
                      className={`source-status-card source-index-card reader-pure-date-card${
                        isDateExpanded ? " is-active is-expanded" : ""
                      }`}
                      aria-expanded={isDateExpanded}
                      onClick={() => setExpandedReaderDate(isDateExpanded ? "" : dateGroup.dateKey)}
                    >
                      <div className="source-index-meta">
                        <span>按更新时间排序</span>
                      </div>
                      <div className="source-index-main">
                        <h3>{dateGroup.dateLabel}</h3>
                        <span className="source-index-count">{dateGroup.items.length}</span>
                      </div>
                    </button>
                    {isDateExpanded && dateGroup.items.length ? (
                      <div
                        className="reader-source-article-sublist reader-pure-article-sublist is-expanded"
                        aria-label={`${dateGroup.dateLabel} 文章列表`}
                      >
                        {dateGroup.items.map((item) => (
                          <ReaderPureListCard
                            key={item.id}
                            item={item}
                            isActive={item.id === selectedItemId}
                            onSelect={handleSelectPureItem}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {hasSourceCategoryFilter && !visibleReaderDateGroups.length ? (
                <div className="reader-filter-empty">
                  <span>没有匹配的文章</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {!subscriptions.length ? (
            <div className="empty-state compact">
              <div>
                <h3>还没有订阅源</h3>
                <p>先去“管理订阅源”添加一个 RSSHub 路径，例如 `/github/trending/daily/javascript`。</p>
              </div>
            </div>
          ) : null}

          {subscriptions.length > 0 && !enabledSubscriptions.length ? (
            <div className="empty-state compact">
              <div>
                <h3>暂无启用中的订阅源</h3>
                <p>去“管理订阅源”打开至少一个用户订阅源后，这里才会显示拉取状态和文章。</p>
              </div>
            </div>
          ) : null}

          {enabledSubscriptions.length && readerNavigationMode !== "search" ? (
	            <div className="reader-sidebar-mode-switch" role="group" aria-label="导航模式">
	              <button
	                type="button"
	                className={readerBaseNavigationMode === "pure" ? "is-active" : ""}
	                aria-pressed={readerBaseNavigationMode === "pure"}
	                onClick={() => handleSelectReaderNavigationMode("pure")}
	              >
	                纯享模式
	              </button>
	              <button
	                type="button"
	                className={readerBaseNavigationMode === "traditional" ? "is-active" : ""}
	                aria-pressed={readerBaseNavigationMode === "traditional"}
	                onClick={() => handleSelectReaderNavigationMode("traditional")}
	              >
	                传统模式
	              </button>
	            </div>
          ) : null}

        </aside>
        <button
          type="button"
          className={`reader-source-drawer-backdrop${isSourceDrawerOpen ? " is-open" : ""}`}
          aria-label="关闭订阅源导航"
          onClick={() => setIsSourceDrawerOpen(false)}
        />

        <div className="reader-main">
          {selectedSourceState ? (
            <div className="reader-main-toolbar">
              <button
                type="button"
                className="reader-source-drawer-trigger"
                aria-label="打开订阅源导航"
                aria-expanded={isSourceDrawerOpen}
                onClick={() => setIsSourceDrawerOpen(true)}
              >
                <span className="reader-item-overlay-trigger-icon" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="reader-source-drawer-trigger-text">订阅源</span>
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void refreshReaderSubscription(selectedSourceState.subscriptionId)}
                disabled={selectedSourceState.status === "loading" || reloadingSourceId === selectedSourceState.subscriptionId}
              >
                {reloadingSourceId === selectedSourceState.subscriptionId
                  ? `重新拉取 ${selectedSourceState.subscriptionName} 中...`
                  : `重新拉取 ${selectedSourceState.subscriptionName}`}
              </button>
              <button
                type="button"
                className={`secondary-button reader-image-enhancement-toggle${shouldEnhanceImageUrls ? " is-active" : ""}`}
                aria-pressed={shouldEnhanceImageUrls}
                onClick={handleToggleImageEnhancement}
              >
                图片增强{shouldEnhanceImageUrls ? "开" : "关"}
              </button>
            </div>
          ) : null}

          {selectedSourceState && !filteredItems.length && !loadingReader && reloadingSourceId !== selectedSourceState.subscriptionId ? (
            <div className="empty-state compact">
              <div>
                <h3>这个订阅源暂时没有文章</h3>
                <p>可能是源本身暂无更新，或 RSSHub 路径还未返回条目。</p>
              </div>
            </div>
          ) : null}

          {selectedItem ? (
            <div className="reader-detail-layout">
              <div ref={articleScrollRef} className="reader-article-stream">
                <ReaderArticleCard item={selectedItem} isActive shouldEnhanceImageUrls={shouldEnhanceImageUrls} />
                <nav className="reader-article-pagination" aria-label="文章翻页">
                  <button
                    type="button"
                    className="reader-article-page-button"
                    onClick={() => handleNavigateArticle(previousItem)}
                    disabled={!previousItem}
                  >
                    <span>上一篇</span>
                    <strong>{previousItem?.title || "没有上一篇"}</strong>
                  </button>
                  <button
                    type="button"
                    className="reader-article-page-button"
                    onClick={() => handleNavigateArticle(nextItem)}
                    disabled={!nextItem}
                  >
                    <span>下一篇</span>
                    <strong>{nextItem?.title || "没有下一篇"}</strong>
                  </button>
                </nav>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SourceManagerCard({
  subscription,
  isSaving,
  isRemoving,
  speedTestResult,
  canToggle = true,
  canRemove = true,
  actionLabel = "编辑",
  onEdit,
  onToggle,
  onRemove,
}: {
  subscription: Subscription;
  isSaving: boolean;
  isRemoving: boolean;
  speedTestResult?: SpeedTestResult;
  canToggle?: boolean;
  canRemove?: boolean;
  actionLabel?: string;
  onEdit: (subscription: Subscription) => void;
  onToggle: (subscription: Subscription, enabled: boolean) => void;
  onRemove: (subscription: Subscription) => void;
}) {
  return (
    <article className="source-card">
      <div className="source-card-head">
        <div>
          <h3>{subscription.name}</h3>
          <span>{subscription.routePath}</span>
        </div>
        <div className="source-card-actions">
          {canToggle ? (
            <button
              type="button"
              className={subscription.enabled ? "toggle-switch is-on" : "toggle-switch"}
              aria-pressed={subscription.enabled}
              aria-label={subscription.enabled ? `停用 ${subscription.name}` : `启用 ${subscription.name}`}
              onClick={() => onToggle(subscription, !subscription.enabled)}
              disabled={isSaving || isRemoving}
            >
              <span className="toggle-switch-handle" />
            </button>
          ) : null}
          <button type="button" className="ghost-button" onClick={() => onEdit(subscription)}>
            {actionLabel}
          </button>
          {canRemove ? (
            <button type="button" className="ghost-button danger" onClick={() => onRemove(subscription)} disabled={isSaving || isRemoving}>
              {isRemoving ? "删除中..." : "删除"}
            </button>
          ) : null}
        </div>
      </div>
      <p>{subscription.description || "未填写说明，可以把它当作你自己的订阅备注。"}</p>
      <small>
        {getSubscriptionCategories(subscription).join(" / ")} · {subscription.enabled ? "已启用" : "已停用"} · 最近更新：{formatDateLabel(subscription.updatedAt)}
      </small>
      {speedTestResult ? (
        <span className={`source-speed-badge is-${speedTestResult.status}`}>
          {speedTestResult.status === "testing" ? "测速中" : speedTestResult.status === "success" ? `${speedTestResult.ms}ms` : "失败"}
        </span>
      ) : null}
    </article>
  );
}

function SubscriptionManagementPanel({
  mode,
  title,
  emptyTitle,
  emptyDescription,
  emptyCategoryDescription,
  allowCategoryCreate,
  allowSourceCreate,
}: {
  mode: "sources" | "rsshub";
  title: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyCategoryDescription: string;
  allowCategoryCreate: boolean;
  allowSourceCreate: boolean;
}) {
  const categories = useAppStore((state) => state.categories);
  const subscriptions = useAppStore((state) => state.subscriptions);
  const savingSource = useAppStore((state) => state.savingSource);
  const creatingCategory = useAppStore((state) => state.creatingCategory);
  const removingSourceId = useAppStore((state) => state.removingSourceId);
  const importingSources = useAppStore((state) => state.importingSources);
  const exportingSources = useAppStore((state) => state.exportingSources);
  const saveSource = useAppStore((state) => state.saveSource);
  const exportSourcesBackup = useAppStore((state) => state.exportSourcesBackup);
  const importSourcesBackup = useAppStore((state) => state.importSourcesBackup);
  const createSourceCategory = useAppStore((state) => state.createSourceCategory);
  const renameSourceCategory = useAppStore((state) => state.renameSourceCategory);
  const deleteSourceCategory = useAppStore((state) => state.deleteSourceCategory);
  const testSource = useAppStore((state) => state.testSource);
  const setCurrentTab = useAppStore((state) => state.setCurrentTab);
  const toggleSourceEnabled = useAppStore((state) => state.toggleSourceEnabled);
  const removeSource = useAppStore((state) => state.removeSource);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCategoryManagerOpen, setIsCategoryManagerOpen] = useState(false);
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [managedCategoryName, setManagedCategoryName] = useState("");
  const [managedCategoryDraft, setManagedCategoryDraft] = useState("");
  const [managedNewCategoryName, setManagedNewCategoryName] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(() =>
    typeof window === "undefined" ? "" : parseAppLocation(window.location.href).category,
  );
  const [editingSubscriptionId, setEditingSubscriptionId] = useState("");
  const [form, setForm] = useState<SubscriptionInput>(buildEmptyForm);
  const [speedTestResults, setSpeedTestResults] = useState<Record<string, SpeedTestResult>>({});
  const [isSpeedTesting, setIsSpeedTesting] = useState(false);
  const [speedTestProgress, setSpeedTestProgress] = useState({ completed: 0, total: 0 });
  const [backupImportUrl, setBackupImportUrl] = useState("");
  const backupImportInputRef = useRef<HTMLInputElement | null>(null);
  const isRsshubMode = mode === "rsshub";
  const usesCategorySidebar = isRsshubMode;
  const panelSubscriptions = useMemo(
    () => subscriptions.filter((subscription) => isRsshubDocSubscription(subscription) === isRsshubMode),
    [isRsshubMode, subscriptions],
  );
  const panelCategories = useMemo(
    () => buildVisibleCategories(subscriptions, categories, isRsshubMode),
    [categories, isRsshubMode, subscriptions],
  );
  const buildCategoryUrl = isRsshubMode ? buildUrlForRsshubCategory : buildUrlForSourcesCategory;

  function resetForm() {
    setIsModalOpen(false);
    setEditingSubscriptionId("");
    setForm(buildEmptyForm());
  }

  function resolveDefaultSourceCategory() {
    return DEFAULT_SOURCE_CATEGORY;
  }

  function handleCreate() {
    const defaultCategory = resolveDefaultSourceCategory();

    setEditingSubscriptionId("");
    setForm({
      ...buildEmptyForm(),
      category: defaultCategory,
      categories: defaultCategory ? [defaultCategory] : [],
    });
    setIsModalOpen(true);
  }

  function handleCreateFromRsshubDraft(draft: SubscriptionInput) {
    writeSourceDraft({
      ...buildEmptyForm(),
      name: draft.name,
      routePath: draft.routePath,
      description: draft.description,
      enabled: true,
    });

    resetForm();

    if (typeof window !== "undefined") {
      window.history.pushState({}, "", buildUrlForTab(window.location.href, "sources"));
    }

    setCurrentTab("sources");
  }

  function handleStartCategoryCreate() {
    setIsCreatingCategory(true);
    setNewCategoryName("");
  }

  function handleCancelCategoryCreate() {
    setIsCreatingCategory(false);
    setNewCategoryName("");
  }

  function handleEdit(subscription: Subscription) {
    setEditingSubscriptionId(subscription.id);
    setForm({
      category: subscription.category,
      categories: getSubscriptionCategories(subscription),
      name: subscription.name,
      routePath: subscription.routePath,
      routeTemplate: subscription.routeTemplate,
      description: subscription.description,
      enabled: subscription.enabled,
    });
    setIsModalOpen(true);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextCategories = getInputCategories(form);
    const succeeded = await saveSource(
      {
        category: nextCategories[0] || form.category.trim(),
        categories: nextCategories,
        name: form.name.trim(),
        routePath: form.routePath.trim(),
        routeTemplate: form.routeTemplate?.trim() || "",
        description: form.description.trim(),
        enabled: form.enabled,
      },
      editingSubscriptionId || undefined,
    );

    if (succeeded) {
      resetForm();
    }
  }

  async function handleCreateCategory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = newCategoryName.trim();

    if (!normalizedName) {
      return;
    }

    const createdCategory = await createSourceCategory(normalizedName);

    if (createdCategory) {
      if (typeof window !== "undefined") {
        window.history.pushState({}, "", buildCategoryUrl(window.location.href, createdCategory));
      }
      setSelectedCategory(createdCategory);
      handleCancelCategoryCreate();
    }
  }

  function handleSelectCategory(categoryId: string) {
    if (typeof window !== "undefined") {
      window.history.pushState({}, "", buildCategoryUrl(window.location.href, categoryId));
    }

    setSelectedCategory(categoryId);
  }

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, { totalCount: number; enabledCount: number }>();
    const totalCounts = { totalCount: 0, enabledCount: 0 };

    for (const subscription of panelSubscriptions) {
      totalCounts.totalCount += 1;
      totalCounts.enabledCount += subscription.enabled ? 1 : 0;

      for (const category of getSubscriptionCategories(subscription)) {
        const currentCounts = counts.get(category) || { totalCount: 0, enabledCount: 0 };
        counts.set(category, {
          totalCount: currentCounts.totalCount + 1,
          enabledCount: currentCounts.enabledCount + (subscription.enabled ? 1 : 0),
        });
      }
    }

    const categoryItems = panelCategories.map((category) => {
      const categoryCounts = counts.get(category) || { totalCount: 0, enabledCount: 0 };
      const label = isRsshubMode ? category.replace(/^RSSHub 文档\s*\/\s*/, "") : category;

      return {
        id: category,
        label,
        countLabel: isRsshubMode ? String(categoryCounts.totalCount) : `${categoryCounts.enabledCount}/${categoryCounts.totalCount}`,
      };
    });

    if (!usesCategorySidebar) {
      return [
        {
          id: ALL_SOURCES_CATEGORY,
          label: "全部类型",
          countLabel: `${totalCounts.enabledCount}/${totalCounts.totalCount}`,
        },
        ...categoryItems,
      ];
    }

    return categoryItems;
  }, [isRsshubMode, panelCategories, panelSubscriptions, usesCategorySidebar]);

  const managedCategoryOptions = useMemo(() => {
    const counts = new Map<string, { totalCount: number; enabledCount: number }>();

    for (const subscription of panelSubscriptions) {
      for (const category of getSubscriptionCategories(subscription)) {
        const currentCounts = counts.get(category) || { totalCount: 0, enabledCount: 0 };
        counts.set(category, {
          totalCount: currentCounts.totalCount + 1,
          enabledCount: currentCounts.enabledCount + (subscription.enabled ? 1 : 0),
        });
      }
    }

    return panelCategories.map((category) => {
      const categoryCounts = counts.get(category) || { totalCount: 0, enabledCount: 0 };

      return {
        id: category,
        label: category,
        countLabel: `${categoryCounts.enabledCount}/${categoryCounts.totalCount}`,
        totalCount: categoryCounts.totalCount,
      };
    });
  }, [panelCategories, panelSubscriptions]);

  const activeCategory = useMemo(
    () => {
      if (!usesCategorySidebar) {
        return selectedCategory && selectedCategory !== ALL_SOURCES_CATEGORY && panelCategories.includes(selectedCategory)
          ? selectedCategory
          : ALL_SOURCES_CATEGORY;
      }

      return resolveAvailableSourcesCategory(selectedCategory, panelCategories);
    },
    [panelCategories, selectedCategory, usesCategorySidebar],
  );

  useEffect(() => {
    function syncCategoryFromLocation() {
      if (typeof window === "undefined") {
        return;
      }

      const locationState = parseAppLocation(window.location.href);

      if (locationState.tab === mode) {
        setSelectedCategory(locationState.category);
      }
    }

    syncCategoryFromLocation();
    window.addEventListener("popstate", syncCategoryFromLocation);
    window.addEventListener("hashchange", syncCategoryFromLocation);

    return () => {
      window.removeEventListener("popstate", syncCategoryFromLocation);
      window.removeEventListener("hashchange", syncCategoryFromLocation);
    };
  }, [mode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const nextCategory = usesCategorySidebar
      ? resolveAvailableSourcesCategory(selectedCategory, panelCategories)
      : selectedCategory && selectedCategory !== ALL_SOURCES_CATEGORY && panelCategories.includes(selectedCategory)
        ? selectedCategory
        : ALL_SOURCES_CATEGORY;
    const locationState = parseAppLocation(window.location.href);

    if (locationState.tab !== mode) {
      return;
    }

    if (selectedCategory !== nextCategory) {
      setSelectedCategory(nextCategory);
    }

    if (!nextCategory) {
      return;
    }

    if (locationState.category !== nextCategory) {
      window.history.replaceState({}, "", buildCategoryUrl(window.location.href, nextCategory));
    }
  }, [buildCategoryUrl, mode, panelCategories, selectedCategory, usesCategorySidebar]);

  useEffect(() => {
    if (isRsshubMode || isModalOpen) {
      return;
    }

    const sourceDraft = readSourceDraft();

    if (!sourceDraft) {
      return;
    }

    setEditingSubscriptionId("");
    setForm({
      ...sourceDraft,
      category: resolveDefaultSourceCategory(),
      categories: sourceDraft.categories?.length ? sourceDraft.categories : [resolveDefaultSourceCategory()].filter(Boolean),
    });
    setIsModalOpen(true);
  }, [isModalOpen, isRsshubMode, panelCategories, selectedCategory]);

  const filteredSubscriptions = useMemo(
    () =>
      activeCategory === ALL_SOURCES_CATEGORY
        ? panelSubscriptions
        : panelSubscriptions.filter((subscription) => getSubscriptionCategories(subscription).includes(activeCategory)),
    [activeCategory, panelSubscriptions],
  );

  async function handleSpeedTestVisibleSubscriptions() {
    if (isSpeedTesting || !filteredSubscriptions.length) {
      return;
    }

    const targets = filteredSubscriptions.filter((subscription) => !isRsshubDocSubscription(subscription));

    if (!targets.length) {
      return;
    }

    setIsSpeedTesting(true);
    setSpeedTestProgress({ completed: 0, total: targets.length });
    setSpeedTestResults((current) => {
      const next = { ...current };

      for (const subscription of targets) {
        next[subscription.id] = { status: "testing" };
      }

      return next;
    });

    let cursor = 0;
    let completed = 0;
    const workerCount = Math.min(4, targets.length);

    async function runWorker() {
      while (cursor < targets.length) {
        const subscription = targets[cursor];
        cursor += 1;
        const startedAt = performance.now();

        try {
          await testSource({
            category: subscription.category,
            categories: getSubscriptionCategories(subscription),
            name: subscription.name,
            routePath: subscription.routePath,
            routeTemplate: subscription.routeTemplate,
            description: subscription.description,
            enabled: subscription.enabled,
          });
          const elapsedMs = Math.max(1, Math.round(performance.now() - startedAt));
          setSpeedTestResults((current) => ({
            ...current,
            [subscription.id]: { status: "success", ms: elapsedMs },
          }));
        } catch {
          setSpeedTestResults((current) => ({
            ...current,
            [subscription.id]: { status: "error" },
          }));
        } finally {
          completed += 1;
          setSpeedTestProgress({ completed, total: targets.length });
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    setIsSpeedTesting(false);
  }

  async function handleCreateManagedCategory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = managedNewCategoryName.trim();

    if (!normalizedName) {
      return;
    }

    const createdCategory = await createSourceCategory(normalizedName);

    if (createdCategory) {
      setManagedNewCategoryName("");
      if (typeof window !== "undefined") {
        window.history.pushState({}, "", buildCategoryUrl(window.location.href, createdCategory));
      }
      setSelectedCategory(createdCategory);
    }
  }

  function handleStartManagedCategoryEdit(categoryName: string) {
    setManagedCategoryName(categoryName);
    setManagedCategoryDraft(categoryName);
  }

  function handleCancelManagedCategoryEdit() {
    setManagedCategoryName("");
    setManagedCategoryDraft("");
  }

  async function handleSaveManagedCategory(currentName: string) {
    const nextName = managedCategoryDraft.trim();

    if (!nextName || nextName === currentName) {
      handleCancelManagedCategoryEdit();
      return;
    }

    const succeeded = await renameSourceCategory(currentName, nextName);

    if (succeeded) {
      if (activeCategory === currentName) {
        if (typeof window !== "undefined") {
          window.history.pushState({}, "", buildCategoryUrl(window.location.href, nextName));
        }
        setSelectedCategory(nextName);
      }
      handleCancelManagedCategoryEdit();
    }
  }

  async function handleDeleteManagedCategory(categoryName: string) {
    const confirmed = window.confirm(`删除类型「${categoryName}」？仅属于该类型的订阅源会移动到「未分类」。`);

    if (!confirmed) {
      return;
    }

    const succeeded = await deleteSourceCategory(categoryName);

    if (succeeded && activeCategory === categoryName) {
      if (typeof window !== "undefined") {
        window.history.pushState({}, "", buildCategoryUrl(window.location.href, ALL_SOURCES_CATEGORY));
      }
      setSelectedCategory(ALL_SOURCES_CATEGORY);
    }
  }

  async function handleExportSourcesBackup() {
    const backup = await exportSourcesBackup();

    if (!backup || typeof window === "undefined") {
      return;
    }

    const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    link.href = url;
    link.download = `garss-subscriptions-backup-${timestamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  }

  async function handleImportSourcesBackup(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    const confirmed = window.confirm("导入备份会替换当前用户订阅源和启用状态，RSSHub 文档模板会保留。确定继续？");

    if (!confirmed) {
      return;
    }

    try {
      const text = await file.text();
      const backup = JSON.parse(text) as SubscriptionsBackup;
      const succeeded = await importSourcesBackup(backup);

      if (succeeded) {
        if (typeof window !== "undefined") {
          window.history.pushState({}, "", buildCategoryUrl(window.location.href, ALL_SOURCES_CATEGORY));
        }
        setSelectedCategory(ALL_SOURCES_CATEGORY);
      }
    } catch {
      window.alert("备份文件不是有效的 JSON，请选择通过 GARSS 导出的订阅源备份。");
    }
  }

  async function handleImportSourcesBackupFromUrl(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sourceUrl = backupImportUrl.trim();

    if (!sourceUrl) {
      return;
    }

    const confirmed = window.confirm("将从 URL 导入备份并替换当前用户订阅源和启用状态，RSSHub 文档模板会保留。确定继续？");

    if (!confirmed) {
      return;
    }

    const succeeded = await importSourcesBackup({ sourceUrl });

    if (succeeded) {
      setBackupImportUrl("");
      if (typeof window !== "undefined") {
        window.history.pushState({}, "", buildCategoryUrl(window.location.href, ALL_SOURCES_CATEGORY));
      }
      setSelectedCategory(ALL_SOURCES_CATEGORY);
    }
  }

  return (
    <section className="content-panel sources-panel">
      <div className={`sources-layout${usesCategorySidebar ? "" : " is-flat"}`}>
        {usesCategorySidebar ? (
          <aside className="sources-sidebar">
            <div className="sources-sidebar-head">
              <div className="sources-sidebar-title">
                <span>{title}</span>
                {allowCategoryCreate ? (
                  <button
                    type="button"
                    className="category-create-trigger"
                    onClick={handleStartCategoryCreate}
                    aria-label="创建新类型"
                    disabled={isCreatingCategory}
                  >
                    +
                  </button>
                ) : null}
              </div>
            </div>
            <div className="category-list">
              {allowCategoryCreate && isCreatingCategory ? (
                <form className="category-create-inline" onSubmit={handleCreateCategory}>
                  <input
                    type="text"
                    autoFocus
                    value={newCategoryName}
                    onChange={(event) => setNewCategoryName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        handleCancelCategoryCreate();
                      }
                    }}
                    placeholder="新建类型"
                  />
                  <div className="category-create-actions">
                    <button type="submit" className="inline-action-button" disabled={creatingCategory || !newCategoryName.trim()}>
                      {creatingCategory ? "创建中" : "保存"}
                    </button>
                    <button type="button" className="inline-action-button is-muted" onClick={handleCancelCategoryCreate}>
                      取消
                    </button>
                  </div>
                </form>
              ) : null}
              {categoryOptions.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={activeCategory === category.id ? "category-item is-active" : "category-item"}
                  onClick={() => handleSelectCategory(category.id)}
                >
                  <span>{category.label}</span>
                  <strong>{category.countLabel}</strong>
                </button>
              ))}
            </div>
          </aside>
        ) : null}

        <div className="source-list">
          {allowSourceCreate ? (
            <div className="source-list-toolbar">
              <button type="button" className="manage-category-button" onClick={() => setIsCategoryManagerOpen(true)}>
                管理类型
              </button>
              <label className="source-filter-control">
                <span>类型</span>
                <select value={activeCategory} onChange={(event) => handleSelectCategory(event.target.value)}>
                  {categoryOptions.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label} · {category.countLabel}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="primary-button" onClick={handleCreate}>
                新增订阅源
              </button>
              <button
                type="button"
                className="secondary-button source-speed-test-button"
                onClick={() => void handleSpeedTestVisibleSubscriptions()}
                disabled={isSpeedTesting || !filteredSubscriptions.length}
              >
                {isSpeedTesting ? `测速中 ${speedTestProgress.completed}/${speedTestProgress.total}` : "一键测速"}
              </button>
            </div>
          ) : null}
          {filteredSubscriptions.length ? (
            filteredSubscriptions.map((subscription) => (
              <SourceManagerCard
                key={subscription.id}
                subscription={subscription}
                isSaving={savingSource}
                isRemoving={removingSourceId === subscription.id}
                speedTestResult={speedTestResults[subscription.id]}
                canToggle={!isRsshubMode}
                canRemove={!isRsshubMode}
                actionLabel={isRsshubMode ? "查看" : "编辑"}
                onEdit={handleEdit}
                onToggle={(target, enabled) => void toggleSourceEnabled(target.id, enabled)}
                onRemove={(target) => void removeSource(target.id)}
              />
            ))
          ) : (
            <div className="empty-state compact">
              <div>
                <h3>{panelSubscriptions.length ? "这个类型下还没有订阅源" : emptyTitle}</h3>
                <p>{panelSubscriptions.length ? emptyCategoryDescription : emptyDescription}</p>
              </div>
            </div>
          )}
          {allowSourceCreate ? (
            <div className="source-backup-toolbar" aria-label="订阅源备份">
              <div className="source-backup-copy">
                <strong>订阅源备份</strong>
                <span>导出或恢复订阅源、类型和启用状态。</span>
              </div>
              <form className="source-backup-url-form" onSubmit={(event) => void handleImportSourcesBackupFromUrl(event)}>
                <input
                  type="url"
                  value={backupImportUrl}
                  onChange={(event) => setBackupImportUrl(event.target.value)}
                  placeholder="粘贴备份 JSON URL"
                  aria-label="备份 JSON URL"
                />
                <button
                  type="submit"
                  className="secondary-button source-backup-button"
                  disabled={savingSource || importingSources || exportingSources || !backupImportUrl.trim()}
                >
                  URL 导入
                </button>
              </form>
              <div className="source-backup-actions">
                <input
                  ref={backupImportInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="source-backup-file-input"
                  onChange={(event) => void handleImportSourcesBackup(event)}
                />
                <button
                  type="button"
                  className="secondary-button source-backup-button"
                  onClick={() => backupImportInputRef.current?.click()}
                  disabled={savingSource || importingSources || exportingSources}
                >
                  {importingSources ? "导入中..." : "本地导入"}
                </button>
                <button
                  type="button"
                  className="primary-button source-backup-button"
                  onClick={() => void handleExportSourcesBackup()}
                  disabled={savingSource || importingSources || exportingSources || !panelSubscriptions.length}
                >
                  {exportingSources ? "导出中..." : "导出备份"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {isModalOpen ? (
        <SubscriptionEditorModal
          categories={panelCategories}
          form={form}
          savingSource={savingSource}
          editingSubscriptionId={editingSubscriptionId}
          viewOnly={isRsshubMode}
          onClose={resetForm}
          onSubmit={handleSubmit}
          onFormChange={(updater) => setForm((current) => updater(current))}
          onTestSubscription={testSource}
          onCreateSubscriptionDraft={isRsshubMode ? handleCreateFromRsshubDraft : undefined}
        />
      ) : null}

      {isCategoryManagerOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setIsCategoryManagerOpen(false)}>
          <section className="modal-panel category-manager-panel" role="dialog" aria-modal="true" aria-label="管理类型" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-form-sheet category-manager-sheet">
              <div className="sheet-head">
                <div className="sheet-head-row">
                  <div>
                    <h2>管理类型</h2>
                    <p>新增、重命名或删除订阅源类型。</p>
                  </div>
                  <button type="button" className="ghost-button" onClick={() => setIsCategoryManagerOpen(false)}>
                    关闭
                  </button>
                </div>
              </div>

              <form className="category-manager-create" onSubmit={handleCreateManagedCategory}>
                <input
                  type="text"
                  value={managedNewCategoryName}
                  onChange={(event) => setManagedNewCategoryName(event.target.value)}
                  placeholder="输入新类型名称"
                />
                <button type="submit" className="primary-button" disabled={creatingCategory || !managedNewCategoryName.trim()}>
                  新增
                </button>
              </form>

              <div className="category-manager-list">
                {managedCategoryOptions.map((category) => {
                  const isEditingCategory = managedCategoryName === category.id;

                  return (
                    <div className="category-manager-item" key={category.id}>
                      {isEditingCategory ? (
                        <input
                          type="text"
                          autoFocus
                          value={managedCategoryDraft}
                          onChange={(event) => setManagedCategoryDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              void handleSaveManagedCategory(category.id);
                            }

                            if (event.key === "Escape") {
                              handleCancelManagedCategoryEdit();
                            }
                          }}
                        />
                      ) : (
                        <div className="category-manager-item-main">
                          <strong>{category.label}</strong>
                          <span>{category.countLabel} 个启用/全部订阅源</span>
                        </div>
                      )}

                      <div className="category-manager-actions">
                        {isEditingCategory ? (
                          <>
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => void handleSaveManagedCategory(category.id)}
                              disabled={creatingCategory || !managedCategoryDraft.trim()}
                            >
                              保存
                            </button>
                            <button type="button" className="ghost-button" onClick={handleCancelManagedCategoryEdit}>
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="ghost-button" onClick={() => handleStartManagedCategoryEdit(category.id)}>
                              编辑
                            </button>
                            <button type="button" className="ghost-button danger" onClick={() => void handleDeleteManagedCategory(category.id)} disabled={creatingCategory}>
                              删除
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function SourcesPanel() {
  return (
    <SubscriptionManagementPanel
      mode="sources"
      title="类型"
      emptyTitle="还没有任何用户订阅源"
      emptyDescription="这里现在只保存你自己维护的订阅源。点击“新增订阅源”补充 RSSHub 路径或完整 RSS 地址。"
      emptyCategoryDescription="切换到其他类型，或点击“新增订阅源”补充新的订阅源。"
      allowCategoryCreate
      allowSourceCreate
    />
  );
}

function RsshubPanel() {
  return (
    <SubscriptionManagementPanel
      mode="rsshub"
      title="RSSHUB"
      emptyTitle="还没有同步 RSSHUB 模板"
      emptyDescription="运行 npm run sync:rsshub-docs 后，这里会展示 RSSHub 官方文档导入的模板路由。"
      emptyCategoryDescription="切换到其他 RSSHUB 类型查看模板路由。"
      allowCategoryCreate={false}
      allowSourceCreate={false}
    />
  );
}

function SettingsAiConnectionSection() {
  const aiPromptText =
    "请安装Skill https://clawhub.ai/zhaoolee/garss-studio-rss-api 按照skill要求，在本地启动项目，获取今天的摄影类型的信息更新，把前20张图片放到我桌面的 RSS摄影图 文件夹里，并使用markdown给出图片来源，最后给出一个 http://127.0.0.1:25173/reader?pw=banana 的链接支持我通过html人工操作项目";
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  async function handleCopyAiPrompt() {
    try {
      await navigator.clipboard.writeText(aiPromptText);
      setCopiedPrompt(true);
      window.setTimeout(() => setCopiedPrompt(false), 1400);
    } catch {
      setCopiedPrompt(false);
      window.alert("复制失败，请手动选中文字复制。");
    }
  }

  return (
    <section className="editor-sheet settings-sheet settings-page-sheet">
      <div className="sheet-head">
        <p>把下面这段提示词交给AI</p>
      </div>

      <div className="settings-doc-card settings-ai-guide">
        <button type="button" className="settings-ai-copy-button" onClick={() => void handleCopyAiPrompt()}>
          {copiedPrompt ? "已复制" : "复制"}
        </button>
        <p>{aiPromptText}</p>
      </div>
    </section>
  );
}

function SettingsApiDocsSection() {
  return (
    <section className="editor-sheet settings-sheet settings-page-sheet">
      <div className="sheet-head">
        <h3>API开放文档</h3>
        <p>当前后端提供的接口清单。完整机器可读版本可查看 OpenAPI JSON。</p>
      </div>

      <div className="settings-doc-links">
        <a href="/api/docs" target="_blank" rel="noreferrer">
          Swagger UI
        </a>
        <a href="/api/openapi.json" target="_blank" rel="noreferrer">
          OpenAPI JSON
        </a>
      </div>

      <div className="settings-api-list">
        {API_DOCUMENT_ITEMS.map((item) => (
          <article className="settings-api-item" key={`${item.method}-${item.path}`}>
            <div className="settings-api-line">
              <span className="settings-api-method">{item.method}</span>
              <code>{item.path}</code>
              <span className={item.auth === "公开" ? "settings-api-auth" : "settings-api-auth is-protected"}>
                {item.auth}
              </span>
            </div>
            <p>{item.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function SettingsPanel({ initialSection = "fetch", onLogout }: { initialSection?: SettingsSection; onLogout: () => void }) {
  const subscriptions = useAppStore((state) => state.subscriptions);
  const autoRefreshIntervalMinutes = useAppStore((state) => state.autoRefreshIntervalMinutes);
  const parallelFetchCount = useAppStore((state) => state.parallelFetchCount);
  const nextAutoRefreshAt = useAppStore((state) => state.nextAutoRefreshAt);
  const socketConnected = useAppStore((state) => state.socketConnected);
  const socketConnectionLabel = useAppStore((state) => state.socketConnectionLabel);
  const schedulerEnabled = useAppStore((state) => state.schedulerEnabled);
  const activeFetchCount = useAppStore((state) => state.activeFetchCount);
  const completedFetchCount = useAppStore((state) => state.completedFetchCount);
  const loadingReader = useAppStore((state) => state.loadingReader);
  const savingSettings = useAppStore((state) => state.savingSettings);
  const setAutoRefreshIntervalMinutes = useAppStore((state) => state.setAutoRefreshIntervalMinutes);
  const setParallelFetchCount = useAppStore((state) => state.setParallelFetchCount);
  const setNextAutoRefreshAt = useAppStore((state) => state.setNextAutoRefreshAt);
  const refreshReader = useAppStore((state) => state.refreshReader);
  const [nowTimestamp, setNowTimestamp] = useState(() => Date.now());
  const [selectedSection, setSelectedSection] = useState<SettingsSection>(initialSection);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowTimestamp(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setSelectedSection(initialSection);
  }, [initialSection]);

  const enabledSubscriptionCount = useMemo(
    () => subscriptions.filter((subscription) => subscription.enabled && !isRsshubDocSubscription(subscription)).length,
    [subscriptions],
  );
  const autoRefreshOptions = useMemo(
    () => buildSortedOptions(AUTO_REFRESH_OPTION_VALUES, autoRefreshIntervalMinutes),
    [autoRefreshIntervalMinutes],
  );
  const parallelFetchOptions = useMemo(
    () => buildSortedOptions(PARALLEL_FETCH_OPTION_VALUES, parallelFetchCount),
    [parallelFetchCount],
  );
  const effectiveNextAutoRefreshAt = useMemo(
    () => resolveUpcomingTimestamp(nextAutoRefreshAt, nowTimestamp, autoRefreshIntervalMinutes),
    [autoRefreshIntervalMinutes, nextAutoRefreshAt, nowTimestamp],
  );
  const hasActiveFetchTask = loadingReader || activeFetchCount > 0;
  const taskCompletedCount = hasActiveFetchTask ? Math.min(completedFetchCount, enabledSubscriptionCount) : 0;
  const taskProgressPercent =
    hasActiveFetchTask && enabledSubscriptionCount
      ? Math.min(100, Math.round((taskCompletedCount / enabledSubscriptionCount) * 100))
      : 0;

  useEffect(() => {
    if (effectiveNextAutoRefreshAt && effectiveNextAutoRefreshAt !== nextAutoRefreshAt) {
      setNextAutoRefreshAt(effectiveNextAutoRefreshAt);
    }
  }, [effectiveNextAutoRefreshAt, nextAutoRefreshAt, setNextAutoRefreshAt]);

  return (
    <section className="content-panel settings-panel">
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <div className="sources-sidebar-head">
            <div className="sources-sidebar-title">
              <span>设置</span>
            </div>
          </div>
          <div className="settings-nav">
            <button
              type="button"
              className={selectedSection === "fetch" ? "category-item is-active" : "category-item"}
              onClick={() => setSelectedSection("fetch")}
            >
              <span>拉取设置</span>
            </button>
            <button
              type="button"
              className={selectedSection === "rsshub" ? "category-item is-active" : "category-item"}
              onClick={() => setSelectedSection("rsshub")}
            >
              <span>RSSHUB</span>
            </button>
            <button
              type="button"
              className={selectedSection === "ai" ? "category-item is-active" : "category-item"}
              onClick={() => setSelectedSection("ai")}
            >
              <span>连接AI</span>
            </button>
            <button
              type="button"
              className={selectedSection === "api" ? "category-item is-active" : "category-item"}
              onClick={() => setSelectedSection("api")}
            >
              <span>API开放文档</span>
            </button>
            <button
              type="button"
              className={selectedSection === "account" ? "category-item is-active" : "category-item"}
              onClick={() => setSelectedSection("account")}
            >
              <span>账号管理</span>
            </button>
            <button
              type="button"
              className={selectedSection === "about" ? "category-item is-active" : "category-item"}
              onClick={() => setSelectedSection("about")}
            >
              <span>关于</span>
            </button>
          </div>
        </aside>

        <div className="settings-content">
          {selectedSection === "fetch" ? (
            <section className="editor-sheet settings-sheet settings-page-sheet">
              <div className="sheet-head">
                <h3>拉取设置</h3>
                <p>控制自动刷新节奏、单次并行拉取数量，以及后端连接状态。</p>
              </div>

              <div className="settings-grid">
                <label className="stack-field">
                  <span>自动拉取时间间隔</span>
                  <select
                    value={autoRefreshIntervalMinutes}
                    onChange={(event) => {
                      void setAutoRefreshIntervalMinutes(Number(event.target.value));
                    }}
                    disabled={savingSettings}
                  >
                    {autoRefreshOptions.map((value) => (
                      <option key={value} value={value}>
                        {formatIntervalLabel(value)}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="settings-meta-card">
                  <span>距离下一次自动拉取</span>
                  <div className="settings-countdown-row">
                    <strong>
                      {schedulerEnabled
                        ? effectiveNextAutoRefreshAt
                          ? formatRemainingDuration(effectiveNextAutoRefreshAt, nowTimestamp)
                          : "--"
                        : "自动调度未启用"}
                    </strong>
                    <button
                      type="button"
                      className="settings-fetch-now-button"
                      onClick={() => void refreshReader(true)}
                      disabled={loadingReader || activeFetchCount > 0 || enabledSubscriptionCount === 0}
                    >
                      {loadingReader || activeFetchCount > 0 ? "拉取中" : "立刻拉取"}
                    </button>
                  </div>
                </div>

                <label className="stack-field">
                  <span>每次并行拉取 RSS 数量</span>
                  <select
                    value={parallelFetchCount}
                    onChange={(event) => {
                      void setParallelFetchCount(Number(event.target.value));
                    }}
                    disabled={savingSettings}
                  >
                    {parallelFetchOptions.map((value) => (
                      <option key={value} value={value}>
                        {value} 个源
                      </option>
                    ))}
                  </select>
                </label>

                <div className="settings-meta-card">
                  <span>Socket 连接状态</span>
                  <strong className={socketConnected ? "connection-state is-connected" : "connection-state is-disconnected"}>
                    {socketConnectionLabel}
                  </strong>
                </div>

                <div className="settings-task-card">
                  <div className="settings-task-head">
                    <span>当前拉取任务进度</span>
                    <strong>{hasActiveFetchTask ? `${taskProgressPercent}%` : "暂无任务"}</strong>
                  </div>
                  <progress
                    className="settings-task-meter"
                    max={Math.max(1, enabledSubscriptionCount)}
                    value={taskCompletedCount}
                    aria-label="当前拉取任务进度"
                  />
                  <div className="settings-task-counts">
                    <span>任务总数 {hasActiveFetchTask ? enabledSubscriptionCount : 0}</span>
                    <span>完成数 {taskCompletedCount}</span>
                  </div>
                </div>
              </div>
            </section>
          ) : selectedSection === "rsshub" ? (
            <div className="settings-rsshub-panel">
              <RsshubPanel />
            </div>
          ) : selectedSection === "ai" ? (
            <SettingsAiConnectionSection />
          ) : selectedSection === "api" ? (
            <SettingsApiDocsSection />
          ) : selectedSection === "account" ? (
            <section className="editor-sheet settings-sheet settings-page-sheet">
              <div className="sheet-head">
                <h3>账号管理</h3>
                <p>管理当前提取码登录状态。</p>
              </div>
              <div className="settings-account-card">
                <div>
                  <span>当前会话</span>
                  <strong>已使用 URL 提取码或本地会话进入工作台</strong>
                  <p>退出后会清除当前浏览器里的访问状态和 URL 中的 `pw` 参数。</p>
                </div>
                <button type="button" className="secondary-button settings-logout-button" onClick={onLogout}>
                  退出登录
                </button>
              </div>
            </section>
          ) : (
            <section className="editor-sheet settings-sheet settings-page-sheet">
              <div className="sheet-head">
                <h3>关于</h3>
                <p>项目仓库地址。</p>
              </div>
              <div className="settings-about-card">
                <span>GitHub</span>
                <a href="https://github.com/zhaoolee/garss" target="_blank" rel="noreferrer">
                  https://github.com/zhaoolee/garss
                </a>
              </div>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const authChecked = useAppStore((state) => state.authChecked);
  const authToken = useAppStore((state) => state.authToken);
  const currentTab = useAppStore((state) => state.currentTab);
  const dataError = useAppStore((state) => state.dataError);
  const setCurrentTab = useAppStore((state) => state.setCurrentTab);
  const setNextAutoRefreshAt = useAppStore((state) => state.setNextAutoRefreshAt);
  const setSocketConnectionState = useAppStore((state) => state.setSocketConnectionState);
  const setBackendTaskSnapshot = useAppStore((state) => state.setBackendTaskSnapshot);
  const clearDataError = useAppStore((state) => state.clearDataError);
  const logout = useAppStore((state) => state.logout);
  const bootstrap = useAppStore((state) => state.bootstrap);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    function syncTabFromLocation() {
      if (typeof window === "undefined") {
        return;
      }

      setCurrentTab(parseAppLocation(window.location.href).tab);
    }

    syncTabFromLocation();
    window.addEventListener("popstate", syncTabFromLocation);

    return () => {
      window.removeEventListener("popstate", syncTabFromLocation);
    };
  }, [setCurrentTab]);

  useEffect(() => {
    if (!authToken) {
      setSocketConnectionState(false, "未连接");
      setBackendTaskSnapshot(0, 0);
      return;
    }

    setSocketConnectionState(false, "连接中");

    const socket = io({
      auth: { token: authToken },
    });

    socket.on("connect", () => {
      setSocketConnectionState(true, "已连接");
    });

    socket.on("disconnect", () => {
      setSocketConnectionState(false, "已断开");
    });

    socket.on("connect_error", () => {
      setSocketConnectionState(false, "连接失败");
    });

    socket.on("server:status", (payload: { connected?: boolean; label?: string; schedulerEnabled?: boolean; nextScheduledAt?: string }) => {
      setSocketConnectionState(Boolean(payload?.connected), payload?.label || "已连接", Boolean(payload?.schedulerEnabled));
      if (typeof payload?.nextScheduledAt === "string") {
        const nextScheduledAt = new Date(payload.nextScheduledAt).getTime();

        if (Number.isFinite(nextScheduledAt)) {
          setNextAutoRefreshAt(nextScheduledAt);
        }
      }
    });

    socket.on("reader:tasks", (payload: { activeFetchCount?: number; completedFetchCount?: number }) => {
      setBackendTaskSnapshot(
        Number(payload?.activeFetchCount || 0),
        Number(payload?.completedFetchCount || 0),
      );
    });

    return () => {
      socket.disconnect();
      setSocketConnectionState(false, "未连接");
    };
  }, [authToken, setBackendTaskSnapshot, setNextAutoRefreshAt, setSocketConnectionState]);

  useEffect(() => {
    if (!authToken) {
      setNextAutoRefreshAt(0);
    }
  }, [authToken, setNextAutoRefreshAt]);

  if (!authChecked) {
    return (
      <main className="login-screen">
        <section className="login-card">
          <span className="login-eyebrow">GARSS Studio</span>
          <h1>正在连接工作台</h1>
          <p>检查本地登录状态并同步订阅源。</p>
        </section>
      </main>
    );
  }

  if (!authToken) {
    return <LoginScreen />;
  }

  function handleLogout() {
    writeAccessCodeToCurrentUrl("");
    logout();
  }

  function handleTabChange(tab: AppTab) {
    if (typeof window !== "undefined") {
      const nextUrl = buildUrlForTab(window.location.href, tab);

      if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== nextUrl) {
        window.history.pushState({}, "", nextUrl);
      }
    }

    setCurrentTab(tab);
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-topbar-inner">
          <div className="topbar-primary">
            <div className="brand-block">
              <img className="brand-logo" src="/logo.png" alt="GARSS logo" />
              <div>
                <h1>嘎RSS</h1>
              </div>
            </div>

            <nav className="tab-switcher tab-switcher-main" aria-label="主导航">
              <button
                type="button"
                className={currentTab === "reader" ? "tab-button active" : "tab-button"}
                onClick={() => handleTabChange("reader")}
              >
                阅读 RSS
              </button>
              <button
                type="button"
                className={currentTab === "sources" ? "tab-button active" : "tab-button"}
                onClick={() => handleTabChange("sources")}
              >
                订阅源
              </button>
            </nav>
          </div>

          <div className="topbar-actions">
            <nav className="tab-switcher tab-switcher-settings" aria-label="设置导航">
              <button
                type="button"
                className={currentTab === "settings" || currentTab === "rsshub" ? "tab-button active" : "tab-button"}
                onClick={() => handleTabChange("settings")}
              >
                设置
              </button>
            </nav>
          </div>
        </div>
      </header>

      {dataError ? (
        <div className="global-error">
          <span>{dataError}</span>
          <button type="button" className="ghost-button" onClick={clearDataError}>
            知道了
          </button>
        </div>
      ) : null}

      <main
        className={
          currentTab === "reader"
            ? "workspace reader-workspace"
            : currentTab === "sources"
              ? "workspace sources-workspace"
              : "workspace settings-workspace"
        }
      >
        {currentTab === "reader" ? (
          <ReaderPanel />
        ) : currentTab === "sources" ? (
          <SourcesPanel />
        ) : currentTab === "rsshub" ? (
          <SettingsPanel initialSection="rsshub" onLogout={handleLogout} />
        ) : (
          <SettingsPanel onLogout={handleLogout} />
        )}
      </main>
    </div>
  );
}
