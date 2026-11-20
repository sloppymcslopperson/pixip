The UI is unauthenticated and binding is loopback-by-default with an explicit override, which is deliberate but undocumented in the client.

### Notes

- Document the posture in the client (or a one-line banner when bound off-loopback).
- Revisit a shared-secret cookie only if binding outside a private network ever becomes a requirement.
