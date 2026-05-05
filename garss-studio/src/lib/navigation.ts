import type { AppTab } from "../types";

export const ALL_SOURCES_CATEGORY = "all";

export interface ParsedAppLocation {
  tab: AppTab;
  category: string;
  accessCode: string;
  readerMode: "" | "pure" | "traditional";
  readerCategory: string;
  readerItemId: string;
}

const DEFAULT_BASE_URL = "http://localhost";

function toUrl(input: string): URL {
  return new URL(input, DEFAULT_BASE_URL);
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function parseTabFromPathname(pathname: string): AppTab {
  switch (normalizePathname(pathname)) {
    case "/rsshub":
      return "rsshub";
    case "/sources":
      return "sources";
    case "/settings":
      return "settings";
    case "/":
    case "/reader":
    default:
      return "reader";
  }
}

function normalizeCategory(hash: string): string {
  const decodedHash = decodeURIComponent(hash.replace(/^#/, "")).trim();

  if (!decodedHash || decodedHash.toLowerCase() === ALL_SOURCES_CATEGORY) {
    return ALL_SOURCES_CATEGORY;
  }

  return decodedHash;
}

function normalizeReaderMode(value: string | null): "" | "pure" | "traditional" {
  return value === "pure" || value === "traditional" ? value : "";
}

function parseReaderHash(hash: string): {
  readerMode: "" | "pure" | "traditional";
  readerCategory: string;
  readerItemId: string;
} {
  const decodedHash = decodeURIComponent(hash.replace(/^#/, "")).trim();

  if (!decodedHash) {
    return { readerMode: "", readerCategory: "", readerItemId: "" };
  }

  const searchParams = new URLSearchParams(decodedHash);
  return {
    readerMode: normalizeReaderMode(searchParams.get("mode")),
    readerCategory: searchParams.get("category")?.trim() || "",
    readerItemId: searchParams.get("item")?.trim() || "",
  };
}

function buildPathname(tab: AppTab): string {
  switch (tab) {
    case "sources":
      return "/sources";
    case "rsshub":
      return "/rsshub";
    case "settings":
      return "/settings";
    case "reader":
    default:
      return "/reader";
  }
}

export function parseAppLocation(input: string): ParsedAppLocation {
  const url = toUrl(input);
  const tab = parseTabFromPathname(url.pathname);
  const readerHash =
    tab === "reader" ? parseReaderHash(url.hash) : { readerMode: "" as const, readerCategory: "", readerItemId: "" };

  return {
    tab,
    category: tab === "sources" || tab === "rsshub" ? normalizeCategory(url.hash) : ALL_SOURCES_CATEGORY,
    accessCode: url.searchParams.get("pw")?.trim() || "",
    readerMode: readerHash.readerMode,
    readerCategory: readerHash.readerCategory,
    readerItemId: readerHash.readerItemId,
  };
}

export function readAccessCodeFromUrl(input: string): string {
  return parseAppLocation(input).accessCode;
}

export function readAccessCodeFromCurrentUrl(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return readAccessCodeFromUrl(window.location.href);
}

export function writeAccessCodeToCurrentUrl(accessCode: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const url = toUrl(window.location.href);

  if (accessCode.trim()) {
    url.searchParams.set("pw", accessCode.trim());
  } else {
    url.searchParams.delete("pw");
  }

  window.history.replaceState({}, "", url);
}

export function buildUrlForTab(input: string, tab: AppTab): string {
  const url = toUrl(input);
  url.pathname = buildPathname(tab);
  url.hash = "";
  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildUrlForReaderState(
  input: string,
  state: { mode: "pure" | "traditional"; category?: string; itemId?: string },
): string {
  const url = toUrl(input);
  const searchParams = new URLSearchParams();

  url.pathname = buildPathname("reader");
  searchParams.set("mode", state.mode);

  if (state.category?.trim()) {
    searchParams.set("category", state.category.trim());
  }

  if (state.itemId?.trim()) {
    searchParams.set("item", state.itemId.trim());
  }

  url.hash = searchParams.toString();
  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildUrlForSourcesCategory(input: string, category: string): string {
  return buildUrlForCategory(input, "sources", category);
}

export function buildUrlForRsshubCategory(input: string, category: string): string {
  return buildUrlForCategory(input, "rsshub", category);
}

function buildUrlForCategory(input: string, tab: "sources" | "rsshub", category: string): string {
  const url = toUrl(input);
  url.pathname = buildPathname(tab);
  url.hash = normalizeCategory(category) === ALL_SOURCES_CATEGORY ? "" : category;
  return `${url.pathname}${url.search}${url.hash}`;
}
