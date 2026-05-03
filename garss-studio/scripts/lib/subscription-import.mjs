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
  const existingById = new Map(existingSubscriptions.map((subscription) => [subscription.id, subscription]));
  const manualSubscriptions = existingSubscriptions.filter(
    (subscription) => !subscription.id.startsWith(`${generatedIdPrefix}-`),
  );

  const mergedGeneratedSubscriptions = generatedSubscriptions.map((subscription) => {
    const current = existingById.get(subscription.id);
    const nextCore = {
      category: subscription.category,
      name: subscription.name,
      routePath: subscription.routePath,
      description: subscription.description,
    };

    const isUnchanged =
      current &&
      current.category === nextCore.category &&
      current.name === nextCore.name &&
      current.routePath === nextCore.routePath &&
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
