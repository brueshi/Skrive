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

/// WM_NCCALCSIZE payload (wParam == TRUE): `rgrc[0]` is in/out the proposed
/// client rect. We reclaim the caption band from its top and leave the resize
/// frame on all edges, so the OS still drives resizing.
pub const NCCALCSIZE_PARAMS = extern struct {
    rgrc: [3]RECT,
    lppos: ?*anyopaque,
};

/// WM_GETMINMAXINFO payload — `ptMinTrackSize` enforces the minimum window
/// size (parity with the macOS host's 720x480 minSize).
pub const MINMAXINFO = extern struct {
    ptReserved: POINT,
    ptMaxSize: POINT,
    ptMaxPosition: POINT,
    ptMinTrackSize: POINT,
    ptMaxTrackSize: POINT,
};

/// WINDOWPLACEMENT — used by window-state persistence (B4): captures the
/// normal (restored) rect plus the show state, so a maximized window restores
/// to the right un-maximized bounds.
pub const WINDOWPLACEMENT = extern struct {
    length: u32,
    flags: u32,
    showCmd: u32,
    ptMinPosition: POINT,
    ptMaxPosition: POINT,
    rcNormalPosition: RECT,
};
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
pub const WM_CLOSE: u32 = 0x0010;
pub const WM_GETMINMAXINFO: u32 = 0x0024;
pub const WM_NCCALCSIZE: u32 = 0x0083;
pub const WM_APP: u32 = 0x8000;

// WM_SIZE wParam values (which size change occurred).
pub const SIZE_RESTORED: usize = 0;
pub const SIZE_MAXIMIZED: usize = 2;

// ShowWindow commands used by the window-control bridge commands.
pub const SW_MINIMIZE: i32 = 6;
pub const SW_MAXIMIZE: i32 = 3;
pub const SW_RESTORE: i32 = 9;

// GetSystemMetrics index: caption (title bar) height — the band the frameless
// WM_NCCALCSIZE handler reclaims into the client area.
pub const SM_CYCAPTION: i32 = 4;

// Minimum window size (parity with the macOS host).
pub const MIN_WIDTH: i32 = 720;
pub const MIN_HEIGHT: i32 = 480;

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
pub extern "user32" fn LoadIconW(hInstance: ?HINSTANCE, lpIconName: LPCWSTR) callconv(WINAPI) ?w.HICON;
pub extern "user32" fn MessageBoxW(hWnd: ?HWND, lpText: LPCWSTR, lpCaption: LPCWSTR, uType: u32) callconv(WINAPI) i32;
pub const MB_OK: u32 = 0x0;
pub const MB_ICONERROR: u32 = 0x10;

/// MAKEINTRESOURCEW: a numeric resource id passed where an LPCWSTR name is
/// expected (the low word is the id, the rest must be zero). Used to load the
/// embedded icon (IDI_SKRIVE) from the exe's own module.
pub fn makeIntResourceW(id: u16) LPCWSTR {
    return @ptrFromInt(id);
}
/// IDI_SKRIVE — the icon resource id, matching skrive.rc.
pub const IDI_SKRIVE: u16 = 1;
pub extern "user32" fn GetClientRect(hWnd: HWND, lpRect: *RECT) callconv(WINAPI) BOOL;
pub extern "user32" fn SetWindowLongPtrW(hWnd: HWND, nIndex: i32, dwNewLong: LPARAM) callconv(WINAPI) LPARAM;
pub extern "user32" fn GetWindowLongPtrW(hWnd: HWND, nIndex: i32) callconv(WINAPI) LPARAM;
pub extern "user32" fn GetSystemMetrics(nIndex: i32) callconv(WINAPI) i32;
pub extern "user32" fn IsZoomed(hWnd: HWND) callconv(WINAPI) BOOL;
// Frame recompute after the window style/extent assumptions change at startup
// (forces a fresh WM_NCCALCSIZE so the frameless client rect takes effect).
pub extern "user32" fn SetWindowPos(hWnd: HWND, hWndInsertAfter: ?HWND, X: i32, Y: i32, cx: i32, cy: i32, uFlags: u32) callconv(WINAPI) BOOL;
pub const SWP_NOMOVE: u32 = 0x0002;
pub const SWP_NOSIZE: u32 = 0x0001;
pub const SWP_NOZORDER: u32 = 0x0004;
pub const SWP_FRAMECHANGED: u32 = 0x0020;
// Window placement (B4 persistence): normal rect + show state in one struct.
pub extern "user32" fn GetWindowPlacement(hWnd: HWND, lpwndpl: *WINDOWPLACEMENT) callconv(WINAPI) BOOL;
pub extern "user32" fn SetWindowPlacement(hWnd: HWND, lpwndpl: *const WINDOWPLACEMENT) callconv(WINAPI) BOOL;

// Theme-matched window background brush (the frameless resize frame shows this
// color). gdi32 CreateSolidBrush takes a COLORREF (0x00BBGGRR).
pub extern "gdi32" fn CreateSolidBrush(color: u32) callconv(WINAPI) ?w.HBRUSH;

// Windows dark/light mode (HKCU ...\Themes\Personalize\AppsUseLightTheme).
pub extern "advapi32" fn RegGetValueW(
    hkey: ?*anyopaque,
    lpSubKey: LPCWSTR,
    lpValue: LPCWSTR,
    dwFlags: u32,
    pdwType: ?*u32,
    pvData: ?*anyopaque,
    pcbData: ?*u32,
) callconv(WINAPI) i32;
pub const HKEY_CURRENT_USER: *anyopaque = @ptrFromInt(0x80000001);
pub const RRF_RT_REG_DWORD: u32 = 0x00000010;

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
