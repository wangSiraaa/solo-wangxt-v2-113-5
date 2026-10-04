import { contentFingerprint } from './fingerprint';
import type { Project } from '../../types';
import type { AuditState, SeamAuditReport } from './types';

export interface StoredSnapshot {
  status: 'running' | 'passed' | 'failed' | 'error';
  startedAt: number;
  report: SeamAuditReport | null;
  schemaVersion: number;
}

export interface ControllerRunner {
  (
    project: Project,
    options: { isCancelled: () => boolean }
  ): Promise<SeamAuditReport>;
}

function freshState(fingerprint: string): AuditState {
  return { status: 'stale', report: null, fingerprint, startedAt: null };
}

/**
 * Framework-independent audit lifecycle guard for one project. The epoch token is bumped
 * on every content change call (including edit→undo that returns to the same bytes, and
 * every hydration/refresh), so an async audit that started before the newest change can
 * never write a passing verdict onto different content: its completion is discarded and
 * the content remains marked stale until explicitly re-audited.
 */
export class SeamAuditController {
  readonly projectId: string;
  fingerprint: string;
  epoch = 0;
  state: AuditState;
  private listeners = new Set<(state: AuditState) => void>();

  constructor(project: Project) {
    this.projectId = project.id;
    this.fingerprint = contentFingerprint(project);
    this.state = freshState(this.fingerprint);
  }

  subscribe(listener: (state: AuditState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private publish(patch: Partial<AuditState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.state));
  }

  /** Refresh/reload: new epoch; a matching stored terminal report may be adopted. */
  hydrate(stored: StoredSnapshot | null, currentSchema: number): void {
    this.epoch += 1;
    if (
      stored &&
      stored.schemaVersion === currentSchema &&
      stored.report &&
      stored.status !== 'running' &&
      stored.report.fingerprint === this.fingerprint &&
      stored.report.projectId === this.projectId
    ) {
      this.publish({
        status: stored.status,
        report: stored.report,
        startedAt: stored.startedAt,
        fingerprint: this.fingerprint,
        message: undefined
      });
    } else {
      this.publish({
        ...freshState(this.fingerprint),
        message: stored ? '旧版本或未完成的审计记录已作废，请重新运行' : undefined
      });
    }
  }

  /**
   * Content change (edit, undo, redo, group switch, autosave mutating content).
   * Old audits are invalidated regardless of whether bytes returned to a prior value:
   * the epoch token only moves forward.
   */
  contentChanged(project: Project): void {
    this.epoch += 1;
    this.fingerprint = contentFingerprint(project);
    this.publish({
      status: 'stale',
      report: null,
      fingerprint: this.fingerprint,
      startedAt: null,
      message: '内容已变化，旧审计结果过期，请重新运行接缝审计'
    });
  }

  /** Force the current verdict stale without a content change (e.g. explicit invalidate). */
  markStale(message?: string): void {
    this.epoch += 1;
    this.publish({ ...freshState(this.fingerprint), message });
  }

  /**
   * Begin an audit. Resolves to the accepted report, or null when the result was
   * superseded (late return discarded). The runner should only persist the report when
   * this resolves non-null; otherwise a stale late result must not reach storage.
   */
  start(
    project: Project,
    runner: ControllerRunner
  ): Promise<SeamAuditReport | null> {
    this.epoch += 1;
    this.fingerprint = contentFingerprint(project);
    const epoch = this.epoch;
    const fingerprint = this.fingerprint;
    const startedAt = Date.now();
    this.publish({ status: 'running', report: null, fingerprint, startedAt, message: undefined });

    return runner(project, {
      isCancelled: () => this.epoch !== epoch || this.fingerprint !== fingerprint
    }).then(
      (report) => {
        if (this.epoch !== epoch || this.fingerprint !== fingerprint) {
          // Late return for superseded content: discard entirely. The current content
          // keeps its 'stale' state and is never marked passed by this result, and the
          // report is not offered for persistence.
          return null;
        }
        this.publish({
          status: report.status,
          report,
          startedAt,
          fingerprint,
          message: undefined
        });
        return report;
      },
      (error: unknown) => {
        if (this.epoch !== epoch || this.fingerprint !== fingerprint) return null;
        this.publish({
          status: 'error',
          report: null,
          fingerprint,
          startedAt,
          message: error instanceof Error ? error.message : String(error)
        });
        return null;
      }
    );
  }
}
