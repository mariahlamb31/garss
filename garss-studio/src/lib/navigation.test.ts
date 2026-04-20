import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUrlForSourcesCategory,
  buildUrlForTab,
  parseAppLocation,
  readAccessCodeFromUrl,
} from "./navigation.ts";

test("parseAppLocation derives reader tab from pathname and preserves pw query", () => {
  const parsed = parseAppLocation("https://example.com/reader?pw=banana");

  assert.equal(parsed.tab, "reader");
  assert.equal(parsed.category, "all");
  assert.equal(parsed.accessCode, "banana");
});

test("parseAppLocation derives sources tab and category from hash", () => {
  const parsed = parseAppLocation("https://example.com/sources?pw=banana#AI");

  assert.equal(parsed.tab, "sources");
  assert.equal(parsed.category, "AI");
  assert.equal(parsed.accessCode, "banana");
});

test("parseAppLocation treats missing or #all hash as fallback category marker", () => {
  assert.equal(parseAppLocation("https://example.com/sources?pw=banana").category, "all");
  assert.equal(parseAppLocation("https://example.com/sources?pw=banana#all").category, "all");
  assert.equal(parseAppLocation("https://example.com/sources?pw=banana#ALL").category, "all");
});

test("parseAppLocation falls back to reader for unknown paths", () => {
  const parsed = parseAppLocation("https://example.com/unknown?pw=banana#AI");

  assert.equal(parsed.tab, "reader");
  assert.equal(parsed.category, "all");
  assert.equal(parsed.accessCode, "banana");
});

test("buildUrlForTab preserves pw query while switching top-level tabs", () => {
  assert.equal(buildUrlForTab("https://example.com/sources?pw=banana#AI", "settings"), "/settings?pw=banana");
  assert.equal(buildUrlForTab("https://example.com/settings?pw=banana", "reader"), "/reader?pw=banana");
});

test("buildUrlForSourcesCategory updates only hash and keeps query", () => {
  assert.equal(
    buildUrlForSourcesCategory("https://example.com/sources?pw=banana#AI", "设计"),
    "/sources?pw=banana#%E8%AE%BE%E8%AE%A1",
  );
});

test("buildUrlForSourcesCategory drops hash for fallback category", () => {
  assert.equal(buildUrlForSourcesCategory("https://example.com/sources?pw=banana#AI", "all"), "/sources?pw=banana");
});

test("readAccessCodeFromUrl trims pw and ignores other route parts", () => {
  assert.equal(readAccessCodeFromUrl("https://example.com/settings?pw=%20banana%20#AI"), "banana");
  assert.equal(readAccessCodeFromUrl("https://example.com/reader?foo=bar"), "");
});
