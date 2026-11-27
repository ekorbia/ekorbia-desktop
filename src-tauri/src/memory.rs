// SPDX-License-Identifier: MIT

#![allow(clippy::needless_pass_by_value)]
//! Workspace notes — a Markdown file per workspace whose contents are sent
//! with every question asked in that workspace (standing facts: who the
//! client is, which spelling to use).
//!
//! The path lives on the workspace's row (`spaces.memory_path`), so these
//! commands take it as a parameter. It is not sandboxed: the file is in
//! the user's own Documents folder, or wherever they pointed it.
//!
//! (There used to be a second, global memory file added to every chat in
//! every workspace. It was removed: one memory across every client can
//! carry one client's details into another's answers.)

use crate::files::commands::spawn_opener;

/// Read a Space's memory file at the given absolute path. Returns:
///   • `Some(s)` when the file exists and is non-empty after trim
///   • `None`    when the file is missing, empty, or the path is empty
///
/// "None → omit the system message" in the UI's send pipeline.
#[tauri::command]
pub(crate) fn space_memory_read(path: String) -> Result<Option<String>, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match std::fs::read_to_string(trimmed) {
        Ok(s) => {
            if s.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(s))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read Space memory file: {e}")),
    }
}

/// Where a Space's notes live when the Space has no path of its own:
/// `<Documents>/Ekorbia/Spaces/<slug>/memory.md`. Empty when there is no
/// Documents or home directory to put it in, or when `slug` is not a plain
/// name (it becomes a directory name, so nothing that could step out of
/// `Spaces/` is accepted).
fn default_space_memory_path(slug: &str) -> String {
    let plain = !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !plain {
        return String::new();
    }
    match dirs::document_dir().or_else(dirs::home_dir) {
        Some(base) => base
            .join("Ekorbia")
            .join("Spaces")
            .join(slug)
            .join("memory.md")
            .to_string_lossy()
            .to_string(),
        None => String::new(),
    }
}

/// Save a Space's notes — the text the workspace settings dialog edits in
/// place. `path` is the Space's own memory path; when it is empty the
/// default for `slug` is used. Creates the folder if needed and returns
/// the path written, so the caller can store it on the Space the first
/// time. Same trust model as `space_memory_read` / `space_memory_open`:
/// a non-empty path is one the user chose.
#[tauri::command]
pub(crate) fn space_memory_write(
    path: String,
    slug: String,
    contents: String,
) -> Result<String, String> {
    let chosen = path.trim();
    let target = if chosen.is_empty() {
        default_space_memory_path(slug.trim())
    } else {
        chosen.to_string()
    };
    if target.is_empty() {
        return Err("No place to keep this workspace's notes".to_string());
    }
    write_space_memory(std::path::Path::new(&target), &contents)?;
    Ok(target)
}

fn write_space_memory(target: &std::path::Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create notes folder: {e}"))?;
    }
    std::fs::write(target, contents).map_err(|e| format!("save notes: {e}"))
}

/// Open a Space's memory file in the OS default editor (when `reveal` is
/// false) or reveal it in the file manager (when true). When opening for
/// edit and the file doesn't exist yet, creates the parent directory and
/// seeds a small template — same UX as `memory_open` so a fresh Space
/// gets editable empty memory on first click.
///
/// Refuses an empty path with a clear error so the UI can show a toast
/// rather than silently no-oping.
#[tauri::command]
pub(crate) fn space_memory_open(path: String, reveal: bool) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Space has no memory file set — pick one first".to_string());
    }
    if !reveal {
        let p = std::path::Path::new(trimmed);
        if !p.exists() {
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("create Space memory dir: {e}"))?;
            }
            let template = "# Space memory\n\n- \n";
            std::fs::write(trimmed, template)
                .map_err(|e| format!("create Space memory file: {e}"))?;
        }
    }
    spawn_opener(trimmed, reveal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_space_memory_path_takes_only_plain_slugs() {
        let p = default_space_memory_path("hartwell-v-meridian");
        assert!(
            p.ends_with("Ekorbia/Spaces/hartwell-v-meridian/memory.md"),
            "{p}"
        );
        // A slug becomes a directory name: nothing that could leave Spaces/.
        assert_eq!(default_space_memory_path(""), "");
        assert_eq!(default_space_memory_path("../outside"), "");
        assert_eq!(default_space_memory_path("a/b"), "");
        assert_eq!(default_space_memory_path(".hidden"), "");
    }

    #[test]
    fn notes_round_trip_through_write_and_read() {
        let dir = std::env::temp_dir().join(format!("ek_space_notes_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // The folder does not exist yet: writing creates it.
        let file = dir.join("spaces").join("novel").join("memory.md");
        let path = file.to_string_lossy().to_string();
        assert_eq!(space_memory_read(path.clone()).unwrap(), None);

        let written = space_memory_write(
            path.clone(),
            "novel".into(),
            "We act for the buyer.\n".into(),
        )
        .unwrap();
        assert_eq!(written, path);
        assert_eq!(
            space_memory_read(path.clone()).unwrap().as_deref(),
            Some("We act for the buyer.\n")
        );

        // Saving empty notes leaves an empty file, which reads as "no notes".
        space_memory_write(path.clone(), "novel".into(), String::new()).unwrap();
        assert_eq!(space_memory_read(path).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writing_with_no_path_and_no_usable_slug_is_refused() {
        assert!(space_memory_write(String::new(), "../x".into(), "text".into()).is_err());
        assert!(space_memory_write("  ".into(), String::new(), "text".into()).is_err());
    }
}
