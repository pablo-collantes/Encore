// PUBLIC entry: the sign-in gate and nothing else. Everything a signed-in user
// sees is reached through the lazy import in auth/Gate.tsx.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Gate } from "./auth/Gate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gate />
  </StrictMode>,
);

// Installable PWA. The service worker caches nothing (see public/sw.js).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
