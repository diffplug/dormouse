import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Each Worker's static files build under `dist/<worker>/`.
  build: { outDir: "dist/account", sourcemap: false },
});
