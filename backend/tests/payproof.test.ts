import { describe, it } from 'node:test';
import assert from 'node:assert';
import axios from 'axios';
import {
  validateAndParseTelebirrData,
  phonesMatch,
  normalizePhone,
  uploadReceiptToPayProof,
  pollPayProofVerification,
  verifyTelebirrReceiptWithPayProof,
  PayProofVerificationData,
} from '../src/services/payproof.service';

describe('PayProof Telebirr Verification Service', () => {
  describe('phonesMatch & normalizePhone', () => {
    it('normalizes Ethiopian phone formats correctly', () => {
      assert.strictEqual(normalizePhone('251911223344'), '911223344');
      assert.strictEqual(normalizePhone('0911223344'), '911223344');
      assert.strictEqual(normalizePhone('0711223344'), '711223344');
      assert.strictEqual(normalizePhone('+251 91 122 3344'), '911223344');
    });

    it('matches masked Telebirr numbers against registered phone numbers', () => {
      // Receipt has 2519****1087, registered is 0912341087
      assert.strictEqual(phonesMatch('2519****1087', '0912341087'), true);
      assert.strictEqual(phonesMatch('2519****1087', '251912341087'), true);
      assert.strictEqual(phonesMatch('09****1087', '0912341087'), true);
    });

    it('rejects numbers with different endings', () => {
      assert.strictEqual(phonesMatch('2519****1087', '0912349999'), false);
    });
  });

  describe('validateAndParseTelebirrData - Bank Scope (TELEBIRR ONLY)', () => {
    it('strictly rejects non-Telebirr receipts (CBE)', () => {
      const cbeData: PayProofVerificationData = {
        id: 101,
        status: 'VERIFIED',
        bank_name: 'CBE',
        reference_number: 'FT2412345678',
        amount: 500,
      };

      const result = validateAndParseTelebirrData(cbeData);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.verified, false);
      assert.strictEqual(result.status, 'INVALID_RECEIPT');
      assert.strictEqual(result.code, 'UNSUPPORTED_BANK');
      assert.match(result.message || '', /Only Telebirr receipts are supported/i);
    });

    it('strictly rejects other banks (AWASH, DASHEN, etc.)', () => {
      const awashData: PayProofVerificationData = {
        id: 102,
        status: 'VERIFIED',
        bank_name: 'AWASH',
        reference_number: 'AWA123456',
        amount: 250,
      };

      const result = validateAndParseTelebirrData(awashData);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.code, 'UNSUPPORTED_BANK');
    });

    it('accepts valid Telebirr receipts', () => {
      const telebirrData: PayProofVerificationData = {
        id: 103,
        status: 'VERIFIED',
        bank_name: 'TELEBIRR',
        reference_number: 'DJ88KMM4K0',
        amount: 11.0,
        service_fee: 1.0,
        pdf_link_data: {
          settled_amount: 10.0,
          service_fee: 1.0,
          date: '08-10-2026 19:59:43',
          to_name: 'SADA',
          credited_party_account_no: '2519****1087',
          payer_name: 'ALEMAYEHU KEBEDE',
          payer_telebirr_no: '2519****5544',
        },
      };

      const result = validateAndParseTelebirrData(telebirrData);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.verified, true);
      assert.strictEqual(result.status, 'VERIFIED');
      assert.strictEqual(result.provider, 'TELEBIRR');
      assert.strictEqual(result.reference, 'DJ88KMM4K0');
    });
  });

  describe('validateAndParseTelebirrData - Settled Amount Trap', () => {
    it('uses settled_amount (10.00 ETB) and NOT debited total (11.00 ETB)', () => {
      const data: PayProofVerificationData = {
        id: 104,
        status: 'VERIFIED',
        bank_name: 'TELEBIRR',
        reference_number: 'DJ88KMM4K0',
        amount: 11.0, // Debited total including 1 ETB fee
        service_fee: 1.0,
        pdf_link_data: {
          settled_amount: 10.0, // Real received amount
          service_fee: 1.0,
          to_name: 'SADA',
        },
      };

      // When cashier/merchant expects 10.00 ETB
      const result = validateAndParseTelebirrData(data, { expectedAmount: 10.0 });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.amount, 10.0);
      assert.strictEqual(result.settledAmount, 10.0);
      assert.strictEqual(result.totalDebitedAmount, 11.0);
      assert.strictEqual(result.serviceFee, 1.0);

      // If merchant expected 11.00 ETB, it should flag an AMOUNT_MISMATCH because settled is 10.00
      const mismatch = validateAndParseTelebirrData(data, { expectedAmount: 11.0 });
      assert.strictEqual(mismatch.success, false);
      assert.strictEqual(mismatch.status, 'AMOUNT_MISMATCH');
      assert.match(mismatch.message || '', /Amount mismatch/i);
    });

    it('handles floating point precision using integer cents', () => {
      const data: PayProofVerificationData = {
        id: 105,
        status: 'VERIFIED',
        bank_name: 'TELEBIRR',
        reference_number: 'DJ88KMM4K1',
        amount: 10.3,
        service_fee: 0.3,
        pdf_link_data: {
          settled_amount: 10.0,
        },
      };

      const result = validateAndParseTelebirrData(data, { expectedAmount: 10.0 });
      assert.strictEqual(result.success, true);
    });
  });

  describe('validateAndParseTelebirrData - Masked Beneficiary Matching', () => {
    const registered = [
      { accountNumber: '0912341087', accountHolderName: 'Sada Trading Enterprise' },
    ];

    it('verifies when masked phone number matches registered account', () => {
      const data: PayProofVerificationData = {
        id: 106,
        status: 'VERIFIED',
        bank_name: 'TELEBIRR',
        reference_number: 'DJ88KMM4K2',
        to_account: '2519****1087',
        to_name: 'Sada Trading',
        pdf_link_data: {
          settled_amount: 50.0,
          credited_party_account_no: '2519****1087',
          to_name: 'Sada Trading',
        },
      };

      const result = validateAndParseTelebirrData(data, {
        registeredAccounts: registered,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'VERIFIED');
    });

    it('rejects when destination phone and beneficiary name do not match', () => {
      const data: PayProofVerificationData = {
        id: 107,
        status: 'VERIFIED',
        bank_name: 'TELEBIRR',
        reference_number: 'DJ88KMM4K3',
        to_account: '2519****9999',
        to_name: 'Completely Different Person',
        pdf_link_data: {
          settled_amount: 50.0,
          credited_party_account_no: '2519****9999',
          to_name: 'Completely Different Person',
        },
      };

      const result = validateAndParseTelebirrData(data, {
        registeredAccounts: registered,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'WRONG_RECEIVER');
      assert.match(result.message || '', /Wrong receiver/i);
    });
  });

  describe('validateAndParseTelebirrData - Terminal Status Failures & Account Not Configured Fallback', () => {
    it('returns INVALID_RECEIPT when PayProof reports genuine FAILED status (not found)', () => {
      const data: PayProofVerificationData = {
        id: 108,
        status: 'FAILED',
        bank_name: 'TELEBIRR',
        reference_number: 'INVALID_REF',
        failure_reason: 'Transaction not found on Ethio Telecom portal',
      };

      const result = validateAndParseTelebirrData(data);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'INVALID_RECEIPT');
      assert.strictEqual(result.code, 'FAILED');
      assert.match(result.message || '', /not found/i);
    });

    it('successfully verifies when PayProof sets FAILED due to ACCOUNT_NOT_CONFIGURED but Ethio Telecom verified the receipt', () => {
      // Exact payload shape reported by the user
      const userPayload: PayProofVerificationData = {
        id: 4,
        status: 'FAILED',
        bank_name: 'TELEBIRR',
        amount: '11.0' as any,
        service_fee: '1.00' as any,
        reference_number: 'DJ88KMM4K0',
        transaction_date: '2026-10-08T16:59:43Z',
        admin_note:
          'ACCOUNT_NOT_CONFIGURED: Payment of ETB 10.00 to "SADA MUSSEIN ADAM" (2519****1087) at TELEBIRR is not registered to your company. If this account is yours, add it in Settings → Bank Accounts so future receipts can verify.',
        pdf_link_data: {
          amount: '10' as any,
          date: '08-10-2026 19:59:43',
          from_account: '2519****5625',
          from_name: 'bereket TEREFE AYELE',
          reference_number: 'DJ88KMM4K0',
          settled_amount: '10' as any,
          status: 'የክፍያ ዝርዝር/ Invoice details',
          to_account: '2519****1087',
          to_name: 'SADA MUSSEIN ADAM',
          total_amount_debited: '11' as any,
          total_paid_amount: '11' as any,
          transaction_fee: '1.00' as any,
          url: 'https://transactioninfo.ethiotelecom.et/receipt/DJ88KMM4K0',
        },
        ai_extracted_data: {
          step1_link_verification: {
            status: 'verified',
            url: 'https://transactioninfo.ethiotelecom.et/receipt/DJ88KMM4K0',
            receipt_data: {
              settled_amount: '10',
              reference_number: 'DJ88KMM4K0',
            },
          },
        },
      };

      const userRegisteredAccounts = [
        { accountNumber: '0932571087', accountHolderName: 'SADA' },
      ];

      const result = validateAndParseTelebirrData(userPayload, {
        expectedAmount: 10.0,
        registeredAccounts: userRegisteredAccounts,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.verified, true);
      assert.strictEqual(result.status, 'VERIFIED');
      assert.strictEqual(result.amount, 10.0);
      assert.strictEqual(result.settledAmount, 10.0);
      assert.strictEqual(result.totalDebitedAmount, 11.0);
      assert.strictEqual(result.serviceFee, 1.0);
      assert.strictEqual(result.reference, 'DJ88KMM4K0');
      assert.strictEqual(result.receiverAccount, '2519****1087');
      assert.strictEqual(result.receiverName, 'SADA MUSSEIN ADAM');
      assert.strictEqual(result.senderName, 'bereket TEREFE AYELE');
    });
  });

  describe('End-to-End Upload, Polling & Validation Flow (Mocked HTTP)', () => {
    const originalPost = axios.post;
    const originalGet = axios.get;

    it('uploads image and polls through PENDING -> PROCESSING -> VERIFIED', async () => {
      process.env.PAYPROOF_SECRET_KEY = 'sk_live_test_dummy_key';
      process.env.PAYPROOF_BASE_URL = 'https://verifyitet.duckdns.org';

      let postCalled = false;
      let getCallCount = 0;

      // Mock axios.post
      (axios as any).post = async (url: string, _data: any, config: any) => {
        postCalled = true;
        assert.match(url, /\/api\/v1\/verifications\/$/);
        assert.strictEqual(config.headers.Authorization, 'Bearer sk_live_test_dummy_key');
        return {
          status: 201,
          headers: { 'x-request-id': 'req-upload-test-123' },
          data: { id: 777, status: 'PENDING' },
        };
      };

      // Mock axios.get
      (axios as any).get = async (url: string, config: any) => {
        getCallCount++;
        assert.match(url, /\/api\/v1\/verifications\/777\/$/);
        assert.strictEqual(config.headers.Authorization, 'Bearer sk_live_test_dummy_key');

        if (getCallCount === 1) {
          return {
            status: 200,
            headers: { 'x-request-id': 'req-poll-1' },
            data: { id: 777, status: 'PENDING' },
          };
        } else if (getCallCount === 2) {
          return {
            status: 200,
            headers: { 'x-request-id': 'req-poll-2' },
            data: { id: 777, status: 'PROCESSING' },
          };
        } else {
          return {
            status: 200,
            headers: { 'x-request-id': 'req-poll-3' },
            data: {
              verification: {
                id: 777,
                status: 'VERIFIED',
                bank_name: 'TELEBIRR',
                reference_number: 'DJ88KMM4K0',
                amount: 11.0,
                service_fee: 1.0,
                pdf_link_data: {
                  settled_amount: 10.0,
                  service_fee: 1.0,
                  to_name: 'SADA',
                },
              },
            },
          };
        }
      };

      try {
        const dummyBuffer = Buffer.from('fake-jpeg-data');
        const progressStages: string[] = [];

        const result = await verifyTelebirrReceiptWithPayProof(dummyBuffer, 'receipt.jpg', 'image/jpeg', {
          expectedAmount: 10.0,
          pollIntervalMs: 10,
          timeoutMs: 2000,
          onProgress: (stage) => progressStages.push(stage),
        });

        assert.strictEqual(postCalled, true);
        assert.strictEqual(getCallCount, 3);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'VERIFIED');
        assert.strictEqual(result.amount, 10.0);
        assert.strictEqual(result.settledAmount, 10.0);
        assert.strictEqual(result.reference, 'DJ88KMM4K0');
        assert.strictEqual(result.verificationId, 777);
        assert.strictEqual(result.requestId, 'req-poll-3');
        assert(progressStages.length >= 2);
      } finally {
        (axios as any).post = originalPost;
        (axios as any).get = originalGet;
      }
    });
  });

  describe('Telegram Formatter Output', () => {
    it('formats verified Telebirr receipt with Ethiopian calendar and relative time', async () => {
      const { formatVerificationResult } = await import('../src/telegram/formatter');
      const targetDate = new Date('2026-10-13T20:13:00.000Z'); // 23:13 in Africa/Addis_Ababa
      const verifyDate = new Date(targetDate.getTime() + (26 * 24 + 13) * 3600 * 1000 + 10 * 60 * 1000); // 26d 13h later

      const sampleResult = {
        status: 'VERIFIED',
        provider: 'TELEBIRR',
        txnReference: 'DJD2RP0ZNM',
        amount: 10,
        settledAmount: 10,
        receiverName: 'SADA',
        transactionDate: targetDate.toISOString(),
        verifiedAt: verifyDate.toISOString(),
      };

      const formatted = formatVerificationResult({ httpStatus: 200, result: sampleResult });

      assert(formatted.includes('✅ *Verified / ተረጋግጧል*'));
      assert(formatted.includes('🏦 `TELEBIRR`'));
      assert(formatted.includes('💰 *ETB 10*'));
      assert(formatted.includes('🔖 `DJD2RP0ZNM`'));
      assert(formatted.includes('👥 *SADA*'));
      assert(formatted.includes('📅 13 Oct 2026, 11:13 PM'));
      assert(formatted.includes('\\(ጥቅምት 3, 2019, 5:13 ከምሽት\\)'));
      assert(formatted.includes('26d 13h from verification'));
    });
  });
});
