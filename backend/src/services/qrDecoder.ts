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

        /** Decode a prepared buffer. `invert` defaults to dontInvert for speed. */
        const runDecode = async (
            imgBuffer: Buffer,
            invert: 'dontInvert' | 'attemptBoth' = 'dontInvert'
        ): Promise<string | null> => {
            try {
                const { data, info } = await sharp(imgBuffer).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
                // Pass byteOffset and byteLength to avoid Node buffer pool offset corruption
                const clampedArray = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
                const code = jsQR(clampedArray, info.width, info.height, {
                    inversionAttempts: invert,
                });
                if (code && code.data) {
                    const qrData = code.data.trim();
                    // Only return URLs that are genuine CBE or Telebirr receipt links.
                    // Any other URL (including SSRF bait like 169.254.x.x) is silently dropped.
                    if (qrData.startsWith('https://') || qrData.startsWith('http://')) {
                        return isAllowedReceiptUrl(qrData) ? qrData : null;
                    }
                    // Bare alphanumeric transaction references (no URL) pass through as-is
                    if (/^[A-Z0-9]{8,25}$/i.test(qrData)) {
                        return qrData;
                    }
                }
                return null;
            } catch {
                return null;
            }
        };

        // Rotate first (EXIF orientation), cap at 1400px, and reuse this base buffer
        const { data: baseBuffer, info: baseInfo } = await sharp(imageBuffer)
            .rotate()
            .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
            .toBuffer({ resolveWithObject: true });

        // Pass 1: 900px copy, no inversion (fastest path)
        const small = (baseInfo.width <= 900 && baseInfo.height <= 900)
            ? baseBuffer
            : await sharp(baseBuffer)
                .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
                .toBuffer();

        let qrUrl = await runDecode(small, 'dontInvert');
        if (qrUrl) return qrUrl;

        // Pass 2: 900px grayscale + contrast boost
        await yieldCpu();
        const pass2Buffer = await sharp(small).grayscale().linear(1.5, -0.2).toBuffer();
        qrUrl = await runDecode(pass2Buffer, 'dontInvert');
        if (qrUrl) return qrUrl;

        // Pass 3: crop lower half of portrait receipts (using rotated base image)
        await yieldCpu();
        if (baseInfo.height > baseInfo.width * 1.2) {
            const top = Math.floor(baseInfo.height / 2);
            const crop = await sharp(baseBuffer)
                .extract({ left: 0, top, width: baseInfo.width, height: baseInfo.height - top })
                .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
                .toBuffer();
            qrUrl = await runDecode(crop, 'dontInvert');
            if (qrUrl) return qrUrl;
        }

        // Pass 4: inverted / challenging codes on fast 900px buffer
        await yieldCpu();
        qrUrl = await runDecode(small, 'attemptBoth');
        if (qrUrl) return qrUrl;

        // Pass 5 (extreme last resort): full base buffer without inverted double-scan
        if (baseInfo.width > 900 || baseInfo.height > 900) {
            await yieldCpu();
            return await runDecode(baseBuffer, 'dontInvert');
        }

        return null;
    } catch (e) {
        return null;
    }
};
