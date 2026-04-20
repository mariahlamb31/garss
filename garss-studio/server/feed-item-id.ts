import crypto from "node:crypto";

interface BuildFeedItemIdInput {
  subscriptionId: string;
  sourceLink: string;
  title: string;
  guid: string;
  publishedAtFingerprint: string;
  excerpt: string;
  contentText: string;
  index: number;
}

function normalizeIdentityPart(value: string): string {
  return value.trim();
}

function hashContentFingerprint(excerpt: string, contentText: string): string {
  return crypto
    .createHash("sha1")
    .update(`${normalizeIdentityPart(excerpt)}\u0000${normalizeIdentityPart(contentText)}`)
    .digest("hex");
}

export function buildFeedItemId(input: BuildFeedItemIdInput): string {
  const subscriptionId = normalizeIdentityPart(input.subscriptionId);
  const sourceLink = normalizeIdentityPart(input.sourceLink);
  const title = normalizeIdentityPart(input.title);
  const guid = normalizeIdentityPart(input.guid);
  const publishedAtFingerprint = normalizeIdentityPart(input.publishedAtFingerprint);
  const excerpt = normalizeIdentityPart(input.excerpt);
  const contentText = normalizeIdentityPart(input.contentText);
  const hasIdentityFingerprint = Boolean(guid || publishedAtFingerprint || excerpt || contentText);
  const fallbackIndex = hasIdentityFingerprint ? "" : String(input.index);
  const stableKey = [
    subscriptionId,
    sourceLink,
    title,
    guid,
    publishedAtFingerprint,
    hashContentFingerprint(excerpt, contentText),
    fallbackIndex,
  ].join(":");

  return crypto.createHash("sha1").update(stableKey).digest("hex");
}
