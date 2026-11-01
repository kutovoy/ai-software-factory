# Design

## Decisions

1. **bwrap is opt-in/auto.** `RUNNER_SANDBOX=bwrap` requires `bwrap`; Linux auto-selects it when present, macOS
   keeps `sandbox-exec`, and `none` is explicit. Missing binary reports `runner.sandbox_unavailable` instead of
   silently running unsandboxed.
2. **Minimal bwrap jail.** `--ro-bind / /`, `--dev /dev`, `--proc /proc`, `--tmpfs /tmp`, `--bind <workspace>
   <workspace>`, `--chdir <workspace>`; `--unshare-net` when the network policy is `denied`.
3. **Replay is a recorded run, not a harness simulation.** A replay reads `runs/<id>/events.jsonl` plus
   `patch.diff`, re-emits the event stream and applies the patch to a fresh workspace. Benchmarks can pin a
   recording for deterministic scoring without model calls.
4. **Hydration.** Time elements render a stable ISO string on the server and format on the client after mount (or
   suppress the mismatch on the element); no `toLocaleString()` during SSR.
