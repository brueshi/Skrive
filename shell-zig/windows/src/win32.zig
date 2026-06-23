//! The Win32 surface the host hand-declares (Turf idiom). Kept in one place so
//! `main.zig` and `app.zig` share it. `std.os.windows` supplies the base handle
//! types; 0.16 dropped WINAPI/WPARAM/LRESULT and made BOOL a wrapper, so those
//! are re-declared as the ABI-identical primitives.

const std = @import("std");
pub const w = std.os.windows;

pub const WINAPI: std.builtin.CallingConvention = std.builtin.CallingConvention.winapi;

pub const WPARAM = usize;
pub const LPARAM = isize;
pub const LRESULT = isize;
pub const BOOL = i32;
pub const HWND = w.HWND;
pub const HINSTANCE = w.HINSTANCE;
pub const HMODULE = w.HMODULE;
pub const LPCWSTR = w.LPCWSTR;
pub const LPWSTR = [*:0]u16;

pub const RECT = extern struct { left: i32, top: i32, right: i32, bottom: i32 };
pub const POINT = extern struct { x: i32, y: i32 };
pub const MSG = extern struct {
    hwnd: ?HWND,
    message: u32,
    wParam: WPARAM,
    lParam: LPARAM,
    time: u32,
    pt: POINT,
    lPrivate: u32,
};

pub const WNDPROC = *const fn (HWND, u32, WPARAM, LPARAM) callconv(WINAPI) LRESULT;
pub const WNDCLASSEXW = extern struct {
    cbSize: u32,
    style: u32,
    lpfnWndProc: WNDPROC,
    cbClsExtra: i32,
    cbWndExtra: i32,
    hInstance: HINSTANCE,
    hIcon: ?w.HICON,
    hCursor: ?w.HCURSOR,
    hbrBackground: ?w.HBRUSH,
    lpszMenuName: ?LPCWSTR,
    lpszClassName: LPCWSTR,
    hIconSm: ?w.HICON,
};

// Window-class / style constants.
pub const CS_VREDRAW: u32 = 0x0001;
pub const CS_HREDRAW: u32 = 0x0002;
pub const WS_OVERLAPPEDWINDOW: u32 = 0x00CF0000;
pub const SW_SHOWDEFAULT: i32 = 10;
pub const CW_USEDEFAULT: i32 = @bitCast(@as(u32, 0x80000000));
pub const IDC_ARROW: LPCWSTR = @ptrFromInt(32512); // MAKEINTRESOURCEW(32512)
pub const COLOR_WINDOW_BRUSH: w.HBRUSH = @ptrFromInt(6); // COLOR_WINDOW (5) + 1

// Messages.
pub const WM_DESTROY: u32 = 0x0002;
pub const WM_SIZE: u32 = 0x0005;
pub const WM_APP: u32 = 0x8000;

// SetWindowLongPtr / GetWindowLongPtr index for our App back-pointer.
pub const GWLP_USERDATA: i32 = -21;

pub extern "kernel32" fn GetModuleHandleW(lpModuleName: ?LPCWSTR) callconv(WINAPI) ?HMODULE;
pub extern "kernel32" fn GetModuleFileNameW(hModule: ?HMODULE, lpFilename: [*]u16, nSize: u32) callconv(WINAPI) u32;
pub extern "kernel32" fn LoadLibraryW(lpLibFileName: LPCWSTR) callconv(WINAPI) ?HMODULE;
pub extern "kernel32" fn GetProcAddress(hModule: HMODULE, lpProcName: [*:0]const u8) callconv(WINAPI) ?*anyopaque;

pub extern "user32" fn RegisterClassExW(unnamedParam1: *const WNDCLASSEXW) callconv(WINAPI) w.ATOM;
pub extern "user32" fn CreateWindowExW(
    dwExStyle: u32,
    lpClassName: LPCWSTR,
    lpWindowName: LPCWSTR,
    dwStyle: u32,
    X: i32,
    Y: i32,
    nWidth: i32,
    nHeight: i32,
    hWndParent: ?HWND,
    hMenu: ?w.HMENU,
    hInstance: HINSTANCE,
    lpParam: ?w.LPVOID,
) callconv(WINAPI) ?HWND;
pub extern "user32" fn DefWindowProcW(HWND, u32, WPARAM, LPARAM) callconv(WINAPI) LRESULT;
pub extern "user32" fn ShowWindow(hWnd: HWND, nCmdShow: i32) callconv(WINAPI) BOOL;
pub extern "user32" fn UpdateWindow(hWnd: HWND) callconv(WINAPI) BOOL;
pub extern "user32" fn GetMessageW(lpMsg: *MSG, hWnd: ?HWND, wMsgFilterMin: u32, wMsgFilterMax: u32) callconv(WINAPI) BOOL;
pub extern "user32" fn TranslateMessage(lpMsg: *const MSG) callconv(WINAPI) BOOL;
pub extern "user32" fn DispatchMessageW(lpMsg: *const MSG) callconv(WINAPI) LRESULT;
pub extern "user32" fn PostQuitMessage(nExitCode: i32) callconv(WINAPI) void;
pub extern "user32" fn PostMessageW(hWnd: ?HWND, Msg: u32, wParam: WPARAM, lParam: LPARAM) callconv(WINAPI) BOOL;
pub extern "user32" fn LoadCursorW(hInstance: ?HINSTANCE, lpCursorName: LPCWSTR) callconv(WINAPI) ?w.HCURSOR;
pub extern "user32" fn GetClientRect(hWnd: HWND, lpRect: *RECT) callconv(WINAPI) BOOL;
pub extern "user32" fn SetWindowLongPtrW(hWnd: HWND, nIndex: i32, dwNewLong: LPARAM) callconv(WINAPI) LPARAM;
pub extern "user32" fn GetWindowLongPtrW(hWnd: HWND, nIndex: i32) callconv(WINAPI) LPARAM;

pub extern "ole32" fn CoTaskMemFree(pv: ?*anyopaque) callconv(WINAPI) void;
pub extern "ole32" fn CoInitializeEx(pvReserved: ?*anyopaque, dwCoInit: u32) callconv(WINAPI) i32;
pub const COINIT_APARTMENTTHREADED: u32 = 0x2;

// CoCreateInstance for the shell dialog/file-operation COM objects.
pub extern "ole32" fn CoCreateInstance(
    rclsid: *const anyopaque,
    pUnkOuter: ?*anyopaque,
    dwClsContext: u32,
    riid: *const anyopaque,
    ppv: *?*anyopaque,
) callconv(WINAPI) i32;
pub const CLSCTX_INPROC_SERVER: u32 = 0x1;

// Shell open (external links, reveal folder). Returns >32 on success.
pub extern "shell32" fn ShellExecuteW(
    hwnd: ?HWND,
    lpOperation: ?LPCWSTR,
    lpFile: LPCWSTR,
    lpParameters: ?LPCWSTR,
    lpDirectory: ?LPCWSTR,
    nShowCmd: i32,
) callconv(WINAPI) ?HINSTANCE;
pub const SW_SHOWNORMAL: i32 = 1;

// Recycle-bin delete via the classic single-call API (no COM vtable to
// hand-roll, unlike IFileOperation). pFrom is a double-NUL-terminated list.
pub const SHFILEOPSTRUCTW = extern struct {
    hwnd: ?HWND,
    wFunc: u32,
    pFrom: ?[*:0]const u16,
    pTo: ?[*:0]const u16,
    fFlags: u16,
    fAnyOperationsAborted: BOOL,
    hNameMappings: ?*anyopaque,
    lpszProgressTitle: ?LPCWSTR,
};
pub extern "shell32" fn SHFileOperationW(lpFileOp: *SHFILEOPSTRUCTW) callconv(WINAPI) i32;
pub const FO_DELETE: u32 = 0x0003;
pub const FOF_SILENT: u16 = 0x0004;
pub const FOF_NOCONFIRMATION: u16 = 0x0010;
pub const FOF_ALLOWUNDO: u16 = 0x0040;
pub const FOF_NOERRORUI: u16 = 0x0400;

// Single-instance guard.
pub extern "kernel32" fn CreateMutexW(lpMutexAttributes: ?*anyopaque, bInitialOwner: BOOL, lpName: LPCWSTR) callconv(WINAPI) ?*anyopaque;
pub extern "kernel32" fn GetLastError() callconv(WINAPI) u32;
pub const ERROR_ALREADY_EXISTS: u32 = 183;

// Environment + directory for the %APPDATA%/Skrive data dir.
pub extern "kernel32" fn GetEnvironmentVariableW(lpName: LPCWSTR, lpBuffer: [*]u16, nSize: u32) callconv(WINAPI) u32;
pub extern "kernel32" fn CreateDirectoryW(lpPathName: LPCWSTR, lpSecurityAttributes: ?*anyopaque) callconv(WINAPI) BOOL;

// Clipboard.
pub extern "user32" fn OpenClipboard(hWndNewOwner: ?HWND) callconv(WINAPI) BOOL;
pub extern "user32" fn CloseClipboard() callconv(WINAPI) BOOL;
pub extern "user32" fn EmptyClipboard() callconv(WINAPI) BOOL;
pub extern "user32" fn SetClipboardData(uFormat: u32, hMem: ?*anyopaque) callconv(WINAPI) ?*anyopaque;
pub extern "user32" fn GetClipboardData(uFormat: u32) callconv(WINAPI) ?*anyopaque;
pub extern "user32" fn RegisterClipboardFormatW(lpszFormat: LPCWSTR) callconv(WINAPI) u32;
pub const CF_UNICODETEXT: u32 = 13;

// Global memory for clipboard payloads.
pub extern "kernel32" fn GlobalAlloc(uFlags: u32, dwBytes: usize) callconv(WINAPI) ?*anyopaque;
pub extern "kernel32" fn GlobalLock(hMem: *anyopaque) callconv(WINAPI) ?[*]u8;
pub extern "kernel32" fn GlobalUnlock(hMem: *anyopaque) callconv(WINAPI) BOOL;
pub extern "kernel32" fn GlobalSize(hMem: *anyopaque) callconv(WINAPI) usize;
pub const GMEM_MOVEABLE: u32 = 0x2;
