import { useEffect, useMemo, useRef, useState } from "react";
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
  viewOnly?: boolean;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onFormChange: (updater: (current: SubscriptionInput) => SubscriptionInput) => void;
  onTestSubscription: (input: SubscriptionInput) => Promise<SubscriptionTestResponse>;
  onCreateSubscriptionDraft?: (input: SubscriptionInput) => void;
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

function normalizeCategoryList(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const normalized = (value || "").trim();

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

export function SubscriptionEditorModal({
  categories,
  form,
  savingSource,
  editingSubscriptionId,
  viewOnly = false,
  onClose,
  onSubmit,
  onFormChange,
  onTestSubscription,
  onCreateSubscriptionDraft,
}: SubscriptionEditorModalProps) {
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  const [testFeedback, setTestFeedback] = useState<TestFeedback>(buildIdleFeedback);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const backdropPointerStartedRef = useRef(false);
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
  const categoryOptions = useMemo(() => {
    const currentCategories = normalizeCategoryList([...(form.categories || []), form.category]);
    return normalizeCategoryList([...categories, ...currentCategories]);
  }, [categories, form.categories, form.category]);
  const selectedCategories = useMemo(
    () => normalizeCategoryList([...(form.categories || []), form.category]),
    [form.categories, form.category],
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

  function updateCategories(nextCategories: string[]) {
    const normalized = normalizeCategoryList(nextCategories);
    updateForm((current) => ({
      ...current,
      category: normalized[0] || "",
      categories: normalized,
    }));
  }

  function handleToggleCategory(category: string) {
    if (selectedCategories.includes(category)) {
      updateCategories(selectedCategories.filter((entry) => entry !== category));
      return;
    }

    updateCategories([...selectedCategories, category]);
  }

  function handleAddCategory() {
    const normalizedName = newCategoryName.trim();

    if (!normalizedName) {
      return;
    }

    updateCategories([...selectedCategories, normalizedName]);
    setNewCategoryName("");
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

  function buildSubscriptionDraft(): SubscriptionInput {
    return {
      category: selectedCategories[0] || form.category.trim(),
      categories: selectedCategories,
      name: form.name.trim(),
      routePath: form.routePath.trim(),
      routeTemplate: form.routeTemplate?.trim() || templateMeta.template || "",
      description: form.description.trim(),
      enabled: true,
    };
  }

  function handleBackdropPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    backdropPointerStartedRef.current = event.target === event.currentTarget;
  }

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>) {
    const shouldClose = backdropPointerStartedRef.current && event.target === event.currentTarget;
    backdropPointerStartedRef.current = false;

    if (shouldClose) {
      onClose();
    }
  }

  return (
    <div className="modal-backdrop" onPointerDown={handleBackdropPointerDown} onClick={handleBackdropClick}>
      <div className="modal-panel" onClick={(event) => event.stopPropagation()}>
        <form className={`modal-form-sheet${viewOnly ? " is-view-only" : ""}`} onSubmit={(event) => void onSubmit(event)}>
          <div className="sheet-head">
            <h3>{viewOnly ? "查看订阅源" : editingSubscriptionId ? "编辑订阅源" : "新增订阅源"}</h3>
            {!viewOnly ? <p>保留整条地址直改，同时对 RSSHub 模板路由提供参数填写和保存前自测。</p> : null}
          </div>

          <label className="stack-field">
            <span>名称</span>
            <input
              type="text"
              value={form.name}
              disabled={viewOnly}
              onChange={(event) => updateForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="例如：GitHub Trending JS"
            />
          </label>

          {viewOnly && form.description.trim() ? (
            <label className="stack-field">
              <span>说明</span>
              <textarea rows={3} value={form.description} disabled placeholder="可选，用来记录这个源的用途。" />
            </label>
          ) : null}

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
                disabled={viewOnly}
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

          {!viewOnly ? (
            <section className={`advanced-options${viewOnly || isAdvancedOpen ? " is-open" : ""}`}>
              <button
                type="button"
                className="advanced-options-trigger"
                aria-expanded={isAdvancedOpen}
                onClick={() => setIsAdvancedOpen((currentValue) => !currentValue)}
              >
                <span>高级选项</span>
                <strong>{isAdvancedOpen ? "收起" : "展开"}</strong>
              </button>
              <div className="advanced-options-body">
                <label className="stack-field">
                  <span>类型</span>
                  <div className="category-tag-editor">
                    <div className="category-tag-list">
                      {selectedCategories.length ? (
                        selectedCategories.map((category) => (
                          <button
                            key={`selected-${category}`}
                            type="button"
                            className="category-tag is-selected"
                            onClick={() => handleToggleCategory(category)}
                          >
                            <span>{category}</span>
                            <strong>×</strong>
                          </button>
                        ))
                      ) : (
                        <small className="field-help">还没有类型，可以从预制类型选择或直接新增。</small>
                      )}
                    </div>
                    {categoryOptions.length ? (
                      <div className="category-preset-list">
                        {categoryOptions.map((category) => {
                          const isSelected = selectedCategories.includes(category);

                          return (
                            <button
                              key={`preset-${category}`}
                              type="button"
                              className={isSelected ? "category-preset is-selected" : "category-preset"}
                              onClick={() => handleToggleCategory(category)}
                            >
                              {category}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="category-create-row">
                      <input
                        type="text"
                        value={newCategoryName}
                        onChange={(event) => setNewCategoryName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            handleAddCategory();
                          }
                        }}
                        placeholder="新增类型"
                      />
                      <button type="button" className="secondary-button" onClick={handleAddCategory} disabled={!newCategoryName.trim()}>
                        添加
                      </button>
                    </div>
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
              </div>
            </section>
          ) : null}

          {hasMissingRequiredParameter ? (
            <div className="editor-test-row">
              <span className="field-help is-warning">请先补全必填参数再测试。</span>
            </div>
          ) : null}

          {testFeedback.status === "success" ? (
            <div className="test-feedback-card is-success">
              <div className="test-feedback-head">
                <strong>{testFeedback.message}</strong>
                {viewOnly && onCreateSubscriptionDraft ? (
                  <button type="button" className="secondary-button" onClick={() => onCreateSubscriptionDraft(buildSubscriptionDraft())}>
                    一键添加订阅源
                  </button>
                ) : null}
              </div>
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

          {!viewOnly ? (
            <div className="form-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={savingSource || !form.name.trim() || !form.routePath.trim()}
              >
                {savingSource ? "保存中..." : editingSubscriptionId ? "更新订阅源" : "添加订阅源"}
              </button>
              <button type="button" className="secondary-button" onClick={onClose}>
                取消
              </button>
            </div>
          ) : null}
        </form>
      </div>
    </div>
  );
}
