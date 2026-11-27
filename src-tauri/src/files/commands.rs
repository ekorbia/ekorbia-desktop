// SPDX-License-Identifier: MIT

//! Opening a path in the OS file manager or default app, and saving text
//! the person asked to save.
//!
//! This module used to hold the commands behind the model's own file saving
//! (a `write_file` tool, a Files panel, per-chat output folders). That
//! feature was removed: the model no longer writes to disk by itself. What
//! is left is the opener other modules share and `text_file_save`, which
//! writes one code block from a reply to the place the person chose in the
//! save dialog.

/// Open `path` with the OS default handler, or (`reveal`) show it selected
/// in the file manager. Used for the templates folder, a workspace's notes
/// file, the models folder and attached documents.
#[cfg(target_os = "macos")]
pub(crate) fn spawn_opener(path: &str, reveal: bool) -> Result<(), String> {
    let mut cmd = std::process::Command::new("open");
    if reveal {
        cmd.arg("-R");
    }
    cmd.arg(path);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open spawn failed: {e}"))
}

#[cfg(target_os = "linux")]
pub(crate) fn spawn_opener(path: &str, reveal: bool) -> Result<(), String> {
    // xdg-open has no reveal semantics. Best we can do: open the parent
    // directory and trust the file manager to leave the user near the file.
    let target = if reveal {
        std::path::Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    };
    std::process::Command::new("xdg-open")
        .arg(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("xdg-open spawn failed: {e}"))
}

#[cfg(target_os = "windows")]
pub(crate) fn spawn_opener(path: &str, reveal: bool) -> Result<(), String> {
    if reveal {
        std::process::Command::new("explorer.exe")
            .args(["/select,", path])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("explorer spawn failed: {e}"))
    } else {
        // The empty quoted string is a `start` title placeholder so the
        // path isn't mis-parsed as the window title.
        std::process::Command::new("cmd")
            .args(["/c", "start", "", path])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("start spawn failed: {e}"))
    }
}

/// Upper bound on a saved code block. A block in a reply is kilobytes; this
/// only stops a runaway.
const MAX_TEXT_FILE_BYTES: usize = 32 * 1024 * 1024;

/// Write `contents` to `path`: the Save… button on a code block in a reply.
///
/// The path is the one the person picked in the OS save dialog, so it is
/// their choice of place and name, not the model's. Nothing in a reply can
/// reach this command by itself: the button is added by the app's own code,
/// a reply is sanitised before it is shown, and the page's content policy
/// runs no script from it. That is why this does not go through
/// `sandbox::resolve_within`, which is for paths a model supplies.
#[tauri::command]
pub(crate) fn text_file_save(path: String, contents: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    if path.trim().is_empty() || !target.is_absolute() {
        return Err("no place was chosen for the file".into());
    }
    if target.is_dir() {
        return Err("that is a folder, not a file".into());
    }
    if contents.len() > MAX_TEXT_FILE_BYTES {
        return Err("the text is too large to save".into());
    }
    std::fs::write(target, contents).map_err(|e| format!("could not write {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("ekorbia-text-save-{}-{name}", std::process::id()))
    }

    #[test]
    fn saving_writes_the_text_as_given() {
        let path = temp_path("notes.md");
        let text = "# Notes\n\nFees are fixed at £4,500.\n";
        text_file_save(path.to_string_lossy().to_string(), text.into()).unwrap();
        let back = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(back, text);
    }

    #[test]
    fn saving_again_replaces_the_file() {
        // The save dialog has already asked about replacing it.
        let path = temp_path("data.csv");
        let p = path.to_string_lossy().to_string();
        text_file_save(p.clone(), "a,b\n1,2\n".into()).unwrap();
        text_file_save(p, "a\n".into()).unwrap();
        let back = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(back, "a\n");
    }

    #[test]
    fn a_missing_or_relative_path_is_refused() {
        assert!(text_file_save(String::new(), "x".into()).is_err());
        assert!(text_file_save("   ".into(), "x".into()).is_err());
        assert!(text_file_save("notes.md".into(), "x".into()).is_err());
        assert!(text_file_save("../notes.md".into(), "x".into()).is_err());
    }

    #[test]
    fn a_folder_is_refused() {
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        assert_eq!(
            text_file_save(dir, "x".into()),
            Err("that is a folder, not a file".into())
        );
    }

    #[test]
    fn a_runaway_is_refused_before_anything_is_written() {
        let path = temp_path("huge.txt");
        let huge = "x".repeat(MAX_TEXT_FILE_BYTES + 1);
        assert!(text_file_save(path.to_string_lossy().to_string(), huge).is_err());
        assert!(!path.exists());
    }
}
