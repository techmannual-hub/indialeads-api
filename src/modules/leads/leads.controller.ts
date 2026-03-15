import { Request, Response } from 'express';
import { z } from 'zod';
import { leadsService } from './leads.service';
import { storageService } from '../storage/storage.service';
import {
  createLeadSchema,
  updateLeadSchema,
  listLeadsSchema,
  bulkUpdateSchema,
} from './leads.schema';
import { asyncHandler, AppError } from '../../lib/errors';
import { success, created, paginated } from '../../lib/response';
import { getLeadImportQueue } from '../../config/queues';
import prisma from '../../config/database';

export const listLeads = asyncHandler(async (req: Request, res: Response) => {
  const query = listLeadsSchema.parse(req.query);
  const { leads, pagination } = await leadsService.list(req.tenantId, query);
  return paginated(res, leads, pagination);
});

export const getLead = asyncHandler(async (req: Request, res: Response) => {
  const lead = await leadsService.getById(req.tenantId, req.params.id);
  return success(res, lead);
});

export const createLead = asyncHandler(async (req: Request, res: Response) => {
  const input = createLeadSchema.parse(req.body);
  const lead = await leadsService.create(req.tenantId, input);
  return created(res, lead, 'Lead created');
});

export const updateLead = asyncHandler(async (req: Request, res: Response) => {
  const input = updateLeadSchema.parse(req.body);
  const lead = await leadsService.update(req.tenantId, req.params.id, input);
  return success(res, lead, 'Lead updated');
});

export const deleteLead = asyncHandler(async (req: Request, res: Response) => {
  await leadsService.delete(req.tenantId, req.params.id);
  return success(res, null, 'Lead deleted');
});

export const bulkUpdateLeads = asyncHandler(async (req: Request, res: Response) => {
  const { lead_ids, ...updates } = bulkUpdateSchema.parse(req.body);
  const result = await leadsService.bulkUpdate(req.tenantId, lead_ids, updates);
  return success(res, result, `${result.updated} leads updated`);
});

export const uploadLeads = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) throw new AppError('No file uploaded', 400);

  const allowedTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
  ];
  if (!allowedTypes.includes(req.file.mimetype)) {
    throw new AppError('Only .xlsx, .xls, and .csv files are supported', 400);
  }

  // Upload file to S3
  const s3Key = `leads/${req.tenantId}/${Date.now()}-${req.file.originalname}`;
  const s3Url = await storageService.uploadBuffer(
    req.file.buffer,
    s3Key,
    req.file.mimetype
  );

  // Create upload record
  const upload = await prisma.leadUpload.create({
    data: {
      tenant_id: req.tenantId,
      file_name: req.file.originalname,
      s3_key: s3Key,
      status: 'PENDING',
    },
  });

  // Enqueue processing job
  const queue = getLeadImportQueue();
  await queue.add(
    'import-leads',
    { tenantId: req.tenantId, uploadId: upload.id, s3Key },
    { jobId: upload.id } // idempotent: same upload won't be queued twice
  );

  return created(res, { upload_id: upload.id, s3_url: s3Url }, 'File uploaded, processing started');
});

export const getUploadStatus = asyncHandler(async (req: Request, res: Response) => {
  const upload = await prisma.leadUpload.findFirst({
    where: { id: req.params.uploadId, tenant_id: req.tenantId },
  });
  if (!upload) throw new AppError('Upload not found', 404);
  return success(res, upload);
});

export const addTag = asyncHandler(async (req: Request, res: Response) => {
  const { tag_id } = z.object({ tag_id: z.string() }).parse(req.body);
  await leadsService.addTag(req.tenantId, req.params.id, tag_id);
  return success(res, null, 'Tag added');
});

export const removeTag = asyncHandler(async (req: Request, res: Response) => {
  await leadsService.removeTag(req.tenantId, req.params.id, req.params.tagId);
  return success(res, null, 'Tag removed');
});
