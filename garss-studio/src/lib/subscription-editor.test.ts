import assert from "node:assert/strict";
import test from "node:test";
import { buildCopiedSubscriptionName, buildDuplicateSubscriptionDraft } from "./subscription-editor.ts";

test("buildCopiedSubscriptionName appends a copy suffix once", () => {
  assert.equal(buildCopiedSubscriptionName("GitHub Trending JS"), "GitHub Trending JS（副本）");
  assert.equal(buildCopiedSubscriptionName("GitHub Trending JS（副本）"), "GitHub Trending JS（副本）");
});

test("buildDuplicateSubscriptionDraft keeps form values but switches to create mode", () => {
  const draft = buildDuplicateSubscriptionDraft({
    category: "AI",
    name: "RSSHub 模板",
    routePath: "/github/trending/daily/javascript",
    routeTemplate: "/github/trending/daily/:language",
    description: "按语言订阅",
    enabled: false,
  });

  assert.equal(draft.editingSubscriptionId, "");
  assert.deepEqual(draft.form, {
    category: "AI",
    name: "RSSHub 模板（副本）",
    routePath: "/github/trending/daily/javascript",
    routeTemplate: "/github/trending/daily/:language",
    description: "按语言订阅",
    enabled: false,
  });
});
