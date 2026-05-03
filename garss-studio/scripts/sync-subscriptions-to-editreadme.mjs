import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeText, readStudioSubscriptions } from "./lib/subscription-import.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const defaultEditReadmePath = path.join(repoRoot, "EditREADME.md");
const defaultStudioStoragePath = path.join(repoRoot, "garss-studio", "storage", "subscriptions.json");
const fallbackCategory = "未分类";

function readOption(name, fallbackValue) {
  const index = process.argv.indexOf(name);

  if (index === -1) {
    return fallbackValue;
  }

  return process.argv[index + 1] ? path.resolve(process.cwd(), process.argv[index + 1]) : fallbackValue;
}

function escapeTableCell(value) {
  return normalizeText(value)
    .replaceAll("|", "&#124;")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

function normalizeEditReadmeSubscriptionUrl(value) {
  const rawValue = normalizeText(value);

  if (!rawValue) {
    return "";
  }

  if (rawValue.startsWith("/")) {
    return `http://rsshub:1200${rawValue}`;
  }

  return rawValue.replace(/^https?:\/\/rsshub\.v2fy\.com(?=\/|$)/i, "http://rsshub:1200");
}

function normalizeUrlForMatch(value) {
  return normalizeEditReadmeSubscriptionUrl(value).replace(/\/+$/, "");
}

function replaceRsshubOrigin(value) {
  return value.replaceAll("https://rsshub.v2fy.com", "http://rsshub:1200").replaceAll("http://rsshub.v2fy.com", "http://rsshub:1200");
}

function extractSourceId(codeCell) {
  const idMatch = codeCell.match(/id="([^"]+)"/i);

  if (idMatch?.[1]) {
    return normalizeText(idMatch[1]).toUpperCase();
  }

  const spanMatch = codeCell.match(/<span>([^<]+)<\/span>/i);

  if (spanMatch?.[1]) {
    return normalizeText(spanMatch[1]).toUpperCase();
  }

  return normalizeText(codeCell).toUpperCase();
}

function extractFirstTableCell(line) {
  const match = line.match(/^\|\s*(.*?)\s*\|/);
  return match?.[1] ? normalizeText(match[1]) : "";
}

function extractSubscriptionUrl(line) {
  const match = line.match(/\[订阅地址\]\((.*?)\)/);
  return match?.[1] ? normalizeText(match[1]) : "";
}

function parseExistingTable(markdownLines, tableStartIndex, tableEndIndex) {
  const categories = [];
  const codeCellBySourceId = new Map();
  const sourceIdByRoutePath = new Map();
  const orderBySourceId = new Map();
  const existingCategories = new Set();
  let currentCategory = "";
  let sourceOrder = 0;

  for (let index = tableStartIndex + 2; index < tableEndIndex; index += 1) {
    const line = markdownLines[index];
    const categoryMatch = line.match(/^\|\s*<h2 id="([^"]+)">(.+?)<\/h2>\s*\|/i);

    if (categoryMatch?.[2]) {
      currentCategory = normalizeText(categoryMatch[2]);
      if (currentCategory && !categories.includes(currentCategory)) {
        categories.push(currentCategory);
      }
      existingCategories.add(currentCategory);
      continue;
    }

    if (!line.includes("[订阅地址]")) {
      continue;
    }

    const codeCell = extractFirstTableCell(line);
    const sourceId = extractSourceId(codeCell);
    const routePath = extractSubscriptionUrl(line);

    if (!sourceId) {
      continue;
    }

    codeCellBySourceId.set(sourceId, codeCell || sourceId);
    orderBySourceId.set(sourceId, sourceOrder);
    sourceOrder += 1;

    if (routePath) {
      const normalizedRoutePath = normalizeUrlForMatch(routePath);

      if (normalizedRoutePath && !sourceIdByRoutePath.has(normalizedRoutePath)) {
        sourceIdByRoutePath.set(normalizedRoutePath, sourceId);
      }
    }
  }

  return {
    categories,
    codeCellBySourceId,
    sourceIdByRoutePath,
    orderBySourceId,
    existingCategories,
  };
}

function findRssTable(markdownLines) {
  const tableStartIndex = markdownLines.findIndex((line) => /\|\s*编号\s*\|\s*名称\s*\|\s*描述\s*\|\s*RSS\s*\|/.test(line));

  if (tableStartIndex === -1) {
    throw new Error("没有找到 EditREADME.md 中的 RSS 列表表头。");
  }

  let tableEndIndex = markdownLines.length;

  for (let index = tableStartIndex + 2; index < markdownLines.length; index += 1) {
    if (!markdownLines[index].trim().startsWith("|")) {
      tableEndIndex = index;
      break;
    }
  }

  return { tableStartIndex, tableEndIndex };
}

function getSubscriptionCategory(subscription) {
  if (Array.isArray(subscription.categories) && subscription.categories.length) {
    return normalizeText(subscription.categories[0]) || fallbackCategory;
  }

  return normalizeText(subscription.category) || fallbackCategory;
}

function getSubscriptionRoutePath(subscription) {
  return normalizeText(subscription.routePath) || normalizeText(subscription.routeTemplate);
}

function getEditReadmeSourceId(subscription) {
  const id = normalizeText(subscription.id);

  if (!id.toLowerCase().startsWith("editreadme-")) {
    return "";
  }

  return id.slice("editreadme-".length).toUpperCase();
}

function createSourceIdGenerator(usedSourceIds) {
  let nextIndex = 1;

  for (const sourceId of usedSourceIds) {
    const match = sourceId.match(/^N(\d+)$/i);

    if (match?.[1]) {
      nextIndex = Math.max(nextIndex, Number(match[1]) + 1);
    }
  }

  return () => {
    let sourceId = "";

    do {
      sourceId = `N${String(nextIndex).padStart(3, "0")}`;
      nextIndex += 1;
    } while (usedSourceIds.has(sourceId));

    usedSourceIds.add(sourceId);
    return sourceId;
  };
}

function buildMissingRowsByCategory(subscriptions, existingTable) {
  const usedSourceIds = new Set(existingTable.codeCellBySourceId.keys());
  const createSourceId = createSourceIdGenerator(usedSourceIds);
  const rowsByCategory = new Map();
  const categories = [...existingTable.categories];
  let skippedExistingSources = 0;
  let appendedSources = 0;

  for (const subscription of subscriptions) {
    const id = normalizeText(subscription.id);

    if (!id || id.startsWith("rsshub-doc-")) {
      continue;
    }

    const routePath = normalizeEditReadmeSubscriptionUrl(getSubscriptionRoutePath(subscription));
    const name = normalizeText(subscription.name);

    if (!routePath || !name) {
      continue;
    }

    const category = getSubscriptionCategory(subscription);
    const editReadmeSourceId = getEditReadmeSourceId(subscription);
    const existingRouteSourceId = existingTable.sourceIdByRoutePath.get(normalizeUrlForMatch(routePath));
    const existingSourceId = editReadmeSourceId && existingTable.codeCellBySourceId.has(editReadmeSourceId)
      ? editReadmeSourceId
      : existingRouteSourceId;

    if (existingSourceId) {
      skippedExistingSources += 1;
      continue;
    }

    const sourceId = editReadmeSourceId || createSourceId();
    const codeCell = existingTable.codeCellBySourceId.get(sourceId) || sourceId;
    const row = {
      sourceId,
      order: existingTable.orderBySourceId.get(sourceId) ?? Number.MAX_SAFE_INTEGER,
      line: `| ${codeCell} | ${escapeTableCell(name)} | ${escapeTableCell(subscription.description)} | {{latest_content}} | [订阅地址](${routePath}) |`,
    };

    if (!rowsByCategory.has(category)) {
      rowsByCategory.set(category, []);
    }

    rowsByCategory.get(category).push(row);
    appendedSources += 1;

    if (!categories.includes(category)) {
      categories.push(category);
    }
  }

  return {
    categories,
    rowsByCategory,
    skippedExistingSources,
    appendedSources,
  };
}

function takeRows(rowsByCategory, category) {
  const rows = rowsByCategory.get(category) || [];
  rowsByCategory.delete(category);

  return rows
    .sort((left, right) => left.order - right.order || left.sourceId.localeCompare(right.sourceId))
    .map((row) => row.line);
}

function renderPreservedTableBody(markdownLines, tableStartIndex, tableEndIndex, categories, rowsByCategory, existingTable) {
  const lines = [];
  let currentCategory = "";

  for (let index = tableStartIndex + 2; index < tableEndIndex; index += 1) {
    const line = replaceRsshubOrigin(markdownLines[index]);
    const categoryMatch = line.match(/^\|\s*<h2 id="([^"]+)">(.+?)<\/h2>\s*\|/i);

    if (categoryMatch?.[2]) {
      if (currentCategory) {
        lines.push(...takeRows(rowsByCategory, currentCategory));
      }

      currentCategory = normalizeText(categoryMatch[2]);
    }

    lines.push(line);
  }

  if (currentCategory) {
    lines.push(...takeRows(rowsByCategory, currentCategory));
  }

  for (const category of categories) {
    if (existingTable.existingCategories.has(category)) {
      continue;
    }

    const rows = takeRows(rowsByCategory, category);

    if (!rows.length) {
      continue;
    }

    lines.push(`| <h2 id="${escapeTableCell(category)}">${escapeTableCell(category)}</h2> |  |   |  |`);
    lines.push(...rows);
  }

  return lines;
}

async function main() {
  const editReadmePath = readOption("--editreadme", defaultEditReadmePath);
  const studioStoragePath = readOption("--subscriptions", defaultStudioStoragePath);
  const isDryRun = process.argv.includes("--dry-run");

  const markdown = await fs.readFile(editReadmePath, "utf8");
  const markdownLines = markdown.split(/\r?\n/);
  const subscriptions = await readStudioSubscriptions(studioStoragePath);
  const { tableStartIndex, tableEndIndex } = findRssTable(markdownLines);
  const existingTable = parseExistingTable(markdownLines, tableStartIndex, tableEndIndex);
  const { categories, rowsByCategory, skippedExistingSources, appendedSources } = buildMissingRowsByCategory(subscriptions, existingTable);
  const tableBody = renderPreservedTableBody(markdownLines, tableStartIndex, tableEndIndex, categories, rowsByCategory, existingTable);
  const nextMarkdownLines = [
    ...markdownLines.slice(0, tableStartIndex + 2),
    ...tableBody,
    ...markdownLines.slice(tableEndIndex).map(replaceRsshubOrigin),
  ];
  const nextMarkdown = nextMarkdownLines.join("\n");

  if (!isDryRun) {
    await fs.writeFile(editReadmePath, nextMarkdown, "utf8");
  }

  console.log(
    JSON.stringify(
      {
        editReadmePath,
        studioStoragePath,
        dryRun: isDryRun,
        inputSubscriptions: subscriptions.length,
        existingSources: skippedExistingSources,
        appendedSources,
        writtenSources: tableBody.filter((line) => line.includes("[订阅地址]")).length,
        writtenCategories: tableBody.filter((line) => line.includes("<h2")).length,
        skippedRsshubDocs: subscriptions.filter((subscription) => normalizeText(subscription.id).startsWith("rsshub-doc-")).length,
      },
      null,
      2,
    ),
  );
}

await main();
