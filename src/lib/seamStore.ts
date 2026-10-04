import { get, writable } from 'svelte/store';
import type { Project } from '../types';
import { contentFingerprint } from './fingerprint';
import { contentVersion } from './contentEvents';
import { runSeamAudit } from './seamAudit';
import type { AuditRecord, AuditStatus, SeamReport } from './seamTypes';
import { auditKey, loadAuditRecord, saveAuditRecord } from './db';
import { editor } from './stores';

export interface SeamAuditState {
  status: AuditStatus | 'idle';
  projectId: string;
  fingerprint: string;
  /** contentVersion captured for the current audit; late results must match it. */
  epoch: number;
  report: SeamReport | null;
  error: string | null;
  startedAt: number | null;
}

const initialProject = get(editor).project;
const auditStore = writable<SeamAuditState>({
  status: 'idle',
  projectId: initialProject.id,
  fingerprint: contentFingerprint(initialProject),
  epoch: get(contentVersion),
  report: null,
  error: null,
  startedAt: null
});

let runCounter = 0;
let activeRun: { runId: number; fingerprint: string; epoch: number } | null = null;

function currentSnapshot(project: Project) {
  return { fingerprint: contentFingerprint(project), epoch: get(contentVersion) };
}

/**
 * Any content mutation (including transient drag edits later undone, undo/redo,
 * group switches, cell resize) bumps contentVersion. A finished audit for old
 * content becomes 过期 and can never flip back to 通过; a running audit whose
 * contentVersion changes discards its late result. Identical content restored by
 * undo still has a *new* epoch, so a pre-edit async result can never pass it.
 */
contentVersion.subscribe(() => {
  const state = get(auditStore);
  if (state.status === 'idle' || state.status === 'stale') return;
  auditStore.update((current) => ({
    ...current,
    epoch: get(contentVersion),
    status: 'stale',
    report: current.status === 'running' ? null : current.report,
    error: '工程内容已变更，旧审计结果过期，请重新审计'
  }));
  // Persist the stale marker immediately, so a reload after editing mid-run can
  // never restore the old record as a pass.
  if (state.status === 'running') {
    void saveAuditRecord({
      id: auditKey(state.projectId),
      projectId: state.projectId,
      fingerprint: state.fingerprint,
      epoch: get(contentVersion),
      status: 'stale',
      startedAt: state.startedAt ?? Date.now(),
      finishedAt: Date.now(),
      report: null,
      error: '审计期间工程内容变更'
    }).catch(() => {});
  }
});

// Switching projects must never show the previous project's verdict, not even for
// the few ms before IndexedDB hydration resolves: reset to idle synchronously;
// hydrateProject() then restores the stored verdict for this project id if any.
let lastProjectId = get(editor).project.id;
editor.subscribe((state) => {
  if (state.project.id === lastProjectId) return;
  lastProjectId = state.project.id;
  activeRun = null;
  auditStore.set({
    status: 'idle',
    projectId: state.project.id,
    fingerprint: contentFingerprint(state.project),
    epoch: get(contentVersion),
    report: null,
    error: null,
    startedAt: null
  });
});

/** Load the stored audit for a project; anything fingerprint-stale shows as 过期. */
export async function hydrateProject(project: Project) {
  const { fingerprint, epoch } = currentSnapshot(project);
  let record: AuditRecord | undefined;
  try {
    record = await loadAuditRecord(project.id);
  } catch {
    record = undefined;
  }
  const state = get(auditStore);
  // Hydration arriving after the user switched projects again is irrelevant; never
  // clobber an audit actively running in the current session either.
  if (state.projectId !== project.id || state.status === 'running') return;
  if (!record) {
    auditStore.set({
      status: 'idle',
      projectId: project.id,
      fingerprint,
      epoch,
      report: null,
      error: null,
      startedAt: null
    });
    return;
  }
  // A run that never reached a terminal state (tab closed mid-audit) cannot pass.
  const contentMatches = record.fingerprint === fingerprint;
  const status: AuditStatus =
    !contentMatches || record.status === 'running' || record.status === 'stale'
      ? 'stale'
      : record.status;
  auditStore.set({
    status,
    projectId: project.id,
    fingerprint,
    epoch,
    report: contentMatches ? record.report : null,
    error: contentMatches ? record.error : '存储的审计对应不同内容，已标记为过期',
    startedAt: record.startedAt
  });
}

export async function startAudit() {
  const project = get(editor).project;
  const { fingerprint, epoch } = currentSnapshot(project);
  const runId = ++runCounter;
  activeRun = { runId, fingerprint, epoch };
  const startedAt = Date.now();
  auditStore.set({
    status: 'running',
    projectId: project.id,
    fingerprint,
    epoch,
    report: null,
    error: null,
    startedAt
  });
  // Persist the running marker so a reload mid-audit shows 过期, never 通过.
  await persist({
    id: auditKey(project.id),
    projectId: project.id,
    fingerprint,
    epoch,
    status: 'running',
    startedAt,
    finishedAt: null,
    report: null,
    error: null
  });

  const token = { runId, projectId: project.id, fingerprint, epoch };
  const snapshot: Project = structuredClone(project);
  try {
    // Let the UI paint the 运行中 state before synchronous rasterization starts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const report = await runSeamAudit(snapshot, {
      token,
      isCancelled: () => {
        if (activeRun?.runId !== runId) return true;
        const current = get(auditStore);
        return current.epoch !== epoch || current.fingerprint !== fingerprint;
      },
      yieldToUi: () => new Promise((resolve) => setTimeout(resolve, 0))
    });

    if (activeRun?.runId !== runId) return; // superseded by a newer run
    const after = get(auditStore);
    if (after.epoch !== epoch || after.fingerprint !== fingerprint) {
      // Late result: content changed (edit/undo/group switch/autosave-driven edit)
      // while the audit was running. It can never mark the new content as passed.
      markStale('审计返回时工程已变更，结果已作废');
      return;
    }
    auditStore.set({
      status: report.status,
      projectId: project.id,
      fingerprint,
      epoch,
      report,
      error: null,
      startedAt: report.startedAt
    });
    await persist({
      id: auditKey(project.id),
      projectId: project.id,
      fingerprint,
      epoch,
      status: report.status,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      report,
      error: null
    });
  } catch (error) {
    if (activeRun?.runId !== runId) return;
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'cancelled') {
      markStale('审计期间工程发生变更，结果已作废');
      return;
    }
    const current = get(auditStore);
    auditStore.set({ ...current, status: 'error', error: message });
    await persist({
      id: auditKey(project.id),
      projectId: project.id,
      fingerprint,
      epoch,
      status: 'error',
      startedAt: current.startedAt ?? startedAt,
      finishedAt: Date.now(),
      report: null,
      error: message
    });
  } finally {
    if (activeRun?.runId === runId) activeRun = null;
  }
}

function markStale(message: string | null) {
  auditStore.update((state) => ({
    ...state,
    status: 'stale',
    report: null,
    error: message
  }));
}

async function persist(record: AuditRecord) {
  try {
    await saveAuditRecord(record);
  } catch {
    // Persistence failure must not erase an in-session verdict.
  }
}

export const seamAudit = auditStore;
