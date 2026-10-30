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

/** Returns true only for genuine CBE / Telebirr receipt URLs. */
function isAllowedReceiptUrl(url: string): boolean {
    return parseReceiptLink(url) !== null;
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

export const decodeReceiptQr = async (buffer: Buffer, mimetype: string): Promise<string | null> => {
    try {
        let imageBuffer = buffer;
        if (mimetype === 'application/pdf') {
            const rendered = await renderPdfToPng(buffer);
            if (!rendered) return null;
            imageBuffer = rendered;
        }

        /** Decode a prepared buffer. `invert` defaults to dontInvert for speed. */
        const runDecode = async (imgBuffer: Buffer, invert: 'dontInvert' | 'attemptBoth' = 'dontInvert'): Promise<string | null> => {
            const { data, info } = await sharp(imgBuffer).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
            const clampedArray = new Uint8ClampedArray(data.buffer);
            const code = jsQR(clampedArray, info.width, info.height, {
                inversionAttempts: invert
            });
            if (code && code.data) {
                const qrData = code.data.trim();
                // Only return URLs that are genuine CBE or Telebirr receipt links.
                // Any other URL (including SSRF bait like 169.254.x.x) is silently dropped.
                if (qrData.startsWith('https://') || qrData.startsWith('http://')) {
                    return isAllowedReceiptUrl(qrData) ? qrData : null;
                }
                // Bare alphanumeric transaction references (no URL) pass through as-is
                if (/^[A-Z0-9]{8,20}$/i.test(qrData)) {
                    return qrData;
                }
            }
            return null;
        };

        // Always auto-rotate first (EXIF orientation), then shrink to 900 px.
        // jsQR cost is proportional to pixel count; 900 px is fast and still readable.
        const small = await sharp(imageBuffer).rotate().resize({ width: 900, withoutEnlargement: true }).toBuffer();

        // Pass 1: 900 px copy, no inversion (fastest path)
        let qrUrl = await runDecode(small);
        if (qrUrl) return qrUrl;

        // Pass 2: 900 px grayscale + contrast boost
        qrUrl = await runDecode(await sharp(small).grayscale().linear(1.5, -0.2).toBuffer());
        if (qrUrl) return qrUrl;

        // Pass 3: crop lower half of portrait receipts — QR is usually near the bottom
        const meta = await sharp(imageBuffer).metadata();
        if (meta.width && meta.height && meta.height > meta.width * 1.2) {
            const top = Math.floor(meta.height / 2);
            const crop = await sharp(imageBuffer)
                .extract({ left: 0, top, width: meta.width, height: meta.height - top })
                .resize({ width: 900, withoutEnlargement: true })
                .toBuffer();
            qrUrl = await runDecode(crop);
            if (qrUrl) return qrUrl;
        }

        // Pass 4 (last resort): full-size original, allow inverted QR codes
        return await runDecode(imageBuffer, 'attemptBoth');
    } catch (e) {
        return null; 
    }
};
