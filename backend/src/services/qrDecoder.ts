import jsQR from 'jsqr';
import { parseReceiptLink } from './receiptLink';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import sharp from 'sharp';

const execAsync = util.promisify(exec);

/** Cache the check for pdftoppm binary availability */
let pdftoppmAvailable: boolean | null = null;
async function isPdftoppmAvailable(): Promise<boolean> {
    if (pdftoppmAvailable !== null) return pdftoppmAvailable;
    try {
        await execAsync('which pdftoppm');
        pdftoppmAvailable = true;
    } catch {
        pdftoppmAvailable = false;
    }
    return pdftoppmAvailable;
}

/** Returns true only for genuine CBE / Telebirr receipt URLs. */
function isAllowedReceiptUrl(url: string): boolean {
    return parseReceiptLink(url) !== null;
}

function validateQrData(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const qrData = raw.trim();
    if (!qrData) return null;
    // Only return URLs that are genuine CBE or Telebirr receipt links.
    // Any other URL (including SSRF bait like 169.254.x.x) is silently dropped.
    if (qrData.startsWith('https://') || qrData.startsWith('http://')) {
        return isAllowedReceiptUrl(qrData) ? qrData : null;
    }
    // Bare alphanumeric transaction references (no URL) pass through as-is
    if (/^[A-Z0-9]{8,25}$/i.test(qrData)) {
        return qrData;
    }
    return null;
}

async function renderPdfToPng(buffer: Buffer): Promise<Buffer | null> {
    const tempId = crypto.randomBytes(8).toString('hex');
    const pdfPath = path.join(os.tmpdir(), `${tempId}.pdf`);
    const pngPrefix = path.join(os.tmpdir(), `${tempId}`);

    try {
        fs.writeFileSync(pdfPath, buffer);
        await execAsync(`pdftoppm -png -f 1 -l 1 "${pdfPath}" "${pngPrefix}"`);
        const pngPath = `${pngPrefix}-1.png`;
        if (fs.existsSync(pngPath)) {
            const pngBuffer = fs.readFileSync(pngPath);
            fs.unlinkSync(pngPath);
            return pngBuffer;
        }
        return null;
    } catch (e) {
        return null;
    } finally {
        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    }
}

/** Yield event loop between expensive CPU-bound decode passes */
const yieldCpu = () => new Promise<void>((resolve) => setImmediate(resolve));

export const decodeReceiptQr = async (buffer: Buffer, mimetype: string): Promise<string | null> => {
    try {
        let imageBuffer = buffer;
        if (mimetype === 'application/pdf') {
            if (!(await isPdftoppmAvailable())) {
                return null;
            }
            const rendered = await renderPdfToPng(buffer);
            if (!rendered) return null;
            imageBuffer = rendered;
        }

        // Single sharp decode directly to raw RGBA pixels (no redundant JPEG re-encode/decode cycles!)
        const { data: raw900, info: info900 } = await sharp(imageBuffer)
            .rotate()
            .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const clamped900 = new Uint8ClampedArray(raw900.buffer, raw900.byteOffset, raw900.byteLength);

        // Pass 1: Standard light-background QR (fastest path, ~15-30ms)
        const p1 = jsQR(clamped900, info900.width, info900.height, { inversionAttempts: 'dontInvert' });
        const r1 = validateQrData(p1?.data);
        if (r1) return r1;

        // Pass 2: Lower-half crop for tall portrait mobile receipts (zero sharp calls — subarray view!)
        if (info900.height > info900.width * 1.15) {
            const top = Math.floor(info900.height * 0.45);
            const cropHeight = info900.height - top;
            const sub = clamped900.subarray(top * info900.width * 4);
            const p2 = jsQR(sub, info900.width, cropHeight, { inversionAttempts: 'dontInvert' });
            const r2 = validateQrData(p2?.data);
            if (r2) return r2;
        }

        // Pass 3: Dark-mode / inverted QR on the exact same in-memory raw buffer (zero sharp calls!)
        await yieldCpu();
        const p3 = jsQR(clamped900, info900.width, info900.height, { inversionAttempts: 'onlyInvert' });
        const r3 = validateQrData(p3?.data);
        if (r3) return r3;

        // Pass 4: Contrast-boosted higher-res decode (single sharp call directly to raw RGBA)
        await yieldCpu();
        const { data: rawBoost, info: infoBoost } = await sharp(imageBuffer)
            .rotate()
            .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
            .grayscale()
            .linear(1.5, -0.2)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        const clampedBoost = new Uint8ClampedArray(rawBoost.buffer, rawBoost.byteOffset, rawBoost.byteLength);
        const p4 = jsQR(clampedBoost, infoBoost.width, infoBoost.height, { inversionAttempts: 'dontInvert' });
        return validateQrData(p4?.data);
    } catch (e) {
        return null;
    }
};
