---
grilled: false
leg: follow-up
project: pixip
---

The quick auto-namer fix now retries once when the first title call loses the provider race, but the title path still has hardening gaps: provider contention, genuinely slow calls, and empty/error replies are not fully classified. Follow up so a slow or contended provider still produces a useful label without hanging the daemon.

### Already landed in the quick fix

- Default title model is the live session model; `--title-model` / `PIXIP_TITLE_MODEL` still overrides it.
- A failed title call while the first turn is busy is held and retried once after `agent_settled`, before falling back to local words.
- The failure log now includes the one-shot child's stderr, truncated.
- Fake Pi can fail the first one-shot call once (`FAKE_PI_TITLE_FAIL_ONCE`) and emit delayed settle events for the regression test.

### Known evidence

- `tmp/trial/pixip.log` has repeated `auto title failed` entries for the `opencode-go/deepseek-v4.1-flash` one-shot call before this fix, with sessions named from the first prompt words instead.
- A manual concurrent pair of one-shot calls succeeded, so this needs a real busy-session reproduction rather than assuming provider-wide serialization.

### Candidate work

- Add a bounded backoff or wait-until-idle queue instead of one retry at settle.
- Distinguish timeout, provider error and empty reply; only fall back to local words after a real failure.
- Keep a title attempt from surviving a manual rename or a session stop/rekey.
- Add a regression test with the fake Pi fixture that simulates a genuinely slow or hanging first title call.

### Acceptance

- A slow/contended title provider does not silently degrade to first words on the first try.
- Failures are diagnosable from `pixip.log`.
- The agent turn is never blocked or hung by the title call.
- A manual rename always wins, including while a retry is pending.

### Also fixed after the initial quick pass

- `runTitlePi` now closes the one-shot child's stdin. `execFile` had left the pipe open, so Pi waited for EOF and timed out on every title call; this was the main reason labels fell back to first words.
- Fake Pi has `FAKE_PI_TITLE_REQUIRE_STDIN_END=1` to keep that regression covered.
