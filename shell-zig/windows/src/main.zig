//! Skrive Windows host — Stage 5.0 skeleton.
//!
//! A bare Win32 window plus a proof-of-life round-trip through the Zig core,
//! both cross-compiled from macOS. This stage answers exactly one question:
//! does the unify-on-Zig host link the existing core (C++ watcher and all)
//! and produce a runnable Windows binary, built entirely on a Mac? WebView2,
//! serving, and the message bridge are Stage 5.1.
//!
//! The host calls the core's native `Core` API directly (no C-ABI marshaling
//! between a Zig host and a Zig core); the C ABI in `skrive_core.zig` stays
//! reserved for the Swift macOS host. The emit callback here just records the
//! response so the `app:version` round-trip is observable when run on Windows;
//! 5.1 replaces it with `ExecuteScript` delivery to the WebView2.
//!
//! Win32 is hand-declared (Turf idiom) rather than pulled from a binding, so
//! the host owns its small, explicit surface — the same posture chosen for the
//! WebView2 COM glue in 5.1. `std.os.windows` supplies the base types.

const std = @import("std");
const core = @import("skrive_core");
const w = std.os.windows;

const WINAPI: std.builtin.CallingConvention = std.builtin.CallingConvention.winapi;

// 0.16's std.os.windows dropped WPARAM/LRESULT and made BOOL a wrapper type.
// These are ABI-identical primitives (UINT_PTR / LONG_PTR / c_int), declared
// locally so the message loop compares against plain ints without friction.
const WPARAM = usize;
const LPARAM = isize;
const LRESULT = isize;
const BOOL = i32;

// ---- Win32 surface (hand-declared) ----------------------------------------

const WNDPROC = *const fn (w.HWND, u32, WPARAM, LPARAM) callconv(WINAPI) LRESULT;

const WNDCLASSEXW = extern struct {
    cbSize: u32,
    style: u32,
    lpfnWndProc: WNDPROC,
    cbClsExtra: i32,
    cbWndExtra: i32,
    hInstance: w.HINSTANCE,
    hIcon: ?w.HICON,
    hCursor: ?w.HCURSOR,
    hbrBackground: ?w.HBRUSH,
    lpszMenuName: ?w.LPCWSTR,
    lpszClassName: w.LPCWSTR,
    hIconSm: ?w.HICON,
};

const POINT = extern struct { x: i32, y: i32 };

const MSG = extern struct {
    hwnd: ?w.HWND,
    message: u32,
    wParam: WPARAM,
    lParam: LPARAM,
    time: u32,
    pt: POINT,
    lPrivate: u32,
};

extern "kernel32" fn GetModuleHandleW(lpModuleName: ?w.LPCWSTR) callconv(WINAPI) ?w.HMODULE;
extern "user32" fn RegisterClassExW(unnamedParam1: *const WNDCLASSEXW) callconv(WINAPI) w.ATOM;
extern "user32" fn CreateWindowExW(
    dwExStyle: u32,
    lpClassName: w.LPCWSTR,
    lpWindowName: w.LPCWSTR,
    dwStyle: u32,
    X: i32,
    Y: i32,
    nWidth: i32,
    nHeight: i32,
    hWndParent: ?w.HWND,
    hMenu: ?w.HMENU,
    hInstance: w.HINSTANCE,
    lpParam: ?w.LPVOID,
) callconv(WINAPI) ?w.HWND;
extern "user32" fn DefWindowProcW(w.HWND, u32, WPARAM, LPARAM) callconv(WINAPI) LRESULT;
extern "user32" fn ShowWindow(hWnd: w.HWND, nCmdShow: i32) callconv(WINAPI) BOOL;
extern "user32" fn UpdateWindow(hWnd: w.HWND) callconv(WINAPI) BOOL;
extern "user32" fn GetMessageW(lpMsg: *MSG, hWnd: ?w.HWND, wMsgFilterMin: u32, wMsgFilterMax: u32) callconv(WINAPI) BOOL;
extern "user32" fn TranslateMessage(lpMsg: *const MSG) callconv(WINAPI) BOOL;
extern "user32" fn DispatchMessageW(lpMsg: *const MSG) callconv(WINAPI) LRESULT;
extern "user32" fn PostQuitMessage(nExitCode: i32) callconv(WINAPI) void;
extern "user32" fn LoadCursorW(hInstance: ?w.HINSTANCE, lpCursorName: w.LPCWSTR) callconv(WINAPI) ?w.HCURSOR;

const CS_VREDRAW: u32 = 0x0001;
const CS_HREDRAW: u32 = 0x0002;
const WS_OVERLAPPEDWINDOW: u32 = 0x00CF0000;
const WM_DESTROY: u32 = 0x0002;
const SW_SHOWDEFAULT: i32 = 10;
const CW_USEDEFAULT: i32 = @bitCast(@as(u32, 0x80000000));
const IDC_ARROW: w.LPCWSTR = @ptrFromInt(32512); // MAKEINTRESOURCEW(32512)
const COLOR_WINDOW_BRUSH: w.HBRUSH = @ptrFromInt(6); // COLOR_WINDOW (5) + 1

fn wndProc(hwnd: w.HWND, msg: u32, wParam: WPARAM, lParam: LPARAM) callconv(WINAPI) LRESULT {
    switch (msg) {
        WM_DESTROY => {
            PostQuitMessage(0);
            return 0;
        },
        else => return DefWindowProcW(hwnd, msg, wParam, lParam),
    }
}

// ---- Core proof-of-life ----------------------------------------------------

/// Core -> host emit. 5.0 only needs to prove the response comes back, so it
/// writes to stderr (visible in the console subsystem when run on Windows).
/// 5.1 swaps this for the delivery-rule ExecuteScript into the WebView2.
fn emitProof(userdata: ?*anyopaque, message_json: [*:0]const u8) callconv(.c) void {
    _ = userdata;
    std.debug.print("[core emit] {s}\n", .{std.mem.span(message_json)});
}

pub fn main() !void {
    const hinstance: w.HINSTANCE = @ptrCast(GetModuleHandleW(null) orelse return error.NoModuleHandle);

    const class_name = std.unicode.utf8ToUtf16LeStringLiteral("SkriveWindowClass");
    const title = std.unicode.utf8ToUtf16LeStringLiteral("Skrive (Zig host)");

    const wc = WNDCLASSEXW{
        .cbSize = @sizeOf(WNDCLASSEXW),
        .style = CS_HREDRAW | CS_VREDRAW,
        .lpfnWndProc = wndProc,
        .cbClsExtra = 0,
        .cbWndExtra = 0,
        .hInstance = hinstance,
        .hIcon = null,
        .hCursor = LoadCursorW(null, IDC_ARROW),
        .hbrBackground = COLOR_WINDOW_BRUSH,
        .lpszMenuName = null,
        .lpszClassName = class_name,
        .hIconSm = null,
    };
    if (RegisterClassExW(&wc) == 0) return error.RegisterClassFailed;

    // Prove the core links and round-trips before opening the window. Single-
    // threaded blocking Io on this thread is the host model (the C ABI uses the
    // same global Io); empty app-data dir is fine — 5.0 issues no persistence.
    const io = std.Io.Threaded.global_single_threaded.io();
    const c = core.Core.create(io, "", emitProof, null) catch return error.CoreCreateFailed;
    defer c.destroy();
    c.handle("{\"v\":1,\"id\":1,\"cmd\":\"app:version\",\"payload\":{}}");

    const hwnd = CreateWindowExW(
        0,
        class_name,
        title,
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        1100,
        720,
        null,
        null,
        hinstance,
        null,
    ) orelse return error.CreateWindowFailed;

    _ = ShowWindow(hwnd, SW_SHOWDEFAULT);
    _ = UpdateWindow(hwnd);

    var msg: MSG = undefined;
    while (GetMessageW(&msg, null, 0, 0) != 0) {
        _ = TranslateMessage(&msg);
        _ = DispatchMessageW(&msg);
    }
}
