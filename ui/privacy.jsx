// privacy.jsx — Settings → Privacy: the offline lock and the record of
// every connection Ekorbia has made to anything other than this Mac.
//
// The numbers and rows come from Rust (src-tauri/src/net.rs), which is the
// one gate every outbound connection passes through; this pane only shows
// them. It re-reads when Rust says the record changed (`privacy:changed`).
//
// What it can and cannot speak for is stated at the foot, and must stay:
// it lists what Ekorbia did, not other apps, macOS, or a separate Ollama.
//
// Depends on: tokens (T, ek* styles), atoms (EkToggle), icons, utils (net*).

'use strict';

// Words for where chats are answered, used on the saved report.
function privacyAnswersWith(backendKind, baseUrl) {
  if (backendKind === "engine") return "The built-in engine, on this Mac";
  const local = isLocalEndpoint(backendKind, baseUrl);
  if (backendKind === "ollama") {
    return local ? "Ollama, on this Mac" : "Ollama on another machine";
  }
  if (local) return "A server on this Mac";
  const p = privacyStatus(backendKind, baseUrl, false);
  return p.host ? `A server on another machine: ${p.host}` : "A server on another machine";
}

//   backendKind, baseUrl   which engine answers (for the notes and the report)
//   nameOfModel(id)        → { name, detail } — plain names for downloads
//   modelLabels            { id: "Balanced · Gemma 4 12B" } for the report
function PrivacySettings({ backendKind = "engine", baseUrl = null, nameOfModel, modelLabels = {} }) {
  const invoke = getInvoke();
  const dialogApi = getDialogApi();
  const [status, setStatus] = useState(null); // { locked, lockedSince, summary }
  const [rows, setRows] = useState(null); // null = not read yet
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(null); // { ok, msg }

  const load = async () => {
    if (!invoke) return;
    try {
      const [s, r] = await Promise.all([invoke("privacy_status"), invoke("privacy_log", { limit: 200 })]);
      setStatus(s || null);
      setRows(Array.isArray(r) ? r : []);
    } catch (e) {
      setNote({ ok: false, msg: `Could not read the record: ${e}` });
      setRows([]);
    }
  };

  useEffect(() => {
    load();
    // Rust emits this whenever a connection is recorded or the lock moves.
    const events = typeof getEventApi === "function" ? getEventApi() : null;
    let unlisten = null;
    let gone = false;
    if (events && events.listen) {
      events
        .listen("privacy:changed", () => load())
        .then((u) => {
          if (gone) u();
          else unlisten = u;
        })
        .catch(() => {});
    }
    return () => {
      gone = true;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const locked = !!(status && status.locked);
  const summary = (status && status.summary) || {};

  const setLock = async (on) => {
    if (!invoke || busy) return;
    setBusy(true);
    setNote(null);
    try {
      setStatus(await invoke("privacy_set_lock", { on }));
    } catch (e) {
      setNote({ ok: false, msg: `Could not change the lock: ${e}` });
    }
    setBusy(false);
  };

  const saveReport = async () => {
    if (!invoke || !dialogApi || saving) return;
    setNote(null);
    let path = null;
    try {
      const d = new Date();
      const two = (n) => String(n).padStart(2, "0");
      path = await dialogApi.save({
        title: "Save the privacy report",
        defaultPath: `Ekorbia privacy report ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}.html`,
        filters: [{ name: "Web page", extensions: ["html"] }],
      });
    } catch (e) {
      setNote({ ok: false, msg: String(e) });
      return;
    }
    if (!path) return;
    setSaving(true);
    try {
      await invoke("privacy_report_save", {
        path,
        labels: modelLabels,
        answersWith: privacyAnswersWith(backendKind, baseUrl),
      });
      setNote({ ok: true, msg: `Saved to ${path}` });
    } catch (e) {
      setNote({ ok: false, msg: `Could not save the report: ${e}` });
    }
    setSaving(false);
  };

  const remoteServer = !isLocalEndpoint(backendKind, baseUrl);
  const sentOff = netSentOffWords(summary);
  const resultColor = (r) =>
    r === "refused" ? T.amber : r === "failed" ? T.red : r === "verified" ? T.green : T.fg1;

  return (
    <div data-privacy-settings data-locked={locked ? "true" : "false"} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontFamily: T.sans, fontSize: 17, fontWeight: 600, color: T.fg }}>Privacy</div>

      {/* ── The lock ── */}
      <div
        data-privacy-lock
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 14,
          padding: "12px 14px",
          border: `1px solid ${locked ? T.fg : T.border}`,
          boxShadow: locked ? `0 0 0 1px ${T.fg}` : "none",
          borderRadius: 10,
          background: T.isLight ? T.bg0 : T.bg2,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div id="ek-privacy-lock-label" style={{ fontFamily: T.sans, fontSize: 13.5, fontWeight: 600, color: T.fg }}>
            Offline lock
          </div>
          <div data-privacy-lock-state style={ekHint({ marginTop: 2 })}>
            {locked
              ? `On${status && status.lockedSince ? ` since ${netWhen(status.lockedSince)}` : ""}. Ekorbia refuses every connection until you turn this off.`
              : "Off. Ekorbia connects only when you ask for something that needs it, such as downloading a model."}
          </div>
          {locked && remoteServer && (
            <div data-privacy-lock-server style={ekHint({ marginTop: 6, color: T.amber })}>
              Chats are set to use a server on another machine, so they will be refused while the lock is on.
            </div>
          )}
        </div>
        <EkToggle value={locked} onChange={setLock} label="Offline lock" testId="offline-lock" disabled={busy || !status} />
      </div>

      {/* ── The headline ── */}
      <div data-privacy-headline style={{ fontFamily: T.sans, fontSize: 13, color: T.fg }}>
        Chats, documents and dictation sent off this Mac:{" "}
        <b data-privacy-sent-off style={{ fontWeight: 600, color: sentOff === "none" ? T.green : T.amber }}>
          {sentOff}
        </b>
      </div>

      {/* ── The record ── */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <div style={ekHeading()}>Connections</div>
          <div data-privacy-counts style={ekHint()}>
            {netCountsWords(summary)}
          </div>
          <span style={{ flex: 1 }} />
          <button
            data-privacy-save-report
            onClick={saveReport}
            disabled={saving || !status}
            style={ekBtn("secondary", { small: true, disabled: saving || !status })}
          >
            {saving ? "Saving…" : "Save report…"}
          </button>
        </div>
        {note && (
          <div data-privacy-note style={ekHint({ marginBottom: 6, color: note.ok ? T.fg1 : T.red, overflowWrap: "anywhere" })}>
            {note.msg}
          </div>
        )}
        <div data-privacy-rows style={{ display: "flex", flexDirection: "column" }}>
          {rows !== null && rows.length === 0 && (
            <div data-privacy-empty style={ekHint({ padding: "10px 0" })}>
              Ekorbia has not connected to anything other than this Mac.
            </div>
          )}
          {(rows || []).map((r, i) => (
            <div
              key={`${r.day}|${r.purpose}|${r.detail}|${r.host}|${r.result}`}
              data-privacy-row
              data-result={r.result}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 0",
                borderTop: i === 0 ? "none" : `1px solid ${T.border}`,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  data-privacy-row-title
                  style={{
                    fontFamily: T.sans,
                    fontSize: 13,
                    fontWeight: 500,
                    color: T.fg,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {netRowTitle(r, nameOfModel)}
                </div>
                <div data-privacy-row-where style={ekHint({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>
                  {r.host} · {netWhen(r.lastAt)}
                </div>
              </div>
              <span
                data-privacy-row-result
                style={{ fontFamily: T.sans, fontSize: 12, fontWeight: 500, color: resultColor(r.result), flexShrink: 0 }}
              >
                {netResultWords(r.result)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div data-privacy-limits style={{ ...ekHint(), borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
        This lists what Ekorbia did. It cannot see other apps or macOS.
        {backendKind === "ollama" && (
          <span data-privacy-ollama-note>
            {" "}Ollama is a separate app and downloads models on its own; only the downloads you start from Ekorbia appear here.
          </span>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { PrivacySettings, privacyAnswersWith });
