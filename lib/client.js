window.__ModuleLoader__.load({ id: "dsh-dujiangyan-dispatch", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/ReviewPage.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var BASE = "/plugins/dsh-dujiangyan-dispatch";
var MAX_EVENTS = 3e3;
var css = {
  page: { padding: "calc(20px + var(--dsh-frame-top-clearance, 0px)) 24px 24px", height: "100%", overflow: "auto", boxSizing: "border-box", color: "var(--dsw-alias-label-primary, inherit)", fontSize: 13 },
  h1: { fontSize: 18, fontWeight: 600, margin: "0 0 2px" },
  sub: { color: "var(--dsw-alias-label-secondary, #888)", margin: "0 0 14px" },
  tabs: { display: "flex", gap: 4, borderBottom: "1px solid var(--dsw-alias-border-l2, #8884)", marginBottom: 14, flexWrap: "wrap" },
  tab: (on) => ({ padding: "6px 12px", border: "none", background: "none", cursor: "pointer", color: "inherit", fontSize: 13, borderBottom: on ? "2px solid var(--dsw-alias-state-business-primary, #3b82f6)" : "2px solid transparent", fontWeight: on ? 600 : 400 }),
  card: { border: "1px solid var(--dsw-alias-border-l2, #8884)", borderRadius: 8, padding: 12, marginBottom: 12, background: "var(--dsw-alias-bg-layer-1, transparent)" },
  row: { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" },
  stat: { minWidth: 120 },
  statN: { fontSize: 22, fontWeight: 600 },
  muted: { color: "var(--dsw-alias-label-secondary, #888)" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l2, #8884)", color: "var(--dsw-alias-label-secondary, #888)", fontWeight: 500 },
  td: { padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-border-l1, #8882)", verticalAlign: "top", wordBreak: "break-word" },
  btn: { padding: "4px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #8886)", background: "none", color: "inherit", cursor: "pointer", fontSize: 12 },
  btnAllow: { borderColor: "var(--dsw-alias-state-success-primary, #16a34a)", color: "var(--dsw-alias-state-success-primary, #16a34a)" },
  btnDeny: { borderColor: "var(--dsw-alias-state-error-primary, #dc2626)", color: "var(--dsw-alias-state-error-primary, #dc2626)" },
  pill: (color) => ({ display: "inline-block", padding: "1px 8px", borderRadius: 999, fontSize: 11, border: `1px solid ${color}`, color }),
  code: { fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all" },
  input: { flex: 1, minWidth: 200, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #8886)", background: "transparent", color: "inherit", fontSize: 12 }
};
var C = {
  ok: "var(--dsw-alias-state-success-primary, #16a34a)",
  warn: "var(--dsw-alias-state-warn-primary, #d97706)",
  err: "var(--dsw-alias-state-error-primary, #dc2626)",
  info: "var(--dsw-alias-state-business-primary, #3b82f6)",
  mute: "var(--dsw-alias-label-secondary, #888)"
};
var statusColor = (s) => s === "done" ? C.ok : s === "error" || s === "interrupted" || s === "needs_attention" ? C.err : s === "cancelled" ? C.mute : s === "running" ? C.info : C.warn;
var kindColor = (k) => k === "deny" ? C.err : k === "escalate" ? C.warn : C.ok;
var time = (iso) => iso === void 0 ? "" : new Date(iso).toLocaleTimeString();
var short = (id) => (id ?? "").replace(/^session-/, "").slice(0, 8);
function useDujiangyan() {
  const [state, setState] = (0, import_react.useState)(void 0);
  const [error, setError] = (0, import_react.useState)(void 0);
  const events = (0, import_react.useRef)([]);
  const cursor = (0, import_react.useRef)(0);
  const inflight = (0, import_react.useRef)(false);
  const [, bump] = (0, import_react.useState)(0);
  const poll = (0, import_react.useCallback)(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const res = await fetch(`${BASE}/state?cursor=${cursor.current}`, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) throw new Error(`${res.status}`);
      const snap = await res.json();
      if (snap.truncated) events.current = [];
      if (snap.events.length > 0) {
        events.current = [...events.current, ...snap.events].slice(-MAX_EVENTS);
      }
      cursor.current = snap.cursor;
      setState(snap);
      setError(void 0);
      bump((n) => n + 1);
    } catch (err) {
      setError(String(err));
    } finally {
      inflight.current = false;
    }
  }, []);
  (0, import_react.useEffect)(() => {
    void poll();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, 2e3);
    return () => clearInterval(timer);
  }, [poll]);
  const post = (0, import_react.useCallback)(async (path, body) => {
    const res = await fetch(`${BASE}/${path}`, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    void poll();
    return { ok: res.ok, json };
  }, [poll]);
  return { state, error, events: events.current, post };
}
function ReviewPage({ t, openSession, archiveSession, unarchiveSession }) {
  const { state, error, events, post } = useDujiangyan();
  const [tab, setTab] = (0, import_react.useState)("overview");
  if (state === void 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.page, children: error !== void 0 ? `${t("loadError")}: ${error}` : t("loading") });
  }
  const pending = state.approvals.length;
  const tabs = [
    ["overview", t("tabOverview")],
    ["sessions", t("tabSessions")],
    ["gate", t("tabGate")],
    ["approvals", `${t("tabApprovals")}${pending > 0 ? ` (${pending})` : ""}`],
    ["routes", t("tabRoutes")]
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.page, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", { style: css.h1, children: t("title") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: css.sub, children: [
      t("subtitle"),
      " \xB7 v",
      state.version,
      error !== void 0 ? ` \xB7 \u26A0 ${error}` : ""
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.tabs, role: "tablist", children: tabs.map(([id, label]) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", role: "tab", "aria-selected": tab === id, style: css.tab(tab === id), onClick: () => setTab(id), children: label }, id)) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(HealthBanner, { t, health: state.health, onOpen: () => setTab("approvals") }),
    tab === "overview" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Overview, { t, state, events }),
    tab === "sessions" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Sessions, { t, state, openSession, archiveSession, unarchiveSession, post }),
    tab === "gate" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Gate, { t, state, events }),
    tab === "approvals" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Approvals, { t, state, post, openSession }),
    tab === "routes" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Routes, { t, state, events })
  ] });
}
function Overview({ t, state, events }) {
  const running = state.tasks.filter((x) => x.status === "running").length;
  const queuedTasks = state.tasks.filter((x) => x.status === "queued" || String(x.status).startsWith("waiting")).length;
  const byState = { running: 0, queued: 0, idle: 0 };
  const byCreator = /* @__PURE__ */ new Map();
  for (const s of state.sessions) {
    byState[s.state] = (byState[s.state] ?? 0) + 1;
    byCreator.set(s.createdBy ?? "?", (byCreator.get(s.createdBy ?? "?") ?? 0) + 1);
  }
  const recent = events.filter((e) => e.type === "gate/decision" || e.type.startsWith("approval/") || e.type.startsWith("route/") || e.type === "routes/probed" || e.type.startsWith("task/") && e.type !== "task/tool-call").slice(-15).reverse();
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.card, ...css.row }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.stat, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.statN, children: state.sessions.length }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.muted, children: t("dispatchedSessions") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.muted, children: [
          t("stRunning"),
          " ",
          byState.running,
          " \xB7 ",
          t("stQueued"),
          " ",
          byState.queued,
          " \xB7 ",
          t("stIdle"),
          " ",
          byState.idle
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.muted, children: [...byCreator].map(([k, v]) => `${k} ${v}`).join(" \xB7 ") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.stat, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.statN, children: running }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.muted, children: t("activeTasks") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.muted, children: [
          t("stQueued"),
          " ",
          queuedTasks
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.stat, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...css.statN, color: state.approvals.length > 0 ? C.warn : void 0 }, children: state.approvals.length }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.muted, children: t("pending") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.stat, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.statN, children: state.leases.length }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.muted, children: t("leases") })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ProvidersTable, { t, providers: state.providers }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.card, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("table", { style: css.table, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tbody", { children: [
      recent.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: t("noEvents") }) }),
      recent.map((e) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: { ...css.td, width: 80 }, children: time(e.at) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: { ...css.td, width: 140 }, children: e.type }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: describe(e) })
      ] }, e.seq))
    ] }) }) })
  ] });
}
function describe(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case "gate/decision":
      return `${d.tool} \xB7 ${d.kind} \xB7 ${d.rule}${d.reason ? ` \u2014 ${d.reason}` : ""}`;
    case "approval/pending":
      return `${d.tool} \xB7 ${d.rule} \u2014 ${d.reason}`;
    case "approval/settled":
      return `${d.tool} \u2192 ${d.result}`;
    case "route/switch":
      return `${d.from} \u2192 ${d.to} (${d.reason})`;
    case "route/broken":
      return `${d.route} \u2014 ${d.reason}`;
    case "routes/probed":
      return `${d.ok}/${d.count} ok${d.failed?.length ? ` \xB7 failed: ${d.failed.map((f) => f.route).join(", ")}` : ""} \xB7 by ${d.by}`;
    case "limits/override":
      return JSON.stringify(d);
    default:
      return [d.title, d.taskId, d.error, d.summary?.changes].filter(Boolean).join(" \xB7 ");
  }
}
function ProvidersTable({ t, providers }) {
  const names = Object.keys(providers);
  if (names.length === 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.card, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", { style: css.table, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { children: [t("provider"), t("cap"), t("inFlight"), t("queued"), t("circuit"), t("counts")].map((h) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: css.th, children: h }, h)) }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: names.map((n) => {
      const p = providers[n];
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: n }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", { style: css.td, children: [
          p.cap,
          " / ",
          p.maxConcurrent
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: p.inFlight }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: p.queued }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(p.circuit === "closed" ? C.ok : p.circuit === "open" ? C.err : C.warn), children: p.circuit }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", { style: css.td, children: [
          p.counts.ok,
          " / ",
          p.counts.rate_limited,
          " / ",
          p.counts.overloaded,
          " / ",
          p.counts.error
        ] })
      ] }, n);
    }) })
  ] }) });
}
function batchesOf(sessions, legacy) {
  const m = /* @__PURE__ */ new Map();
  for (const s of sessions) {
    const key = s.batch ?? `legacy:${s.createdBy ?? "?"}`;
    const b = m.get(key) ?? { key, label: s.batch ?? `${legacy}${s.createdBy ? ` \xB7 ${s.createdBy}` : ""}`, createdBy: s.createdBy ?? "?", sessions: [], first: s.createdAt };
    b.sessions.push(s);
    if (String(s.createdAt) < String(b.first)) b.first = s.createdAt;
    m.set(key, b);
  }
  return [...m.values()].sort((a, b) => String(b.first).localeCompare(String(a.first)));
}
function ArchiveDialog({ t, title, sessions, preselect, onCancel, onConfirm }) {
  const [checked, setChecked] = (0, import_react.useState)(() => Object.fromEntries(sessions.map((s) => [s.sessionId, preselect && s.state === "idle"])));
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(void 0);
  const ids = sessions.filter((s) => checked[s.sessionId] === true).map((s) => s.sessionId);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { role: "dialog", "aria-modal": "true", style: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1e3 }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.card, width: "min(640px, 92vw)", maxHeight: "80vh", overflow: "auto", background: "var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, #222))" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 600, fontSize: 15, marginBottom: 6 }, children: title }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...css.muted, marginBottom: 10 }, children: t("archiveWarn") }),
    sessions.map((s) => {
      const busySession = s.state !== "idle";
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { ...css.row, padding: "4px 0", opacity: busySession ? 0.55 : 1 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", disabled: busySession, checked: checked[s.sessionId] === true, onChange: (e) => setChecked({ ...checked, [s.sessionId]: e.target.checked }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: s.title ?? short(s.sessionId) }),
        s.batch !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.muted, children: s.batch }),
        busySession && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(C.warn), children: t("busyCannotArchive") })
      ] }, s.sessionId);
    }),
    error !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: C.err, marginTop: 8 }, children: error }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.row, justifyContent: "flex-end", marginTop: 12 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: css.muted, children: [
        t("selected"),
        " ",
        ids.length
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: css.btn, onClick: onCancel, disabled: busy, children: t("cancelBtn") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", style: { ...css.btn, ...css.btnDeny }, disabled: busy || ids.length === 0, onClick: async () => {
        setBusy(true);
        try {
          await onConfirm(ids);
        } catch (err) {
          setError(String(err));
          setBusy(false);
        }
      }, children: [
        t("confirmArchive"),
        " (",
        ids.length,
        ")"
      ] })
    ] })
  ] }) });
}
function Sessions({ t, state, openSession, archiveSession, unarchiveSession, post }) {
  const [showArchived, setShowArchived] = (0, import_react.useState)(false);
  const [dialog, setDialog] = (0, import_react.useState)(void 0);
  const [notice, setNotice] = (0, import_react.useState)(void 0);
  const bySession = (0, import_react.useMemo)(() => {
    const m = /* @__PURE__ */ new Map();
    for (const task of state.tasks) m.set(task.sessionId, [...m.get(task.sessionId) ?? [], task]);
    return m;
  }, [state.tasks]);
  const archivedCount = state.sessions.filter((s) => s.desktop === "archived").length;
  const visible = state.sessions.filter((s) => showArchived || s.desktop !== "archived");
  const batches = batchesOf(visible, t("legacyBatch"));
  const activeAll = state.sessions.filter((s) => s.desktop !== "archived" && s.desktop !== "missing");
  const runArchive = async (ids) => {
    for (const id of ids) await archiveSession(id);
    setDialog(void 0);
    setNotice(`${t("archivedN")} ${ids.length}`);
  };
  if (state.sessions.length === 0) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.card, children: t("noSessions") });
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.row, justifyContent: "space-between", marginBottom: 10 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: css.row, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: showArchived, onChange: (e) => setShowArchived(e.target.checked) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
          t("showArchived"),
          " (",
          archivedCount,
          ")"
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.row, children: [
        notice !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.muted, children: notice }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: { ...css.btn, ...css.btnDeny },
            disabled: activeAll.length === 0,
            onClick: () => setDialog({ title: t("archiveAllTitle"), sessions: activeAll, preselect: false }),
            children: t("archiveAll")
          }
        )
      ] })
    ] }),
    batches.map((b) => {
      const live = b.sessions.filter((s) => s.desktop !== "archived" && s.desktop !== "missing");
      const archived = b.sessions.filter((s) => s.desktop === "archived");
      const counts = { running: 0, queued: 0, idle: 0 };
      for (const s of live) counts[s.state] = (counts[s.state] ?? 0) + 1;
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.card, padding: 0 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.row, justifyContent: "space-between", padding: "10px 12px", borderBottom: "1px solid var(--dsw-alias-border-l2, #8884)" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontWeight: 600 }, children: [
              t("batch"),
              ": ",
              b.label
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.muted, children: [
              t("createdBy"),
              " ",
              b.createdBy,
              " \xB7 ",
              time(b.first),
              " \xB7 ",
              b.sessions.length,
              " \xB7 ",
              t("stRunning"),
              " ",
              counts.running,
              " \xB7 ",
              t("stQueued"),
              " ",
              counts.queued,
              " \xB7 ",
              t("stIdle"),
              " ",
              counts.idle,
              archived.length > 0 ? ` \xB7 ${t("stArchived")} ${archived.length}` : ""
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.row, children: [
            archived.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: css.btn, onClick: async () => {
              for (const s of archived) await unarchiveSession(s.sessionId);
              setNotice(`${t("restoredN")} ${archived.length}`);
            }, children: t("restoreBatch") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                style: { ...css.btn, ...css.btnDeny },
                disabled: live.length === 0,
                onClick: () => setDialog({ title: `${t("archiveBatchTitle")}: ${b.label}`, sessions: live, preselect: true }),
                children: t("archiveBatch")
              }
            )
          ] })
        ] }),
        b.sessions.map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: "10px 12px", borderBottom: "1px solid var(--dsw-alias-border-l1, #8882)", opacity: s.desktop === "archived" ? 0.6 : 1 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.row, justifyContent: "space-between" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontWeight: 600 }, children: [
                s.desktop === "archived" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(C.mute), children: t("stArchived") }) : s.desktop === "missing" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(C.err), children: t("stMissing") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(s.state === "running" ? C.info : s.state === "queued" ? C.warn : C.mute), children: s.state === "running" ? t("stRunning") : s.state === "queued" ? t("stQueued") : t("stIdle") }),
                " ",
                s.title ?? short(s.sessionId)
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.muted, children: [
                t("workspace"),
                ": ",
                s.cwd,
                " \xB7 ",
                t("route"),
                ": ",
                s.chain.map((r) => `${r.provider}/${r.model}`).join(" \u2192 "),
                " \xB7 ",
                short(s.sessionId),
                " \xB7 ",
                time(s.createdAt)
              ] }),
              (() => {
                const live2 = (bySession.get(s.sessionId) ?? []).find((x) => x.status === "running" && typeof x.latest === "string" && x.latest !== "");
                return live2 === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 4 }, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(C.info), children: t("narration") }),
                  " ",
                  live2.latest
                ] });
              })()
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.row, children: [
              s.desktop === "archived" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: css.btn, onClick: () => void unarchiveSession(s.sessionId), children: t("restore") }),
              s.desktop !== "archived" && s.desktop !== "missing" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: css.btn, onClick: () => openOrCopy(openSession, s.sessionId, () => setNotice(t("ctxOpenFailed"))), children: t("open") })
            ] })
          ] }),
          (bySession.get(s.sessionId) ?? []).slice(0, 8).map((task) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 6 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.row, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(statusColor(task.status)), children: task.status }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: task.title ?? task.prompt.slice(0, 80) }),
              task.resources.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: css.muted, children: [
                "[",
                task.resources.join(", "),
                "]"
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.muted, children: time(task.startedAt ?? task.createdAt) }),
              (task.status === "running" || task.status === "queued" || task.status.startsWith("waiting")) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: css.btn, onClick: () => void post("task-cancel", { taskId: task.id }), children: t("cancel") })
            ] }),
            task.summary !== void 0 && (task.summary.changes || task.summary.leftovers) && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.muted, marginTop: 4 }, children: [
              task.summary.changes,
              task.summary.leftovers ? ` \xB7 \u2691 ${task.summary.leftovers}` : ""
            ] }),
            (task.error || (task.errors ?? []).length > 0) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: C.err, marginTop: 4 }, children: task.error ?? task.errors.join("; ") })
          ] }, task.id))
        ] }, s.sessionId))
      ] }, b.key);
    }),
    dialog !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      ArchiveDialog,
      {
        t,
        title: dialog.title,
        sessions: dialog.sessions,
        preselect: dialog.preselect,
        onCancel: () => setDialog(void 0),
        onConfirm: runArchive
      }
    )
  ] });
}
function Gate({ t, state, events }) {
  const [filter, setFilter] = (0, import_react.useState)("all");
  const titles = (0, import_react.useMemo)(() => new Map(state.sessions.map((s) => [s.sessionId, s.title])), [state.sessions]);
  const rows = events.filter((e) => e.type === "gate/decision" && (filter === "all" || e.data.kind === filter)).slice(-300).reverse();
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.card, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...css.row, marginBottom: 8 }, children: ["all", "deny", "escalate"].map((f) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...css.btn, fontWeight: filter === f ? 600 : 400 }, onClick: () => setFilter(f), children: f === "all" ? t("filterAll") : f === "deny" ? t("filterDeny") : t("filterEscalate") }, f)) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", { style: css.table, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { children: [t("time"), t("sessions"), t("tool"), t("decision"), t("rule"), t("reason")].map((h) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: css.th, children: h }, h)) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tbody", { children: [
        rows.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, colSpan: 6, children: t("noEvents") }) }),
        rows.map((e) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: time(e.at) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: String(titles.get(e.data.root) ?? short(e.data.sessionId)) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: e.data.tool }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(kindColor(e.data.kind)), children: e.data.kind }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: e.data.rule }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: e.data.reason })
        ] }, e.seq))
      ] })
    ] })
  ] });
}
function openOrCopy(openSession, id, onFallback) {
  if (openSession(id)) return;
  void navigator.clipboard?.writeText(id).catch(() => void 0);
  onFallback();
}
function ApprovalContextView({ t, ctx }) {
  if (ctx === void 0) return null;
  const calls = ctx.recentCalls ?? [];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { open: true, style: { ...css.card, marginBottom: 6 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("summary", { style: { cursor: "pointer", fontWeight: 600 }, children: t("ctxTitle") }),
    ctx.taskTitle !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.muted, children: [
      t("ctxTask"),
      ": ",
      ctx.taskTitle,
      ctx.route !== void 0 ? ` \xB7 ${ctx.route}` : ""
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { margin: "6px 0" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("b", { children: [
        t("ctxWhy"),
        ":"
      ] }),
      " ",
      ctx.lastAssistant ?? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.muted, children: t("ctxNone") })
    ] }),
    ctx.description !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginBottom: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("b", { children: [
        t("ctxDesc"),
        ":"
      ] }),
      " ",
      ctx.description
    ] }),
    calls.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginBottom: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("b", { children: [
        t("ctxRecent"),
        ":"
      ] }),
      calls.map((c, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.code, fontSize: 12 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(c.verdict.startsWith("deny") || c.verdict.endsWith("deny") ? C.err : c.verdict === "allow" || c.verdict.endsWith("allow") ? C.ok : C.warn), children: c.verdict }),
        " ",
        c.tool,
        " ",
        c.args,
        c.decider !== void 0 ? ` (${c.decider})` : ""
      ] }, i))
    ] }),
    ctx.taskPrompt !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("summary", { style: { cursor: "pointer" }, children: t("ctxPrompt") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...css.code, whiteSpace: "pre-wrap" }, children: ctx.taskPrompt })
    ] })
  ] });
}
function HealthBanner({ t, health, onOpen }) {
  const alerts = health?.alerts ?? [];
  if (alerts.length === 0) return null;
  const critical = alerts.some((a) => a.level === "critical");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { role: "alert", style: { ...css.card, borderColor: critical ? C.err : C.warn, borderWidth: 2, borderStyle: "solid" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("b", { style: { color: critical ? C.err : C.warn }, children: [
      t("healthTitle"),
      " (",
      alerts.length,
      ")"
    ] }),
    alerts.map((a) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.muted, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(a.level === "critical" ? C.err : C.warn), children: a.kind }),
      " ",
      a.message,
      a.kind === "approval-aging" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: css.btn, onClick: onOpen, children: t("tabApprovals") })
      ] })
    ] }, a.id))
  ] });
}
var ageMinutes = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 6e4);
function Approvals({ t, state, post, openSession }) {
  const [reasons, setReasons] = (0, import_react.useState)({});
  const [notice, setNotice] = (0, import_react.useState)(void 0);
  const [busy, setBusy] = (0, import_react.useState)(void 0);
  const titles = (0, import_react.useMemo)(() => new Map(state.sessions.map((s) => [s.sessionId, s.title])), [state.sessions]);
  const aiBadge = state.aiApproval !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.card, ...css.muted }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(state.aiApproval.enabled ? C.ok : C.warn), children: t(state.aiApproval.enabled ? "aiOn" : "aiOff") }),
    " ",
    state.aiApproval.enabled ? (state.aiApproval.judges ?? []).map((j) => j.model).join(" + ") : ""
  ] });
  if (state.approvals.length === 0) return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    aiBadge,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.card, children: t("noPending") })
  ] });
  const decide = async (id, decision) => {
    setBusy(id);
    try {
      await post("approval", { id, decision, reason: reasons[id] });
    } finally {
      setBusy(void 0);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    aiBadge,
    state.approvals.map((a) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.card, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.row, justifyContent: "space-between" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(C.warn), children: a.rule }),
          " ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: a.tool }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: css.muted, children: [
            " \xB7 ",
            String(titles.get(a.sessionId) ?? short(a.sessionId)),
            " \xB7 ",
            t("expiresAt"),
            " ",
            time(a.expiresAt)
          ] }),
          " ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: css.pill(ageMinutes(a.createdAt) >= 3 ? C.err : C.mute), children: [
            t("waited"),
            " ",
            ageMinutes(a.createdAt),
            " ",
            t("minutes")
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: css.btn, onClick: () => openOrCopy(openSession, a.sessionId, () => setNotice(t("ctxOpenFailed"))), children: t("open") })
      ] }),
      notice !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.muted, children: notice }),
      a.danger !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { role: "alert", style: { ...css.pill(C.err), margin: "6px 0" }, children: t("dangerSandbox") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { margin: "6px 0" }, children: a.reason }),
      a.truncated === true && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...css.pill(C.warn), marginBottom: 6 }, children: t("truncated") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ApprovalContextView, { t, ctx: a.context }),
      a.ai !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.card, marginBottom: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: t(a.ai.status === "judging" ? "aiJudging" : "aiSplit") }),
        (a.ai.opinions ?? []).map((o) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.muted, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: css.pill(o.decision === "allow" ? C.ok : o.decision === "deny" ? C.err : C.warn), children: o.decision }),
          " ",
          o.judge,
          ": ",
          o.reason
        ] }, o.judge))
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...css.code, ...css.card, marginBottom: 8, maxHeight: 360, overflow: "auto" }, children: a.summary }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.row, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: css.input, placeholder: t("reasonPlaceholder"), value: reasons[a.id] ?? "", onChange: (e) => setReasons({ ...reasons, [a.id]: e.target.value }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy === a.id, style: { ...css.btn, ...css.btnAllow }, onClick: () => void decide(a.id, "allow"), children: t("allow") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy === a.id, style: { ...css.btn, ...css.btnDeny }, onClick: () => void decide(a.id, "deny"), children: t("deny") })
      ] })
    ] }, a.id))
  ] });
}
function Routes({ t, state, events }) {
  const broken = Object.entries(state.routeHealth?.broken ?? {});
  const probes = events.filter((e) => e.type === "routes/probed").slice(-50).reverse();
  const routeEvents = events.filter((e) => e.type === "route/switch" || e.type === "route/broken" || e.type === "limits/override").slice(-100).reverse();
  const usage = Object.entries(state.usage ?? {});
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ProvidersTable, { t, providers: state.providers }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.card, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 600, marginBottom: 6 }, children: t("broken") }),
      broken.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.muted, children: t("noEvents") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("table", { style: css.table, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: broken.map(([route, b]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: route }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: b.reason }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", { style: css.td, children: [
          t("until"),
          " ",
          time(b.until)
        ] })
      ] }, route)) }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.card, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 600, marginBottom: 6 }, children: t("probes") }),
      probes.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.muted, children: t("noEvents") }) : probes.map((p) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginBottom: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          time(p.at),
          " \xB7 ",
          p.data.ok,
          "/",
          p.data.count,
          " ok \xB7 by ",
          p.data.by
        ] }),
        (p.data.failed ?? []).map((f) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...css.code, color: C.err }, children: [
          f.route,
          " \u2014 ",
          f.detail
        ] }, f.route))
      ] }, p.seq))
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.card, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 600, marginBottom: 6 }, children: t("routeEvents") }),
      routeEvents.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: css.muted, children: t("noEvents") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("table", { style: css.table, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: routeEvents.map((e) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: { ...css.td, width: 80 }, children: time(e.at) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: { ...css.td, width: 120 }, children: e.type }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: describe(e) })
      ] }, e.seq)) }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: css.card, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 600, marginBottom: 6 }, children: t("usage") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", { style: css.table, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { children: [t("route"), t("requests"), t("tokensIn"), t("tokensOut"), t("cacheHit")].map((h) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: css.th, children: h }, h)) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: usage.map(([route, u]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: route }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: u.requests }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: u.inputTokens }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: u.outputTokens }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: css.td, children: u.cacheHitRate === null ? "\u2014" : `${Math.round(u.cacheHitRate * 100)}%` })
        ] }, route)) })
      ] })
    ] })
  ] });
}

// src/client/locales.ts
var zh = {
  panel: "\u90FD\u6C5F\u5830",
  title: "\u90FD\u6C5F\u5830 \xB7 Agent \u8C03\u5EA6\u4E0E\u5B88\u95E8",
  subtitle: "\u6D3E\u53D1\u7684\u4F1A\u8BDD\u3001\u95F8\u95E8\u51B3\u5B9A\u3001\u5BA1\u6279\u4E0E\u6E20\u9053\u5065\u5EB7",
  tabOverview: "\u6982\u89C8",
  tabSessions: "\u4F1A\u8BDD\u4E0E\u4EFB\u52A1",
  tabGate: "\u95F8\u95E8\u8BB0\u5F55",
  tabApprovals: "\u5F85\u5BA1\u6279",
  tabRoutes: "\u6E20\u9053\u4E0E\u63A2\u6D4B",
  loading: "\u52A0\u8F7D\u4E2D\u2026",
  loadError: "\u65E0\u6CD5\u8BFB\u53D6\u90FD\u6C5F\u5830\u72B6\u6001",
  sessions: "\u4F1A\u8BDD",
  dispatchedSessions: "\u5DF2\u6D3E\u53D1\u7684\u4F1A\u8BDD\uFF08\u542B\u7A7A\u95F2\uFF09",
  stRunning: "\u8FD0\u884C\u4E2D",
  stQueued: "\u6392\u961F",
  stIdle: "\u7A7A\u95F2",
  workspace: "\u5DE5\u4F5C\u533A",
  batch: "\u6279\u6B21",
  legacyBatch: "\u672A\u5206\u6279\uFF08\u65E7\u4F1A\u8BDD\uFF09",
  stArchived: "\u5DF2\u5F52\u6863",
  stMissing: "\u4E0D\u53EF\u7528",
  showArchived: "\u663E\u793A\u5DF2\u5F52\u6863",
  archiveBatch: "\u5F52\u6863\u672C\u6279\u2026",
  archiveAll: "\u5168\u90E8\u5F52\u6863\u2026",
  archiveBatchTitle: "\u5F52\u6863\u8FD9\u4E00\u6279\u4F1A\u8BDD",
  archiveAllTitle: "\u5F52\u6863\u4F1A\u8BDD\uFF08\u5168\u90E8\u6279\u6B21\uFF09\u2014\u2014\u8BF7\u9010\u4E2A\u52FE\u9009",
  archiveWarn: "\u5F52\u6863\u540E\uFF0C\u8FD9\u4E9B\u4F1A\u8BDD\u4F1A\u4ECE\u684C\u9762\u7248\u4FA7\u8FB9\u680F\u9690\u85CF\uFF0C\u4E5F\u4E0D\u518D\u63A5\u6536\u65B0\u4EFB\u52A1\uFF1B\u5BF9\u8BDD\u8BB0\u5F55\u4E0D\u4F1A\u5220\u9664\uFF0C\u53EF\u4EE5\u968F\u65F6\u5728\u8FD9\u91CC\u6216\u4FA7\u8FB9\u680F\u7684\u201C\u5DF2\u5F52\u6863\u201D\u5217\u8868\u4E2D\u6062\u590D\u3002\u6B63\u5728\u8FD0\u884C\u6216\u6392\u961F\u7684\u4F1A\u8BDD\u4E0D\u80FD\u5F52\u6863\u3002",
  busyCannotArchive: "\u8FD0\u884C\u4E2D\uFF0C\u4E0D\u80FD\u5F52\u6863",
  selected: "\u5DF2\u9009",
  cancelBtn: "\u53D6\u6D88",
  confirmArchive: "\u786E\u8BA4\u5F52\u6863",
  archivedN: "\u5DF2\u5F52\u6863",
  restoredN: "\u5DF2\u6062\u590D",
  restore: "\u6062\u590D",
  restoreBatch: "\u6062\u590D\u672C\u6279",
  activeTasks: "\u8FD0\u884C\u4E2D\u4EFB\u52A1",
  pending: "\u5F85\u5BA1\u6279",
  leases: "\u72EC\u5360\u9501",
  unlimited: "\u4E0D\u9650",
  open: "\u6253\u5F00\u4F1A\u8BDD",
  cancel: "\u53D6\u6D88\u4EFB\u52A1",
  allow: "\u6279\u51C6",
  deny: "\u62D2\u7EDD",
  reasonPlaceholder: "\u7406\u7531\uFF08\u53EF\u9009\uFF0C\u62D2\u7EDD\u65F6\u5EFA\u8BAE\u5199\u6E05\u695A\u8BA9 agent \u600E\u4E48\u6539\uFF09",
  noPending: "\u6CA1\u6709\u5F85\u5BA1\u6279\u7684\u8C03\u7528",
  healthTitle: "\u9700\u8981\u6CE8\u610F",
  waited: "\u5DF2\u7B49\u5F85",
  minutes: "\u5206\u949F",
  dangerSandbox: "\u5371\u9669\uFF1A\u6279\u51C6\u4F1A\u8BA9\u8FD9\u4E2A\u8C03\u7528\u5728\u6C99\u7BB1\u4E4B\u5916\u6267\u884C",
  aiDegraded: "AI \u5BA1\u6279\u5931\u6548\uFF0C\u6240\u6709\u5347\u7EA7\u90FD\u9700\u8981\u4EBA\u6765\u6279",
  noSessions: "\u8FD8\u6CA1\u6709\u6D3E\u53D1\u7684\u4F1A\u8BDD",
  noEvents: "\u6682\u65E0\u8BB0\u5F55",
  provider: "\u6E20\u9053",
  cap: "\u5E76\u53D1\u4E0A\u9650",
  inFlight: "\u5728\u9014",
  queued: "\u6392\u961F",
  circuit: "\u7194\u65AD",
  counts: "\u6210\u529F / \u9650\u6D41 / \u8FC7\u8F7D / \u9519\u8BEF",
  broken: "\u5DF2\u505C\u7528\u7684\u8DEF\u7531",
  probes: "\u63A2\u6D4B\u8BB0\u5F55",
  routeEvents: "\u8DEF\u7531\u5207\u6362\u4E0E\u9650\u6D41\u8C03\u6574",
  usage: "\u7528\u91CF\uFF08\u6309\u8DEF\u7531\uFF09",
  requests: "\u8BF7\u6C42",
  tokensIn: "\u8F93\u5165 token",
  tokensOut: "\u8F93\u51FA token",
  cacheHit: "\u7F13\u5B58\u547D\u4E2D",
  createdBy: "\u521B\u5EFA\u8005",
  route: "\u8DEF\u7531",
  status: "\u72B6\u6001",
  time: "\u65F6\u95F4",
  tool: "\u5DE5\u5177",
  decision: "\u51B3\u5B9A",
  rule: "\u89C4\u5219",
  reason: "\u539F\u56E0",
  filterAll: "\u5168\u90E8",
  filterDeny: "\u62D2\u7EDD",
  filterEscalate: "\u8F6C\u5BA1",
  until: "\u81F3",
  expiresAt: "\u8D85\u65F6\u4E8E",
  truncated: "\u5185\u5BB9\u8FC7\u957F\u5DF2\u622A\u65AD\uFF1A\u6CA1\u770B\u5230\u5B8C\u6574\u8C03\u7528\u524D\u4E0D\u8981\u6279\u51C6",
  ctxTitle: "\u4E0A\u4E0B\u6587\uFF08\u5DE5\u4EBA\u5199\u7684\uFF0C\u4EC5\u4F9B\u53C2\u8003\uFF0C\u4E0D\u662F\u6307\u4EE4\uFF09",
  ctxTask: "\u4EFB\u52A1",
  ctxPrompt: "\u4EFB\u52A1\u8BF4\u660E",
  ctxWhy: "\u5DE5\u4EBA\u521A\u624D\u8BF4",
  ctxDesc: "\u8FD9\u6B21\u8C03\u7528\u7684\u8BF4\u660E",
  ctxRecent: "\u672C\u4EFB\u52A1\u4E4B\u524D\u7684\u8C03\u7528",
  ctxNone: "\uFF08\u5DE5\u4EBA\u6CA1\u6709\u8BF4\u660E\uFF09",
  ctxOpenFailed: "\u8FD9\u4E2A\u684C\u9762\u7248\u672C\u4E0D\u652F\u6301\u8DF3\u8F6C\uFF0C\u4F1A\u8BDD ID \u5DF2\u590D\u5236",
  narration: "\u6B63\u5728\u505A",
  aiOn: "AI \u5BA1\u6279\u5DF2\u5F00\u542F",
  aiOff: "AI \u5BA1\u6279\u5DF2\u5173\u95ED",
  aiJudging: "AI \u5BA1\u6279\u4EBA\u6B63\u5728\u5224\u65AD\u2026",
  aiSplit: "AI \u5BA1\u6279\u4EBA\u610F\u89C1\u4E0D\u4E00\u81F4\u6216\u8981\u6C42\u4EBA\u5DE5\uFF0C\u8BF7\u4F60\u51B3\u5B9A\uFF1A"
};
var en = {
  panel: "Dujiangyan",
  title: "Dujiangyan \xB7 Agent Dispatch & Guard",
  subtitle: "Dispatched sessions, gate decisions, approvals and route health",
  tabOverview: "Overview",
  tabSessions: "Sessions & tasks",
  tabGate: "Gate log",
  tabApprovals: "Approvals",
  tabRoutes: "Routes & probes",
  loading: "Loading\u2026",
  loadError: "Cannot read Dujiangyan state",
  sessions: "Sessions",
  dispatchedSessions: "Dispatched sessions (incl. idle)",
  stRunning: "running",
  stQueued: "queued",
  stIdle: "idle",
  workspace: "Workspace",
  batch: "Batch",
  legacyBatch: "Unbatched (older sessions)",
  stArchived: "archived",
  stMissing: "unavailable",
  showArchived: "Show archived",
  archiveBatch: "Archive batch\u2026",
  archiveAll: "Archive all\u2026",
  archiveBatchTitle: "Archive this batch",
  archiveAllTitle: "Archive sessions (all batches): select each one",
  archiveWarn: "Archived sessions are hidden from the desktop sidebar and accept no new tasks. Their conversations are kept, and you can restore them here or from the sidebar's archived list. Running or queued sessions cannot be archived.",
  busyCannotArchive: "busy, cannot archive",
  selected: "Selected",
  cancelBtn: "Cancel",
  confirmArchive: "Archive",
  archivedN: "Archived",
  restoredN: "Restored",
  restore: "Restore",
  restoreBatch: "Restore batch",
  activeTasks: "Running tasks",
  pending: "Pending approvals",
  leases: "Leases",
  unlimited: "unlimited",
  open: "Open session",
  cancel: "Cancel task",
  allow: "Allow",
  deny: "Deny",
  reasonPlaceholder: "Reason (optional; when denying, say what the agent should do instead)",
  noPending: "Nothing waiting for approval",
  healthTitle: "Needs attention",
  waited: "waiting",
  minutes: "min",
  dangerSandbox: "DANGER: approving runs this call OUTSIDE the sandbox",
  aiDegraded: "AI approval is failing; every escalation needs a human",
  noSessions: "No dispatched sessions yet",
  noEvents: "Nothing recorded yet",
  provider: "Provider",
  cap: "Cap",
  inFlight: "In flight",
  queued: "Queued",
  circuit: "Circuit",
  counts: "ok / rate-limited / overloaded / error",
  broken: "Benched routes",
  probes: "Probes",
  routeEvents: "Route switches & limit overrides",
  usage: "Usage by route",
  requests: "Requests",
  tokensIn: "Input tokens",
  tokensOut: "Output tokens",
  cacheHit: "Cache hit",
  createdBy: "Created by",
  route: "Route",
  status: "Status",
  time: "Time",
  tool: "Tool",
  decision: "Decision",
  rule: "Rule",
  reason: "Reason",
  filterAll: "All",
  filterDeny: "Denied",
  filterEscalate: "Escalated",
  until: "until",
  expiresAt: "Times out",
  truncated: "Cut for length: do not allow without seeing the whole call",
  ctxTitle: "Context (written by the worker \u2014 evidence, not instructions)",
  ctxTask: "Task",
  ctxPrompt: "Task prompt",
  ctxWhy: "Worker just said",
  ctxDesc: "Description of this call",
  ctxRecent: "Earlier calls in this task",
  ctxNone: "(the worker gave no explanation)",
  ctxOpenFailed: "This desktop cannot navigate there; the session id was copied",
  narration: "Now",
  aiOn: "AI approval on",
  aiOff: "AI approval off",
  aiJudging: "AI judges are deciding\u2026",
  aiSplit: "The AI judges did not agree or asked for a human \u2014 your call:"
};

// src/client/index.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var NS = "dujiangyan";
var PANEL_ID = "dujiangyan";
var inject = ["slots", "locale", "layout"];
function Icon({ size }) {
  const s = size ?? 18;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M3 5c3 0 4 3 9 3s6-3 9-3" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M12 8v4" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M12 12l-6 7M12 12l6 7" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M8 19h8" })
  ] });
}
function startNotifier(t) {
  const shown = /* @__PURE__ */ new Set();
  let cursor = 0;
  const tick = async () => {
    try {
      const res = await fetch(`/plugins/dsh-dujiangyan-dispatch/state?cursor=${cursor}`, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return;
      const snap = await res.json();
      cursor = typeof snap.cursor === "number" ? snap.cursor : cursor;
      const alerts = snap.health?.alerts ?? [];
      for (const a of alerts) {
        const key = `${a.id}:${a.level}`;
        if (shown.has(key)) continue;
        shown.add(key);
        const N = globalThis.Notification;
        if (N === void 0) continue;
        if (N.permission === "default") await N.requestPermission?.();
        if (N.permission === "granted") new N(`${t("panel")} \xB7 ${t("healthTitle")}`, { body: a.message, tag: a.id });
      }
    } catch {
    }
  };
  const timer = setInterval(() => void tick(), 15e3);
  return () => clearInterval(timer);
}
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dujiangyan: dictionaries");
  ctx.effect(() => startNotifier((key) => ctx.locale.bind(NS)(key)), "dujiangyan: desktop notifications");
  const t = ctx.locale.bind(NS);
  const openSession = (id) => {
    const ws = ctx.get?.("uiWorkspace");
    if (ws?.openSession !== void 0) {
      ws.openSession(id);
      return true;
    }
    const sessions = ctx.get?.("sessions");
    if (sessions?.open !== void 0) {
      sessions.open(id);
      ctx.layout?.selectPanel?.(null);
      return true;
    }
    return false;
  };
  const workspaces = () => ctx.get?.("uiWorkspace") ?? ctx.get?.("workspaces");
  const archiveSession = async (id) => {
    const ws = workspaces();
    if (ws?.archiveSession === void 0) throw new Error("archive is unavailable in this desktop version");
    await ws.archiveSession(id);
  };
  const unarchiveSession = async (id) => {
    const ws = workspaces();
    if (ws?.unarchiveSession === void 0) throw new Error("unarchive is unavailable in this desktop version");
    await ws.unarchiveSession(id);
  };
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ openSession, archiveSession, unarchiveSession })
  }, ReviewPage));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: 40,
    locale: NS,
    label: () => t("panel")
  }, Icon));
}

return module.exports;
} });
