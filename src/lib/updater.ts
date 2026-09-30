import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

/** An update the worker can act on — version plus the release notes. */
export interface AvailableUpdate {
  version: string;
  notes: string | null;
  install(onProgress: (pct: number | null) => void): Promise<void>;
}

/** Turn a raw updater failure into something a worker can act on.
 * The plugin's own messages ("http error", JSON parse errors on an empty
 * latest.json, signature mismatches) mean nothing at the counter. */
export function friendlyUpdateError(e: unknown): string {
  const raw = String(e instanceof Error ? e.message : e).replace(/^Error: /, "");
  if (/404|not found/i.test(raw))
    return "No published release found yet — updates appear after the next release is published.";
  if (/empty|unexpected end|parse|invalid type/i.test(raw))
    return "The update server answered with garbage (usually right after publishing — wait a minute and retry).";
  if (/signature/i.test(raw))
    return "The download's signature didn't match — don't retry blindly, tell the manager.";
  if (/invalid updater binary format/i.test(raw))
    return "The update downloaded but doesn't match how this copy was installed (rpm/deb vs AppImage) — grab the matching installer from the releases page and install it once; later updates then flow on their own.";
  if (/network|offline|dns|timed? ?out|failed to fetch|connection/i.test(raw))
    return "Couldn't reach the update server — check the internet connection and retry.";
  return raw || "Update check failed for an unknown reason.";
}

/** Check for a newer release. Resolves null when up to date; throws a
 * human-readable message on failure (see friendlyUpdateError). Never call
 * from the dev server — there is no bundle to update there. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const update: Update | null = await check().catch((e: unknown) => {
    throw new Error(friendlyUpdateError(e));
  });
  if (!update) return null;
  const notes =
    typeof update.rawJson?.notes === "string" && update.rawJson.notes.trim()
      ? update.rawJson.notes.trim()
      : null;
  return {
    version: update.version,
    notes,
    install: async (onProgress) => {
      let total: number | null = null;
      let done = 0;
      const onEvent = (ev: DownloadEvent) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? null;
          done = 0;
          onProgress(total ? 0 : null);
        } else if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          onProgress(total ? Math.min(99, Math.round((done / total) * 100)) : null);
        }
      };
      try {
        await update.downloadAndInstall(onEvent);
      } catch (e: unknown) {
        throw new Error(friendlyUpdateError(e));
      }
      onProgress(100);
    },
  };
}
