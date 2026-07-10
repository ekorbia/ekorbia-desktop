// SPDX-License-Identifier: MIT

fn main() {
    // The dev-mode dock icon is embedded into the binary at compile time
    // (generate_context! reads the files listed under bundle.icon), but
    // tauri-build only registers tauri.conf.json for change detection —
    // editing an icon alone doesn't dirty the crate, so `cargo tauri dev`
    // keeps showing the old icon out of the build cache. Track the icons
    // directory explicitly so icon swaps rebuild and re-embed.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build();
}
