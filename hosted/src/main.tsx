import { createRoot } from "react-dom/client";
import { App } from "./App";
import { takeEnrollment } from "./enrollment";
import "./index.css";

// Taken before anything renders; a later fragment change on `/enroll` is App's.
const enrollment = takeEnrollment();
createRoot(document.getElementById("root")!).render(
  <App enrollment={enrollment} />,
);
