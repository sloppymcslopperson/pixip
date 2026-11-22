session auto-titling not descriptive enough. Please change the prompt (or something) to make the title more descriptive. Look at /fit work and /fit start templates to see example of boilerplate, and try to make the titling model reach for the substance of the initial prompt.

### Done

- `titlePrompt` now tells the title model to ignore slash-command process boilerplate (board paths, review/commit steps, tool names) and label the concrete feature, bug, file or decision, preferring a `title:` field, `### Goal` or summary.
- Ticket ids and revisions are kept as useful context when they help identify the task, rather than treated as noise.
- The local fallback prefers an explicit `title:` field and skips an empty `title: (empty)` placeholder, so a failed model call no longer names a `/fit work` session after the wrapper.
- Updated `ARCHITECTURE.md` and `README.md`; added fallback and prompt-shape tests.

### Verification

- `env -u PIXIP_INSIDE -u PIXIP_SESSION_ID npm run check` is green (244 main tests plus the host workspace).
