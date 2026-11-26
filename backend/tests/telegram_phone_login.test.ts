import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { normalizePhone } from '../src/controllers/auth.controller';
import { verifyInitData } from '../src/controllers/miniapp.controller';

describe('Telegram Phone Passwordless Sign-In & Normalization', () => {
  describe('normalizePhone for Database Matching', () => {
    it('normalizes local 09 format to E.164 (+251...) exactly matching DB storage', () => {
      assert.strictEqual(normalizePhone('0912345678'), '+251912345678');
    });

    it('normalizes local 07 format to E.164 (+251...)', () => {
      assert.strictEqual(normalizePhone('0712345678'), '+251712345678');
    });

    it('normalizes Telegram 2519... format (no plus) to E.164 (+251...)', () => {
      assert.strictEqual(normalizePhone('251912345678'), '+251912345678');
    });

    it('normalizes Telegram 2517... format (no plus) to E.164 (+251...)', () => {
      assert.strictEqual(normalizePhone('251712345678'), '+251712345678');
    });

    it('preserves valid +251... format', () => {
      assert.strictEqual(normalizePhone('+251912345678'), '+251912345678');
    });

    it('handles 9-digit raw numbers without prefix by prepending +251', () => {
      assert.strictEqual(normalizePhone('912345678'), '+251912345678');
      assert.strictEqual(normalizePhone('712345678'), '+251712345678');
    });

    it('handles spaces and dashes properly', () => {
      assert.strictEqual(normalizePhone('0912 34 56 78'), '+251912345678');
      assert.strictEqual(normalizePhone('+251-912-345678'), '+251912345678');
    });
  });

  describe('HMAC-SHA256 Cryptographic Validation', () => {
    const mockBotToken = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

    it('successfully validates genuine Telegram initData', () => {
      process.env.TELEGRAM_BOT_TOKEN = mockBotToken;

      const user = JSON.stringify({
        id: 888777666,
        first_name: 'Abebe',
        last_name: 'Bikila',
        username: 'abebikila',
      });
      const auth_date = Math.floor(Date.now() / 1000).toString();

      // Data check string: alphabetically sorted key=value joined by \n
      const params = new Map<string, string>([
        ['auth_date', auth_date],
        ['query_id', 'AAHdF6IQAAAAAN0XohD12345'],
        ['user', user],
      ]);

      const dataCheckString = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');

      const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(mockBotToken)
        .digest();

      const hash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

      const rawInitData = `auth_date=${encodeURIComponent(auth_date)}&query_id=AAHdF6IQAAAAAN0XohD12345&user=${encodeURIComponent(user)}&hash=${hash}`;

      const parsed = verifyInitData(rawInitData);
      assert.strictEqual(parsed.user?.id, 888777666);
      assert.strictEqual(parsed.user?.first_name, 'Abebe');
    });

    it('rejects tampered Telegram initData', () => {
      process.env.TELEGRAM_BOT_TOKEN = mockBotToken;

      const rawInitData = `auth_date=1700000000&query_id=fake&user=%7B%22id%22%3A123%7D&hash=invalid_hash_signature`;

      assert.throws(() => {
        verifyInitData(rawInitData);
      }, /initData signature mismatch/i);
    });

    it('rejects expired Telegram initData (> 24 hours)', () => {
      process.env.TELEGRAM_BOT_TOKEN = mockBotToken;

      const user = JSON.stringify({ id: 12345, first_name: 'Old' });
      // 25 hours ago
      const auth_date = Math.floor(Date.now() / 1000 - 25 * 3600).toString();

      const params = new Map<string, string>([
        ['auth_date', auth_date],
        ['user', user],
      ]);

      const dataCheckString = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');

      const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(mockBotToken)
        .digest();

      const hash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

      const rawInitData = `auth_date=${encodeURIComponent(auth_date)}&user=${encodeURIComponent(user)}&hash=${hash}`;

      assert.throws(() => {
        verifyInitData(rawInitData);
      }, /older than 24 hours/i);
    });
  });
});
