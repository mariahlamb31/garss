import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const defaultEditReadmePath = path.join(repoRoot, "EditREADME.md");
const defaultStudioStoragePath = path.join(repoRoot, "garss-studio", "storage", "subscriptions.json");
const defaultGarssInfoPath = path.join(repoRoot, "garssInfo.json");

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtml(value) {
  return normalizeText(value.replace(/<[^>]+>/g, " "));
}

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

async function readStudioSubscriptions(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildStudioSubscriptions(parsedSources, existingSubscriptions) {
  const now = new Date().toISOString();
  const existingById = new Map(existingSubscriptions.map((subscription) => [subscription.id, subscription]));
  const manualSubscriptions = existingSubscriptions.filter(
    (subscription) => !subscription.id.startsWith("editreadme-"),
  );

  const generatedSubscriptions = parsedSources.map((source) => {
    const id = `editreadme-${source.sourceId.toLowerCase()}`;
    const current = existingById.get(id);
    const nextCore = {
      category: source.category,
      name: source.title,
      routePath: source.xmlUrl,
      description: source.description,
    };

    const isUnchanged =
      current &&
      current.category === nextCore.category &&
      current.name === nextCore.name &&
      current.routePath === nextCore.routePath &&
      current.description === nextCore.description;

    return {
      id,
      ...nextCore,
      enabled: current?.enabled ?? true,
      createdAt: current?.createdAt ?? now,
      updatedAt: isUnchanged ? current.updatedAt : now,
    };
  });

  return [...generatedSubscriptions, ...manualSubscriptions];
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
