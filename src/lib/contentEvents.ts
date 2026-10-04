import { writable } from 'svelte/store';

/**
 * Monotonic content version, bumped on every project mutation (edit, undo/redo,
 * group switch, cell resize, object add/delete). Kept separate from seamStore so
 * the editor store can signal content changes without importing the audit store
 * (which imports the editor store, which would be an ES module cycle).
 */
export const contentVersion = writable(0);

export function notifyContentChanged() {
  contentVersion.update((value) => value + 1);
}
