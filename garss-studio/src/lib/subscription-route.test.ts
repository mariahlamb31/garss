import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRoutePathFromTemplate,
  extractRouteTemplateMeta,
  matchRoutePathToTemplate,
} from "./subscription-route.ts";

test("extractRouteTemplateMeta parses slash-friendly optional params and example", () => {
  const meta = extractRouteTemplateMeta(
    "/81/81rc/:category{.+}?",
    "若订阅 工作动态，网址为 https://81rc.81.cn/sy/gzdt 210283。截取 https://81rc.81.cn/ 到末尾的部分 sy/gzdt 210283 作为参数填入，此时路由为 /81/81rc/sy/gzdt_210283。 | 示例：/81/81rc/sy/gzdt_210283 | 参数：category: 分类，默认为 sy/gzdt 210283，即工作动态，可在对应分类页 URL 中找到",
  );

  assert.equal(meta.isTemplate, true);
  assert.equal(meta.parameters.length, 1);
  assert.equal(meta.parameters[0]?.name, "category");
  assert.equal(meta.parameters[0]?.optional, true);
  assert.equal(meta.parameters[0]?.pattern, ".+");
  assert.equal(meta.exampleRoutePath, "/81/81rc/sy/gzdt_210283");
});

test("extractRouteTemplateMeta infers selectable options from RSSHub docs description", () => {
  const meta = extractRouteTemplateMeta(
    "/163/news/rank/:category?/:type?/:time?",
    "全站新闻 点击榜 的统计时间仅包含 “24 小时”、“本周”、“本月”，不包含 “1 小时”。即可用的time参数为day、week、month。 其他分类 点击榜 的统计时间仅包含 “1 小时”、“24 小时”、“本周”。即可用的time参数为hour、day、week。 而所有分类（包括全站）的 跟贴榜 的统计时间皆仅包含 “24 小时”、“本周”、“本月”。即可用的time参数为day、week、month。 新闻分类： 全站 新闻 娱乐 体育 财经 科技 汽车 女人 房产 游戏 旅游 教育 whole news entertainment sports money tech auto lady house game travel edu | 示例：/163/news/rank/whole/click/day | 参数：category: 新闻分类，参见下表，默认为“全站”；type: 排行榜类型，“点击榜”对应click，“跟贴榜”对应follow，默认为“点击榜”；time: 统计时间，“1小时”对应hour，“24小时”对应day，“本周”对应week，“本月”对应month，默认为“24小时”",
  );

  const typeField = meta.parameters.find((parameter) => parameter.name === "type");
  const timeField = meta.parameters.find((parameter) => parameter.name === "time");
  const categoryField = meta.parameters.find((parameter) => parameter.name === "category");

  assert.deepEqual(typeField?.options.map((option) => option.value), ["click", "follow"]);
  assert.deepEqual(timeField?.options.map((option) => option.value), ["hour", "day", "week", "month"]);
  assert.ok(categoryField?.options.some((option) => option.label === "全站" && option.value === "whole"));
  assert.ok(categoryField?.options.some((option) => option.label === "教育" && option.value === "edu"));
});

test("buildRoutePathFromTemplate and matchRoutePathToTemplate stay in sync", () => {
  const template = "/163/music/djradio/:id/:info?";
  const routePath = buildRoutePathFromTemplate(template, {
    id: "347317067",
    info: "",
  });

  assert.equal(routePath, "/163/music/djradio/347317067");
  assert.deepEqual(matchRoutePathToTemplate(template, routePath), {
    matched: true,
    values: {
      id: "347317067",
      info: "",
    },
  });

  const routePathWithOptional = buildRoutePathFromTemplate(template, {
    id: "347317067",
    info: "hide",
  });

  assert.equal(routePathWithOptional, "/163/music/djradio/347317067/hide");
  assert.deepEqual(matchRoutePathToTemplate(template, routePathWithOptional), {
    matched: true,
    values: {
      id: "347317067",
      info: "hide",
    },
  });
});
