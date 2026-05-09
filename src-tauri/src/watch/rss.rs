// SPDX-License-Identifier: MIT

//! RSS-kind pipeline: fetch the feed, enumerate entries, dedupe against
//! previously-processed item IDs, summarise each new one. Per-entry
//! errors are logged but don't stop the rest of the feed.

use crate::log::log_warn;
use crate::watch::http::{fetch_url_text, html_to_text, http_client, RSS_MAX_BODY_BYTES};
use crate::watch::pipeline::{
    already_processed, flush_notify_batch, is_cancelled, new_notify_batch, process_item,
    record_fetch_error, resolve_system_msg,
};
use crate::watch::Watch;
use std::sync::atomic::AtomicBool;

/// If feed-supplied content is shorter than this, we treat it as a teaser
/// and try to fetch the linked article body. 200 chars is just enough for
/// "a worthwhile summary input" — too low and we'd over-fetch on chatty
/// summaries; too high and we'd miss feeds that ship full short posts.
const RSS_FOLLOW_LINK_THRESHOLD: usize = 200;

/// GET an RSS/Atom feed URL and return the parsed model. Sends an Accept
/// header that nudges servers toward feed content types — most feed hosts
/// honour it; ones that don't still return XML at the URL.
pub(crate) async fn fetch_rss_feed(url: &str) -> Result<feed_rs::model::Feed, String> {
    let resp = http_client()
        .get(url)
        .header(
            "Accept",
            "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        )
        .send()
        .await
        .map_err(|e| format!("GET feed {url} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from {url}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Read feed body from {url}: {e}"))?;
    if bytes.len() > RSS_MAX_BODY_BYTES {
        return Err(format!(
            "Feed too large ({} bytes; cap is {RSS_MAX_BODY_BYTES} bytes)",
            bytes.len()
        ));
    }
    feed_rs::parser::parse(&bytes[..]).map_err(|e| format!("Feed parse failed: {e}"))
}

pub(crate) async fn run_rss_watch(app: &tauri::AppHandle, watch: &Watch, cancel: &AtomicBool) {
    let Some(feed_url) = watch.source_url.as_deref().filter(|s| !s.is_empty()) else {
        log_warn!("watch '{}': RSS kind has no source_url", watch.name);
        return;
    };
    // One batch per poll cycle — feed-level fetch errors AND per-entry
    // outcomes both feed in here, flushed once at the bottom.
    let mut notify_batch = new_notify_batch();

    // Resolve prompt body once for the whole feed; see `resolve_system_msg`'s
    // comment for why this matters on multi-entry feeds.
    let system_msg = resolve_system_msg(app, watch);

    let feed = match fetch_rss_feed(feed_url).await {
        Ok(f) => f,
        Err(e) => {
            log_warn!("watch '{}': fetch feed: {e}", watch.name);
            // Surface to UI + notify batch. The "item_id" here is the feed
            // URL — these network-level errors aren't per-entry.
            record_fetch_error(app, &watch.id, feed_url, "feed", &e, &mut notify_batch);
            flush_notify_batch(app, watch, &notify_batch);
            return;
        }
    };

    for entry in feed.entries {
        // Per-entry cancel check. Skips the remaining feed entries — a
        // 50-item feed with slow link-following won't keep churning
        // after the user toggles off.
        if is_cancelled(cancel) {
            break;
        }
        // Item ID: prefer GUID / Atom <id>, then first link's href. Skip
        // truly anonymous entries — without a stable key we'd re-process
        // them on every poll.
        let item_id = if !entry.id.is_empty() {
            entry.id.clone()
        } else if let Some(link) = entry.links.first() {
            link.href.clone()
        } else {
            continue;
        };

        match already_processed(app, &watch.id, &item_id) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => {
                log_warn!("watch '{}': memo lookup failed: {e}", watch.name);
                continue;
            }
        }

        let label = entry
            .title
            .as_ref()
            .map(|t| t.content.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                entry
                    .links
                    .first()
                    .map(|l| l.href.clone())
                    .unwrap_or_else(|| item_id.clone())
            });

        // Body extraction, in preference order:
        //   1. <content> (Atom) or <content:encoded> (RSS extension). When
        //      the publisher includes it, this is the full article body.
        //   2. <summary> / <description>. Often a teaser but sometimes
        //      the full post (esp. on personal blogs / static-site feeds).
        //   3. Follow the first <link> and extract its body text.
        let mut text = entry
            .content
            .as_ref()
            .and_then(|c| c.body.as_deref())
            .map(html_to_text)
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_default();

        if text.len() < RSS_FOLLOW_LINK_THRESHOLD {
            if let Some(s) = entry.summary.as_ref() {
                let summary_text = html_to_text(&s.content);
                if summary_text.len() > text.len() {
                    text = summary_text;
                }
            }
        }

        if text.len() < RSS_FOLLOW_LINK_THRESHOLD {
            if let Some(link) = entry.links.first() {
                match fetch_url_text(&link.href).await {
                    Ok(article) if !article.trim().is_empty() => text = article,
                    Ok(_) => {} // empty — keep whatever we already have
                    Err(e) => {
                        // Network-level errors on the link are non-fatal;
                        // we still try to summarise from feed-supplied text.
                        log_warn!(
                            "watch '{}': follow link {}: {e}",
                            watch.name, link.href
                        );
                    }
                }
            }
        }

        if let Err(e) = process_item(
            app, watch, &system_msg, &item_id, &label, text, &mut notify_batch, cancel,
        )
        .await
        {
            log_warn!("watch '{}': process_item {item_id}: {e}", watch.name);
        }
    }
    flush_notify_batch(app, watch, &notify_batch);
}
