// SPDX-License-Identifier: MIT

#![allow(clippy::needless_pass_by_value)]
//! Full-text chat search backed by the messages_fts virtual table (FTS5) +
//! bm25 ranking. Returns up to 50 highest-ranked hits across all chats.
//! Snippet markers use 0x01/0x02 sentinels rather than HTML tags so the JS
//! side can split safely without an XSS risk from user-typed message content.

use crate::db::DbState;
use serde::{Deserialize, Serialize};

const SNIPPET_START: &str = "\u{0001}";
const SNIPPET_END: &str = "\u{0002}";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchHit {
    msg_id: String,
    chat_id: String,
    chat_title: String,
    chat_model: String,
    role: String,
    /// Snippet text with `\u{0001}` / `\u{0002}` wrapping each matched
    /// fragment. The JS side splits on these sentinels and renders matched
    /// fragments inside <mark>. Sentinels chosen because they cannot
    /// legitimately appear in message content.
    snippet: String,
    /// Wall-clock time string from the message row (HH:MM); may be empty.
    time: String,
    /// Sequence within the chat — useful if we later add "scroll to message".
    seq: i64,
    /// Parent chat's updated_at, for sorting hits within a single chat.
    updated_at: i64,
}

/// Convert a free-text query into FTS5 MATCH syntax. The raw user input may
/// contain characters that FTS5 treats as operators (`-`, `(`, `:`, …), so we
/// strip everything that isn't alphanumeric and tokenize on whitespace. Each
/// resulting token gets a `*` suffix for prefix matching — that gives the
/// familiar "search-as-you-type" feel where typing "lock stu" already
/// matches "locked study". Returns an empty string if no usable tokens
/// remain; callers should short-circuit and return no results in that case.
fn sanitize_fts_query(q: &str) -> String {
    let cleaned: String = q
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    cleaned
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("{}*", t.to_lowercase()))
        .collect::<Vec<_>>()
        .join(" ")
}

#[tauri::command]
pub(crate) fn search_chats(
    state: tauri::State<'_, DbState>,
    query: String,
) -> Result<Vec<SearchHit>, String> {
    let fts_query = sanitize_fts_query(&query);
    if fts_query.is_empty() {
        return Ok(vec![]);
    }
    let db = state.0.lock().map_err(|e| e.to_string())?;
    // snippet() args: (table, column index, start marker, end marker,
    //                  ellipsis, max-tokens-around-hit).
    // 16 tokens gives ~80 chars of context per side — enough to read in
    // the sidebar without overflowing.
    let mut stmt = db
        .prepare(
            "SELECT m.id, m.chat_id, c.title, COALESCE(c.model, ''), m.role, \
                    snippet(messages_fts, 0, ?2, ?3, '…', 16), \
                    COALESCE(m.time, ''), m.seq, c.updated_at \
             FROM messages_fts \
             JOIN messages m ON m.rowid = messages_fts.rowid \
             JOIN chats    c ON c.id    = m.chat_id \
             WHERE messages_fts MATCH ?1 \
             ORDER BY bm25(messages_fts) LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    // FTS5 MATCH can still throw on edge-case inputs that survive
    // sanitisation (rare, but e.g. an all-stopword query). Treat any query
    // error as "no results" rather than surfacing a scary message to the
    // user — empty results is the expected UX for a malformed query.
    let mapped = stmt.query_map(
        (&fts_query, SNIPPET_START, SNIPPET_END),
        |row| {
            Ok(SearchHit {
                msg_id: row.get(0)?,
                chat_id: row.get(1)?,
                chat_title: row.get(2)?,
                chat_model: row.get(3)?,
                role: row.get(4)?,
                snippet: row.get(5)?,
                time: row.get(6)?,
                seq: row.get(7)?,
                updated_at: row.get(8)?,
            })
        },
    );
    let Ok(rows) = mapped else { return Ok(vec![]) };
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_returns_empty() {
        // Caller short-circuits to "no results" — exact empty string is
        // the contract.
        assert_eq!(sanitize_fts_query(""), "");
    }

    #[test]
    fn whitespace_only_returns_empty() {
        assert_eq!(sanitize_fts_query("   \t\n  "), "");
    }

    #[test]
    fn punctuation_only_returns_empty() {
        // Every char is non-alphanumeric → no tokens. Must not surface to
        // FTS5 as `*` or it'd throw.
        assert_eq!(sanitize_fts_query("!@#$%^&*()-=:"), "");
    }

    #[test]
    fn single_token_gets_prefix_star() {
        assert_eq!(sanitize_fts_query("hello"), "hello*");
    }

    #[test]
    fn multiple_tokens_joined_with_space() {
        assert_eq!(sanitize_fts_query("hello world"), "hello* world*");
    }

    #[test]
    fn lowercases_input() {
        // FTS5's default unicode61 tokenizer is case-insensitive on its end
        // but we lowercase here so the displayed query string is stable.
        assert_eq!(sanitize_fts_query("Hello WORLD"), "hello* world*");
    }

    #[test]
    fn fts5_reserved_chars_become_token_boundaries() {
        // CLAUDE.md: dashes, parens, colons, quotes are all FTS5 operators.
        // Each must be stripped to a space so the user input can't form
        // an unintended phrase or column-match expression.
        assert_eq!(sanitize_fts_query("foo-bar"), "foo* bar*");
        assert_eq!(sanitize_fts_query("foo:bar"), "foo* bar*");
        assert_eq!(sanitize_fts_query("(foo bar)"), "foo* bar*");
        assert_eq!(sanitize_fts_query("\"foo bar\""), "foo* bar*");
    }

    #[test]
    fn numbers_preserved() {
        assert_eq!(sanitize_fts_query("user 123"), "user* 123*");
    }

    #[test]
    fn unicode_alphanumeric_preserved() {
        // unicode61 with diacritic-strip is the tokenizer; the sanitizer
        // works in chars, so accented letters survive (is_alphanumeric is
        // Unicode-aware). The trailing `*` lets them match against the
        // stripped form in the index.
        assert_eq!(sanitize_fts_query("café"), "café*");
    }

    #[test]
    fn collapses_runs_of_punctuation_between_tokens() {
        // "foo---bar" must not produce empty tokens (which would emit a
        // bare `*` and 500 out the query).
        assert_eq!(sanitize_fts_query("foo---bar"), "foo* bar*");
    }
}
