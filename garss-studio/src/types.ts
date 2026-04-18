export type AppTab = "reader" | "sources" | "settings";

export interface Subscription {
  id: string;
  category: string;
  name: string;
  routePath: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FeedItem {
  id: string;
  subscriptionId: string;
  subscriptionName: string;
  routePath: string;
  title: string;
  link: string;
  author: string;
  publishedAt: string;
  excerpt: string;
  contentHtml: string;
  contentText: string;
}

export interface ReaderError {
  subscriptionId: string;
  subscriptionName: string;
  message: string;
}

export interface SessionResponse {
  authenticated: true;
  expiresAt: number;
  settingsUserId?: string;
}

export interface LoginResponse {
  token: string;
  expiresAt: number;
}

export interface SubscriptionsResponse {
  subscriptions: Subscription[];
  categories: string[];
}

export interface ReaderItemsResponse {
  generatedAt: string;
  items: FeedItem[];
  errors: ReaderError[];
}

export type ReaderSourceStatus = "idle" | "loading" | "success" | "error" | "disabled";

export interface ReaderSourceState {
  subscriptionId: string;
  subscriptionName: string;
  routePath: string;
  status: ReaderSourceStatus;
  itemCount: number;
  message: string;
  updatedAt: string;
}

export interface ReaderSubscriptionResponse {
  generatedAt: string;
  subscriptionId: string;
  subscriptionName: string;
  routePath: string;
  items: FeedItem[];
}

export interface SubscriptionInput {
  category: string;
  name: string;
  routePath: string;
  description: string;
  enabled: boolean;
}

export interface CategoryResponse {
  category: string;
  categories: string[];
}

export interface AppSettingsResponse {
  autoRefreshIntervalMinutes: number;
  parallelFetchCount: number;
  nextScheduledAt?: string;
  settingsUserId?: string;
}
