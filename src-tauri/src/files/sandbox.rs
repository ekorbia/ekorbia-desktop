// SPDX-License-Identifier: MIT

//! Single chokepoint for resolving a user-controlled / model-controlled path
//! into an absolute path *guaranteed* to live inside a permitted directory.
//!
//! Used by tools.rs (write_file tool) and any future manual-save command. If
//! a path passes through here, the caller may write to it without further
//! permission checks. If not, the caller MUST refuse.
//!
//! ## Threat model
//!
//! The `requested` argument arrives from an LLM. It may be:
//!   - Malicious by virtue of prompt injection ("save my key to ~/.ssh/...").
//!   - Confused (absolute path that happens to land outside output_dir).
//!   - Innocuous but path-shaped in ways the user didn't intend ("../x.html").
//!
//! ## Containment rules
//!
//! 1. `output_dir` MUST be an absolute path. We canonicalise it first; if it
//!    doesn't exist we create it (lazy creation on first save is part of the
//!    UX — the user shouldn't have to mkdir before tooling can write).
//! 2. `requested` MUST be relative, not absolute, and MUST NOT contain `..`
//!    components, NUL bytes, or empty path segments after splitting on `/`.
//!    A leading `/` is rejected outright.
//! 3. The joined path is canonicalised; the canonical result must start with
//!    the canonical `output_dir`. This catches symlink-via-parent-dir
//!    escapes that the syntactic checks above miss.
//! 4. The basename must be non-empty (no trailing slash → directory write).

use std::path::{Component, Path, PathBuf};

/// Resolve `requested` (a relative, model-supplied path) into a path inside
/// `output_dir`. Returns the absolute, canonical target path on success.
///
/// On success, all parent directories up to but not including the file have
/// been created. The caller is responsible for the actual file write.
pub(crate) fn resolve_within(output_dir: &Path, requested: &str) -> Result<PathBuf, String> {
    if requested.is_empty() {
        return Err("path is empty".into());
    }
    if requested.contains('\0') {
        return Err("path contains NUL byte".into());
    }
    let req_path = Path::new(requested);
    if req_path.is_absolute() {
        return Err(format!("path must be relative, got absolute: {requested}"));
    }

    // Walk components — reject `..`, normalise `.` and explicit current-dir
    // markers. Anything weirder than Normal / CurDir is a hard rejection.
    let mut clean = PathBuf::new();
    let mut last_was_normal = false;
    for comp in req_path.components() {
        match comp {
            Component::Normal(seg) => {
                if seg.is_empty() {
                    return Err("path contains empty segment".into());
                }
                clean.push(seg);
                last_was_normal = true;
            }
            Component::CurDir => { /* skip */ }
            Component::ParentDir => {
                return Err(format!("path may not contain `..`: {requested}"));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("path may not be absolute: {requested}"));
            }
        }
    }
    if !last_was_normal {
        return Err("path does not name a file".into());
    }

    // Canonicalise the output_dir (creating it lazily). We can't canonicalise
    // the joined target yet because it almost certainly doesn't exist — first
    // save creates it. Instead we canonicalise the *parent* of the target
    // after `create_dir_all` and assert it stays inside output_dir.
    if !output_dir.exists() {
        std::fs::create_dir_all(output_dir)
            .map_err(|e| format!("failed to create output_dir: {e}"))?;
    }
    let canon_root = output_dir
        .canonicalize()
        .map_err(|e| format!("failed to canonicalise output_dir: {e}"))?;
    let target = canon_root.join(&clean);

    // Materialise the parent so we can canonicalise it (the file itself may
    // not exist yet — that's the whole point of write_file). After this,
    // the parent's canonical form lets us re-check containment against any
    // symlinks that might have been planted between dir creation and now.
    if let Some(parent) = target.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create parent dirs: {e}"))?;
        }
        let canon_parent = parent
            .canonicalize()
            .map_err(|e| format!("failed to canonicalise parent: {e}"))?;
        if !canon_parent.starts_with(&canon_root) {
            return Err(format!(
                "resolved path escapes output_dir (parent canonicalised to {})",
                canon_parent.display()
            ));
        }
    }

    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ekorbia-sandbox-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_absolute_paths() {
        let root = tmpdir();
        assert!(resolve_within(&root, "/etc/passwd").is_err());
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let root = tmpdir();
        assert!(resolve_within(&root, "../../etc/passwd").is_err());
        assert!(resolve_within(&root, "foo/../../bar").is_err());
    }

    #[test]
    fn rejects_nul_byte() {
        let root = tmpdir();
        assert!(resolve_within(&root, "foo\0.html").is_err());
    }

    #[test]
    fn rejects_empty() {
        let root = tmpdir();
        assert!(resolve_within(&root, "").is_err());
    }

    #[test]
    fn accepts_plain_filename() {
        let root = tmpdir();
        let p = resolve_within(&root, "index.html").unwrap();
        assert!(p.starts_with(root.canonicalize().unwrap()));
        assert_eq!(p.file_name().unwrap(), "index.html");
    }

    #[test]
    fn accepts_subdirectory() {
        let root = tmpdir();
        let p = resolve_within(&root, "src/main.rs").unwrap();
        assert!(p.starts_with(root.canonicalize().unwrap()));
        assert!(root.join("src").exists(), "parent dir should be created");
    }

    // Symlink-escape test runs unix-only: `std::os::unix::fs::symlink` is
    // gated to unix, and Windows symlink semantics + permissions are
    // different enough (developer mode or admin token required) that a
    // direct port would add more flakiness than coverage. Windows path
    // traversal is still covered by the `..` / absolute-path / NUL-byte
    // rejection tests above, which run on every target.
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let root = tmpdir();
        let outside = tmpdir();
        // Plant a symlink inside root that points outside.
        let link = root.join("evil");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        // Try to write under the symlink — canonicalised parent will
        // resolve to `outside`, which doesn't start with `root`.
        let err = resolve_within(&root, "evil/file.txt").unwrap_err();
        assert!(err.contains("escapes"), "got: {err}");
    }
}
