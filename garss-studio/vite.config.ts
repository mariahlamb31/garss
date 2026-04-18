import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.VITE_API_PROXY_TARGET || "http://backend:3001";

  return {
    plugins: [react()],
    server: {
      host: true,
      allowedHosts: true,
      watch: env.VITE_USE_POLLING
        ? {
            usePolling: true,
            interval: 120,
          }
        : undefined,
      proxy: {
        "/api": {
          target: proxyTarget,
        },
        "/socket.io": {
          target: proxyTarget,
          ws: true,
        },
      },
    },
  };
});
