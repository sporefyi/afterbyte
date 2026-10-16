import type { Queue, Job } from 'bullmq';
import type { QueueName } from './queues.js';

export interface DeadLetterJobDto {
  id: string;
  queue: QueueName;
  jobKey: string | null;
  attemptsMade: number;
  failedReason: string;
  failedAt: string | null;
  finishedOn: number | null;
  data: unknown;
}

export function toDeadLetterDto(queue: QueueName, job: Job): DeadLetterJobDto {
  const jobKey = (job.data as any)?.jobKey ?? null;
  const failedAt = job.failedReason && job.finishedOn
    ? new Date(job.finishedOn).toISOString()
    : null;

  return {
    id: job.id ?? '',
    queue,
    jobKey,
    attemptsMade: job.attemptsMade ?? 0,
    failedReason: job.failedReason ?? '',
    failedAt,
    finishedOn: job.finishedOn ?? null,
    data: job.data,
  };
}

export async function listDeadLetterJobs(
  queues: Map<QueueName, Queue>,
  queueName: QueueName,
  opts?: { limit?: number; offset?: number },
): Promise<{ jobs: DeadLetterJobDto[]; total: number }> {
  const queue = queues.get(queueName);
  if (!queue) {
    return { jobs: [], total: 0 };
  }

  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const total = await queue.getFailedCount();
  const failedJobs = await queue.getFailed(offset, offset + limit - 1);

  const jobs = failedJobs.map((job) => toDeadLetterDto(queueName, job));

  return { jobs, total };
}

export async function getQueueOverview(
  queues: Map<QueueName, Queue>,
): Promise<Record<QueueName, Record<string, number>>> {
  const overview = {} as Record<QueueName, Record<string, number>>;

  for (const [queueName, queue] of queues) {
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    );
    overview[queueName] = counts;
  }

  return overview;
}

export async function retryDeadLetterJob(
  queues: Map<QueueName, Queue>,
  queueName: QueueName,
  jobId: string,
): Promise<void> {
  const queue = queues.get(queueName);
  if (!queue) {
    throw new Error(`Queue ${queueName} not found`);
  }

  const job = await queue.getJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found in queue ${queueName}`);
  }

  await job.retry();
}

export async function discardDeadLetterJob(
  queues: Map<QueueName, Queue>,
  queueName: QueueName,
  jobId: string,
): Promise<void> {
  const queue = queues.get(queueName);
  if (!queue) {
    throw new Error(`Queue ${queueName} not found`);
  }

  const job = await queue.getJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found in queue ${queueName}`);
  }

  // Removing the BullMQ job never erases business dedup in job_records
  await job.remove();
}
