// SPDX-License-Identifier: MIT

//! Prompts (file-system store).
#![allow(clippy::needless_pass_by_value)]

//!
//! Prompts live as Markdown files with YAML frontmatter in a user-configured
//! directory (default ~/Documents/Ekorbia/Prompts). The filename (sans .md)
//! is the prompt's stable id ("slug"). Sharing a prompt = sharing one file.
//!
//! SQLite holds only `prompt_meta`: per-user UI preferences (favorite color,
//! etc.) that should NOT travel with a shared file. Joined to file data at
//! read time, keyed by slug.
//!
//! Built-ins are baked into the binary via include_str! (see BUILTIN_PROMPTS)
//! and copied into the prompts dir on first launch, after which they're just
//! files the user owns and can edit/delete freely.

use crate::db::{file_mtime_unix, get_setting, now_unix, set_setting, DbState};
use crate::log::log_warn;

/// Max suffix attempts (`base-2`, `base-3`, …) before `dedupe_slug` gives up
/// and appends a unix-timestamp suffix to guarantee progress. The loop
/// terminates either way; this just keeps the suffix short for the common case.
const SLUG_DEDUP_MAX_ATTEMPTS: u32 = 1000;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub(crate) struct PromptFrontmatter {
    name: String,
    tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Prompt {
    /// Filename without `.md`. Stable across renames (renaming a prompt's
    /// display name does NOT rename the file in v1 — keeps file IDs sticky
    /// and avoids churn for downstream watchers / git history).
    id: String,
    name: String,
    tags: Vec<String>,
    body: String,
    /// One of FAVORITE_COLORS ids ("amber" | "blue" | ...) or None.
    /// Lives in `prompt_meta` so it doesn't leak into shared files.
    favorite: Option<String>,
    /// True if this slug matches a known built-in (used by the UI to gate
    /// "this is a built-in" UI affordances; built-ins are NOT read-only —
    /// the user can edit or delete them freely).
    builtin: bool,
    /// File mtime (unix seconds). Used for "Recent" sort.
    updated_at: i64,
}

/// Built-in prompts baked into the binary at compile time. The first tuple
/// element is the slug (filename without `.md`); the second is the full file
/// contents (YAML frontmatter + body). On first launch we copy any missing
/// built-ins into the user's prompts directory; after that they're just
/// regular files the user can edit, rename, or delete.
const BUILTIN_PROMPTS: &[(&str, &str)] = &[
    (
        "explain-simply",
        include_str!("../builtin-prompts/explain-simply.md"),
    ),
    ("summarize", include_str!("../builtin-prompts/summarize.md")),
    (
        "translate-spanish",
        include_str!("../builtin-prompts/translate-spanish.md"),
    ),
    (
        "translate-french",
        include_str!("../builtin-prompts/translate-french.md"),
    ),
    (
        "translate-german",
        include_str!("../builtin-prompts/translate-german.md"),
    ),
    (
        "brainstorm",
        include_str!("../builtin-prompts/brainstorm.md"),
    ),
    (
        "sensitive-doc-qa",
        include_str!("../builtin-prompts/sensitive-doc-qa.md"),
    ),
    (
        "notes-synthesizer",
        include_str!("../builtin-prompts/notes-synthesizer.md"),
    ),
    (
        "email-draft",
        include_str!("../builtin-prompts/email-draft.md"),
    ),
    (
        "website-personal",
        include_str!("../builtin-prompts/website-personal.md"),
    ),
    (
        "website-professional",
        include_str!("../builtin-prompts/website-professional.md"),
    ),
    (
        "game-text-adventure",
        include_str!("../builtin-prompts/game-text-adventure.md"),
    ),
    (
        "game-lateral-thinking",
        include_str!("../builtin-prompts/game-lateral-thinking.md"),
    ),
    (
        "game-murder-mystery",
        include_str!("../builtin-prompts/game-murder-mystery.md"),
    ),
    (
        "log-triage",
        include_str!("../builtin-prompts/log-triage.md"),
    ),
    (
        "resume-coach",
        include_str!("../builtin-prompts/resume-coach.md"),
    ),
    (
        "cover-letter",
        include_str!("../builtin-prompts/cover-letter.md"),
    ),
    (
        "careers-watcher",
        include_str!("../builtin-prompts/careers-watcher.md"),
    ),
    (
        "tone-reframer",
        include_str!("../builtin-prompts/tone-reframer.md"),
    ),
    (
        "devils-advocate",
        include_str!("../builtin-prompts/devils-advocate.md"),
    ),
    (
        "paper-tracker",
        include_str!("../builtin-prompts/paper-tracker.md"),
    ),
    (
        "wikipedia-watch",
        include_str!("../builtin-prompts/wikipedia-watch.md"),
    ),
    (
        "price-watcher",
        include_str!("../builtin-prompts/price-watcher.md"),
    ),
    (
        "new-listings-watcher",
        include_str!("../builtin-prompts/new-listings-watcher.md"),
    ),
    (
        "rental-watcher",
        include_str!("../builtin-prompts/rental-watcher.md"),
    ),
    (
        "gcp-uptime",
        include_str!("../builtin-prompts/gcp-uptime.md"),
    ),
    (
        "cloudflare-uptime",
        include_str!("../builtin-prompts/cloudflare-uptime.md"),
    ),
    (
        "how-does-it-end",
        include_str!("../builtin-prompts/how-does-it-end.md"),
    ),
    (
        "cliff-notes",
        include_str!("../builtin-prompts/cliff-notes.md"),
    ),
    (
        "should-i-watch",
        include_str!("../builtin-prompts/should-i-watch.md"),
    ),
    (
        "album-deep-dive",
        include_str!("../builtin-prompts/album-deep-dive.md"),
    ),
];

fn is_builtin_slug(slug: &str) -> bool {
    BUILTIN_PROMPTS.iter().any(|(s, _)| *s == slug)
}

/// Compute the default prompts directory: `<home>/Documents/Ekorbia/Prompts`.
/// Falls back to the app data dir if the home dir can't be resolved (rare —
/// happens in sandboxed environments / CI). The path is returned even if it
/// doesn't exist yet; callers create it as needed.
fn default_prompts_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    if let Some(home) = dirs::document_dir() {
        return home.join("Ekorbia").join("Prompts");
    }
    app.path()
        .app_data_dir()
        .map(|p| p.join("prompts"))
        .unwrap_or_else(|_| std::path::PathBuf::from("./prompts"))
}

/// Resolve the configured prompts directory, falling back to the default.
/// Does not create the directory — `ensure_prompts_dir` does that. Used by
/// the watch pipeline's `fetch_prompt_body` too, so this stays pub(crate).
pub(crate) fn resolve_prompts_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    let db = app.state::<DbState>();
    if let Ok(conn) = db.0.lock() {
        if let Some(p) = get_setting(&conn, "prompts_dir") {
            if !p.is_empty() {
                return std::path::PathBuf::from(p);
            }
        }
    }
    default_prompts_dir(app)
}

/// Create the prompts dir if it doesn't exist. Returns the path.
fn ensure_prompts_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = resolve_prompts_dir(app);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create prompts directory {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Slugify a display name into `[a-z0-9-]+` with prompt-library-specific
/// empty fallback. Thin wrapper over `db::slugify` — see that for the core
/// algorithm. Returns `"prompt"` when the input slugifies to empty (e.g. user
/// typed only emoji or punctuation) so a valid `.md` filename is always
/// available.
fn slugify(s: &str) -> String {
    let v = crate::db::slugify(s, None);
    if v.is_empty() {
        "prompt".into()
    } else {
        v
    }
}

/// Resolve a fresh, non-colliding slug under `dir`. If the candidate doesn't
/// exist, returns it unchanged; otherwise appends `-2`, `-3`, … until it
/// finds a free slot. After `SLUG_DEDUP_MAX_ATTEMPTS` (vanishingly unlikely)
/// appends a timestamp suffix to guarantee progress.
fn dedupe_slug(dir: &std::path::Path, base: &str) -> String {
    if !dir.join(format!("{base}.md")).exists() {
        return base.to_string();
    }
    for n in 2..SLUG_DEDUP_MAX_ATTEMPTS {
        let cand = format!("{base}-{n}");
        if !dir.join(format!("{cand}.md")).exists() {
            return cand;
        }
    }
    format!("{base}-{}", now_unix())
}

/// Parse a Markdown file with optional YAML frontmatter. Robust to files
/// that have no frontmatter at all (treated as body-only with default
/// metadata) and to malformed YAML (returns default frontmatter so the file
/// still loads — frontmatter errors should never make a prompt disappear).
pub(crate) fn parse_prompt_file(text: &str) -> (PromptFrontmatter, String) {
    let mut lines = text.lines();
    let first = lines.next();
    if first != Some("---") {
        return (PromptFrontmatter::default(), text.to_string());
    }
    let mut fm_lines: Vec<&str> = Vec::new();
    let mut found_end = false;
    for line in lines.by_ref() {
        if line == "---" {
            found_end = true;
            break;
        }
        fm_lines.push(line);
    }
    if !found_end {
        return (PromptFrontmatter::default(), text.to_string());
    }
    let fm_text = fm_lines.join("\n");
    let body = lines.collect::<Vec<&str>>().join("\n");
    let fm: PromptFrontmatter = serde_yaml::from_str(&fm_text).unwrap_or_default();
    (fm, body.trim_start_matches('\n').to_string())
}

/// Render a prompt back to file form: YAML frontmatter + blank line + body.
fn render_prompt_file(fm: &PromptFrontmatter, body: &str) -> Result<String, String> {
    let yaml = serde_yaml::to_string(fm).map_err(|e| format!("YAML emit failed: {e}"))?;
    Ok(format!("---\n{yaml}---\n{body}"))
}

fn load_prompt_meta(conn: &Connection, slug: &str) -> Option<String> {
    conn.query_row(
        "SELECT favorite FROM prompt_meta WHERE slug = ?1",
        [slug],
        |row| row.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

#[tauri::command]
pub(crate) fn prompts_dir_get(app: tauri::AppHandle) -> Result<String, String> {
    Ok(resolve_prompts_dir(&app).to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn prompts_dir_set(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    std::fs::create_dir_all(&p).map_err(|e| format!("Could not create directory {path}: {e}"))?;
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    set_setting(&conn, "prompts_dir", &path)
}

/// Open the configured prompts directory in the OS file manager.
/// Replaces a previous `shellApi.open(path)` from the JS side that the
/// tauri-plugin-shell default scope regex silently rejected. We re-resolve
/// the path through `resolve_prompts_dir` so the JS caller has no way to
/// pass an arbitrary path — the dir is always the one the app currently
/// reads prompts from.
#[tauri::command]
pub(crate) fn prompts_dir_reveal(app: tauri::AppHandle) -> Result<(), String> {
    let dir = resolve_prompts_dir(&app);
    if !dir.exists() {
        return Err(format!("prompts dir does not exist: {}", dir.display()));
    }
    crate::files::commands::spawn_opener(&dir.to_string_lossy(), false)
}

#[tauri::command]
pub(crate) fn prompts_list(app: tauri::AppHandle) -> Result<Vec<Prompt>, String> {
    let dir = ensure_prompts_dir(&app)?;
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut out: Vec<Prompt> = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Read prompts dir failed: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // Only consider .md files. Other files (LICENSE, README, .DS_Store)
        // sharing the directory are silently skipped.
        let is_md = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_md {
            continue;
        }
        let slug = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let text = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                log_warn!("prompts_list: skip {}: {e}", path.display());
                continue;
            }
        };
        let (fm, body) = parse_prompt_file(&text);
        let display_name = if fm.name.trim().is_empty() {
            slug.clone()
        } else {
            fm.name
        };
        let favorite = load_prompt_meta(&conn, &slug);
        out.push(Prompt {
            id: slug.clone(),
            name: display_name,
            tags: fm.tags,
            body,
            favorite,
            builtin: is_builtin_slug(&slug),
            // Unreadable mtime → now_unix so a broken file still sorts at the
            // top of the "Recent" list rather than the bottom. See
            // `db::file_mtime_unix` doc for fallback semantics rationale.
            updated_at: file_mtime_unix(&path).unwrap_or_else(now_unix),
        });
    }
    // Descending by updated_at = ascending by negated value, expressed via
    // sort_by_key for clarity. Reverse() avoids the cmp() closure boilerplate.
    out.sort_by_key(|p| std::cmp::Reverse(p.updated_at));
    Ok(out)
}

/// Write a prompt to disk. `slug` is the desired filename stem; pass `""`
/// (or the slugified name) for new prompts and the prompt's existing id for
/// updates. Returns the slug actually written — equal to the input for
/// updates, but possibly suffixed (`-2`, `-3`) on creation if the slug was
/// already taken.
#[tauri::command]
pub(crate) fn prompts_save(
    app: tauri::AppHandle,
    slug: String,
    name: String,
    tags: Vec<String>,
    body: String,
) -> Result<String, String> {
    let dir = ensure_prompts_dir(&app)?;
    let trimmed_slug = slug.trim();
    let final_slug = if trimmed_slug.is_empty() {
        // New prompt: derive slug from name, dedupe against the dir.
        let base = slugify(&name);
        dedupe_slug(&dir, &base)
    } else {
        // Update: keep the existing slug (renames are intentionally
        // out-of-scope for v1 — file id stays sticky).
        trimmed_slug.to_string()
    };
    let fm = PromptFrontmatter { name, tags };
    let content = render_prompt_file(&fm, &body)?;
    let path = dir.join(format!("{final_slug}.md"));
    std::fs::write(&path, content).map_err(|e| format!("Write {}: {e}", path.display()))?;
    Ok(final_slug)
}

#[tauri::command]
pub(crate) fn prompts_delete(app: tauri::AppHandle, slug: String) -> Result<(), String> {
    let dir = ensure_prompts_dir(&app)?;
    let path = dir.join(format!("{slug}.md"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Delete {}: {e}", path.display()))?;
    }
    // Also drop the meta row so a re-created prompt with the same slug
    // doesn't inherit the deleted prompt's favorite color. Failure is
    // non-fatal — the prompt file is already gone, the worst case is a
    // stale meta row that gets overwritten on a future meta_set or sits
    // harmlessly until the prompt is recreated. Logged so a pattern of
    // failures is visible.
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if let Err(e) = conn.execute("DELETE FROM prompt_meta WHERE slug = ?1", [&slug]) {
        log_warn!("prompt_meta cleanup for {slug} failed: {e}");
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn prompts_meta_set(
    app: tauri::AppHandle,
    slug: String,
    favorite: Option<String>,
) -> Result<(), String> {
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO prompt_meta (slug, favorite) VALUES (?1, ?2) \
         ON CONFLICT(slug) DO UPDATE SET favorite = excluded.favorite",
        (&slug, &favorite),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Copy any built-in prompts that aren't already present in the prompts dir.
/// Idempotent: once a built-in file exists in the dir, this skips it — so
/// user edits to a built-in are preserved across launches. Stamps a flag in
/// app_settings so the very first run is distinguishable from later ones.
#[tauri::command]
pub(crate) fn prompts_seed_builtins(app: tauri::AppHandle) -> Result<u32, String> {
    let dir = ensure_prompts_dir(&app)?;
    let mut written = 0u32;
    for (slug, contents) in BUILTIN_PROMPTS {
        let path = dir.join(format!("{slug}.md"));
        if path.exists() {
            continue;
        }
        std::fs::write(&path, contents).map_err(|e| format!("Seed {}: {e}", path.display()))?;
        written += 1;
    }
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    set_setting(&conn, "builtins_seeded_v1", "1")?;
    Ok(written)
}

/// Overwrite all built-in prompts from the embedded copies, regardless of
/// existing files. Useful when the user wants to revert local edits, or has
/// deleted a built-in and wants it back. User-created prompts are untouched.
#[tauri::command]
pub(crate) fn prompts_restore_builtins(app: tauri::AppHandle) -> Result<u32, String> {
    let dir = ensure_prompts_dir(&app)?;
    let mut written = 0u32;
    for (slug, contents) in BUILTIN_PROMPTS {
        let path = dir.join(format!("{slug}.md"));
        std::fs::write(&path, contents).map_err(|e| format!("Restore {}: {e}", path.display()))?;
        written += 1;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmpdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ekorbia-prompts-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // ── slugify ────────────────────────────────────────────────────────────

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Hello World"), "hello-world");
    }

    #[test]
    fn slugify_lowercases() {
        assert_eq!(slugify("UPPER"), "upper");
    }

    #[test]
    fn slugify_collapses_runs_of_non_alphanum() {
        assert_eq!(slugify("foo   ---  bar"), "foo-bar");
    }

    #[test]
    fn slugify_trims_leading_and_trailing_dashes() {
        assert_eq!(slugify("  hello  "), "hello");
        assert_eq!(slugify("---hello---"), "hello");
    }

    #[test]
    fn slugify_empty_input_falls_back_to_prompt() {
        // Documented contract: emoji-only / punctuation-only / empty input
        // must still produce a valid filename rather than blowing up the
        // file-system save.
        assert_eq!(slugify(""), "prompt");
        assert_eq!(slugify("!!!"), "prompt");
        assert_eq!(slugify("   "), "prompt");
        assert_eq!(slugify("🎉🎉"), "prompt");
    }

    #[test]
    fn slugify_preserves_alphanum() {
        assert_eq!(slugify("abc123"), "abc123");
        assert_eq!(slugify("abc 123"), "abc-123");
    }

    // ── dedupe_slug ────────────────────────────────────────────────────────

    #[test]
    fn dedupe_slug_returns_base_when_free() {
        let dir = tmpdir();
        assert_eq!(dedupe_slug(&dir, "fresh"), "fresh");
    }

    #[test]
    fn dedupe_slug_appends_2_on_collision() {
        let dir = tmpdir();
        fs::write(dir.join("taken.md"), "").unwrap();
        assert_eq!(dedupe_slug(&dir, "taken"), "taken-2");
    }

    #[test]
    fn dedupe_slug_appends_3_when_2_also_taken() {
        let dir = tmpdir();
        fs::write(dir.join("taken.md"), "").unwrap();
        fs::write(dir.join("taken-2.md"), "").unwrap();
        assert_eq!(dedupe_slug(&dir, "taken"), "taken-3");
    }

    // ── is_builtin_slug ────────────────────────────────────────────────────

    #[test]
    fn is_builtin_slug_recognises_known() {
        // Sanity: a handful of well-known built-in slugs from
        // BUILTIN_PROMPTS must return true.
        assert!(is_builtin_slug("explain-simply"));
        assert!(is_builtin_slug("summarize"));
        assert!(is_builtin_slug("brainstorm"));
    }

    #[test]
    fn is_builtin_slug_rejects_unknown() {
        assert!(!is_builtin_slug("my-custom-prompt"));
        assert!(!is_builtin_slug(""));
        // Case-sensitive — slugs are always lowercase on disk.
        assert!(!is_builtin_slug("Summarize"));
    }

    // ── parse_prompt_file ──────────────────────────────────────────────────

    #[test]
    fn parse_prompt_file_no_frontmatter_returns_default_and_full_body() {
        let body = "# Title\n\nJust a body, no frontmatter.";
        let (fm, parsed) = parse_prompt_file(body);
        assert_eq!(fm.name, "");
        assert!(fm.tags.is_empty());
        assert_eq!(parsed, body);
    }

    #[test]
    fn parse_prompt_file_with_valid_frontmatter() {
        let text = "---\nname: My Prompt\ntags:\n  - alpha\n  - beta\n---\nBody here.";
        let (fm, body) = parse_prompt_file(text);
        assert_eq!(fm.name, "My Prompt");
        assert_eq!(fm.tags, vec!["alpha".to_string(), "beta".to_string()]);
        assert_eq!(body, "Body here.");
    }

    #[test]
    fn parse_prompt_file_unterminated_frontmatter_treated_as_body() {
        // Documented contract: "frontmatter errors should never make a
        // prompt disappear". An opening `---` with no closing one means
        // we treat the whole file as body with default metadata.
        let text = "---\nname: oops\nno closing marker\nfoo bar";
        let (fm, body) = parse_prompt_file(text);
        assert_eq!(fm.name, "");
        assert_eq!(body, text);
    }

    #[test]
    fn parse_prompt_file_malformed_yaml_falls_back_to_default() {
        // YAML parse error → default frontmatter, body still extracted.
        // The user sees a prompt with no display name (slug fallback) but
        // doesn't lose the prompt entirely.
        let text = "---\nname: [unclosed\n---\nBody survives.";
        let (fm, body) = parse_prompt_file(text);
        assert_eq!(fm.name, "");
        assert!(fm.tags.is_empty());
        assert_eq!(body, "Body survives.");
    }

    #[test]
    fn parse_prompt_file_strips_leading_blank_lines_from_body() {
        // The closing `---` is typically followed by a blank line; the
        // body shouldn't include it.
        let text = "---\nname: X\n---\n\n\nReal body.";
        let (_, body) = parse_prompt_file(text);
        assert_eq!(body, "Real body.");
    }
}
