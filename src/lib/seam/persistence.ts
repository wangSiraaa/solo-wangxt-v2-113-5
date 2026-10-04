import type { SeamAuditReport } from './types';

/**
 * Audit history lives in its own IndexedDB database so an old project migration (or an
 * older app version with a different audit interpretation) can never surface a forged
 * "passed": loading a report from an unknown schema invalidates it.
 */
const DB_NAME = 'wallpaper-seam-audit';
const DB_VERSION = 1;
const STORE = 'audits';
export const AUDIT_SCHEMA_STORAGE_VERSION = 1;

export interface StoredAudit {
  /** key: `${projectId}:${fingerprint}` */
  key: string;
  projectId: string;
  fingerprint: string;
  schemaVersion: number;
  status: 'running' | 'passed' | 'failed' | 'error';
  startedAt: number;
  finishedAt: number | null;
  report: SeamAuditReport | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('projectId', 'projectId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开审计数据库'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('审计存储操作失败'));
  });
}

export function auditKey(projectId: string, fingerprint: string): string {
  return `${projectId}:${fingerprint}`;
}

export async function putAudit(entry: StoredAudit): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    await requestToPromise(tx.objectStore(STORE).put(entry));
  } finally {
    db.close();
  }
}

export async function getAudit(projectId: string, fingerprint: string): Promise<StoredAudit | undefined> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    return await requestToPromise(tx.objectStore(STORE).get(auditKey(projectId, fingerprint)));
  } finally {
    db.close();
  }
}

export async function listAuditsFor(projectId: string): Promise<StoredAudit[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    return await requestToPromise(tx.objectStore(STORE).index('projectId').getAll(projectId));
  } finally {
    db.close();
  }
}

export async function deleteAuditsFor(projectId: string): Promise<void> {
  const db = await openDb();
  try {
    const entries = await listAuditsFor(projectId);
    const tx = db.transaction(STORE, 'readwrite');
    await Promise.all(entries.map((entry) => requestToPromise(tx.objectStore(STORE).delete(entry.key))));
  } finally {
    db.close();
  }
}
