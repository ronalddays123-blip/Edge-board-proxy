import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Edge Board crashed:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ background: "#0A0D10", color: "#E7ECEF", minHeight: "100vh", padding: 20, fontFamily: "monospace" }}>
          <h2 style={{ color: "#FF5C5C" }}>Something broke</h2>
          <p style={{ color: "#7C8894", fontSize: 13 }}>
            Screenshot this whole message and send it back — this is exactly what was invisible before.
          </p>
          <pre style={{ whiteSpace: "pre-wrap", background: "#12171C", padding: 12, borderRadius: 6, fontSize: 12, color: "#E7ECEF", border: "1px solid #232B32" }}>
            {this.state.error.toString()}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 12, background: "#35C48C", color: "#04140D", border: "none", borderRadius: 6, padding: "8px 14px", fontWeight: 600, cursor: "pointer" }}
          >
            Try to recover
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
