// Typed surface for the client reftag grammar. The implementation (and the one
// regex) lives in `src/client/reftags.js` so the browser can import it without a
// build step; this module only adds the types used by the hub, CLI and tests.
export { REF_TAG_SOURCE, formatRefTag, messageKey, parseRefTag, refForEntry, scanRefTags } from "./client/reftags.js";

export interface InboxRef {
	kind: "inbox";
	id: string;
}

export interface HistoryEntryRef {
	kind: "history";
	session: string;
	entry: string;
}

export interface HistoryMessageRef {
	kind: "history";
	session: string;
	message: { role: string; timestamp: number };
}

export type RefTag = InboxRef | HistoryEntryRef | HistoryMessageRef;

export interface RefTagMatch {
	ref: RefTag;
	tag: string;
	start: number;
	end: number;
}
