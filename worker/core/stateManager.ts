/**
 * stateManager.ts — Central state management for the Worker.
 *
 * Tracks:
 * - Worker status (running/stopped/scanning/idle)
 * - Active & completed jobs
 * - Statistics for dashboard
 *
 * This is the single source of truth for the worker's state.
 */
import type { WorkerState, WorkerStatus, ProcessingJob, JobStatus } from '../types.ts';

const MAX_HISTORY = 100;

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

export function setScanning(): void {
  state.status = 'scanning';
  state.lastScanAt = Date.now();
}

export function setIdle(nextScanAt: number): void {
  state.status = 'idle';
  state.nextScanAt = nextScanAt;
}

// ─── Job Management ──────────────────────────────────────────────────────────

/**
 * Add a new job to the active jobs list.
 */
export function addJob(job: ProcessingJob): ProcessingJob {
  state.activeJobs.push(job);
  return job;
}

/**
 * Update fields on an active job.
 */
export function updateJob(
  jobId: string,
  updates: Partial<Pick<ProcessingJob, 'status' | 'message' | 'progress' | 'qty'>>,
): void {
  const job = state.activeJobs.find(j => j.id === jobId);
  if (job) {
    Object.assign(job, updates);
  }
}

/**
 * Complete a job — move it from active to history and update counters.
 */
export function completeJob(jobId: string, finalStatus: 'done' | 'skipped' | 'error'): void {
  const idx = state.activeJobs.findIndex(j => j.id === jobId);
  if (idx === -1) return;

  const job = state.activeJobs[idx];
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
}
