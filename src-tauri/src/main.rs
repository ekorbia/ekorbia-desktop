// SPDX-License-Identifier: MIT

// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ekorbia_lib::run()
}
