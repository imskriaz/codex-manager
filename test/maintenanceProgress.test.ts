import { describe, expect, it } from 'vitest';
import { isMaintenanceJob, mergeMaintenanceJob, type MaintenanceJob } from '../src/domain/maintenance';

const job: MaintenanceJob = { id: 'cleanup', tool: 'archives', operation: 'delete', status: 'running', total: 2, processed: 1, cleared: 1, skipped: 0, failed: 0, errors: [], revision: 2, previewToken: 'preview' };
describe('maintenance progress boundaries', () => {
  it('accepts bounded progress from current and older hosts', () => {
    expect(isMaintenanceJob(job)).toBe(true);
    expect(isMaintenanceJob({ ...job, revision: undefined, previewToken: undefined })).toBe(true);
    for (const patch of [{ id: '' }, { tool: 'unknown' }, { total: 10001 }, { processed: 3 }, { cleared: 2 }, { revision: -1 }, { status: 'completed' }, { errors: Array(21).fill('error') }, { errors: ['x'.repeat(301)] }, { previewToken: {} }, { cancelRequested: 'true' }, { extra: 'unbounded relay payload' }]) expect(isMaintenanceJob({ ...job, ...patch })).toBe(false);
  });
  it('does not roll back counters, cancellation, terminal outcomes, or revisions', () => {
    const cancelling = { ...job, cancelRequested: true };
    expect(mergeMaintenanceJob(cancelling, { ...job, revision: 3 }).cancelRequested).toBe(true);
    expect(mergeMaintenanceJob(job, { ...job, revision: 1 })).toBe(job);
    expect(mergeMaintenanceJob(job, { ...job, revision: undefined })).toBe(job);
    expect(mergeMaintenanceJob(job, { ...job, total: 3, revision: 3 })).toBe(job);
    expect(mergeMaintenanceJob(job, { ...job, cleared: 0, skipped: 1, revision: 3 })).toBe(job);
    expect(mergeMaintenanceJob(job, { ...job, processed: 0, cleared: 0, revision: 3 })).toBe(job);
    const complete: MaintenanceJob = { ...job, processed: 2, cleared: 2, status: 'completed', revision: 4 };
    expect(mergeMaintenanceJob(complete, { ...complete, status: 'running', revision: 5 })).toBe(complete);
    expect(mergeMaintenanceJob(complete, { ...complete, status: 'failed', revision: 5 })).toBe(complete);
    expect(mergeMaintenanceJob({ ...job, status: 'unknown' }, complete)).toEqual(complete);
    expect(mergeMaintenanceJob(job, { ...job, id: 'next' }).id).toBe('next');
  });
});
