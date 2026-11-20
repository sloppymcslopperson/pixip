Replacing AoE needs worktree creation and teardown per session, which pixip does not do at all yet.

### Notes

- Decide whether the hub shells out to `git worktree` or reuses AoE's helpers.
- Needs a story for branch naming, cleanup on stop, and refusing two sessions on one worktree.
