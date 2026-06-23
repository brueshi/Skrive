//! Hand-declared WebView2 COM ABI — the surface the host calls and implements.
//!
//! Vtable layouts and IIDs are transcribed from the official `WebView2.h`
//! (SDK 1.0.3351.48); these are frozen COM contracts (newer SDKs only add
//! `_4`/`_5`/... interfaces). COM vtables are positional, so EVERY slot must be
//! present in declaration order. Risk-reduction tactic: only the methods the
//! host actually calls are given real signatures; every other slot is a
//! pointer-sized `Slot` filler, grouped into array runs whose lengths are
//! audited against the header slot numbers (in comments). A wrong filler count
//! is therefore visible by arithmetic, and can't silently shift a real method.
//!
//! All COM methods use the single Win64 calling convention (`STDMETHODCALLTYPE`
//! is a no-op on x86_64), which Zig's `callconv(.winapi)` matches; the hidden
//! `this` is the first argument.

const std = @import("std");
const win32 = @import("win32.zig");
const w = win32.w;

const WINAPI = win32.WINAPI;
const LPCWSTR = win32.LPCWSTR;
const LPWSTR = win32.LPWSTR;

pub const HRESULT = i32;
pub const S_OK: HRESULT = 0;
pub const E_NOINTERFACE: HRESULT = @bitCast(@as(u32, 0x80004002));
pub const E_POINTER: HRESULT = @bitCast(@as(u32, 0x80004003));

/// A vtable slot the host never calls. Pointer-sized; preserves layout.
const Slot = *const anyopaque;

/// An 8-byte token returned by every `add_*` event registration; passed back
/// by value to `remove_*`. We register once for the app lifetime and never
/// remove, but the out-param must still be the right size/shape.
pub const EventRegistrationToken = extern struct { value: i64 };

/// COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND.
pub const HostResourceAccessKind = enum(i32) { deny = 0, allow = 1, deny_cors = 2 };

// ---- GUID / IID -----------------------------------------------------------

pub const GUID = extern struct {
    Data1: u32,
    Data2: u16,
    Data3: u16,
    Data4: [8]u8,
};

fn parseHex(comptime T: type, comptime s: []const u8) T {
    return std.fmt.parseInt(T, s, 16) catch unreachable;
}

/// Parse the canonical 8-4-4-4-12 GUID string at comptime.
pub fn guid(comptime s: []const u8) GUID {
    return .{
        .Data1 = parseHex(u32, s[0..8]),
        .Data2 = parseHex(u16, s[9..13]),
        .Data3 = parseHex(u16, s[14..18]),
        .Data4 = .{
            parseHex(u8, s[19..21]), parseHex(u8, s[21..23]),
            parseHex(u8, s[24..26]), parseHex(u8, s[26..28]),
            parseHex(u8, s[28..30]), parseHex(u8, s[30..32]),
            parseHex(u8, s[32..34]), parseHex(u8, s[34..36]),
        },
    };
}

pub fn guidEql(a: *const GUID, b: *const GUID) bool {
    return std.mem.eql(u8, std.mem.asBytes(a), std.mem.asBytes(b));
}

pub const IID_IUnknown = guid("00000000-0000-0000-C000-000000000046");
pub const IID_ICoreWebView2_3 = guid("A0D6DF20-3B92-416D-AA0C-437A9C727857");
pub const IID_EnvironmentCompletedHandler = guid("4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d");
pub const IID_ControllerCompletedHandler = guid("6c4819f3-c9b7-4260-8127-c9f5bde7f68c");
pub const IID_WebMessageReceivedHandler = guid("57213f19-00e6-49fa-8e07-898ea01ecbd2");
pub const IID_NavigationStartingHandler = guid("9adbe429-f36d-432b-9ddc-f8881fbd76e3");
pub const IID_NewWindowRequestedHandler = guid("d4c185fe-c81c-4989-97af-2d3fa7ab5651");

// ---- IUnknown (for casting + QueryInterface/Release on any interface) ------

pub const IUnknown = extern struct {
    lpVtbl: *const Vtbl,
    pub const Vtbl = extern struct {
        QueryInterface: *const fn (*IUnknown, *const GUID, *?*anyopaque) callconv(WINAPI) HRESULT,
        AddRef: *const fn (*IUnknown) callconv(WINAPI) u32,
        Release: *const fn (*IUnknown) callconv(WINAPI) u32,
    };
    pub fn queryInterface(self: *IUnknown, iid: *const GUID, out: *?*anyopaque) HRESULT {
        return self.lpVtbl.QueryInterface(self, iid, out);
    }
    pub fn addRef(self: *IUnknown) u32 {
        return self.lpVtbl.AddRef(self);
    }
    pub fn release(self: *IUnknown) u32 {
        return self.lpVtbl.Release(self);
    }
};

/// Reinterpret any COM interface pointer as `*IUnknown` (slots 1-3 are always
/// QueryInterface/AddRef/Release), to QI or Release it generically.
pub fn asUnknown(ptr: *anyopaque) *IUnknown {
    return @ptrCast(@alignCast(ptr));
}

// ---- ICoreWebView2Environment  (5 own methods, slots 4-8) -----------------

pub const ICoreWebView2Environment = extern struct {
    lpVtbl: *const Vtbl,
    pub const Vtbl = extern struct {
        QueryInterface: Slot,
        AddRef: Slot,
        Release: Slot,
        // 4: CreateCoreWebView2Controller(parentWindow, handler)
        CreateCoreWebView2Controller: *const fn (*ICoreWebView2Environment, ?w.HWND, *anyopaque) callconv(WINAPI) HRESULT,
        rest_5_8: [4]Slot,
    };
    pub fn createController(self: *ICoreWebView2Environment, parent: ?w.HWND, handler: *anyopaque) HRESULT {
        return self.lpVtbl.CreateCoreWebView2Controller(self, parent, handler);
    }
};

// ---- ICoreWebView2Controller  (23 own methods, slots 4-26) ----------------

pub const ICoreWebView2Controller = extern struct {
    lpVtbl: *const Vtbl,
    pub const Vtbl = extern struct {
        QueryInterface: Slot,
        AddRef: Slot,
        Release: *const fn (*ICoreWebView2Controller) callconv(WINAPI) u32,
        run_4_6: [3]Slot, // get_IsVisible, put_IsVisible, get_Bounds
        // 7: put_Bounds(RECT)  — RECT is a 16-byte aggregate; on Win64 it is
        // passed by hidden reference. Zig's callconv(.winapi) lowers by-value
        // aggregates per the MSVC ABI, so declaring it by value is correct;
        // flagged as an ABI-sensitive spot to confirm on the first Windows run.
        put_Bounds: *const fn (*ICoreWebView2Controller, win32.RECT) callconv(WINAPI) HRESULT,
        run_8_25: [18]Slot, // get_ZoomFactor .. Close
        // 26: get_CoreWebView2(out ICoreWebView2**)
        get_CoreWebView2: *const fn (*ICoreWebView2Controller, *?*anyopaque) callconv(WINAPI) HRESULT,
    };
    pub fn putBounds(self: *ICoreWebView2Controller, bounds: win32.RECT) HRESULT {
        return self.lpVtbl.put_Bounds(self, bounds);
    }
    pub fn getCoreWebView2(self: *ICoreWebView2Controller, out: *?*anyopaque) HRESULT {
        return self.lpVtbl.get_CoreWebView2(self, out);
    }
};

// ---- ICoreWebView2_3  (73 total slots; inherits _2 inherits ICoreWebView2) -

pub const ICoreWebView2_3 = extern struct {
    lpVtbl: *const Vtbl,
    pub const Vtbl = extern struct {
        QueryInterface: Slot,
        AddRef: Slot,
        Release: *const fn (*ICoreWebView2_3) callconv(WINAPI) u32,
        // 4: get_Settings(out ICoreWebView2Settings**) — owned ref (Release it).
        get_Settings: *const fn (*ICoreWebView2_3, *?*anyopaque) callconv(WINAPI) HRESULT,
        run_5: [1]Slot, // get_Source
        // 6: Navigate(uri)
        Navigate: *const fn (*ICoreWebView2_3, LPCWSTR) callconv(WINAPI) HRESULT,
        // 7: NavigateToString(htmlContent) — diagnostic, bypasses serving
        NavigateToString: *const fn (*ICoreWebView2_3, LPCWSTR) callconv(WINAPI) HRESULT,
        // 8: add_NavigationStarting(handler, out token) — the main-frame
        // navigation backstop (cancel off-origin nav, route it externally).
        add_NavigationStarting: *const fn (*ICoreWebView2_3, *anyopaque, *EventRegistrationToken) callconv(WINAPI) HRESULT,
        run_9_27: [19]Slot, // remove_NavigationStarting .. remove_ProcessFailed
        // 28: AddScriptToExecuteOnDocumentCreated(js, handler|null)
        AddScriptToExecuteOnDocumentCreated: *const fn (*ICoreWebView2_3, LPCWSTR, ?*anyopaque) callconv(WINAPI) HRESULT,
        run_29: [1]Slot, // RemoveScriptToExecuteOnDocumentCreated
        // 30: ExecuteScript(js, handler|null)
        ExecuteScript: *const fn (*ICoreWebView2_3, LPCWSTR, ?*anyopaque) callconv(WINAPI) HRESULT,
        run_31_34: [4]Slot, // CapturePreview, Reload, PostWebMessageAsJson, PostWebMessageAsString
        // 35: add_WebMessageReceived(handler, out token)
        add_WebMessageReceived: *const fn (*ICoreWebView2_3, *anyopaque, *EventRegistrationToken) callconv(WINAPI) HRESULT,
        run_36_44: [9]Slot, // remove_WebMessageReceived .. Stop
        // 45: add_NewWindowRequested(handler, out token) — window.open /
        // target=_blank backstop (suppress the popup, route the URI externally).
        add_NewWindowRequested: *const fn (*ICoreWebView2_3, *anyopaque, *EventRegistrationToken) callconv(WINAPI) HRESULT,
        run_46_51: [6]Slot, // remove_NewWindowRequested .. RemoveHostObjectFromScript
        // 52: OpenDevToolsWindow() — opens DevTools without needing webview focus
        OpenDevToolsWindow: *const fn (*ICoreWebView2_3) callconv(WINAPI) HRESULT,
        run_53_71: [19]Slot, // add_WebResourceRequested .. get_IsSuspended
        // 72: SetVirtualHostNameToFolderMapping(hostName, folderPath, accessKind)
        SetVirtualHostNameToFolderMapping: *const fn (*ICoreWebView2_3, LPCWSTR, LPCWSTR, HostResourceAccessKind) callconv(WINAPI) HRESULT,
        run_73: [1]Slot, // ClearVirtualHostNameToFolderMapping
    };

    pub fn navigate(self: *ICoreWebView2_3, uri: LPCWSTR) HRESULT {
        return self.lpVtbl.Navigate(self, uri);
    }
    pub fn navigateToString(self: *ICoreWebView2_3, html: LPCWSTR) HRESULT {
        return self.lpVtbl.NavigateToString(self, html);
    }
    pub fn addScriptOnDocumentCreated(self: *ICoreWebView2_3, js: LPCWSTR) HRESULT {
        return self.lpVtbl.AddScriptToExecuteOnDocumentCreated(self, js, null);
    }
    pub fn executeScript(self: *ICoreWebView2_3, js: LPCWSTR) HRESULT {
        return self.lpVtbl.ExecuteScript(self, js, null);
    }
    pub fn addWebMessageReceived(self: *ICoreWebView2_3, handler: *anyopaque, token: *EventRegistrationToken) HRESULT {
        return self.lpVtbl.add_WebMessageReceived(self, handler, token);
    }
    pub fn getSettings(self: *ICoreWebView2_3, out: *?*anyopaque) HRESULT {
        return self.lpVtbl.get_Settings(self, out);
    }
    pub fn addNavigationStarting(self: *ICoreWebView2_3, handler: *anyopaque, token: *EventRegistrationToken) HRESULT {
        return self.lpVtbl.add_NavigationStarting(self, handler, token);
    }
    pub fn addNewWindowRequested(self: *ICoreWebView2_3, handler: *anyopaque, token: *EventRegistrationToken) HRESULT {
        return self.lpVtbl.add_NewWindowRequested(self, handler, token);
    }
    pub fn setVirtualHostMapping(self: *ICoreWebView2_3, host: LPCWSTR, folder: LPCWSTR, kind: HostResourceAccessKind) HRESULT {
        return self.lpVtbl.SetVirtualHostNameToFolderMapping(self, host, folder, kind);
    }
    pub fn openDevTools(self: *ICoreWebView2_3) HRESULT {
        return self.lpVtbl.OpenDevToolsWindow(self);
    }
};

// ---- ICoreWebView2WebMessageReceivedEventArgs  (3 own methods, slots 4-6) --

pub const ICoreWebView2WebMessageReceivedEventArgs = extern struct {
    lpVtbl: *const Vtbl,
    pub const Vtbl = extern struct {
        QueryInterface: Slot,
        AddRef: Slot,
        Release: *const fn (*ICoreWebView2WebMessageReceivedEventArgs) callconv(WINAPI) u32,
        run_4_5: [2]Slot, // get_Source, get_WebMessageAsJson
        // 6: TryGetWebMessageAsString(out LPWSTR) — the renderer posts a JSON
        // envelope as a string, so this returns that JSON verbatim (callee
        // allocates; free with CoTaskMemFree).
        TryGetWebMessageAsString: *const fn (*ICoreWebView2WebMessageReceivedEventArgs, *?LPWSTR) callconv(WINAPI) HRESULT,
    };
    pub fn tryGetWebMessageAsString(self: *ICoreWebView2WebMessageReceivedEventArgs, out: *?LPWSTR) HRESULT {
        return self.lpVtbl.TryGetWebMessageAsString(self, out);
    }
    pub fn release(self: *ICoreWebView2WebMessageReceivedEventArgs) u32 {
        return self.lpVtbl.Release(self);
    }
};

// ---- ICoreWebView2Settings  (21 own methods, slots 4-24) ------------------
// Only put_AreDevToolsEnabled (slot 13) is called — to disable DevTools/F12 in
// release builds (B5), mirroring the macOS host's #if DEBUG inspector gate.

pub const ICoreWebView2Settings = extern struct {
    lpVtbl: *const Vtbl,
    pub const Vtbl = extern struct {
        QueryInterface: Slot,
        AddRef: Slot,
        Release: *const fn (*ICoreWebView2Settings) callconv(WINAPI) u32,
        run_4_12: [9]Slot, // get/put IsScriptEnabled .. get_AreDevToolsEnabled
        // 13: put_AreDevToolsEnabled(BOOL)
        put_AreDevToolsEnabled: *const fn (*ICoreWebView2Settings, win32.BOOL) callconv(WINAPI) HRESULT,
        run_14_21: [8]Slot, // get/put AreDefaultContextMenusEnabled .. IsBuiltInErrorPageEnabled
    };
    pub fn putAreDevToolsEnabled(self: *ICoreWebView2Settings, enabled: win32.BOOL) HRESULT {
        return self.lpVtbl.put_AreDevToolsEnabled(self, enabled);
    }
};

// ---- ICoreWebView2NavigationStartingEventArgs  (7 own methods, slots 4-10) -

pub const ICoreWebView2NavigationStartingEventArgs = extern struct {
    lpVtbl: *const Vtbl,
    pub const Vtbl = extern struct {
        QueryInterface: Slot,
        AddRef: Slot,
        Release: Slot,
        // 4: get_Uri(out LPWSTR) — the navigation target (callee-allocated;
        // free with CoTaskMemFree).
        get_Uri: *const fn (*ICoreWebView2NavigationStartingEventArgs, *?LPWSTR) callconv(WINAPI) HRESULT,
        run_5_8: [4]Slot, // get_IsUserInitiated, get_IsRedirected, get_RequestHeaders, get_Cancel
        // 9: put_Cancel(BOOL) — cancel an off-origin main-frame navigation.
        put_Cancel: *const fn (*ICoreWebView2NavigationStartingEventArgs, win32.BOOL) callconv(WINAPI) HRESULT,
        run_10: [1]Slot, // get_NavigationId
    };
    pub fn getUri(self: *ICoreWebView2NavigationStartingEventArgs, out: *?LPWSTR) HRESULT {
        return self.lpVtbl.get_Uri(self, out);
    }
    pub fn putCancel(self: *ICoreWebView2NavigationStartingEventArgs, cancel: win32.BOOL) HRESULT {
        return self.lpVtbl.put_Cancel(self, cancel);
    }
};

// ---- ICoreWebView2NewWindowRequestedEventArgs  (8 own methods, slots 4-11) -

pub const ICoreWebView2NewWindowRequestedEventArgs = extern struct {
    lpVtbl: *const Vtbl,
    pub const Vtbl = extern struct {
        QueryInterface: Slot,
        AddRef: Slot,
        Release: Slot,
        // 4: get_Uri(out LPWSTR) — the requested popup target (CoTaskMemFree).
        get_Uri: *const fn (*ICoreWebView2NewWindowRequestedEventArgs, *?LPWSTR) callconv(WINAPI) HRESULT,
        run_5_6: [2]Slot, // put_NewWindow, get_NewWindow
        // 7: put_Handled(BOOL) — true = we handled it, so no popup webview opens.
        put_Handled: *const fn (*ICoreWebView2NewWindowRequestedEventArgs, win32.BOOL) callconv(WINAPI) HRESULT,
        run_8_11: [4]Slot, // get_Handled, get_IsUserInitiated, GetDeferral, get_WindowFeatures
    };
    pub fn getUri(self: *ICoreWebView2NewWindowRequestedEventArgs, out: *?LPWSTR) HRESULT {
        return self.lpVtbl.get_Uri(self, out);
    }
    pub fn putHandled(self: *ICoreWebView2NewWindowRequestedEventArgs, handled: win32.BOOL) HRESULT {
        return self.lpVtbl.put_Handled(self, handled);
    }
};

// ---- The exported loader entry point (resolved dynamically) ----------------

pub const CreateEnvironmentFn = *const fn (
    browserExecutableFolder: ?LPCWSTR,
    userDataFolder: ?LPCWSTR,
    environmentOptions: ?*anyopaque,
    environmentCreatedHandler: *anyopaque,
) callconv(WINAPI) HRESULT;

/// Dynamically load `WebView2Loader.dll` (shipped next to the exe) and resolve
/// `CreateCoreWebView2EnvironmentWithOptions`. Dynamic loading (vs linking the
/// import lib) is what keeps the cross-compile free of MSVC artifacts.
pub fn loadCreateEnvironment() ?CreateEnvironmentFn {
    const name = std.unicode.utf8ToUtf16LeStringLiteral("WebView2Loader.dll");
    const dll = win32.LoadLibraryW(name) orelse return null;
    const proc = win32.GetProcAddress(dll, "CreateCoreWebView2EnvironmentWithOptions") orelse return null;
    return @ptrCast(@alignCast(proc));
}
