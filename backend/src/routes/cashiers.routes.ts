import { Router } from 'express';
import {
  listCashiers,
  createCashier,
  updateCashier,
  setCashierStatus,
  deleteCashier,
} from '../controllers/cashiers.controller';
import { requireAuth, requireAdmin } from '../middleware/auth.middleware';

const router = Router();

// All cashier management routes require authentication and admin privileges
router.get('/', requireAuth, requireAdmin, listCashiers);
router.post('/', requireAuth, requireAdmin, createCashier);
router.patch('/:id', requireAuth, requireAdmin, updateCashier);
router.patch('/:id/status', requireAuth, requireAdmin, setCashierStatus);
router.delete('/:id', requireAuth, requireAdmin, deleteCashier);

export default router;
