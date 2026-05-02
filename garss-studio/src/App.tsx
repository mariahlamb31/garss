import { useEffect, useMemo, useRef, useState } from "react";
import { SubscriptionEditorModal } from "./components/SubscriptionEditorModal";
import { io } from "socket.io-client";
import {
  ALL_SOURCES_CATEGORY,
  buildUrlForRsshubCategory,
  buildUrlForSourcesCategory,
  buildUrlForTab,
  parseAppLocation,
  readAccessCodeFromCurrentUrl,
  writeAccessCodeToCurrentUrl,
} from "./lib/navigation";
import { useAppStore } from "./store/useAppStore";
import type { AppTab, FeedItem, ReaderSourceState, Subscription, SubscriptionInput } from "./types";

type SettingsSection = "fetch" | "account" | "about";
type SpeedTestResult = {
  status: "testing" | "success" | "error";
  ms?: number;
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

function formatIntervalLabel(value: number): string {
  if (value < 60) {
    return `${value} 分钟`;
  }

  if (value % 60 === 0) {
    return `${value / 60} 小时`;
  }

  return `${Math.floor(value / 60)} 小时 ${value % 60} 分钟`;
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
const SOURCE_DRAFT_STORAGE_KEY = "garss-studio.source-draft";

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

function ReaderArticleCard({
  item,
  isActive,
  articleRef,
}: {
  item: FeedItem;
  isActive: boolean;
  articleRef?: (node: HTMLElement | null) => void;
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
                <div
                  className="reader-article-content"
                  dangerouslySetInnerHTML={{ __html: item.contentHtml }}
                />
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
              <span className="reader-article-footer-brand">由 GARSS Studio 阅读</span>
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
  onSelect,
}: {
  sourceState: ReaderSourceState;
  isActive: boolean;
  onSelect: (subscriptionId: string) => void;
}) {
  const shouldShowError = sourceState.status === "error" && sourceState.message.trim();
  const updatedLabel = sourceState.updatedAt ? formatDateLabel(sourceState.updatedAt) : "尚未更新";

  return (
    <button
      type="button"
      className={`source-status-card source-index-card is-${sourceState.status}${isActive ? " is-active" : ""}`}
      aria-pressed={isActive}
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
  const subscriptions = useAppStore((state) => state.subscriptions);
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
  const [selectedItemId, setSelectedItemId] = useState("");
  const [completedSourceOrder, setCompletedSourceOrder] = useState<string[]>([]);
  const [isSourceDrawerOpen, setIsSourceDrawerOpen] = useState(false);
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
  const selectedItem = useMemo(
    () => filteredItems.find((item) => item.id === selectedItemId) || null,
    [filteredItems, selectedItemId],
  );
  const selectedItemIndex = useMemo(
    () => filteredItems.findIndex((item) => item.id === selectedItemId),
    [filteredItems, selectedItemId],
  );
  const previousItem = selectedItemIndex > 0 ? filteredItems[selectedItemIndex - 1] : null;
  const nextItem =
    selectedItemIndex >= 0 && selectedItemIndex < filteredItems.length - 1
      ? filteredItems[selectedItemIndex + 1]
      : null;

  useEffect(() => {
    if (!filteredItems.length) {
      setSelectedItemId("");
      return;
    }

    if (!filteredItems.some((item) => item.id === selectedItemId)) {
      setSelectedItemId(filteredItems[0]?.id || "");
    }
  }, [filteredItems, selectedItemId]);

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
    setSelectedItemId(itemId);
    setIsSourceDrawerOpen(false);
    scrollArticleViewportToTop();
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

    setSelectedItemId(item.id);
    scrollArticleViewportToTop();
  }

  return (
    <section className="content-panel reader-panel">
      <div className="reader-layout">
        <aside className={`reader-sidebar${isSourceDrawerOpen ? " is-open" : ""}`} aria-label="订阅源导航">
          {enabledSubscriptions.length ? (
            <div className="source-status-grid">
              {sourceStateList.map((sourceState) => {
                const isSourceActive = sourceState.subscriptionId === selectedSubscriptionId;
                const isSourceExpanded = sourceState.subscriptionId === expandedSubscriptionId;

                return (
                  <div className="reader-source-entry" key={sourceState.subscriptionId}>
                    <ReaderSourceCard
                      sourceState={sourceState}
                      isActive={isSourceActive}
                      onSelect={handleSelectSource}
                    />
                    {isSourceActive && filteredItems.length ? (
                      <div
                        className={`reader-source-article-sublist${isSourceExpanded ? " is-expanded" : ""}`}
                        aria-label={`${sourceState.subscriptionName} 文章列表`}
                      >
                        {filteredItems.map((item) => (
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
                <ReaderArticleCard item={selectedItem} isActive />
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
  const saveSource = useAppStore((state) => state.saveSource);
  const createSourceCategory = useAppStore((state) => state.createSourceCategory);
  const testSource = useAppStore((state) => state.testSource);
  const setCurrentTab = useAppStore((state) => state.setCurrentTab);
  const toggleSourceEnabled = useAppStore((state) => state.toggleSourceEnabled);
  const removeSource = useAppStore((state) => state.removeSource);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(() =>
    typeof window === "undefined" ? "" : parseAppLocation(window.location.href).category,
  );
  const [editingSubscriptionId, setEditingSubscriptionId] = useState("");
  const [form, setForm] = useState<SubscriptionInput>(buildEmptyForm);
  const [speedTestResults, setSpeedTestResults] = useState<Record<string, SpeedTestResult>>({});
  const [isSpeedTesting, setIsSpeedTesting] = useState(false);
  const [speedTestProgress, setSpeedTestProgress] = useState({ completed: 0, total: 0 });
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
    return (
      selectedCategory && selectedCategory !== ALL_SOURCES_CATEGORY && panelCategories.includes(selectedCategory)
        ? selectedCategory
        : panelCategories[0] || ""
    );
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

function SettingsPanel({ onLogout }: { onLogout: () => void }) {
  const subscriptions = useAppStore((state) => state.subscriptions);
  const autoRefreshIntervalMinutes = useAppStore((state) => state.autoRefreshIntervalMinutes);
  const parallelFetchCount = useAppStore((state) => state.parallelFetchCount);
  const nextAutoRefreshAt = useAppStore((state) => state.nextAutoRefreshAt);
  const socketConnected = useAppStore((state) => state.socketConnected);
  const socketConnectionLabel = useAppStore((state) => state.socketConnectionLabel);
  const activeFetchCount = useAppStore((state) => state.activeFetchCount);
  const completedFetchCount = useAppStore((state) => state.completedFetchCount);
  const savingSettings = useAppStore((state) => state.savingSettings);
  const setAutoRefreshIntervalMinutes = useAppStore((state) => state.setAutoRefreshIntervalMinutes);
  const setParallelFetchCount = useAppStore((state) => state.setParallelFetchCount);
  const [nowTimestamp, setNowTimestamp] = useState(() => Date.now());
  const [selectedSection, setSelectedSection] = useState<SettingsSection>("fetch");

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowTimestamp(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

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
  const normalizedCompletedCount = Math.min(completedFetchCount, enabledSubscriptionCount);
  const pendingFetchCount = Math.max(0, enabledSubscriptionCount - normalizedCompletedCount);
  const completedProgressPercent = enabledSubscriptionCount
    ? Math.round((normalizedCompletedCount / enabledSubscriptionCount) * 100)
    : 0;

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
                  <strong>{nextAutoRefreshAt ? formatRemainingDuration(nextAutoRefreshAt, nowTimestamp) : "--"}</strong>
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

                <div className="settings-progress-card">
                  <div className="settings-progress-head">
                    <span>当前拉取任务进度</span>
                    <strong>{enabledSubscriptionCount ? `${completedProgressPercent}%` : "暂无任务"}</strong>
                  </div>
                  <div className="settings-progress-bar" aria-label="当前拉取任务进度">
                    <div
                      className="settings-progress-bar-completed"
                      style={{ width: `${completedProgressPercent}%` }}
                    />
                    <div
                      className="settings-progress-bar-pending"
                      style={{ width: `${Math.max(0, 100 - completedProgressPercent)}%` }}
                    />
                  </div>
                  <div className="settings-progress-legend">
                    <span>已完成 {normalizedCompletedCount}</span>
                    <span>待完成 {pendingFetchCount}</span>
                    <span>拉取中 {activeFetchCount}</span>
                  </div>
                </div>
              </div>
            </section>
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

    socket.on("server:status", (payload: { connected?: boolean; label?: string; nextScheduledAt?: string }) => {
      setSocketConnectionState(Boolean(payload?.connected), payload?.label || "已连接");
      if (typeof payload?.nextScheduledAt === "string") {
        setNextAutoRefreshAt(new Date(payload.nextScheduledAt).getTime());
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
  }, [authToken, setBackendTaskSnapshot, setSocketConnectionState]);

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
              <button
                type="button"
                className={currentTab === "rsshub" ? "tab-button active" : "tab-button"}
                onClick={() => handleTabChange("rsshub")}
              >
                RSSHUB
              </button>
            </nav>
          </div>

          <div className="topbar-actions">
            <nav className="tab-switcher tab-switcher-settings" aria-label="设置导航">
              <button
                type="button"
                className={currentTab === "settings" ? "tab-button active" : "tab-button"}
                onClick={() => handleTabChange("settings")}
              >
                ⚙️ 设置
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
            : currentTab === "sources" || currentTab === "rsshub"
              ? "workspace sources-workspace"
              : "workspace settings-workspace"
        }
      >
        {currentTab === "reader" ? (
          <ReaderPanel />
        ) : currentTab === "sources" ? (
          <SourcesPanel />
        ) : currentTab === "rsshub" ? (
          <RsshubPanel />
        ) : (
          <SettingsPanel onLogout={handleLogout} />
        )}
      </main>
    </div>
  );
}
