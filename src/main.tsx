import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import App from "./App";
import { useSceneStore } from "./store/sceneStore";

if (import.meta.env.DEV) {
  // Test/debug handle (e2e reads the scene through it); stripped from prod builds.
  (window as unknown as { __dstance: unknown }).__dstance = {
    store: useSceneStore,
    scene: () => useSceneStore.getState().root,
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
