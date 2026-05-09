// markdown.jsx — MarkdownMessage component used by chat.jsx for assistant
// messages. User messages stay on the plain pre-wrap path in chat.jsx.
//
// Pipeline:
//   markdown text → marked (parser, custom code renderer + hljs)
//                 → DOMPurify (sanitize)
//                 → innerHTML
//                 → post-mount DOM walk (copy buttons, citations, search)
//
// Why the post-mount DOM walk: marked produces HTML strings, but our two
// pre-existing UI affordances on assistant text — citation chips for [N]
// markers and search-result <mark> highlights — were React-element-based
// in renderMessageContent. Re-implementing them as marked plugins would
// muddy the markdown parser; doing them as a DOM pass after innerHTML is
// the cleanest split (libs handle markdown, we handle our annotations).
//
// During streaming, we render plain text instead: re-parsing markdown on
// every token chunk is wasteful, and a half-typed ```fence``` would flip
// between code-block and paragraph layouts as the closing backticks
// arrive. Plaintext mid-stream → markdown on `done` is the smoother UX.
//
// React hooks (useEffect, useMemo, useRef) come from tokens.jsx's
// top-level destructure — Babel-standalone's text/babel script tags share
// global script scope so we don't redeclare here.

// One-time marked configuration. We register our custom code renderer here
// so every MarkdownMessage shares the same hljs-aware code path. Done
// inside an idempotent guard because Babel script-tag re-execution would
// otherwise re-register on every component mount in dev mode (no actual
// harm — marked.use is additive — but cleaner this way).
function ensureMarkedConfigured() {
  if (typeof marked === 'undefined') return false;
  if (window.__ekMarkedConfigured) return true;
  // gfm: tables, strikethrough, fenced code blocks. breaks: false because
  // hard-wrapping every newline as <br> makes prose look choppy; users
  // wanting a line break can use two newlines (paragraph) or trailing
  // double-space (the GFM way).
  marked.setOptions({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      // Accept BOTH renderer signatures:
      //   v13+ object form:   code({ text, lang, escaped })
      //   pre-v13 positional: code(text, lang, escaped)
      // Despite the marked v13 docs claiming the object form is canonical,
      // the minified bundle's marked.use wrapper sometimes routes the
      // positional form through anyway (depending on how the renderer is
      // composed). Defensive disambiguation here keeps us correct on any
      // packaging path — and the cost is a few cheap typeof checks.
      code(arg1, arg2) {
        let text, lang;
        if (arg1 && typeof arg1 === 'object') {
          text = arg1.text;
          lang = arg1.lang;
        } else {
          text = arg1;
          lang = arg2;
        }
        // Guard against weird inputs (null/undefined) — if we couldn't
        // pull text out of either signature, render an empty block rather
        // than the literal string "undefined".
        if (typeof text !== 'string') text = '';
        const language = (lang || '').trim().toLowerCase();
        let highlighted;
        let appliedLang = language;
        if (typeof hljs !== 'undefined') {
          try {
            if (language && hljs.getLanguage(language)) {
              highlighted = hljs.highlight(text, { language }).value;
            } else {
              const auto = hljs.highlightAuto(text);
              highlighted = auto.value;
              if (!appliedLang && auto.language) appliedLang = auto.language;
            }
          } catch (_) {
            highlighted = escapeHtml(text);
          }
        } else {
          highlighted = escapeHtml(text);
        }
        const langAttr = appliedLang ? ` data-lang="${escapeAttr(appliedLang)}"` : '';
        const classAttr = `hljs${appliedLang ? ' language-' + escapeAttr(appliedLang) : ''}`;
        // Pre.ek-code is what our CSS targets; the surrounding scoping
        // (.ek-md pre.ek-code) keeps styles from leaking to any future
        // non-assistant code rendering.
        return `<pre class="ek-code"${langAttr}><code class="${classAttr}">${highlighted}</code></pre>`;
      },
    },
  });
  window.__ekMarkedConfigured = true;
  return true;
}

// escapeHtml + escapeAttr live in `ui/utils.js` so they're unit-testable
// under node:test. They're on `window` before this file loads.

// Add a "Copy" button to every code block in `root`. Idempotent: bails if
// a button already exists on a given <pre> (so re-runs from the useEffect
// don't stack buttons).
function addCopyButtons(root) {
  const blocks = root.querySelectorAll('pre.ek-code');
  blocks.forEach((pre) => {
    if (pre.querySelector(':scope > .ek-copy-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ek-copy-btn';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const code = pre.querySelector('code');
      const text = code ? code.innerText : pre.innerText;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied!';
        btn.classList.add('ek-copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('ek-copied');
        }, 1400);
      } catch (_) {
        // Clipboard API may fail on insecure contexts or when permission
        // is denied. Fall back to a transient label so the user still
        // gets feedback — we don't surface a toast because the bigger
        // copy paths (chip strip, file save) already have one and a
        // failure here is rare on a Tauri webview.
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
      }
    });
    pre.appendChild(btn);
  });
}

// Walk text nodes in `root` and wrap [N] markers (for valid N in `sources`)
// with a <sup class="ek-citation"> chip. Skips text inside <pre>/<code> so
// citation-shaped tokens that happen to appear in source code (e.g. array
// index literals) aren't transformed.
function wrapCitations(root, sources) {
  if (!sources || sources.length === 0) return;
  const validIndices = new Set(sources.map((s) => s.citationIndex));
  if (validIndices.size === 0) return;
  const textNodes = collectTextNodes(root, /\[\d+\]/);
  for (const node of textNodes) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    let matched = false;
    for (const m of text.matchAll(/\[(\d+)\]/g)) {
      const idx = parseInt(m[1], 10);
      if (!validIndices.has(idx)) continue;
      matched = true;
      if (m.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      }
      const sup = document.createElement('sup');
      sup.className = 'ek-citation';
      const src = sources.find((s) => s.citationIndex === idx);
      if (src && src.path) sup.title = src.path;
      sup.textContent = String(idx);
      frag.appendChild(sup);
      lastIdx = m.index + m[0].length;
    }
    if (!matched) continue;
    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
    node.parentNode.replaceChild(frag, node);
  }
}

// Apply the active search regex by wrapping matching substrings in a
// <mark class="ek-search">. Walks every text node — including inside code
// blocks — because the existing chat.jsx behaviour highlights everywhere.
function applySearchHighlight(root, regex) {
  if (!regex) return;
  const textNodes = collectTextNodes(root, regex);
  for (const node of textNodes) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    let matched = false;
    // matchAll requires /g; defensively rebuild if the caller passed a
    // non-global regex (renderHighlighted in chat.jsx always builds /gi).
    const re = regex.flags.includes('g')
      ? regex
      : new RegExp(regex.source, regex.flags + 'g');
    for (const m of text.matchAll(re)) {
      matched = true;
      if (m.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      }
      const mark = document.createElement('mark');
      mark.className = 'ek-search';
      mark.textContent = m[0];
      frag.appendChild(mark);
      lastIdx = m.index + m[0].length;
    }
    if (!matched) continue;
    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
    node.parentNode.replaceChild(frag, node);
  }
}

// Collect text nodes under `root` whose value matches `predicate` (RegExp
// — tested with .test, not consumed). Skips text inside <pre>/<code> for
// the citation pass; the search pass passes `null` for skipCode to walk
// everything. Helper centralises the TreeWalker boilerplate.
function collectTextNodes(root, predicate, skipCode = true) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    if (skipCode) {
      let p = n.parentNode;
      let inCode = false;
      while (p && p !== root) {
        if (p.nodeName === 'CODE' || p.nodeName === 'PRE') { inCode = true; break; }
        p = p.parentNode;
      }
      // Citations are inside code → skip. Search markers are also harmful
      // inside the hljs token spans (would split them mid-token), so we
      // keep skipCode=true for both passes; matching inside code blocks
      // is a feature we can revisit later if anyone misses it.
      if (inCode) continue;
    }
    // Reset lastIndex BEFORE the test so global regexes (the search regex
    // is /.../gi) test from index 0 every time. Otherwise a successful
    // match advances lastIndex and the next text node gets a partial scan.
    if (predicate.global) predicate.lastIndex = 0;
    if (!predicate.test(n.nodeValue)) continue;
    out.push(n);
  }
  return out;
}

// Public component. Props mirror renderMessageContent's signature plus
// `streaming` so we can stay on the plaintext path while tokens arrive.
//
// Rules-of-Hooks: ALL hooks run on every render unconditionally. We can't
// early-return before useMemo/useEffect, otherwise toggling `streaming`
// from true to false would change the hook count and React crashes with
// "Rendered more hooks than during the previous render". The actual
// markdown work is skipped via internal short-circuits when streaming.
function MarkdownMessage({ content, highlightRegex, sources, streaming }) {
  const ref = useRef(null);

  // Parse markdown only when NOT streaming. During streaming we don't want
  // to re-parse per token and a half-typed fence would flip layouts; we
  // still call useMemo so the hook order stays stable.
  const html = useMemo(() => {
    if (streaming) return '';
    if (!content) return '';
    const ok = ensureMarkedConfigured();
    if (!ok || typeof DOMPurify === 'undefined') {
      // Library failed to load — degrade to plaintext with <br>s so the
      // user still sees their message. Escapes HTML to keep this safe.
      return escapeHtml(content).replace(/\n/g, '<br>');
    }
    let raw;
    try {
      raw = marked.parse(content);
    } catch (_) {
      return escapeHtml(content).replace(/\n/g, '<br>');
    }
    // DOMPurify defaults already block <script>, event handlers, javascript:
    // URLs, etc. We add data-lang to ADD_ATTR so our code-block language
    // badge survives sanitization.
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['data-lang'] });
  }, [content, streaming]);

  // Post-mount annotation pass. Order matters: copy buttons first (they
  // attach to existing <pre> elements), then citation wrapping (which
  // mutates text nodes outside <code>), then search highlighting (which
  // walks text nodes including the new citation text — search-matching
  // a citation number is fine because the citation chip carries the
  // number as its textContent). No-op while streaming because the ref
  // points to the plaintext branch, not the markdown root.
  useEffect(() => {
    if (streaming) return;
    if (!ref.current) return;
    addCopyButtons(ref.current);
    if (sources && sources.length) wrapCitations(ref.current, sources);
    if (highlightRegex) applySearchHighlight(ref.current, highlightRegex);
  }, [html, sources, highlightRegex, streaming]);

  // Streaming branch: render as plaintext via the existing helper so the
  // visual is identical to the prior code path. The hook calls above have
  // already run with stable shape, so React's hook order stays consistent
  // across the streaming → done transition.
  if (streaming) {
    const rmc = (typeof renderMessageContent === 'function')
      ? renderMessageContent
      : null;
    return (
      <div style={{ whiteSpace: 'pre-wrap' }}>
        {rmc ? rmc(content, highlightRegex, sources) : content}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="ek-md"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
