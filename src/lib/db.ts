import type { Project } from '../types';
import type { AuditRecord } from './seamTypes';

const DB_NAME = 'wallpaper-symmetry-editor';
const DB_VERSION = 2;
const STORE = 'projects';
const AUDIT_STORE = 'seam-audits';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      // New in v2: persistent seam audit records. Pre-existing (v1) users get the
      // empty store, so migrated projects never inherit a fabricated "passed".
      if (!db.objectStoreNames.contains(AUDIT_STORE)) {
        const store = db.createObjectStore(AUDIT_STORE, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 操作失败'));
  });
}

export async function saveProject(project: Project): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    await requestToPromise(tx.objectStore(STORE).put({ ...project, updatedAt: Date.now() }));
  } finally {
    db.close();
  }
}

export async function loadProject(id: string): Promise<Project | undefined> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    return await requestToPromise(tx.objectStore(STORE).get(id));
  } finally {
    db.close();
  }
}

export async function listProjects(): Promise<Project[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const projects = await requestToPromise(tx.objectStore(STORE).getAll());
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    db.close();
  }
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([STORE, AUDIT_STORE], 'readwrite');
    await requestToPromise(tx.objectStore(STORE).delete(id));
    // Remove any audit belonging to the deleted project.
    const index = tx.objectStore(AUDIT_STORE).index('projectId');
    const audits = await requestToPromise(index.getAllKeys(id));
    for (const key of audits) {
      tx.objectStore(AUDIT_STORE).delete(key);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('删除失败'));
    });
  } finally {
    db.close();
  }
}

export async function saveAuditRecord(record: AuditRecord): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(AUDIT_STORE, 'readwrite');
    await requestToPromise(tx.objectStore(AUDIT_STORE).put(record));
  } finally {
    db.close();
  }
}

export async function loadAuditRecord(projectId: string): Promise<AuditRecord | undefined> {
  const db = await openDb();
  try {
    const tx = db.transaction(AUDIT_STORE, 'readonly');
    return await requestToPromise(tx.objectStore(AUDIT_STORE).get(auditKey(projectId)));
  } finally {
    db.close();
  }
}

export async function deleteAuditRecord(projectId: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(AUDIT_STORE, 'readwrite');
    await requestToPromise(tx.objectStore(AUDIT_STORE).delete(auditKey(projectId)));
  } finally {
    db.close();
  }
}

export function auditKey(projectId: string): string {
  return `audit:${projectId}`;
}
