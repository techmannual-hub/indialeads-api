import { Router } from 'express';
import * as tenantController from './tenant.controller';

const router = Router();

router.get('/profile', tenantController.getProfile);
router.put('/profile', tenantController.updateProfile);
router.put('/whatsapp-settings', tenantController.updateWaSettings);
router.get('/stats', tenantController.getStats);
router.post('/onboarding', tenantController.advanceOnboarding);

export default router;
