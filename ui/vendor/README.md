# Vendored front-end assets

These files replace unpkg.com / Google Fonts CDN references so the app
boots and runs fully offline. The **only** network traffic Ekorbia produces
is to the local Ollama server on `127.0.0.1:11434`.

Everything here is pinned, committed, and loaded as plain `<script>` /
`<link>` tags — the no-bundler rule still applies (see `CLAUDE.md`).
Licenses for these files: [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

## JS / CSS

| File | Package | Version | Upstream URL |
|---|---|---|---|
| `react.production.min.js` | react | 18.3.1 | `https://unpkg.com/react@18.3.1/umd/react.production.min.js` |
| `react-dom.production.min.js` | react-dom | 18.3.1 | `https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js` |
| `babel.min.js` | @babel/standalone | 7.29.0 | `https://unpkg.com/@babel/standalone@7.29.0/babel.min.js` |
| `marked.min.js` | marked | 13.0.0 | `https://unpkg.com/marked@13.0.0/marked.min.js` |
| `highlight.min.js` | @highlightjs/cdn-assets (common bundle, ~35 languages) | 11.10.0 | `https://unpkg.com/@highlightjs/cdn-assets@11.10.0/highlight.min.js` |
| `github-dark.min.css` | @highlightjs/cdn-assets | 11.10.0 | `https://unpkg.com/@highlightjs/cdn-assets@11.10.0/styles/github-dark.min.css` |
| `purify.min.js` | dompurify | 3.1.6 | `https://unpkg.com/dompurify@3.1.6/dist/purify.min.js` |

Note: through v0.3.0 the app loaded React **development** UMD builds from
the CDN; the vendored copies are the **production** builds (smaller,
faster; React error messages become minified `Minified React error #NNN`
codes — paste the code into react.dev/errors to decode during debugging).

## Fonts (`fonts/`)

Latin-subset variable-font woff2 files, exactly as `fonts.gstatic.com`
served them for the original css2 query (June 2026). Inter and JetBrains
Mono are variable fonts — one file covers all declared weights.

| File | Family / weights | Upstream URL |
|---|---|---|
| `fonts/inter-latin.woff2` | Inter v20, wght 400–700 | `https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2` |
| `fonts/jetbrains-mono-latin.woff2` | JetBrains Mono v24, wght 400–600 | `https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwgknk-4.woff2` |
| `fonts/instrument-serif-latin.woff2` | Instrument Serif v5, 400 | `https://fonts.gstatic.com/s/instrumentserif/v5/jizBRFtNs2ka5fXjeivQ4LroWlx-6zUTjnTLgNs.woff2` |

`fonts/fonts.css` declares the same `@font-face` rules (per-weight, shared
file, latin `unicode-range`) that Google's stylesheet emitted. Non-latin
text falls back to system fonts — identical behavior to the CDN era. To
add more script coverage, fetch the css2 URL in `git log` for this file
with a browser UA, grab the extra subset blocks, and add their woff2s +
rules here.

## SHA-256 checksums

```
2623a9e22809915ce789b4461154e277ddce520d5a4320c14d44332a5d0dcea0  babel.min.js
471ef9ae90c407af440fcdc48edfeeb562106b3267bd12d99071c162fb52ed32  highlight.min.js
95674eef99e625a35507b91ae746e82ce59a2ffcc6d83f69c6c4e62e79d21835  marked.min.js
c0845096a7c4a6741f362ac506c94c1c7d27dc603bcc1bf64a587f76f2dbe3a1  purify.min.js
35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d  react-dom.production.min.js
d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd  react.production.min.js
9f208d022102b1d0c7aebfecd8e42ca7997d5de636649d2b31ea63093d809019  github-dark.min.css
60c06664b5a95c7de6cc3e00d1f9034d78bd1e40b564016b241674449a067d4d  fonts/instrument-serif-latin.woff2
c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4  fonts/inter-latin.woff2
2c32b9b3ee358c119e210f6f5195f9bd34894d78a785ff2e95d60e718e400af4  fonts/jetbrains-mono-latin.woff2
```

Verify with: `shasum -a 256 -c <(grep -E '^[0-9a-f]{64}' README.md)` from
this directory, or re-download any file from its pinned upstream URL and
compare.

## Upgrading a library

1. Download the new pinned version from unpkg into this directory.
2. Update the version in `ui/index.html`'s comment block if referenced,
   this README's table, and the checksum list.
3. Keep `highlight.min.js` and `github-dark.min.css` on the **same**
   version (theme classnames must stay in sync).
4. Run `./scripts/run-ui-tests.sh` — the fixture
   (`tests/e2e/fixtures/playwright.html`) loads these same files.
