import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.VITE_API_PROXY_TARGET || "http://backend:3001";
  const hmrHost = env.VITE_HMR_HOST || "127.0.0.1";
  const hmrClientPort = Number(env.VITE_HMR_CLIENT_PORT || env.VITE_HMR_PORT || 25173);

  return {
    plugins: [react()],
    server: {
      host: true,
      allowedHosts: true,
      hmr: {
        host: hmrHost,
        clientPort: hmrClientPort,
      },
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
