// model-manager.jsx — In-app model download / delete (the "no terminal
// required" path for `ollama pull` / `ollama rm`).
//
//   • Module-scope pull store + window.ekPullModel orchestrator. Lives
//     OUTSIDE any component so an in-flight download survives the modal
//     closing, and so other surfaces (the guided first-run gate) can start
//     pulls and render the same progress.
//   • ModelManagerPanel — installed-model list + download box. Embedded by
//     the Settings → Models tab and by ModelManagerModal.
//   • ModelManagerModal — fullscreen overlay wrapper, opened from the
//     composer ModelPicker / OllamaGate via window.ekOpenModelManager()
//     (registered in main.jsx, same pattern as window.ekOpenOnboarding).
//
// Depends on: tokens (T), utils.js (getInvoke, getChannel, genId,
// formatBytes, accumulatePullProgress), overlays.jsx (ConfirmDialog),
// toast.jsx (window.ekToast). Rust side: ollama_pull / ollama_pull_cancel /
// ollama_delete in src-tauri/src/ollama.rs.

// ── Pull store (module scope = window-global per no-bundler convention) ────
//
// EK_ACTIVE_PULLS maps model name → progress state (the return shape of
// accumulatePullProgress, plus {model, requestId}). Listeners are notified
// on every change; mounted panels subscribe and re-render. A model can
// only have one in-flight pull (second ekPullModel call for the same name
// is a no-op returning the existing promise) — this also sidesteps the
// cancel-registry id-collision hazard documented in ollama.rs.

'use strict';
const EK_ACTIVE_PULLS = new Map();
const EK_PULL_LISTENERS = new Set();
const EK_PULL_PROMISES = new Map(); // model -> in-flight promise

function ekPullsNotify() {
  EK_PULL_LISTENERS.forEach((fn) => {
    try { fn(); } catch (_) { /* a broken listener must not stall pulls */ }
  });
}

function ekPullsSubscribe(fn) {
  EK_PULL_LISTENERS.add(fn);
  return () => EK_PULL_LISTENERS.delete(fn);
}

// Start pulling `model`. Resolves { ok, error }: ok=true when the backend
// reports {"status":"success"}; ok=false on error, cancel, or early stream
// end, with `error` carrying the reason (the HTTP/in-band message) for
// callers that want to surface it. opts.silent suppresses the
// completion/error toasts (the guided first-run renders its own status).
//
// Backend flavors (Phase 3): the ENGINE catalog downloader emits the same
// Ollama-pull-shaped progress chunks (that's a deliberate wire contract —
// see engine/downloads.rs), so the whole store/progress path is shared and
// only the invoke names differ:
//   opts.engine    — `model` is a catalog id → engine_download
//   opts.customUrl — best-effort custom GGUF → engine_download_custom
//   opts.hf        — {repo, file} from the HF picker → engine_download_hf
//                    (checksum-verified; auto-pairs the repo's vision mmproj)
async function ekPullModel(model, opts) {
  const silent = !!(opts && opts.silent);
  const engine = !!(opts && opts.engine);
  const customUrl = (opts && opts.customUrl) || null;
  const hf = (opts && opts.hf) || null;
  const invoke = getInvoke();
  model = (model || "").trim();
  if (!invoke || !model) return { ok: false, error: "The model backend is not available" };
  if (EK_PULL_PROMISES.has(model)) return EK_PULL_PROMISES.get(model);

  // `dl:` namespace for engine downloads, `pull:` for Ollama — same
  // shared cancel registry on the Rust side, no id collisions.
  const isEngineFlavor = engine || !!customUrl || !!hf;
  const requestId = `${isEngineFlavor ? "dl" : "pull"}:${model}:${genId()}`;
  const seed = accumulatePullProgress(null, null);
  seed.model = model;
  seed.requestId = requestId;
  seed.cancelCmd = isEngineFlavor ? "engine_download_cancel" : "ollama_pull_cancel";
  EK_ACTIVE_PULLS.set(model, seed);
  ekPullsNotify();

  const Channel = getChannel();
  const ch = Channel ? new Channel() : null;
  if (ch) {
    ch.onmessage = (chunk) => {
      const cur = EK_ACTIVE_PULLS.get(model);
      if (!cur) return; // finished/cancelled between chunks
      const next = accumulatePullProgress(cur, chunk);
      next.model = model;
      next.requestId = cur.requestId;
      next.cancelCmd = cur.cancelCmd;
      EK_ACTIVE_PULLS.set(model, next);
      ekPullsNotify();
    };
  }

  const run = (async () => {
    try {
      if (hf) {
        await invoke("engine_download_hf", {
          repo: hf.repo,
          file: hf.file,
          name: model,
          requestId,
          onProgress: ch,
        });
      } else if (customUrl) {
        await invoke("engine_download_custom", {
          url: customUrl,
          name: model,
          requestId,
          onProgress: ch,
        });
      } else if (engine) {
        await invoke("engine_download", { modelId: model, requestId, onProgress: ch });
      } else {
        await invoke("ollama_pull", { requestId, model, onProgress: ch });
      }
      const last = EK_ACTIVE_PULLS.get(model);
      if (last && last.error) {
        if (!silent) {
          window.ekToast?.({
            kind: "error",
            title: `Could not pull ${model}`,
            body: last.error,
          });
        }
        return { ok: false, error: last.error };
      }
      // The command resolving WITHOUT a success line means the stream was
      // cancelled (or Ollama closed early) — not a completed download.
      if (!last || !last.done) {
        return { ok: false, error: "Download didn't complete (cancelled or interrupted)" };
      }
      if (!silent) {
        window.ekToast?.({
          kind: "success",
          title: `${model} downloaded`,
          body: "It now appears in the model picker.",
        });
      }
      return { ok: true, error: null };
    } catch (e) {
      if (!silent) {
        window.ekToast?.({
          kind: "error",
          title: `Could not pull ${model}`,
          body: String(e),
        });
      }
      return { ok: false, error: String(e) };
    } finally {
      EK_ACTIVE_PULLS.delete(model);
      EK_PULL_PROMISES.delete(model);
      ekPullsNotify();
    }
  })();
  EK_PULL_PROMISES.set(model, run);
  return run;
}

function ekCancelPull(model) {
  const cur = EK_ACTIVE_PULLS.get(model);
  const invoke = getInvoke();
  if (!cur || !invoke) return;
  // Rust flips the cancel flag; the download command resolves Ok and the
  // finally block above cleans the store. Fire-and-forget by design.
  // Engine downloads keep their .partial on cancel (resume support) —
  // the flavor is routed via the cancelCmd the seed recorded.
  invoke(cur.cancelCmd || "ollama_pull_cancel", { requestId: cur.requestId }).catch(() => {});
}

// Window-accessible progress accessor. EK_ACTIVE_PULLS is a module-scope
// const (not on window), so other scripts (e.g. OllamaGate in overlays.jsx)
// that want to render a pull's progress read it through this function
// declaration, which IS hoisted onto window. Returns the accumulated
// progress object for `model`, or null if no pull is active for it.
function ekGetPull(model) {
  return EK_ACTIVE_PULLS.get(model) || null;
}

// Curated suggestions for the download box. Names + sizes verified against
// the Ollama library (June 2026); sizes are download sizes shown to set
// expectations, not enforced. The panel filters out any model the user has
// already pulled (see `suggestions` in ModelManagerPanel), so this list is
// just the candidate pool — keep it diverse rather than many tags of one
// family.
const CURATED_MODELS = [
  { name: "gemma4:e4b", approx: "9.6 GB", blurb: "All-round default — chat, vision, tools" },
  { name: "gemma4:e2b", approx: "7.2 GB", blurb: "Smaller + faster — good on low-RAM machines" },
  { name: "gemma4:12b", approx: "7.6 GB", blurb: "Stronger reasoning, 256K context" },
  { name: "granite4.1:8b", approx: "5.3 GB", blurb: "IBM Granite — efficient, strong tool use" },
  { name: "qwen3.5:2b", approx: "2.7 GB", blurb: "Tiny + capable — vision, 256K context" },
  { name: "qwen3.5:9b", approx: "6.6 GB", blurb: "Mid-size reasoning + coding — vision, 256K context" },
  { name: "llama3.2:3b", approx: "2.0 GB", blurb: "Tiny general-purpose fallback" },
  { name: "nomic-embed-text", approx: "274 MB", blurb: "Embeddings — needed for folder attachments + search" },
];

// ── Panel ──────────────────────────────────────────────────────────────────

function ModelManagerPanel({ activeModel }) {
  const [models, setModels] = useState(null); // null = loading
  const [loadError, setLoadError] = useState("");
  const [pullInput, setPullInput] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null); // model name
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Bumped by the pull store on every progress chunk; the value is unused —
  // it exists to schedule a re-render that re-reads EK_ACTIVE_PULLS.
  const [, setPullTick] = useState(0);
  const prevPullingRef = useRef(new Set());
  const invoke = getInvoke();
  // Non-Ollama backends hide the pull/delete affordances:
  //   - BYO (custom endpoint): the endpoint owns its model store; the
  //     installed list mirrors /v1/models.
  //   - Bundled engine: models are .gguf FILES in the app's models
  //     folder — managed in the file manager (Phase 2; the Phase 3
  //     catalog adds in-app downloads). The list reads the same
  //     llm_list_models, which the engine adapter answers from a dir
  //     scan.
  const [backendKind, setBackendKind] = useState("ollama");
  const byoBackend = backendKind === "openai";
  const engineBackend = backendKind === "engine";
  // engine_status snapshot for the engine hint (models folder path).
  const [engineInfo, setEngineInfo] = useState(null);
  // Engine catalog (Phase 3): baked-in curated list + per-model install
  // state. null = not fetched. Refreshed when a download finishes (via
  // the pull-store subscription below) and after deletes.
  const [engineCatalog, setEngineCatalog] = useState(null);
  // Machine RAM (GB) for the catalog's fit badges.
  const [ramGb, setRamGb] = useState(null);
  // "Add from a link" box: one field; we derive the local name from the file
  // (see parseHfGgufLink). Replaces the old url + invent-a-name pair.
  const [customLink, setCustomLink] = useState("");
  // HF repo picker (#3): after "Browse", holds the repo's .gguf listing.
  // Shape: { repo, loading, error, files:[{path,size,sha256}], mmproj:{…}|null }.
  const [hfBrowse, setHfBrowse] = useState(null);
  // Engine catalog view controls: a filter box and a fold for the long tail.
  const [catalogFilter, setCatalogFilter] = useState("");
  const [catalogExpanded, setCatalogExpanded] = useState(false);
  const refreshCatalog = () => {
    if (!invoke) return;
    invoke("engine_catalog")
      .then((c) => setEngineCatalog(c?.models || []))
      .catch(() => setEngineCatalog([]));
  };
  // The pull-finish subscription effect below is mount-scoped; give it a
  // ref so it can trigger catalog refreshes without re-subscribing.
  const refreshCatalogRef = useRef(() => {});
  refreshCatalogRef.current = engineBackend ? refreshCatalog : () => {};
  useEffect(() => {
    if (!invoke) return;
    invoke("llm_backend_config_get")
      .then((c) => setBackendKind(c?.backend || "ollama"))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);
  useEffect(() => {
    if (!invoke || !engineBackend) return;
    invoke("engine_status")
      .then((s) => setEngineInfo(s || null))
      .catch(() => setEngineInfo(null));
    refreshCatalog();
    invoke("system_profile")
      .then((p) => {
        const b = p?.totalRamBytes;
        if (b) setRamGb(Math.round(b / 1073741824));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kind-gated
  }, [engineBackend]);

  const refreshModels = () => {
    if (!invoke) { setModels([]); setLoadError("Ollama not running"); return; }
    invoke("llm_list_models")
      .then((data) => {
        const sorted = (data.models || []).slice().sort((a, b) =>
          (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }),
        );
        setModels(sorted);
        setLoadError("");
      })
      .catch((e) => {
        setModels([]);
        // The engine's errors name the real problem ("llama-server
        // binary not found — run scripts/…"); the legacy label only
        // fits the Ollama backend.
        setLoadError(String(e?.message || e || "") || "Ollama not running");
      });
  };

  useEffect(() => {
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render on pull progress; refresh the installed list when any pull
  // LEAVES the store (finished or cancelled — either way /api/tags may
  // have changed).
  useEffect(() => {
    return ekPullsSubscribe(() => {
      const now = new Set(EK_ACTIVE_PULLS.keys());
      const prev = prevPullingRef.current;
      let someoneFinished = false;
      prev.forEach((m) => { if (!now.has(m)) someoneFinished = true; });
      prevPullingRef.current = now;
      setPullTick((t) => t + 1);
      if (someoneFinished) {
        refreshModels();
        refreshCatalogRef.current(); // engine: flip catalog rows to Installed
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPull = (name) => {
    const model = (name || "").trim();
    if (!model) return;
    setPullInput("");
    ekPullModel(model);
  };

  const doDelete = async () => {
    const model = confirmDelete;
    if (!model) return;
    setDeleteBusy(true);
    try {
      if (engineBackend) {
        // Engine models are files; Rust unloads a resident (idle) model
        // first and refuses while it's actively streaming.
        await invoke("engine_model_delete", { name: model });
      } else {
        await invoke("ollama_delete", { model });
      }
      window.ekToast?.({ kind: "success", title: `${model} deleted` });
      refreshModels();
      refreshCatalogRef.current();
    } catch (e) {
      window.ekToast?.({ kind: "error", title: `Could not delete ${model}`, body: String(e) });
    } finally {
      setDeleteBusy(false);
      setConfirmDelete(null);
    }
  };

  const startCustomDownload = () => {
    const parsed = parseHfGgufLink(customLink);
    if (!parsed) return;
    setCustomLink("");
    ekPullModel(parsed.name, { customUrl: parsed.url });
  };

  // "Browse" a pasted org/model: list its .gguf files (Rust hits the HF tree
  // API, which also gives us each file's sha256 for verified downloads).
  const browseHfRepo = () => {
    const repo = parseHfRepo(customLink);
    if (!repo || !invoke) return;
    setHfBrowse({ repo, loading: true, error: "", files: [], mmproj: null });
    invoke("engine_hf_repo_files", { repo })
      .then((r) =>
        setHfBrowse({
          repo: (r && r.repo) || repo,
          loading: false,
          error: "",
          files: (r && r.files) || [],
          mmproj: (r && r.mmproj) || null,
        }),
      )
      .catch((e) =>
        setHfBrowse({
          repo,
          loading: false,
          error: String((e && e.message) || e || "Couldn't read that repo."),
          files: [],
          mmproj: null,
        }),
      );
  };

  const downloadHfFile = (file) => {
    if (!hfBrowse) return;
    const name = ggufNameFromFile((file.path || "").split("/").pop());
    if (!name) return;
    ekPullModel(name, { hf: { repo: hfBrowse.repo, file: file.path } });
  };

  const installed = models || [];
  const installedNames = new Set(installed.map((m) => m.name));
  const pulls = Array.from(EK_ACTIVE_PULLS.values());
  const suggestions = CURATED_MODELS.filter(
    (c) => !installedNames.has(c.name) && !EK_ACTIVE_PULLS.has(c.name),
  );

  // Type-ahead options for the download box. Ollama's local API has no
  // remote-library search endpoint (/api/tags only reports INSTALLED
  // models), and querying ollama.com directly would break the
  // "only talks to localhost" guarantee — so true full-library
  // autocomplete isn't possible offline. Instead we offer a static
  // <datalist>: the curated names plus the user's already-installed names
  // (handy for `pull`-to-update). Free-typing any other name still works.
  const datalistNames = Array.from(
    new Set([...CURATED_MODELS.map((c) => c.name), ...installed.map((m) => m.name)]),
  ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  // ── Engine catalog view (fit-first, foldable) ────────────────────────────
  // Split chat vs embeddings, rank the chat models so the best pick for THIS
  // Mac leads and oversized ones sink, then fold the long tail so a growing
  // catalog stays scannable in the tab's limited vertical space.
  const catalogAll = engineCatalog || [];
  const chatCatalog = catalogAll.filter((c) => c.purpose !== "embed");
  const embedCatalog = catalogAll.filter((c) => c.purpose === "embed");
  const recommendedModel = chatCatalog.find((c) => c.recommended);
  const recFits =
    recommendedModel && (ramGb === null || ramGb >= recommendedModel.minRamGb);
  let heroId = recFits ? recommendedModel.id : null;
  if (!heroId && chatCatalog.length) {
    // The curated pick can't run here → lead with the largest that fits.
    const rec = recommendEngineModel(catalogAll, ramGb ? ramGb * 1073741824 : 0);
    if (rec && !rec.lowRam) heroId = rec.id;
  }
  const withFit = (c) => ({ ...c, lowRam: ramGb !== null && ramGb < c.minRamGb });
  const rankedChat = chatCatalog.map(withFit).sort((a, b) => {
    if (a.id === heroId) return -1;
    if (b.id === heroId) return 1;
    // Fitting before oversized; within a group, larger (more capable) first.
    return (
      (a.lowRam ? 1 : 0) - (b.lowRam ? 1 : 0) ||
      (b.totalBytes || 0) - (a.totalBytes || 0)
    );
  });
  const cq = catalogFilter.trim().toLowerCase();
  const matchCat = (c) =>
    !cq ||
    (c.label || "").toLowerCase().includes(cq) ||
    (c.blurb || "").toLowerCase().includes(cq);
  const filteredChat = rankedChat.filter(matchCat);
  // Fold only in the plain, unfiltered view; a search shows every match.
  const FOLD_AT = 4;
  const folding = !cq && !catalogExpanded && filteredChat.length > FOLD_AT;
  const shownChat = folding ? filteredChat.slice(0, FOLD_AT) : filteredChat;
  const hiddenChat = filteredChat.length - shownChat.length;
  const hiddenTooBig = folding
    ? filteredChat.slice(FOLD_AT).filter((c) => c.lowRam).length
    : 0;
  const parsedLink = parseHfGgufLink(customLink);
  // A direct .gguf link → one-shot "Add"; else an org/model → "Browse".
  const parsedRepo = parsedLink ? null : parseHfRepo(customLink);
  const linkMode = parsedLink ? "add" : parsedRepo ? "browse" : "none";

  const catalogButton = (c) => {
    const pull = EK_ACTIVE_PULLS.get(c.id);
    if (c.installed) {
      return (
        <span
          data-catalog-installed
          style={{ fontFamily: T.mono, fontSize: 10.5, color: T.green, whiteSpace: "nowrap" }}
        >
          ✓ installed
        </span>
      );
    }
    if (pull) {
      return (
        <button
          onClick={() => ekCancelPull(c.id)}
          style={{
            padding: "3px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
            background: "transparent", color: T.fg3, fontFamily: T.sans,
            fontSize: 11.5, cursor: "pointer",
          }}
        >
          Cancel
        </button>
      );
    }
    return (
      <button
        data-catalog-download={c.id}
        onClick={() => ekPullModel(c.id, { engine: true })}
        style={{
          padding: "3px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
          background: "transparent", color: T.fg2, fontFamily: T.sans,
          fontSize: 11.5, cursor: "pointer",
        }}
      >
        Download
      </button>
    );
  };

  const catalogChatRow = (c) => {
    const isHero = c.id === heroId;
    return (
      <div
        key={c.id}
        data-catalog-model={c.id}
        style={{
          display: "grid", gridTemplateColumns: "1fr auto", gap: 8,
          alignItems: "center",
          padding: isHero ? "10px 12px" : "7px 8px",
          borderRadius: isHero ? 8 : 4,
          border: isHero ? "1px solid var(--ek-accent)" : "none",
          marginBottom: isHero ? 6 : 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg, fontWeight: 500 }}>
              {c.label}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>
              {formatBytes(c.totalBytes)}
            </span>
            {isHero && (
              <span
                data-catalog-hero
                style={{
                  fontFamily: T.mono, fontSize: 9, padding: "1px 5px", borderRadius: 3,
                  background: T.bg2, color: "var(--ek-accent)",
                  border: "1px solid var(--ek-accent)",
                  textTransform: "uppercase", letterSpacing: 0.4,
                }}
              >
                {ramGb !== null ? "best for your Mac" : "recommended"}
              </span>
            )}
            {c.lowRam && (
              <span
                data-catalog-ram-warning
                style={{
                  fontFamily: T.mono, fontSize: 9, padding: "1px 5px", borderRadius: 3,
                  background: T.amber + "26", color: T.amber,
                  textTransform: "uppercase", letterSpacing: 0.4,
                }}
                title={`This model wants ${c.minRamGb} GB of RAM; this Mac has ${ramGb} GB.`}
              >
                needs {c.minRamGb} GB RAM
              </span>
            )}
          </div>
          <div style={{ fontFamily: T.sans, fontSize: 11.5, color: T.fg2, marginTop: 1 }}>
            {c.blurb}
          </div>
        </div>
        {catalogButton(c)}
      </div>
    );
  };

  const catalogEmbedRow = (c) => (
    <div
      key={c.id}
      data-catalog-model={c.id}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 4 }}
    >
      <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg, fontWeight: 500 }}>
        {c.label}
      </span>
      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>
        {formatBytes(c.totalBytes)}
      </span>
      <span
        style={{
          fontFamily: T.mono, fontSize: 9, padding: "1px 5px", borderRadius: 3,
          background: T.blue + "26", color: T.blue,
          textTransform: "uppercase", letterSpacing: 0.4,
        }}
      >
        embeddings
      </span>
      <span style={{ flex: 1 }} />
      {catalogButton(c)}
    </div>
  );

  // Which quant to badge "recommended" in the HF picker: a sensible balanced
  // default if present, else the median by size.
  const hfRecommendedIndex = (files) => {
    const pref = ["q4_k_m", "q4_0", "q5_k_m", "q4_k_s"];
    for (const p of pref) {
      const i = files.findIndex((f) => (f.path || "").toLowerCase().includes(p));
      if (i >= 0) return i;
    }
    if (!files.length) return -1;
    const bySize = files.map((f, i) => [f.size || 0, i]).sort((a, b) => a[0] - b[0]);
    return bySize[Math.floor(bySize.length / 2)][1];
  };

  const hfFileRow = (file, opts) => {
    const recommended = !!(opts && opts.recommended);
    const vision = !!(opts && opts.vision);
    const base = (file.path || "").split("/").pop();
    const name = ggufNameFromFile(base);
    const quant = ggufQuantLabel(file.path);
    const installed = name && installedNames.has(name);
    const pull = name && EK_ACTIVE_PULLS.get(name);
    const verified = !!(file.sha256 && file.sha256.length >= 32);
    return (
      <div
        key={file.path}
        data-hf-file={file.path}
        style={{
          display: "grid", gridTemplateColumns: "1fr auto", gap: 8,
          alignItems: "center", padding: "7px 8px", borderRadius: 4,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.fg }} title={base}>
              {quant || base}
            </span>
            {recommended && (
              <span
                style={{
                  fontFamily: T.mono, fontSize: 9, padding: "1px 5px", borderRadius: 3,
                  background: T.bg2, color: "var(--ek-accent)",
                  border: "1px solid var(--ek-accent)",
                  textTransform: "uppercase", letterSpacing: 0.4,
                }}
              >
                recommended
              </span>
            )}
            {vision && (
              <span
                data-hf-vision
                style={{
                  fontFamily: T.mono, fontSize: 9, padding: "1px 5px", borderRadius: 3,
                  background: T.blue + "26", color: T.blue,
                  textTransform: "uppercase", letterSpacing: 0.4,
                }}
                title="This repo ships a vision projector; it downloads with the model."
              >
                vision
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>
            <span>{formatBytes(file.size)}</span>
            {verified && (
              <span data-hf-verified style={{ color: T.green }}>· ✓ hash-verified</span>
            )}
          </div>
        </div>
        {installed ? (
          <span
            data-catalog-installed
            style={{ fontFamily: T.mono, fontSize: 10.5, color: T.green, whiteSpace: "nowrap" }}
          >
            ✓ installed
          </span>
        ) : pull ? (
          <button
            onClick={() => ekCancelPull(name)}
            style={{
              padding: "3px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
              background: "transparent", color: T.fg3, fontFamily: T.sans,
              fontSize: 11.5, cursor: "pointer",
            }}
          >
            Cancel
          </button>
        ) : (
          <button
            data-hf-download={file.path}
            onClick={() => downloadHfFile(file)}
            style={{
              padding: "3px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
              background: "transparent", color: T.fg2, fontFamily: T.sans,
              fontSize: 11.5, cursor: "pointer",
            }}
          >
            Download
          </button>
        )}
      </div>
    );
  };

  const sectionLabel = (text) => (
    <div
      style={{
        fontFamily: T.mono, fontSize: 10, color: T.fg3,
        textTransform: "uppercase", letterSpacing: 0.6,
        padding: "10px 2px 6px",
      }}
    >
      {text}
    </div>
  );

  return (
    <div data-model-manager style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      {sectionLabel("Installed models")}

      {models === null && (
        <div style={{ padding: "10px 2px", fontFamily: T.mono, fontSize: 11, color: T.fg3 }}>
          <span className="typing-dot">●</span> <span className="typing-dot">●</span>{" "}
          <span className="typing-dot">●</span>
        </div>
      )}
      {loadError && (
        <div style={{ padding: "10px 2px", fontFamily: T.mono, fontSize: 11, color: T.fg3 }}>
          {loadError}
        </div>
      )}
      {models !== null && !loadError && installed.length === 0 && (
        <div style={{ padding: "10px 2px", fontFamily: T.sans, fontSize: 12.5, color: T.fg2 }}>
          No models installed yet — download one below.
        </div>
      )}

      {installed.map((m) => {
        const isActive = m.name === activeModel;
        const params = m.details?.parameter_size || "";
        const quant = m.details?.quantization_level || "";
        const sizeOnDisk = formatBytes(m.size);
        return (
          <div
            key={m.name}
            style={{
              display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8,
              alignItems: "center", padding: "7px 8px", borderRadius: 4,
            }}
          >
            <ModelDot color={modelColor(m.name)} size={7} />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg, fontWeight: 500 }}>
                  {m.name}
                </span>
                {params && <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg2 }}>{params}</span>}
                {quant && <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.fg3 }}>{quant}</span>}
                {isActive && (
                  <span
                    style={{
                      fontFamily: T.mono, fontSize: 9, padding: "1px 5px", borderRadius: 3,
                      background: T.green + "26", color: T.green,
                      textTransform: "uppercase", letterSpacing: 0.4,
                    }}
                  >
                    active
                  </span>
                )}
              </div>
              {sizeOnDisk && (
                <div style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3, marginTop: 1 }}>
                  {sizeOnDisk} on disk
                </div>
              )}
            </div>
            {!byoBackend && (
            <button
              onClick={() => setConfirmDelete(m.name)}
              title={engineBackend ? `Delete ${m.name} from the models folder` : `Delete ${m.name} from Ollama`}
              style={{
                padding: "3px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
                background: "transparent", color: T.fg3, fontFamily: T.sans,
                fontSize: 11.5, cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = T.red; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = T.fg3; }}
            >
              Delete
            </button>
            )}
          </div>
        );
      })}

      {pulls.length > 0 && sectionLabel("Downloading")}
      {pulls.map((p) => (
        <div key={p.model} style={{ padding: "7px 8px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg, fontWeight: 500, flex: 1 }}>
              {p.model}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg2 }}>
              {p.pct !== null
                ? `${p.pct}% · ${formatBytes(p.completedBytes)} / ${formatBytes(p.totalBytes)}`
                : p.statusLine || "starting…"}
            </span>
            <button
              onClick={() => ekCancelPull(p.model)}
              style={{
                padding: "2px 8px", borderRadius: 4, border: `1px solid ${T.border}`,
                background: "transparent", color: T.fg3, fontFamily: T.sans,
                fontSize: 11, cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
          <div
            style={{
              marginTop: 6, height: 4, borderRadius: 2, background: T.bg3,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: p.pct !== null ? `${p.pct}%` : "30%",
                background: T.amber,
                borderRadius: 2,
                transition: "width 200ms linear",
                // Indeterminate shimmer until the first layer reports size.
                animation: p.pct === null ? "blink 1.1s steps(2) infinite" : "none",
              }}
            />
          </div>
        </div>
      ))}

      {byoBackend && (
        <div
          data-byo-hint
          style={{
            fontFamily: T.sans, fontSize: 11, color: T.fg3,
            lineHeight: 1.5, marginTop: 10,
          }}
        >
          Models are managed by your endpoint server (LM Studio,
          llama-server, ...). Load or download models there; this list
          mirrors what it reports at /v1/models.
        </div>
      )}
      {engineBackend && engineCatalog !== null && (
        <>
          {sectionLabel("Model catalog")}
          {chatCatalog.length > FOLD_AT && (
            <input
              data-catalog-filter
              value={catalogFilter}
              onChange={(e) => setCatalogFilter(e.target.value)}
              placeholder="Filter models…"
              spellCheck={false}
              autoComplete="off"
              style={{
                width: "100%", boxSizing: "border-box", margin: "0 0 8px",
                padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                background: T.bg2, color: T.fg, fontFamily: T.sans, fontSize: 12, outline: "none",
              }}
            />
          )}
          {shownChat.map(catalogChatRow)}
          {shownChat.length === 0 && (
            <div style={{ fontFamily: T.sans, fontSize: 12, color: T.fg3, padding: "6px 8px" }}>
              No models match that filter.
            </div>
          )}
          {folding && (
            <div
              data-catalog-showmore
              onClick={() => setCatalogExpanded(true)}
              style={{
                display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                padding: "8px 8px", marginTop: 2, borderTop: `1px solid ${T.border}`,
                fontFamily: T.sans, fontSize: 11.5, color: T.fg2,
              }}
            >
              <span aria-hidden="true" style={{ color: T.fg3 }}>▸</span>
              Show {hiddenChat} more
              {hiddenTooBig > 0 && (
                <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>
                  {hiddenTooBig} need &gt; {ramGb} GB
                </span>
              )}
            </div>
          )}
          {!folding && catalogExpanded && !cq && filteredChat.length > FOLD_AT && (
            <div
              data-catalog-showless
              onClick={() => setCatalogExpanded(false)}
              style={{
                display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                padding: "8px 8px", marginTop: 2, borderTop: `1px solid ${T.border}`,
                fontFamily: T.sans, fontSize: 11.5, color: T.fg2,
              }}
            >
              <span aria-hidden="true" style={{ color: T.fg3 }}>▾</span>
              Show less
            </div>
          )}
          {embedCatalog.length > 0 && (
            <>
              {sectionLabel("Embeddings")}
              {embedCatalog.map(catalogEmbedRow)}
            </>
          )}
        </>
      )}

      {engineBackend && (
        <div
          data-engine-hint
          style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}
        >
          {sectionLabel("Add from a link")}
          <div style={{ display: "flex", gap: 6, padding: "0 2px" }}>
            <input
              data-custom-gguf-url
              value={customLink}
              onChange={(e) => {
                const v = e.target.value;
                setCustomLink(v);
                // Editing away from the browsed repo clears its stale results.
                if (hfBrowse && parseHfRepo(v) !== hfBrowse.repo) setHfBrowse(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                if (linkMode === "browse") browseHfRepo();
                else if (linkMode === "add") startCustomDownload();
              }}
              placeholder="huggingface.co/org/model  ·  or a direct …/model.gguf link"
              spellCheck={false}
              autoComplete="off"
              style={{
                flex: 1, minWidth: 0, padding: "7px 10px", borderRadius: 6,
                border: `1px solid ${T.border}`, background: T.bg2, color: T.fg,
                fontFamily: T.mono, fontSize: 11.5, outline: "none",
              }}
            />
            <button
              data-custom-gguf-download
              onClick={linkMode === "browse" ? browseHfRepo : startCustomDownload}
              disabled={linkMode === "none"}
              style={{
                padding: "7px 16px", borderRadius: 6, border: "none",
                background: linkMode !== "none" ? T.amber : T.bg3,
                color: linkMode !== "none" ? T.bg0 : T.fg3,
                fontFamily: T.sans, fontSize: 12.5, fontWeight: 600,
                cursor: linkMode !== "none" ? "pointer" : "default", flexShrink: 0,
              }}
            >
              {linkMode === "browse" ? "Browse" : "Add"}
            </button>
          </div>
          <div
            data-custom-gguf-status
            style={{ fontFamily: T.sans, fontSize: 11, color: T.fg3, padding: "0 2px", lineHeight: 1.5 }}
          >
            {parsedLink ? (
              <>
                Installs as{" "}
                <span style={{ fontFamily: T.mono, color: T.fg2 }}>{parsedLink.name}</span>{" "}
                — named from the file. Best-effort: quality depends on the
                file's built-in chat template. For vision, add a matching{" "}
                <span style={{ fontFamily: T.mono }}>{parsedLink.name}.mmproj.gguf</span>{" "}
                to the models folder.
              </>
            ) : parsedRepo ? (
              <>
                Browse{" "}
                <span style={{ fontFamily: T.mono, color: T.fg2 }}>{parsedRepo}</span>{" "}
                to pick a quant — downloads are checksum-verified, and its vision
                projector (if any) comes with the model.
              </>
            ) : customLink.trim() ? (
              "Paste a Hugging Face model (org/model) or a direct link to a .gguf file."
            ) : (
              <>
                Paste a Hugging Face model —{" "}
                <span style={{ fontFamily: T.mono }}>org/model</span> to browse its
                quants, or a direct{" "}
                <span style={{ fontFamily: T.mono }}>.gguf</span> link to add one
                straight away. You can also drop files into the models folder.
              </>
            )}
          </div>

          {hfBrowse && (
            <div
              data-hf-results
              style={{
                border: `1px solid ${T.border}`, borderRadius: 6,
                padding: "8px 8px 4px", marginTop: 2,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 2px 4px" }}>
                <span
                  style={{
                    fontFamily: T.mono, fontSize: 10.5, color: T.fg2,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}
                >
                  {hfBrowse.repo}
                </span>
                {!hfBrowse.loading && !hfBrowse.error && (
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>
                    {hfBrowse.files.length} model{hfBrowse.files.length === 1 ? "" : "s"}
                    {hfBrowse.mmproj ? " · vision" : ""}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <button
                  data-hf-close
                  onClick={() => setHfBrowse(null)}
                  aria-label="Close repo results"
                  style={{ border: "none", background: "transparent", color: T.fg3, fontSize: 13, cursor: "pointer", padding: "0 2px" }}
                >
                  ✕
                </button>
              </div>
              {hfBrowse.loading && (
                <div style={{ padding: "6px 8px", fontFamily: T.mono, fontSize: 11, color: T.fg3 }}>
                  Reading repo…
                </div>
              )}
              {hfBrowse.error && (
                <div style={{ padding: "6px 8px", fontFamily: T.sans, fontSize: 11.5, color: T.amber }}>
                  {hfBrowse.error}
                </div>
              )}
              {!hfBrowse.loading && !hfBrowse.error &&
                (() => {
                  const recIdx = hfRecommendedIndex(hfBrowse.files);
                  return hfBrowse.files.map((f, i) =>
                    hfFileRow(f, { recommended: i === recIdx, vision: !!hfBrowse.mmproj }),
                  );
                })()}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            <button
              data-engine-reveal
              onClick={() => invoke && invoke("engine_models_dir_reveal").catch(() => {})}
              style={{
                padding: "4px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
                background: T.bg2, color: T.fg, fontFamily: T.sans,
                fontSize: 11, cursor: "pointer", flexShrink: 0,
              }}
            >
              Reveal models folder
            </button>
            {engineInfo && (
              <span
                style={{
                  fontFamily: T.mono, fontSize: 10, color: T.fg3,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
                title={engineInfo.modelsDir}
              >
                {engineInfo.modelsDir}
              </span>
            )}
          </div>
        </div>
      )}
      {!byoBackend && !engineBackend && sectionLabel("Download a model")}
      {!byoBackend && !engineBackend && (
      <>
      <div style={{ display: "flex", gap: 6, padding: "0 2px" }}>
        <input
          value={pullInput}
          onChange={(e) => setPullInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") startPull(pullInput); }}
          placeholder="model name, e.g. gemma4:e4b"
          list="ek-model-list"
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1, padding: "7px 10px", borderRadius: 6,
            border: `1px solid ${T.border}`, background: T.bg2, color: T.fg,
            fontFamily: T.mono, fontSize: 12, outline: "none",
          }}
        />
        {/* Offline type-ahead — see datalistNames above for why this is a
            static list rather than a live library search. */}
        <datalist id="ek-model-list">
          {datalistNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <button
          onClick={() => startPull(pullInput)}
          disabled={!pullInput.trim()}
          style={{
            padding: "7px 14px", borderRadius: 6, border: "none",
            background: pullInput.trim() ? T.amber : T.bg3,
            color: pullInput.trim() ? T.bg0 : T.fg3,
            fontFamily: T.sans, fontSize: 12.5, fontWeight: 600,
            cursor: pullInput.trim() ? "pointer" : "default",
          }}
        >
          Pull
        </button>
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3, padding: "5px 2px 0" }}>
        Browse the full library at ollama.com/library
      </div>

      </>
      )}

      {!byoBackend && !engineBackend && suggestions.length > 0 && (
        <>
          {sectionLabel("Suggestions")}
          {suggestions.map((c) => (
            <div
              key={c.name}
              data-model-suggestion={c.name}
              style={{
                display: "grid", gridTemplateColumns: "1fr auto", gap: 8,
                alignItems: "center", padding: "6px 8px", borderRadius: 4,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontFamily: T.sans, fontSize: 12.5, color: T.fg, fontWeight: 500 }}>
                    {c.name}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>{c.approx}</span>
                </div>
                <div style={{ fontFamily: T.sans, fontSize: 11.5, color: T.fg2, marginTop: 1 }}>
                  {c.blurb}
                </div>
              </div>
              <button
                onClick={() => startPull(c.name)}
                style={{
                  padding: "3px 10px", borderRadius: 4, border: `1px solid ${T.border}`,
                  background: "transparent", color: T.fg2, fontFamily: T.sans,
                  fontSize: 11.5, cursor: "pointer",
                }}
              >
                Pull
              </button>
            </div>
          ))}
        </>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={`Delete ${confirmDelete || ""}?`}
        body={
          confirmDelete === activeModel
            ? `${confirmDelete} is your ACTIVE model — chats will fall back to another installed model. The download is removed from disk; you can download it again any time.`
            : engineBackend
              ? `This removes the model's files from Ekorbia's models folder. You can download it again from the catalog any time.`
              : `This removes the model from Ollama's local store. You can pull it again any time.`
        }
        confirmText="Delete"
        busy={deleteBusy}
        onConfirm={doDelete}
        onCancel={() => { if (!deleteBusy) setConfirmDelete(null); }}
      />
    </div>
  );
}

// ── Modal wrapper ──────────────────────────────────────────────────────────

function ModelManagerModal({ open, onClose, activeModel }) {
  // Esc closes. Capture phase so a stacked ConfirmDialog (which also
  // listens on capture + stops propagation) wins when it's open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose?.(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      onClick={() => onClose?.()}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Manage models"
        style={{
          width: 460, maxHeight: "78vh", overflowY: "auto",
          background: panelGrad(), border: `1px solid ${T.borderStrong}`,
          borderRadius: 8, boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          padding: "14px 16px 16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontFamily: T.serif, fontSize: 17, color: T.fg, flex: 1 }}>
            Manage models
          </div>
          <button
            onClick={() => onClose?.()}
            aria-label="Close"
            style={{
              border: "none", background: "transparent", color: T.fg3,
              fontSize: 16, cursor: "pointer", padding: 2,
            }}
          >
            ✕
          </button>
        </div>
        <ModelManagerPanel activeModel={activeModel} />
      </div>
    </div>
  );
}
