import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  server: {
    port: 5173,
    // Everything the browser sends to /api is forwarded to the Node server,
    // which is the only process that ever sees the Anthropic API key.
    proxy: { "/api": "http://localhost:8787" },
  },
  plugins: [react()],
});
