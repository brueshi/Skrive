//------------------------------------------------------------------------------
//  Test aggregator. Rooted at src/ so the modules' relative imports (ui/ ->
//  ../gfx/) resolve inside one module path. `zig build test` runs every test
//  in the files pulled in here.
//------------------------------------------------------------------------------
test {
    _ = @import("ui/context.zig");
    _ = @import("ui/layout.zig");
    _ = @import("ui/anim.zig");
    _ = @import("ui/widgets.zig");
}
