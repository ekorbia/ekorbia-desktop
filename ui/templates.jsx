// templates.jsx — Templates: the Settings pane, the editor, and the cards a
// new chat offers.
//
// A template is a saved instruction with a name. It is the same Markdown
// file the app has always called a prompt (name + optional description,
// hint and tags in the frontmatter, the instruction as the body), kept in
// the same folder; only the word and the controls changed. The Rust
// commands and much of the code still say "prompt".
//
// Depends on: tokens (T, ek* styles), atoms, icons, utils (sortTemplates,
// filterTemplates, isStarred).

'use strict';

// The star on a row. Filled when on.
function TemplateStar({ on, onClick, name }) {
  return (
    <button
      type="button"
      data-template-star
      aria-pressed={!!on}
      aria-label={on ? `Remove the star from ${name}` : `Star ${name}`}
      title={
        on
          ? "Starred: on a new chat's cards and in the + menu. Click to remove."
          : "Star it to put it on a new chat's cards and in the + menu."
      }
      onClick={(e) => {
        e.stopPropagation();
        onClick && onClick();
      }}
      style={{
        width: 28,
        height: 28,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        borderRadius: 7,
        padding: 0,
        cursor: "pointer",
        color: on ? T.amber : T.fg3,
        flexShrink: 0,
      }}
    >
      <I.Star size={15} fill={on ? "currentColor" : "none"} />
    </button>
  );
}

// ─── Settings → Templates ───────────────────────────────────
//
//   templates      rows from prompts_list (one-chat `_virtual` rows are
//                  dropped here)
//   onSave(t)      → Promise<slug|null>; t = { id?, name, description,
//                  hint, body } — no id means a new template
//   onDelete(id), onDuplicate(id) → Promise
//   onToggleStar(id)
//   onChanged()    re-read the folder (after it is changed or restored)
//   openRequest    { id | "new", n } — open that template's editor; `n`
//                  changes on every request so the same one can reopen
function TemplatesSettings({
  templates = [],
  onSave,
  onDelete,
  onDuplicate,
  onToggleStar,
  onChanged,
  openRequest = null,
}) {
  const invoke = getInvoke();
  const dialogApi = getDialogApi();
  const [query, setQuery] = useState("");
  // null | { id: string | null } (null id = a new template)
  const [editing, setEditing] = useState(null);
  const [folder, setFolder] = useState("");
  const [status, setStatus] = useState(null); // { ok, msg }
  const [confirmRestore, setConfirmRestore] = useState(false);

  useEffect(() => {
    if (!invoke) return;
    invoke("prompts_dir_get").then((p) => setFolder(p || "")).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!openRequest) return;
    setEditing({ id: openRequest.id === "new" ? null : openRequest.id });
  }, [openRequest && openRequest.n]);

  const all = sortTemplates(templates);
  const shown = filterTemplates(templates, query);
  const current = editing && editing.id ? all.find((t) => t.id === editing.id) || null : null;
  // The template being edited was deleted from the folder meanwhile.
  useEffect(() => {
    if (editing && editing.id && !current) setEditing(null);
  }, [editing, current]);

  const chooseFolder = async () => {
    if (!dialogApi || !invoke) return;
    try {
      const picked = await dialogApi.open({ directory: true, multiple: false, title: "Choose the templates folder" });
      const next = picked ? (typeof picked === "string" ? picked : picked.path) : null;
      if (!next) return;
      await invoke("prompts_dir_set", { path: next });
      setFolder(next);
      setStatus({ ok: true, msg: "Now using that folder." });
      if (onChanged) await onChanged();
    } catch (e) {
      setStatus({ ok: false, msg: String(e) });
    }
  };
  const openFolder = async () => {
    if (!invoke) return;
    try {
      await invoke("prompts_dir_reveal");
    } catch (e) {
      setStatus({ ok: false, msg: `Could not open the folder: ${e}` });
    }
  };
  const restore = async () => {
    if (!invoke) return;
    setConfirmRestore(false);
    try {
      const n = await invoke("prompts_restore_builtins");
      setStatus({ ok: true, msg: `Restored ${n} starter template${n === 1 ? "" : "s"}.` });
      if (onChanged) await onChanged();
    } catch (e) {
      setStatus({ ok: false, msg: String(e) });
    }
  };

  const link = {
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    fontFamily: T.sans,
    fontSize: 12,
    color: T.amber,
  };

  return (
    <div data-templates-settings style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ fontFamily: T.sans, fontSize: 17, fontWeight: 600, color: T.fg }}>Templates</div>
        <div style={ekHint({ fontSize: 12.5, marginTop: 3 })}>
          Saved instructions you can choose in a chat. A star puts one on a
          new chat's cards and in the + menu.
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <span
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              display: "inline-flex",
              color: T.fg2,
              pointerEvents: "none",
            }}
          >
            <I.Search size={13} />
          </span>
          <input
            data-template-search
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search templates"
            style={ekField({ paddingLeft: 30 })}
          />
        </div>
        <button data-template-new onClick={() => setEditing({ id: null })} style={ekBtn("secondary")}>
          <I.Plus size={12} />
          New
        </button>
      </div>

      <div data-template-list style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {all.length === 0 && (
          <div data-template-empty style={ekHint({ padding: "14px 2px" })}>
            No templates yet. Choose New to write one, or restore the starter set below.
          </div>
        )}
        {all.length > 0 && shown.length === 0 && (
          <div data-template-empty style={ekHint({ padding: "14px 2px" })}>
            No template matches “{query.trim()}”.
          </div>
        )}
        {shown.map((t) => (
          <div
            key={t.id}
            data-template-row
            data-template-id={t.id}
            data-starred={isStarred(t) ? "true" : "false"}
            role="button"
            tabIndex={0}
            onClick={() => setEditing({ id: t.id })}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setEditing({ id: t.id });
              }
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = T.bg2)}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px 6px 4px",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            <TemplateStar on={isStarred(t)} name={t.name} onClick={() => onToggleStar && onToggleStar(t.id)} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                data-template-name
                style={{
                  fontFamily: T.sans,
                  fontSize: 13,
                  fontWeight: 600,
                  color: T.fg,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {t.name}
              </div>
              {t.description && (
                <div
                  data-template-description
                  style={ekHint({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}
                >
                  {t.description}
                </div>
              )}
            </div>
            <span style={{ display: "inline-flex", color: T.fg3, flexShrink: 0 }}>
              <I.ChevronR size={12} />
            </span>
          </div>
        ))}
      </div>

      <div
        data-template-folder
        style={{
          ...ekHint(),
          borderTop: `1px solid ${T.border}`,
          paddingTop: 10,
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        <div style={{ overflowWrap: "anywhere" }}>
          Kept as files in <span data-template-folder-path>{folder || "…"}</span>.
        </div>
        {confirmRestore ? (
          <div data-template-restore-confirm style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ color: T.fg1 }}>
              This puts the starter templates back as they shipped. Any changes
              you made to them are lost; your own templates are not touched.
            </span>
            <button data-template-restore-yes onClick={restore} style={ekBtn("secondary", { small: true })}>
              Restore
            </button>
            <button onClick={() => setConfirmRestore(false)} style={ekBtn("quiet", { small: true })}>
              Cancel
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button data-template-open-folder onClick={openFolder} style={link}>
              Open folder
            </button>
            <span>·</span>
            <button data-template-choose-folder onClick={chooseFolder} style={link}>
              Use another folder…
            </button>
            <span>·</span>
            <button data-template-restore onClick={() => setConfirmRestore(true)} style={link}>
              Restore the starter set
            </button>
          </div>
        )}
        {status && (
          <div data-template-status style={{ color: status.ok ? T.fg1 : T.red }}>{status.msg}</div>
        )}
      </div>

      {editing && (
        <TemplateEditor
          key={editing.id || "new"}
          template={current}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            const slug = onSave ? await onSave(draft) : null;
            if (slug) setEditing(null);
            return slug;
          }}
          onDelete={async (id) => {
            if (onDelete) await onDelete(id);
            setEditing(null);
          }}
          onDuplicate={async (id) => {
            const slug = onDuplicate ? await onDuplicate(id) : null;
            // Carry on in the copy, which is what was asked for.
            setEditing(slug ? { id: slug } : null);
          }}
        />
      )}
    </div>
  );
}

// ─── The editor ─────────────────────────────────────────────
// Four fields. Saving writes the same Markdown file a text editor would.
// `template` null = a new one.
function TemplateEditor({ template, onClose, onSave, onDelete, onDuplicate }) {
  const isNew = !template;
  const [name, setName] = useState(template ? template.name || "" : "");
  const [description, setDescription] = useState(template ? template.description || "" : "");
  const [hint, setHint] = useState(template ? template.hint || "" : "");
  const [body, setBody] = useState(template ? template.body || "" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (isNew && nameRef.current) nameRef.current.focus();
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSave = !!name.trim() && !!body.trim() && !busy;
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError("");
    try {
      const slug = await onSave({
        id: template ? template.id : null,
        name: name.trim(),
        description: description.trim(),
        hint: hint.trim(),
        body,
      });
      if (!slug) setError("That could not be saved. Check the templates folder still exists.");
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  const label = (text, htmlFor, note) => (
    <label htmlFor={htmlFor} style={{ display: "block", marginBottom: 5 }}>
      <span style={{ fontFamily: T.sans, fontSize: 12, fontWeight: 500, color: T.fg }}>{text}</span>
      {note && <span style={ekHint({ marginLeft: 6 })}>{note}</span>}
    </label>
  );

  return (
    <div
      data-template-editor-backdrop
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        data-template-editor
        data-template-id={template ? template.id : ""}
        role="dialog"
        aria-label={isNew ? "New template" : `Edit ${template.name}`}
        style={{
          width: 560,
          maxWidth: "calc(100vw - 40px)",
          maxHeight: "calc(100vh - 60px)",
          display: "flex",
          flexDirection: "column",
          background: panelGrad(),
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 14,
          boxShadow: `${T.shadowPop}, ${T.insetHi}`,
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "18px 22px 4px", fontFamily: T.sans, fontSize: 17, fontWeight: 600, color: T.fg }}>
          {isNew ? "New template" : template.name}
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "10px 22px 4px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div>
            {label("Name", "ek-tpl-name")}
            <input
              id="ek-tpl-name"
              ref={nameRef}
              data-template-field="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              style={ekField()}
            />
          </div>
          <div>
            {label("Description", "ek-tpl-description", "one line, shown under the name")}
            <input
              id="ek-tpl-description"
              data-template-field="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={120}
              style={ekField()}
            />
          </div>
          <div>
            {label("Hint shown in the message box", "ek-tpl-hint", "optional")}
            <input
              id="ek-tpl-hint"
              data-template-field="hint"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              maxLength={120}
              placeholder="Dictate or paste your notes"
              style={ekField()}
            />
          </div>
          <div>
            {label("Instructions", "ek-tpl-body")}
            <textarea
              id="ek-tpl-body"
              data-template-field="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={9}
              placeholder="Say what the model should do with whatever it is given next."
              style={ekField({ resize: "vertical", minHeight: 150, lineHeight: 1.5 })}
            />
          </div>
          {error && (
            <div data-template-error style={ekHint({ color: T.red })}>
              {error}
            </div>
          )}
        </div>
        <div style={{ padding: "12px 22px 18px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {!isNew && !confirmDelete && (
            <>
              <button data-template-delete onClick={() => setConfirmDelete(true)} style={ekBtn("danger")}>
                Delete…
              </button>
              <button data-template-duplicate onClick={() => onDuplicate(template.id)} style={ekBtn("secondary")}>
                Duplicate
              </button>
            </>
          )}
          {!isNew && confirmDelete && (
            <>
              <span style={ekHint({ color: T.fg1 })}>Delete this template and its file?</span>
              <button
                data-template-delete-yes
                onClick={() => onDelete(template.id)}
                style={{ ...ekBtn("primary"), background: T.red, border: `1px solid ${T.red}`, color: "#fff" }}
              >
                Delete
              </button>
              <button onClick={() => setConfirmDelete(false)} style={ekBtn("quiet")}>
                Keep it
              </button>
            </>
          )}
          <span style={{ flex: 1 }} />
          <button data-template-cancel onClick={onClose} style={ekBtn("secondary")}>
            Cancel
          </button>
          <button
            data-template-save
            onClick={save}
            disabled={!canSave}
            style={ekBtn("primary", { disabled: !canSave })}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── The cards on a new chat ────────────────────────────────
// Starred templates, up to six. Choosing one turns it on for this chat.
function TemplateCards({ templates = [], activeIds = [], onUse, onAll }) {
  const cards = starredTemplates(templates, 6);
  const on = new Set(activeIds || []);
  return (
    <div data-template-cards>
      {cards.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            gap: 12,
            textAlign: "left",
          }}
        >
          {cards.map((t) => {
            const active = on.has(t.id);
            return (
              <button
                key={t.id}
                type="button"
                data-template-card={t.id}
                aria-pressed={active}
                onClick={() => onUse && onUse(t.id)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  minHeight: 66,
                  textAlign: "left",
                  background: T.isLight ? T.bg0 : T.bg1,
                  border: `1px solid ${active ? T.fg : T.border}`,
                  boxShadow: active ? `0 0 0 1px ${T.fg}` : "none",
                  borderRadius: 12,
                  padding: "11px 14px",
                  cursor: "pointer",
                  fontFamily: T.sans,
                }}
              >
                <span style={{ color: T.fg, fontSize: 13.5, fontWeight: 600 }}>{t.name}</span>
                {t.description && (
                  <span style={{ color: T.fg2, fontSize: 12, lineHeight: 1.4 }}>{t.description}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {onAll && (
        <button
          type="button"
          data-template-all
          onClick={onAll}
          style={{
            marginTop: cards.length ? 14 : 0,
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            fontFamily: T.sans,
            fontSize: 12.5,
            color: T.fg2,
          }}
        >
          All templates
        </button>
      )}
    </div>
  );
}

Object.assign(window, { TemplateStar, TemplatesSettings, TemplateEditor, TemplateCards });
