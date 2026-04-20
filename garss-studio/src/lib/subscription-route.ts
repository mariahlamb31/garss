export interface RouteParameterOption {
  label: string;
  value: string;
}

export interface RouteParameterDefinition {
  name: string;
  optional: boolean;
  pattern: string;
  description: string;
  options: RouteParameterOption[];
  inputKind: "text" | "select";
}

interface TemplateSegment {
  type: "static" | "param";
  value?: string;
  name?: string;
  optional?: boolean;
  pattern?: string;
}

export interface RouteTemplateMeta {
  template: string;
  isTemplate: boolean;
  exampleRoutePath: string;
  parameters: RouteParameterDefinition[];
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function splitDescriptionParts(description: string): string[] {
  return description
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractExampleRoutePath(description: string): string {
  const match = description.match(/示例：([^\s|]+)/);
  return normalizeText(match?.[1]);
}

function extractParameterDescriptions(description: string): Record<string, string> {
  const match = description.match(/参数：([\s\S]+)/);

  if (!match) {
    return {};
  }

  return Object.fromEntries(
    match[1]
      .split(/[；;]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const index = entry.indexOf(":");

        if (index <= 0) {
          return ["", ""];
        }

        return [normalizeText(entry.slice(0, index)), normalizeText(entry.slice(index + 1))];
      })
      .filter((entry) => entry[0]),
  );
}

function dedupeOptions(options: RouteParameterOption[]): RouteParameterOption[] {
  const seen = new Set<string>();
  const result: RouteParameterOption[] = [];

  for (const option of options) {
    const label = normalizeText(option.label);
    const value = normalizeText(option.value);

    if (!label || !value) {
      continue;
    }

    const key = `${label}::${value}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({ label, value });
  }

  return result;
}

function extractOptionsFromMappings(text: string): RouteParameterOption[] {
  const result: RouteParameterOption[] = [];

  for (const match of text.matchAll(/[“"]?([^"”]+?)[”"]?\s*对应\s*([a-z0-9_-]+)/gi)) {
    result.push({
      label: normalizeText(match[1]),
      value: normalizeText(match[2]),
    });
  }

  return result;
}

function extractOptionsFromValueFirstPairs(text: string): RouteParameterOption[] {
  const result: RouteParameterOption[] = [];

  for (const chunk of text.split(/[，;,；]/)) {
    const trimmed = normalizeText(chunk);
    const match = trimmed.match(/^([a-z0-9_-]+)(.+)$/i);

    if (!match) {
      continue;
    }

    const label = normalizeText(match[2]).replace(/\(默认\)|（默认）/g, "").trim();

    if (!label) {
      continue;
    }

    result.push({
      label,
      value: normalizeText(match[1]),
    });
  }

  return result;
}

function extractDenseTableOptions(text: string): RouteParameterOption[] {
  const tokens = normalizeText(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length < 4 || tokens.length % 2 !== 0) {
    return [];
  }

  const half = tokens.length / 2;
  const left = tokens.slice(0, half);
  const right = tokens.slice(half);

  if (!right.every((token) => /^[a-z0-9_-]+$/i.test(token))) {
    return [];
  }

  return left.map((label, index) => ({
    label,
    value: right[index] || "",
  }));
}

function extractOptionsFromDescription(paramDescription: string, fullDescription: string): RouteParameterOption[] {
  const directOptionsMatch = paramDescription.match(/可选值:\s*(.+)$/i);
  const directOptionsText = normalizeText(directOptionsMatch?.[1]);

  if (directOptionsText) {
    return dedupeOptions(
      directOptionsText.split(/[;,；]/).map((entry) => {
        const [left, right] = entry.split("=");
        const label = normalizeText(left);
        const value = normalizeText(right);
        return value ? { label, value } : { label, value: label };
      }),
    );
  }

  const mappedOptions = dedupeOptions([
    ...extractOptionsFromMappings(paramDescription),
    ...extractOptionsFromValueFirstPairs(paramDescription),
  ]);

  if (mappedOptions.length) {
    return mappedOptions;
  }

  if (/见下表|参见下表|默认为/.test(paramDescription)) {
    const leadingText =
      splitDescriptionParts(fullDescription).find((entry) => !entry.startsWith("示例：") && !entry.startsWith("参数：")) ||
      "";
    const denseOptions = dedupeOptions(extractDenseTableOptions(leadingText.replace(/^.+?[：:]/, "")));

    if (denseOptions.length) {
      return denseOptions;
    }
  }

  return [];
}

function parseTemplateSegments(template: string): TemplateSegment[] {
  return template
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const match = segment.match(/^:([a-zA-Z0-9_]+)(?:\{([^}]+)\})?(\?)?$/);

      if (!match) {
        return {
          type: "static",
          value: segment,
        };
      }

      return {
        type: "param",
        name: match[1],
        pattern: match[2] || "",
        optional: match[3] === "?",
      };
    });
}

export function buildRoutePathFromTemplate(template: string, values: Record<string, string>): string {
  const segments = parseTemplateSegments(template);
  const output: string[] = [];

  for (const segment of segments) {
    if (segment.type === "static") {
      output.push(segment.value || "");
      continue;
    }

    const value = normalizeText(values[segment.name || ""]);

    if (!value) {
      if (!segment.optional) {
        output.push("");
      }
      continue;
    }

    output.push(value.replace(/^\/+|\/+$/g, ""));
  }

  return `/${output.filter(Boolean).join("/")}`;
}

export function matchRoutePathToTemplate(
  template: string,
  routePath: string,
): { matched: boolean; values: Record<string, string> } {
  const templateSegments = parseTemplateSegments(template);
  const routeSegments = normalizeText(routePath)
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
  const values: Record<string, string> = {};
  let routeIndex = 0;

  for (const templateSegment of templateSegments) {
    if (templateSegment.type === "static") {
      if (routeSegments[routeIndex] !== templateSegment.value) {
        return { matched: false, values };
      }

      routeIndex += 1;
      continue;
    }

    const paramName = templateSegment.name || "";

    if (templateSegment.pattern === ".+") {
      const remaining = routeSegments.slice(routeIndex).join("/");

      if (!remaining && !templateSegment.optional) {
        return { matched: false, values };
      }

      values[paramName] = remaining;
      routeIndex = routeSegments.length;
      continue;
    }

    const currentSegment = routeSegments[routeIndex];

    if (!currentSegment) {
      if (templateSegment.optional) {
        values[paramName] = "";
        continue;
      }

      return { matched: false, values };
    }

    values[paramName] = currentSegment;
    routeIndex += 1;
  }

  if (routeIndex !== routeSegments.length) {
    return { matched: false, values };
  }

  for (const segment of templateSegments) {
    if (segment.type === "param" && !values[segment.name || ""]) {
      values[segment.name || ""] = "";
    }
  }

  return { matched: true, values };
}

export function extractRouteTemplateMeta(routeTemplate: string, description: string): RouteTemplateMeta {
  const template = normalizeText(routeTemplate);
  const parameterDescriptions = extractParameterDescriptions(description);
  const parameters = parseTemplateSegments(template)
    .filter((segment): segment is TemplateSegment & { type: "param"; name: string } => segment.type === "param" && Boolean(segment.name))
    .map((segment) => {
      const paramDescription = parameterDescriptions[segment.name] || "";
      const options = extractOptionsFromDescription(paramDescription, description);

      return {
        name: segment.name,
        optional: Boolean(segment.optional),
        pattern: segment.pattern || "",
        description: paramDescription,
        options,
        inputKind: options.length ? "select" : "text",
      } satisfies RouteParameterDefinition;
    });

  return {
    template,
    isTemplate: parameters.length > 0,
    exampleRoutePath: extractExampleRoutePath(description),
    parameters,
  };
}
