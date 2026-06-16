// Intentionally empty. CSkriveCore is a header-only module wrapping the
// Zig core's C ABI; the symbols live in libskrive_core.a, linked by the
// executable target. SwiftPM wants at least one source file in a C
// target, so this file exists to satisfy that and nothing more.
