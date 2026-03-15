import { Router, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { storageService } from '../storage/storage.service';
import { waService } from '../whatsapp/whatsapp.service';
import { NotFoundError, AppError } from '../../lib/errors';
import { asyncHandler } from '../../lib/errors';
import { success, created, paginated } from '../../lib/response';
import { getPaginationParams, buildPaginationMeta } from '../../lib/response';

// ── Schemas ──────────────────────────────────────────────────────────────────

const createProductSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  price: z.number().positive().optional(),
  currency: z.string().length(3).default('INR'),
  sku: z.string().max(100).optional(),
  wa_catalog_id: z.string().optional(),
  wa_product_id: z.string().optional(),
});

const updateProductSchema = createProductSchema.partial();

// ── Service ───────────────────────────────────────────────────────────────────

class CatalogService {
  async list(tenantId: string, page: unknown, limit: unknown, activeOnly = false) {
    const params = getPaginationParams(page, limit);
    const where: Prisma.CatalogProductWhereInput = { tenant_id: tenantId };
    if (activeOnly) where.is_active = true;

    const [products, total] = await Promise.all([
      prisma.catalogProduct.findMany({
        where,
        skip: params.skip,
        take: params.limit,
        orderBy: { created_at: 'desc' },
      }),
      prisma.catalogProduct.count({ where }),
    ]);

    return { products, pagination: buildPaginationMeta(total, params) };
  }

  async getById(tenantId: string, id: string) {
    const product = await prisma.catalogProduct.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!product) throw new NotFoundError('Product');
    return product;
  }

  async create(tenantId: string, input: z.infer<typeof createProductSchema>) {
    return prisma.catalogProduct.create({
      data: {
        tenant_id: tenantId,
        name: input.name,
        description: input.description,
        price: input.price,
        currency: input.currency,
        sku: input.sku,
        wa_catalog_id: input.wa_catalog_id,
        wa_product_id: input.wa_product_id,
      },
    });
  }

  async update(tenantId: string, id: string, input: z.infer<typeof updateProductSchema>) {
    const product = await prisma.catalogProduct.findFirst({ where: { id, tenant_id: tenantId } });
    if (!product) throw new NotFoundError('Product');

    return prisma.catalogProduct.update({ where: { id }, data: input });
  }

  async delete(tenantId: string, id: string) {
    const product = await prisma.catalogProduct.findFirst({ where: { id, tenant_id: tenantId } });
    if (!product) throw new NotFoundError('Product');
    await prisma.catalogProduct.delete({ where: { id } });
  }

  async toggleActive(tenantId: string, id: string) {
    const product = await prisma.catalogProduct.findFirst({ where: { id, tenant_id: tenantId } });
    if (!product) throw new NotFoundError('Product');
    return prisma.catalogProduct.update({
      where: { id },
      data: { is_active: !product.is_active },
    });
  }

  /**
   * Upload product image:
   * 1. Upload to S3
   * 2. Store URL in DB
   * 3. Upload to WA Media endpoint
   * 4. Store wa_media_id (used as product image in catalog messages)
   */
  async uploadImage(tenantId: string, productId: string, file: Express.Multer.File) {
    const product = await prisma.catalogProduct.findFirst({
      where: { id: productId, tenant_id: tenantId },
    });
    if (!product) throw new NotFoundError('Product');

    if (!file.mimetype.startsWith('image/')) {
      throw new AppError('Only image files are allowed', 400);
    }

    // 1. Upload to S3
    const s3Key = `catalog/${tenantId}/${productId}-${Date.now()}.${file.originalname.split('.').pop()}`;
    const s3Url = await storageService.uploadBuffer(file.buffer, s3Key, file.mimetype);

    // 2. Upload to WhatsApp Media API
    let waMediaId: string | undefined;
    try {
      waMediaId = await waService.uploadMedia(
        tenantId,
        file.buffer,
        file.originalname,
        file.mimetype
      );
    } catch {
      // Non-fatal: store in DB even if WA upload fails
      console.warn(`WA media upload failed for product ${productId}`);
    }

    // 3. Store media asset record
    await prisma.mediaAsset.create({
      data: {
        tenant_id: tenantId,
        file_name: file.originalname,
        file_type: 'image',
        mime_type: file.mimetype,
        s3_key: s3Key,
        s3_url: s3Url,
        wa_media_id: waMediaId,
        file_size: file.size,
      },
    });

    // 4. Update product with image info
    return prisma.catalogProduct.update({
      where: { id: productId },
      data: {
        image_url: s3Url,
        s3_key: s3Key,
        ...(waMediaId && { wa_product_id: waMediaId }),
      },
    });
  }
}

export const catalogService = new CatalogService();

// ── Controller + Router ───────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const router = Router();

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, active } = req.query;
  const { products, pagination } = await catalogService.list(
    req.tenantId, page, limit, active === 'true'
  );
  return paginated(res, products, pagination);
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const input = createProductSchema.parse(req.body);
  const product = await catalogService.create(req.tenantId, input);
  return created(res, product, 'Product created');
}));

router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const product = await catalogService.getById(req.tenantId, req.params.id);
  return success(res, product);
}));

router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  const input = updateProductSchema.parse(req.body);
  const product = await catalogService.update(req.tenantId, req.params.id, input);
  return success(res, product, 'Product updated');
}));

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  await catalogService.delete(req.tenantId, req.params.id);
  return success(res, null, 'Product deleted');
}));

router.patch('/:id/toggle', asyncHandler(async (req: Request, res: Response) => {
  const product = await catalogService.toggleActive(req.tenantId, req.params.id);
  return success(res, product);
}));

router.post(
  '/:id/image',
  upload.single('image'),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) throw new AppError('No image file uploaded', 400);
    const product = await catalogService.uploadImage(req.tenantId, req.params.id, req.file);
    return success(res, product, 'Image uploaded');
  })
);

export default router;
