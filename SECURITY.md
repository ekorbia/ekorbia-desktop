# Security Policy

Thanks for helping keep Ekorbia and its users safe.

## Supported versions

Ekorbia is in early development. Only the latest released version is
supported for security fixes.

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

**Please do not report security issues through public GitHub issues.**
Public disclosure of an unpatched vulnerability puts every Ekorbia user
at risk.

Instead, use GitHub's private security advisory mechanism:

👉 **[Open a private security advisory](https://github.com/ekorbia/ekorbia-desktop/security/advisories/new)**

This sends the report directly to the maintainers without making it
visible to anyone else. Include:

1. **What the issue is** — a clear description of the vulnerability.
2. **How to reproduce it** — step-by-step or a proof-of-concept, if you
   have one. The simplest possible repro that demonstrates the issue is
   ideal.
3. **What you think the impact is** — what an attacker could do with
   this. Speculation is fine; we'll evaluate independently.
4. **Your environment** — Ekorbia version, macOS version, Ollama
   version (if relevant), and which models you were using.
5. **Suggested mitigation**, if any. Not required.

## Scope

The following are in scope for security reports:

- The Ekorbia desktop application (Rust + JSX) shipped on the Releases
  page.
- The build pipeline and CI configuration in `.github/workflows/`.
- The IPC surface between the Tauri Rust backend and the web frontend.
- The on-disk SQLite database and how Ekorbia handles its contents.
- The sandbox boundary in `src/files/sandbox.rs` and any path-handling
  code that touches user-supplied or model-supplied paths.

The following are **out of scope**:

- Vulnerabilities in [Ollama](https://github.com/ollama/ollama) itself
  (report those upstream).
- Vulnerabilities in third-party Rust crates we depend on (report
  upstream; we'll bump the version once a fix lands).
- Issues that require an attacker to already have local code execution
  as the user running Ekorbia. Local malware can already do anything
  the user can; we don't claim a security boundary there.
- Findings from automated scanners without a demonstrated impact.

## Local-first threat model

Ekorbia is a local-first desktop application. It does not send your
chat content to any third-party server; conversations live in the
local SQLite database and are sent only to your local Ollama instance.
This shapes our threat model:

- **Network exposure** is minimal — Ekorbia opens outbound HTTP
  connections to `http://localhost:11434` (Ollama) and to RSS / URL
  endpoints you configure in the Watch tab. It does not bind any
  listening ports.
- **Sandbox boundaries we care most about**: the `write_file` tool the
  model can call, which is constrained to per-chat output directories
  via `sandbox::resolve_within`. Path-traversal or sandbox-escape bugs
  in that code path are high-priority reports.
- **What you trust by running Ekorbia**: any model you load through
  Ollama. Models can call the `write_file` tool with whatever filename
  they choose (subject to sandbox checks). Don't load untrusted models
  any more than you would run untrusted code.

Thank you for taking the time to report responsibly.
