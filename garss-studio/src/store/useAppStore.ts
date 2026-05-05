import { create } from "zustand";
import { parseAppLocation, readAccessCodeFromCurrentUrl } from "../lib/navigation";
import { bootstrapAuthSession } from "./bootstrap-auth";
import {
  createCategory,
  deleteCategory,
  exportSubscriptionsBackup,
  getAppSettings,
  getErrorMessage,
  getReaderItems,
  getReaderSubscriptionItems,
  getSession,
  getSubscriptions,
  importSubscriptionsBackup,
  testSubscription,
  login,
  removeSubscription,
  renameCategory,
  saveSubscription,
  updateAppSettings,
} from "../lib/api";
import type {
  AppTab,
  AppSettingsResponse,
  FeedItem,
  ReaderError,
  ReaderSourceState,
  Subscription,
  SubscriptionsBackup,
  SubscriptionsBackupImportInput,
  SubscriptionInput,
  SubscriptionTestResponse,
} from "../types";

const AUTH_TOKEN_STORAGE_KEY = "garss-studio.auth-token";
const DEFAULT_AUTO_REFRESH_INTERVAL_MINUTES = 30;
const DEFAULT_PARALLEL_FETCH_COUNT = 2;

function readStoredValue(key: string): string {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(key) || "";
}

function writeStoredValue(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }

  if (!value) {
    window.localStorage.removeItem(key);
    return;
  }

  window.localStorage.setItem(key, value);
}

function readInitialTab(): AppTab {
  if (typeof window === "undefined") {
    return "reader";
  }

  return parseAppLocation(window.location.href).tab;
}

function clampParallelFetchCount(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PARALLEL_FETCH_COUNT;
  }

  return Math.max(1, Math.min(10, Math.floor(value)));
}

function clampAutoRefreshIntervalMinutes(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_AUTO_REFRESH_INTERVAL_MINUTES;
  }

  return Math.max(1, Math.min(24 * 60, Math.floor(value)));
}

function parseTimestamp(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isRsshubDocSubscription(subscription: Subscription): boolean {
  return subscription.id.startsWith("rsshub-doc-");
}

function isReaderSubscription(subscription: Subscription): boolean {
  return subscription.enabled && !isRsshubDocSubscription(subscription);
}

interface AppStoreState {
  authToken: string;
  authChecked: boolean;
  isLoggingIn: boolean;
  loginError: string;
  currentTab: AppTab;
  autoRefreshIntervalMinutes: number;
  parallelFetchCount: number;
  nextAutoRefreshAt: number;
  socketConnected: boolean;
  socketConnectionLabel: string;
  schedulerEnabled: boolean;
  activeFetchCount: number;
  completedFetchCount: number;
  categories: string[];
  subscriptions: Subscription[];
  items: FeedItem[];
  readerErrors: ReaderError[];
  readerSourceStates: Record<string, ReaderSourceState>;
  loadingSubscriptions: boolean;
  loadingReader: boolean;
  reloadingSourceId: string;
  savingSource: boolean;
  importingSources: boolean;
  exportingSources: boolean;
  savingSettings: boolean;
  creatingCategory: boolean;
  removingSourceId: string;
  dataError: string;
  bootstrap: () => Promise<void>;
  loginWithAccessCode: (accessCode: string) => Promise<boolean>;
  logout: () => void;
  setCurrentTab: (tab: AppTab) => void;
  setAutoRefreshIntervalMinutes: (minutes: number) => Promise<boolean>;
  setParallelFetchCount: (count: number) => Promise<boolean>;
  setNextAutoRefreshAt: (timestamp: number) => void;
  setSocketConnectionState: (connected: boolean, label: string, schedulerEnabled?: boolean) => void;
  setBackendTaskSnapshot: (activeFetchCount: number, completedFetchCount: number) => void;
  loadSubscriptions: () => Promise<void>;
  refreshReader: (forceRefresh?: boolean) => Promise<void>;
  refreshReaderSubscription: (subscriptionId: string) => Promise<boolean>;
  saveSource: (input: SubscriptionInput, subscriptionId?: string) => Promise<boolean>;
  exportSourcesBackup: () => Promise<SubscriptionsBackup | null>;
  importSourcesBackup: (backup: SubscriptionsBackupImportInput) => Promise<boolean>;
  testSource: (input: SubscriptionInput) => Promise<SubscriptionTestResponse>;
  createSourceCategory: (name: string) => Promise<string | null>;
  renameSourceCategory: (currentName: string, nextName: string) => Promise<boolean>;
  deleteSourceCategory: (name: string) => Promise<boolean>;
  toggleSourceEnabled: (subscriptionId: string, enabled: boolean) => Promise<boolean>;
  removeSource: (subscriptionId: string) => Promise<boolean>;
  clearDataError: () => void;
}

async function loadWorkspaceData(
  token: string,
): Promise<{ subscriptions: Subscription[]; categories: string[]; items: FeedItem[]; errors: ReaderError[] }> {
  const subscriptionsResponse = await getSubscriptions(token);
  return {
    subscriptions: subscriptionsResponse.subscriptions,
    categories: subscriptionsResponse.categories,
    items: [],
    errors: [],
  };
}

async function loadSubscriptionsData(
  token: string,
): Promise<{ subscriptions: Subscription[]; categories: string[] }> {
  const response = await getSubscriptions(token);
  return {
    subscriptions: response.subscriptions,
    categories: response.categories,
  };
}

async function loadAppSettingsData(token: string): Promise<AppSettingsResponse> {
  return getAppSettings(token);
}

function buildInitialReaderSourceStates(
  subscriptions: Subscription[],
): Record<string, ReaderSourceState> {
  return Object.fromEntries(
    subscriptions.map((subscription) => [
      subscription.id,
      {
        subscriptionId: subscription.id,
        subscriptionName: subscription.name,
        routePath: subscription.routePath,
        status: subscription.enabled ? "idle" : "disabled",
        itemCount: 0,
        message: subscription.enabled ? "等待拉取" : "已停用，不参与拉取",
        updatedAt: "",
      },
    ]),
  );
}

function mergeItems(currentItems: FeedItem[], nextItems: FeedItem[], subscriptionId: string): FeedItem[] {
  return [...currentItems.filter((item) => item.subscriptionId !== subscriptionId), ...nextItems].sort(
    (left, right) => new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime(),
  );
}

function countActiveReaderTasks(readerSourceStates: Record<string, ReaderSourceState>): number {
  return Object.values(readerSourceStates).filter((state) => state.status === "loading").length;
}

function countCompletedReaderTasks(readerSourceStates: Record<string, ReaderSourceState>): number {
  return Object.values(readerSourceStates).filter(
    (state) => state.status === "success" || state.status === "error",
  ).length;
}

function applyReaderSourceLoadingState(
  readerSourceStates: Record<string, ReaderSourceState>,
  subscription: Subscription,
): Record<string, ReaderSourceState> {
  return {
    ...readerSourceStates,
    [subscription.id]: {
      ...(readerSourceStates[subscription.id] || {
        subscriptionId: subscription.id,
        subscriptionName: subscription.name,
        routePath: subscription.routePath,
        itemCount: 0,
        updatedAt: "",
      }),
      subscriptionId: subscription.id,
      subscriptionName: subscription.name,
      routePath: subscription.routePath,
      status: "loading",
      message: "正在拉取 RSSHub 数据",
    },
  };
}

function buildReaderSourceStateFromResponse(
  subscription: Subscription,
  response: { generatedAt: string; items: FeedItem[] },
  fallbackState: ReaderSourceState,
  forceRefresh: boolean,
): ReaderSourceState {
  const isCacheMiss = !forceRefresh && !response.generatedAt && response.items.length === 0;

  if (isCacheMiss) {
    return {
      ...fallbackState,
      subscriptionId: subscription.id,
      subscriptionName: subscription.name,
      routePath: subscription.routePath,
      status: "idle",
      itemCount: 0,
      message: "尚未更新",
      updatedAt: "",
    };
  }

  return {
    ...fallbackState,
    subscriptionId: subscription.id,
    subscriptionName: subscription.name,
    routePath: subscription.routePath,
    status: "success",
    itemCount: response.items.length,
    message: response.items.length
      ? forceRefresh ? "拉取完成" : "已读取缓存"
      : forceRefresh ? "已完成，但暂无文章" : "已读取缓存，但暂无文章",
    updatedAt: response.generatedAt,
  };
}

function buildReaderSourceStatesFromItemsResponse(
  subscriptions: Subscription[],
  response: { generatedAt: string; items: FeedItem[]; errors: ReaderError[] },
  fallbackStates: Record<string, ReaderSourceState>,
): Record<string, ReaderSourceState> {
  const itemCounts = new Map<string, number>();
  const errorsBySubscriptionId = new Map<string, ReaderError>();

  for (const item of response.items) {
    itemCounts.set(item.subscriptionId, (itemCounts.get(item.subscriptionId) || 0) + 1);
  }

  for (const error of response.errors) {
    errorsBySubscriptionId.set(error.subscriptionId, error);
  }

  return Object.fromEntries(
    subscriptions.map((subscription) => {
      const fallbackState = fallbackStates[subscription.id] || {
        subscriptionId: subscription.id,
        subscriptionName: subscription.name,
        routePath: subscription.routePath,
        status: subscription.enabled ? "idle" : "disabled",
        itemCount: 0,
        message: subscription.enabled ? "等待拉取" : "已停用，不参与拉取",
        updatedAt: "",
      };
      const itemCount = itemCounts.get(subscription.id) || 0;
      const readerError = errorsBySubscriptionId.get(subscription.id);

      if (!subscription.enabled) {
        return [
          subscription.id,
          {
            ...fallbackState,
            subscriptionId: subscription.id,
            subscriptionName: subscription.name,
            routePath: subscription.routePath,
            status: "disabled",
            itemCount: 0,
            message: "已停用，不参与拉取",
            updatedAt: "",
          },
        ];
      }

      if (readerError) {
        return [
          subscription.id,
          {
            ...fallbackState,
            subscriptionId: subscription.id,
            subscriptionName: subscription.name,
            routePath: subscription.routePath,
            status: "error",
            itemCount,
            message: readerError.message,
            updatedAt: response.generatedAt,
          },
        ];
      }

      if (itemCount > 0) {
        return [
          subscription.id,
          {
            ...fallbackState,
            subscriptionId: subscription.id,
            subscriptionName: subscription.name,
            routePath: subscription.routePath,
            status: "success",
            itemCount,
            message: "已读取缓存",
            updatedAt: response.generatedAt,
          },
        ];
      }

      return [
        subscription.id,
        {
          ...fallbackState,
          subscriptionId: subscription.id,
          subscriptionName: subscription.name,
          routePath: subscription.routePath,
          status: "idle",
          itemCount: 0,
          message: "尚未更新",
          updatedAt: "",
        },
      ];
    }),
  );
}

let currentReaderRequestId = 0;

export const useAppStore = create<AppStoreState>((set, get) => ({
  authToken: readStoredValue(AUTH_TOKEN_STORAGE_KEY),
  authChecked: false,
  isLoggingIn: false,
  loginError: "",
  currentTab: readInitialTab(),
  autoRefreshIntervalMinutes: DEFAULT_AUTO_REFRESH_INTERVAL_MINUTES,
  parallelFetchCount: DEFAULT_PARALLEL_FETCH_COUNT,
  nextAutoRefreshAt: 0,
  socketConnected: false,
  socketConnectionLabel: "未连接",
  schedulerEnabled: false,
  activeFetchCount: 0,
  completedFetchCount: 0,
  categories: [],
  subscriptions: [],
  items: [],
  readerErrors: [],
  readerSourceStates: {},
  loadingSubscriptions: false,
  loadingReader: false,
  reloadingSourceId: "",
  savingSource: false,
  importingSources: false,
  exportingSources: false,
  savingSettings: false,
  creatingCategory: false,
  removingSourceId: "",
  dataError: "",
  async bootstrap() {
    const storedToken = get().authToken;
    const accessCode = readAccessCodeFromCurrentUrl();

    set({
      loadingSubscriptions: Boolean(storedToken),
      loadingReader: Boolean(storedToken),
      loginError: "",
    });

    const authResult = await bootstrapAuthSession({
      storedToken,
      accessCode,
      getSession,
      login,
      getErrorMessage,
    });

    if (authResult.status !== "authenticated") {
      if (authResult.shouldClearStoredToken) {
        writeStoredValue(AUTH_TOKEN_STORAGE_KEY, "");
      }

      set({
        authToken: "",
        authChecked: true,
        loadingSubscriptions: false,
        loadingReader: false,
        isLoggingIn: false,
        loginError: authResult.error,
      });
      return;
    }

    const token = authResult.authToken;

    if (authResult.shouldPersistToken) {
      writeStoredValue(AUTH_TOKEN_STORAGE_KEY, token);
    }

    try {
      const [subscriptions, settings] = await Promise.all([
        loadSubscriptionsData(token),
        loadAppSettingsData(token),
      ]);
      set({
        authToken: token,
        authChecked: true,
        subscriptions: subscriptions.subscriptions,
        categories: subscriptions.categories,
        autoRefreshIntervalMinutes: clampAutoRefreshIntervalMinutes(settings.autoRefreshIntervalMinutes),
        parallelFetchCount: clampParallelFetchCount(settings.parallelFetchCount),
        nextAutoRefreshAt: parseTimestamp(settings.nextScheduledAt),
        readerSourceStates: buildInitialReaderSourceStates(subscriptions.subscriptions),
        loadingSubscriptions: false,
        loadingReader: false,
        isLoggingIn: false,
        reloadingSourceId: "",
        dataError: "",
        loginError: "",
      });
      void get().refreshReader(false);
    } catch (error) {
      writeStoredValue(AUTH_TOKEN_STORAGE_KEY, "");
      set({
        authToken: "",
        authChecked: true,
        loadingSubscriptions: false,
        loadingReader: false,
        isLoggingIn: false,
        loginError: getErrorMessage(error),
      });
    }
  },
  async loginWithAccessCode(accessCode) {
    set({ isLoggingIn: true, loginError: "" });

    try {
      const response = await login(accessCode);
      writeStoredValue(AUTH_TOKEN_STORAGE_KEY, response.token);
      const [subscriptions, settings] = await Promise.all([
        loadSubscriptionsData(response.token),
        loadAppSettingsData(response.token),
      ]);
      set({
        authToken: response.token,
        authChecked: true,
        subscriptions: subscriptions.subscriptions,
        categories: subscriptions.categories,
        autoRefreshIntervalMinutes: clampAutoRefreshIntervalMinutes(settings.autoRefreshIntervalMinutes),
        parallelFetchCount: clampParallelFetchCount(settings.parallelFetchCount),
        nextAutoRefreshAt: parseTimestamp(settings.nextScheduledAt),
        readerSourceStates: buildInitialReaderSourceStates(subscriptions.subscriptions),
        isLoggingIn: false,
        loadingSubscriptions: false,
        loadingReader: false,
        reloadingSourceId: "",
        dataError: "",
      });
      void get().refreshReader(false);
      return true;
    } catch (error) {
      set({
        authToken: "",
        authChecked: true,
        loadingSubscriptions: false,
        loadingReader: false,
        isLoggingIn: false,
        loginError: getErrorMessage(error),
      });
      return false;
    }
  },
  logout() {
    writeStoredValue(AUTH_TOKEN_STORAGE_KEY, "");
    set({
      authToken: "",
      authChecked: true,
      isLoggingIn: false,
      loginError: "",
      autoRefreshIntervalMinutes: DEFAULT_AUTO_REFRESH_INTERVAL_MINUTES,
      parallelFetchCount: DEFAULT_PARALLEL_FETCH_COUNT,
      nextAutoRefreshAt: 0,
      subscriptions: [],
      categories: [],
      items: [],
      readerErrors: [],
      readerSourceStates: {},
      loadingSubscriptions: false,
      loadingReader: false,
      reloadingSourceId: "",
      savingSource: false,
      importingSources: false,
      exportingSources: false,
      savingSettings: false,
      creatingCategory: false,
      removingSourceId: "",
      dataError: "",
    });
  },
  setCurrentTab(tab) {
    set({ currentTab: tab });
  },
  async setAutoRefreshIntervalMinutes(minutes) {
    const token = get().authToken;
    const nextValue = clampAutoRefreshIntervalMinutes(minutes);

    if (!token) {
      set({ autoRefreshIntervalMinutes: nextValue });
      return true;
    }

    set({ savingSettings: true, dataError: "" });

    try {
      const settings = await updateAppSettings(token, { autoRefreshIntervalMinutes: nextValue });
      set({
        autoRefreshIntervalMinutes: clampAutoRefreshIntervalMinutes(settings.autoRefreshIntervalMinutes),
        parallelFetchCount: clampParallelFetchCount(settings.parallelFetchCount),
        nextAutoRefreshAt: parseTimestamp(settings.nextScheduledAt),
        savingSettings: false,
      });
      return true;
    } catch (error) {
      set({
        savingSettings: false,
        dataError: getErrorMessage(error),
      });
      return false;
    }
  },
  async setParallelFetchCount(count) {
    const token = get().authToken;
    const nextValue = clampParallelFetchCount(count);

    if (!token) {
      set({ parallelFetchCount: nextValue });
      return true;
    }

    set({ savingSettings: true, dataError: "" });

    try {
      const settings = await updateAppSettings(token, { parallelFetchCount: nextValue });
      set({
        autoRefreshIntervalMinutes: clampAutoRefreshIntervalMinutes(settings.autoRefreshIntervalMinutes),
        parallelFetchCount: clampParallelFetchCount(settings.parallelFetchCount),
        nextAutoRefreshAt: parseTimestamp(settings.nextScheduledAt),
        savingSettings: false,
      });
      return true;
    } catch (error) {
      set({
        savingSettings: false,
        dataError: getErrorMessage(error),
      });
      return false;
    }
  },
  setNextAutoRefreshAt(timestamp) {
    set({ nextAutoRefreshAt: Math.max(0, Math.floor(timestamp)) });
  },
  setSocketConnectionState(connected, label, schedulerEnabled) {
    set((state) => ({
      socketConnected: connected,
      socketConnectionLabel: label,
      schedulerEnabled: typeof schedulerEnabled === "boolean" ? schedulerEnabled : connected ? state.schedulerEnabled : false,
    }));
  },
  setBackendTaskSnapshot(activeFetchCount, completedFetchCount) {
    set({
      activeFetchCount: Math.max(0, Math.floor(activeFetchCount)),
      completedFetchCount: Math.max(0, Math.floor(completedFetchCount)),
    });
  },
  async loadSubscriptions() {
    const token = get().authToken;

    if (!token) {
      return;
    }

    set({ loadingSubscriptions: true });

    try {
      const response = await getSubscriptions(token);
      set({
        subscriptions: response.subscriptions,
        categories: response.categories,
        readerSourceStates: buildInitialReaderSourceStates(response.subscriptions),
        loadingSubscriptions: false,
        dataError: "",
      });
    } catch (error) {
      set({
        loadingSubscriptions: false,
        dataError: getErrorMessage(error),
      });
    }
  },
  async refreshReader(forceRefresh = false) {
    const token = get().authToken;

    if (!token) {
      return;
    }

    const { subscriptions } = get();
    const activeSubscriptions = subscriptions.filter(isReaderSubscription);
    const requestId = currentReaderRequestId + 1;
    currentReaderRequestId = requestId;

    const nextStates = buildInitialReaderSourceStates(subscriptions);

    set({
      loadingReader: forceRefresh && activeSubscriptions.length > 0,
      reloadingSourceId: "",
      items: [],
      readerErrors: [],
      readerSourceStates: nextStates,
      activeFetchCount: 0,
      completedFetchCount: 0,
      dataError: "",
    });

    if (!forceRefresh) {
      try {
        const response = await getReaderItems(token);

        if (currentReaderRequestId !== requestId) {
          return;
        }

        const nextReaderSourceStates = buildReaderSourceStatesFromItemsResponse(
          subscriptions,
          response,
          nextStates,
        );

        set({
          items: response.items,
          readerErrors: response.errors,
          readerSourceStates: nextReaderSourceStates,
          loadingReader: false,
          reloadingSourceId: "",
          activeFetchCount: 0,
          completedFetchCount: countCompletedReaderTasks(nextReaderSourceStates),
        });
      } catch (error) {
        if (currentReaderRequestId !== requestId) {
          return;
        }

        set({
          loadingReader: false,
          reloadingSourceId: "",
          activeFetchCount: 0,
          completedFetchCount: countCompletedReaderTasks(nextStates),
          dataError: getErrorMessage(error),
        });
      }

      return;
    }

    let cursor = 0;
    const workerCount = Math.min(activeSubscriptions.length, get().parallelFetchCount);

    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < activeSubscriptions.length) {
        const subscription = activeSubscriptions[cursor];
        cursor += 1;

        if (!subscription || currentReaderRequestId !== requestId) {
          return;
        }

        if (forceRefresh) {
          set((state) => {
            const nextReaderSourceStates = applyReaderSourceLoadingState(state.readerSourceStates, subscription);
            return {
              readerSourceStates: nextReaderSourceStates,
              activeFetchCount: countActiveReaderTasks(nextReaderSourceStates),
              completedFetchCount: countCompletedReaderTasks(nextReaderSourceStates),
            };
          });
        }

        try {
          const response = await getReaderSubscriptionItems(token, subscription.id, forceRefresh);

          if (currentReaderRequestId !== requestId) {
            return;
          }

          set((state) => {
            const nextSourceState = buildReaderSourceStateFromResponse(
              subscription,
              response,
              state.readerSourceStates[subscription.id] || nextStates[subscription.id],
              forceRefresh,
            );

            const nextReaderSourceStates: Record<string, ReaderSourceState> = {
              ...state.readerSourceStates,
              [subscription.id]: nextSourceState,
            };

            return {
              items: mergeItems(state.items, response.items, subscription.id),
              readerSourceStates: nextReaderSourceStates,
              activeFetchCount: countActiveReaderTasks(nextReaderSourceStates),
              completedFetchCount: countCompletedReaderTasks(nextReaderSourceStates),
            };
          });
        } catch (error) {
          if (currentReaderRequestId !== requestId) {
            return;
          }

          const message = getErrorMessage(error);

          set((state) => {
            const nextSourceState: ReaderSourceState = {
              ...(state.readerSourceStates[subscription.id] || nextStates[subscription.id]),
              status: "error",
              itemCount: 0,
              message,
              updatedAt: new Date().toISOString(),
            };

            const nextReaderSourceStates: Record<string, ReaderSourceState> = {
              ...state.readerSourceStates,
              [subscription.id]: nextSourceState,
            };

            return {
              readerErrors: [
                ...state.readerErrors.filter((entry) => entry.subscriptionId !== subscription.id),
                {
                  subscriptionId: subscription.id,
                  subscriptionName: subscription.name,
                  message,
                },
              ],
              readerSourceStates: nextReaderSourceStates,
              activeFetchCount: countActiveReaderTasks(nextReaderSourceStates),
              completedFetchCount: countCompletedReaderTasks(nextReaderSourceStates),
            };
          });
        }
      }
    });

    await Promise.all(workers);

    if (currentReaderRequestId === requestId) {
      set({
        loadingReader: false,
        reloadingSourceId: "",
        activeFetchCount: 0,
        completedFetchCount: countCompletedReaderTasks(get().readerSourceStates),
      });
    }
  },
  async refreshReaderSubscription(subscriptionId) {
    const token = get().authToken;
    const subscription = get().subscriptions.find((entry) => entry.id === subscriptionId);

    if (!token || !subscription || !isReaderSubscription(subscription)) {
      return false;
    }

    currentReaderRequestId += 1;

    set((state) => ({
      reloadingSourceId: subscriptionId,
      readerErrors: state.readerErrors.filter((entry) => entry.subscriptionId !== subscriptionId),
      readerSourceStates: applyReaderSourceLoadingState(state.readerSourceStates, subscription),
      activeFetchCount: countActiveReaderTasks(applyReaderSourceLoadingState(state.readerSourceStates, subscription)),
      completedFetchCount: countCompletedReaderTasks(applyReaderSourceLoadingState(state.readerSourceStates, subscription)),
      dataError: "",
    }));

    try {
      const response = await getReaderSubscriptionItems(token, subscriptionId, true);

      set((state) => {
        const nextSourceState: ReaderSourceState = {
          ...(state.readerSourceStates[subscriptionId] || {
            subscriptionId: subscription.id,
            subscriptionName: subscription.name,
            routePath: subscription.routePath,
            status: "idle",
            itemCount: 0,
            message: "等待拉取",
            updatedAt: "",
          }),
          subscriptionId: subscription.id,
          subscriptionName: subscription.name,
          routePath: subscription.routePath,
          status: "success",
          itemCount: response.items.length,
          message: response.items.length ? "拉取完成" : "已完成，但暂无文章",
          updatedAt: response.generatedAt,
        };

        const nextReaderSourceStates: Record<string, ReaderSourceState> = {
          ...state.readerSourceStates,
          [subscriptionId]: nextSourceState,
        };

        return {
          items: mergeItems(state.items, response.items, subscriptionId),
          reloadingSourceId: state.reloadingSourceId === subscriptionId ? "" : state.reloadingSourceId,
          readerSourceStates: nextReaderSourceStates,
          activeFetchCount: 0,
          completedFetchCount: countCompletedReaderTasks(nextReaderSourceStates),
        };
      });
      return true;
    } catch (error) {
      const message = getErrorMessage(error);

      set((state) => {
        const nextSourceState: ReaderSourceState = {
          ...(state.readerSourceStates[subscriptionId] || {
            subscriptionId: subscription.id,
            subscriptionName: subscription.name,
            routePath: subscription.routePath,
            status: "idle",
            itemCount: 0,
            message: "等待拉取",
            updatedAt: "",
          }),
          subscriptionId: subscription.id,
          subscriptionName: subscription.name,
          routePath: subscription.routePath,
          status: "error",
          itemCount: 0,
          message,
          updatedAt: new Date().toISOString(),
        };

        const nextReaderSourceStates: Record<string, ReaderSourceState> = {
          ...state.readerSourceStates,
          [subscriptionId]: nextSourceState,
        };

        return {
          reloadingSourceId: state.reloadingSourceId === subscriptionId ? "" : state.reloadingSourceId,
          readerErrors: [
            ...state.readerErrors.filter((entry) => entry.subscriptionId !== subscriptionId),
            {
              subscriptionId,
              subscriptionName: subscription.name,
              message,
            },
          ],
          readerSourceStates: nextReaderSourceStates,
          activeFetchCount: 0,
          completedFetchCount: countCompletedReaderTasks(nextReaderSourceStates),
        };
      });
      return false;
    }
  },
  async saveSource(input, subscriptionId) {
    const token = get().authToken;

    if (!token) {
      return false;
    }

    set({ savingSource: true, dataError: "" });

    try {
      await saveSubscription(token, input, subscriptionId);
      const workspaceData = await loadWorkspaceData(token);
      set({
        subscriptions: workspaceData.subscriptions,
        categories: workspaceData.categories,
        items: [],
        readerErrors: [],
        readerSourceStates: buildInitialReaderSourceStates(workspaceData.subscriptions),
        savingSource: false,
        reloadingSourceId: "",
      });
      void get().refreshReader(false);
      return true;
    } catch (error) {
      set({
        savingSource: false,
        dataError: getErrorMessage(error),
      });
      return false;
    }
  },
  async exportSourcesBackup() {
    const token = get().authToken;

    if (!token) {
      return null;
    }

    set({ exportingSources: true, dataError: "" });

    try {
      const backup = await exportSubscriptionsBackup(token);
      set({ exportingSources: false });
      return backup;
    } catch (error) {
      set({
        exportingSources: false,
        dataError: getErrorMessage(error),
      });
      return null;
    }
  },
  async importSourcesBackup(backup) {
    const token = get().authToken;

    if (!token) {
      return false;
    }

    set({ importingSources: true, dataError: "" });

    try {
      const response = await importSubscriptionsBackup(token, backup);
      set({
        subscriptions: response.subscriptions,
        categories: response.categories,
        items: [],
        readerErrors: [],
        readerSourceStates: buildInitialReaderSourceStates(response.subscriptions),
        importingSources: false,
        reloadingSourceId: "",
      });
      void get().refreshReader(false);
      return true;
    } catch (error) {
      set({
        importingSources: false,
        dataError: getErrorMessage(error),
      });
      return false;
    }
  },
  async testSource(input) {
    const token = get().authToken;

    if (!token) {
      throw new Error("当前未登录，无法测试订阅源。");
    }

    return testSubscription(token, input);
  },
  async createSourceCategory(name) {
    const token = get().authToken;

    if (!token) {
      return null;
    }

    set({ creatingCategory: true, dataError: "" });

    try {
      const response = await createCategory(token, name.trim());
      set((state) => ({
        categories: response.categories.length ? response.categories : state.categories,
        creatingCategory: false,
      }));
      return response.category;
    } catch (error) {
      set({
        creatingCategory: false,
        dataError: getErrorMessage(error),
      });
      return null;
    }
  },
  async renameSourceCategory(currentName, nextName) {
    const token = get().authToken;

    if (!token) {
      return false;
    }

    set({ creatingCategory: true, dataError: "" });

    try {
      const response = await renameCategory(token, currentName, nextName.trim());
      set({
        subscriptions: response.subscriptions,
        categories: response.categories,
        items: [],
        readerErrors: [],
        readerSourceStates: buildInitialReaderSourceStates(response.subscriptions),
        creatingCategory: false,
        reloadingSourceId: "",
      });
      void get().refreshReader(false);
      return true;
    } catch (error) {
      set({
        creatingCategory: false,
        dataError: getErrorMessage(error),
      });
      return false;
    }
  },
  async deleteSourceCategory(name) {
    const token = get().authToken;

    if (!token) {
      return false;
    }

    set({ creatingCategory: true, dataError: "" });

    try {
      const response = await deleteCategory(token, name);
      set({
        subscriptions: response.subscriptions,
        categories: response.categories,
        items: [],
        readerErrors: [],
        readerSourceStates: buildInitialReaderSourceStates(response.subscriptions),
        creatingCategory: false,
        reloadingSourceId: "",
      });
      void get().refreshReader(false);
      return true;
    } catch (error) {
      set({
        creatingCategory: false,
        dataError: getErrorMessage(error),
      });
      return false;
    }
  },
  async toggleSourceEnabled(subscriptionId, enabled) {
    const token = get().authToken;
    const subscription = get().subscriptions.find((entry) => entry.id === subscriptionId);

    if (!token || !subscription) {
      return false;
    }

    set({ savingSource: true, dataError: "" });

    try {
      await saveSubscription(
        token,
        {
          category: subscription.category,
          categories: subscription.categories?.length ? subscription.categories : [subscription.category],
          name: subscription.name,
          routePath: subscription.routePath,
          routeTemplate: subscription.routeTemplate,
          description: subscription.description,
          enabled,
        },
        subscriptionId,
      );
      const subscriptions = await loadSubscriptionsData(token);
      set({
        subscriptions: subscriptions.subscriptions,
        categories: subscriptions.categories,
        items: [],
        readerErrors: [],
        readerSourceStates: buildInitialReaderSourceStates(subscriptions.subscriptions),
        savingSource: false,
        reloadingSourceId: "",
      });
      void get().refreshReader(false);
      return true;
    } catch (error) {
      set({
        savingSource: false,
        dataError: getErrorMessage(error),
      });
      return false;
    }
  },
  async removeSource(subscriptionId) {
    const token = get().authToken;

    if (!token) {
      return false;
    }

    set({ removingSourceId: subscriptionId, dataError: "" });

    try {
      await removeSubscription(token, subscriptionId);
      const workspaceData = await loadWorkspaceData(token);
      set({
        subscriptions: workspaceData.subscriptions,
        categories: workspaceData.categories,
        items: [],
        readerErrors: [],
        readerSourceStates: buildInitialReaderSourceStates(workspaceData.subscriptions),
        removingSourceId: "",
        reloadingSourceId: "",
      });
      void get().refreshReader(false);
      return true;
    } catch (error) {
      set({
        removingSourceId: "",
        dataError: getErrorMessage(error),
      });
      return false;
    }
  },
  clearDataError() {
    set({ dataError: "" });
  },
}));
