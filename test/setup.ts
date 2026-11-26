// Test preload. A pixip-managed Pi session exports PIXIP_INSIDE and
// PIXIP_SESSION_ID to its children, which makes the CLI spawned by tests treat
// its own stop/start as an inside-session restart. It also exports daemon
// pointers such as PIXIP_PI_HOST, which would make the daemon ignore the fake
// Pi fixture. Clear the inherited pixip environment once for the whole test
// process; tests that need one of these values pass it explicitly, and the
// spawn helpers apply that env after this scrub.
for (const key of [
	"PIXIP_INSIDE",
	"PIXIP_SESSION_ID",
	"PIXIP_PI_HOST",
	"PIXIP_PI",
	"PIXIP_DATA_DIR",
	"PIXIP_DAEMON_URL",
	"PIXIP_INBOX_TOKEN",
]) {
	delete process.env[key];
}
