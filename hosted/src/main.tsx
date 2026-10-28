import { createRoot } from "react-dom/client";
import { AdminMetrics, isAdminMetricsPath } from "./AdminMetrics";
import { App } from "./App";
import { takeEnrollment } from "./enrollment";
import "./index.css";

const root = createRoot(document.getElementById("root")!);
if (isAdminMetricsPath(location.pathname)) root.render(<AdminMetrics />);
else {
  // Taken before anything renders; a later fragment change on `/enroll` is App's.
  const enrollment = takeEnrollment();
  root.render(<App enrollment={enrollment} />);
}
