import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  useLocation,
  useParams,
} from "react-router-dom";
import { agentdesk, contextForPath, resetDemo } from "../runtime/agentdesk.ts";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { AgentPresence, type PresenceMode } from "./AgentPresence.tsx";
import { ApprovalCards } from "./ApprovalCards.tsx";
import { Inspector } from "./Inspector.tsx";

const PRESENCE_KEY = "agentdesk-presence-mode";

function initialPresence(): PresenceMode {
  return localStorage.getItem(PRESENCE_KEY) === "fast" ? "fast" : "guided";
}

const NAV = [
  ["", "Overview"],
  ["customers", "Customers"],
  ["orders", "Orders"],
  ["inventory", "Inventory"],
  ["shipping", "Shipping"],
  ["billing", "Billing"],
  ["support", "Support"],
  ["reports", "Reports"],
] as const;

export function AppShell() {
  const { mode } = useParams();
  const location = useLocation();
  const [presence, setPresence] = useState<PresenceMode>(initialPresence);

  const validMode = mode === "agentdesk" || mode === "baseline";

  useEffect(() => {
    if (!validMode) {
      return;
    }
    const { exposure, context } = contextForPath(location.pathname);
    void agentdesk.setExposure(exposure);
    void agentdesk.setContext(context);
  }, [location.pathname, validMode]);

  if (!validMode) {
    return <Navigate to="/agentdesk" replace />;
  }

  const base = `/${mode}`;
  const otherMode = mode === "baseline" ? "agentdesk" : "baseline";
  const restSuffix = location.pathname.slice(base.length);

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="topbar">
        <div className="brand">
          Meridian Ops
          <small>powered by AgentDesk</small>
        </div>
        <div className="mode-switch" aria-label="Runtime mode">
          <Link
            to={`/agentdesk${restSuffix}`}
            className={mode === "agentdesk" ? "active" : ""}
          >
            AgentDesk
          </Link>
          <Link
            to={`/baseline${restSuffix}`}
            className={mode === "baseline" ? "active" : ""}
          >
            Baseline
          </Link>
        </div>
        <div className="spacer" />
        <button
          title="Guided mode navigates, scrolls, and narrates what the agent is acting on. Execution is identical in both modes."
          onClick={() => {
            const next: PresenceMode = presence === "guided" ? "fast" : "guided";
            setPresence(next);
            localStorage.setItem(PRESENCE_KEY, next);
          }}
        >
          Presence: {presence}
        </button>
        <Link to={`${base}/benchmark`}>
          <button>Benchmark</button>
        </Link>
        <button
          onClick={() => {
            void resetDemo();
          }}
        >
          Reset Demo
        </button>
      </header>
      <aside className="sidebar" aria-label="Sections">
        <nav>
          {NAV.map(([path, label]) => (
            <NavLink
              key={label}
              to={path === "" ? base : `${base}/${path}`}
              end={path === ""}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              {label}
            </NavLink>
          ))}
          <div className="section-label">Experiment</div>
          <NavLink
            to={`${base}/benchmark`}
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            Benchmark
          </NavLink>
        </nav>
      </aside>
      <main className="main" id="main-content" tabIndex={-1}>
        <AgentPresence mode={presence} />
        {mode === "baseline" ? (
          <div className="banner-baseline">
            <strong>BASELINE / CONTROL MODE</strong>
            This mode intentionally publishes the application capability
            catalog as a flat WebMCP tool surface for comparison with
            AgentDesk. Same capabilities, same handlers, different exposure
            strategy. Hint: switch to the other mode with {" "}
            <Link to={`/${otherMode}${restSuffix}`}>one click</Link>.
          </div>
        ) : null}
        <Outlet />
      </main>
      <aside className="rail" aria-label="AgentDesk activity and receipts">
        <Inspector />
        <ActivityPanel />
      </aside>
      <ApprovalCards />
    </div>
  );
}
