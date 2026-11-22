// The one place the hub creates a Pi-speaking child. `pixip-pi-host` can provide
// another implementation without touching the Hub state machine or the wire path.
import { RpcChild, type RpcChildOptions } from "./rpc.ts";

export interface PiBackend {
	create(options: RpcChildOptions): RpcChild;
}

/** Default backend: the real `pi --mode rpc` child. */
export const piRpcBackend: PiBackend = {
	create(options) {
		return new RpcChild(options);
	},
};
