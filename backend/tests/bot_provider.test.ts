import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  pickProvider,
  lastProvider,
  orgBanks,
  extractExpectedAmount,
} from '../src/telegram/bot';
import prisma from '../src/utils/prisma';

describe('Telegram Bot Fast Provider Selection', () => {
  const dummyOrgId = 'org-test-provider-123';
  const cashierId = 987654321;

  beforeEach(() => {
    lastProvider.clear();
    orgBanks.clear();
  });

  describe('Caption Keyword Matching', () => {
    it('detects Telebirr from various caption formats', async () => {
      assert.strictEqual(await pickProvider('telebirr', cashierId, dummyOrgId), 'TELEBIRR');
      assert.strictEqual(await pickProvider('Paid with Tele Birr', cashierId, dummyOrgId), 'TELEBIRR');
      assert.strictEqual(await pickProvider('TELEBIRR 50 ETB', cashierId, dummyOrgId), 'TELEBIRR');
    });

    it('detects CBE from various caption formats', async () => {
      assert.strictEqual(await pickProvider('cbe', cashierId, dummyOrgId), 'CBE');
      assert.strictEqual(await pickProvider('Receipt for cbe transfer', cashierId, dummyOrgId), 'CBE');
      assert.strictEqual(await pickProvider('CBE 100', cashierId, dummyOrgId), 'CBE');
    });
  });

  describe('Organization Registered Accounts (Zero Processing Fallback)', () => {
    it('picks TELEBIRR if organization has only Telebirr registered', async () => {
      // Mock orgBanks cache directly
      orgBanks.set(dummyOrgId, { banks: new Set(['TELEBIRR']), exp: Date.now() + 60000 });

      const picked = await pickProvider(undefined, cashierId, dummyOrgId);
      assert.strictEqual(picked, 'TELEBIRR');
    });

    it('picks CBE if organization has only CBE registered', async () => {
      orgBanks.set(dummyOrgId, { banks: new Set(['CBE']), exp: Date.now() + 60000 });

      const picked = await pickProvider(undefined, cashierId, dummyOrgId);
      assert.strictEqual(picked, 'CBE');
    });
  });

  describe('Last Provider Memory & Ambiguity Resolution', () => {
    it('uses lastProvider when organization has both CBE and TELEBIRR', async () => {
      orgBanks.set(dummyOrgId, { banks: new Set(['TELEBIRR', 'CBE']), exp: Date.now() + 60000 });

      // Cashier previously verified Telebirr
      lastProvider.set(cashierId, 'TELEBIRR');
      assert.strictEqual(await pickProvider(undefined, cashierId, dummyOrgId), 'TELEBIRR');

      // Cashier previously verified CBE
      lastProvider.set(cashierId, 'CBE');
      assert.strictEqual(await pickProvider(undefined, cashierId, dummyOrgId), 'CBE');
    });

    it('returns undefined (triggers inline buttons) when org has both and cashier is new', async () => {
      orgBanks.set(dummyOrgId, { banks: new Set(['TELEBIRR', 'CBE']), exp: Date.now() + 60000 });

      // No lastProvider set for this cashier
      const picked = await pickProvider(undefined, cashierId, dummyOrgId);
      assert.strictEqual(picked, undefined);
    });
  });

  describe('Caption Amount Extraction', () => {
    it('extracts amounts correctly', () => {
      assert.strictEqual(extractExpectedAmount('50 ETB'), 50);
      assert.strictEqual(extractExpectedAmount('ETB 120.50'), 120.5);
      assert.strictEqual(extractExpectedAmount('telebirr 75'), 75);
      assert.strictEqual(extractExpectedAmount(''), undefined);
      assert.strictEqual(extractExpectedAmount('Receipt 2026'), undefined);
    });
  });
});
