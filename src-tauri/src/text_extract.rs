// SPDX-License-Identifier: MIT

//! Shared file-to-text extraction used by both the watch pipeline (summarise
//! new files in a folder) and the attachment pipeline (chunk + embed large
//! text attachments). Lives at the crate root because it's a true seam: it
//! doesn't conceptually belong to either consumer.

use std::path::Path;

/// Dispatch extraction by file extension. PDFs go through pdf-extract on a
/// blocking worker (sync + CPU-bound). Plain-text formats are read directly
/// as UTF-8. We offload the read to spawn_blocking too because std::fs is
/// sync and a large file would otherwise stall the runtime.
pub(crate) async fn extract_text_from_file(file_path: &Path) -> Result<String, String> {
    let ext = file_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());

    let owned = file_path.to_path_buf();
    match ext.as_deref() {
        Some("pdf") => tokio::task::spawn_blocking(move || pdf_extract::extract_text(&owned))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("PDF extract failed: {e}")),
        Some("txt") | Some("md") | Some("markdown") => {
            tokio::task::spawn_blocking(move || std::fs::read_to_string(&owned))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("Text read failed: {e}"))
        }
        // The watch + attachment pipelines should never hand us anything
        // else, but be defensive in case the supported-extension list and
        // this dispatch drift.
        other => Err(format!("Unsupported file extension: {other:?}")),
    }
}
