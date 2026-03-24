/**
 * Cron-based sync scheduler using node-cron.
 *
 * Manages per-project cron schedules that trigger syncs at specified intervals.
 * Schedules survive agent restart because they are derived from project config.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';

/** Minimum interval between scheduled sync triggers (5 minutes). */
const MIN_SCHEDULE_INTERVAL_MS = 5 * 60 * 1000;

/** Callback invoked when a scheduled sync should be triggered. */
export type OnScheduledSync = (projectId: string) => void;

export interface SchedulerOptions {
  readonly logger: Logger;
  readonly onScheduledSync: OnScheduledSync;
}

interface ScheduledJob {
  readonly projectId: string;
  readonly cronExpression: string;
  task: ScheduledTask;
  /** Timestamp of the last trigger that was actually dispatched. */
  lastTriggeredAt: number;
}

/**
 * Manages cron-based sync schedules for projects.
 */
export class Scheduler {
  private readonly logger: Logger;
  private readonly onScheduledSync: OnScheduledSync;
  private readonly jobs = new Map<string, ScheduledJob>();

  constructor(options: SchedulerOptions) {
    this.logger = options.logger.child({ component: 'scheduler' });
    this.onScheduledSync = options.onScheduledSync;
  }

  /**
   * Schedule a project for periodic sync.
   * If the project already has a schedule, it is replaced.
   *
   * @param projectId - The project ID.
   * @param cronExpression - A valid cron expression (e.g., "0 * * * *" for hourly).
   */
  schedule(projectId: string, cronExpression: string): void {
    // Validate the cron expression
    if (!cron.validate(cronExpression)) {
      this.logger.error({ projectId, cronExpression }, 'Invalid cron expression, not scheduling');
      return;
    }

    // Remove existing schedule if any
    this.unschedule(projectId);

    this.logger.info({ projectId, cronExpression }, 'Scheduling project sync');

    const job: ScheduledJob = {
      projectId,
      cronExpression,
      task: undefined as unknown as ScheduledTask, // set below
      lastTriggeredAt: 0,
    };

    const task = cron.schedule(cronExpression, () => {
      const now = Date.now();
      if (now - job.lastTriggeredAt < MIN_SCHEDULE_INTERVAL_MS) {
        this.logger.debug(
          { projectId, cronExpression },
          'Cron trigger throttled (minimum interval not elapsed)',
        );
        return;
      }
      job.lastTriggeredAt = now;
      this.logger.info({ projectId, cronExpression }, 'Cron trigger fired, requesting sync');
      this.onScheduledSync(projectId);
    });

    // Assign the task after creation (avoids chicken-and-egg with the closure)
    job.task = task;

    this.jobs.set(projectId, job);
  }

  /**
   * Remove a project's sync schedule.
   */
  unschedule(projectId: string): void {
    const existing = this.jobs.get(projectId);
    if (existing) {
      this.logger.info(
        { projectId, cronExpression: existing.cronExpression },
        'Removing project schedule',
      );
      existing.task.stop();
      this.jobs.delete(projectId);
    }
  }

  /**
   * Check whether a project has an active schedule.
   */
  isScheduled(projectId: string): boolean {
    return this.jobs.has(projectId);
  }

  /**
   * Get the cron expression for a scheduled project.
   */
  getCronExpression(projectId: string): string | null {
    return this.jobs.get(projectId)?.cronExpression ?? null;
  }

  /**
   * Get all currently scheduled project IDs.
   */
  getScheduledProjects(): readonly string[] {
    return Array.from(this.jobs.keys());
  }

  /**
   * Stop all scheduled jobs and clean up.
   */
  stopAll(): void {
    this.logger.info({ jobCount: this.jobs.size }, 'Stopping all scheduled jobs');

    for (const [projectId, job] of this.jobs) {
      job.task.stop();
      this.logger.debug({ projectId }, 'Stopped scheduled job');
    }

    this.jobs.clear();
  }
}
