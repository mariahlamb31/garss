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
const repoRoot = path.resolve(__dirname, "..", "..");
const defaultEditReadmePath = path.join(repoRoot, "EditREADME.md");
const defaultStudioStoragePath = path.join(repoRoot, "garss-studio", "storage", "subscriptions.json");
const defaultGarssInfoPath = path.join(repoRoot, "garssInfo.json");

function extractSourceId(cell, fallbackIndex) {
  const idMatch = cell.match(/id="([^"]+)"/i);
  if (idMatch?.[1]) {
    return normalizeText(idMatch[1]);
  }

  const spanMatch = cell.match(/<span>([^<]+)<\/span>/i);
  if (spanMatch?.[1]) {
    return normalizeText(spanMatch[1]);
  }

  const plainText = stripHtml(cell);
  return plainText || `ROW${String(fallbackIndex + 1).padStart(3, "0")}`;
}

function parseEditReadme(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sources = [];
  let currentCategory = "";

  const categoryPattern = /^\|\s*<h2 id="[^"]+">(.+?)<\/h2>\s*\|/i;
  const sourcePattern =
    /^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*\{\{latest_content\}\}\s*\|\s*\[订阅地址\]\((.*?)\)\s*\|\s*$/;

  for (const line of lines) {
    const categoryMatch = line.match(categoryPattern);
    if (categoryMatch?.[1]) {
      currentCategory = normalizeText(categoryMatch[1]);
      continue;
    }

    const sourceMatch = line.match(sourcePattern);
    if (!sourceMatch) {
      continue;
    }

    const [, rawCode, rawTitle, rawDescription, rawUrl] = sourceMatch;
    const title = normalizeText(stripHtml(rawTitle));
    const description = normalizeText(stripHtml(rawDescription));
    const xmlUrl = normalizeText(rawUrl);

    if (!currentCategory || !title || !xmlUrl) {
      continue;
    }

    sources.push({
      sourceId: extractSourceId(rawCode, sources.length),
      category: currentCategory,
      title,
      description,
      xmlUrl,
    });
  }

  return sources;
}

function buildStudioSubscriptions(parsedSources, existingSubscriptions) {
  const sourceByUrl = new Map();

  for (const source of parsedSources) {
    const current = sourceByUrl.get(source.xmlUrl);

    if (!current) {
      sourceByUrl.set(source.xmlUrl, {
        ...source,
        categories: [source.category],
        sourceIds: [source.sourceId],
      });
      continue;
    }

    if (!current.categories.includes(source.category)) {
      current.categories.push(source.category);
    }

    if (!current.sourceIds.includes(source.sourceId)) {
      current.sourceIds.push(source.sourceId);
    }
  }

  const generatedSubscriptions = Array.from(sourceByUrl.values()).map((source) => ({
    id: buildStableId("editreadme", source.xmlUrl),
    previousIds: [
      buildStableId("editreadme", source.category, source.sourceId, source.xmlUrl),
      ...source.sourceIds.map((sourceId) => `editreadme-${sourceId.toLowerCase()}`),
    ],
    category: source.category,
    categories: source.categories,
    name: source.title,
    routePath: source.xmlUrl,
    routeTemplate: source.xmlUrl,
    description: source.description,
    enabled: true,
  }));

  return mergeGeneratedSubscriptions({
    generatedSubscriptions,
    existingSubscriptions,
    generatedIdPrefix: "editreadme",
    defaultEnabled: true,
  });
}

async function main() {
  const editReadmePath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultEditReadmePath;
  const studioStoragePath = process.argv[3]
    ? path.resolve(process.cwd(), process.argv[3])
    : defaultStudioStoragePath;
  const garssInfoPath = process.argv[4] ? path.resolve(process.cwd(), process.argv[4]) : defaultGarssInfoPath;

  const markdown = await fs.readFile(editReadmePath, "utf8");
  const parsedSources = parseEditReadme(markdown);
  const existingSubscriptions = await readStudioSubscriptions(studioStoragePath);
  const nextSubscriptions = buildStudioSubscriptions(parsedSources, existingSubscriptions);

  const garssInfo = {
    garssInfo: parsedSources.map((source) => ({
      sourceId: source.sourceId,
      category: source.category,
      title: source.title,
      description: source.description,
      xmlUrl: source.xmlUrl,
    })),
  };

  await writeJson(studioStoragePath, nextSubscriptions);
  await writeJson(garssInfoPath, garssInfo);

  console.log(
    JSON.stringify(
      {
        editReadmePath,
        studioStoragePath,
        garssInfoPath,
        parsedSources: parsedSources.length,
        studioSubscriptions: nextSubscriptions.length,
      },
      null,
      2,
    ),
  );
}

await main();
