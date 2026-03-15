import { z } from 'zod';

export const createLeadSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(7).max(20),
  email: z.string().email().optional().or(z.literal('')),
  products: z.array(z.string()).default([]),
  status: z.enum(['PENDING', 'LIVE', 'DEAD', 'COOLING']).default('PENDING'),
  stage: z.string().max(100).optional(),
  label: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
});

export const updateLeadSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional().or(z.literal('')),
  products: z.array(z.string()).optional(),
  status: z.enum(['PENDING', 'LIVE', 'DEAD', 'COOLING']).optional(),
  stage: z.string().max(100).optional().nullable(),
  label: z.string().max(100).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  opt_out: z.boolean().optional(),
  cooling_until: z.string().datetime().optional().nullable(),
});

export const listLeadsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['PENDING', 'LIVE', 'DEAD', 'COOLING']).optional(),
  stage: z.string().optional(),
  label: z.string().optional(),
  search: z.string().optional(),
  tag_id: z.string().optional(),
  sort_by: z.enum(['created_at', 'updated_at', 'name', 'last_contacted_at']).default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export const bulkUpdateSchema = z.object({
  lead_ids: z.array(z.string()).min(1).max(500),
  status: z.enum(['PENDING', 'LIVE', 'DEAD', 'COOLING']).optional(),
  stage: z.string().optional(),
  label: z.string().optional(),
  tag_id: z.string().optional(),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export type ListLeadsInput = z.infer<typeof listLeadsSchema>;
