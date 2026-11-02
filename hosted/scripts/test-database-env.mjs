import { inject } from "vitest";

// Runs before test imports, including pgstencil/database's module-level paths.
// Child Node processes inherit the same root; other Vitest runs get their own.
process.env.PGSTENCIL_PROJECT_ROOT = inject("pgstencilRoot");
