import { runSeamAudit } from './seamAudit';
import { contentFingerprint } from './fingerprint';
import { renderSupercell, exportPeriodicTile } from './export';
import { seamAudit, startAudit, hydrateProject } from './seamStore';
import { editor, undo, setGroup, setProject, updateProject, selectObject } from './stores';
import { seamP1Sample, p6mSample, defaultProject, glideSample, rotationSample } from './samples';
import { contentVersion } from './contentEvents';
import { saveProject, listProjects, loadAuditRecord } from './db';

// Dev-only hooks for automated acceptance checks (tree-shaken from production).
export function installDebugHooks() {
  const api = {
    runSeamAudit,
    contentFingerprint,
    renderSupercell,
    exportPeriodicTile,
    seamAudit,
    startAudit,
    hydrateProject,
    editor,
    undo,
    setGroup,
    setProject,
    updateProject,
    selectObject,
    seamP1Sample,
    p6mSample,
    defaultProject,
    glideSample,
    rotationSample,
    contentVersion,
    saveProject,
    listProjects,
    loadAuditRecord
  };
  (globalThis as Record<string, unknown>).__seamDebug = api;
}
