import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The staff portal's own dev server — separate from vite.config.js (the
// customer chat) rather than a second entry point in the same project.
// OIDC's callback lands on staff-server directly (localhost:8791/auth/
// callback, never proxied — see staff-server/index.ts's header) and a
// session cookie set there is host-only ("localhost"), not port-scoped, so
// it's already present when this server's own proxied /api calls reach
// staff-server. A second independent root keeps that whole story simple.
export default defineConfig({
  root: "staff",
  server: {
    port: 5174,
    proxy: {
      "/api": "http://localhost:8791",
      "/auth": { target: "http://localhost:8791", changeOrigin: false },
    },
  },
  plugins: [react()],
});
