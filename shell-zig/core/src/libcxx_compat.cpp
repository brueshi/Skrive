// libc++ ABI compatibility shim for the macOS host build.
//
// Zig 0.16 compiles the vendored watcher TU against its bundled (newest)
// libc++, whose string hashing calls the out-of-line std::__1::__hash_memory.
// The macOS host links the core's static archive against the SYSTEM libc++,
// and on macOS releases older than the dev machine that symbol is not exported
// — so the watcher fails to link with an undefined __hash_memory on an older CI
// runner while linking fine on a newer dev box. This supplies a definition so
// the link succeeds on any macOS.
//
// Compiled ONLY for the macOS host static lib (the `--sysroot` cross-build in
// build.zig). Native and Windows builds statically link Zig's own libc++, which
// already defines __hash_memory; a second definition there would be a duplicate
// symbol. Where the system libc++ DOES export __hash_memory (a newer macOS),
// that lives in the dynamic libc++ and coexists with this static definition
// under the two-level namespace — no conflict.
//
// Defining a name in namespace std is technically undefined behavior, but it is
// the established, contained workaround for this exact libc++ ABI gap. The
// result only feeds libc++'s internal hash containers, which need a
// deterministic hash, not a specific algorithm — FNV-1a is sufficient.
// __SIZE_TYPE__ is the compiler's size_t so no libc++ header (and thus no
// clashing declaration of __hash_memory) is pulled in.

namespace std {
inline namespace __1 {

__SIZE_TYPE__ __hash_memory(const void* ptr, __SIZE_TYPE__ size) noexcept {
  const unsigned char* bytes = static_cast<const unsigned char*>(ptr);
  __SIZE_TYPE__ hash = 1469598103934665603ULL;  // FNV-1a offset basis
  for (__SIZE_TYPE__ i = 0; i < size; ++i) {
    hash ^= bytes[i];
    hash *= 1099511628211ULL;  // FNV-1a prime
  }
  return hash;
}

}  // namespace __1
}  // namespace std
