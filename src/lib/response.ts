import { Response } from 'express';
import { ApiResponse, PaginationMeta, PaginationParams } from '../types';

export function success<T>(res: Response, data: T, message?: string, status = 200): Response {
  const response: ApiResponse<T> = { success: true, data, message };
  return res.status(status).json(response);
}

export function created<T>(res: Response, data: T, message?: string): Response {
  return success(res, data, message, 201);
}

export function paginated<T>(
  res: Response,
  data: T[],
  pagination: PaginationMeta,
  message?: string
): Response {
  const response: ApiResponse<T[]> = { success: true, data, message, pagination };
  return res.status(200).json(response);
}

export function error(res: Response, message: string, status = 400): Response {
  const response: ApiResponse = { success: false, message };
  return res.status(status).json(response);
}

export function validationError(
  res: Response,
  errors: Record<string, string[]>,
  message = 'Validation failed'
): Response {
  const response: ApiResponse = { success: false, message, errors };
  return res.status(422).json(response);
}

export function getPaginationParams(
  page: unknown,
  limit: unknown,
  maxLimit = 100
): PaginationParams {
  const p = Math.max(1, parseInt(String(page ?? 1), 10) || 1);
  const l = Math.min(maxLimit, Math.max(1, parseInt(String(limit ?? 20), 10) || 20));
  return {
    page: p,
    limit: l,
    skip: (p - 1) * l,
  };
}

export function buildPaginationMeta(
  total: number,
  params: PaginationParams
): PaginationMeta {
  const total_pages = Math.ceil(total / params.limit);
  return {
    page: params.page,
    limit: params.limit,
    total,
    total_pages,
    has_next: params.page < total_pages,
    has_prev: params.page > 1,
  };
}
