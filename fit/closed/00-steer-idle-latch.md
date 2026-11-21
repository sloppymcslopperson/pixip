---
grilled: true
commit: "15ed5fc"
---

A steer that reaches Pi while it is idle is only queued and never starts a turn, and `Hub.touch()` marked the session busy anyway, so no `agent_settled` ever cleared it; from then on every composer message was sent as a steer and sat forever. The clear button also failed with `unknown frame "clear_queue"` because the running daemon predated that server frame (`--dev` reloads client assets only).

### Symptom

- Messages sent to the agent during/after a batch run never reached it; the queue chips showed them pending and `/api/sessions` reported the session `busy` long after its last record, so the idle-detach never fired.
- The chips' `×` answered `{"t":"error","message":"unknown frame \"clear_queue\""}` and did not clear.

### Root cause

- `src/hub.ts` `steer()` called `touch()`, which set `info.state = "busy"` and cancelled the idle timer. RPC `steer` only queues, so when Pi was idle no `agent_start`/`agent_settled` followed: a permanent busy latch. The client picks `steer` vs `prompt` from that same flag, so the latch fed itself.
- The `:8137` daemon started at 17:37:02; the `clear_queue` server case landed at 18:15:37 (`95b1f6d`). `--dev` serves client files from disk but never reloads hub/server code, so the new button hit an old server.

### Fix

- `Hub.steer()` is now `prompt` + `streamingBehavior: "steer"`. Pi ignores the behavior when idle (a normal turn starts) and steers when busy; it also keeps extension commands working. The client still sends `t:"steer"`, so the wire protocol is unchanged.
- `Hub.touch()` only updates `lastActivity` and clears the idle timer; run state comes from `agent_start`/`agent_settled` alone. `prompt()` reschedules the idle timer when no run started.
- `ARCHITECTURE.md` and `docs/parity.md` now say the `steer` frame maps to `prompt` + steer and why RPC `steer` is avoided.
- `test/fixtures/fake-pi.mjs` models `prompt` + `streamingBehavior` as a queued message, and `test/builtin.test.ts` asserts an idle `hub.steer` sends one `prompt` with `streamingBehavior: "steer"` and leaves the session `idle`.
- The clear button needs only the daemon restart; no code change.

### Verification

- `npm run check` green (157 tests).
- Fresh daemon + real `pi`: idle steer produced `agent_start`, a `user:Now reply…`/`assistant:SECOND` turn, final state `idle`, and `clear_queue` answered `{"t":"queue","steering":[],"followUp":[]}`.
- Restart `:8137` with `./dev.sh` after copying any queued chips (they live in the old child's memory).
