import type { Config } from "@react-router/dev/config";
import { DOCS_PAGES } from "./src/lib/docs-pages";

export default {
  appDirectory: "src",
  buildDirectory: "dist",
  ssr: false,
  prerender() {
    return [
      "/",
      "/playground",
      "/playground/desktop",
      "/playground/pocket",
      "/pocket",
      ...DOCS_PAGES.map((page) => page.path),
    ];
  },
} satisfies Config;
