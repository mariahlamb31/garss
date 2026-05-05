import "dotenv/config";
import { createServer } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import Parser from "rss-parser";
import { Server as SocketIOServer, type Socket } from "socket.io";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import { buildFeedItemId } from "./feed-item-id.js";

interface AccessTokenPayload {
  type: "access";
  exp: number;
  accessCodeHash: string;
  settingsUserId?: string;
}

interface SubscriptionRecord {
  id: string;
  category: string;
  categories?: string[];
  name: string;
  routePath: string;
  routeTemplate?: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SubscriptionsBackupRecord {
  version: 1;
  exportedAt: string;
  subscriptions: SubscriptionRecord[];
  categories: string[];
}

type SubscriptionsBackupInput = Partial<SubscriptionsBackupRecord> & {
  sourceUrl?: string;
};

interface FeedItemRecord {
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

interface AppSettingsRecord {
  autoRefreshIntervalMinutes: number;
  parallelFetchCount: number;
}

type AppSettingsCollection = Record<string, AppSettingsRecord>;

interface ReaderCacheRecord {
  generatedAt: string;
  items: FeedItemRecord[];
}

type ReaderCacheCollection = Record<string, ReaderCacheRecord>;

type LooseFeedItem = Parser.Item & {
  author?: string;
  creator?: string;
  summary?: string;
  "content:encoded"?: string;
};

interface SocketTaskSnapshot {
  activeFetchCount: number;
  completedFetchCount: number;
  timestamp: string;
}

interface ServerStatusPayload {
  connected: boolean;
  label: string;
  schedulerEnabled: boolean;
  timestamp: string;
  nextScheduledAt: string;
  settingsUserId: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = process.env.APP_ROOT
  ? path.resolve(process.env.APP_ROOT)
  : path.basename(path.dirname(__dirname)) === "dist-server"
    ? path.resolve(__dirname, "..", "..")
    : path.resolve(__dirname, "..");
const storageDir = path.join(rootDir, "storage");
const subscriptionsFilePath = path.join(storageDir, "subscriptions.json");
const categoriesFilePath = path.join(storageDir, "categories.json");
const settingsFilePath = path.join(storageDir, "settings.json");
const readerCacheFilePath = path.join(storageDir, "reader-cache.json");
const port = Number(process.env.PORT || 3001);
const host = (process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const rsshubBaseUrl = (process.env.RSSHUB_BASE_URL || "http://127.0.0.1:1200").trim();
const schedulerEnabled = resolveBooleanEnv(process.env.SCHEDULER_ENABLED, true);

const parser = new Parser();
let activeFetchCount = 0;
let completedFetchCount = 0;
const userRefreshTimers = new Map<string, NodeJS.Timeout>();
let fullRefreshInFlight: Promise<void> | null = null;
let readerCacheWriteChain: Promise<void> = Promise.resolve();

const DEFAULT_AUTO_REFRESH_INTERVAL_MINUTES = 30;
const DEFAULT_PARALLEL_FETCH_COUNT = 2;
const FEED_FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const IMAGE_PROXY_TIMEOUT_MS = 12_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_PROXY_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const blockedImageProxyHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "backend", "frontend", "rsshub"]);
const openApiScanPaths = [
  path.join(rootDir, "server/**/*.ts"),
  path.join(rootDir, "dist-server/server/**/*.js"),
].map((value) => value.split(path.sep).join("/"));

function getAccessCode(): string {
  return (process.env.ACCESS_CODE || "banana").trim() || "banana";
}

function getSigningSecret(): string {
  return (process.env.ACCESS_TOKEN_SECRET || `${getAccessCode()}:garss-studio`).trim();
}

function isRsshubDocSubscription(subscription: Pick<SubscriptionRecord, "id">): boolean {
  return subscription.id.startsWith("rsshub-doc-");
}

function isReaderSubscription(subscription: Pick<SubscriptionRecord, "id" | "enabled">): boolean {
  return subscription.enabled && !isRsshubDocSubscription(subscription);
}

function isRsshubDocCategory(category: string): boolean {
  return normalizeCategory(category).startsWith("RSSHub 文档 /");
}

function getSessionTtlMs(): number {
  const hours = Number(process.env.SESSION_TTL_HOURS || 168);

  if (!Number.isFinite(hours) || hours <= 0) {
    return 168 * 60 * 60 * 1000;
  }

  return hours * 60 * 60 * 1000;
}

function getDefaultSettingsUserId(): string {
  return normalizeText(getAccessCode()) || "banana";
}

function safeEqualStrings(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function decodeBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signValue(value: string): string {
  return crypto.createHmac("sha256", getSigningSecret()).update(value).digest("base64url");
}

function hashAccessCode(accessCode: string): string {
  return crypto.createHash("sha256").update(accessCode).digest("hex");
}

function createToken(payload: AccessTokenPayload): { token: string; expiresAt: number } {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = signValue(encodedPayload);

  return {
    token: `${encodedPayload}.${signature}`,
    expiresAt: payload.exp,
  };
}

function verifyToken(token: string): AccessTokenPayload | null {
  if (!token.includes(".")) {
    return null;
  }

  const [encodedPayload, providedSignature] = token.split(".", 2);
  const expectedSignature = signValue(encodedPayload);

  if (!providedSignature || providedSignature.length !== expectedSignature.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload)) as AccessTokenPayload;

    if (payload.type !== "access" || payload.exp <= Date.now()) {
      return null;
    }

    if (payload.accessCodeHash !== hashAccessCode(getAccessCode())) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function getAccessTokenFromRequest(request: Request): string {
  const authorization = request.get("authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    return "";
  }

  return authorization.slice("Bearer ".length).trim();
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveBooleanEnv(value: string | undefined, fallbackValue: boolean): boolean {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return fallbackValue;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallbackValue;
}

function normalizeRoutePath(value: unknown): string {
  const rawValue = normalizeText(value);

  if (!rawValue) {
    return "";
  }

  try {
    const url = new URL(rawValue);

    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }

    return `${url.pathname}${url.search}${url.hash}` || "/";
  } catch {
    return rawValue.startsWith("/") ? rawValue : `/${rawValue}`;
  }
}

function normalizeRouteTemplate(value: unknown): string {
  const normalizedRoute = normalizeRoutePath(value);
  return normalizedRoute.includes(":") ? normalizedRoute : "";
}

function normalizeBoolean(value: unknown, fallbackValue = true): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }

    if (value === "false") {
      return false;
    }
  }

  return fallbackValue;
}

function normalizeCategory(value: unknown): string {
  const normalized = normalizeText(value).replace(/\s+/g, " ");
  return normalized || "未分类";
}

function clampParallelFetchCount(value: unknown): number {
  const normalized = Number(value);

  if (!Number.isFinite(normalized)) {
    return DEFAULT_PARALLEL_FETCH_COUNT;
  }

  return Math.max(1, Math.min(10, Math.floor(normalized)));
}

function clampAutoRefreshIntervalMinutes(value: unknown): number {
  const normalized = Number(value);

  if (!Number.isFinite(normalized)) {
    return DEFAULT_AUTO_REFRESH_INTERVAL_MINUTES;
  }

  return Math.max(1, Math.min(24 * 60, Math.floor(normalized)));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "发生了未知错误。";
}

function buildSocketTaskSnapshot(): SocketTaskSnapshot {
  return {
    activeFetchCount,
    completedFetchCount,
    timestamp: new Date().toISOString(),
  };
}

function buildDefaultSettings(): AppSettingsRecord {
  return {
    autoRefreshIntervalMinutes: DEFAULT_AUTO_REFRESH_INTERVAL_MINUTES,
    parallelFetchCount: DEFAULT_PARALLEL_FETCH_COUNT,
  };
}

function normalizeSettingsRecord(value: unknown): AppSettingsRecord {
  const source = value && typeof value === "object" ? value as Partial<AppSettingsRecord> : {};

  return {
    autoRefreshIntervalMinutes: clampAutoRefreshIntervalMinutes(source.autoRefreshIntervalMinutes),
    parallelFetchCount: clampParallelFetchCount(source.parallelFetchCount),
  };
}

function resolveSettingsUserId(value: unknown): string {
  return normalizeText(value) || getDefaultSettingsUserId();
}

function computeNextScheduledAt(intervalMinutes: number, fromDate = new Date()): Date {
  const safeIntervalMinutes = clampAutoRefreshIntervalMinutes(intervalMinutes);
  const intervalMs = safeIntervalMinutes * 60 * 1000;
  const dayStart = new Date(fromDate);
  dayStart.setHours(0, 0, 0, 0);

  const elapsedMs = Math.max(0, fromDate.getTime() - dayStart.getTime());
  const nextOffset = (Math.floor(elapsedMs / intervalMs) + 1) * intervalMs;

  return new Date(dayStart.getTime() + nextOffset);
}

function buildSettingsResponse(
  userId: string,
  settings: AppSettingsRecord,
): AppSettingsRecord & { nextScheduledAt: string; settingsUserId: string } {
  return {
    ...settings,
    nextScheduledAt: computeNextScheduledAt(settings.autoRefreshIntervalMinutes).toISOString(),
    settingsUserId: resolveSettingsUserId(userId),
  };
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function stripHtml(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractRawContentHtml(item: LooseFeedItem): string {
  const contentEncoded = item["content:encoded"];

  return normalizeText(
    (typeof contentEncoded === "string" && contentEncoded) ||
      (typeof item.content === "string" && item.content) ||
      (typeof item.summary === "string" && item.summary) ||
      "",
  );
}

function buildContentText(rawHtml: string): string {
  if (!rawHtml) {
    return "";
  }

  return decodeHtmlEntities(
    rawHtml
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/(p|div|section|article|li|blockquote|h[1-6])\s*>/gi, "\n\n")
      .replace(/<\s*li\b[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeEmbeddedUrl(
  value: string,
  baseUrl: string,
  kind: "href" | "src",
): string {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return "";
  }

  try {
    const resolved = new URL(trimmedValue, baseUrl);

    if (resolved.protocol === "http:" || resolved.protocol === "https:") {
      return resolved.toString();
    }

    if (kind === "href" && resolved.protocol === "mailto:") {
      return resolved.toString();
    }

    return "";
  } catch {
    return "";
  }
}

function sanitizeHtml(input: string, baseUrl: string): string {
  if (!input) {
    return "";
  }

  const blockedTagPattern = /<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|meta|link|base|source|svg|math|canvas|video|audio)\b[\s\S]*?(?:\/\s*>|>\s*[\s\S]*?<\s*\/\s*\1\s*>)/gi;

  let sanitized = input
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(blockedTagPattern, "")
    .replace(/\s(on\w+|style|srcset|formaction)\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "");

  sanitized = sanitized.replace(
    /\s(href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (_match, attributeName, _fullValue, doubleQuotedValue, singleQuotedValue, bareValue) => {
      const originalValue = doubleQuotedValue || singleQuotedValue || bareValue || "";
      const normalizedValue = normalizeEmbeddedUrl(
        originalValue,
        baseUrl,
        attributeName === "src" ? "src" : "href",
      );

      if (!normalizedValue) {
        return "";
      }

      return ` ${attributeName}="${escapeHtmlAttribute(normalizedValue)}"`;
    },
  );

  sanitized = sanitized.replace(/<\s*a\b([^>]*)>/gi, (_match, attrs) => `<a${attrs} target="_blank" rel="noreferrer">`);
  sanitized = sanitized.replace(/<\s*img\b([^>]*)>/gi, (_match, attrs) => `<img${attrs} loading="lazy" />`);

  return sanitized.trim();
}

function normalizeCachedFeedItemRecord(value: unknown, index: number): FeedItemRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const source = value as Partial<FeedItemRecord>;
  const subscriptionId = normalizeText(source.subscriptionId);
  const subscriptionName = normalizeText(source.subscriptionName);
  const routePath = normalizeText(source.routePath);
  const title = normalizeText(source.title) || "未命名条目";
  const link = normalizeText(source.link);
  const author = normalizeText(source.author);
  const publishedAt = normalizeText(source.publishedAt) || new Date().toISOString();
  const excerpt = normalizeText(source.excerpt);
  const contentHtml = normalizeText(source.contentHtml);
  const contentText = normalizeText(source.contentText) || excerpt;

  return {
    id: buildFeedItemId({
      subscriptionId,
      sourceLink: link || routePath,
      title,
      guid: normalizeText(source.id),
      publishedAtFingerprint: publishedAt,
      excerpt,
      contentText,
      index,
    }),
    subscriptionId,
    subscriptionName,
    routePath,
    title,
    link,
    author,
    publishedAt,
    excerpt: excerpt || contentText.slice(0, 220),
    contentHtml,
    contentText,
  };
}

function normalizeReaderCacheRecord(value: unknown): ReaderCacheRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const source = value as Partial<ReaderCacheRecord>;

  if (!Array.isArray(source.items)) {
    return null;
  }

  const generatedAt = normalizeText(source.generatedAt) || new Date().toISOString();
  const items = source.items
    .map((item, index) => normalizeCachedFeedItemRecord(item, index))
    .filter((item): item is FeedItemRecord => Boolean(item?.id && item.subscriptionId));

  return {
    generatedAt,
    items,
  };
}

function shouldForceRefresh(value: unknown): boolean {
  if (typeof value === "string") {
    return value === "1" || value.toLowerCase() === "true";
  }

  return value === true;
}

function buildRsshubUrl(routePath: string): string {
  const base = rsshubBaseUrl.endsWith("/") ? rsshubBaseUrl : `${rsshubBaseUrl}/`;
  return new URL(routePath, base).toString();
}

function normalizeImageProxyTargetUrl(value: unknown): string {
  const rawValue = normalizeText(value);

  if (!rawValue) {
    throw new Error("url 参数不能为空。");
  }

  let targetUrl: URL;

  try {
    targetUrl = new URL(rawValue);
  } catch {
    throw new Error("url 参数必须是合法的绝对地址。");
  }

  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    throw new Error("url 参数只支持 http 或 https。");
  }

  const hostname = targetUrl.hostname.toLowerCase();

  if (blockedImageProxyHosts.has(hostname) || hostname.endsWith(".localhost")) {
    throw new Error("不支持代理内部主机图片。");
  }

  return targetUrl.toString();
}

function buildImageProxyReferer(targetUrl: string): string {
  const parsedUrl = new URL(targetUrl);

  if (parsedUrl.hostname.toLowerCase().endsWith("doubanio.com")) {
    return "https://movie.douban.com/";
  }

  return `${parsedUrl.protocol}//${parsedUrl.host}/`;
}

function formatByteLimit(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function parseContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

async function readResponseTextWithinLimit(
  response: globalThis.Response,
  controller: AbortController,
  maxBytes: number,
): Promise<string> {
  const declaredContentLength = parseContentLength(response.headers.get("content-length"));

  if (declaredContentLength !== null && declaredContentLength > maxBytes) {
    controller.abort();
    throw new Error(`response too large (limit ${formatByteLimit(maxBytes)})`);
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new StringDecoder("utf8");
  let totalBytes = 0;
  const textParts: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      totalBytes += chunk.byteLength;

      if (totalBytes > maxBytes) {
        controller.abort();
        throw new Error(`response too large (limit ${formatByteLimit(maxBytes)})`);
      }

      const decodedChunk = decoder.write(chunk);

      if (decodedChunk) {
        textParts.push(decodedChunk);
      }
    }

    const finalChunk = decoder.end();

    if (finalChunk) {
      textParts.push(finalChunk);
    }

    return textParts.join("");
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors after the stream has completed or been aborted.
    }
  }
}

async function readResponseBufferWithinLimit(
  response: globalThis.Response,
  controller: AbortController,
  maxBytes: number,
): Promise<Buffer> {
  const declaredContentLength = parseContentLength(response.headers.get("content-length"));

  if (declaredContentLength !== null && declaredContentLength > maxBytes) {
    controller.abort();
    throw new Error(`response too large (limit ${formatByteLimit(maxBytes)})`);
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  let totalBytes = 0;
  const chunks: Buffer[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      totalBytes += chunk.byteLength;

      if (totalBytes > maxBytes) {
        controller.abort();
        throw new Error(`response too large (limit ${formatByteLimit(maxBytes)})`);
      }

      chunks.push(chunk);
    }

    return Buffer.concat(chunks, totalBytes);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors after the stream has completed or been aborted.
    }
  }
}

async function fetchFeedXml(targetUrl: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`upstream returned ${response.status}`);
    }

    return await readResponseTextWithinLimit(response, controller, MAX_FEED_BYTES);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`request timed out after ${FEED_FETCH_TIMEOUT_MS}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function choosePublishedAt(item: LooseFeedItem): string {
  return item.isoDate || item.pubDate || new Date().toISOString();
}

function buildExcerpt(contentText: string, item: LooseFeedItem): string {
  const contentSnippet = normalizeText(item.contentSnippet);
  return (contentSnippet ? stripHtml(contentSnippet) : contentText).slice(0, 220);
}

function normalizeFeedItem(
  subscription: SubscriptionRecord,
  item: LooseFeedItem,
  index: number,
): FeedItemRecord {
  const sourceLink =
    (typeof item.link === "string" && item.link) ||
    (typeof item.guid === "string" && item.guid) ||
    buildRsshubUrl(subscription.routePath);
  const rawContentHtml = extractRawContentHtml(item);
  const contentHtml = sanitizeHtml(rawContentHtml, sourceLink);
  const contentText = buildContentText(rawContentHtml) || normalizeText(item.contentSnippet);
  const title = (item.title || "未命名条目").trim();
  const publishedAt = choosePublishedAt(item);
  const excerpt = buildExcerpt(contentText, item);

  return {
    id: buildFeedItemId({
      subscriptionId: subscription.id,
      sourceLink,
      title,
      guid: normalizeText(item.guid),
      publishedAtFingerprint: normalizeText(item.isoDate) || normalizeText(item.pubDate),
      excerpt,
      contentText,
      index,
    }),
    subscriptionId: subscription.id,
    subscriptionName: subscription.name,
    routePath: subscription.routePath,
    title,
    link: sourceLink,
    author: normalizeText(item.creator) || normalizeText(item.author),
    publishedAt,
    excerpt,
    contentHtml,
    contentText,
  };
}

async function ensureStorage(): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });

  try {
    await fs.access(subscriptionsFilePath);
  } catch {
    await fs.writeFile(subscriptionsFilePath, "[]\n", "utf8");
  }

  try {
    await fs.access(categoriesFilePath);
  } catch {
    await fs.writeFile(categoriesFilePath, "[]\n", "utf8");
  }

  try {
    await fs.access(settingsFilePath);
  } catch {
    await fs.writeFile(
      settingsFilePath,
      `${JSON.stringify({ [getDefaultSettingsUserId()]: buildDefaultSettings() }, null, 2)}\n`,
      "utf8",
    );
  }

  try {
    await fs.access(readerCacheFilePath);
  } catch {
    await fs.writeFile(readerCacheFilePath, "{}\n", "utf8");
  }
}

async function readSubscriptions(): Promise<SubscriptionRecord[]> {
  await ensureStorage();
  const raw = await fs.readFile(subscriptionsFilePath, "utf8");

  try {
    const parsed = JSON.parse(raw) as SubscriptionRecord[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((subscription) => {
      const category = normalizeCategory(subscription?.category);

      return {
        ...subscription,
        category,
        categories: normalizeSubscriptionCategories(subscription?.categories, category),
        routeTemplate: normalizeRouteTemplate(subscription?.routeTemplate ?? subscription?.routePath),
        enabled: normalizeBoolean(subscription?.enabled, true),
      };
    });
  } catch {
    return [];
  }
}

function dedupeCategories(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = normalizeCategory(value);

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

function normalizeSubscriptionCategories(value: unknown, fallbackCategory: string): string[] {
  const rawValues = Array.isArray(value) ? value : [];
  const normalized = dedupeCategories([
    ...rawValues.map((entry) => normalizeCategory(entry)),
    fallbackCategory,
  ]);

  return normalized.length ? normalized : [fallbackCategory];
}

async function readCategories(): Promise<string[]> {
  await ensureStorage();
  const raw = await fs.readFile(categoriesFilePath, "utf8");

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return dedupeCategories(parsed.map((entry) => normalizeCategory(entry)));
  } catch {
    return [];
  }
}

async function writeCategories(categories: string[]): Promise<void> {
  await ensureStorage();
  const normalized = dedupeCategories(categories);
  await fs.writeFile(`${categoriesFilePath}.tmp`, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(`${categoriesFilePath}.tmp`, categoriesFilePath);
}

async function readSettingsCollection(): Promise<AppSettingsCollection> {
  await ensureStorage();
  const raw = await fs.readFile(settingsFilePath, "utf8");

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { [getDefaultSettingsUserId()]: buildDefaultSettings() };
    }

    if (
      "autoRefreshIntervalMinutes" in parsed ||
      "parallelFetchCount" in parsed
    ) {
      return {
        [getDefaultSettingsUserId()]: normalizeSettingsRecord(parsed),
      };
    }

    const entries = Object.entries(parsed).map(([userId, settings]) => [
      resolveSettingsUserId(userId),
      normalizeSettingsRecord(settings),
    ]);

    if (!entries.length) {
      return { [getDefaultSettingsUserId()]: buildDefaultSettings() };
    }

    return Object.fromEntries(entries);
  } catch {
    return { [getDefaultSettingsUserId()]: buildDefaultSettings() };
  }
}

async function writeSettingsCollection(settingsCollection: AppSettingsCollection): Promise<void> {
  await ensureStorage();
  const normalized = Object.fromEntries(
    Object.entries(settingsCollection).map(([userId, settings]) => [
      resolveSettingsUserId(userId),
      normalizeSettingsRecord(settings),
    ]),
  );
  await fs.writeFile(`${settingsFilePath}.tmp`, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(`${settingsFilePath}.tmp`, settingsFilePath);
}

async function readSettings(userId: string): Promise<AppSettingsRecord> {
  const settingsCollection = await readSettingsCollection();
  return settingsCollection[resolveSettingsUserId(userId)] || buildDefaultSettings();
}

async function writeSettings(userId: string, settings: AppSettingsRecord): Promise<void> {
  const normalizedUserId = resolveSettingsUserId(userId);
  const settingsCollection = await readSettingsCollection();
  settingsCollection[normalizedUserId] = normalizeSettingsRecord(settings);
  await writeSettingsCollection(settingsCollection);
}

async function readReaderCacheCollection(): Promise<ReaderCacheCollection> {
  await ensureStorage();
  const raw = await fs.readFile(readerCacheFilePath, "utf8");

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const entries = Object.entries(parsed)
      .map(([subscriptionId, cacheRecord]) => [
        normalizeText(subscriptionId),
        normalizeReaderCacheRecord(cacheRecord),
      ] as const)
      .filter((entry): entry is [string, ReaderCacheRecord] => Boolean(entry[0] && entry[1]));

    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function runWithReaderCacheWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = readerCacheWriteChain.then(operation, operation);
  readerCacheWriteChain = result.then(() => undefined, () => undefined);
  return result;
}

async function writeReaderCacheCollectionUnsafe(cacheCollection: ReaderCacheCollection): Promise<void> {
  await ensureStorage();
  await fs.writeFile(`${readerCacheFilePath}.tmp`, `${JSON.stringify(cacheCollection, null, 2)}\n`, "utf8");
  await fs.rename(`${readerCacheFilePath}.tmp`, readerCacheFilePath);
}

async function writeReaderCacheCollection(cacheCollection: ReaderCacheCollection): Promise<void> {
  await runWithReaderCacheWriteLock(async () => {
    await writeReaderCacheCollectionUnsafe(cacheCollection);
  });
}

async function updateReaderCacheCollection(
  updater: (cacheCollection: ReaderCacheCollection) => ReaderCacheCollection,
): Promise<void> {
  await runWithReaderCacheWriteLock(async () => {
    const currentCollection = await readReaderCacheCollection();
    await writeReaderCacheCollectionUnsafe(updater(currentCollection));
  });
}

function mergeReaderCacheRecord(
  currentRecord: ReaderCacheRecord | undefined,
  incomingRecord: ReaderCacheRecord,
): ReaderCacheRecord {
  if (!currentRecord) {
    return incomingRecord;
  }

  const currentTimestamp = new Date(currentRecord.generatedAt).getTime();
  const incomingTimestamp = new Date(incomingRecord.generatedAt).getTime();

  if (Number.isFinite(currentTimestamp) && Number.isFinite(incomingTimestamp) && currentTimestamp > incomingTimestamp) {
    return currentRecord;
  }

  return incomingRecord;
}

async function mergeReaderCacheCollection(partialCacheCollection: ReaderCacheCollection): Promise<void> {
  const entries = Object.entries(partialCacheCollection)
    .map(([subscriptionId, cacheRecord]) => [
      normalizeText(subscriptionId),
      normalizeReaderCacheRecord(cacheRecord),
    ] as const)
    .filter((entry): entry is [string, ReaderCacheRecord] => Boolean(entry[0] && entry[1]));

  if (!entries.length) {
    return;
  }

  await updateReaderCacheCollection((currentCollection) => {
    const nextCollection = { ...currentCollection };

    for (const [subscriptionId, cacheRecord] of entries) {
      nextCollection[subscriptionId] = mergeReaderCacheRecord(nextCollection[subscriptionId], cacheRecord);
    }

    return nextCollection;
  });
}

async function readReaderCache(
  subscriptionId: string,
  cacheCollection?: ReaderCacheCollection,
): Promise<ReaderCacheRecord | null> {
  const currentCollection = cacheCollection || await readReaderCacheCollection();
  return currentCollection[subscriptionId] || null;
}

async function writeReaderCache(subscriptionId: string, cacheRecord: ReaderCacheRecord): Promise<void> {
  const normalizedSubscriptionId = normalizeText(subscriptionId);
  const normalizedRecord = normalizeReaderCacheRecord(cacheRecord);

  if (!normalizedSubscriptionId || !normalizedRecord) {
    return;
  }

  await updateReaderCacheCollection((cacheCollection) => ({
    ...cacheCollection,
    [normalizedSubscriptionId]: normalizedRecord,
  }));
}

async function deleteReaderCache(subscriptionId: string): Promise<void> {
  const normalizedSubscriptionId = normalizeText(subscriptionId);

  if (!normalizedSubscriptionId) {
    return;
  }

  await updateReaderCacheCollection((cacheCollection) => {
    if (!(normalizedSubscriptionId in cacheCollection)) {
      return cacheCollection;
    }

    const nextCollection = { ...cacheCollection };
    delete nextCollection[normalizedSubscriptionId];
    return nextCollection;
  });
}

async function updateReaderCacheSubscriptionMetadata(subscription: SubscriptionRecord): Promise<void> {
  const cacheRecord = await readReaderCache(subscription.id);

  if (!cacheRecord) {
    return;
  }

  await writeReaderCache(subscription.id, {
    ...cacheRecord,
    items: cacheRecord.items.map((item) => ({
      ...item,
      subscriptionName: subscription.name,
      routePath: subscription.routePath,
    })),
  });
}

async function buildServerStatusPayload(userId: string): Promise<ServerStatusPayload> {
  const normalizedUserId = resolveSettingsUserId(userId);
  const settings = await readSettings(normalizedUserId);

  return {
    connected: true,
    label: schedulerEnabled ? "已连接" : "已连接（自动调度已禁用）",
    schedulerEnabled,
    timestamp: new Date().toISOString(),
    nextScheduledAt: computeNextScheduledAt(settings.autoRefreshIntervalMinutes).toISOString(),
    settingsUserId: normalizedUserId,
  };
}

async function emitServerStatusToSocket(socket: Socket): Promise<void> {
  const auth = socket.data.auth as AccessTokenPayload | undefined;
  const userId = resolveSettingsUserId(auth?.settingsUserId);
  socket.emit("server:status", await buildServerStatusPayload(userId));
}

async function broadcastServerStatusForUser(userId: string): Promise<void> {
  const normalizedUserId = resolveSettingsUserId(userId);
  const payload = await buildServerStatusPayload(normalizedUserId);

  for (const socket of io.sockets.sockets.values()) {
    const auth = socket.data.auth as AccessTokenPayload | undefined;

    if (resolveSettingsUserId(auth?.settingsUserId) !== normalizedUserId) {
      continue;
    }

    socket.emit("server:status", payload);
  }
}

async function ensureCategory(category: string): Promise<void> {
  await ensureCategories([category]);
}

async function ensureCategories(nextCategories: string[]): Promise<void> {
  const categories = await readCategories();
  let changed = false;

  for (const category of dedupeCategories(nextCategories)) {
    if (categories.includes(category)) {
      continue;
    }

    categories.push(category);
    changed = true;
  }

  if (changed) {
    await writeCategories(categories);
  }
}

function buildCategoryList(subscriptions: SubscriptionRecord[], explicitCategories: string[]): string[] {
  return dedupeCategories([
    ...explicitCategories,
    ...subscriptions.flatMap((subscription) => (subscription.categories?.length ? subscription.categories : [subscription.category])),
  ]);
}

function buildUserCategoryList(subscriptions: SubscriptionRecord[], explicitCategories: string[]): string[] {
  return buildCategoryList(subscriptions, explicitCategories).filter((category) => !isRsshubDocCategory(category));
}

function normalizeBackupSubscriptions(value: unknown): SubscriptionRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("备份文件缺少 subscriptions 数组。");
  }

  const now = new Date().toISOString();
  const usedIds = new Set<string>();
  const usedRoutePaths = new Set<string>();

  return value.map((entry, index) => {
    const raw = entry as Partial<SubscriptionRecord>;
    const category = normalizeCategory(raw?.category);
    const categories = normalizeSubscriptionCategories(raw?.categories, category).filter((item) => !isRsshubDocCategory(item));
    const normalizedCategories = categories.length ? categories : [category].filter((item) => !isRsshubDocCategory(item));
    const name = normalizeText(raw?.name);
    const routePath = normalizeRoutePath(raw?.routePath);
    const routeTemplate = normalizeRouteTemplate(raw?.routeTemplate);
    const idCandidate = normalizeText(raw?.id) || crypto.randomUUID();
    const id = usedIds.has(idCandidate) || idCandidate.startsWith("rsshub-doc-") ? crypto.randomUUID() : idCandidate;

    if (!name) {
      throw new Error(`第 ${index + 1} 个订阅源缺少名称。`);
    }

    if (!routePath || routePath === "/") {
      throw new Error(`第 ${index + 1} 个订阅源缺少订阅地址。`);
    }

    if (usedRoutePaths.has(routePath)) {
      throw new Error(`备份文件中存在重复订阅地址：${routePath}`);
    }

    usedIds.add(id);
    usedRoutePaths.add(routePath);

    return {
      id,
      category: normalizedCategories[0] || "未分类",
      categories: normalizedCategories.length ? normalizedCategories : ["未分类"],
      name,
      routePath,
      routeTemplate,
      description: normalizeText(raw?.description),
      enabled: normalizeBoolean(raw?.enabled, true),
      createdAt: normalizeText(raw?.createdAt) || now,
      updatedAt: normalizeText(raw?.updatedAt) || now,
    };
  });
}

function normalizeBackupCategories(value: unknown, subscriptions: SubscriptionRecord[]): string[] {
  const explicitCategories = Array.isArray(value)
    ? dedupeCategories(value.map((entry) => normalizeCategory(entry))).filter((category) => !isRsshubDocCategory(category))
    : [];

  return buildUserCategoryList(subscriptions, explicitCategories);
}

function normalizeBackupSourceUrl(value: unknown): string {
  const rawValue = normalizeText(value);

  if (!rawValue) {
    return "";
  }

  try {
    const url = new URL(rawValue);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }

    return url.toString();
  } catch {
    return "";
  }
}

async function readSubscriptionsBackupInput(body: SubscriptionsBackupInput): Promise<SubscriptionsBackupInput> {
  const sourceUrl = normalizeBackupSourceUrl(body?.sourceUrl);

  if (!sourceUrl) {
    return body;
  }

  const response = await fetch(sourceUrl, {
    headers: {
      accept: "application/json,text/plain;q=0.9,*/*;q=0.5",
      "user-agent": "GARSS Studio backup importer",
    },
  });

  if (!response.ok) {
    throw new Error(`备份 URL 无法访问：HTTP ${response.status}`);
  }

  const text = await response.text();

  if (text.length > 5 * 1024 * 1024) {
    throw new Error("备份 URL 内容超过 5MB。");
  }

  try {
    return JSON.parse(text) as SubscriptionsBackupInput;
  } catch {
    throw new Error("备份 URL 返回的内容不是有效 JSON。");
  }
}

async function writeSubscriptions(subscriptions: SubscriptionRecord[]): Promise<void> {
  await ensureStorage();
  await fs.writeFile(`${subscriptionsFilePath}.tmp`, `${JSON.stringify(subscriptions, null, 2)}\n`, "utf8");
  await fs.rename(`${subscriptionsFilePath}.tmp`, subscriptionsFilePath);
}

function ensureAuthenticated(request: Request, response: Response, next: NextFunction): void {
  const token = getAccessTokenFromRequest(request);

  if (!token) {
    response.status(401).json({ error: "缺少访问令牌，请重新输入提取码。" });
    return;
  }

  const payload = verifyToken(token);

  if (!payload) {
    response.status(401).json({ error: "登录状态已失效，请重新输入提取码。" });
    return;
  }

  response.locals.auth = payload;
  next();
}

async function fetchSubscriptionItems(subscription: SubscriptionRecord): Promise<FeedItemRecord[]> {
  const xml = await fetchFeedXml(buildRsshubUrl(subscription.routePath));
  const feed = await parser.parseString(xml);
  const items = Array.isArray(feed.items) ? feed.items : [];

  return items.slice(0, 40).map((item, index) => normalizeFeedItem(subscription, item, index));
}

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  path: "/socket.io",
});
const openApiSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "GARSS Studio Backend API",
      version: "0.1.0",
      description:
        "GARSS Studio backend API. In development and production, browser access should still go through the single gateway entry and use /api/* paths.",
    },
    servers: [
      {
        url: "/",
        description: "Single-port gateway entry",
      },
    ],
    tags: [
      { name: "System", description: "Health and maintenance endpoints" },
      { name: "Auth", description: "Access code login and session validation" },
      { name: "Subscriptions", description: "Subscription and category management" },
      { name: "Settings", description: "Per-user fetch settings" },
      { name: "Reader", description: "Cached RSS reads and forced refreshes" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Bearer token from /api/auth/login",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            error: { type: "string" },
          },
          required: ["error"],
        },
        LoginRequest: {
          type: "object",
          properties: {
            accessCode: { type: "string", example: "banana" },
          },
          required: ["accessCode"],
        },
        LoginResponse: {
          type: "object",
          properties: {
            token: { type: "string" },
            expiresAt: { type: "number", format: "double" },
          },
          required: ["token", "expiresAt"],
        },
        SessionResponse: {
          type: "object",
          properties: {
            authenticated: { type: "boolean", example: true },
            expiresAt: { type: "number", format: "double" },
            settingsUserId: { type: "string", example: "banana" },
          },
          required: ["authenticated", "expiresAt", "settingsUserId"],
        },
        Subscription: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            category: { type: "string" },
            name: { type: "string" },
            routePath: { type: "string", example: "/36kr/newsflashes" },
            description: { type: "string" },
            enabled: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
          required: [
            "id",
            "category",
            "name",
            "routePath",
            "description",
            "enabled",
            "createdAt",
            "updatedAt",
          ],
        },
        SubscriptionInput: {
          type: "object",
          properties: {
            category: { type: "string", example: "软件工具" },
            name: { type: "string", example: "36氪快讯" },
            routePath: { type: "string", example: "/36kr/newsflashes" },
            description: { type: "string", example: "36Kr 快讯" },
            enabled: { type: "boolean", example: true },
          },
          required: ["category", "name", "routePath"],
        },
        SubscriptionsResponse: {
          type: "object",
          properties: {
            subscriptions: {
              type: "array",
              items: { $ref: "#/components/schemas/Subscription" },
            },
            categories: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["subscriptions", "categories"],
        },
        SettingsResponse: {
          type: "object",
          properties: {
            autoRefreshIntervalMinutes: { type: "integer", example: 30 },
            parallelFetchCount: { type: "integer", example: 2 },
            nextScheduledAt: { type: "string", format: "date-time" },
            settingsUserId: { type: "string", example: "banana" },
          },
          required: [
            "autoRefreshIntervalMinutes",
            "parallelFetchCount",
            "nextScheduledAt",
            "settingsUserId",
          ],
        },
        SettingsUpdateRequest: {
          type: "object",
          properties: {
            autoRefreshIntervalMinutes: { type: "integer", example: 30 },
            parallelFetchCount: { type: "integer", example: 2 },
          },
        },
        CategoryCreateRequest: {
          type: "object",
          properties: {
            name: { type: "string", example: "软件工具" },
          },
          required: ["name"],
        },
        CategoryCreateResponse: {
          type: "object",
          properties: {
            category: { type: "string" },
            categories: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["category", "categories"],
        },
        SubscriptionResponse: {
          type: "object",
          properties: {
            subscription: { $ref: "#/components/schemas/Subscription" },
          },
          required: ["subscription"],
        },
        DeleteResponse: {
          type: "object",
          properties: {
            deleted: { type: "boolean", example: true },
          },
          required: ["deleted"],
        },
        ReaderItem: {
          type: "object",
          properties: {
            id: { type: "string" },
            subscriptionId: { type: "string", format: "uuid" },
            subscriptionName: { type: "string" },
            routePath: { type: "string" },
            title: { type: "string" },
            link: { type: "string" },
            author: { type: "string" },
            publishedAt: { type: "string", format: "date-time" },
            excerpt: { type: "string" },
            contentHtml: { type: "string" },
            contentText: { type: "string" },
          },
          required: [
            "id",
            "subscriptionId",
            "subscriptionName",
            "routePath",
            "title",
            "link",
            "author",
            "publishedAt",
            "excerpt",
            "contentHtml",
            "contentText",
          ],
        },
        ReaderItemsError: {
          type: "object",
          properties: {
            subscriptionId: { type: "string", format: "uuid" },
            subscriptionName: { type: "string" },
            message: { type: "string" },
          },
          required: ["subscriptionId", "subscriptionName", "message"],
        },
        ReaderItemsResponse: {
          type: "object",
          properties: {
            generatedAt: { type: "string", format: "date-time" },
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/ReaderItem" },
            },
            errors: {
              type: "array",
              items: { $ref: "#/components/schemas/ReaderItemsError" },
            },
          },
          required: ["generatedAt", "items", "errors"],
        },
        ReaderSubscriptionResponse: {
          type: "object",
          properties: {
            generatedAt: { type: "string", format: "date-time" },
            subscriptionId: { type: "string", format: "uuid" },
            subscriptionName: { type: "string" },
            routePath: { type: "string" },
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/ReaderItem" },
            },
          },
          required: ["generatedAt", "subscriptionId", "subscriptionName", "routePath", "items"],
        },
        ReaderFetchErrorResponse: {
          type: "object",
          properties: {
            error: { type: "string" },
            subscriptionId: { type: "string", format: "uuid" },
            subscriptionName: { type: "string" },
            routePath: { type: "string" },
          },
          required: ["error", "subscriptionId", "subscriptionName", "routePath"],
        },
      },
    },
  },
  apis: openApiScanPaths,
});

function broadcastTaskSnapshot(): void {
  io.emit("reader:tasks", buildSocketTaskSnapshot());
}

async function fetchSubscriptionItemsTracked(subscription: SubscriptionRecord): Promise<FeedItemRecord[]> {
  if (activeFetchCount === 0) {
    completedFetchCount = 0;
  }

  activeFetchCount += 1;
  broadcastTaskSnapshot();

  try {
    return await fetchSubscriptionItems(subscription);
  } finally {
    activeFetchCount = Math.max(0, activeFetchCount - 1);
    completedFetchCount += 1;
    broadcastTaskSnapshot();
  }
}

async function fetchReaderCacheRecord(subscription: SubscriptionRecord): Promise<ReaderCacheRecord> {
  const items = await fetchSubscriptionItemsTracked(subscription);

  return {
    generatedAt: new Date().toISOString(),
    items,
  };
}

async function fetchAndCacheSubscriptionItems(
  subscription: SubscriptionRecord,
): Promise<ReaderCacheRecord> {
  const cacheRecord = await fetchReaderCacheRecord(subscription);
  await writeReaderCache(subscription.id, cacheRecord);
  return cacheRecord;
}

async function refreshSubscriptionIntoCache(subscription: SubscriptionRecord): Promise<void> {
  const cacheRecord = await fetchReaderCacheRecord(subscription);
  await writeReaderCache(subscription.id, cacheRecord);
}

function buildEmptyReaderCacheRecord(): ReaderCacheRecord {
  return {
    generatedAt: "",
    items: [],
  };
}

async function getSubscriptionReaderData(
  subscription: SubscriptionRecord,
  forceRefresh: boolean,
  cacheCollection?: ReaderCacheCollection,
): Promise<ReaderCacheRecord> {
  if (!forceRefresh) {
    const cached = await readReaderCache(subscription.id, cacheCollection);

    if (cached) {
      return cached;
    }

    return buildEmptyReaderCacheRecord();
  }

  return fetchAndCacheSubscriptionItems(subscription);
}

async function refreshAllSubscriptionsIntoCache(parallelFetchCount: number): Promise<void> {
  if (fullRefreshInFlight) {
    return fullRefreshInFlight;
  }

  fullRefreshInFlight = (async () => {
    const subscriptions = await readSubscriptions();
    const enabledSubscriptions = subscriptions.filter(isReaderSubscription);
    const workerCount = Math.min(enabledSubscriptions.length, clampParallelFetchCount(parallelFetchCount));

    if (!workerCount) {
      activeFetchCount = 0;
      completedFetchCount = 0;
      broadcastTaskSnapshot();
      return;
    }

    let cursor = 0;

    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < enabledSubscriptions.length) {
        const subscription = enabledSubscriptions[cursor];
        cursor += 1;

        if (!subscription) {
          return;
        }

        try {
          // Scheduler writes each subscription result immediately through the serialized cache path.
          await refreshSubscriptionIntoCache(subscription);
        } catch (error) {
          console.error(`[scheduler] failed to refresh ${subscription.name}:`, getErrorMessage(error));
        }
      }
    });

    await Promise.all(workers);
  })();

  try {
    await fullRefreshInFlight;
  } finally {
    fullRefreshInFlight = null;
  }
}

function clearUserRefreshTimer(userId: string): void {
  const normalizedUserId = resolveSettingsUserId(userId);
  const existingTimer = userRefreshTimers.get(normalizedUserId);

  if (!existingTimer) {
    return;
  }

  clearTimeout(existingTimer);
  userRefreshTimers.delete(normalizedUserId);
}

function clearAllUserRefreshTimers(): void {
  for (const [userId, timer] of userRefreshTimers.entries()) {
    clearTimeout(timer);
    userRefreshTimers.delete(userId);
  }
}

async function scheduleUserRefresh(userId: string): Promise<void> {
  const normalizedUserId = resolveSettingsUserId(userId);
  clearUserRefreshTimer(normalizedUserId);

  if (!schedulerEnabled) {
    return;
  }

  const settings = await readSettings(normalizedUserId);
  const nextScheduledAt = computeNextScheduledAt(settings.autoRefreshIntervalMinutes);
  const delay = Math.max(1000, nextScheduledAt.getTime() - Date.now());

  const timer = setTimeout(() => {
    void (async () => {
      userRefreshTimers.delete(normalizedUserId);
      await scheduleUserRefresh(normalizedUserId);
      await broadcastServerStatusForUser(normalizedUserId);
      await refreshAllSubscriptionsIntoCache(settings.parallelFetchCount);
    })();
  }, delay);

  userRefreshTimers.set(normalizedUserId, timer);
}

async function scheduleAllUserRefreshJobs(): Promise<void> {
  if (!schedulerEnabled) {
    clearAllUserRefreshTimers();
    return;
  }

  const settingsCollection = await readSettingsCollection();
  const userIds = Object.keys(settingsCollection);

  if (!userIds.length) {
    await scheduleUserRefresh(getDefaultSettingsUserId());
    return;
  }

  await Promise.all(userIds.map((userId) => scheduleUserRefresh(userId)));
}

app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));
app.get(/^\/api\/docs$/, (_request, response) => {
  response.redirect("/api/docs/");
});
app.get("/api/openapi.json", (_request, response) => {
  response.json(openApiSpec);
});
app.use(
  "/api/docs",
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    explorer: true,
    swaggerOptions: {
      url: "/api/openapi.json",
    },
  }),
);

/**
 * @openapi
 * /api/health:
 *   get:
 *     tags:
 *       - System
 *     summary: Health check for the backend service
 *     responses:
 *       200:
 *         description: Service status and current subscription count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 rsshubBaseUrl:
 *                   type: string
 *                 subscriptions:
 *                   type: integer
 *                 now:
 *                   type: string
 *                   format: date-time
 *               required:
 *                 - ok
 *                 - rsshubBaseUrl
 *                 - subscriptions
 *                 - now
 */
app.get("/api/health", async (_request, response) => {
  const subscriptions = await readSubscriptions();
  response.json({
    ok: true,
    rsshubBaseUrl,
    subscriptions: subscriptions.length,
    now: new Date().toISOString(),
  });
});

app.get("/api/image-proxy", async (request, response) => {
  let targetUrl: string;

  try {
    targetUrl = normalizeImageProxyTargetUrl(request.query.url);
  } catch (error) {
    response.status(400).json({ error: getErrorMessage(error) });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_PROXY_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(targetUrl, {
      headers: {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        referer: buildImageProxyReferer(targetUrl),
        "user-agent": IMAGE_PROXY_USER_AGENT,
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!upstreamResponse.ok) {
      response.status(upstreamResponse.status).json({ error: `upstream returned ${upstreamResponse.status}` });
      return;
    }

    const contentType = upstreamResponse.headers.get("content-type") || "application/octet-stream";

    if (!contentType.toLowerCase().startsWith("image/")) {
      response.status(415).json({ error: "upstream content is not an image" });
      return;
    }

    const imageBuffer = await readResponseBufferWithinLimit(upstreamResponse, controller, MAX_IMAGE_BYTES);

    response.setHeader("Content-Type", contentType);
    response.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(imageBuffer);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      response.status(504).json({ error: `request timed out after ${IMAGE_PROXY_TIMEOUT_MS}ms` });
      return;
    }

    response.status(502).json({ error: getErrorMessage(error) });
  } finally {
    clearTimeout(timeout);
  }
});

app.get("/api/rsshub/fetch", ensureAuthenticated, async (request, response) => {
  const routePath = normalizeText(request.query.routePath);

  if (!routePath || !routePath.startsWith("/")) {
    response.status(400).json({ error: "routePath 必须是以 / 开头的 RSSHub 路径。" });
    return;
  }

  try {
    const xml = await fetchFeedXml(buildRsshubUrl(routePath));
    response.type("application/xml").send(xml);
  } catch (error) {
    response.status(502).json({ error: getErrorMessage(error), routePath });
  }
});

io.use((socket, next) => {
  const token = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token.trim() : "";
  const payload = verifyToken(token);

  if (!payload) {
    next(new Error("UNAUTHORIZED"));
    return;
  }

  socket.data.auth = payload;
  next();
});

io.on("connection", (socket) => {
  void emitServerStatusToSocket(socket);
  socket.emit("reader:tasks", buildSocketTaskSnapshot());
});

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags:
 *       - Auth
 *     summary: Exchange access code for a bearer token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: Bearer token issued
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *       400:
 *         description: Missing access code
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Invalid access code
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.post("/api/auth/login", (request, response) => {
  const accessCode = normalizeText(request.body?.accessCode);

  if (!accessCode) {
    response.status(400).json({ error: "请输入提取码。" });
    return;
  }

  if (!safeEqualStrings(accessCode, getAccessCode())) {
    response.status(401).json({ error: "提取码不正确。" });
    return;
  }

  const payload: AccessTokenPayload = {
    type: "access",
    exp: Date.now() + getSessionTtlMs(),
    accessCodeHash: hashAccessCode(getAccessCode()),
    settingsUserId: accessCode,
  };

  response.json(createToken(payload));
});

/**
 * @openapi
 * /api/auth/session:
 *   get:
 *     tags:
 *       - Auth
 *     summary: Validate current bearer token
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Session is valid
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SessionResponse'
 *       401:
 *         description: Missing or invalid bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.get("/api/auth/session", ensureAuthenticated, (_request, response) => {
  const auth = response.locals.auth as AccessTokenPayload;
  response.json({
    authenticated: true,
    expiresAt: auth.exp,
    settingsUserId: resolveSettingsUserId(auth.settingsUserId),
  });
});

/**
 * @openapi
 * /api/subscriptions:
 *   get:
 *     tags:
 *       - Subscriptions
 *     summary: List subscriptions and merged category list
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current subscriptions and categories
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SubscriptionsResponse'
 *       401:
 *         description: Missing or invalid bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *   post:
 *     tags:
 *       - Subscriptions
 *     summary: Create a subscription
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SubscriptionInput'
 *     responses:
 *       201:
 *         description: Subscription created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SubscriptionResponse'
 *       400:
 *         description: Missing name or routePath
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Missing or invalid bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Duplicate routePath
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.get("/api/subscriptions", ensureAuthenticated, async (_request, response) => {
  const subscriptions = await readSubscriptions();
  const categories = buildCategoryList(subscriptions, await readCategories());
  response.json({ subscriptions, categories });
});

app.get("/api/subscriptions/backup", ensureAuthenticated, async (_request, response) => {
  const subscriptions = await readSubscriptions();
  const userSubscriptions = subscriptions.filter((subscription) => !isRsshubDocSubscription(subscription));
  const categories = buildUserCategoryList(userSubscriptions, await readCategories());

  const backup: SubscriptionsBackupRecord = {
    version: 1,
    exportedAt: new Date().toISOString(),
    subscriptions: userSubscriptions,
    categories,
  };

  response.json(backup);
});

app.post("/api/subscriptions/backup", ensureAuthenticated, async (request, response) => {
  let importedSubscriptions: SubscriptionRecord[];
  let importedCategories: string[];

  try {
    const backupInput = await readSubscriptionsBackupInput(request.body || {});
    importedSubscriptions = normalizeBackupSubscriptions(backupInput?.subscriptions);
    importedCategories = normalizeBackupCategories(backupInput?.categories, importedSubscriptions);
  } catch (error) {
    response.status(400).json({ error: getErrorMessage(error) });
    return;
  }

  const currentSubscriptions = await readSubscriptions();
  const currentReaderSubscriptions = currentSubscriptions.filter((subscription) => !isRsshubDocSubscription(subscription));
  const rsshubDocSubscriptions = currentSubscriptions.filter(isRsshubDocSubscription);
  const rsshubDocCategories = (await readCategories()).filter(isRsshubDocCategory);
  const nextSubscriptions = [...importedSubscriptions, ...rsshubDocSubscriptions];
  const nextCategories = dedupeCategories([...importedCategories, ...rsshubDocCategories]);
  const importedById = new Map(importedSubscriptions.map((subscription) => [subscription.id, subscription]));

  await writeSubscriptions(nextSubscriptions);
  await writeCategories(nextCategories);

  await Promise.all(
    currentReaderSubscriptions.map(async (subscription) => {
      const importedSubscription = importedById.get(subscription.id);

      if (!importedSubscription || importedSubscription.routePath !== subscription.routePath) {
        await deleteReaderCache(subscription.id);
      } else if (importedSubscription.name !== subscription.name) {
        await updateReaderCacheSubscriptionMetadata(importedSubscription);
      }
    }),
  );

  const categories = buildCategoryList(nextSubscriptions, await readCategories());
  response.json({
    importedCount: importedSubscriptions.length,
    subscriptions: nextSubscriptions,
    categories,
  });
});

/**
 * @openapi
 * /api/settings:
 *   get:
 *     tags:
 *       - Settings
 *     summary: Read fetch settings for the authenticated user bucket
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Effective settings with next scheduled run
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SettingsResponse'
 *       401:
 *         description: Missing or invalid bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *   put:
 *     tags:
 *       - Settings
 *     summary: Update fetch settings for the authenticated user bucket
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SettingsUpdateRequest'
 *     responses:
 *       200:
 *         description: Updated settings with next scheduled run
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SettingsResponse'
 *       401:
 *         description: Missing or invalid bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.get("/api/settings", ensureAuthenticated, async (_request, response) => {
  const auth = response.locals.auth as AccessTokenPayload;
  const userId = resolveSettingsUserId(auth.settingsUserId);
  const settings = await readSettings(userId);
  response.json(buildSettingsResponse(userId, settings));
});

app.put("/api/settings", ensureAuthenticated, async (request, response) => {
  const auth = response.locals.auth as AccessTokenPayload;
  const settingsUserId = resolveSettingsUserId(auth.settingsUserId);
  const currentSettings = await readSettings(settingsUserId);
  const nextSettings = normalizeSettingsRecord({
    ...currentSettings,
    autoRefreshIntervalMinutes:
      request.body?.autoRefreshIntervalMinutes ?? currentSettings.autoRefreshIntervalMinutes,
    parallelFetchCount:
      request.body?.parallelFetchCount ?? currentSettings.parallelFetchCount,
  });

  await writeSettings(settingsUserId, nextSettings);
  await scheduleUserRefresh(settingsUserId);
  await broadcastServerStatusForUser(settingsUserId);
  response.json(buildSettingsResponse(settingsUserId, nextSettings));
});

/**
 * @openapi
 * /api/categories:
 *   post:
 *     tags:
 *       - Subscriptions
 *     summary: Create an explicit category
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CategoryCreateRequest'
 *     responses:
 *       201:
 *         description: Category created
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CategoryCreateResponse'
 *       400:
 *         description: Missing category name
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Missing or invalid bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Category already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.post("/api/categories", ensureAuthenticated, async (request, response) => {
  const rawName = normalizeText(request.body?.name);

  if (!rawName) {
    response.status(400).json({ error: "类型名称不能为空。" });
    return;
  }

  const name = normalizeCategory(rawName);
  const categories = await readCategories();

  if (categories.includes(name)) {
    response.status(409).json({ error: "这个类型已经存在。" });
    return;
  }

  const nextCategories = [...categories, name];
  await writeCategories(nextCategories);
  response.status(201).json({ category: name, categories: nextCategories });
});

app.put("/api/categories/:name", ensureAuthenticated, async (request, response) => {
  const currentName = normalizeCategory(request.params.name);
  const nextName = normalizeCategory(request.body?.name);

  if (!currentName) {
    response.status(400).json({ error: "原类型名称不能为空。" });
    return;
  }

  if (!nextName) {
    response.status(400).json({ error: "新类型名称不能为空。" });
    return;
  }

  const subscriptions = await readSubscriptions();
  const explicitCategories = await readCategories();
  const categoryExists =
    explicitCategories.includes(currentName) ||
    subscriptions.some((subscription) => normalizeSubscriptionCategories(subscription.categories, subscription.category).includes(currentName));

  if (!categoryExists) {
    response.status(404).json({ error: "类型不存在。" });
    return;
  }

  if (currentName !== nextName) {
    const nextExists =
      explicitCategories.includes(nextName) ||
      subscriptions.some((subscription) => normalizeSubscriptionCategories(subscription.categories, subscription.category).includes(nextName));

    if (nextExists) {
      response.status(409).json({ error: "目标类型已经存在。" });
      return;
    }
  }

  const now = new Date().toISOString();
  const nextSubscriptions = subscriptions.map((subscription) => {
    const categories = normalizeSubscriptionCategories(subscription.categories, subscription.category).map((category) =>
      category === currentName ? nextName : category,
    );
    const normalizedCategories = dedupeCategories(categories);
    const changed = normalizedCategories.join("\n") !== normalizeSubscriptionCategories(subscription.categories, subscription.category).join("\n");

    return {
      ...subscription,
      category: normalizedCategories[0] || nextName,
      categories: normalizedCategories,
      updatedAt: changed ? now : subscription.updatedAt,
    };
  });
  const nextExplicitCategories = explicitCategories.map((category) => (category === currentName ? nextName : category));

  await writeSubscriptions(nextSubscriptions);
  await writeCategories(nextExplicitCategories);

  const categories = buildCategoryList(nextSubscriptions, await readCategories());
  response.json({ category: nextName, subscriptions: nextSubscriptions, categories });
});

app.delete("/api/categories/:name", ensureAuthenticated, async (request, response) => {
  const name = normalizeCategory(request.params.name);
  const fallbackCategory = "未分类";

  if (!name) {
    response.status(400).json({ error: "类型名称不能为空。" });
    return;
  }

  const subscriptions = await readSubscriptions();
  const explicitCategories = await readCategories();
  const categoryExists =
    explicitCategories.includes(name) ||
    subscriptions.some((subscription) => normalizeSubscriptionCategories(subscription.categories, subscription.category).includes(name));

  if (!categoryExists) {
    response.status(404).json({ error: "类型不存在。" });
    return;
  }

  const now = new Date().toISOString();
  let movedSubscriptionCount = 0;
  const nextSubscriptions = subscriptions.map((subscription) => {
    const currentCategories = normalizeSubscriptionCategories(subscription.categories, subscription.category);

    if (!currentCategories.includes(name)) {
      return subscription;
    }

    movedSubscriptionCount += 1;
    const nextCategories = currentCategories.filter((category) => category !== name);
    const normalizedCategories = nextCategories.length ? nextCategories : [fallbackCategory];

    return {
      ...subscription,
      category: normalizedCategories[0],
      categories: normalizedCategories,
      updatedAt: now,
    };
  });
  const nextExplicitCategories = explicitCategories.filter((category) => category !== name);

  if (movedSubscriptionCount > 0 && !nextExplicitCategories.includes(fallbackCategory)) {
    nextExplicitCategories.push(fallbackCategory);
  }

  await writeSubscriptions(nextSubscriptions);
  await writeCategories(nextExplicitCategories);

  const categories = buildCategoryList(nextSubscriptions, await readCategories());
  response.json({ deleted: true, subscriptions: nextSubscriptions, categories });
});

/**
 * @openapi
 * /api/subscriptions/test:
 *   post:
 *     tags:
 *       - Subscriptions
 *     summary: Test a subscription route before saving
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SubscriptionInput'
 *     responses:
 *       200:
 *         description: Subscription test succeeded
 *       400:
 *         description: Missing name or routePath
 *       401:
 *         description: Missing or invalid bearer token
 *       502:
 *         description: Upstream RSS fetch failed
 */
app.post("/api/subscriptions/test", ensureAuthenticated, async (request, response) => {
  const category = normalizeCategory(request.body?.category);
  const categories = normalizeSubscriptionCategories(request.body?.categories, category);
  const name = normalizeText(request.body?.name);
  const routePath = normalizeRoutePath(request.body?.routePath);
  const description = normalizeText(request.body?.description);
  const routeTemplate = normalizeRouteTemplate(request.body?.routeTemplate);

  if (!name) {
    response.status(400).json({ error: "订阅源名称不能为空。" });
    return;
  }

  if (!routePath || routePath === "/") {
    response.status(400).json({ error: "RSSHub 路径不能为空。" });
    return;
  }

  const subscription: SubscriptionRecord = {
    id: "preview-test",
    category,
    categories,
    name,
    routePath,
    routeTemplate,
    description,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    const items = await fetchSubscriptionItems(subscription);
    response.json({
      ok: true,
      routePath: subscription.routePath,
      targetUrl: buildRsshubUrl(subscription.routePath),
      itemCount: items.length,
      sampleTitles: items.slice(0, 3).map((item) => item.title).filter(Boolean),
      message: items.length ? `可正常访问，已获取 ${items.length} 条内容。` : "可正常访问，但当前未返回条目。",
    });
  } catch (error) {
    response.status(502).json({
      error: getErrorMessage(error),
      routePath: subscription.routePath,
      targetUrl: buildRsshubUrl(subscription.routePath),
    });
  }
});

app.post("/api/subscriptions", ensureAuthenticated, async (request, response) => {
  const category = normalizeCategory(request.body?.category);
  const categories = normalizeSubscriptionCategories(request.body?.categories, category);
  const name = normalizeText(request.body?.name);
  const routePath = normalizeRoutePath(request.body?.routePath);
  const description = normalizeText(request.body?.description);
  const routeTemplate = normalizeRouteTemplate(request.body?.routeTemplate);
  const enabled = normalizeBoolean(request.body?.enabled, true);

  if (!name) {
    response.status(400).json({ error: "订阅源名称不能为空。" });
    return;
  }

  if (!routePath || routePath === "/") {
    response.status(400).json({ error: "RSSHub 路径不能为空。" });
    return;
  }

  const subscriptions = await readSubscriptions();

  if (subscriptions.some((subscription) => subscription.routePath === routePath)) {
    response.status(409).json({ error: "这个 RSSHub 路径已经存在。" });
    return;
  }

  const now = new Date().toISOString();
  const subscription: SubscriptionRecord = {
    id: crypto.randomUUID(),
    category: categories[0] || category,
    categories,
    name,
    routePath,
    routeTemplate,
    description,
    enabled,
    createdAt: now,
    updatedAt: now,
  };

  subscriptions.unshift(subscription);
  await writeSubscriptions(subscriptions);
  await ensureCategories(categories);
  response.status(201).json({ subscription });
});

/**
 * @openapi
 * /api/subscriptions/{id}:
 *   put:
 *     tags:
 *       - Subscriptions
 *     summary: Update a subscription
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Subscription id
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SubscriptionInput'
 *     responses:
 *       200:
 *         description: Subscription updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SubscriptionResponse'
 *       400:
 *         description: Missing name or routePath
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Missing or invalid bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Subscription not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Duplicate routePath
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *   delete:
 *     tags:
 *       - Subscriptions
 *     summary: Delete a subscription and its cached reader data
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Subscription id
 *     responses:
 *       200:
 *         description: Subscription deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeleteResponse'
 *       401:
 *         description: Missing or invalid bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Subscription not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.put("/api/subscriptions/:id", ensureAuthenticated, async (request, response) => {
  const id = normalizeText(request.params.id);
  const category = normalizeCategory(request.body?.category);
  const categories = normalizeSubscriptionCategories(request.body?.categories, category);
  const name = normalizeText(request.body?.name);
  const routePath = normalizeRoutePath(request.body?.routePath);
  const description = normalizeText(request.body?.description);
  const nextRouteTemplate = normalizeRouteTemplate(request.body?.routeTemplate);
  const enabled = normalizeBoolean(request.body?.enabled, true);

  if (!name) {
    response.status(400).json({ error: "订阅源名称不能为空。" });
    return;
  }

  if (!routePath || routePath === "/") {
    response.status(400).json({ error: "RSSHub 路径不能为空。" });
    return;
  }

  const subscriptions = await readSubscriptions();
  const index = subscriptions.findIndex((subscription) => subscription.id === id);

  if (index < 0) {
    response.status(404).json({ error: "订阅源不存在。" });
    return;
  }

  const duplicated = subscriptions.some(
    (subscription) => subscription.id !== id && subscription.routePath === routePath,
  );

  if (duplicated) {
    response.status(409).json({ error: "这个 RSSHub 路径已经存在。" });
    return;
  }

  const current = subscriptions[index];
  const routeTemplate = nextRouteTemplate || current.routeTemplate || normalizeRouteTemplate(current.routePath);
  const updated: SubscriptionRecord = {
    ...current,
    category: categories[0] || category,
    categories,
    name,
    routePath,
    routeTemplate,
    description,
    enabled,
    updatedAt: new Date().toISOString(),
  };

  subscriptions[index] = updated;
  await writeSubscriptions(subscriptions);
  await ensureCategories(categories);

  if (current.routePath !== updated.routePath) {
    await deleteReaderCache(updated.id);
  } else if (current.name !== updated.name) {
    await updateReaderCacheSubscriptionMetadata(updated);
  }

  response.json({ subscription: updated });
});

app.delete("/api/subscriptions/:id", ensureAuthenticated, async (request, response) => {
  const id = normalizeText(request.params.id);
  const subscriptions = await readSubscriptions();
  const nextSubscriptions = subscriptions.filter((subscription) => subscription.id !== id);

  if (nextSubscriptions.length === subscriptions.length) {
    response.status(404).json({ error: "订阅源不存在。" });
    return;
  }

  await writeSubscriptions(nextSubscriptions);
  await deleteReaderCache(id);
  response.json({ deleted: true });
});

/**
 * @openapi
 * /api/reader/items:
 *   get:
 *     tags:
 *       - Reader
 *     summary: Read aggregated reader items across enabled subscriptions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: refresh
 *         schema:
 *           type: boolean
 *         description: When true, bypass cache and fetch all enabled subscriptions immediately
 *     responses:
 *       200:
 *         description: Aggregated reader items plus per-subscription fetch errors
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReaderItemsResponse'
 *       401:
 *         description: Missing or invalid bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
app.get("/api/reader/items", ensureAuthenticated, async (request, response) => {
  const subscriptions = await readSubscriptions();
  const forceRefresh = shouldForceRefresh(request.query.refresh);
  const readerCacheCollection = forceRefresh ? undefined : await readReaderCacheCollection();
  const results = await Promise.all(
    subscriptions.filter(isReaderSubscription).map(async (subscription) => {
      try {
        const cacheRecord = await getSubscriptionReaderData(subscription, forceRefresh, readerCacheCollection);
        return {
          generatedAt: cacheRecord.generatedAt,
          items: cacheRecord.items,
          error: null,
        };
      } catch (error) {
        return {
          items: [],
          error: {
            subscriptionId: subscription.id,
            subscriptionName: subscription.name,
            message: getErrorMessage(error),
          },
        };
      }
    }),
  );

  const items = results
    .flatMap((result) => result.items)
    .sort((left, right) => new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime());

  const errors = results.flatMap((result) => (result.error ? [result.error] : []));

  response.json({
    generatedAt: new Date().toISOString(),
    items,
    errors,
  });
});

/**
 * @openapi
 * /api/reader/subscriptions/{id}:
 *   get:
 *     tags:
 *       - Reader
 *     summary: Read cached items for one subscription or force-refresh that source
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Subscription id
 *       - in: query
 *         name: refresh
 *         schema:
 *           type: boolean
 *         description: When true, fetch the real RSS source and update cache
 *     responses:
 *       200:
 *         description: Reader items for the selected subscription
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReaderSubscriptionResponse'
 *       401:
 *         description: Missing or invalid bearer token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Subscription not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Subscription is disabled
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       502:
 *         description: Upstream RSS fetch failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ReaderFetchErrorResponse'
 */
app.get("/api/reader/subscriptions/:id", ensureAuthenticated, async (request, response) => {
  const subscriptions = await readSubscriptions();
  const subscriptionId = normalizeText(request.params.id);
  const subscription = subscriptions.find((entry) => entry.id === subscriptionId);
  const forceRefresh = shouldForceRefresh(request.query.refresh);

  if (!subscription) {
    response.status(404).json({ error: "订阅源不存在。" });
    return;
  }

  if (!isReaderSubscription(subscription)) {
    response.status(409).json({ error: "该订阅源未在管理订阅源中启用，不能进入阅读。" });
    return;
  }

  try {
    const cacheRecord = await getSubscriptionReaderData(subscription, forceRefresh);
    response.json({
      generatedAt: cacheRecord.generatedAt,
      subscriptionId: subscription.id,
      subscriptionName: subscription.name,
      routePath: subscription.routePath,
      items: cacheRecord.items,
    });
  } catch (error) {
    response.status(502).json({
      error: getErrorMessage(error),
      subscriptionId: subscription.id,
      subscriptionName: subscription.name,
      routePath: subscription.routePath,
    });
  }
});

httpServer.listen(port, host, () => {
  console.log(`GARSS Studio backend listening on http://${host}:${port}`);
  if (!schedulerEnabled) {
    console.log("GARSS Studio backend auto scheduler disabled by SCHEDULER_ENABLED=false");
    return;
  }

  void scheduleAllUserRefreshJobs();
});
