//! The host orchestration: owns the window, the Zig core, and the WebView2
//! controller, and wires the message bridge between them.
//!
//! Flow (all async steps resume on the UI thread via the message loop):
//!   create window
//!     -> CreateCoreWebView2EnvironmentWithOptions
//!       -> onEnvCreated: Environment.CreateCoreWebView2Controller(hwnd)
//!         -> onControllerCreated: get the webview, QI to _3, map the virtual
//!            host to the on-disk renderer dir, inject the renderer transport
//!            at document-create, subscribe to web messages, size + navigate.
//!
//! Bridge: renderer -> host is WebView2's WebMessageReceived (the renderer
//! posts an envelope string via window.chrome.webview.postMessage); host ->
//! renderer is the core's `emit`, marshaled to the UI thread and delivered by
//! ExecuteScript per the Part I delivery rule (jsescape). Marshaling matters
//! even now: once a project opens, the Stage 3 watcher emits from its own
//! thread, and WebView2 is UI-thread-affine — so every emit is copied and
//! PostMessage'd to the window, exactly as the macOS host hops to the main
//! queue.

const std = @import("std");
const win32 = @import("win32.zig");
const wv = @import("webview2.zig");
const handlers = @import("handlers.zig");
const jsescape = @import("jsescape.zig");
const core_mod = @import("skrive_core");

const w = win32.w;
const WINAPI = win32.WINAPI;

/// Custom message: a core emit was copied and queued for UI-thread delivery.
/// wParam is the heap pointer to the NUL-terminated copy (freed after use).
const WM_SKRIVE_EMIT: u32 = win32.WM_APP + 1;

const CLASS_NAME = std.unicode.utf8ToUtf16LeStringLiteral("SkriveWindowClass");
const WINDOW_TITLE = std.unicode.utf8ToUtf16LeStringLiteral("Skrive");
const VIRTUAL_HOST = std.unicode.utf8ToUtf16LeStringLiteral("skrive.app");
const NAV_URL = std.unicode.utf8ToUtf16LeStringLiteral("http://skrive.app/index.html");

pub const App = struct {
    gpa: std.mem.Allocator,
    hinstance: win32.HINSTANCE,
    asset_dir_w: [:0]u16,
    bridge_js_w: ?[:0]u16 = null,
    app_data_dir: []const u8,

    hwnd: ?win32.HWND = null,
    core: ?*core_mod.Core = null,
    create_env: wv.CreateEnvironmentFn = undefined,
    controller: ?*wv.ICoreWebView2Controller = null,
    webview3: ?*wv.ICoreWebView2_3 = null,

    env_handler: handlers.EnvCompletedHandler = undefined,
    controller_handler: handlers.ControllerCompletedHandler = undefined,
    web_message_handler: handlers.WebMessageHandler = undefined,
    web_msg_token: wv.EventRegistrationToken = .{ .value = 0 },

    /// Build the window + core and kick off async WebView2 creation. The App is
    /// heap-allocated so its address is stable: the handlers hold `*App`, the
    /// window stores it in GWLP_USERDATA, and the core's emit userdata is it.
    pub fn create(gpa: std.mem.Allocator) !*App {
        const io = std.Io.Threaded.global_single_threaded.io();

        const exe_dir = try getExeDir(gpa);
        defer gpa.free(exe_dir);
        const asset_dir = try std.fs.path.join(gpa, &.{ exe_dir, "renderer" });
        defer gpa.free(asset_dir);
        const asset_dir_w = try std.unicode.utf8ToUtf16LeAllocZ(gpa, asset_dir);
        errdefer gpa.free(asset_dir_w);
        const app_data_dir = try gpa.dupe(u8, exe_dir);
        errdefer gpa.free(app_data_dir);

        const self = try gpa.create(App);
        errdefer gpa.destroy(self);
        self.* = .{
            .gpa = gpa,
            .hinstance = @ptrCast(win32.GetModuleHandleW(null) orelse return error.NoModuleHandle),
            .asset_dir_w = asset_dir_w,
            .app_data_dir = app_data_dir,
        };

        // The renderer transport, bundled next to the exe; injected at
        // document-create so window.skrive exists before the app module runs.
        // A missing bundle is non-fatal here (logged) — first light just won't
        // have a working bridge, which the manual gate will catch loudly.
        const bridge_path = try std.fs.path.join(gpa, &.{ exe_dir, "native-bridge.js" });
        defer gpa.free(bridge_path);
        if (std.Io.Dir.cwd().readFileAlloc(io, bridge_path, gpa, .unlimited)) |js| {
            defer gpa.free(js);
            self.bridge_js_w = std.unicode.utf8ToUtf16LeAllocZ(gpa, js) catch null;
        } else |err| {
            std.debug.print("[skrive] could not read native-bridge.js: {s}\n", .{@errorName(err)});
        }

        self.create_env = wv.loadCreateEnvironment() orelse return error.WebView2LoaderMissing;
        self.core = core_mod.Core.create(io, app_data_dir, emitToHost, self) catch return error.CoreCreateFailed;
        self.env_handler = handlers.EnvCompletedHandler.init(onEnvCreated, self);
        self.controller_handler = handlers.ControllerCompletedHandler.init(onControllerCreated, self);
        self.web_message_handler = handlers.WebMessageHandler.init(onWebMessage, self);

        try self.createWindow();

        // userDataFolder = null defaults to a folder next to the exe (writable
        // in dev). Stage 5.2 points this at %APPDATA%/Skrive.
        const hr = self.create_env(null, null, null, @ptrCast(&self.env_handler));
        if (hr != wv.S_OK) logHr("CreateCoreWebView2EnvironmentWithOptions", hr);
        return self;
    }

    fn createWindow(self: *App) !void {
        const wc = win32.WNDCLASSEXW{
            .cbSize = @sizeOf(win32.WNDCLASSEXW),
            .style = win32.CS_HREDRAW | win32.CS_VREDRAW,
            .lpfnWndProc = wndProc,
            .cbClsExtra = 0,
            .cbWndExtra = 0,
            .hInstance = self.hinstance,
            .hIcon = null,
            .hCursor = win32.LoadCursorW(null, win32.IDC_ARROW),
            .hbrBackground = win32.COLOR_WINDOW_BRUSH,
            .lpszMenuName = null,
            .lpszClassName = CLASS_NAME,
            .hIconSm = null,
        };
        if (win32.RegisterClassExW(&wc) == 0) return error.RegisterClassFailed;

        const hwnd = win32.CreateWindowExW(
            0,
            CLASS_NAME,
            WINDOW_TITLE,
            win32.WS_OVERLAPPEDWINDOW,
            win32.CW_USEDEFAULT,
            win32.CW_USEDEFAULT,
            1100,
            720,
            null,
            null,
            self.hinstance,
            null,
        ) orelse return error.CreateWindowFailed;
        self.hwnd = hwnd;
        _ = win32.SetWindowLongPtrW(hwnd, win32.GWLP_USERDATA, @bitCast(@intFromPtr(self)));
        _ = win32.ShowWindow(hwnd, win32.SW_SHOWDEFAULT);
        _ = win32.UpdateWindow(hwnd);
    }

    // ---- async WebView2 creation callbacks (UI thread) --------------------

    fn onEnvCreated(ctx: *anyopaque, hr: wv.HRESULT, env_opt: ?*wv.ICoreWebView2Environment) callconv(.c) void {
        const self: *App = @ptrCast(@alignCast(ctx));
        if (hr != wv.S_OK) return logHr("environment created", hr);
        const env = env_opt orelse return;
        const chr = env.createController(self.hwnd, @ptrCast(&self.controller_handler));
        if (chr != wv.S_OK) logHr("CreateCoreWebView2Controller", chr);
    }

    fn onControllerCreated(ctx: *anyopaque, hr: wv.HRESULT, controller_opt: ?*wv.ICoreWebView2Controller) callconv(.c) void {
        const self: *App = @ptrCast(@alignCast(ctx));
        if (hr != wv.S_OK) return logHr("controller created", hr);
        const controller = controller_opt orelse return;
        self.controller = controller;

        var cwv: ?*anyopaque = null;
        if (controller.getCoreWebView2(&cwv) != wv.S_OK) return logHr("get_CoreWebView2", -1);
        const cwv_ptr = cwv orelse return;

        // QI the base ICoreWebView2 up to _3 for SetVirtualHostNameToFolderMapping.
        var p3: ?*anyopaque = null;
        if (wv.asUnknown(cwv_ptr).queryInterface(&wv.IID_ICoreWebView2_3, &p3) != wv.S_OK) {
            return logHr("QueryInterface ICoreWebView2_3", -1);
        }
        const webview3: *wv.ICoreWebView2_3 = @ptrCast(@alignCast(p3 orelse return));
        self.webview3 = webview3;

        _ = webview3.setVirtualHostMapping(VIRTUAL_HOST, self.asset_dir_w.ptr, .allow);
        if (self.bridge_js_w) |bjs| _ = webview3.addScriptOnDocumentCreated(bjs.ptr);
        _ = webview3.addWebMessageReceived(@ptrCast(&self.web_message_handler), &self.web_msg_token);
        self.resizeWebview();
        _ = webview3.navigate(NAV_URL);
    }

    // ---- bridge ------------------------------------------------------------

    /// Renderer -> host. The renderer posts the envelope as a string, so
    /// TryGetWebMessageAsString returns the JSON verbatim. Host-owned commands
    /// (dialogs, clipboard, open-external) are Stage 5.2 — until then the core
    /// answers UNKNOWN_COMMAND for them, which the renderer surfaces as a
    /// rejected promise (no crash). First light needs none of them.
    fn onWebMessage(ctx: *anyopaque, args_opt: ?*wv.ICoreWebView2WebMessageReceivedEventArgs) callconv(.c) void {
        const self: *App = @ptrCast(@alignCast(ctx));
        const args = args_opt orelse return;
        var msg_w: ?win32.LPWSTR = null;
        if (args.tryGetWebMessageAsString(&msg_w) != wv.S_OK) return;
        const raw = msg_w orelse return;
        defer win32.CoTaskMemFree(raw);
        const utf8 = std.unicode.utf16LeToUtf8Alloc(self.gpa, std.mem.span(raw)) catch return;
        defer self.gpa.free(utf8);
        const core = self.core orelse return;
        core.handle(utf8);
    }

    /// Core -> host emit. Called on the UI thread for command responses and on
    /// the watcher thread for events; either way, copy the core-owned string
    /// and PostMessage it to the window so delivery always runs on the UI
    /// thread, FIFO-ordered. c_allocator is thread-safe.
    fn emitToHost(userdata: ?*anyopaque, message_json: [*:0]const u8) callconv(.c) void {
        const self: *App = @ptrCast(@alignCast(userdata.?));
        const hwnd = self.hwnd orelse return;
        const copy = std.heap.c_allocator.dupeZ(u8, std.mem.span(message_json)) catch return;
        if (win32.PostMessageW(hwnd, WM_SKRIVE_EMIT, @intFromPtr(copy.ptr), 0) == 0) {
            std.heap.c_allocator.free(copy);
        }
    }

    /// UI-thread side of emit: escape the envelope per the delivery rule and
    /// ExecuteScript it into the renderer.
    fn deliverEmit(self: *App, wparam: win32.WPARAM) void {
        const ptr: [*:0]u8 = @ptrFromInt(wparam);
        const json = std.mem.span(ptr);
        defer std.heap.c_allocator.free(json);
        const webview3 = self.webview3 orelse return;

        const lit = jsescape.stringLiteral(std.heap.c_allocator, json) catch return;
        defer std.heap.c_allocator.free(lit);
        const script = std.fmt.allocPrint(std.heap.c_allocator, "window.__skriveDispatch({s});", .{lit}) catch return;
        defer std.heap.c_allocator.free(script);
        const script_w = std.unicode.utf8ToUtf16LeAllocZ(std.heap.c_allocator, script) catch return;
        defer std.heap.c_allocator.free(script_w);
        _ = webview3.executeScript(script_w.ptr);
    }

    fn resizeWebview(self: *App) void {
        const controller = self.controller orelse return;
        const hwnd = self.hwnd orelse return;
        var rc: win32.RECT = undefined;
        if (win32.GetClientRect(hwnd, &rc) == 0) return;
        _ = controller.putBounds(rc);
    }

    pub fn run(_: *App) void {
        var msg: win32.MSG = undefined;
        while (win32.GetMessageW(&msg, null, 0, 0) != 0) {
            _ = win32.TranslateMessage(&msg);
            _ = win32.DispatchMessageW(&msg);
        }
    }
};

fn wndProc(hwnd: win32.HWND, msg: u32, wparam: win32.WPARAM, lparam: win32.LPARAM) callconv(WINAPI) win32.LRESULT {
    const ud = win32.GetWindowLongPtrW(hwnd, win32.GWLP_USERDATA);
    const app: ?*App = if (ud == 0) null else @ptrFromInt(@as(usize, @bitCast(ud)));
    switch (msg) {
        WM_SKRIVE_EMIT => {
            if (app) |a| a.deliverEmit(wparam);
            return 0;
        },
        win32.WM_SIZE => {
            if (app) |a| a.resizeWebview();
            return 0;
        },
        win32.WM_DESTROY => {
            win32.PostQuitMessage(0);
            return 0;
        },
        else => return win32.DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// The directory containing the running exe (WTF-8), where the renderer assets
/// and the bridge bundle are staged. Caller owns the result.
fn getExeDir(gpa: std.mem.Allocator) ![]u8 {
    var buf: [32768]u16 = undefined;
    const n = win32.GetModuleFileNameW(null, &buf, buf.len);
    if (n == 0 or n >= buf.len) return error.ExePathFailed;
    const full = try std.unicode.utf16LeToUtf8Alloc(gpa, buf[0..n]);
    defer gpa.free(full);
    const dir = std.fs.path.dirname(full) orelse ".";
    return gpa.dupe(u8, dir);
}

fn logHr(what: []const u8, hr: wv.HRESULT) void {
    std.debug.print("[skrive] {s} failed: hr=0x{x:0>8}\n", .{ what, @as(u32, @bitCast(hr)) });
}
