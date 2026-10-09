import jsQR from 'jsqr';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import sharp from 'sharp';

const execAsync = util.promisify(exec);

const ALLOWED_HOSTS = [
    'mbreciept.cbe.com.et',
    'mbreceipt.cbe.com.et',
    'apps.cbe.com.et',
    'telebirr'
];

function isWhitelisted(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    return ALLOWED_HOSTS.some(host => lowerUrl.includes(host));
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

        const runDecode = async (imgBuffer: Buffer): Promise<string | null> => {
            const { data, info } = await sharp(imgBuffer).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
            const clampedArray = new Uint8ClampedArray(data.buffer);
            const code = jsQR(clampedArray, info.width, info.height, {
                inversionAttempts: "attemptBoth"
            });
            if (code && code.data && isWhitelisted(code.data)) {
                return code.data;
            }
            return null;
        };

        // Pass 1: Original
        let qrUrl = await runDecode(imageBuffer);
        if (qrUrl) return qrUrl;

        // Pass 2: Grayscale + Contrast
        const img = sharp(imageBuffer);
        const pass2 = await img.clone().grayscale().linear(1.5, -0.2).toBuffer();
        qrUrl = await runDecode(pass2);
        if (qrUrl) return qrUrl;

        // Pass 3: Scaled down
        const metadata = await img.metadata();
        if (metadata.width && metadata.width > 800) {
            const pass3a = await img.clone().resize({ width: 800 }).toBuffer();
            qrUrl = await runDecode(pass3a);
            if (qrUrl) return qrUrl;
        }
        if (metadata.height && metadata.height > 800) {
            const pass3b = await img.clone().resize({ height: 800 }).toBuffer();
            qrUrl = await runDecode(pass3b);
            if (qrUrl) return qrUrl;
        }

        // Pass 4: Crop bottom section
        if (metadata.width && metadata.height && metadata.height > metadata.width * 1.2) {
            const bottomHalfHeight = Math.floor(metadata.height / 2);
            const pass4a = await img.clone().extract({ left: 0, top: bottomHalfHeight, width: metadata.width, height: bottomHalfHeight }).toBuffer();
            qrUrl = await runDecode(pass4a);
            if (qrUrl) return qrUrl;
            
            const bottomQuarterHeight = Math.floor(metadata.height * 0.25);
            const pass4b = await img.clone().extract({ left: 0, top: metadata.height - bottomQuarterHeight, width: metadata.width, height: bottomQuarterHeight }).toBuffer();
            qrUrl = await runDecode(pass4b);
            if (qrUrl) return qrUrl;
        }

        return null;
    } catch (e) {
        return null; 
    }
};
