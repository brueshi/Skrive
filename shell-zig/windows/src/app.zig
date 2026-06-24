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
const diag = @import("diag.zig");
const paths = @import("paths.zig");
const host_cmds = @import("host_cmds.zig");
const updater = @import("updater.zig");
const crashlog = @import("crashlog.zig");
const core_mod = @import("skrive_core");
const build_options = @import("build_options");

const w = win32.w;
const WINAPI = win32.WINAPI;

/// Custom message: a core emit was copied and queued for UI-thread delivery.
/// wParam is the heap pointer to the NUL-terminated copy (freed after use).
const WM_SKRIVE_EMIT: u32 = win32.WM_APP + 1;
/// Custom message: the core emitted a `host:` command (trash/reveal) for the
/// host to perform on the UI thread. wParam is the heap pointer to the copy.
const WM_SKRIVE_HOSTCMD: u32 = win32.WM_APP + 2;

const CLASS_NAME = std.unicode.utf8ToUtf16LeStringLiteral("SkriveWindowClass");
const WINDOW_TITLE = std.unicode.utf8ToUtf16LeStringLiteral("Skrive");
// `.localhost` is a reserved TLD (RFC 6761): it never resolves externally (no
// domain to own) and is exempt from HSTS — unlike `.app`, a real HSTS-preloaded
// TLD that engines force-upgrade to HTTPS, which would break our http virtual
// host. Tauri uses `tauri.localhost` for exactly this reason.
const VIRTUAL_HOST = std.unicode.utf8ToUtf16LeStringLiteral("skrive.localhost");
const NAV_URL = std.unicode.utf8ToUtf16LeStringLiteral("http://skrive.localhost/index.html");

pub const App = struct {
    gpa: std.mem.Allocator,
    hinstance: win32.HINSTANCE,
    asset_dir_w: [:0]u16,
    bridge_js_w: ?[:0]u16 = null,
    app_data_dir: []const u8,

    hwnd: ?win32.HWND = null,
    core: ?*core_mod.Core = null,
    create_env: wv.CreateEnvironmentFn = undefined,
    environment: ?*wv.ICoreWebView2Environment = null,
    controller: ?*wv.ICoreWebView2Controller = null,
    webview3: ?*wv.ICoreWebView2_3 = null,

    env_handler: handlers.EnvCompletedHandler = undefined,
    controller_handler: handlers.ControllerCompletedHandler = undefined,
    web_message_handler: handlers.WebMessageHandler = undefined,
    nav_starting_handler: handlers.NavigationStartingHandler = undefined,
    new_window_handler: handlers.NewWindowRequestedHandler = undefined,
    process_failed_handler: handlers.ProcessFailedHandler = undefined,
    web_msg_token: wv.EventRegistrationToken = .{ .value = 0 },
    nav_starting_token: wv.EventRegistrationToken = .{ .value = 0 },
    new_window_token: wv.EventRegistrationToken = .{ .value = 0 },
    process_failed_token: wv.EventRegistrationToken = .{ .value = 0 },
    user_data_dir_w: ?[:0]u16 = null,
    /// Last maximized state delivered to the renderer; dedups the WM_SIZE
    /// stream (SIZE_RESTORED fires on every resize step) so window:maximize
    /// Changed is emitted only on a real transition.
    is_maximized: bool = false,

    /// Build the window + core and kick off async WebView2 creation. The App is
    /// heap-allocated so its address is stable: the handlers hold `*App`, the
    /// window stores it in GWLP_USERDATA, and the core's emit userdata is it.
    pub fn create(gpa: std.mem.Allocator) !*App {
        diag.log("=== Skrive host starting (stage 5.1 diag build) ===", .{});
        // Install the native crash handler first thing, before the window, the
        // webview, or any worker thread — so a crash during startup is still
        // captured (Stage 6.5, parity with the macOS host's early CrashLog).
        crashlog.install(gpa);
        // WebView2 creation and its completion callbacks want a COM apartment on
        // the calling (UI) thread. Initialize STA before anything COM happens.
        const co = win32.CoInitializeEx(null, win32.COINIT_APARTMENTTHREADED);
        diag.log("CoInitializeEx hr=0x{x:0>8}", .{diag.hx(co)});

        const io = std.Io.Threaded.global_single_threaded.io();

        const exe_dir = try getExeDir(gpa);
        defer gpa.free(exe_dir);
        const asset_dir = try std.fs.path.join(gpa, &.{ exe_dir, "renderer" });
        defer gpa.free(asset_dir);
        diag.log("asset dir: {s}", .{asset_dir});
        const asset_dir_w = try std.unicode.utf8ToUtf16LeAllocZ(gpa, asset_dir);
        errdefer gpa.free(asset_dir_w);

        // The core's persistence and the WebView2 user-data folder both live
        // under %APPDATA%\Skrive (the WebView2 store in a subfolder so it does
        // not mingle with the core's state files).
        const app_data_dir = try paths.appDataDir(gpa);
        errdefer gpa.free(app_data_dir);
        diag.log("app data dir: {s}", .{app_data_dir});
        const wv_data_dir = try std.fs.path.join(gpa, &.{ app_data_dir, "WebView2" });
        defer gpa.free(wv_data_dir);
        const wv_data_dir_w = try std.unicode.utf8ToUtf16LeAllocZ(gpa, wv_data_dir);
        errdefer gpa.free(wv_data_dir_w);

        const self = try gpa.create(App);
        errdefer gpa.destroy(self);
        self.* = .{
            .gpa = gpa,
            .hinstance = @ptrCast(win32.GetModuleHandleW(null) orelse return error.NoModuleHandle),
            .asset_dir_w = asset_dir_w,
            .app_data_dir = app_data_dir,
            .user_data_dir_w = wv_data_dir_w,
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
            diag.log("bridge loaded: {d} bytes", .{js.len});
        } else |err| {
            diag.log("WARN could not read native-bridge.js: {s}", .{@errorName(err)});
        }

        self.create_env = wv.loadCreateEnvironment() orelse {
            diag.log("FATAL WebView2Loader.dll / CreateCoreWebView2EnvironmentWithOptions not found", .{});
            return error.WebView2LoaderMissing;
        };
        diag.log("WebView2Loader resolved", .{});
        self.core = core_mod.Core.create(io, app_data_dir, emitToHost, self) catch return error.CoreCreateFailed;
        self.env_handler = handlers.EnvCompletedHandler.init(onEnvCreated, self);
        self.controller_handler = handlers.ControllerCompletedHandler.init(onControllerCreated, self);
        self.web_message_handler = handlers.WebMessageHandler.init(onWebMessage, self);
        self.nav_starting_handler = handlers.NavigationStartingHandler.init(onNavigationStarting, self);
        self.new_window_handler = handlers.NewWindowRequestedHandler.init(onNewWindowRequested, self);
        self.process_failed_handler = handlers.ProcessFailedHandler.init(onProcessFailed, self);

        try self.createWindow();
        diag.log("window created", .{});

        // Start the WinSparkle auto-updater on the UI thread now the window
        // exists. Host-native: WinSparkle does its own HTTPS + dialog and never
        // touches the renderer's net:* seam. Best-effort (no DLL -> no updater).
        updater.start(gpa, build_options.version);

        const user_data: ?win32.LPCWSTR = if (self.user_data_dir_w) |d| d.ptr else null;
        const hr = self.create_env(null, user_data, null, @ptrCast(&self.env_handler));
        diag.log("CreateEnvironment requested, hr=0x{x:0>8}", .{diag.hx(hr)});
        if (hr != wv.S_OK) logHr("CreateCoreWebView2EnvironmentWithOptions", hr);
        return self;
    }

    fn createWindow(self: *App) !void {
        // The icon embedded as IDI_SKRIVE (skrive.rc), loaded from this exe's
        // own module — drives the window's title-bar corner, taskbar button,
        // and Alt-Tab entry. Same handle for large and small; Windows scales.
        const icon = win32.LoadIconW(self.hinstance, win32.makeIntResourceW(win32.IDI_SKRIVE));
        // Theme-matched background: the frameless window keeps a thin OS resize
        // frame (B3), and this is the color it shows — chosen to match the
        // renderer's pre-paint shell bg (#161719 dark / #e7e8ea light, same as
        // the macOS host) so the frame reads as intentional padding, not chrome.
        const bg = themeBackgroundBrush() orelse win32.COLOR_WINDOW_BRUSH;
        const wc = win32.WNDCLASSEXW{
            .cbSize = @sizeOf(win32.WNDCLASSEXW),
            .style = win32.CS_HREDRAW | win32.CS_VREDRAW,
            .lpfnWndProc = wndProc,
            .cbClsExtra = 0,
            .cbWndExtra = 0,
            .hInstance = self.hinstance,
            .hIcon = icon,
            .hCursor = win32.LoadCursorW(null, win32.IDC_ARROW),
            .hbrBackground = bg,
            .lpszMenuName = null,
            .lpszClassName = CLASS_NAME,
            .hIconSm = icon,
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
        // Force a WM_NCCALCSIZE pass so the frameless client rect (caption
        // reclaimed) takes effect before the first paint, not on the first
        // resize.
        _ = win32.SetWindowPos(hwnd, null, 0, 0, 0, 0, win32.SWP_NOMOVE | win32.SWP_NOSIZE | win32.SWP_NOZORDER | win32.SWP_FRAMECHANGED);
        // B4: restore the saved size/position/maximized state (which also shows
        // the window via its showCmd). First launch (or unreadable state) falls
        // back to the default placement.
        if (!self.restoreWindowState()) {
            _ = win32.ShowWindow(hwnd, win32.SW_SHOWDEFAULT);
        }
        _ = win32.UpdateWindow(hwnd);
    }

    // ---- async WebView2 creation callbacks (UI thread) --------------------

    fn onEnvCreated(ctx: *anyopaque, hr: wv.HRESULT, env_opt: ?*wv.ICoreWebView2Environment) callconv(.c) void {
        const self: *App = @ptrCast(@alignCast(ctx));
        diag.log("onEnvCreated fired, hr=0x{x:0>8}", .{diag.hx(hr)});
        if (hr != wv.S_OK) return logHr("environment created", hr);
        const env = env_opt orelse {
            diag.log("onEnvCreated: env is null despite S_OK", .{});
            return;
        };
        // Retain the environment for the app lifetime: the object passed to a
        // completion handler is borrowed, so storing the raw pointer without
        // AddRef lets it be destroyed when this callback returns.
        _ = wv.asUnknown(env).addRef();
        self.environment = env;
        const chr = env.createController(self.hwnd, @ptrCast(&self.controller_handler));
        diag.log("CreateController requested, hr=0x{x:0>8}", .{diag.hx(chr)});
        if (chr != wv.S_OK) logHr("CreateCoreWebView2Controller", chr);
    }

    fn onControllerCreated(ctx: *anyopaque, hr: wv.HRESULT, controller_opt: ?*wv.ICoreWebView2Controller) callconv(.c) void {
        const self: *App = @ptrCast(@alignCast(ctx));
        diag.log("onControllerCreated fired, hr=0x{x:0>8}", .{diag.hx(hr)});
        if (hr != wv.S_OK) return logHr("controller created", hr);
        const controller = controller_opt orelse return;
        // Retain the controller for the app lifetime — THE fix for the webview
        // tearing down right after creation: it is a borrowed reference, and
        // dropping it destroys the controller (and the whole WebView2 process
        // tree) the moment this callback returns.
        _ = wv.asUnknown(controller).addRef();
        self.controller = controller;

        var cwv: ?*anyopaque = null;
        const ghr = controller.getCoreWebView2(&cwv);
        diag.log("get_CoreWebView2 hr=0x{x:0>8}", .{diag.hx(ghr)});
        if (ghr != wv.S_OK) return;
        const cwv_ptr = cwv orelse return;

        // QI the base ICoreWebView2 up to _3 for SetVirtualHostNameToFolderMapping.
        // get_CoreWebView2 returned a reference we own; QI takes its own, so we
        // release the base interface and keep webview3.
        var p3: ?*anyopaque = null;
        const qhr = wv.asUnknown(cwv_ptr).queryInterface(&wv.IID_ICoreWebView2_3, &p3);
        diag.log("QI ICoreWebView2_3 hr=0x{x:0>8}", .{diag.hx(qhr)});
        if (qhr != wv.S_OK) return;
        const webview3: *wv.ICoreWebView2_3 = @ptrCast(@alignCast(p3 orelse return));
        _ = wv.asUnknown(cwv_ptr).release();
        self.webview3 = webview3;

        const vhr = webview3.setVirtualHostMapping(VIRTUAL_HOST, self.asset_dir_w.ptr, .allow);
        diag.log("setVirtualHostMapping hr=0x{x:0>8}", .{diag.hx(vhr)});
        if (self.bridge_js_w) |bjs| {
            const ahr = webview3.addScriptOnDocumentCreated(bjs.ptr);
            diag.log("addScriptOnDocumentCreated hr=0x{x:0>8}", .{diag.hx(ahr)});
        }
        const mhr = webview3.addWebMessageReceived(@ptrCast(&self.web_message_handler), &self.web_msg_token);
        diag.log("addWebMessageReceived hr=0x{x:0>8}", .{diag.hx(mhr)});

        // B5: DevTools/F12 only in dev builds, mirroring the macOS host's
        // #if DEBUG inspector gate. get_Settings returns an owned reference.
        var settings_ptr: ?*anyopaque = null;
        if (webview3.getSettings(&settings_ptr) == wv.S_OK) {
            if (settings_ptr) |sp| {
                const settings: *wv.ICoreWebView2Settings = @ptrCast(@alignCast(sp));
                const dhr = settings.putAreDevToolsEnabled(if (build_options.dev) 1 else 0);
                diag.log("putAreDevToolsEnabled({}) hr=0x{x:0>8}", .{ build_options.dev, diag.hx(dhr) });
                // B3: enable non-client-region support so the renderer's
                // `app-region: drag` topbar acts as the window caption (drag,
                // double-click maximize, right-click system menu) — the clean
                // path vs hand-rolled WM_NCHITTEST through the WebView2 child.
                var s9_ptr: ?*anyopaque = null;
                if (wv.asUnknown(sp).queryInterface(&wv.IID_ICoreWebView2Settings9, &s9_ptr) == wv.S_OK) {
                    if (s9_ptr) |s9p| {
                        const s9: *wv.ICoreWebView2Settings9 = @ptrCast(@alignCast(s9p));
                        const ncr = s9.putIsNonClientRegionSupportEnabled(1);
                        diag.log("putIsNonClientRegionSupportEnabled hr=0x{x:0>8}", .{diag.hx(ncr)});
                        _ = wv.asUnknown(s9p).release();
                    }
                }
                _ = wv.asUnknown(sp).release();
            }
        }

        // A1: navigation backstop. Pin the main frame to the app origin and
        // route popups / external links out to the OS browser.
        const nshr = webview3.addNavigationStarting(@ptrCast(&self.nav_starting_handler), &self.nav_starting_token);
        diag.log("addNavigationStarting hr=0x{x:0>8}", .{diag.hx(nshr)});
        const nwhr = webview3.addNewWindowRequested(@ptrCast(&self.new_window_handler), &self.new_window_token);
        diag.log("addNewWindowRequested hr=0x{x:0>8}", .{diag.hx(nwhr)});

        // 6.5: webview process-death backstop. On a browser/renderer/GPU
        // process failure, log a breadcrumb and reload the renderer.
        const pfhr = webview3.addProcessFailed(@ptrCast(&self.process_failed_handler), &self.process_failed_token);
        diag.log("addProcessFailed hr=0x{x:0>8}", .{diag.hx(pfhr)});

        var rc: win32.RECT = undefined;
        _ = win32.GetClientRect(self.hwnd.?, &rc);
        diag.log("client rect = {d}x{d}", .{ rc.right - rc.left, rc.bottom - rc.top });
        self.resizeWebview();

        const nhr = webview3.navigate(NAV_URL);
        diag.log("navigate hr=0x{x:0>8}", .{diag.hx(nhr)});
    }

    // ---- navigation backstop (A1) -----------------------------------------

    /// Whether `uri` may load in the main frame. The app origin
    /// (http://skrive.localhost) and the renderer-internal schemes
    /// (about:/blob:/data:) are in-app; everything else is off-origin and gets
    /// cancelled + routed externally. Mirrors the macOS decidePolicyFor switch.
    fn isInAppOrigin(uri: []const u8) bool {
        return std.mem.startsWith(u8, uri, "http://skrive.localhost") or
            std.mem.startsWith(u8, uri, "about:") or
            std.mem.startsWith(u8, uri, "blob:") or
            std.mem.startsWith(u8, uri, "data:");
    }

    /// Cancel any main-frame navigation off the app origin and hand the URI to
    /// the OS browser (host_cmds.openExternal enforces the scheme allowlist, so
    /// a disallowed scheme like file:// is simply cancelled with no open). A
    /// link in a note can never replace the running app.
    fn onNavigationStarting(ctx: *anyopaque, args_opt: ?*wv.ICoreWebView2NavigationStartingEventArgs) callconv(.c) void {
        const self: *App = @ptrCast(@alignCast(ctx));
        const args = args_opt orelse return;
        var uri_w: ?win32.LPWSTR = null;
        if (args.getUri(&uri_w) != wv.S_OK) return;
        const raw = uri_w orelse return;
        defer win32.CoTaskMemFree(raw);
        const uri = std.unicode.utf16LeToUtf8Alloc(self.gpa, std.mem.span(raw)) catch return;
        defer self.gpa.free(uri);
        if (isInAppOrigin(uri)) return;
        _ = args.putCancel(1);
        host_cmds.openExternal(self.gpa, uri);
        diag.log("nav backstop: cancelled off-origin nav to {s}", .{uri});
    }

    /// Suppress popups (window.open / target=_blank) and route their target to
    /// the OS browser. Handled is set unconditionally so no child webview ever
    /// spawns, even if the URI can't be read. Mirrors createWebViewWith on macOS.
    fn onNewWindowRequested(ctx: *anyopaque, args_opt: ?*wv.ICoreWebView2NewWindowRequestedEventArgs) callconv(.c) void {
        const self: *App = @ptrCast(@alignCast(ctx));
        const args = args_opt orelse return;
        var uri_w: ?win32.LPWSTR = null;
        if (args.getUri(&uri_w) == wv.S_OK) {
            if (uri_w) |raw| {
                defer win32.CoTaskMemFree(raw);
                if (std.unicode.utf16LeToUtf8Alloc(self.gpa, std.mem.span(raw))) |uri| {
                    defer self.gpa.free(uri);
                    host_cmds.openExternal(self.gpa, uri);
                } else |_| {}
            }
        }
        _ = args.putHandled(1);
    }

    /// WebView2 process death (6.5). Record a local breadcrumb and reload the
    /// renderer to recover — the Windows twin of the macOS host's
    /// webViewWebContentProcessDidTerminate. Best-effort; runs on the UI thread.
    fn onProcessFailed(ctx: *anyopaque) callconv(.c) void {
        const self: *App = @ptrCast(@alignCast(ctx));
        diag.log("webview ProcessFailed; reloading", .{});
        crashlog.logWebviewTermination(self.gpa);
        if (self.webview3) |wv3| _ = wv3.reload();
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
        // Host-owned commands (dialogs, clipboard, open-external) are answered
        // here and never reach the core; everything else forwards.
        if (self.routeHostOwned(utf8)) return;
        const core = self.core orelse return;
        core.handle(utf8);
    }

    /// Handle a host-owned command, replying to the renderer directly. Returns
    /// true if `request` was one. Mirrors the macOS CoreBridge.routeHostOwned.
    fn routeHostOwned(self: *App, request: []const u8) bool {
        var arena = std.heap.ArenaAllocator.init(self.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, request, .{}) catch return false;
        if (parsed != .object) return false;
        const obj = parsed.object;
        const cmd = switch (obj.get("cmd") orelse return false) {
            .string => |s| s,
            else => return false,
        };
        const id = switch (obj.get("id") orelse return false) {
            .integer => |i| i,
            else => return false,
        };
        const payload: ?std.json.ObjectMap = switch (obj.get("payload") orelse std.json.Value{ .null = {} }) {
            .object => |o| o,
            else => null,
        };

        if (std.mem.eql(u8, cmd, "project:openDialog")) {
            const path = host_cmds.pickFolder(self.gpa, self.hwnd);
            defer if (path) |p| self.gpa.free(p);
            if (path) |p| {
                const q = jsonQuote(self.gpa, p) catch return true;
                defer self.gpa.free(q);
                const result = std.fmt.allocPrint(self.gpa, "{{\"path\":{s}}}", .{q}) catch return true;
                defer self.gpa.free(result);
                self.sendOk(id, result);
            } else self.sendOk(id, "{\"path\":null}");
            return true;
        }
        // B3 window controls: the renderer's custom min/max/close buttons
        // (frameless chrome) drive these. Host-owned, like the dialogs.
        if (std.mem.eql(u8, cmd, "window:minimize")) {
            if (self.hwnd) |h| _ = win32.ShowWindow(h, win32.SW_MINIMIZE);
            self.sendOk(id, "{}");
            return true;
        }
        if (std.mem.eql(u8, cmd, "window:toggleMaximize")) {
            if (self.hwnd) |h| {
                if (win32.IsZoomed(h) != 0) {
                    _ = win32.ShowWindow(h, win32.SW_RESTORE);
                } else {
                    _ = win32.ShowWindow(h, win32.SW_MAXIMIZE);
                }
            }
            self.sendOk(id, "{}");
            return true;
        }
        if (std.mem.eql(u8, cmd, "window:close")) {
            if (self.hwnd) |h| _ = win32.PostMessageW(h, win32.WM_CLOSE, 0, 0);
            self.sendOk(id, "{}");
            return true;
        }
        if (std.mem.eql(u8, cmd, "window:isMaximized")) {
            const m = if (self.hwnd) |h| win32.IsZoomed(h) != 0 else false;
            const result = std.fmt.allocPrint(self.gpa, "{{\"maximized\":{s}}}", .{if (m) "true" else "false"}) catch return true;
            defer self.gpa.free(result);
            self.sendOk(id, result);
            return true;
        }
        if (std.mem.eql(u8, cmd, "links:openExternal")) {
            if (payload) |p| if (p.get("url")) |u| switch (u) {
                .string => |s| host_cmds.openExternal(self.gpa, s),
                else => {},
            };
            self.sendOk(id, "{}");
            return true;
        }
        if (std.mem.eql(u8, cmd, "clipboard:writeText")) {
            if (payload) |p| if (p.get("text")) |t| switch (t) {
                .string => |s| host_cmds.writeText(self.gpa, self.hwnd, s),
                else => {},
            };
            self.sendOk(id, "{}");
            return true;
        }
        if (std.mem.eql(u8, cmd, "clipboard:writeRich")) {
            var html: []const u8 = "";
            var text: []const u8 = "";
            if (payload) |p| {
                if (p.get("html")) |h| switch (h) {
                    .string => |s| html = s,
                    else => {},
                };
                if (p.get("text")) |t| switch (t) {
                    .string => |s| text = s,
                    else => {},
                };
            }
            host_cmds.writeRich(self.gpa, self.hwnd, html, text);
            self.sendOk(id, "{}");
            return true;
        }
        if (std.mem.eql(u8, cmd, "clipboard:readText")) {
            const text = host_cmds.readText(self.gpa, self.hwnd) orelse (self.gpa.dupe(u8, "") catch return true);
            defer self.gpa.free(text);
            const q = jsonQuote(self.gpa, text) catch return true;
            defer self.gpa.free(q);
            const result = std.fmt.allocPrint(self.gpa, "{{\"text\":{s}}}", .{q}) catch return true;
            defer self.gpa.free(result);
            self.sendOk(id, result);
            return true;
        }
        // Host-owned per the contract: return the build version (stamped from
        // package.json via -Dversion), the same value WinSparkle compares
        // against the appcast. The core's app:version is a spike string, so we
        // intercept here to keep the displayed version consistent with the
        // updater (parity with the macOS CoreBridge).
        if (std.mem.eql(u8, cmd, "app:version")) {
            const q = jsonQuote(self.gpa, build_options.version) catch return true;
            defer self.gpa.free(q);
            const result = std.fmt.allocPrint(self.gpa, "{{\"version\":{s}}}", .{q}) catch return true;
            defer self.gpa.free(result);
            self.sendOk(id, result);
            return true;
        }
        // 6.5 diagnostics. Renderer errors (window.onerror / unhandledrejection)
        // can't be written by the sandboxed renderer, so the host appends them
        // to the local crash log; "Reveal diagnostics" opens that folder. Both
        // local only, never uploaded.
        if (std.mem.eql(u8, cmd, "log:append")) {
            if (payload) |p| if (p.get("line")) |l| switch (l) {
                .string => |s| crashlog.appendRenderer(self.gpa, s),
                else => {},
            };
            self.sendOk(id, "{}");
            return true;
        }
        if (std.mem.eql(u8, cmd, "log:reveal")) {
            crashlog.reveal(self.gpa);
            self.sendOk(id, "{}");
            return true;
        }
        // The Settings "Check for updates" button -> WinSparkle's own dialog.
        // Status is shown by WinSparkle's UI, not streamed via updater:status.
        if (std.mem.eql(u8, cmd, "updater:check")) {
            updater.check();
            self.sendOk(id, "{}");
            return true;
        }
        return false;
    }

    /// Perform a core-delegated `host:` command (trash/reveal) on the UI thread
    /// and reply on the host channel; the core turns the reply into the
    /// deferred renderer response. Deferred via PostMessage so this never
    /// re-enters the core's original `handle` arena.
    fn handleHostCommand(self: *App, wparam: win32.WPARAM) void {
        const ptr: [*:0]u8 = @ptrFromInt(wparam);
        const json = std.mem.span(ptr);
        defer std.heap.c_allocator.free(json);
        var arena = std.heap.ArenaAllocator.init(self.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, json, .{}) catch return;
        if (parsed != .object) return;
        const obj = parsed.object;
        const verb = switch (obj.get("host") orelse return) {
            .string => |s| s,
            else => return,
        };
        const id = switch (obj.get("id") orelse return) {
            .integer => |i| i,
            else => return,
        };
        const path = switch (obj.get("path") orelse std.json.Value{ .null = {} }) {
            .string => |s| s,
            else => "",
        };
        const ok = if (std.mem.eql(u8, verb, "trash"))
            host_cmds.trash(self.gpa, path)
        else if (std.mem.eql(u8, verb, "reveal"))
            host_cmds.reveal(self.gpa, path)
        else
            false;
        const reply = std.fmt.allocPrint(self.gpa, "{{\"v\":1,\"host\":\"result\",\"id\":{d},\"ok\":{s}}}", .{ id, if (ok) "true" else "false" }) catch return;
        defer self.gpa.free(reply);
        const core = self.core orelse return;
        core.handle(reply);
    }

    fn sendOk(self: *App, id: i64, result_json: []const u8) void {
        const env = std.fmt.allocPrint(self.gpa, "{{\"v\":1,\"id\":{d},\"ok\":true,\"result\":{s}}}", .{ id, result_json }) catch return;
        defer self.gpa.free(env);
        self.sendToRenderer(env);
    }

    /// Escape `json` per the delivery rule and ExecuteScript it into the
    /// renderer. UI thread only.
    fn sendToRenderer(self: *App, json: []const u8) void {
        const webview3 = self.webview3 orelse return;
        const lit = jsescape.stringLiteral(self.gpa, json) catch return;
        defer self.gpa.free(lit);
        const script = std.fmt.allocPrint(self.gpa, "window.__skriveDispatch({s});", .{lit}) catch return;
        defer self.gpa.free(script);
        const script_w = std.unicode.utf8ToUtf16LeAllocZ(self.gpa, script) catch return;
        defer self.gpa.free(script_w);
        _ = webview3.executeScript(script_w.ptr);
    }

    /// Core -> host emit. Called on the UI thread for command responses and on
    /// the watcher thread for events; either way, copy the core-owned string
    /// and PostMessage it to the window so delivery always runs on the UI
    /// thread, FIFO-ordered. c_allocator is thread-safe.
    fn emitToHost(userdata: ?*anyopaque, message_json: [*:0]const u8) callconv(.c) void {
        const self: *App = @ptrCast(@alignCast(userdata.?));
        const hwnd = self.hwnd orelse return;
        const msg = std.mem.span(message_json);
        const copy = std.heap.c_allocator.dupeZ(u8, msg) catch return;
        // A `host:` envelope is a core-delegated OS action (trash/reveal), not
        // renderer-bound; route it to the host-command handler instead.
        const wm = if (std.mem.startsWith(u8, msg, "{\"v\":1,\"host\":")) WM_SKRIVE_HOSTCMD else WM_SKRIVE_EMIT;
        if (win32.PostMessageW(hwnd, wm, @intFromPtr(copy.ptr), 0) == 0) {
            std.heap.c_allocator.free(copy);
        }
    }

    /// UI-thread side of emit: deliver the envelope to the renderer.
    fn deliverEmit(self: *App, wparam: win32.WPARAM) void {
        const ptr: [*:0]u8 = @ptrFromInt(wparam);
        const json = std.mem.span(ptr);
        defer std.heap.c_allocator.free(json);
        self.sendToRenderer(json);
    }

    fn resizeWebview(self: *App) void {
        const controller = self.controller orelse return;
        const hwnd = self.hwnd orelse return;
        var rc: win32.RECT = undefined;
        if (win32.GetClientRect(hwnd, &rc) == 0) return;
        _ = controller.putBounds(rc);
    }

    /// Tell the renderer the window's maximize state changed, so its custom
    /// maximize/restore glyph stays in sync. Deduped against the last delivered
    /// state (WM_SIZE/SIZE_RESTORED fires on every resize step). Safe before the
    /// webview exists (sendToRenderer no-ops until then).
    fn setMaximized(self: *App, maximized: bool) void {
        if (self.is_maximized == maximized) return;
        self.is_maximized = maximized;
        const env = std.fmt.allocPrint(
            self.gpa,
            "{{\"event\":\"window:maximizeChanged\",\"payload\":{{\"maximized\":{s}}}}}",
            .{if (maximized) "true" else "false"},
        ) catch return;
        defer self.gpa.free(env);
        self.sendToRenderer(env);
    }

    // ---- window-state persistence (B4) ------------------------------------

    /// %APPDATA%\Skrive\window-state.json. Caller owns the result.
    fn windowStatePath(self: *App, gpa: std.mem.Allocator) ![]u8 {
        return std.fs.path.join(gpa, &.{ self.app_data_dir, "window-state.json" });
    }

    /// Persist the restored (un-maximized) rect + maximized flag on close.
    /// WINDOWPLACEMENT.rcNormalPosition is the normal rect even when the window
    /// is currently maximized, so a maximized window reopens maximized but
    /// un-maximizes to where it last was. Best-effort; failures are silent.
    fn saveWindowState(self: *App) void {
        const hwnd = self.hwnd orelse return;
        var wp: win32.WINDOWPLACEMENT = std.mem.zeroes(win32.WINDOWPLACEMENT);
        wp.length = @sizeOf(win32.WINDOWPLACEMENT);
        if (win32.GetWindowPlacement(hwnd, &wp) == 0) return;
        const r = wp.rcNormalPosition;
        const maximized = wp.showCmd == 3; // SW_SHOWMAXIMIZED
        const json = std.fmt.allocPrint(
            self.gpa,
            "{{\"x\":{d},\"y\":{d},\"w\":{d},\"h\":{d},\"maximized\":{s}}}",
            .{ r.left, r.top, r.right - r.left, r.bottom - r.top, if (maximized) "true" else "false" },
        ) catch return;
        defer self.gpa.free(json);
        const path = self.windowStatePath(self.gpa) catch return;
        defer self.gpa.free(path);
        const io = std.Io.Threaded.global_single_threaded.io();
        std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = json }) catch {};
    }

    /// Restore the saved placement (and show the window). Returns whether it
    /// restored — false means no/invalid state, and the caller shows the window
    /// with the default placement instead.
    fn restoreWindowState(self: *App) bool {
        const hwnd = self.hwnd orelse return false;
        const path = self.windowStatePath(self.gpa) catch return false;
        defer self.gpa.free(path);
        const io = std.Io.Threaded.global_single_threaded.io();
        const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, self.gpa, .unlimited) catch return false;
        defer self.gpa.free(bytes);
        var arena = std.heap.ArenaAllocator.init(self.gpa);
        defer arena.deinit();
        const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena.allocator(), bytes, .{}) catch return false;
        if (parsed != .object) return false;
        const o = parsed.object;
        const x = jsonInt(o, "x") orelse return false;
        const y = jsonInt(o, "y") orelse return false;
        const wdt = jsonInt(o, "w") orelse return false;
        const hgt = jsonInt(o, "h") orelse return false;
        if (wdt < win32.MIN_WIDTH or hgt < win32.MIN_HEIGHT) return false;
        const maximized = switch (o.get("maximized") orelse std.json.Value{ .null = {} }) {
            .bool => |b| b,
            else => false,
        };
        var wp: win32.WINDOWPLACEMENT = std.mem.zeroes(win32.WINDOWPLACEMENT);
        wp.length = @sizeOf(win32.WINDOWPLACEMENT);
        wp.showCmd = if (maximized) 3 else 1; // SW_SHOWMAXIMIZED : SW_SHOWNORMAL
        wp.rcNormalPosition = .{ .left = x, .top = y, .right = x + wdt, .bottom = y + hgt };
        wp.ptMinPosition = .{ .x = -1, .y = -1 };
        wp.ptMaxPosition = .{ .x = -1, .y = -1 };
        return win32.SetWindowPlacement(hwnd, &wp) != 0;
    }

    pub fn run(_: *App) void {
        var msg: win32.MSG = undefined;
        while (win32.GetMessageW(&msg, null, 0, 0) != 0) {
            _ = win32.TranslateMessage(&msg);
            _ = win32.DispatchMessageW(&msg);
        }
    }
};

/// Read an i32 field from a parsed JSON object, or null if missing/wrong type.
fn jsonInt(o: std.json.ObjectMap, key: []const u8) ?i32 {
    return switch (o.get(key) orelse return null) {
        .integer => |i| std.math.cast(i32, i),
        else => null,
    };
}

fn wndProc(hwnd: win32.HWND, msg: u32, wparam: win32.WPARAM, lparam: win32.LPARAM) callconv(WINAPI) win32.LRESULT {
    const ud = win32.GetWindowLongPtrW(hwnd, win32.GWLP_USERDATA);
    const app: ?*App = if (ud == 0) null else @ptrFromInt(@as(usize, @bitCast(ud)));
    switch (msg) {
        WM_SKRIVE_EMIT => {
            if (app) |a| a.deliverEmit(wparam);
            return 0;
        },
        WM_SKRIVE_HOSTCMD => {
            if (app) |a| a.handleHostCommand(wparam);
            return 0;
        },
        win32.WM_NCCALCSIZE => {
            // Frameless chrome (B3). DefWindowProc computes the standard client
            // rect (insets all four edges for the resize frame + caption); we
            // then reclaim the top into the client area. The left/right/bottom
            // resize frames stay non-client, so resizing those edges + corners
            // is OS-native with no custom WM_NCHITTEST (the WebView2 child would
            // otherwise swallow interior hits).
            if (wparam != 0) {
                const p: *win32.NCCALCSIZE_PARAMS = @ptrFromInt(@as(usize, @bitCast(lparam)));
                const requested_top = p.rgrc[0].top;
                const ret = win32.DefWindowProcW(hwnd, msg, wparam, lparam);
                if (win32.IsZoomed(hwnd) == 0) {
                    // Not maximized: reclaim the ENTIRE top edge so the topbar
                    // runs flush to the window top. Leaving even the thin top
                    // resize-frame strip non-client makes DWM paint it with the
                    // user's accent color (the reported green bar). Cost: no
                    // top-edge resize (corners/sides still resize).
                    p.rgrc[0].top = requested_top;
                } else {
                    // Maximized: keep DefWindowProc's inset (it accounts for the
                    // off-screen overhang) and reclaim just the caption, which
                    // lands the client top exactly at the visible work-area top.
                    p.rgrc[0].top -= win32.GetSystemMetrics(win32.SM_CYCAPTION);
                }
                return ret;
            }
            return win32.DefWindowProcW(hwnd, msg, wparam, lparam);
        },
        win32.WM_GETMINMAXINFO => {
            const mmi: *win32.MINMAXINFO = @ptrFromInt(@as(usize, @bitCast(lparam)));
            mmi.ptMinTrackSize = .{ .x = win32.MIN_WIDTH, .y = win32.MIN_HEIGHT };
            return 0;
        },
        win32.WM_SIZE => {
            if (app) |a| {
                a.resizeWebview();
                if (wparam == win32.SIZE_MAXIMIZED) {
                    a.setMaximized(true);
                } else if (wparam == win32.SIZE_RESTORED) {
                    a.setMaximized(false);
                }
            }
            return 0;
        },
        win32.WM_DESTROY => {
            if (app) |a| a.saveWindowState();
            // Flush WinSparkle's background thread before the loop exits.
            updater.shutdown();
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
    diag.log("[skrive] {s} failed: hr=0x{x:0>8}", .{ what, diag.hx(hr) });
}

/// A solid brush in the pre-paint shell color for the current OS theme. COLORREF
/// is 0x00BBGGRR; #161719 -> 0x00191716, #e7e8ea -> 0x00eae8e7 (matches the
/// macOS host's window.backgroundColor). Caller treats null as "fall back".
fn themeBackgroundBrush() ?win32.w.HBRUSH {
    const dark: u32 = 0x00191716;
    const light: u32 = 0x00eae8e7;
    return win32.CreateSolidBrush(if (isLightTheme()) light else dark);
}

/// Whether Windows is in light app mode (HKCU Personalize\AppsUseLightTheme).
/// Defaults to dark on any read failure — a safe neutral for the frame sliver.
fn isLightTheme() bool {
    const subkey = std.unicode.utf8ToUtf16LeStringLiteral("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
    const value = std.unicode.utf8ToUtf16LeStringLiteral("AppsUseLightTheme");
    var data: u32 = 0;
    var cb: u32 = @sizeOf(u32);
    const rc = win32.RegGetValueW(win32.HKEY_CURRENT_USER, subkey, value, win32.RRF_RT_REG_DWORD, null, &data, &cb);
    if (rc != 0) return false;
    return data != 0;
}

/// Quote + JSON-escape a string for embedding as a JSON value (paths contain
/// backslashes; text contains quotes/newlines). Caller owns the result.
fn jsonQuote(gpa: std.mem.Allocator, s: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.append(gpa, '"');
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice(gpa, "\\\""),
            '\\' => try out.appendSlice(gpa, "\\\\"),
            '\n' => try out.appendSlice(gpa, "\\n"),
            '\r' => try out.appendSlice(gpa, "\\r"),
            '\t' => try out.appendSlice(gpa, "\\t"),
            else => {
                if (c < 0x20) {
                    var tmp: [8]u8 = undefined;
                    try out.appendSlice(gpa, try std.fmt.bufPrint(&tmp, "\\u{x:0>4}", .{c}));
                } else try out.append(gpa, c);
            },
        }
    }
    try out.append(gpa, '"');
    return out.toOwnedSlice(gpa);
}
