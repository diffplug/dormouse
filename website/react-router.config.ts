import { cp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "@react-router/dev/config";

const buildDirectory = "dist";

async function flattenClientBuild() {
  const clientDir = join(buildDirectory, "client");
  for (const entry of await readdir(clientDir)) {
    await cp(join(clientDir, entry), join(buildDirectory, entry), {
      force: true,
      recursive: true,
    });
  }

  await rm(clientDir, { force: true, recursive: true });
  await rm(join(buildDirectory, "server"), { force: true, recursive: true });
}

export default {
  appDirectory: "src",
  buildDirectory,
  ssr: false,
  prerender: {
    paths: ["/", "/playground", "/tether", "/changelog", "/dependencies"],
    concurrency: 4,
  },
  routeDiscovery: { mode: "initial" },
  buildEnd: flattenClientBuild,
} satisfies Config;
