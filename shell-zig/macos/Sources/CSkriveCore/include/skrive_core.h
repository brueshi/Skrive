// Part I C ABI between the native host and the Zig core. The Zig side
// (shell-zig/core/src/skrive_core.zig) exports these symbols; this header
// is how the Swift host sees them. The two are coupled by the round-trip
// test, not the compiler, so keep the signatures in lockstep.
#ifndef SKRIVE_CORE_H
#define SKRIVE_CORE_H

#ifdef __cplusplus
extern "C" {
#endif

// Opaque core handle. Created once, destroyed at shutdown.
typedef struct SkriveCore SkriveCore;

// Core -> host. `message_json` is a response or event envelope, valid
// only for the duration of this call; the host copies what it keeps.
typedef void (*SkriveCoreEmit)(void *userdata, const char *message_json);

// config_json carries the app-data dir, project defaults, and the markup
// extension set (Stage 2). All strings are UTF-8, NUL-terminated.
SkriveCore *skrive_core_create(const char *config_json,
                               SkriveCoreEmit emit,
                               void *userdata);

// Host -> core. `request_json` is a full request envelope; the core
// replies asynchronously via the emit callback registered at create.
void skrive_core_handle(SkriveCore *core, const char *request_json);

void skrive_core_destroy(SkriveCore *core);

#ifdef __cplusplus
}
#endif

#endif // SKRIVE_CORE_H
