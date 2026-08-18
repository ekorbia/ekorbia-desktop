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
| `katex.min.js` | katex | 0.18.4 | `https://unpkg.com/katex@0.18.4/dist/katex.min.js` |
| `katex.min.css` | katex | 0.18.4 | `https://unpkg.com/katex@0.18.4/dist/katex.min.css` |
| `mermaid.min.js` | mermaid (IIFE build; sets `globalThis.mermaid`) | 11.16.1 | `https://unpkg.com/mermaid@11.16.1/dist/mermaid.min.js` |

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

The 20 `fonts/KaTeX_*.woff2` files are KaTeX 0.18.4's math fonts, copied
verbatim from the npm package's `dist/fonts/`. `katex.min.css` references
them as `url(fonts/…)` relative to itself, which is why they live in this
shared `fonts/` directory. The CSS also lists `.woff`/`.ttf` fallbacks we
deliberately do NOT vendor — WebKit always picks the woff2 source and
never requests the others (minimumSystemVersion 11.0 ⇒ Safari 14+).

## SHA-256 checksums

```
2623a9e22809915ce789b4461154e277ddce520d5a4320c14d44332a5d0dcea0  babel.min.js
9f208d022102b1d0c7aebfecd8e42ca7997d5de636649d2b31ea63093d809019  github-dark.min.css
471ef9ae90c407af440fcdc48edfeeb562106b3267bd12d99071c162fb52ed32  highlight.min.js
180c2d77d434d7da51d6625c50a964d4fd6fdbdb9bc8796a0a016c30c49931fb  katex.min.css
2ec5916941ef4383e0314eaabcc712301b06001d9fb68e08d751d2bae5a27a1a  katex.min.js
95674eef99e625a35507b91ae746e82ce59a2ffcc6d83f69c6c4e62e79d21835  marked.min.js
18327bef70d96fb505fe7287d9f6a7362ebf07ff6576ddfaffb1a06f3e1a2954  mermaid.min.js
c0845096a7c4a6741f362ac506c94c1c7d27dc603bcc1bf64a587f76f2dbe3a1  purify.min.js
35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d  react-dom.production.min.js
d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd  react.production.min.js
0cdd387c9590a1a9f9794560022dbb59654a7d86f187aa0c81495ad42d3a7308  fonts/KaTeX_AMS-Regular.woff2
de7701e42cf1f4cf0b766c03fb27977207eee2f4fd5d76fa82188406da43ea4c  fonts/KaTeX_Caligraphic-Bold.woff2
5d53e70ad607c2352162dec9e0923fb54ecdafaccbf604cd8dcf7d00facb989b  fonts/KaTeX_Caligraphic-Regular.woff2
74444efd593c005e3f4573b44524704c0af0a937fe911cca9e94068d0d140d3f  fonts/KaTeX_Fraktur-Bold.woff2
51814d270d06ff0255dba0799994fa4d8c84d11f09951d47595f4abb1f3602dc  fonts/KaTeX_Fraktur-Regular.woff2
0f60d1b897938ec918c8ce073092411baf9438f6739465693ff18b0f9d20b021  fonts/KaTeX_Main-Bold.woff2
99cd42a3c072d918f2f44984a807cf7aa16e13545fd0875fc07c6c65f99e715b  fonts/KaTeX_Main-BoldItalic.woff2
97479ca6cce906abc961ecac96faa5f9ca2e61b8e7670d475826bcdee9a7c267  fonts/KaTeX_Main-Italic.woff2
c2342cd8b869e01752a9321dc17213fc40d4d04c79688c1d43f2cf316abd7866  fonts/KaTeX_Main-Regular.woff2
dc47344dbb6cb5b655c8460d561f4df5f501b90c804ad3c6cec65fe322351ab1  fonts/KaTeX_Math-BoldItalic.woff2
7af58c5ec8f132a2ddde9027c6d7814decce4d3b822a11192a42a20e2e973264  fonts/KaTeX_Math-Italic.woff2
e99ae51144bf1232efcc1bfe5add36262c6866b0faab24fa75740e1b98577a62  fonts/KaTeX_SansSerif-Bold.woff2
00b26ac825e2095056396e0553b8ac26d3f8ad158c3826e28b4c45b385c4714a  fonts/KaTeX_SansSerif-Italic.woff2
68e8c73ef42afd3ccec58bf0fba302cce448938e7fc020a5e31f8a952eee1342  fonts/KaTeX_SansSerif-Regular.woff2
036d4e95149b69ff9bcc0cd55771efeb25ffa3947293e69acd78d5ac328c684b  fonts/KaTeX_Script-Regular.woff2
6b47c40166b6dbe21a5dfca7718413f2147fd2399be1ba605d8ad39cedf25dfe  fonts/KaTeX_Size1-Regular.woff2
d04c54219f9eaec6d4d4fd42dfb28785975a4794d6b2fc71e566b9cd6db842dd  fonts/KaTeX_Size2-Regular.woff2
73d591271b1604960cb10bb90fee021670af7297017e0e98480b332d11f51995  fonts/KaTeX_Size3-Regular.woff2
a4af7d414440a1c1790825cfb700cf9cf43b0f2c4b04f0ebc523011ad9853ec0  fonts/KaTeX_Size4-Regular.woff2
71d517d67827787cfabdf186914cc3358eda539e37931941f2b2fd4a21f68c0b  fonts/KaTeX_Typewriter-Regular.woff2
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
