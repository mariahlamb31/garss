import assert from "node:assert/strict";
import test from "node:test";
import { buildFeedItemId } from "./feed-item-id.js";

test("buildFeedItemId returns different ids for same title and link when published/content differ", () => {
  const baseInput = {
    subscriptionId: "sub-1",
    sourceLink: "https://weather.sz.gov.cn/live",
    title: "来自深圳市气象局官网",
    guid: "",
  };

  const firstId = buildFeedItemId({
    ...baseInput,
    publishedAtFingerprint: "2026-04-19T16:00:00.000Z",
    excerpt: "深圳台风网直播第 1 条",
    contentText: "第 1 条正文",
    index: 0,
  });
  const secondId = buildFeedItemId({
    ...baseInput,
    publishedAtFingerprint: "2026-04-19T17:00:00.000Z",
    excerpt: "深圳台风网直播第 2 条",
    contentText: "第 2 条正文",
    index: 1,
  });

  assert.notEqual(firstId, secondId);
});

test("buildFeedItemId stays stable for the same item payload", () => {
  const input = {
    subscriptionId: "sub-1",
    sourceLink: "https://weather.sz.gov.cn/live",
    title: "来自深圳市气象局官网",
    guid: "item-guid-1",
    publishedAtFingerprint: "2026-04-19T16:00:00.000Z",
    excerpt: "深圳台风网直播第 1 条",
    contentText: "第 1 条正文",
    index: 0,
  };

  assert.equal(buildFeedItemId(input), buildFeedItemId(input));
});

test("buildFeedItemId falls back to index only when other identity fields are identical", () => {
  const baseInput = {
    subscriptionId: "sub-1",
    sourceLink: "https://weather.sz.gov.cn/live",
    title: "来自深圳市气象局官网",
    guid: "",
    publishedAtFingerprint: "",
    excerpt: "",
    contentText: "",
  };

  const firstId = buildFeedItemId({ ...baseInput, index: 0 });
  const secondId = buildFeedItemId({ ...baseInput, index: 1 });

  assert.notEqual(firstId, secondId);
});
