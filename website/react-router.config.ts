import type { Config } from "@react-router/dev/config";

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
      "/changelog",
      "/docs/dor",
      "/docs/agent-skill",
      "/docs/self-host",
      "/supply-chain",
    ];
  },
} satisfies Config;
