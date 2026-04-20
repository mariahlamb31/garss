import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStableId,
  mergeGeneratedSubscriptions,
  normalizeText,
  readStudioSubscriptions,
  stripHtml,
  writeJson,
} from "./lib/subscription-import.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const defaultStudioStoragePath = path.join(projectRoot, "storage", "subscriptions.json");
const defaultRoutesSnapshotPath = path.join(projectRoot, "storage", "rsshub-docs-routes.snapshot.json");
const defaultRoutesJsonUrl =
  process.env.RSSHUB_DOCS_JSON_URL || "https://raw.githubusercontent.com/DIYgod/RSSHub/refs/heads/gh-pages/build/routes.json";

const CATEGORY_LABELS = {
  social: "社交媒体",
  "social-media": "社交媒体",
  "new-media": "新媒体",
  traditional: "传统媒体",
  bbs: "论坛",
  blog: "博客",
  programming: "编程开发",
  design: "设计",
  live: "直播",
  multimedia: "多媒体",
  picture: "图片",
  acg: "ACG",
  "program-update": "应用更新",
  university: "高校",
  forecast: "预报预警",
  travel: "旅行",
  shopping: "购物",
  game: "游戏",
  gaming: "游戏",
  reading: "阅读",
  government: "政府",
  study: "学习",
  journal: "期刊",
  finance: "财经",
  other: "未分类",
};

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripMarkdown(value) {
  return normalizeText(
    decodeHtmlEntities(
      String(value || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^:::\s*\w+\s*/gm, " ")
        .replace(/^:::\s*$/gm, " ")
        .replace(/^>+/gm, " ")
        .replace(/[*_#|>-]+/g, " ")
        .replace(/\s+/g, " "),
    ),
  );
}

function normalizeRouteSegment(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function buildFullRoutePath(namespace, routePath) {
  const normalizedNamespace = normalizeRouteSegment(namespace);
  const normalizedRoutePath = String(routePath || "").trim();

  if (!normalizedRoutePath.startsWith("/")) {
    return `/${normalizedNamespace}/${normalizedRoutePath}`.replace(/\/+/g, "/");
  }

  return `/${normalizedNamespace}${normalizedRoutePath}`.replace(/\/+/g, "/");
}

function formatParameterValue(parameterValue) {
  if (typeof parameterValue === "string") {
    return stripMarkdown(parameterValue);
  }

  if (!parameterValue || typeof parameterValue !== "object") {
    return "";
  }

  const description = stripMarkdown(parameterValue.description || "");
  const options = Array.isArray(parameterValue.options)
    ? parameterValue.options
        .map((option) => {
          if (!option || typeof option !== "object") {
            return "";
          }

          const label = normalizeText(option.label || option.value || "");
          const optionValue = normalizeText(option.value || "");
          return label && optionValue && label !== optionValue ? `${label}=${optionValue}` : label || optionValue;
        })
        .filter(Boolean)
        .slice(0, 8)
    : [];

  if (!options.length) {
    return description;
  }

  return [description, `可选值: ${options.join("; ")}`].filter(Boolean).join(" ");
}

function buildParameterSummary(parameters) {
  if (!parameters || typeof parameters !== "object") {
    return "";
  }

  const entries = Object.entries(parameters)
    .map(([name, value]) => {
      const summary = formatParameterValue(value);
      return summary ? `${name}: ${summary}` : name;
    })
    .filter(Boolean);

  return entries.length ? `参数：${entries.join("；")}` : "";
}

function buildDescription(routeDoc) {
  const descriptionParts = [
    stripMarkdown(routeDoc.description || ""),
    routeDoc.example ? `示例：${routeDoc.example}` : "",
    buildParameterSummary(routeDoc.parameters),
    routeDoc.url ? `来源：${normalizeText(routeDoc.url)}` : "",
    routeDoc.location ? `源码：${normalizeText(routeDoc.location)}` : "",
  ].filter(Boolean);

  return descriptionParts.join(" | ");
}

function mapCategoryLabel(routeDoc, namespaceDoc) {
  const routeCategories = Array.isArray(routeDoc.categories) ? routeDoc.categories : [];
  const namespaceCategories = Array.isArray(namespaceDoc.categories) ? namespaceDoc.categories : [];
  const rawCategory = routeCategories[0] || namespaceCategories[0] || "other";
  const normalized = normalizeText(rawCategory).toLowerCase();
  const label = CATEGORY_LABELS[normalized] || rawCategory;
  return `RSSHub 文档 / ${label}`;
}

function extractLocalizedRoute(routeDoc) {
  if (routeDoc?.zh && typeof routeDoc.zh === "object") {
    return { ...routeDoc, ...routeDoc.zh };
  }

  return routeDoc;
}

function parseRsshubDocsRoutes(routesCollection) {
  return Object.entries(routesCollection).flatMap(([namespace, namespaceDoc]) => {
    const routes = namespaceDoc?.routes;
    if (!routes || typeof routes !== "object") {
      return [];
    }

    return Object.values(routes)
      .map((rawRouteDoc) => extractLocalizedRoute(rawRouteDoc))
      .filter((routeDoc) => routeDoc && typeof routeDoc === "object" && normalizeText(routeDoc.path))
      .map((routeDoc) => {
        const fullRoutePath = buildFullRoutePath(namespace, routeDoc.path);
        return {
          id: buildStableId("rsshub-doc", namespace, routeDoc.path),
          category: mapCategoryLabel(routeDoc, namespaceDoc),
          name: [normalizeText(namespaceDoc?.name), normalizeText(routeDoc.name)].filter(Boolean).join(" - "),
          routePath: fullRoutePath,
          routeTemplate: fullRoutePath,
          description: buildDescription(routeDoc),
          enabled: false,
        };
      });
  });
}

async function loadRoutesPayload(input) {
  if (/^https?:\/\//i.test(input)) {
    const response = await fetch(input);

    if (!response.ok) {
      throw new Error(`RSSHub routes 文档获取失败：${response.status} ${response.statusText}`);
    }

    return response.text();
  }

  return fs.readFile(path.resolve(process.cwd(), input), "utf8");
}

async function main() {
  const routesSource = process.argv[2] || defaultRoutesJsonUrl;
  const studioStoragePath = process.argv[3]
    ? path.resolve(process.cwd(), process.argv[3])
    : defaultStudioStoragePath;
  const snapshotPath = process.argv[4]
    ? path.resolve(process.cwd(), process.argv[4])
    : defaultRoutesSnapshotPath;

  const payload = await loadRoutesPayload(routesSource);
  const routesCollection = JSON.parse(payload);
  const generatedSubscriptions = parseRsshubDocsRoutes(routesCollection);
  const existingSubscriptions = await readStudioSubscriptions(studioStoragePath);
  const nextSubscriptions = mergeGeneratedSubscriptions({
    generatedSubscriptions,
    existingSubscriptions,
    generatedIdPrefix: "rsshub-doc",
    defaultEnabled: false,
  });

  await writeJson(studioStoragePath, nextSubscriptions);
  await writeJson(snapshotPath, {
    syncedAt: new Date().toISOString(),
    source: routesSource,
    routes: generatedSubscriptions,
  });

  console.log(
    JSON.stringify(
      {
        routesSource,
        studioStoragePath,
        snapshotPath,
        parsedRoutes: generatedSubscriptions.length,
        studioSubscriptions: nextSubscriptions.length,
      },
      null,
      2,
    ),
  );
}

await main();
