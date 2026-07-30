#!/usr/bin/env python3
"""Judge the host self-test's JSON report.

Reads the SELFTEST payload on stdin, writes tab-separated `verdict\tlabel\tdetail`
lines on stdout. Lives apart from the shell script because the report is JSON and
grepping JSON in bash is how a gate starts lying.

Each rule states what a failure MEANS, not just that it happened: a smoke check
exists to tell a human what broke, and "assertion 4 failed" tells them nothing.
"""
import json
import sys


def main() -> int:
    raw = sys.stdin.read().strip()
    try:
        r = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"fail\tSELFTEST payload was not valid JSON\t{e}")
        return 0

    out: list[tuple[str, str, str]] = []

    def check(ok: bool, label: str, detail: str = "") -> None:
        out.append(("pass" if ok else "fail", label, detail))

    # The bridge is alive. Everything else is meaningless if this fails.
    check(r.get("hasSkrive") is True, "window.skrive is present",
          "the bridge user-script did not run — nothing below is trustworthy")
    check(bool(r.get("version")) and not r.get("versionError"),
          f"app.version round-trip ({r.get('version') or r.get('versionError')})",
          "renderer -> Swift -> Zig -> renderer is broken")

    # The renderer mounted. This is what catches the dep-optimization blank
    # screen: a module graph that fails to load never mounts React at all.
    root_children = r.get("rootChildren", 0)
    check(root_children > 0, f"renderer mounted ({root_children} root children)",
          "blank window — check the Vite log for a missing deps/chunk-*.js")

    errors = r.get("workerErrors", 0)
    check(errors == 0, f"no console errors during boot ({errors})",
          "the console relay counted uncaught errors while starting")

    # Real files through the real core.
    if "snapshotError" in r:
        check(False, "project.snapshot", str(r["snapshotError"]))
    else:
        files = r.get("snapshotFiles", 0)
        check(files > 0, f"project.snapshot read {files} real files off disk",
              "the fs/project namespaces did not reach the Zig core")

    # The spelling oracle. This is the assertion that catches the Swift-6
    # executor-isolation SIGTRAPs: both crashes fired the instant the
    # NSSpellChecker completion ran, so the namespace merely EXISTING proves
    # nothing — the round trip has to come back.
    if r.get("spellError"):
        check(False, "spell round-trip", str(r["spellError"]))
    elif not r.get("spellNamespace"):
        check(False, "spell namespace missing",
              "the host did not register spell:* — on macOS that is a regression")
    elif r.get("spellAvailable") is not True:
        # A host with no oracle is a legitimate state, not a failure. Windows
        # reports exactly this until it implements ISpellChecker.
        out.append(("info", "spell.available() is false — host has no oracle "
                            "(expected on Windows, a regression on macOS)", ""))
    else:
        check(r.get("spellRangeCoversTeh") is True,
              f"spell.check flagged the misspelling ({r.get('spellRangeCount')} range(s))",
              "the oracle answered but with the wrong offsets — find/replace "
              "would edit the wrong characters")
        suggests = r.get("spellSuggestCount", -1)
        check(suggests > 0, f"spell.suggest returned {suggests} candidates",
              "corrections would offer an empty menu")

    # Informational: the app boots to its welcome state, so zero is expected.
    out.append(("info", f"painted blocks: {r.get('blockCount', 'n/a')} "
                        "(0 is normal — nothing is open on a clean boot)", ""))

    for verdict, label, detail in out:
        print(f"{verdict}\t{label}\t{detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
