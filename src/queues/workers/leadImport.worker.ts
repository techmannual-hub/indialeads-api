import { Worker, Job } from 'bullmq';
import { createRedisConnection } from '../../config/redis';
import { QUEUE_NAMES } from '../../config/queues';
import { LeadImportJobData } from '../../types';
import { processLeadUpload } from '../../modules/leads/leads.upload';

export function createLeadImportWorker(): Worker {
  const worker = new Worker<LeadImportJobData>(
    QUEUE_NAMES.LEAD_IMPORTER,
    async (job: Job<LeadImportJobData>) => {
      const { tenantId, uploadId, s3Key } = job.data;
      console.log(`📥 Processing lead upload ${uploadId} for tenant ${tenantId}`);
      await processLeadUpload(tenantId, uploadId, s3Key);
    },
    {
      connection: createRedisConnection(),
      concurrency: 2, // max 2 imports at a time
    }
  );

  worker.on('completed', (job) => {
    console.log(`✅ Lead import job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`❌ Lead import job ${job?.id} failed:`, err.message);
  });

  return worker;
}
