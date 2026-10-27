import { Router } from 'express';
import { register, login, cashierLogin } from '../controllers/auth.controller';

const router = Router();

router.post('/register', register);
router.post('/login', login);

/**
 * POST /auth/cashier-token
 * Verifies the cashier PIN once and returns an 8-hour JWT.
 * Tablets call this at shift start; subsequent /verify/* calls use the JWT.
 */
router.post('/cashier-token', cashierLogin);

export default router;

