import { useEffect } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  useLocation,
  useParams,
} from "react-router-dom";
import { resetStore } from "../data/store.ts";
import { agentdesk, contextForPath } from "../runtime/agentdesk.ts";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { ApprovalCards } from "./ApprovalCards.tsx";
import { Inspector } from "./Inspector.tsx";

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
        <Link to={`${base}/benchmark`}>
          <button>Benchmark</button>
        </Link>
        <button
          onClick={() => {
            resetStore();
            void agentdesk.reset();
          }}
        >
          Reset Demo
        </button>
      </header>
      <aside className="sidebar">
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
      <main className="main">
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
      <aside className="rail">
        <Inspector />
        <ActivityPanel />
      </aside>
      <ApprovalCards />
    </div>
  );
}
