import React from "react";
import ReactDOM from "react-dom/client";
import EdgeBoard from "./EdgeBoard.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";

// Global safety net: React's error boundary only catches errors during
// rendering, NOT errors thrown inside event handlers (like an onClick).
// This catches everything else, bypassing React entirely, so a crash is
// always visible instead of silently blanking the page.
function showFatalError(message, stack) {
  const existing = document.getElementById("fatal-error-overlay");
  if (existing) return; // don't stack multiple overlays
  const el = document.createElement("div");
  el.id = "fatal-error-overlay";
  el.style.cssText = "position:fixed;inset:0;background:#0A0D10;color:#E7ECEF;padding:20px;font-family:monospace;z-index:99999;overflow:auto;";
  el.innerHTML = `
    <h2 style="color:#FF5C5C;">Caught a crash outside React</h2>
    <p style="color:#7C8894;font-size:13px;">Screenshot this whole message and send it back.</p>
    <pre style="white-space:pre-wrap;background:#12171C;padding:12px;border-radius:6px;font-size:12px;border:1px solid #232B32;">${(message || "").replace(/</g, "&lt;")}\n\n${(stack || "").replace(/</g, "&lt;")}</pre>
  `;
  document.body.appendChild(el);
}

window.addEventListener("error", (e) => {
  showFatalError(e.message, e.error?.stack);
});
window.addEventListener("unhandledrejection", (e) => {
  showFatalError("Unhandled promise rejection: " + (e.reason?.message || e.reason), e.reason?.stack);
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <EdgeBoard />
    </ErrorBoundary>
  </React.StrictMode>
);
