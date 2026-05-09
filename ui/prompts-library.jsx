// prompts-library.jsx -- PromptLibrary right-panel browser/editor.
// Depends on: tokens, atoms (Resizer), icons, data (FAVORITE_COLORS).

// ─── Prompt Library ─────────────────────────────────────────
// Browser inspired by Native Instruments' Guitar Rig:
//   • Colored "Favorite" tags (7 colors) as a quick personal-bucket filter
//   • Free-text tags shown as a single flat row of chips; clicking a chip
//     toggles it as a filter (OR semantics — prompts with any selected tag)
//   • Right-click a row to assign/clear a Favorite without opening the editor
//   • Sort by Recent / A→Z / Z→A / Favorite
function PromptLibrary({
  prompts,
  selectedId,
  onSelect,
  onUse,
  onUpdate,
  onCreate,
  onDelete,
  onRefresh,
  onImport,
  width,
  attachedIds = [],
  // tabHeader is the <RightPanelTabs ...> element supplied by main.jsx so
  // that PromptLibrary stays decoupled from the surrounding right-panel
  // chrome — the tab bar is rendered at the very top of the aside before
  // PromptLibrary's own subheader.
  tabHeader,
}) {
  const EMPTY_PROMPT = {
    id: "",
    body: "",
    name: "",
    tags: [],
    favorite: null,
    updated: "",
  };

  // ── Filter / sort state (session-scoped — fresh on every panel re-open) ──
  const [search, setSearch] = useState("");
  const [favoriteFilter, setFavoriteFilter] = useState(null);
  const [tagFilters, setTagFilters] = useState([]);
  const [filtersOpen, setFiltersOpen] = useState(true);
  // Default to alphabetical — easier to scan / find a prompt by name once
  // the library has more than a handful. Users who prefer the recency view
  // can switch back via the sort menu; the choice is session-scoped so it
  // resets on next panel open.
  const [sort, setSort] = useState("name");
  const [sortOpen, setSortOpen] = useState(false);

  // ── List column width (persisted) ─────────────────────────────────────────
  // The left-column prompt list is independently resizable from the panel
  // itself: longer prompt names benefit from a wider list, but a wide list
  // squeezes the editor. We persist the choice across launches so it's a
  // one-time tune, not a per-session chore.
  //
  // Inlined here instead of imported from main.jsx because components.jsx
  // loads before main.jsx in index.html — no shared module scope. Keeping
  // the storage key namespaced under `ekorbia.promptlibrary.*` matches the
  // convention used by the panel's other persisted bits.
  const LIST_WIDTH_KEY = "ekorbia.promptlibrary.listwidth";
  const [listWidth, setListWidth] = useState(() => {
    try {
      const raw = localStorage.getItem(LIST_WIDTH_KEY);
      if (raw !== null) return JSON.parse(raw);
    } catch {}
    return 150;
  });
  useEffect(() => {
    try {
      localStorage.setItem(LIST_WIDTH_KEY, JSON.stringify(listWidth));
    } catch {}
  }, [listWidth]);
  // Stash the width at drag-start so the Resizer's relative dx applies
  // against a stable anchor, even if React re-renders mid-drag.
  const listWidthStartRef = useRef(listWidth);
  // Cap the list at "panel width minus editor minimum" so dragging the
  // panel narrower doesn't strand a too-wide list with no room for the
  // editor pane. Clamp during render too — handles the case where the
  // panel shrinks while the persisted list width is still large.
  const maxListWidth = Math.max(150, (width || 380) - 200);
  const effectiveListWidth = Math.min(Math.max(100, listWidth), maxListWidth);

  // ── Filtering ──────────────────────────────────────────────
  // All tags across all prompts, de-duped and sorted — a single flat list.
  // The filter panel renders this as one wrapping row of chips; clicking a
  // chip toggles it in `tagFilters`, and a prompt is shown if it carries
  // at least one of the selected tags (OR semantics).
  const allTags = useMemo(() => {
    const set = new Set();
    prompts.forEach((p) => (p.tags || []).forEach((t) => set.add(t)));
    return [...set].sort();
  }, [prompts]);

  const visiblePrompts = useMemo(() => {
    let r = prompts;
    const q = search.trim().toLowerCase();
    if (q) {
      r = r.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.body || "").toLowerCase().includes(q) ||
          (p.tags || []).some((t) => t.toLowerCase().includes(q)),
      );
    }
    if (favoriteFilter) {
      r = r.filter((p) => p.favorite === favoriteFilter);
    }
    if (tagFilters.length) {
      // OR semantics across all selected tags: a prompt qualifies if it
      // carries at least one. Chose OR over AND because users typically
      // hit the filter chips to *explore* related prompts, not to narrow
      // a known set — adding another tag should broaden the result, not
      // restrict to the intersection.
      r = r.filter((p) => tagFilters.some((t) => (p.tags || []).includes(t)));
    }
    if (sort === "name") {
      r = [...r].sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === "name_desc") {
      r = [...r].sort((a, b) => b.name.localeCompare(a.name));
    } else if (sort === "favorite") {
      // Group by favorite color; un-favorited go last.
      const order = (f) =>
        f ? FAVORITE_COLORS.findIndex((c) => c.id === f) : 999;
      r = [...r].sort((a, b) => order(a.favorite) - order(b.favorite));
    }
    // 'recent' falls through — prompts arrive sorted by updated_at DESC.
    return r;
  }, [prompts, search, favoriteFilter, tagFilters, sort]);

  // ── Selection / draft state ────────────────────────────────
  // Note: `selected` is derived from `visiblePrompts` first so changing
  // filters scrolls focus to something visible; falls back to the full
  // list and finally an empty placeholder when nothing matches.
  const selected =
    visiblePrompts.find((p) => p.id === selectedId) ||
    prompts.find((p) => p.id === selectedId) ||
    visiblePrompts[0] ||
    prompts[0] ||
    EMPTY_PROMPT;

  const fileInputRef = useRef(null);
  const [draft, setDraft] = useState(selected.body);
  const [name, setName] = useState(selected.name);
  const [tags, setTags] = useState(selected.tags || []);
  const [tagInput, setTagInput] = useState("");

  useEffect(() => {
    setDraft(selected.body);
    setName(selected.name);
    setTags(selected.tags || []);
    setTagInput("");
  }, [selected.id]);

  // ── Right-click context menu ───────────────────────────────
  // `menu = { x, y, prompt }` or null. Closed by document mousedown that
  // falls outside any `[data-menu]` subtree.
  const [menu, setMenu] = useState(null);

  // ── Delete-confirm dialog ──────────────────────────────────
  // Replaces the previous `window.confirm` call — uses the same styled
  // ConfirmDialog as Settings → Danger zone for visual consistency. The
  // dialog is opened from the trash button in the editor's action bar and
  // dismisses itself on confirm/cancel. busy is mostly cosmetic since
  // `onDelete` (deletePrompt in main.jsx) is fire-and-forget, but it
  // mirrors handleConfirmClearAll's pattern and protects against future
  // async work being added to that path.
  const [deleteConfirm, setDeleteConfirm] = useState(null); // null or { prompt }
  const [deleteBusy, setDeleteBusy] = useState(false);
  useEffect(() => {
    if (!menu && !sortOpen) return;
    const onDoc = (e) => {
      if (e.target.closest("[data-menu]")) return;
      setMenu(null);
      setSortOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menu, sortOpen]);

  if (!prompts.length)
    return (
      <aside
        style={{
          width: width || 380,
          flexShrink: 0,
          background: T.bg1,
          borderLeft: `1px solid ${T.border}`,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {tabHeader}
        {/* Empty-library message: shown only on the very first launch (or
            after the user deletes every prompt). Mentions both ways to
            populate the library — manually via "New" and the built-ins
            restore in Settings — so the user isn't stuck either way. */}
        <div
          style={{
            padding: "32px 20px",
            color: T.fg3,
            fontFamily: T.sans,
            fontSize: 12.5,
            lineHeight: 1.65,
            textAlign: "center",
          }}
        >
          <div style={{ color: T.fg2, fontSize: 13.5, marginBottom: 6 }}>
            No prompts in your library yet.
          </div>
          Prompts are <span style={{ fontFamily: T.mono, color: T.fg2 }}>.md</span> files
          with a system message and tags — handy presets you can pin to a chat.
          <div style={{ marginTop: 10, fontSize: 11.5 }}>
            Click <span style={{ color: T.fg2 }}>New</span> above to write one, or
            restore the built-ins from{" "}
            <span style={{ color: T.fg2 }}>Settings → Prompts</span>.
          </div>
        </div>
      </aside>
    );

  const toggleTagFilter = (t) =>
    setTagFilters((fs) =>
      fs.includes(t) ? fs.filter((x) => x !== t) : [...fs, t],
    );
  const clearFilters = () => {
    setTagFilters([]);
    setFavoriteFilter(null);
    setSearch("");
  };
  const anyFilterActive = !!search || !!favoriteFilter || tagFilters.length > 0;

  const addTag = (t) => {
    // Free-text tags — trim, drop a leading "#" if the user typed one,
    // lowercase for case-insensitive matching.
    const v = t.trim().replace(/^#/, "").toLowerCase();
    if (!v || tags.includes(v)) return;
    setTags([...tags, v]);
    setTagInput("");
  };
  const removeTag = (t) => setTags(tags.filter((x) => x !== t));

  // ── Save the immediate (non-draft) favorite marker ─────────
  // Favorites are markers, not content, so a click commits straight to the
  // DB without going through the Save Changes button — matching the
  // right-click-to-tag UX in Guitar Rig.
  const setFavoriteFor = (id, fav) => {
    onUpdate(id, { favorite: fav });
    setMenu(null);
  };

  const dirty =
    draft !== selected.body ||
    name !== selected.name ||
    tags.length !== (selected.tags || []).length ||
    tags.some((t, i) => t !== (selected.tags || [])[i]);

  const SORT_LABELS = {
    recent: "Recent",
    name: "A → Z",
    name_desc: "Z → A",
    favorite: "Favorite",
  };

  return (
    <aside
      style={{
        width: width || 380,
        flexShrink: 0,
        background: T.bg1,
        borderLeft: `1px solid ${T.border}`,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {tabHeader}
      {/* ── Sub-header ─────────────────────────────────────── */}
      {/* No more redundant "Prompts" label/icon — the tab bar above */}
      {/* already shows the active tab. We keep count + tab-specific  */}
      {/* actions (Import, New) on a thin row.                        */}
      <div
        style={{
          height: 32,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          padding: "0 8px 0 14px",
          borderBottom: `1px solid ${T.border}`,
          gap: 8,
        }}
      >
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>
          {visiblePrompts.length}/{prompts.length}
        </span>
        <span style={{ flex: 1 }} />
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt,text/plain,text/markdown"
          style={{ display: "none" }}
          onChange={async (e) => {
            const f = e.target.files && e.target.files[0];
            if (f && onImport) await onImport(f);
            e.target.value = "";
          }}
        />
        <IconButton
          icon={I.Refresh}
          onClick={() => onRefresh && onRefresh()}
          title="Reload prompts from disk"
          size={22}
        />
        <IconButton
          icon={I.Upload}
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
          title="Import from file (.md, .txt)"
          size={22}
        />
        <IconButton
          icon={I.Plus}
          onClick={() => onCreate && onCreate()}
          title="New prompt"
          size={22}
        />
      </div>

      {/* ── Search ─────────────────────────────────────────── */}
      <div
        style={{ padding: "8px 10px", borderBottom: `1px solid ${T.border}` }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: T.bg2,
            borderRadius: 5,
            padding: "0 8px",
            height: 24,
            border: `1px solid ${T.border}`,
          }}
        >
          <I.Search size={11} style={{ color: T.fg3 }} />
          <input
            placeholder="Search prompts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              color: T.fg,
              fontFamily: T.mono,
              fontSize: 11,
              padding: 0,
              outline: "none",
            }}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              title="Clear"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: T.fg3,
                padding: 0,
                display: "inline-flex",
              }}
            >
              <I.X size={9} />
            </button>
          )}
        </div>
      </div>

      {/* ── Favorites strip ─────────────────────────────────── */}
      {/* 7 colored dots + a no-color "any" button. Click toggles the filter; */}
      {/* clicking the same dot again clears it. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        <span
          style={{
            fontFamily: T.mono,
            fontSize: 9.5,
            color: T.fg3,
            letterSpacing: 0.4,
            textTransform: "uppercase",
          }}
        >
          Fav
        </span>
        <button
          onClick={() => setFavoriteFilter(null)}
          title="Any favorite (or none)"
          style={{
            width: 14,
            height: 14,
            border: `1px solid ${!favoriteFilter ? T.borderStrong : T.border}`,
            borderRadius: 99,
            background: !favoriteFilter ? T.bg4 : "transparent",
            color: T.fg3,
            fontFamily: T.mono,
            fontSize: 9,
            cursor: "pointer",
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ∅
        </button>
        {FAVORITE_COLORS.map((f) => {
          const active = favoriteFilter === f.id;
          // Identical render to the per-prompt favorite picker below — same
          // size, same active-state ring, no opacity fade. Consistency
          // between these two strips matters: users naturally compare them.
          return (
            <button
              key={f.id}
              onClick={() =>
                setFavoriteFilter(favoriteFilter === f.id ? null : f.id)
              }
              title={`Filter by ${f.id}`}
              style={{
                width: 14,
                height: 14,
                borderRadius: 99,
                background: f.color,
                border: `2px solid ${active ? T.fg : "transparent"}`,
                cursor: "pointer",
                padding: 0,
              }}
            />
          );
        })}
        <span style={{ flex: 1 }} />
        {anyFilterActive && (
          <button
            onClick={clearFilters}
            title="Clear all filters"
            style={{
              fontFamily: T.mono,
              fontSize: 9.5,
              color: T.amber,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            clear
          </button>
        )}
      </div>

      {/* ── Filter groups (collapsible) ─────────────────────── */}
      <div style={{ borderBottom: `1px solid ${T.border}` }}>
        <button
          onClick={() => setFiltersOpen((o) => !o)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: T.fg2,
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 0.4,
            textTransform: "uppercase",
          }}
        >
          <span style={{ fontSize: 8 }}>{filtersOpen ? "▾" : "▸"}</span>
          <span>Filters</span>
          {tagFilters.length > 0 && (
            <span style={{ color: T.amber }}>· {tagFilters.length}</span>
          )}
        </button>
        {filtersOpen && (
          <div style={{ padding: "0 10px 8px" }}>
            {allTags.length === 0 && (
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  color: T.fg3,
                  padding: "2px 0 6px",
                }}
              >
                No tags yet — add some in the editor below.
              </div>
            )}
            {allTags.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {allTags.map((t) => {
                  const active = tagFilters.includes(t);
                  return (
                    <button
                      key={t}
                      onClick={() => toggleTagFilter(t)}
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9.5,
                        padding: "2px 7px",
                        background: active ? T.bg4 : T.bg2,
                        color: active ? T.fg : T.fg2,
                        border: `1px solid ${active ? T.borderStrong : T.border}`,
                        borderRadius: 3,
                        cursor: "pointer",
                      }}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── List header (count + sort) ──────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "4px 10px",
          borderBottom: `1px solid ${T.border}`,
          gap: 6,
          position: "relative",
        }}
      >
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.fg3 }}>
          {visiblePrompts.length === 1
            ? "1 prompt"
            : `${visiblePrompts.length} prompts`}
        </span>
        <span style={{ flex: 1 }} />
        <button
          data-menu
          onClick={() => setSortOpen((o) => !o)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontFamily: T.mono,
            fontSize: 10,
            color: T.fg2,
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "2px 4px",
          }}
        >
          {SORT_LABELS[sort]} <span style={{ fontSize: 8 }}>▾</span>
        </button>
        {sortOpen && (
          <div
            data-menu
            style={{
              position: "absolute",
              top: "100%",
              right: 8,
              zIndex: 20,
              background: T.bg2,
              border: `1px solid ${T.borderStrong}`,
              borderRadius: 5,
              padding: 4,
              minWidth: 100,
              boxShadow: "0 6px 18px rgba(0,0,0,0.4)",
            }}
          >
            {Object.entries(SORT_LABELS).map(([k, v]) => (
              <button
                key={k}
                onClick={() => {
                  setSort(k);
                  setSortOpen(false);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "4px 8px",
                  background: sort === k ? T.bg4 : "transparent",
                  border: "none",
                  borderRadius: 3,
                  cursor: "pointer",
                  color: sort === k ? T.fg : T.fg1,
                  fontFamily: T.mono,
                  fontSize: 10.5,
                }}
              >
                {v}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Two-column body: list + editor ──────────────────── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* List */}
        <div
          style={{
            width: effectiveListWidth,
            flexShrink: 0,
            overflowY: "auto",
            borderRight: `1px solid ${T.border}`,
            padding: "6px 0",
          }}
        >
          {visiblePrompts.length === 0 && (
            <div
              style={{
                padding: "20px 10px",
                color: T.fg3,
                fontFamily: T.sans,
                fontSize: 11.5,
                lineHeight: 1.5,
                textAlign: "center",
              }}
            >
              No prompts match.
              {anyFilterActive && (
                <div style={{ marginTop: 6, fontSize: 11 }}>
                  Try{" "}
                  <button
                    onClick={clearFilters}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      color: T.amber,
                      cursor: "pointer",
                      fontFamily: T.mono,
                      fontSize: 11,
                      textDecoration: "underline",
                      textUnderlineOffset: 2,
                    }}
                  >
                    clearing filters
                  </button>
                  .
                </div>
              )}
            </div>
          )}
          {visiblePrompts.map((p) => {
            const sel = p.id === selected.id;
            const favColor = p.favorite
              ? FAVORITE_COLOR_MAP[p.favorite]?.color
              : null;
            return (
              <div
                key={p.id}
                onClick={() => onSelect(p.id)}
                onDoubleClick={() => {
                  // Toggle attach/detach via the existing onUse path.
                  // Calling onSelect first keeps the row highlighted as
                  // selected (the single-click handler already ran, but
                  // being explicit makes the intent obvious and the call
                  // is idempotent so the double-fire is harmless).
                  onSelect(p.id);
                  onUse(p);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onSelect(p.id);
                  setMenu({ x: e.clientX, y: e.clientY, prompt: p });
                }}
                style={{
                  margin: "0 6px",
                  padding: "6px 8px",
                  borderRadius: 4,
                  background: sel ? T.bg4 : "transparent",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
                onMouseEnter={(e) =>
                  !sel && (e.currentTarget.style.background = T.bg3)
                }
                onMouseLeave={(e) =>
                  !sel && (e.currentTarget.style.background = "transparent")
                }
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {/* Favorite color dot (or an 8px placeholder so names align). */}
                  {/* Solid fill, no glow — at this size a halo desaturated */}
                  {/* the colors enough that they stopped being identifiable. */}
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 99,
                      background: favColor || "transparent",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      fontFamily: T.sans,
                      fontSize: 12,
                      color: sel ? T.fg : T.fg1,
                      fontWeight: sel ? 500 : 400,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {p.name}
                  </span>
                </div>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9.5,
                    color: T.fg3,
                    paddingLeft: 12,
                  }}
                >
                  {p.updated}
                </div>
              </div>
            );
          })}
        </div>

        {/* List/editor split — drag to resize the left column. The list's */}
        {/* own right border is the visible divider at rest; the Resizer is */}
        {/* a 4px transparent hit region that tints amber on hover.        */}
        <Resizer
          onDrag={(dx) => {
            if (dx === 0) listWidthStartRef.current = listWidth;
            const next = listWidthStartRef.current + dx;
            setListWidth(Math.max(100, Math.min(maxListWidth, next)));
          }}
        />

        {/* Editor */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          {/* Editor header */}
          <div
            style={{
              padding: "10px 12px 6px",
              borderBottom: `1px solid ${T.border}`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  background: "transparent",
                  color: T.fg,
                  fontFamily: T.sans,
                  fontSize: 13.5,
                  fontWeight: 500,
                  padding: 0,
                  outline: "none",
                }}
              />
            </div>

            {/* Favorite row — immediate save (not part of draft) */}
            {selected.id && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  marginBottom: 6,
                }}
              >
                <span
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    color: T.fg3,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    marginRight: 2,
                  }}
                >
                  Fav
                </span>
                <button
                  onClick={() => setFavoriteFor(selected.id, null)}
                  title="No favorite"
                  style={{
                    width: 12,
                    height: 12,
                    border: `1px solid ${!selected.favorite ? T.borderStrong : T.border}`,
                    background: !selected.favorite ? T.bg4 : "transparent",
                    borderRadius: 99,
                    cursor: "pointer",
                    padding: 0,
                    color: T.fg3,
                    fontFamily: T.mono,
                    fontSize: 8,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  ∅
                </button>
                {FAVORITE_COLORS.map((f) => {
                  const active = selected.favorite === f.id;
                  // Same 14×14 / ring-on-active treatment as the top FAV
                  // filter strip — keeps the two strips visually identical
                  // so the user reads them as the same control vocabulary.
                  return (
                    <button
                      key={f.id}
                      onClick={() => setFavoriteFor(selected.id, f.id)}
                      title={f.id}
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 99,
                        background: f.color,
                        border: `2px solid ${active ? T.fg : "transparent"}`,
                        cursor: "pointer",
                        padding: 0,
                      }}
                    />
                  );
                })}
              </div>
            )}

            {/* Tags */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                alignItems: "center",
              }}
            >
              {tags.map((t) => (
                <span
                  key={t}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    fontFamily: T.mono,
                    fontSize: 9.5,
                    padding: "1px 4px 1px 6px",
                    background: T.bg2,
                    color: T.fg2,
                    borderRadius: 3,
                    border: `1px solid ${T.border}`,
                  }}
                >
                  {t}
                  <button
                    onClick={() => removeTag(t)}
                    style={{
                      background: "none",
                      border: "none",
                      color: T.fg3,
                      cursor: "pointer",
                      padding: 0,
                      lineHeight: 1,
                      display: "inline-flex",
                    }}
                  >
                    <I.X size={8} />
                  </button>
                </span>
              ))}
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag(tagInput);
                  } else if (
                    e.key === "Backspace" &&
                    !tagInput &&
                    tags.length
                  ) {
                    removeTag(tags[tags.length - 1]);
                  }
                }}
                placeholder="+ tag"
                style={{
                  border: "none",
                  background: "transparent",
                  outline: "none",
                  color: T.fg2,
                  fontFamily: T.mono,
                  fontSize: 9.5,
                  width: 110,
                  padding: "1px 2px",
                }}
              />
              <span
                style={{
                  fontFamily: T.mono,
                  fontSize: 9.5,
                  color: T.fg3,
                  marginLeft: 4,
                }}
              >
                · edited {selected.updated}
              </span>
            </div>
          </div>

          {/* Body editor */}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            style={{
              flex: 1,
              border: "none",
              resize: "none",
              background: T.bg0,
              color: T.fg,
              fontFamily: T.mono,
              fontSize: 12,
              lineHeight: 1.6,
              padding: "12px 14px",
              minHeight: 0,
              outline: "none",
            }}
          />

          {/* Action bar */}
          <div
            style={{
              padding: 10,
              borderTop: `1px solid ${T.border}`,
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: T.bg1,
            }}
          >
            {dirty ? (
              <>
                <button
                  onClick={() => {
                    onUpdate(selected.id, {
                      name,
                      body: draft,
                      tags,
                    });
                  }}
                  style={{
                    height: 24,
                    padding: "0 10px",
                    background: T.amber,
                    border: "none",
                    borderRadius: 4,
                    color: T.bg0,
                    fontFamily: T.mono,
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Save changes
                </button>
                <button
                  onClick={() => {
                    setDraft(selected.body);
                    setName(selected.name);
                    setTags(selected.tags || []);
                  }}
                  style={{
                    height: 24,
                    padding: "0 10px",
                    background: "transparent",
                    border: `1px solid ${T.border}`,
                    borderRadius: 4,
                    color: T.fg2,
                    fontFamily: T.mono,
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  Discard
                </button>
                <span style={{ flex: 1 }} />
                <span
                  style={{ fontFamily: T.mono, fontSize: 10, color: T.amber }}
                >
                  ● unsaved
                </span>
              </>
            ) : (
              <>
                <button
                  onClick={() => onUse(selected)}
                  style={{
                    height: 24,
                    padding: "0 10px",
                    background: attachedIds.includes(selected.id)
                      ? T.amber
                      : T.bg4,
                    border: `1px solid ${attachedIds.includes(selected.id) ? T.amber : T.borderStrong}`,
                    borderRadius: 4,
                    color: attachedIds.includes(selected.id) ? T.bg0 : T.fg,
                    fontFamily: T.mono,
                    fontSize: 11,
                    fontWeight: 500,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  {attachedIds.includes(selected.id) ? (
                    <>
                      <I.Check size={10} /> Attached
                    </>
                  ) : (
                    <>
                      <I.Send size={10} /> Attach
                    </>
                  )}
                </button>
                <button
                  onClick={() => {
                    if (!onCreate || !selected.id) return;
                    onCreate({
                      name: selected.name + " (copy)",
                      tags: [...(selected.tags || [])],
                      body: selected.body,
                      favorite: selected.favorite,
                    });
                  }}
                  style={{
                    height: 24,
                    padding: "0 8px",
                    background: "transparent",
                    border: `1px solid ${T.border}`,
                    borderRadius: 4,
                    color: T.fg2,
                    fontFamily: T.mono,
                    fontSize: 11,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <I.Copy size={10} /> Duplicate
                </button>
                <span style={{ flex: 1 }} />
                <button
                  title={selected.builtin
                    ? "Delete built-in prompt (you can restore from Settings)"
                    : "Delete prompt"}
                  onClick={() => {
                    if (!onDelete || !selected.id) return;
                    setDeleteConfirm({ prompt: selected });
                  }}
                  style={{
                    width: 24,
                    height: 24,
                    background: "transparent",
                    border: "none",
                    color: T.fg3,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = T.red)}
                  onMouseLeave={(e) => (e.currentTarget.style.color = T.fg3)}
                >
                  <I.Trash size={11} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Delete-confirm dialog ────────────────────────────── */}
      {/* Same styled ConfirmDialog the Settings → Danger zone uses, */}
      {/* so the prompt-delete flow matches the chat-clear flow visually. */}
      <ConfirmDialog
        open={!!deleteConfirm}
        title="Delete prompt?"
        body={
          deleteConfirm?.prompt?.builtin ? (
            <>
              Delete the built-in prompt{" "}
              <b>"{deleteConfirm.prompt.name}"</b>? You can restore it from
              Settings → Restore built-in prompts.
            </>
          ) : (
            <>
              Delete the prompt{" "}
              <b>"{deleteConfirm?.prompt?.name}"</b>? This removes the .md
              file from your prompts directory.
            </>
          )
        }
        confirmText="Delete prompt"
        cancelText="Cancel"
        busy={deleteBusy}
        onConfirm={async () => {
          if (!deleteConfirm) return;
          setDeleteBusy(true);
          try {
            onDelete(deleteConfirm.prompt.id);
          } finally {
            setDeleteBusy(false);
            setDeleteConfirm(null);
          }
        }}
        onCancel={() => {
          if (!deleteBusy) setDeleteConfirm(null);
        }}
      />

      {/* ── Right-click context menu ─────────────────────────── */}
      {/* Fixed-position so it can escape the panel's overflow. The */}
      {/* outside-click hook above is in charge of closing it. */}
      {menu && (
        <div
          data-menu
          style={{
            position: "fixed",
            top: menu.y,
            left: menu.x,
            zIndex: 50,
            background: T.bg2,
            border: `1px solid ${T.borderStrong}`,
            borderRadius: 5,
            padding: 4,
            minWidth: 160,
            boxShadow: "0 8px 22px rgba(0,0,0,0.5)",
          }}
        >
          <div
            style={{
              padding: "4px 8px",
              fontFamily: T.mono,
              fontSize: 9,
              color: T.fg3,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Favorite
          </div>
          <div
            style={{
              display: "flex",
              gap: 4,
              padding: "2px 8px 6px",
              alignItems: "center",
            }}
          >
            <button
              onClick={() => setFavoriteFor(menu.prompt.id, null)}
              title="No favorite"
              style={{
                width: 14,
                height: 14,
                border: `1px solid ${!menu.prompt.favorite ? T.borderStrong : T.border}`,
                background: !menu.prompt.favorite ? T.bg4 : "transparent",
                color: T.fg3,
                borderRadius: 99,
                cursor: "pointer",
                fontFamily: T.mono,
                fontSize: 9,
                padding: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ∅
            </button>
            {FAVORITE_COLORS.map((f) => {
              const active = menu.prompt.favorite === f.id;
              // Matches the other two favorite-picker strips above — same
              // 14×14 / ring-on-active treatment, no opacity fade.
              return (
                <button
                  key={f.id}
                  onClick={() => setFavoriteFor(menu.prompt.id, f.id)}
                  title={f.id}
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 99,
                    background: f.color,
                    border: `2px solid ${active ? T.fg : "transparent"}`,
                    cursor: "pointer",
                    padding: 0,
                  }}
                />
              );
            })}
          </div>
          <div
            style={{
              height: 1,
              background: T.border,
              margin: "2px 0",
            }}
          />
          <button
            onClick={() => {
              if (onCreate) {
                onCreate({
                  name: menu.prompt.name + " (copy)",
                  tags: [...(menu.prompt.tags || [])],
                  body: menu.prompt.body,
                  favorite: menu.prompt.favorite,
                });
              }
              setMenu(null);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "5px 8px",
              background: "transparent",
              border: "none",
              borderRadius: 3,
              cursor: "pointer",
              color: T.fg1,
              fontFamily: T.mono,
              fontSize: 10.5,
              textAlign: "left",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = T.bg3)}
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <I.Copy size={10} /> Duplicate
          </button>
        </div>
      )}
    </aside>
  );
}
