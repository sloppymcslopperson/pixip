The web view needs the TUI footer line, not a custom summary bar.

### Format (from pi's own footer component)

- line 1: `~/cwd (branch) • session name`, dim;
- line 2 left: `↑in ↓out R<cacheRead> W<cacheWrite> $cost` then `percent%/window (auto)`, colored by threshold (>70 warning, >90 error);
- line 2 right: `model • thinkingLevel` (or `model • thinking off`), provider prefix only when it fits.

### Implementation

Hub sends raw numbers (`get_session_stats` + `get_state`, git branch via `git -C cwd branch --show-current`); the client formats using the same rules, so the hub stays thin. Formatting is unit tested in `test/footer.test.js`.
