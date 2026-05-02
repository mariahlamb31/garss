import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeText, readJsonFile, writeJson } from "./lib/subscription-import.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const defaultGarssInfoPath = path.join(repoRoot, "garssInfo.json");
const defaultSubscriptionsPath = path.join(repoRoot, "garss-studio", "storage", "subscriptions.json");
const defaultCategoriesPath = path.join(repoRoot, "garss-studio", "storage", "categories.json");
const defaultReaderCachePath = path.join(repoRoot, "garss-studio", "storage", "reader-cache.json");

function buildDuplicateSafeId(source, seenCounts) {
  const sourceId = normalizeText(source.sourceId).toLowerCase();
  const seenCount = seenCounts.get(sourceId) || 0;
  seenCounts.set(sourceId, seenCount + 1);

  if (seenCount === 0) {
    return `editreadme-${sourceId}`;
  }

  const digest = crypto
    .createHash("sha1")
    .update([source.category, source.title, source.xmlUrl].map((value) => normalizeText(value)).join("::"))
    .digest("hex")
    .slice(0, 8);

  return `editreadme-${sourceId}-${digest}`;
}

function normalizeGarssInfoSources(garssInfo) {
  const seenCounts = new Map();

  return garssInfo
    .map((source) => ({
      sourceId: normalizeText(source?.sourceId),
      category: normalizeText(source?.category),
      title: normalizeText(source?.title),
      description: normalizeText(source?.description),
      xmlUrl: normalizeText(source?.xmlUrl),
    }))
    .filter((source) => source.sourceId && source.category && source.title && source.xmlUrl)
    .map((source) => ({
      ...source,
      id: buildDuplicateSafeId(source, seenCounts),
    }));
}

function buildSubscriptionsFromGarssInfo(sources, existingSubscriptions) {
  const now = new Date().toISOString();
  const existingById = new Map(existingSubscriptions.map((subscription) => [subscription.id, subscription]));
  const existingByRouteAndName = new Map(
    existingSubscriptions.map((subscription) => [
      `${normalizeText(subscription.routePath)}::${normalizeText(subscription.name)}`,
      subscription,
    ]),
  );

  return sources.map((source) => {
    const current = existingById.get(source.id) || existingByRouteAndName.get(`${source.xmlUrl}::${source.title}`);
    const isUnchanged =
      current &&
      current.category === source.category &&
      current.name === source.title &&
      current.routePath === source.xmlUrl &&
      current.description === source.description;

    return {
      id: source.id,
      category: source.category,
      name: source.title,
      routePath: source.xmlUrl,
      routeTemplate: current?.routeTemplate || "",
      description: source.description,
      enabled: current?.enabled ?? true,
      createdAt: current?.createdAt ?? now,
      updatedAt: isUnchanged ? current.updatedAt : now,
    };
  });
}

async function pruneReaderCache(readerCachePath, allowedSubscriptionIds) {
  const cache = await readJsonFile(readerCachePath, {});

  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    return 0;
  }

  const nextCache = {};
  let prunedCount = 0;

  for (const [subscriptionId, value] of Object.entries(cache)) {
    if (allowedSubscriptionIds.has(subscriptionId)) {
      nextCache[subscriptionId] = value;
    } else {
      prunedCount += 1;
    }
  }

  await writeJson(readerCachePath, nextCache);
  return prunedCount;
}

async function main() {
  const garssInfoPath = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : defaultGarssInfoPath;
  const subscriptionsPath = process.argv[3] ? path.resolve(process.cwd(), process.argv[3]) : defaultSubscriptionsPath;
  const categoriesPath = process.argv[4] ? path.resolve(process.cwd(), process.argv[4]) : defaultCategoriesPath;
  const readerCachePath = process.argv[5] ? path.resolve(process.cwd(), process.argv[5]) : defaultReaderCachePath;

  const garssInfoJson = await readJsonFile(garssInfoPath, { garssInfo: [] });
  const sources = normalizeGarssInfoSources(Array.isArray(garssInfoJson.garssInfo) ? garssInfoJson.garssInfo : []);
  const existingSubscriptions = await readJsonFile(subscriptionsPath, []);
  const rsshubDocs = Array.isArray(existingSubscriptions)
    ? existingSubscriptions
        .filter((subscription) => subscription.id?.startsWith("rsshub-doc-"))
        .map((subscription) => ({ ...subscription, enabled: false }))
    : [];
  const userSubscriptions = buildSubscriptionsFromGarssInfo(sources, Array.isArray(existingSubscriptions) ? existingSubscriptions : []);
  const categories = Array.from(new Set(userSubscriptions.map((subscription) => subscription.category)));
  const nextSubscriptions = [...userSubscriptions, ...rsshubDocs];
  const prunedCacheKeys = await pruneReaderCache(readerCachePath, new Set(userSubscriptions.map((subscription) => subscription.id)));

  await writeJson(subscriptionsPath, nextSubscriptions);
  await writeJson(categoriesPath, categories);

  console.log(
    JSON.stringify(
      {
        garssInfoPath,
        subscriptionsPath,
        categoriesPath,
        readerCachePath,
        userSubscriptions: userSubscriptions.length,
        rsshubDocs: rsshubDocs.length,
        categories: categories.length,
        prunedCacheKeys,
      },
      null,
      2,
    ),
  );
}

await main();
