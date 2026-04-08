import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3688",
        changeOrigin: true
      },
      "/auth": {
        target: "http://127.0.0.1:3688",
        changeOrigin: true
      },
      "/admin": {
        target: "http://127.0.0.1:3688",
        changeOrigin: true
      }
    }
  }
});
