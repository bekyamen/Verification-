import { Router } from 'express';
import { miniappAuth, miniappLink, miniappMe } from '../controllers/miniapp.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// Validate Telegram initData → return JWT or { needsRegistration: true }
router.post('/auth', miniappAuth);

// Link a Telegram account to an existing API user (requires valid JWT)
router.post('/link', requireAuth, miniappLink);

// Get full profile of the logged-in Mini App user
router.get('/me', requireAuth, miniappMe);

export default router;
