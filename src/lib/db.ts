import type { Project } from '../types';

const DB_NAME = 'wallpaper-symmetry-editor';
const DB_VERSION = 1;
const STORE = 'projects';

/**
 * Current document schema. Projects written by older builds (undefined/older version)
 * are migrated as never-audited: the seam audit UI never adopts a passing record for
 * them until the user reruns the audit against the migrated content.
 */
export const PROJECT_SCHEMA_VERSION = 1;

export function migrateProject(raw: Project): Project {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.objects)) return raw;
  if (raw.schemaVersion === PROJECT_SCHEMA_VERSION) return raw;
  return { ...raw, schemaVersion: PROJECT_SCHEMA_VERSION };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
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
    await requestToPromise(
      tx.objectStore(STORE).put({
        ...project,
        schemaVersion: PROJECT_SCHEMA_VERSION,
        updatedAt: Date.now()
      })
    );
  } finally {
    db.close();
  }
}

export async function loadProject(id: string): Promise<Project | undefined> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const project = await requestToPromise(tx.objectStore(STORE).get(id));
    return project ? migrateProject(project) : undefined;
  } finally {
    db.close();
  }
}

export async function listProjects(): Promise<Project[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const projects = await requestToPromise(tx.objectStore(STORE).getAll());
    return projects.map(migrateProject).sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    db.close();
  }
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    await requestToPromise(tx.objectStore(STORE).delete(id));
  } finally {
    db.close();
  }
}
