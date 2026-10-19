/**
 * The composer's live preview: the unsaved profile resolved and compiled by the same Rust code the CLI runs.
 *
 * The engine runs in the browser on the shelf's snapshot plus the draft (`overrideProfile`), so the `apm.yml` shown is
 * byte for byte what `shelfkit compile --dry-run` writes for the same profile. When the engine cannot run here (no
 * WebAssembly, or the shelf's files cannot be read), `previewProfile` asks the Worker, which runs the same engine.
 */
import { conflictsOf } from "@shelfkit/engine";
import type { Conflict } from "@shelfkit/engine";
import type { CompilePlan, Profile, ResolvedProfile } from "@shelfkit/schema";
import { ref, shallowRef, watch } from "vue";
import type { Ref } from "vue";

import { execute, messageOf } from "../api/graphql.ts";
import { readPlan, readResolution } from "../api/json.ts";
import { PreviewProfileQuery } from "../api/operations.ts";
import { loadEngine, shelfFiles } from "../engine/browser.ts";
import type { SnapshotEntry } from "../engine/browser.ts";

export interface Preview {
  /** Where the preview ran. */
  readonly runner: "browser" | "server";
  readonly resolution: ResolvedProfile | null;
  readonly plan: CompilePlan | null;
  /** The plan exactly as `shelfkit compile --dry-run --json` prints it. */
  readonly planText: string | null;
  readonly conflicts: readonly Conflict[];
}

/** A preview kept current, with what went wrong last and whether a compile is running. */
export interface LivePreview {
  readonly preview: Ref<Preview | null>;
  readonly error: Ref<string | null>;
  readonly running: Ref<boolean>;
}

const DEBOUNCE_MS = 120;

async function inBrowser(
  shelf: string,
  entries: readonly SnapshotEntry[],
  document: Profile
): Promise<Preview> {
  const [engine, files] = await Promise.all([
    loadEngine(),
    shelfFiles(shelf, entries),
  ]);
  const options = { overrideProfile: document, profile: document.id };
  const resolved = engine.resolve(files, options);
  const planned = engine.planCompile(files, options);
  const resolution = resolved.ok ? resolved.value : null;
  return {
    conflicts: conflictsOf(
      resolution,
      planned.ok
        ? { errors: [], plan: planned.plan }
        : { errors: planned.errors, plan: null }
    ),
    plan: planned.ok ? planned.plan : null,
    planText: planned.ok ? planned.text : null,
    resolution,
    runner: "browser",
  };
}

async function onServer(shelf: string, document: Profile): Promise<Preview> {
  const data = await execute(PreviewProfileQuery, { document, shelf });
  const preview = data.shelf?.previewProfile;
  if (preview === undefined) {
    throw new Error("the shelf cannot be read");
  }
  const plan = readPlan(preview.plan?.json ?? null);
  return {
    conflicts: preview.conflicts,
    plan,
    planText: null,
    resolution: readResolution(preview.resolution?.json ?? null),
    runner: "server",
  };
}

/** Keep a preview of `document` current as it changes. */
export function usePreview(
  shelf: Ref<string>,
  entries: Ref<readonly SnapshotEntry[] | null>,
  document: Ref<Profile | null>
): LivePreview {
  const preview = shallowRef<Preview | null>(null);
  const problem = ref<string | null>(null);
  const running = ref(false);
  const browserFailed = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = 0;

  async function run(): Promise<void> {
    const current = document.value;
    const files = entries.value;
    if (current === null || files === null) {
      return;
    }
    latest += 1;
    const ticket = latest;
    running.value = true;
    try {
      let next: Preview;
      if (browserFailed.value) {
        next = await onServer(shelf.value, current);
      } else {
        try {
          next = await inBrowser(shelf.value, files, current);
        } catch (engineError) {
          browserFailed.value = true;
          problem.value = `The in-browser engine could not run (${messageOf(engineError)}); previewing on the server.`;
          next = await onServer(shelf.value, current);
        }
      }
      if (ticket === latest) {
        preview.value = next;
        if (!browserFailed.value) {
          problem.value = null;
        }
      }
    } catch (error) {
      if (ticket === latest) {
        problem.value = messageOf(error);
      }
    } finally {
      if (ticket === latest) {
        running.value = false;
      }
    }
  }

  watch(
    [document, entries],
    () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // `run` settles every failure into `problem`, so nothing is left to await.
        void run();
      }, DEBOUNCE_MS);
    },
    { deep: true, immediate: true }
  );

  return { error: problem, preview, running };
}
