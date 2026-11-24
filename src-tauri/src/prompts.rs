// SPDX-License-Identifier: MIT

//! Templates (file-system store). The app calls them templates; the code,
//! the commands and the folder keep the older word "prompt".
#![allow(clippy::needless_pass_by_value)]

//!
//! Prompts live as Markdown files with YAML frontmatter in a user-configured
//! directory (default ~/Documents/Ekorbia/Prompts). The filename (sans .md)
//! is the prompt's stable id ("slug"). Sharing a prompt = sharing one file.
//!
//! Frontmatter: `name`, plus three optional lines — `description` (the one
//! line under the name on a card), `hint` (what the message box says while
//! the template is on) and `tags` (kept, no longer shown). A file with none
//! of them still loads.
//!
//! SQLite holds only `prompt_meta`: per-user preferences that should NOT
//! travel with a shared file — today, whether it is starred (`favorite` is
//! non-null; older installs stored a colour name there, which still counts).
//! Joined to file data at read time, keyed by slug.
//!
//! The starter set is baked into the binary via include_str! (see
//! BUILTIN_PROMPTS). Each starter is copied into the folder ONCE, the first
//! launch that knows about it (`builtins_offered` records which); after that
//! it is the user's file to edit or delete, and a deleted one stays deleted.

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
    /// One line saying what you get. Optional.
    #[serde(skip_serializing_if = "String::is_empty")]
    description: String,
    /// What the message box shows while this template is on. Optional.
    #[serde(skip_serializing_if = "String::is_empty")]
    hint: String,
    /// Kept in the file for anyone who uses them; the app no longer shows
    /// or edits tags.
    #[serde(skip_serializing_if = "Vec::is_empty")]
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
    description: String,
    hint: String,
    tags: Vec<String>,
    body: String,
    /// Non-null = starred. New stars are written as "star"; an older
    /// install's colour name ("amber", "blue", …) counts as starred too.
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
        "summarise-a-document",
        include_str!("../builtin-prompts/summarise-a-document.md"),
    ),
    (
        "explain-in-plain-english",
        include_str!("../builtin-prompts/explain-in-plain-english.md"),
    ),
    (
        "letter-to-a-client",
        include_str!("../builtin-prompts/letter-to-a-client.md"),
    ),
    (
        "change-the-tone",
        include_str!("../builtin-prompts/change-the-tone.md"),
    ),
    (
        "answer-only-from-the-document",
        include_str!("../builtin-prompts/answer-only-from-the-document.md"),
    ),
    (
        "argue-the-other-side",
        include_str!("../builtin-prompts/argue-the-other-side.md"),
    ),
    ("translate", include_str!("../builtin-prompts/translate.md")),
    (
        "chronology-of-events",
        include_str!("../builtin-prompts/chronology-of-events.md"),
    ),
    (
        "key-dates-and-deadlines",
        include_str!("../builtin-prompts/key-dates-and-deadlines.md"),
    ),
    ("file-note", include_str!("../builtin-prompts/file-note.md")),
    (
        "meeting-minutes",
        include_str!("../builtin-prompts/meeting-minutes.md"),
    ),
    (
        "house-style",
        include_str!("../builtin-prompts/house-style.md"),
    ),
    (
        "notes-synthesizer",
        include_str!("../builtin-prompts/notes-synthesizer.md"),
    ),
];

/// Starters that are starred when they are first copied in: the six cards
/// a new chat offers on a fresh install.
const DEFAULT_STARRED: &[&str] = &[
    "summarise-a-document",
    "chronology-of-events",
    "letter-to-a-client",
    "file-note",
    "key-dates-and-deadlines",
    "explain-in-plain-english",
];

/// `app_settings` key: comma-separated slugs of every starter this install
/// has already been offered (copied in, or found already present).
const OFFERED_KEY: &str = "builtins_offered";

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

/// A frontmatter value is one line: collapse any line breaks and trim.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<&str>>().join(" ")
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
            description: fm.description.trim().to_string(),
            hint: fm.hint.trim().to_string(),
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
    description: Option<String>,
    hint: Option<String>,
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
    let fm = PromptFrontmatter {
        name,
        description: one_line(description.as_deref().unwrap_or("")),
        hint: one_line(hint.as_deref().unwrap_or("")),
        tags,
    };
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

/// Which starters to copy in now. A starter this install has not been
/// offered yet is written if its file is missing, and counts as offered
/// either way. One already offered is left alone — so a starter the user
/// deleted stays deleted. Returns (slugs written, every slug now offered).
fn seed_missing(
    dir: &std::path::Path,
    offered: &std::collections::BTreeSet<String>,
) -> Result<(Vec<&'static str>, std::collections::BTreeSet<String>), String> {
    let mut written: Vec<&'static str> = Vec::new();
    let mut now_offered = offered.clone();
    for (slug, contents) in BUILTIN_PROMPTS {
        if offered.contains(*slug) {
            continue;
        }
        let path = dir.join(format!("{slug}.md"));
        if !path.exists() {
            std::fs::write(&path, contents).map_err(|e| format!("Seed {}: {e}", path.display()))?;
            written.push(slug);
        }
        now_offered.insert((*slug).to_string());
    }
    Ok((written, now_offered))
}

fn parse_offered(raw: &str) -> std::collections::BTreeSet<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Copy in any starter template this install has not been offered yet (see
/// `seed_missing`), and star the ones a new chat shows as cards. Runs at
/// every launch; after the first it writes nothing unless a release adds a
/// starter. A star is only ever added for a file written just now, and only
/// if the user has no setting for that slug already.
#[tauri::command]
pub(crate) fn prompts_seed_builtins(app: tauri::AppHandle) -> Result<u32, String> {
    // Resolve the folder BEFORE taking the DB lock: resolving reads a
    // setting under that same (non-reentrant) lock.
    let dir = ensure_prompts_dir(&app)?;
    let db = app.state::<DbState>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let offered = parse_offered(&get_setting(&conn, OFFERED_KEY).unwrap_or_default());
    let (written, now_offered) = seed_missing(&dir, &offered)?;
    for slug in &written {
        if DEFAULT_STARRED.contains(slug) {
            if let Err(e) = conn.execute(
                "INSERT OR IGNORE INTO prompt_meta (slug, favorite) VALUES (?1, 'star')",
                [slug],
            ) {
                log_warn!("starring starter {slug} failed: {e}");
            }
        }
    }
    let joined = now_offered.into_iter().collect::<Vec<String>>().join(",");
    set_setting(&conn, OFFERED_KEY, &joined)?;
    set_setting(&conn, "builtins_seeded_v1", "1")?;
    Ok(u32::try_from(written.len()).unwrap_or(u32::MAX))
}

/// Overwrite every starter template from the embedded copies, regardless of
/// existing files. Useful when the user wants to revert local edits, or has
/// deleted a starter and wants it back. Their own templates are untouched,
/// and so are stars.
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
        assert!(is_builtin_slug("summarise-a-document"));
        assert!(is_builtin_slug("file-note"));
        assert!(is_builtin_slug("notes-synthesizer"));
        // Prompts shipped before the starter set are no longer built in.
        assert!(!is_builtin_slug("summarize"));
        assert!(!is_builtin_slug("brainstorm"));
    }

    // ── the starter set ────────────────────────────────────────────────────

    #[test]
    fn starter_set_is_twelve_templates_and_the_notes_synthesizer() {
        assert_eq!(BUILTIN_PROMPTS.len(), 13);
        let mut slugs: Vec<&str> = BUILTIN_PROMPTS.iter().map(|(s, _)| *s).collect();
        slugs.sort_unstable();
        slugs.dedup();
        assert_eq!(slugs.len(), 13, "no slug twice");
    }

    #[test]
    fn every_starter_parses_with_a_name_matching_its_file() {
        for (slug, text) in BUILTIN_PROMPTS {
            let (fm, body) = parse_prompt_file(text);
            assert!(!fm.name.is_empty(), "{slug}: name");
            assert!(!body.trim().is_empty(), "{slug}: body");
            // A new template made in the app with this name gets this file
            // name; keep the shipped ones consistent with that.
            assert_eq!(
                &slugify(&fm.name),
                slug,
                "{slug}: file name follows the name"
            );
            // One line each: a line break would be folded into the card.
            assert!(!fm.description.contains('\n'), "{slug}: description");
            assert!(!fm.hint.contains('\n'), "{slug}: hint");
            if *slug != "notes-synthesizer" {
                assert!(!fm.description.is_empty(), "{slug}: description");
            }
        }
    }

    #[test]
    fn starred_starters_exist_and_carry_a_hint() {
        assert_eq!(DEFAULT_STARRED.len(), 6);
        for slug in DEFAULT_STARRED {
            let text = BUILTIN_PROMPTS
                .iter()
                .find(|(s, _)| s == slug)
                .map(|(_, t)| *t)
                .unwrap_or_else(|| panic!("{slug} is not a starter"));
            let (fm, _) = parse_prompt_file(text);
            // A card you choose in a chat tells the message box what to ask for.
            assert!(!fm.hint.is_empty(), "{slug}: hint");
        }
        // The always-on example is never chosen in a chat, so it has none.
        let house = BUILTIN_PROMPTS
            .iter()
            .find(|(s, _)| *s == "house-style")
            .unwrap()
            .1;
        assert!(parse_prompt_file(house).0.hint.is_empty());
    }

    // ── description and hint ───────────────────────────────────────────────

    #[test]
    fn parse_reads_description_and_hint() {
        let text = "---\nname: File note\ndescription: Notes into a note for the file\nhint: Dictate or paste your notes\n---\nBody.";
        let (fm, body) = parse_prompt_file(text);
        assert_eq!(fm.name, "File note");
        assert_eq!(fm.description, "Notes into a note for the file");
        assert_eq!(fm.hint, "Dictate or paste your notes");
        assert!(fm.tags.is_empty());
        assert_eq!(body, "Body.");
    }

    #[test]
    fn a_file_without_the_new_lines_still_loads() {
        let (fm, body) = parse_prompt_file("---\nname: Old one\ntags: [a]\n---\nBody.");
        assert_eq!(fm.name, "Old one");
        assert_eq!(fm.description, "");
        assert_eq!(fm.hint, "");
        assert_eq!(fm.tags, vec!["a".to_string()]);
        assert_eq!(body, "Body.");
    }

    #[test]
    fn render_leaves_out_empty_lines_and_round_trips() {
        let bare = PromptFrontmatter {
            name: "Plain".into(),
            ..Default::default()
        };
        let text = render_prompt_file(&bare, "Body.").unwrap();
        assert_eq!(text, "---\nname: Plain\n---\nBody.");

        let full = PromptFrontmatter {
            name: "Change the tone".into(),
            description: "Four versions: formal, warm, casual, firm".into(),
            hint: "Paste your draft".into(),
            tags: vec!["writing".into()],
        };
        let text = render_prompt_file(&full, "Rewrite it.").unwrap();
        let (fm, body) = parse_prompt_file(&text);
        // A colon in the description survives the trip (YAML quotes it).
        assert_eq!(fm.description, "Four versions: formal, warm, casual, firm");
        assert_eq!(fm.hint, "Paste your draft");
        assert_eq!(fm.tags, vec!["writing".to_string()]);
        assert_eq!(body, "Rewrite it.");
    }

    #[test]
    fn one_line_folds_line_breaks_and_trims() {
        assert_eq!(one_line("  two\nlines \t here "), "two lines here");
        assert_eq!(one_line(""), "");
    }

    // ── copying the starters in ────────────────────────────────────────────

    #[test]
    fn a_new_folder_gets_every_starter_once() {
        let dir = tmpdir();
        let (written, offered) = seed_missing(&dir, &Default::default()).unwrap();
        assert_eq!(written.len(), 13);
        assert_eq!(offered.len(), 13);
        assert!(dir.join("file-note.md").exists());

        // Next launch: nothing to do.
        let (again, offered2) = seed_missing(&dir, &offered).unwrap();
        assert!(again.is_empty());
        assert_eq!(offered2, offered);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_deleted_starter_stays_deleted() {
        let dir = tmpdir();
        let (_, offered) = seed_missing(&dir, &Default::default()).unwrap();
        fs::remove_file(dir.join("house-style.md")).unwrap();
        let (written, _) = seed_missing(&dir, &offered).unwrap();
        assert!(written.is_empty());
        assert!(!dir.join("house-style.md").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_existing_file_is_never_overwritten() {
        let dir = tmpdir();
        fs::write(dir.join("file-note.md"), "mine").unwrap();
        let (written, offered) = seed_missing(&dir, &Default::default()).unwrap();
        assert!(!written.contains(&"file-note"));
        assert_eq!(written.len(), 12);
        // It still counts as offered, so it is not written later either.
        assert!(offered.contains("file-note"));
        assert_eq!(
            fs::read_to_string(dir.join("file-note.md")).unwrap(),
            "mine"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_install_from_before_the_starter_set_gets_the_new_ones_and_keeps_its_files() {
        // The folder as an earlier version left it; nothing recorded as offered.
        let dir = tmpdir();
        fs::write(dir.join("summarize.md"), "old summarize").unwrap();
        fs::write(dir.join("notes-synthesizer.md"), "edited by the user").unwrap();
        let (written, _) = seed_missing(&dir, &Default::default()).unwrap();
        assert_eq!(written.len(), 12);
        assert!(dir.join("summarise-a-document.md").exists());
        assert_eq!(
            fs::read_to_string(dir.join("summarize.md")).unwrap(),
            "old summarize"
        );
        assert_eq!(
            fs::read_to_string(dir.join("notes-synthesizer.md")).unwrap(),
            "edited by the user"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_offered_reads_a_comma_list() {
        let set = parse_offered("file-note, translate,,house-style ");
        assert_eq!(set.len(), 3);
        assert!(set.contains("translate"));
        assert!(parse_offered("").is_empty());
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
