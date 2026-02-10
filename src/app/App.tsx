import React, { useEffect, useState } from "react";
import type { AnalysisInput, AnalysisResult } from "../types/analysis";
import { AnalyzePage } from "../pages/AnalyzePage";
import { ResultPage } from "../pages/ResultPage";
import { getRouteFromHash, setRouteHash, type RouteId } from "./routes";

export function App() {
  const [route, setRoute] = useState<RouteId>(() => getRouteFromHash());

  const [lastInput, setLastInput] = useState<AnalysisInput>({
    threadText: "",
    callChecks: { otpAsked: false, remoteAsked: false, urgentPressured: false },
  });

  const [lastResult, setLastResult] = useState<AnalysisResult | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(getRouteFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const goAnalyze = () => {
    setRoute("analyze");
    setRouteHash("analyze");
  };

  const goResult = (input: AnalysisInput, result: AnalysisResult) => {
    setLastInput(input);
    setLastResult(result);
    setRoute("result");
    setRouteHash("result");
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <div className="brand-title">Phish Demo</div>
          <div className="brand-sub">Thread-based rules + optional call-context signals</div>
        </div>
        <div className="header-actions">
          {route === "result" ? (
            <button className="btn" onClick={goAnalyze}>
              Back
            </button>
          ) : (
            <a className="pill" href="#analyze">
              Demo · Local
            </a>
          )}
        </div>
      </header>

      <main className="app-main">
        <div className="container">
          {route === "result" ? (
            <ResultPage
              input={lastInput}
              result={lastResult}
              onBack={goAnalyze}
              onReanalyze={(input, result) => goResult(input, result)}
            />
          ) : (
            <AnalyzePage initial={lastInput} onAnalyze={(input, result) => goResult(input, result)} />
          )}

          <footer className="app-footer">Demo only. No recording required — call context is checkbox-only.</footer>
        </div>
      </main>
    </div>
  );
}
