import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import { useAppStore } from "./store/useAppStore";
import type { FeedItem, ReaderSourceState, Subscription, SubscriptionInput } from "./types";

type SettingsSection = "fetch" | "about";

function readAccessCodeFromUrl(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return new URLSearchParams(window.location.search).get("pw")?.trim() || "";
}

function writeAccessCodeToUrl(accessCode: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);

  if (accessCode.trim()) {
    url.searchParams.set("pw", accessCode.trim());
  } else {
    url.searchParams.delete("pw");
  }

  window.history.replaceState({}, "", url);
}

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
    name: "",
    routePath: "",
    description: "",
    enabled: true,
  };
}

const AUTO_REFRESH_OPTION_VALUES = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
const PARALLEL_FETCH_OPTION_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function buildSortedOptions(defaultValues: number[], currentValue: number): number[] {
  return Array.from(new Set([...defaultValues, currentValue])).sort((left, right) => left - right);
}

function splitIntoParagraphs(value: string): string[] {
  return value
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function LoginScreen() {
  const isLoggingIn = useAppStore((state) => state.isLoggingIn);
  const loginError = useAppStore((state) => state.loginError);
  const loginWithAccessCode = useAppStore((state) => state.loginWithAccessCode);
  const [accessCode, setAccessCode] = useState(() => readAccessCodeFromUrl());

  useEffect(() => {
    setAccessCode(readAccessCodeFromUrl());
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedAccessCode = accessCode.trim();
    writeAccessCodeToUrl(normalizedAccessCode);
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
        <span className="note-chip">{item.subscriptionName}</span>
        <time>{formatDateLabel(item.publishedAt)}</time>
      </div>
      <h3>{item.title || "未命名条目"}</h3>
      <p>{item.excerpt || "这个条目没有摘要内容，右侧会优先展示 RSS 提供的正文内容。"}</p>
    </article>
  );
}

function ReaderArticle({ item }: { item: FeedItem | null }) {
  if (!item) {
    return (
      <div className="empty-state compact reader-article-empty">
        <div>
          <h3>选择一篇文章开始阅读</h3>
          <p>左侧列表会保留当前订阅源的文章，右侧直接展示 RSS 返回的正文内容。</p>
        </div>
      </div>
    );
  }

  const paragraphs = splitIntoParagraphs(item.contentText || item.excerpt);

  return (
    <article className="reader-article-sheet">
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

function getReaderSourceStatusLabel(status: ReaderSourceState["status"]): string {
  if (status === "loading") {
    return "拉取中";
  }

  if (status === "success") {
    return "已完成";
  }

  if (status === "error") {
    return "失败";
  }

  if (status === "disabled") {
    return "已停用";
  }

  return "等待中";
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
        <span className={`source-index-status is-${sourceState.status}`}>
          {getReaderSourceStatusLabel(sourceState.status)}
        </span>
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
    () => subscriptions.filter((subscription) => subscription.enabled),
    [subscriptions],
  );
  const [selectedSubscriptionId, setSelectedSubscriptionId] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");

  const sourceStateList = useMemo(
    () =>
      enabledSubscriptions
        .map(
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
        )
        .sort((left, right) => {
          const leftRank = left.status === "error" ? 1 : 0;
          const rightRank = right.status === "error" ? 1 : 0;
          return leftRank - rightRank;
        }),
    [enabledSubscriptions, readerSourceStates],
  );

  useEffect(() => {
    if (!enabledSubscriptions.length) {
      setSelectedSubscriptionId("");
      return;
    }

    if (!enabledSubscriptions.some((subscription) => subscription.id === selectedSubscriptionId)) {
      setSelectedSubscriptionId(enabledSubscriptions[0]?.id || "");
    }
  }, [enabledSubscriptions, selectedSubscriptionId]);

  const selectedSourceState = useMemo(
    () => sourceStateList.find((sourceState) => sourceState.subscriptionId === selectedSubscriptionId) || null,
    [selectedSubscriptionId, sourceStateList],
  );

  const filteredItems = useMemo(
    () => items.filter((item) => item.subscriptionId === selectedSubscriptionId),
    [items, selectedSubscriptionId],
  );

  useEffect(() => {
    if (!filteredItems.length) {
      setSelectedItemId("");
      return;
    }

    if (!filteredItems.some((item) => item.id === selectedItemId)) {
      setSelectedItemId(filteredItems[0]?.id || "");
    }
  }, [filteredItems, selectedItemId]);

  const selectedItem = useMemo(
    () => filteredItems.find((item) => item.id === selectedItemId) || filteredItems[0] || null,
    [filteredItems, selectedItemId],
  );

  return (
    <section className="content-panel reader-panel">
      <div className="reader-layout">
        <aside className="reader-sidebar">
          {enabledSubscriptions.length ? (
            <div className="source-status-grid">
              {sourceStateList.map((sourceState) => (
                <ReaderSourceCard
                  key={sourceState.subscriptionId}
                  sourceState={sourceState}
                  isActive={sourceState.subscriptionId === selectedSubscriptionId}
                  onSelect={setSelectedSubscriptionId}
                />
              ))}
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
                <p>去“管理订阅源”打开至少一个 RSS 源后，这里才会显示拉取状态和文章。</p>
              </div>
            </div>
          ) : null}
        </aside>

        <div className="reader-main">
          {selectedSourceState ? (
            <div className="reader-main-toolbar">
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

          {filteredItems.length ? (
            <div className="reader-detail-layout">
              <div className="notes-grid reader-item-list">
                {filteredItems.map((item) => (
                  <ReaderListCard
                    key={item.id}
                    item={item}
                    isActive={item.id === selectedItem?.id}
                    onSelect={setSelectedItemId}
                  />
                ))}
              </div>
              <ReaderArticle item={selectedItem} />
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
  onEdit,
  onToggle,
  onRemove,
}: {
  subscription: Subscription;
  isSaving: boolean;
  isRemoving: boolean;
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
          <button type="button" className="ghost-button" onClick={() => onEdit(subscription)}>
            编辑
          </button>
          <button type="button" className="ghost-button danger" onClick={() => onRemove(subscription)} disabled={isSaving || isRemoving}>
            {isRemoving ? "删除中..." : "删除"}
          </button>
        </div>
      </div>
      <p>{subscription.description || "未填写说明，可以把它当作你自己的订阅备注。"}</p>
      <small>
        {subscription.category} · {subscription.enabled ? "已启用" : "已停用"} · 最近更新：{formatDateLabel(subscription.updatedAt)}
      </small>
    </article>
  );
}

function SourcesPanel() {
  const categories = useAppStore((state) => state.categories);
  const subscriptions = useAppStore((state) => state.subscriptions);
  const savingSource = useAppStore((state) => state.savingSource);
  const creatingCategory = useAppStore((state) => state.creatingCategory);
  const removingSourceId = useAppStore((state) => state.removingSourceId);
  const saveSource = useAppStore((state) => state.saveSource);
  const createSourceCategory = useAppStore((state) => state.createSourceCategory);
  const toggleSourceEnabled = useAppStore((state) => state.toggleSourceEnabled);
  const removeSource = useAppStore((state) => state.removeSource);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [editingSubscriptionId, setEditingSubscriptionId] = useState("");
  const [form, setForm] = useState<SubscriptionInput>(buildEmptyForm);

  function resetForm() {
    setIsModalOpen(false);
    setEditingSubscriptionId("");
    setForm(buildEmptyForm());
  }

  function handleCreate() {
    setEditingSubscriptionId("");
    setForm({
      ...buildEmptyForm(),
      category: selectedCategory === "all" ? "" : selectedCategory,
    });
    setIsModalOpen(true);
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
      name: subscription.name,
      routePath: subscription.routePath,
      description: subscription.description,
      enabled: subscription.enabled,
    });
    setIsModalOpen(true);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const succeeded = await saveSource(
      {
        category: form.category.trim(),
        name: form.name.trim(),
        routePath: form.routePath.trim(),
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
      setSelectedCategory(createdCategory);
      handleCancelCategoryCreate();
    }
  }

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();

    for (const subscription of subscriptions) {
      counts.set(subscription.category, (counts.get(subscription.category) || 0) + 1);
    }

    return [
      { id: "all", label: "全部类型", count: subscriptions.length },
      ...categories.map((category) => ({
        id: category,
        label: category,
        count: counts.get(category) || 0,
      })),
    ];
  }, [categories, subscriptions]);

  useEffect(() => {
    if (selectedCategory === "all") {
      return;
    }

    if (!categoryOptions.some((category) => category.id === selectedCategory)) {
      setSelectedCategory("all");
    }
  }, [categoryOptions, selectedCategory]);

  const filteredSubscriptions = useMemo(
    () =>
      selectedCategory === "all"
        ? subscriptions
        : subscriptions.filter((subscription) => subscription.category === selectedCategory),
    [selectedCategory, subscriptions],
  );

  return (
    <section className="content-panel sources-panel">
      <div className="sources-layout">
        <aside className="sources-sidebar">
          <div className="sources-sidebar-head">
            <div className="sources-sidebar-title">
              <span>类型</span>
              <button
                type="button"
                className="category-create-trigger"
                onClick={handleStartCategoryCreate}
                aria-label="创建新类型"
                disabled={isCreatingCategory}
              >
                +
              </button>
            </div>
          </div>
          <div className="category-list">
            {isCreatingCategory ? (
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
                className={selectedCategory === category.id ? "category-item is-active" : "category-item"}
                onClick={() => setSelectedCategory(category.id)}
              >
                <span>{category.label}</span>
                <strong>{category.count}</strong>
              </button>
            ))}
          </div>
        </aside>

        <div className="source-list">
          <div className="source-list-toolbar">
            <button type="button" className="primary-button" onClick={handleCreate}>
              新增订阅源
            </button>
          </div>
          {filteredSubscriptions.length ? (
            filteredSubscriptions.map((subscription) => (
              <SourceManagerCard
                key={subscription.id}
                subscription={subscription}
                isSaving={savingSource}
                isRemoving={removingSourceId === subscription.id}
                onEdit={handleEdit}
                onToggle={(target, enabled) => void toggleSourceEnabled(target.id, enabled)}
                onRemove={(target) => void removeSource(target.id)}
              />
            ))
          ) : (
            <div className="empty-state compact">
              <div>
                <h3>{subscriptions.length ? "这个类型下还没有订阅源" : "还没有任何订阅源"}</h3>
                <p>
                  {subscriptions.length
                    ? "切换到其他类型，或点击“新增订阅源”补充新的 RSSHub 路径。"
                    : "建议先加 1 到 3 个 RSSHub 路径，确认阅读流转顺畅后再扩展。"}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {isModalOpen ? (
        <div className="modal-backdrop" onClick={resetForm}>
          <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
            <form className="editor-sheet modal-form-sheet" onSubmit={handleSubmit}>
              <div className="sheet-head">
                <h3>{editingSubscriptionId ? "编辑订阅源" : "新增订阅源"}</h3>
                <p>填写 RSSHub 路径或完整 RSS 地址。完整 URL 会直连抓取，路径则通过内部 RSSHub 服务获取。</p>
              </div>

              <label className="stack-field">
                <span>类型</span>
                <input
                  type="text"
                  list="source-category-options"
                  value={form.category}
                  onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
                  placeholder="例如：AI、科技商业、财经市场"
                />
              </label>
              <datalist id="source-category-options">
                {categories.map((category) => (
                  <option key={category} value={category} />
                ))}
              </datalist>

              <label className="stack-field">
                <span>名称</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="例如：GitHub Trending JS"
                />
              </label>

              <label className="stack-field">
                <span>订阅地址</span>
                <input
                  type="text"
                  value={form.routePath}
                  onChange={(event) => setForm((current) => ({ ...current, routePath: event.target.value }))}
                  placeholder="/github/trending/daily/javascript 或 https://example.com/feed.xml"
                />
              </label>

              <label className="stack-field">
                <span>说明</span>
                <textarea
                  rows={5}
                  value={form.description}
                  onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                  placeholder="可选，用来记录这个源的用途。"
                />
              </label>

              <div className="form-actions">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={savingSource || !form.name.trim() || !form.routePath.trim()}
                >
                  {savingSource ? "保存中..." : editingSubscriptionId ? "更新订阅源" : "添加订阅源"}
                </button>
                <button type="button" className="secondary-button" onClick={resetForm}>
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SettingsPanel() {
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
    () => subscriptions.filter((subscription) => subscription.enabled).length,
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
  const isLoggingIn = useAppStore((state) => state.isLoggingIn);
  const currentTab = useAppStore((state) => state.currentTab);
  const dataError = useAppStore((state) => state.dataError);
  const setCurrentTab = useAppStore((state) => state.setCurrentTab);
  const setNextAutoRefreshAt = useAppStore((state) => state.setNextAutoRefreshAt);
  const setSocketConnectionState = useAppStore((state) => state.setSocketConnectionState);
  const setBackendTaskSnapshot = useAppStore((state) => state.setBackendTaskSnapshot);
  const clearDataError = useAppStore((state) => state.clearDataError);
  const logout = useAppStore((state) => state.logout);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const loginWithAccessCode = useAppStore((state) => state.loginWithAccessCode);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!authChecked || authToken || isLoggingIn) {
      return;
    }

    const accessCode = readAccessCodeFromUrl();

    if (!accessCode) {
      return;
    }

    void loginWithAccessCode(accessCode);
  }, [authChecked, authToken, isLoggingIn, loginWithAccessCode]);

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
    writeAccessCodeToUrl("");
    logout();
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="brand-block">
          <img className="brand-logo" src="/logo.png" alt="GARSS logo" />
          <div>
            <h1>RSS 阅读工作台</h1>
          </div>
        </div>

        <div className="topbar-actions">
          <nav className="tab-switcher" aria-label="主导航">
            <button
              type="button"
              className={currentTab === "reader" ? "tab-button active" : "tab-button"}
              onClick={() => setCurrentTab("reader")}
            >
              阅读 RSS
            </button>
            <button
              type="button"
              className={currentTab === "sources" ? "tab-button active" : "tab-button"}
              onClick={() => setCurrentTab("sources")}
            >
              管理订阅源
            </button>
            <button
              type="button"
              className={currentTab === "settings" ? "tab-button active" : "tab-button"}
              onClick={() => setCurrentTab("settings")}
            >
              设置
            </button>
          </nav>
          <button type="button" className="ghost-button" onClick={handleLogout}>
            退出登录
          </button>
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
        {currentTab === "reader" ? <ReaderPanel /> : currentTab === "sources" ? <SourcesPanel /> : <SettingsPanel />}
      </main>
    </div>
  );
}
