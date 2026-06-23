//! The COM objects the host IMPLEMENTS — the callback direction of WebView2's
//! async API. Each is a small `extern struct` whose first field is a vtable
//! pointer (so a `*Handler` is a valid COM interface pointer) plus a plain Zig
//! callback + context the `Invoke` slot forwards to.
//!
//! Lifetime: these are owned by `App` as fields for the whole app lifetime, so
//! AddRef/Release are no-ops returning 1 — WebView2's refcounting never drives
//! our lifetime. The completed handlers are one-shot; keeping them alive after
//! their single Invoke is harmless. QueryInterface answers IUnknown and the
//! handler's own IID (some WebView2 builds QI the handler before calling it).

const std = @import("std");
const win32 = @import("win32.zig");
const wv = @import("webview2.zig");

const WINAPI = win32.WINAPI;
const HRESULT = wv.HRESULT;
const GUID = wv.GUID;

pub const EnvCompletedHandler = extern struct {
    lpVtbl: *const Vtbl,
    callback: *const fn (ctx: *anyopaque, hr: HRESULT, env: ?*wv.ICoreWebView2Environment) callconv(.c) void,
    ctx: *anyopaque,

    pub const Vtbl = extern struct {
        QueryInterface: *const fn (*EnvCompletedHandler, *const GUID, *?*anyopaque) callconv(WINAPI) HRESULT,
        AddRef: *const fn (*EnvCompletedHandler) callconv(WINAPI) u32,
        Release: *const fn (*EnvCompletedHandler) callconv(WINAPI) u32,
        Invoke: *const fn (*EnvCompletedHandler, HRESULT, ?*wv.ICoreWebView2Environment) callconv(WINAPI) HRESULT,
    };

    const vtbl = Vtbl{ .QueryInterface = qi, .AddRef = addRef, .Release = addRef, .Invoke = invoke };

    pub fn init(
        callback: *const fn (ctx: *anyopaque, hr: HRESULT, env: ?*wv.ICoreWebView2Environment) callconv(.c) void,
        ctx: *anyopaque,
    ) EnvCompletedHandler {
        return .{ .lpVtbl = &vtbl, .callback = callback, .ctx = ctx };
    }

    fn qi(self: *EnvCompletedHandler, iid: *const GUID, out: *?*anyopaque) callconv(WINAPI) HRESULT {
        if (wv.guidEql(iid, &wv.IID_IUnknown) or wv.guidEql(iid, &wv.IID_EnvironmentCompletedHandler)) {
            out.* = @ptrCast(self);
            return wv.S_OK;
        }
        out.* = null;
        return wv.E_NOINTERFACE;
    }
    fn addRef(_: *EnvCompletedHandler) callconv(WINAPI) u32 {
        return 1;
    }
    fn invoke(self: *EnvCompletedHandler, hr: HRESULT, env: ?*wv.ICoreWebView2Environment) callconv(WINAPI) HRESULT {
        self.callback(self.ctx, hr, env);
        return wv.S_OK;
    }
};

pub const ControllerCompletedHandler = extern struct {
    lpVtbl: *const Vtbl,
    callback: *const fn (ctx: *anyopaque, hr: HRESULT, controller: ?*wv.ICoreWebView2Controller) callconv(.c) void,
    ctx: *anyopaque,

    pub const Vtbl = extern struct {
        QueryInterface: *const fn (*ControllerCompletedHandler, *const GUID, *?*anyopaque) callconv(WINAPI) HRESULT,
        AddRef: *const fn (*ControllerCompletedHandler) callconv(WINAPI) u32,
        Release: *const fn (*ControllerCompletedHandler) callconv(WINAPI) u32,
        Invoke: *const fn (*ControllerCompletedHandler, HRESULT, ?*wv.ICoreWebView2Controller) callconv(WINAPI) HRESULT,
    };

    const vtbl = Vtbl{ .QueryInterface = qi, .AddRef = addRef, .Release = addRef, .Invoke = invoke };

    pub fn init(
        callback: *const fn (ctx: *anyopaque, hr: HRESULT, controller: ?*wv.ICoreWebView2Controller) callconv(.c) void,
        ctx: *anyopaque,
    ) ControllerCompletedHandler {
        return .{ .lpVtbl = &vtbl, .callback = callback, .ctx = ctx };
    }

    fn qi(self: *ControllerCompletedHandler, iid: *const GUID, out: *?*anyopaque) callconv(WINAPI) HRESULT {
        if (wv.guidEql(iid, &wv.IID_IUnknown) or wv.guidEql(iid, &wv.IID_ControllerCompletedHandler)) {
            out.* = @ptrCast(self);
            return wv.S_OK;
        }
        out.* = null;
        return wv.E_NOINTERFACE;
    }
    fn addRef(_: *ControllerCompletedHandler) callconv(WINAPI) u32 {
        return 1;
    }
    fn invoke(self: *ControllerCompletedHandler, hr: HRESULT, controller: ?*wv.ICoreWebView2Controller) callconv(WINAPI) HRESULT {
        self.callback(self.ctx, hr, controller);
        return wv.S_OK;
    }
};

pub const WebMessageHandler = extern struct {
    lpVtbl: *const Vtbl,
    callback: *const fn (ctx: *anyopaque, args: ?*wv.ICoreWebView2WebMessageReceivedEventArgs) callconv(.c) void,
    ctx: *anyopaque,

    pub const Vtbl = extern struct {
        QueryInterface: *const fn (*WebMessageHandler, *const GUID, *?*anyopaque) callconv(WINAPI) HRESULT,
        AddRef: *const fn (*WebMessageHandler) callconv(WINAPI) u32,
        Release: *const fn (*WebMessageHandler) callconv(WINAPI) u32,
        Invoke: *const fn (*WebMessageHandler, ?*anyopaque, ?*wv.ICoreWebView2WebMessageReceivedEventArgs) callconv(WINAPI) HRESULT,
    };

    const vtbl = Vtbl{ .QueryInterface = qi, .AddRef = addRef, .Release = addRef, .Invoke = invoke };

    pub fn init(
        callback: *const fn (ctx: *anyopaque, args: ?*wv.ICoreWebView2WebMessageReceivedEventArgs) callconv(.c) void,
        ctx: *anyopaque,
    ) WebMessageHandler {
        return .{ .lpVtbl = &vtbl, .callback = callback, .ctx = ctx };
    }

    fn qi(self: *WebMessageHandler, iid: *const GUID, out: *?*anyopaque) callconv(WINAPI) HRESULT {
        if (wv.guidEql(iid, &wv.IID_IUnknown) or wv.guidEql(iid, &wv.IID_WebMessageReceivedHandler)) {
            out.* = @ptrCast(self);
            return wv.S_OK;
        }
        out.* = null;
        return wv.E_NOINTERFACE;
    }
    fn addRef(_: *WebMessageHandler) callconv(WINAPI) u32 {
        return 1;
    }
    fn invoke(self: *WebMessageHandler, _: ?*anyopaque, args: ?*wv.ICoreWebView2WebMessageReceivedEventArgs) callconv(WINAPI) HRESULT {
        self.callback(self.ctx, args);
        return wv.S_OK;
    }
};
