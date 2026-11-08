import { Router } from 'express';
import {
  register,
  login,
  cashierLogin,
  cashierPasswordLogin,
  getMe,
  logout,
} from '../controllers/auth.controller';
import { loginRateLimit } from '../middleware/rateLimit.middleware';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

/**
 * POST /api/auth/register
 * Admin signs up (Personal or Business).
 * Body: { fullName, phone, pinCode, accountType }
 */
router.post('/register', register);

/**
 * POST /api/auth/login
 * Admin logs in with phone + 4-digit PIN.
 * Body: { phone, pinCode }
 */
router.post('/login', loginRateLimit, login);

/**
 * POST /api/auth/cashier-login
 * Cashier logs in with password.
 * Body: { password, fullName?, branchId? }
 */
router.post('/cashier-login', cashierPasswordLogin);

/**
 * GET /api/auth/me
 * Profile of currently authenticated user (Admin or Cashier).
 * Header: Authorization: Bearer <token>
 */
router.get('/me', requireAuth, getMe);

/**
 * POST /api/auth/logout
 * Sign out (clears auth cookie).
 */
router.post('/logout', logout);

/**
 * POST /api/auth/cashier-token
 * Legacy PIN-based cashier login (shift tablet).
 * Body: { pin, branchId }
 */
router.post('/cashier-token', cashierLogin);

export default router;
