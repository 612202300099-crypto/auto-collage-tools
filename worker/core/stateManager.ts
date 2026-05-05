/**
 * stateManager.ts — Central state management for the Worker.
 *
 * Tracks:
 * - Worker status (running/stopped/scanning/idle)
 * - Active & completed jobs
 * - In-memory locks to prevent duplicate processing
 * - Statistics for dashboard
 *
 * This is the single source of truth for the worker's state.
 */
import type { WorkerState, WorkerStatus, ProcessingJob, JobStatus } from '../types.ts';

const MAX_HISTORY = 100;

// ─── In-Memory Lock Set ──────────────────────────────────────────────────────
const activeLocks = new Set<string>();

export function acquireLock(resi: string): boolean {
  if (activeLocks.has(resi)) return false;
  activeLocks.add(resi);
  return true;
}

export function releaseLock(resi: string): void {
  activeLocks.delete(resi);
}

export function isLocked(resi: string): boolean {
  return activeLocks.has(resi);
}

// ─── Worker State ────────────────────────────────────────────────────────────

const state: WorkerState = {
  status: 'stopped',
  startedAt: null,
  lastScanAt: null,
  nextScanAt: null,
  pollIntervalMinutes: 5,
  maxConcurrency: 5,
  totalProcessed: 0,
  totalErrors: 0,
  totalSkipped: 0,
  activeJobs: [],
  history: [],
};

export function getState(): Readonly<WorkerState> {
  return { ...state, activeJobs: [...state.activeJobs], history: [...state.history] };
}

export function setStatus(status: WorkerStatus): void {
  state.status = status;
}

export function setStarted(pollInterval: number, maxConcurrency: number): void {
  state.status = 'running';
  state.startedAt = Date.now();
  state.pollIntervalMinutes = pollInterval;
  state.maxConcurrency = maxConcurrency;
}

export function setStopped(): void {
  state.status = 'stopped';
  state.startedAt = null;
  state.nextScanAt = null;
}

export function setLastScan(): void {
  state.lastScanAt = Date.now();
}

export function setNextScan(timestamp: number): void {
  state.nextScanAt = timestamp;
}

// ─── Job Management ──────────────────────────────────────────────────────────

export function createJob(
  resi: string,
  variant: number,
  dateFolderName: string,
  dateFolderId: string,
  orderFolderId: string,
  qty: number = 1
): ProcessingJob {
  const job: ProcessingJob = {
    id: `${resi}-${Date.now()}`,
    resi,
    variant,
    dateFolderName,
    dateFolderId,
    orderFolderId,
    status: 'queued',
    message: 'Queued for processing',
    startedAt: Date.now(),
    qty,
    progress: 0,
  };
  state.activeJobs.push(job);
  return job;
}

export function updateJob(jobId: string, updates: Partial<Pick<ProcessingJob, 'status' | 'message' | 'progress' | 'dateFolderName' | 'dateFolderId'>>): void {
  const job = state.activeJobs.find(j => j.id === jobId);
  if (job) {
    Object.assign(job, updates);
  }
}

export function completeJob(jobId: string, finalStatus: 'done' | 'skipped' | 'error', message: string): void {
  const idx = state.activeJobs.findIndex(j => j.id === jobId);
  if (idx === -1) return;

  const job = state.activeJobs[idx];
  job.status = finalStatus;
  job.message = message;
  job.completedAt = Date.now();
  job.progress = 100;

  // Move to history
  state.activeJobs.splice(idx, 1);
  state.history.unshift(job);

  // Trim history
  if (state.history.length > MAX_HISTORY) {
    state.history.length = MAX_HISTORY;
  }

  // Update counters
  if (finalStatus === 'done') state.totalProcessed++;
  else if (finalStatus === 'error') state.totalErrors++;
  else if (finalStatus === 'skipped') state.totalSkipped++;
}

/**
 * Reset all stats (for clean restart).
 */
export function resetStats(): void {
  state.totalProcessed = 0;
  state.totalErrors = 0;
  state.totalSkipped = 0;
  state.activeJobs = [];
  state.history = [];
  activeLocks.clear();
}
