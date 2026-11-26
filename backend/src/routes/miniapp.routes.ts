import { Router } from 'express';
import { miniappAuth, miniappLink, miniappUnlink, miniappMe } from '../controllers/miniapp.controller';
import { telegramPhoneLogin } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// Validate Telegram initData → return JWT or { needsRegistration: true }
router.post('/auth', miniappAuth);

// Passwordless login via Telegram-verified phone number
router.post('/phone-login', telegramPhoneLogin);

// Link a Telegram account to an existing API user (requires valid JWT)
router.post('/link', requireAuth, miniappLink);

// Unlink a Telegram account from current user (requires valid JWT)
router.post('/unlink', requireAuth, miniappUnlink);

// Get full profile of the logged-in Mini App user
router.get('/me', requireAuth, miniappMe);

export default router;
