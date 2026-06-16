// SPDX-License-Identifier: MIT

//! System profile — total RAM + platform, used by the guided first-run
//! flow to recommend a right-sized model.
//!
//! Zero new dependencies: macOS reads `hw.memsize` via the `libc` sysctl
//! we already depend on (for `setsid`), Linux parses `/proc/meminfo`, and
//! every other target returns `None` (the UI falls back to a safe default
//! when RAM is unknown). The project is macOS-primary; Windows/Linux are
//! best-effort, and an unknown-RAM path is perfectly acceptable there.

use serde::Serialize;

/// Total physical RAM in bytes, or `None` if we can't determine it on this
/// platform. `None` is not an error — the UI treats it as "unknown" and
/// recommends a conservative default.
#[cfg(target_os = "macos")]
fn total_ram_bytes() -> Option<u64> {
    use std::os::raw::c_void;
    let mut size: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    // `hw.memsize` is the total physical memory in bytes. NUL-terminated
    // name string required by sysctlbyname.
    let name = b"hw.memsize\0";
    // Safety: we pass a valid NUL-terminated name, a correctly-sized u64
    // output buffer with its matching length, and null for the (unused)
    // new-value args. sysctlbyname writes at most `len` bytes.
    let ret = unsafe {
        libc::sysctlbyname(
            name.as_ptr() as *const libc::c_char,
            &mut size as *mut u64 as *mut c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if ret == 0 && size > 0 {
        Some(size)
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn total_ram_bytes() -> Option<u64> {
    // /proc/meminfo line: "MemTotal:       16334336 kB"
    let txt = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in txt.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kb.saturating_mul(1024));
        }
    }
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn total_ram_bytes() -> Option<u64> {
    None
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemProfile {
    /// Total physical RAM in bytes, or null if undetectable on this OS.
    total_ram_bytes: Option<u64>,
    /// "macos" | "linux" | "windows" | … (std::env::consts::OS).
    platform: String,
    /// "aarch64" | "x86_64" | … (std::env::consts::ARCH).
    arch: String,
}

#[tauri::command]
pub(crate) fn system_profile() -> SystemProfile {
    SystemProfile {
        total_ram_bytes: total_ram_bytes(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_reports_this_platform_and_arch() {
        let p = system_profile();
        assert_eq!(p.platform, std::env::consts::OS);
        assert_eq!(p.arch, std::env::consts::ARCH);
        assert!(!p.arch.is_empty());
    }

    /// On the platforms we actually detect RAM for, the value must be
    /// present and sane (> 1 GiB — no modern machine running this app has
    /// less, and it guards against a units mistake reporting kB as bytes).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn detects_nonzero_ram_on_supported_platforms() {
        let bytes = total_ram_bytes().expect("RAM should be detectable here");
        assert!(
            bytes > 1024 * 1024 * 1024,
            "implausibly small RAM ({bytes} bytes) — units bug?"
        );
    }
}
