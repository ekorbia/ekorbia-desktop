// SPDX-License-Identifier: MIT

//! Shared HTTP helpers for RSS / URL watch kinds.
//!
//! One shared client builder so every outgoing request carries the same
//! User-Agent and timeout. Failing to build the client (only possible if
//! tls init blows up) silently falls back to the bare default — better
//! than panicking inside a background task.

use std::sync::OnceLock;
use std::time::Duration;

const HTTP_USER_AGENT: &str = "Ekorbia/0.1 (local AI desktop)";
const HTTP_TIMEOUT_SECS: u64 = 15;
pub(crate) const RSS_MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
pub(crate) const PAGE_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Tighter timeout for RSS link-follow specifically. Feed parse is required
/// (drives the entire cycle); per-entry body augmentation is optional —
/// if a publisher's site is slow we'd rather summarise from feed-supplied
/// content than block the whole cycle for the default 15s × N entries.
pub(crate) const RSS_LINK_FOLLOW_TIMEOUT_SECS: u64 = 10;

/// Shared HTTP client for every RSS / URL watch fetch. Built once; the
/// Arc-backed `Client` shares its connection pool across the watch poller
/// (one pooled connection per host beats a fresh TLS handshake every 30s).
/// Returns a static reference — callers chain `.get(url)` straight off it.
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub(crate) fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(HTTP_USER_AGENT)
            .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
            .build()
            // Builder errors only on TLS init; bare default still works
            // for HTTP-only feeds and gets us out of the pinch.
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Strip HTML to plain text. We use `scraper::Html::parse_fragment` so it
/// handles both well-formed documents and bare-snippet content (which is
/// what most RSS `<description>` and `<content:encoded>` carry). Text is
/// joined by whitespace and runs are collapsed so the model gets clean,
/// readable input without the original document's indentation noise.
pub(crate) fn html_to_text(html: &str) -> String {
    use scraper::Html;
    let doc = Html::parse_fragment(html);
    let mut out = String::new();
    for node in doc.root_element().text() {
        out.push_str(node);
        out.push(' ');
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// GET a URL and return its raw HTML body as a String. Shared by RSS
/// link-follow and URL-watch flows so the size cap + error handling
/// stays in one place; callers pick how to extract text afterwards.
///
/// `timeout_secs = None` uses the shared client default (15s — appropriate
/// for primary URL watches where the page IS the work). `Some(n)` applies
/// a per-request override via `reqwest::RequestBuilder::timeout`, used by
/// RSS link-follow which is optional augmentation.
pub(crate) async fn fetch_url_html(url: &str) -> Result<String, String> {
    fetch_url_html_inner(url, None).await
}

/// Variant of `fetch_url_html` that overrides the client's default timeout
/// for this specific request. reqwest applies `min(client_timeout, request_timeout)`,
/// so this only tightens — never extends — the budget.
pub(crate) async fn fetch_url_html_with_timeout(
    url: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    fetch_url_html_inner(url, Some(timeout_secs)).await
}

async fn fetch_url_html_inner(url: &str, timeout_secs: Option<u64>) -> Result<String, String> {
    let mut req = http_client().get(url);
    if let Some(secs) = timeout_secs {
        req = req.timeout(Duration::from_secs(secs));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("GET {url} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {url}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Read body from {url}: {e}"))?;
    if bytes.len() > PAGE_MAX_BODY_BYTES {
        return Err(format!(
            "Page too large ({} bytes; cap is {PAGE_MAX_BODY_BYTES} bytes)",
            bytes.len()
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// GET a URL and return its body as plain text (whole document). Used
/// for RSS link-follow where there's no per-watch selector.
///
/// The shorter `RSS_LINK_FOLLOW_TIMEOUT_SECS` applies — link-follow is
/// optional body augmentation; we'd rather summarise from feed-supplied
/// text than block the cycle for a slow upstream.
pub(crate) async fn fetch_url_text(url: &str) -> Result<String, String> {
    let html = fetch_url_html_with_timeout(url, RSS_LINK_FOLLOW_TIMEOUT_SECS).await?;
    Ok(html_to_text(&html))
}

/// Apply an optional CSS selector to HTML, then return the joined text
/// of the matched element subtrees. If `selector` is `None` or the
/// selector doesn't match anything, falls back to the whole document
/// — better than silently producing empty content when a user typos
/// `.psot-content` instead of `.post-content`.
pub(crate) fn html_to_text_with_selector(html: &str, selector: Option<&str>) -> String {
    use scraper::{Html, Selector};
    let doc = Html::parse_document(html);
    if let Some(sel_str) = selector {
        if let Ok(sel) = Selector::parse(sel_str) {
            let mut buf = String::new();
            let mut matched = false;
            for el in doc.select(&sel) {
                matched = true;
                for t in el.text() {
                    buf.push_str(t);
                    buf.push(' ');
                }
            }
            if matched {
                return buf.split_whitespace().collect::<Vec<_>>().join(" ");
            }
            // Selector parsed but matched nothing — fall through to the
            // full-page path so the user still gets *something*.
        }
        // Invalid selector → also fall through. Could surface this as
        // an error event, but treating it as "use whole page" keeps the
        // watch productive while the user figures out their selector.
    }
    html_to_text(html)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_to_text_strips_tags() {
        assert_eq!(html_to_text("<p>hello</p>"), "hello");
    }

    #[test]
    fn html_to_text_collapses_whitespace() {
        // Tag indentation + multiple spaces inside text should collapse to
        // single spaces; the model gets clean readable input.
        let html = "<div>\n  <p>foo   bar</p>\n  <p>baz</p>\n</div>";
        assert_eq!(html_to_text(html), "foo bar baz");
    }

    #[test]
    fn html_to_text_handles_nested_tags() {
        let html = "<article><h1>Title</h1><p>Body <em>here</em>.</p></article>";
        assert_eq!(html_to_text(html), "Title Body here .");
    }

    #[test]
    fn html_to_text_with_selector_none_uses_whole_doc() {
        let html = "<html><body><h1>A</h1><p>B</p></body></html>";
        assert_eq!(html_to_text_with_selector(html, None), "A B");
    }

    #[test]
    fn html_to_text_with_selector_extracts_match() {
        let html = "<html><body><nav>menu</nav><article>body text</article></body></html>";
        assert_eq!(
            html_to_text_with_selector(html, Some("article")),
            "body text"
        );
    }

    #[test]
    fn html_to_text_with_selector_falls_back_when_no_match() {
        // CLAUDE.md: "CSS selector fallback over silent empty content" —
        // typo'd selector must return the whole page, not an empty string.
        // The user can diagnose "wrong content" but not "no content at all".
        let html = "<html><body><article>real content</article></body></html>";
        let out = html_to_text_with_selector(html, Some(".psot-content"));
        assert!(out.contains("real content"), "got: {out}");
    }

    #[test]
    fn html_to_text_with_selector_falls_back_on_invalid_selector() {
        // Garbage selector should also fall back rather than panic or
        // bubble an error up to the pipeline.
        let html = "<html><body><p>fallback content</p></body></html>";
        let out = html_to_text_with_selector(html, Some(">>>not a selector<<<"));
        assert!(out.contains("fallback content"), "got: {out}");
    }

    #[test]
    fn html_to_text_with_selector_joins_multiple_matches() {
        let html = "<html><body>\
            <p class=\"x\">one</p><p class=\"y\">skip</p><p class=\"x\">two</p>\
            </body></html>";
        assert_eq!(html_to_text_with_selector(html, Some(".x")), "one two");
    }
}
