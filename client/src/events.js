// Small helpers around EventTarget (Lab 03, Theory 6).

/** Promise for ONE occurrence of an event. Rejects if `signal` aborts first (and unsubscribes). */
export function once(target, type, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onEvent = (e) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(e);
    };
    const onAbort = () => {
      target.removeEventListener(type, onEvent);
      reject(signal.reason);
    };
    target.addEventListener(type, onEvent, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const emit = (target, type, detail) =>
  target.dispatchEvent(new CustomEvent(type, { detail }));
