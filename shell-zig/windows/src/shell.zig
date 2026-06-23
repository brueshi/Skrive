//! The one piece of Stage 5.2 that needs real COM: the modern folder picker
//! (IFileOpenDialog). Trash, open-external, reveal and clipboard all use flat
//! Win32 calls instead, to keep the hand-rolled COM surface minimal. Vtable
//! slot orders are from the well-known shobjidl interface chain
//! (IFileOpenDialog : IFileDialog : IModalWindow : IUnknown); only the called
//! methods are typed, the rest are audited `Slot` filler.

const std = @import("std");
const win32 = @import("win32.zig");
const wv = @import("webview2.zig");

const WINAPI = win32.WINAPI;
const HRESULT = wv.HRESULT;
const Slot = *const anyopaque;

pub const CLSID_FileOpenDialog = wv.guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7");
pub const IID_IFileOpenDialog = wv.guid("D57C7288-D4AD-4768-BE02-9D969532D960");
pub const IID_IShellItem = wv.guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");

const FOS_PICKFOLDERS: u32 = 0x20;
const SIGDN_FILESYSPATH: u32 = 0x80058000;

const IFileOpenDialog = extern struct {
    lpVtbl: *const Vtbl,
    pub const Vtbl = extern struct {
        QueryInterface: Slot,
        AddRef: Slot,
        Release: Slot,
        // IModalWindow
        Show: *const fn (*IFileOpenDialog, ?win32.HWND) callconv(WINAPI) HRESULT, // 4
        // IFileDialog
        run_5_9: [5]Slot, // SetFileTypes, SetFileTypeIndex, GetFileTypeIndex, Advise, Unadvise
        SetOptions: *const fn (*IFileOpenDialog, u32) callconv(WINAPI) HRESULT, // 10
        run_11_20: [10]Slot, // GetOptions .. SetFileNameLabel
        GetResult: *const fn (*IFileOpenDialog, *?*anyopaque) callconv(WINAPI) HRESULT, // 21
        run_22_29: [8]Slot, // AddPlace .. GetSelectedItems
    };
};

const IShellItem = extern struct {
    lpVtbl: *const Vtbl,
    pub const Vtbl = extern struct {
        QueryInterface: Slot,
        AddRef: Slot,
        Release: Slot,
        run_4_5: [2]Slot, // BindToHandler, GetParent
        GetDisplayName: *const fn (*IShellItem, u32, *?win32.LPWSTR) callconv(WINAPI) HRESULT, // 6
        run_7_8: [2]Slot, // GetAttributes, Compare
    };
};

/// Show the folder picker; return the chosen path (WTF-8, caller owns) or null
/// on cancel/error. Matches the contract's `openDialog(): Promise<string|null>`.
pub fn pickFolder(gpa: std.mem.Allocator, owner: ?win32.HWND) ?[]u8 {
    var dlg_ptr: ?*anyopaque = null;
    if (win32.CoCreateInstance(&CLSID_FileOpenDialog, null, win32.CLSCTX_INPROC_SERVER, &IID_IFileOpenDialog, &dlg_ptr) != wv.S_OK) return null;
    const dlg: *IFileOpenDialog = @ptrCast(@alignCast(dlg_ptr orelse return null));
    defer _ = wv.asUnknown(dlg).release();

    _ = dlg.lpVtbl.SetOptions(dlg, FOS_PICKFOLDERS);
    // Show returns a cancelled HRESULT (not S_OK) when the user dismisses it.
    if (dlg.lpVtbl.Show(dlg, owner) != wv.S_OK) return null;

    var item_ptr: ?*anyopaque = null;
    if (dlg.lpVtbl.GetResult(dlg, &item_ptr) != wv.S_OK) return null;
    const item: *IShellItem = @ptrCast(@alignCast(item_ptr orelse return null));
    defer _ = wv.asUnknown(item).release();

    var name_w: ?win32.LPWSTR = null;
    if (item.lpVtbl.GetDisplayName(item, SIGDN_FILESYSPATH, &name_w) != wv.S_OK) return null;
    const name = name_w orelse return null;
    defer win32.CoTaskMemFree(name);

    return std.unicode.utf16LeToUtf8Alloc(gpa, std.mem.span(name)) catch null;
}
