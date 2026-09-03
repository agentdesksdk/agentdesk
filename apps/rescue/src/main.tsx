import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { rescue } from "./runtime.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The scripted walkthrough is not part of the application. It is loaded
// only when the URL carries `?walkthrough=1`, and it says what it is on screen.
const WALKTHROUGH_FLAG = "walkthrough=1";
if (window.location.search.split(/[?&]/).includes(WALKTHROUGH_FLAG)) {
  void import("./walkthrough.ts").then((module) => module.installWalkthrough(rescue));
}
