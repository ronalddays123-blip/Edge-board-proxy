import React from "react";
import ReactDOM from "react-dom/client";
import EdgeBoard from "./EdgeBoard.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <EdgeBoard />
    </ErrorBoundary>
  </React.StrictMode>
);
