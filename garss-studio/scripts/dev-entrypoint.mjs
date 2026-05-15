#!/usr/bin/env node

import { readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";

async function hasInstalledNodeModules() {
  try {
    const stats = await stat("node_modules");
    if (!stats.isDirectory()) {
      return false;
    }
    const entries = await readdir("node_modules");
    return entries.length > 0;
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: "inherit",
    });
    const signalHandlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
      const handler = () => {
        if (!child.killed) {
          child.kill(signal);
        }
      };
      process.once(signal, handler);
      return { signal, handler };
    });

    child.on("error", (error) => {
      for (const item of signalHandlers) {
        process.removeListener(item.signal, item.handler);
      }
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      for (const item of signalHandlers) {
        process.removeListener(item.signal, item.handler);
      }
      if (signal) {
        resolvePromise(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    throw new Error("Missing command for dev entrypoint.");
  }

  if (!(await hasInstalledNodeModules())) {
    const installCode = await run("npm", ["ci"]);
    if (installCode !== 0) {
      process.exitCode = installCode;
      return;
    }
  }

  process.exitCode = await run(command, args);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
