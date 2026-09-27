/**
 * Runtime polyfills for Node.js versions below the engines floor (e.g. Node
 * 18 on embedded/mobile runtimes like nodejs-mobile, which currently tops
 * out at Node 18.20). Every patch is feature-detected and a no-op on
 * runtimes that already provide the API.
 */

// AbortSignal.any() landed in Node 20.3.0. Implements the spec behavior the
// provider APIs rely on: the derived signal aborts with the first input's
// reason, and already-aborted inputs abort it synchronously.
if (typeof AbortSignal !== "undefined") {
	const abortSignalCtor = AbortSignal as unknown as {
		any?: (signals: AbortSignal[]) => AbortSignal;
	};
	if (typeof abortSignalCtor.any !== "function") {
		abortSignalCtor.any = (signals: AbortSignal[]): AbortSignal => {
			const controller = new AbortController();
			const onAbort = (event: Event) => {
				for (const signal of signals) {
					signal.removeEventListener("abort", onAbort);
				}
				controller.abort((event.target as AbortSignal).reason);
			};
			for (const signal of signals) {
				if (signal.aborted) {
					controller.abort(signal.reason);
					return controller.signal;
				}
				signal.addEventListener("abort", onAbort);
			}
			return controller.signal;
		};
	}
}
