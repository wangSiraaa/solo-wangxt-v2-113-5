import { writable } from 'svelte/store';
import type { Project } from '../../types';
import { contentFingerprint } from './fingerprint';
import { runSeamAudit } from './auditor';
import { createCanvasSampler } from './canvasSampler';
import { SeamAuditController, type StoredSnapshot } from './controller';
import {
  auditKey,
  getAudit,
  putAudit,
  AUDIT_SCHEMA_STORAGE_VERSION
} from './persistence';
import type { AuditState, SamplerFactory, SeamAuditReport } from './types';

export type { AuditState };

/**
 * Per-project seam audit state for the UI. Content guarding lives in
 * SeamAuditController; this map adds Svelte reactivity and IndexedDB persistence.
 * Old projects (missing records, older schema, abandoned "running" row) hydrate as
 * stale and can never display a forged pass.
 */
const controllers = new Map<string, SeamAuditController>();

export const auditStore = writable<Record<string, AuditState>>({});

function controllerFor(project: Project): SeamAuditController {
  let controller = controllers.get(project.id);
  if (!controller) {
    controller = new SeamAuditController(project);
    controllers.set(project.id, controller);
    controller.subscribe((state) => {
      auditStore.update((all) => ({ ...all, [project.id]: state }));
    });
  }
  return controller;
}

export function currentFingerprint(project: Project): string {
  return contentFingerprint(project);
}

/** Track a freshly loaded project and adopt a stored verdict only if it still fits. */
export async function hydrateAudit(project: Project): Promise<void> {
  const controller = controllerFor(project);
  let snapshot: StoredSnapshot | null = null;
  try {
    const stored = await getAudit(project.id, contentFingerprint(project));
    if (stored) {
      snapshot = {
        status: stored.status,
        startedAt: stored.startedAt,
        report: stored.report,
        schemaVersion: stored.schemaVersion
      };
    }
  } catch {
    snapshot = null;
  }
  // The project may have changed again while IndexedDB was resolving.
  if (contentFingerprint(project) !== controller.fingerprint) {
    controller.contentChanged(project);
    snapshot = null;
  }
  controller.hydrate(snapshot, AUDIT_SCHEMA_STORAGE_VERSION);
}

/** Edit, undo/redo, group switch, autosave-driven content change. */
export function notifyProjectChanged(project: Project): void {
  const controller = controllerFor(project);
  controller.contentChanged(project);
}

export interface StartOptions {
  samplerFactory?: SamplerFactory;
}

export function startAudit(project: Project, options: StartOptions = {}): void {
  const controller = controllerFor(project);
  const makeTileSampler = options.samplerFactory ?? createCanvasSampler;
  const fingerprint = contentFingerprint(project);
  // Persist an explicit "running" row; a refresh while running hydrates as stale.
  persist({
    key: auditKey(project.id, fingerprint),
    projectId: project.id,
    fingerprint,
    schemaVersion: AUDIT_SCHEMA_STORAGE_VERSION,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    report: null
  });

  void controller
    .start(project, (current, controls) =>
      runSeamAudit(current, {
        ...controls,
        // Seam edges are measured in the actual exported supercell pixels; the software
        // infinite sampler (used internally for contributors) still resolves hot zones.
        samplerFactory: makeTileSampler,
        tileSamplerFactory: makeTileSampler
      })
    )
    .then((report) => {
      // Only a verdict the controller actually accepted (matching epoch + fingerprint)
      // reaches storage; a superseded late result resolves to null and is never written,
      // so it cannot be revived as "passed" after edit→undo or refresh.
      if (report) persistReport(project.id, report);
    });
}

function persist(entry: Parameters<typeof putAudit>[0]) {
  void putAudit(entry).catch(() => undefined);
}

function persistReport(projectId: string, report: SeamAuditReport) {
  persist({
    key: auditKey(projectId, report.fingerprint),
    projectId,
    fingerprint: report.fingerprint,
    schemaVersion: AUDIT_SCHEMA_STORAGE_VERSION,
    status: report.status,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    report
  });
}
