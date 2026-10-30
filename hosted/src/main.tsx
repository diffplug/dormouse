import { createRoot } from "react-dom/client";
import { AdminMetrics, isAdminMetricsPath } from "./AdminMetrics";
import { App } from "./App";
import { takeCheckout, takeConfirmation } from "./billing";
import { takeEnrollment } from "./enrollment";
import "./index.css";

const root = createRoot(document.getElementById("root")!);
if (isAdminMetricsPath(location.pathname)) root.render(<AdminMetrics />);
else {
  // Taken before anything renders; a later fragment change on `/enroll` is App's.
  const enrollment = takeEnrollment();
  const confirming = takeConfirmation();
  const checkout = enrollment ? null : takeCheckout();
  root.render(<App enrollment={enrollment} checkout={checkout} confirming={confirming} />);
}
