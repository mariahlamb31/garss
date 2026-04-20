import { useEffect, useMemo, useState } from "react";
import {
  buildRoutePathFromTemplate,
  extractRouteTemplateMeta,
  matchRoutePathToTemplate,
} from "../lib/subscription-route";
import type { SubscriptionInput, SubscriptionTestResponse } from "../types";

interface SubscriptionEditorModalProps {
  categories: string[];
  form: SubscriptionInput;
  savingSource: boolean;
  editingSubscriptionId: string;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onCreateFromCurrentTemplate: () => void;
  onFormChange: (updater: (current: SubscriptionInput) => SubscriptionInput) => void;
  onTestSubscription: (input: SubscriptionInput) => Promise<SubscriptionTestResponse>;
}

interface TestFeedback {
  status: "idle" | "loading" | "success" | "error";
  message: string;
  itemCount: number;
  sampleTitles: string[];
  targetUrl: string;
}

function buildIdleFeedback(): TestFeedback {
  return {
    status: "idle",
    message: "",
    itemCount: 0,
    sampleTitles: [],
    targetUrl: "",
  };
}

function normalizeTemplateCandidate(form: SubscriptionInput): string {
  const routeTemplate = form.routeTemplate?.trim() || "";

  if (routeTemplate) {
    return routeTemplate;
  }

  return form.routePath.includes(":") ? form.routePath.trim() : "";
}

export function SubscriptionEditorModal({
  categories,
  form,
  savingSource,
  editingSubscriptionId,
  onClose,
  onSubmit,
  onCreateFromCurrentTemplate,
  onFormChange,
  onTestSubscription,
}: SubscriptionEditorModalProps) {
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  const [testFeedback, setTestFeedback] = useState<TestFeedback>(buildIdleFeedback);
  const templateCandidate = normalizeTemplateCandidate(form);
  const templateMeta = useMemo(
    () => extractRouteTemplateMeta(templateCandidate, form.description),
    [form.description, templateCandidate],
  );
  const routeMatch = useMemo(
    () =>
      templateMeta.isTemplate
        ? matchRoutePathToTemplate(templateMeta.template, form.routePath)
        : { matched: false, values: {} },
    [form.routePath, templateMeta],
  );
  const generatedRoutePath = useMemo(
    () =>
      templateMeta.isTemplate
        ? buildRoutePathFromTemplate(templateMeta.template, parameterValues)
        : form.routePath,
    [form.routePath, parameterValues, templateMeta],
  );
  const hasMissingRequiredParameter = templateMeta.parameters.some(
    (parameter) => !parameter.optional && !parameterValues[parameter.name]?.trim(),
  );

  useEffect(() => {
    if (!templateMeta.isTemplate) {
      setParameterValues({});
      return;
    }

    if (routeMatch.matched) {
      setParameterValues(routeMatch.values);
      return;
    }

    const nextValues = Object.fromEntries(templateMeta.parameters.map((parameter) => [parameter.name, ""]));
    setParameterValues(nextValues);
  }, [routeMatch.matched, routeMatch.values, templateMeta]);

  useEffect(() => {
    setTestFeedback(buildIdleFeedback());
  }, [form.description, form.enabled, form.name, form.routePath, form.routeTemplate]);

  function updateForm(updater: (current: SubscriptionInput) => SubscriptionInput) {
    onFormChange(updater);
  }

  function handleRoutePathChange(value: string) {
    updateForm((current) => ({ ...current, routePath: value }));

    if (!templateMeta.isTemplate) {
      return;
    }

    const matched = matchRoutePathToTemplate(templateMeta.template, value);

    if (matched.matched) {
      setParameterValues(matched.values);
    }
  }

  function handleParameterChange(name: string, value: string) {
    const nextValues = {
      ...parameterValues,
      [name]: value,
    };

    setParameterValues(nextValues);
    updateForm((current) => ({
      ...current,
      routeTemplate: templateMeta.template,
      routePath: buildRoutePathFromTemplate(templateMeta.template, nextValues),
    }));
  }

  async function handleTestSubscription() {
    setTestFeedback({
      status: "loading",
      message: "正在测试当前订阅源…",
      itemCount: 0,
      sampleTitles: [],
      targetUrl: "",
    });

    try {
      const result = await onTestSubscription({
        ...form,
        category: form.category.trim(),
        name: form.name.trim(),
        routePath: form.routePath.trim(),
        routeTemplate: form.routeTemplate?.trim() || templateMeta.template || "",
        description: form.description.trim(),
      });

      setTestFeedback({
        status: "success",
        message: result.itemCount
          ? `测试成功，拿到 ${result.itemCount} 条。`
          : "测试成功，可正常访问，但当前没有拿到文章。",
        itemCount: result.itemCount,
        sampleTitles: result.sampleTitles,
        targetUrl: result.targetUrl,
      });
    } catch (error) {
      const message = error instanceof Error && error.message.trim() ? error.message : "测试失败，请稍后重试。";
      setTestFeedback({
        status: "error",
        message,
        itemCount: 0,
        sampleTitles: [],
        targetUrl: "",
      });
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
        <form className="modal-form-sheet" onSubmit={(event) => void onSubmit(event)}>
          <div className="sheet-head">
            <h3>{editingSubscriptionId ? "编辑订阅源" : "新增订阅源"}</h3>
            <p>保留整条地址直改，同时对 RSSHub 模板路由提供参数填写和保存前自测。</p>
          </div>

          <label className="stack-field">
            <span>类型</span>
            <input
              type="text"
              list="source-category-options"
              value={form.category}
              onChange={(event) => updateForm((current) => ({ ...current, category: event.target.value }))}
              placeholder="例如：AI、科技商业、财经市场"
            />
          </label>
          <datalist id="source-category-options">
            {categories.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>

          <label className="stack-field">
            <span>名称</span>
            <input
              type="text"
              value={form.name}
              onChange={(event) => updateForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="例如：GitHub Trending JS"
            />
          </label>

          {templateMeta.isTemplate ? (
            <section className="template-editor-block">
              <div className="template-editor-head">
                <strong>参数编辑</strong>
                <span>{templateMeta.parameters.length} 个占位参数</span>
              </div>
              {templateMeta.parameters.map((parameter) => (
                <label key={parameter.name} className="stack-field template-parameter-field">
                  <span>
                    {parameter.name}
                    {parameter.optional ? <em>可留空</em> : null}
                  </span>
                  {parameter.inputKind === "select" ? (
                    <select
                      value={parameterValues[parameter.name] || ""}
                      onChange={(event) => handleParameterChange(parameter.name, event.target.value)}
                    >
                      <option value="">{parameter.optional ? "留空" : "请选择"}</option>
                      {parameter.options.map((option) => (
                        <option key={`${parameter.name}-${option.value}`} value={option.value}>
                          {option.label} · {option.value}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={parameterValues[parameter.name] || ""}
                      onChange={(event) => handleParameterChange(parameter.name, event.target.value)}
                      placeholder={parameter.pattern === ".+" ? "支持带 / 的整段路径" : `填写 ${parameter.name}`}
                    />
                  )}
                  {parameter.description ? <small className="field-help">{parameter.description}</small> : null}
                </label>
              ))}
              <div className="template-preview-card">
                <small>模板：{templateMeta.template}</small>
                <strong>结果：{generatedRoutePath || "等待填写参数"}</strong>
                {templateMeta.exampleRoutePath ? <small>示例：{templateMeta.exampleRoutePath}</small> : null}
                {!routeMatch.matched && form.routePath.trim() && form.routePath.trim() !== templateMeta.template ? (
                  <small className="field-help is-warning">当前完整地址与模板参数未完全对应，已保留你的手动输入。</small>
                ) : null}
              </div>
            </section>
          ) : null}

          <label className="stack-field">
            <span>订阅地址</span>
            <div className="route-path-row">
              <input
                type="text"
                value={form.routePath}
                onChange={(event) => handleRoutePathChange(event.target.value)}
                placeholder="/github/trending/daily/javascript 或 https://example.com/feed.xml"
              />
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleTestSubscription()}
                disabled={!form.name.trim() || !form.routePath.trim() || testFeedback.status === "loading" || hasMissingRequiredParameter}
              >
                {testFeedback.status === "loading" ? "测试中..." : "自测 RSS"}
              </button>
            </div>
          </label>

          <label className="stack-field">
            <span>说明</span>
            <textarea
              rows={5}
              value={form.description}
              onChange={(event) => updateForm((current) => ({ ...current, description: event.target.value }))}
              placeholder="可选，用来记录这个源的用途。"
            />
          </label>

          {hasMissingRequiredParameter ? (
            <div className="editor-test-row">
              <span className="field-help is-warning">请先补全必填参数再测试。</span>
            </div>
          ) : null}

          {testFeedback.status === "success" ? (
            <div className="test-feedback-card is-success">
              <strong>{testFeedback.message}</strong>
              {testFeedback.targetUrl ? <small>请求地址：{testFeedback.targetUrl}</small> : null}
              {testFeedback.sampleTitles.length ? (
                <ul>
                  {testFeedback.sampleTitles.map((title) => (
                    <li key={title}>{title}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {testFeedback.status === "error" ? (
            <div className="test-feedback-card is-error">
              <strong>测试失败</strong>
              <small>{testFeedback.message}</small>
            </div>
          ) : null}

          <div className="form-actions">
            <button
              type="submit"
              className="primary-button"
              disabled={savingSource || !form.name.trim() || !form.routePath.trim()}
            >
              {savingSource ? "保存中..." : editingSubscriptionId ? "更新订阅源" : "添加订阅源"}
            </button>
            {editingSubscriptionId ? (
              <button
                type="button"
                className="secondary-button"
                onClick={onCreateFromCurrentTemplate}
                disabled={savingSource}
              >
                基于当前模板创建新订阅
              </button>
            ) : null}
            <button type="button" className="secondary-button" onClick={onClose}>
              取消
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
