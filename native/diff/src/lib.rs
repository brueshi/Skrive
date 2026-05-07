//! @skrive/diff — napi-rs bindings over the Markdown diff core.
//!
//! Two functions cross the boundary, mirroring the v0.1.x Tauri command shape
//! `compute_line_diff` (raw side-by-side rows) and `compute_diff` (Phase 3.3b
//! structural ops). Both take two source strings and return JSON trees built
//! from the existing serde-camelCase shapes in `diff.rs`. The TS side
//! re-types those trees in `app/src/lib/diff/` so the boundary stays typed
//! end-to-end without duplicating the Rust shapes here.

#[macro_use]
extern crate napi_derive;

mod diff;

#[cfg(test)]
mod diff_memo;

use napi::Result;
use serde_json::Value;

#[napi]
pub fn compute_diff(before: String, after: String) -> Result<Value> {
    let ops = diff::compute_diff(&before, &after);
    serde_json::to_value(ops).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn compute_line_diff(before: String, after: String) -> Result<Value> {
    let rows = diff::compute_line_diff(&before, &after);
    serde_json::to_value(rows).map_err(|e| napi::Error::from_reason(e.to_string()))
}
