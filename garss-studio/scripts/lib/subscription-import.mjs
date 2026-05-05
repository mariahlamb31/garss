import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function stripHtml(value) {
  return normalizeText(String(value || "").replace(/<[^>]+>/g, " "));
}

export async function readJsonFile(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

export async function readStudioSubscriptions(filePath) {
  const parsed = await readJsonFile(filePath, []);
  return Array.isArray(parsed) ? parsed : [];
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function buildStableId(prefix, ...parts) {
  const normalized = parts
    .map((part) => normalizeText(String(part || "")).toLowerCase())
    .filter(Boolean)
    .join("::");

  const digest = crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

export function mergeGeneratedSubscriptions({
  generatedSubscriptions,
  existingSubscriptions,
  generatedIdPrefix,
  defaultEnabled = false,
}) {
  const now = new Date().toISOString();
  const existingById = new Map();

  for (const subscription of existingSubscriptions) {
    const currentList = existingById.get(subscription.id) || [];
    currentList.push(subscription);
    existingById.set(subscription.id, currentList);
  }

  const existingByRoutePath = new Map();

  for (const subscription of existingSubscriptions) {
    if (!subscription.routePath) {
      continue;
    }

    const currentList = existingByRoutePath.get(subscription.routePath) || [];
    currentList.push(subscription);
    existingByRoutePath.set(subscription.routePath, currentList);
  }

  const generatedRoutePaths = new Set(
    generatedSubscriptions.map((subscription) => normalizeText(subscription.routePath)).filter(Boolean),
  );
  const manualSubscriptions = existingSubscriptions.filter(
    (subscription) =>
      !subscription.id.startsWith(`${generatedIdPrefix}-`) &&
      !generatedRoutePaths.has(normalizeText(subscription.routePath)),
  );

  function findExistingSubscription(subscription) {
    const candidateIds = [subscription.id, ...(subscription.previousIds || [])];

    for (const candidateId of candidateIds) {
      const candidates = existingById.get(candidateId) || [];
      const matchedByRoute = candidates.find((candidate) => candidate.routePath === subscription.routePath);

      if (matchedByRoute) {
        return matchedByRoute;
      }
    }

    for (const candidateId of candidateIds) {
      const candidates = existingById.get(candidateId) || [];
      const matchedByName = candidates.find((candidate) => candidate.name === subscription.name);

      if (matchedByName) {
        return matchedByName;
      }
    }

    for (const candidateId of candidateIds) {
      const candidates = existingById.get(candidateId) || [];

      if (candidates[0]) {
        return candidates[0];
      }
    }

    const routeCandidates = existingByRoutePath.get(subscription.routePath) || [];
    const matchedByRouteAndName = routeCandidates.find((candidate) => candidate.name === subscription.name);

    if (matchedByRouteAndName) {
      return matchedByRouteAndName;
    }

    if (routeCandidates[0]) {
      return routeCandidates[0];
    }

    return null;
  }

  const mergedGeneratedSubscriptions = generatedSubscriptions.map((subscription) => {
    const current = findExistingSubscription(subscription);
    const nextCore = {
      category: subscription.category,
      categories: subscription.categories?.length ? subscription.categories : current?.categories,
      name: subscription.name,
      routePath: subscription.routePath,
      routeTemplate: subscription.routeTemplate ?? current?.routeTemplate,
      description: subscription.description,
    };

    const isUnchanged =
      current &&
      current.category === nextCore.category &&
      JSON.stringify(current.categories || []) === JSON.stringify(nextCore.categories || []) &&
      current.name === nextCore.name &&
      current.routePath === nextCore.routePath &&
      current.routeTemplate === nextCore.routeTemplate &&
      current.description === nextCore.description;

    return {
      id: subscription.id,
      ...nextCore,
      enabled: current?.enabled ?? subscription.enabled ?? defaultEnabled,
      createdAt: current?.createdAt ?? now,
      updatedAt: isUnchanged ? current.updatedAt : now,
    };
  });

  return [...mergedGeneratedSubscriptions, ...manualSubscriptions];
}
