#!/usr/bin/env node

import { access, copyFile, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const repoRoot = resolve(projectRoot, "..");
const entryPort = "25173";

const helpFlags = new Set(["help", "-h", "--help"]);
const actions = new Set(["start", "stop", "restart", "status", "upgrade"]);
const modes = new Set(["dev", "prod", "all"]);
const modeAliases = new Map([
  ["development", "dev"],
  ["--dev", "dev"],
  ["production", "prod"],
  ["--prod", "prod"],
  ["--all", "all"],
]);

function printUsage() {
  console.log(`Usage:
  node scripts/project.mjs start [dev|prod] [--open]
  node scripts/project.mjs stop [dev|prod|all]
  node scripts/project.mjs restart [dev|prod] [--open]
  node scripts/project.mjs upgrade [dev|prod] [--open]
  node scripts/project.mjs status [dev|prod]

Defaults:
  mode = dev

Examples:
  npm run quick:start
  npm run quick:start -- --open
  npm run quick:stop
  npm run quick:status
  npm run quick:upgrade -- --open
  npm run quick:start -- prod
  npm run quick:stop -- all`);
}

function normalizeMode(rawMode) {
  if (!rawMode) {
    return "dev";
  }
  return modeAliases.get(rawMode) ?? rawMode;
}

function parseArgs(argv) {
  const shouldOpen = argv.includes("--open");
  const filteredArgv = argv.filter((arg) => arg !== "--open");
  const [rawAction = "help", rawMode] = filteredArgv;

  if (filteredArgv.some((arg) => helpFlags.has(arg))) {
    return { action: "help", mode: "dev", shouldOpen: false };
  }

  if (!actions.has(rawAction)) {
    throw new Error(`Unsupported action: ${rawAction}`);
  }

  const mode = normalizeMode(rawMode);
  if (!modes.has(mode)) {
    throw new Error(`Unsupported mode: ${rawMode}`);
  }
  if (mode === "all" && rawAction !== "stop") {
    throw new Error("Mode 'all' is only supported by stop.");
  }
  if (shouldOpen && !["start", "restart", "upgrade"].includes(rawAction)) {
    throw new Error("--open is only supported by start, restart, and upgrade.");
  }

  return { action: rawAction, mode, shouldOpen };
}

function composePrefix(mode) {
  if (mode === "dev") {
    return ["compose", "-f", "docker-compose.dev.yml"];
  }
  return ["compose"];
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureEnvFile() {
  const envPath = resolve(projectRoot, ".env");
  const examplePath = resolve(projectRoot, ".env.example");

  if (await pathExists(envPath)) {
    return false;
  }
  if (!(await pathExists(examplePath))) {
    throw new Error("Missing .env.example; cannot create .env automatically.");
  }

  await copyFile(examplePath, envPath);
  return true;
}

async function readAccessCode() {
  const envPath = resolve(projectRoot, ".env");
  const raw = await readFile(envPath, "utf8").catch(() => "");
  const line = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#") && item.startsWith("ACCESS_CODE="));

  if (!line) {
    return "banana";
  }

  return line
    .slice("ACCESS_CODE=".length)
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        rejectPromise(new Error(options.missingMessage ?? `${command} command not found.`));
        return;
      }
      rejectPromise(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function runCommandCapture(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        rejectPromise(new Error(options.missingMessage ?? `${command} command not found.`));
        return;
      }
      rejectPromise(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const details = stderr.trim() || stdout.trim();
      rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code}${details ? `\n${details}` : ""}`));
    });
  });
}

function runDocker(args) {
  return runCommand("docker", args, {
    cwd: projectRoot,
    missingMessage: "Docker command not found. Install Docker Desktop and try again.",
  });
}

function runDockerCapture(args) {
  return runCommandCapture("docker", args, {
    cwd: projectRoot,
    missingMessage: "Docker command not found. Install Docker Desktop and try again.",
  });
}

function runGit(args) {
  return runCommand("git", args, {
    cwd: repoRoot,
    missingMessage: "Git command not found. Install Git and try again.",
  });
}

async function runCompose(mode, args) {
  await runDocker([...composePrefix(mode), ...args]);
}

async function runComposeCapture(mode, args) {
  return runDockerCapture([...composePrefix(mode), ...args]);
}

function parseComposeJson(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function getContainerState(container) {
  return String(container.State ?? container.Status ?? "").trim();
}

function isRunningState(state) {
  const normalized = state.toLowerCase();
  return normalized === "running" || normalized.startsWith("up ");
}

function getEntryUrl(accessCode) {
  const encodedAccessCode = encodeURIComponent(accessCode || "banana");
  return `http://127.0.0.1:${entryPort}/reader?pw=${encodedAccessCode}`;
}

function printEntry(accessCode) {
  const url = getEntryUrl(accessCode);
  console.log(`入口: ${url}`);
  return url;
}

function browserOpener(url) {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

function openEntry(url) {
  return new Promise((resolvePromise) => {
    const { command, args } = browserOpener(url);
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "ignore",
    });

    child.on("error", () => {
      console.log(`无法自动打开浏览器，请手动访问: ${url}`);
      resolvePromise();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.log(`无法自动打开浏览器，请手动访问: ${url}`);
      }
      resolvePromise();
    });
  });
}

async function start(mode, options = {}) {
  const createdEnv = await ensureEnvFile();
  if (createdEnv) {
    console.log("已从 .env.example 创建 .env");
  }

  await runCompose(mode, ["up", "--build", "-d"]);
  const accessCode = await readAccessCode();
  console.log(`${mode === "prod" ? "生产" : "开发"}环境已启动。`);
  const url = printEntry(accessCode);
  if (options.open) {
    await openEntry(url);
  }
}

async function stop(mode) {
  if (mode === "all") {
    await runCompose("dev", ["down"]);
    await runCompose("prod", ["down"]);
    console.log("开发和生产 compose 项目都已关闭。");
    return;
  }

  await runCompose(mode, ["down"]);
  console.log(`${mode === "prod" ? "生产" : "开发"}环境已关闭。`);
}

async function restart(mode, options = {}) {
  await stop(mode);
  await start(mode, options);
}

async function upgrade(mode, options = {}) {
  await ensureEnvFile();
  console.log("正在拉取最新代码...");
  await runGit(["-C", repoRoot, "pull", "--ff-only"]);

  console.log("正在更新 RSSHub 镜像...");
  await runCompose(mode, ["pull", "rsshub"]);

  console.log("正在重建并启动项目...");
  await start(mode, options);
  console.log("升级完成。");
}

async function status(mode) {
  const accessCode = await readAccessCode();
  const url = getEntryUrl(accessCode);
  const label = mode === "prod" ? "生产" : "开发";

  console.log(`${label}环境状态`);
  console.log(`入口: ${url}`);
  console.log("");

  try {
    const { stdout } = await runComposeCapture(mode, ["ps", "--format", "json"]);
    const containers = parseComposeJson(stdout);
    const runningCount = containers.filter((container) => isRunningState(getContainerState(container))).length;
    const totalCount = containers.length;

    if (totalCount === 0) {
      console.log("运行状态: 未运行");
    } else if (runningCount === totalCount) {
      console.log(`运行状态: 运行中 (${runningCount}/${totalCount})`);
    } else if (runningCount > 0) {
      console.log(`运行状态: 部分运行 (${runningCount}/${totalCount})`);
    } else {
      console.log(`运行状态: 未运行 (0/${totalCount})`);
    }

    if (containers.length > 0) {
      console.log("");
      console.log("容器:");
      for (const container of containers) {
        const service = container.Service ?? container.Name ?? "unknown";
        const state = getContainerState(container) || "unknown";
        console.log(`- ${service}: ${state}`);
      }
    }
  } catch (error) {
    console.log("运行状态: 无法读取 Docker Compose JSON 状态。");
    console.log(error.message);
  }

  console.log("");
  console.log("Docker Compose 明细:");
  await runCompose(mode, ["ps"]);
}

async function main() {
  const { action, mode, shouldOpen } = parseArgs(process.argv.slice(2));

  if (action === "help") {
    printUsage();
    return;
  }

  if (action === "start") {
    await start(mode, { open: shouldOpen });
    return;
  }
  if (action === "stop") {
    await stop(mode);
    return;
  }
  if (action === "restart") {
    await restart(mode, { open: shouldOpen });
    return;
  }
  if (action === "upgrade") {
    await upgrade(mode, { open: shouldOpen });
    return;
  }
  if (action === "status") {
    await status(mode);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
