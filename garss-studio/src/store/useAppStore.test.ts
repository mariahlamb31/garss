import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapAuthSession } from "./bootstrap-auth.ts";

test("bootstrap keeps a valid stored token session", async () => {
  const calls: string[] = [];
  const result = await bootstrapAuthSession({
    storedToken: "valid-token",
    accessCode: "",
    async getSession(token) {
      calls.push(`session:${token}`);
      return {
        authenticated: true,
        expiresAt: Date.now() + 60_000,
      };
    },
    async login(accessCode) {
      calls.push(`login:${accessCode}`);
      return {
        token: "unexpected-token",
        expiresAt: Date.now() + 60_000,
      };
    },
    getErrorMessage(error) {
      return error instanceof Error ? error.message : "unknown";
    },
  });

  assert.deepEqual(calls, ["session:valid-token"]);
  assert.deepEqual(result, {
    status: "authenticated",
    authToken: "valid-token",
    shouldPersistToken: false,
  });
});

test("bootstrap auto-recovers with pw when stored token is invalid", async () => {
  const calls: string[] = [];
  const result = await bootstrapAuthSession({
    storedToken: "expired-token",
    accessCode: "banana",
    async getSession(token) {
      calls.push(`session:${token}`);
      throw new Error("登录状态已失效，请重新输入提取码");
    },
    async login(accessCode) {
      calls.push(`login:${accessCode}`);
      return {
        token: "fresh-token",
        expiresAt: Date.now() + 60_000,
      };
    },
    getErrorMessage(error) {
      return error instanceof Error ? error.message : "unknown";
    },
  });

  assert.deepEqual(calls, ["session:expired-token", "login:banana"]);
  assert.deepEqual(result, {
    status: "authenticated",
    authToken: "fresh-token",
    shouldPersistToken: true,
  });
});

test("bootstrap falls back to login error when stored token is invalid and url has no pw", async () => {
  const calls: string[] = [];
  const result = await bootstrapAuthSession({
    storedToken: "expired-token",
    accessCode: "",
    async getSession(token) {
      calls.push(`session:${token}`);
      throw new Error("登录状态已失效，请重新输入提取码");
    },
    async login(accessCode) {
      calls.push(`login:${accessCode}`);
      return {
        token: "unexpected-token",
        expiresAt: Date.now() + 60_000,
      };
    },
    getErrorMessage(error) {
      return error instanceof Error ? error.message : "unknown";
    },
  });

  assert.deepEqual(calls, ["session:expired-token"]);
  assert.deepEqual(result, {
    status: "unauthenticated",
    authToken: "",
    error: "登录状态已失效，请重新输入提取码",
    shouldClearStoredToken: true,
  });
});
