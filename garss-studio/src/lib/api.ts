import type {
  AppSettingsResponse,
  CategoryResponse,
  LoginResponse,
  ReaderItemsResponse,
  ReaderSubscriptionResponse,
  SessionResponse,
  SubscriptionInput,
  SubscriptionTestResponse,
  SubscriptionsResponse,
} from "../types";

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  token?: string;
};

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new ApiError(payload?.error || "请求失败，请稍后重试。", response.status);
  }

  return payload as T;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "请求失败，请稍后重试。";
}

export async function login(accessCode: string): Promise<LoginResponse> {
  return requestJson<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: { accessCode },
  });
}

export async function getSession(token: string): Promise<SessionResponse> {
  return requestJson<SessionResponse>("/api/auth/session", {
    token,
  });
}

export async function getSubscriptions(token: string): Promise<SubscriptionsResponse> {
  return requestJson<SubscriptionsResponse>("/api/subscriptions", {
    token,
  });
}

export async function getAppSettings(token: string): Promise<AppSettingsResponse> {
  return requestJson<AppSettingsResponse>("/api/settings", {
    token,
  });
}

export async function updateAppSettings(
  token: string,
  input: Partial<AppSettingsResponse>,
): Promise<AppSettingsResponse> {
  return requestJson<AppSettingsResponse>("/api/settings", {
    method: "PUT",
    body: input,
    token,
  });
}

export async function createCategory(token: string, name: string): Promise<CategoryResponse> {
  return requestJson<CategoryResponse>("/api/categories", {
    method: "POST",
    body: { name },
    token,
  });
}

export async function renameCategory(token: string, currentName: string, nextName: string): Promise<SubscriptionsResponse> {
  return requestJson<SubscriptionsResponse>(`/api/categories/${encodeURIComponent(currentName)}`, {
    method: "PUT",
    body: { name: nextName },
    token,
  });
}

export async function deleteCategory(token: string, name: string): Promise<SubscriptionsResponse> {
  return requestJson<SubscriptionsResponse>(`/api/categories/${encodeURIComponent(name)}`, {
    method: "DELETE",
    token,
  });
}

export async function saveSubscription(
  token: string,
  input: SubscriptionInput,
  subscriptionId?: string,
): Promise<{ subscription: unknown }> {
  return requestJson<{ subscription: unknown }>(
    subscriptionId ? `/api/subscriptions/${subscriptionId}` : "/api/subscriptions",
    {
      method: subscriptionId ? "PUT" : "POST",
      body: input,
      token,
    },
  );
}

export async function testSubscription(
  token: string,
  input: SubscriptionInput,
): Promise<SubscriptionTestResponse> {
  return requestJson<SubscriptionTestResponse>("/api/subscriptions/test", {
    method: "POST",
    body: input,
    token,
  });
}

export async function removeSubscription(
  token: string,
  subscriptionId: string,
): Promise<{ deleted: true }> {
  return requestJson<{ deleted: true }>(`/api/subscriptions/${subscriptionId}`, {
    method: "DELETE",
    token,
  });
}

export async function getReaderItems(token: string): Promise<ReaderItemsResponse> {
  return requestJson<ReaderItemsResponse>("/api/reader/items", {
    token,
  });
}

export async function getReaderSubscriptionItems(
  token: string,
  subscriptionId: string,
  forceRefresh = false,
): Promise<ReaderSubscriptionResponse> {
  const searchParams = new URLSearchParams();

  if (forceRefresh) {
    searchParams.set("refresh", "1");
  }

  const path = searchParams.size
    ? `/api/reader/subscriptions/${subscriptionId}?${searchParams.toString()}`
    : `/api/reader/subscriptions/${subscriptionId}`;

  return requestJson<ReaderSubscriptionResponse>(path, {
    token,
  });
}
