// Page data is cached between changes, so opening the site or the alarm's once-a-minute check doesn't wake the
// database. Everything that writes (the periodic check, uploads, edits on the site) calls dataChanged(), which
// empties the cache at once; the next request reads the database again. As a backstop, nothing is kept longer than
// 15 minutes (the time between checks).
import { revalidateTag, unstable_cache } from "next/cache";

const TAG = "radar-data";
const MAX_AGE_S = 15 * 60;

/** `fn`'s result, from the cache when nothing changed since it was stored. `key` must name everything `fn` reads from the request. */
export function cached<T>(key: Array<string | number>, fn: () => Promise<T>): Promise<T> {
  // Outside the Next.js server (tests, scripts) there's no cache: just run it
  if (!process.env.NEXT_RUNTIME) return fn();
  return unstable_cache(fn, ["v1", ...key.map(String)], { tags: [TAG], revalidate: MAX_AGE_S })();
}

/** Call after anything is written, so the next page load reads it. */
export function dataChanged() {
  if (!process.env.NEXT_RUNTIME) return;
  try {
    revalidateTag(TAG);
  } catch (e) {
    console.error("cache reset failed", e);
  }
}
