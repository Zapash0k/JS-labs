// Asset pipeline (Lab 03, M1). Callback APIs (Image.onload, decodeAudioData) are wrapped once
// here; everything else in the game just awaits promises.

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

export class JsonError extends Error {
  constructor(url, cause) {
    super(`invalid JSON from ${url}`, { cause });
    this.name = "JsonError";
    this.url = url;
  }
}

export class DecodeError extends Error {
  constructor(url, cause) {
    super(`cannot decode ${url}`, { cause });
    this.name = "DecodeError";
    this.url = url;
  }
}

/** A critical asset (or the manifest) could not be loaded; `item` says which one. */
export class LoadError extends Error {
  constructor(item, cause) {
    super(`${item.key}: ${cause?.message ?? cause}`, { cause });
    this.name = "LoadError";
    this.item = item;
  }
}

// fetch() only rejects when no response arrived at all (network, abort). A 404 is a *fulfilled*
// promise, so every caller goes through this helper, which turns `!ok` into an HttpError.
export async function fetchOk(url, { signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new HttpError(res.status, url);
  return res;
}

export async function fetchJson(url, { signal } = {}) {
  const res = await fetchOk(url, { signal });
  try {
    return await res.json();
  } catch (err) {
    if (err instanceof SyntaxError) throw new JsonError(url, err);
    throw err; // abort / network drop while reading the body
  }
}

// The one place where we build a promise by hand: wrapping the onload/onerror callbacks.
function decodeImage(objectUrl, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const img = new Image();
    const cleanup = () => {
      img.onload = img.onerror = null;
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      img.src = "";
      reject(signal.reason);
    };
    img.onload = () => {
      cleanup();
      resolve(img);
    };
    img.onerror = () => {
      cleanup();
      reject(new DecodeError(objectUrl, null));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    img.src = objectUrl;
  });
}

// Fetch first (so a 404 is an HttpError, not an anonymous "image error", and abort works),
// then let the browser decode the blob.
export async function loadImage(url, { signal } = {}) {
  const res = await fetchOk(url, { signal });
  const objectUrl = URL.createObjectURL(await res.blob());
  try {
    return await decodeImage(objectUrl, { signal });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function loadAudio(ctx, url, { signal } = {}) {
  if (!ctx) throw new Error("Web Audio is not available");
  const res = await fetchOk(url, { signal });
  const data = await res.arrayBuffer();
  signal?.throwIfAborted();
  try {
    return await ctx.decodeAudioData(data); // works on a suspended context: decode while loading
  } catch (cause) {
    throw new DecodeError(url, cause);
  }
}

export async function postJson(url, body, { signal } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

export const loadJson = fetchJson;

// ---------- retry ----------

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Transient failures only: the network dropped, an attempt timed out, the server answered 5xx.
// 4xx (our request is wrong), bad JSON, undecodable data and user aborts never get better by asking again.
export function isRetryable(err) {
  if (err instanceof HttpError) return err.status >= 500;
  if (err instanceof TypeError) return true; // fetch: network error
  return err?.name === "TimeoutError"; // AbortSignal.timeout()
}

/**
 * Calls `fn` up to `attempts` times. Delay before attempt n+1 is "full jitter" exponential backoff:
 * random() * baseMs * 2^(n-1). `signal` cancels both the waiting and the whole retry loop.
 * `random` and `wait` are injectable so tests do not need real time.
 */
export async function withRetry(
  fn,
  { attempts = 3, baseMs = 250, signal, random = Math.random, wait = sleep } = {},
) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (err) {
      if (signal?.aborted || attempt >= attempts || !isRetryable(err)) throw err;
      await wait(random() * baseMs * 2 ** (attempt - 1), signal);
    }
  }
}

// ---------- manifest + loadAll ----------

export function loadManifest(url, { signal, urlFor = (u) => u, ...retry } = {}) {
  return withRetry(() => fetchJson(urlFor(url), { signal }), { signal, ...retry }).catch((err) => {
    if (signal?.aborted) throw err;
    throw new LoadError({ key: "manifest", url }, err);
  });
}

/**
 * Loads every asset of `manifest.assets` ({ key, type: image|audio|json, url, critical? }) at once.
 *  - Promise.all over all items; each item is wrapped so progress ticks as soon as *it* settles.
 *  - A non-critical item that fails is recorded in `failures` and resolves to nothing: a missing
 *    sound must not block the game. A critical failure rejects (LoadError) and cancels the siblings.
 *  - Every attempt gets its own AbortSignal.timeout; `signal` cancels everything.
 *  - `sequential: true` is the slow baseline for the README timing comparison.
 */
export async function loadAll(
  manifest,
  {
    onProgress = () => {},
    signal,
    audioCtx = null,
    timeoutMs = 8000,
    attempts = 3,
    baseMs = 250,
    sequential = false,
    urlFor = (u) => u,
    loaders = {},
  } = {},
) {
  const load = {
    image: loadImage,
    audio: (url, o) => loadAudio(audioCtx, url, o),
    json: loadJson,
    ...loaders,
  };
  const items = manifest.assets;
  const total = items.length;
  const batch = new AbortController(); // lets one critical failure stop the others
  const batchSignal = signal ? AbortSignal.any([signal, batch.signal]) : batch.signal;
  const failures = [];
  let done = 0;
  const t0 = performance.now();

  async function run(item) {
    try {
      const value = await withRetry(
        () =>
          load[item.type](urlFor(item.url), {
            signal: AbortSignal.any([batchSignal, AbortSignal.timeout(timeoutMs)]),
          }),
        { attempts, baseMs, signal: batchSignal },
      );
      return { item, value };
    } catch (error) {
      if (item.critical || batchSignal.aborted) {
        batch.abort(error);
        throw new LoadError(item, error);
      }
      failures.push({ key: item.key, url: item.url, error });
      return { item, value: null };
    } finally {
      onProgress(++done, total, item);
    }
  }

  let results;
  if (sequential) {
    results = [];
    for (const item of items) results.push(await run(item));
  } else {
    results = await Promise.all(items.map(run));
  }

  const out = {
    images: {},
    sounds: {},
    json: {},
    failures,
    ms: performance.now() - t0,
    sequential,
  };
  const bucket = { image: out.images, audio: out.sounds, json: out.json };
  for (const { item, value } of results) if (value) bucket[item.type][item.key] = value;
  return out;
}
