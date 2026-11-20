import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import SpaceMathApp from "./SpaceMathApp";
import { initPwa } from "./pwa";

initPwa();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SpaceMathApp />
  </StrictMode>,
);
