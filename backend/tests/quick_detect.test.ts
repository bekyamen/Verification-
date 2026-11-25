import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { quickDetectProvider } from '../src/services/imageVerify.service';

describe('Quick Provider Auto-Detection (CBE vs Telebirr)', () => {
  const dir = '/home/ma/.gemini/antigravity/brain/932dd8eb-34e2-4ab0-bc4c-d958b3712d64/.user_uploaded';

  it('accurately identifies CBE receipts', async () => {
    const cbeFile = path.join(dir, 'media_1794996810675_2c544b39.jpg');
    if (fs.existsSync(cbeFile)) {
      const buf = fs.readFileSync(cbeFile);
      const prov = await quickDetectProvider(buf, 'image/jpeg');
      assert.strictEqual(prov, 'CBE');
    }
  });

  it('accurately identifies Telebirr receipts', async () => {
    const telebirrFile = path.join(dir, 'media_1795117552732_e47b25e1.jpg');
    if (fs.existsSync(telebirrFile)) {
      const buf = fs.readFileSync(telebirrFile);
      const prov = await quickDetectProvider(buf, 'image/jpeg');
      assert.strictEqual(prov, 'TELEBIRR');
    }
  });

  it('returns UNKNOWN for plain blank buffers', async () => {
    const emptyBuf = Buffer.alloc(100);
    const prov = await quickDetectProvider(emptyBuf, 'image/jpeg');
    assert.strictEqual(prov, 'UNKNOWN');
  });
});
