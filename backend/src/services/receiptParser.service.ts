import '../polyfills';
import { createWorker, createScheduler, PSM } from 'tesseract.js';
const pdfParse = require('pdf-parse');
import { ExtractedReceiptData } from '../types';
import os from 'os';
import path from 'path';
import fs from 'fs';

export const parseRawText = (rawText: string): ExtractedReceiptData => {
  const normalizedText = rawText.toUpperCase().replace(/\s+/g, ' ');

  let provider: ExtractedReceiptData['provider'] = 'UNKNOWN';
  let txnReference: string | null = null;
  let amount: number | null = null;

  // Amount extraction helper
  // Handles formats like:
  //   "ETB 6.00", "6.00 ETB", "AMOUNT: 1,500.00"
  //   "-6 . 0 0 (ETB)"  <- Telebirr app receipt (sender view, OCR-spaced digits)
  const extractAmount = (text: string): number | null => {
    // Pre-process: collapse OCR-space-padded decimals like "-6 . 0 0" => "6.00"
    const collapsed = text.replace(/-?\s*(\d[\d\s,]*)\s*\.\s*([\d\s]+)/g, (_m, intPart, decPart) => {
      return intPart.replace(/[\s,]/g, '') + '.' + decPart.replace(/\s/g, '');
    });

    // Keyword-anchored patterns - also match "(ETB)" with optional parens
    const anchored =
      collapsed.match(/(?:ETB|BIRR|AMOUNT|PAID)[:\s)]*(-?[\d,]+(?:\.\d{1,2})?)/i) ||
      collapsed.match(/(-?[\d,]+(?:\.\d{1,2})?)\s*[\[(]?\s*(?:ETB|BIRR)\s*[\])]?/i);
    if (anchored && anchored[1]) {
      const n = parseFloat(anchored[1].replace(/,/g, ''));
      if (!isNaN(n)) return Math.abs(n); // always positive (sender view is negative)
    }

    // Fallback: any properly-formatted decimal number
    const fallbackMatch = collapsed.match(/\b(\d{1,3}(?:,\d{3})*(?:\.\d{2}))\b/);
    if (fallbackMatch && fallbackMatch[1]) {
      return Math.abs(parseFloat(fallbackMatch[1].replace(/,/g, '')));
    }
    return null;
  };

  // Heuristics for CBE
  if (normalizedText.includes('CBE') || normalizedText.includes('COMMERCIAL BANK') || normalizedText.includes('FT')) {
    provider = 'CBE';
    // 1. Standard FT reference (8-14 alphanumeric characters)
    const cbeRefMatch = normalizedText.match(/\b(FT[A-Z0-9]{8,14})\b/);
    if (cbeRefMatch) {
      txnReference = cbeRefMatch[1];
    } else {
      // 2. Labeled: e.g. "TXN ID: FT26286ZF0XC" or "REFERENCE: FT..."
      const labeledMatch = normalizedText.match(/(?:TXN|TRANS|REF|TRANSACTION|REFERENCE)(?:\s*(?:ID|NO|NUMBER))?[:\s]+(FT[A-Z0-9]{8,14})\b/);
      if (labeledMatch) {
        txnReference = labeledMatch[1];
      } else {
        // 3. Spaced FT due to OCR: "FT 26286ZF0XC"
        const spacedMatch = normalizedText.match(/\bFT\s+([A-Z0-9]{8,14})\b/);
        if (spacedMatch) {
          txnReference = 'FT' + spacedMatch[1];
        } else {
          // 4. Glitch: F7 / FI / PT
          const altMatch = normalizedText.match(/\b(F[T|7|I|1][A-Z0-9]{8,14})\b/);
          if (altMatch) txnReference = 'FT' + altMatch[1].slice(2);
        }
      }
    }
    amount = extractAmount(normalizedText); 
  } 
  
  // Heuristics for Telebirr
  else if (
    normalizedText.includes('TELEBIRR') || 
    normalizedText.includes('ETHIO TELECOM') ||
    normalizedText.includes('TRANSACTION NUMBER') ||
    normalizedText.includes('TRANSACTION TO') ||
    normalizedText.includes('TRANSFER MONEY')
  ) {
    provider = 'TELEBIRR';
    // 1. Labeled transaction number
    const telebirrLabelMatch = normalizedText.match(/(?:TRANSACTION|TXN)\s*(?:NUMB(?:ER)?|NO|ID)?[:\s.]+([A-Z0-9]{8,18})/);
    if (telebirrLabelMatch) {
      txnReference = telebirrLabelMatch[1];
    } else {
      const telebirrMatch = normalizedText.match(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{10,14}\b/);
      if (telebirrMatch) {
        txnReference = telebirrMatch[0];
      }
    }
    amount = extractAmount(normalizedText);
  }

  // Final sanitization
  return {
    provider,
    txnReference: txnReference || null,
    amount: amount || null,
    rawText
  };
};

let scheduler: any = null;
let initPromise: Promise<void> | null = null;

const cpuCount = os.cpus()?.length || 1;
const DEFAULT_WORKERS = cpuCount > 1 ? 2 : 1;
const WORKER_COUNT = process.env.OCR_WORKERS ? parseInt(process.env.OCR_WORKERS, 10) || DEFAULT_WORKERS : DEFAULT_WORKERS;

/** Locate local eng.traineddata to avoid CDN network overhead and latency */
function getLocalTessdataDir(): string | null {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), 'backend'),
    path.resolve(__dirname, '../../'),
    path.resolve(__dirname, '../..'),
    path.resolve(__dirname, '..'),
    '/app',
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'eng.traineddata'))) {
      return dir;
    }
  }
  return null;
}

/**
 * Initialize Tesseract scheduler with worker pool.
 * Does not keep a rejected promise on failure so subsequent requests can retry.
 */
async function initOcrScheduler(): Promise<void> {
  if (scheduler && scheduler.getNumWorkers() > 0) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const newScheduler = createScheduler();
      const localDir = getLocalTessdataDir();
      const workerOptions: any = { gzip: false };
      if (localDir) {
        workerOptions.langPath = localDir;
      }

      for (let i = 0; i < WORKER_COUNT; i++) {
        const worker = await createWorker('eng', 1, workerOptions);
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
        });
        newScheduler.addWorker(worker);
      }
      scheduler = newScheduler;
    } catch (err) {
      // Reset so next caller can attempt initialization again
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

/**
 * Pre-warm the Tesseract scheduler workers on server startup.
 */
export function warmOcrWorkers(): void {
  initOcrScheduler().catch((err) => {
    console.warn('[OCR] Worker pre-warm failed:', err?.message ?? err);
  });
}

export const warmOcr = () => initOcrScheduler().catch(() => undefined);

/**
 * Pre-process an image buffer with sharp:
 *  - Auto-rotate (EXIF)
 *  - Resize to targetWidth (preserving aspect ratio)
 *  - Convert to grayscale
 *  - Normalize contrast
 *  - Fast PNG compression (level 1)
 */
async function preprocessImage(buf: Buffer, targetWidth: number): Promise<Buffer> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharpMod = require('sharp');
    const sharpFn: (input: Buffer) => any = sharpMod.default ?? sharpMod;
    return await sharpFn(buf)
      .rotate()
      .resize({ width: targetWidth, withoutEnlargement: true })
      .grayscale()
      .normalize()
      .jpeg({ quality: 85 })
      .toBuffer() as Buffer;
  } catch {
    return buf;
  }
}

/** Run an OCR job requesting only plain text */
async function runOcrJob(imgBuf: Buffer): Promise<string> {
  await initOcrScheduler();
  const res = await scheduler.addJob(
    'recognize',
    imgBuf,
    {},
    { text: true, hocr: false, tsv: false, box: false }
  );
  return res?.data?.text ?? '';
}

export const parseFileBuffer = async (fileBuffer: Buffer, mimetype: string): Promise<ExtractedReceiptData> => {
  if (mimetype === 'application/pdf') {
    try {
      const pdfData = await pdfParse(fileBuffer);
      if (!pdfData.text || pdfData.text.trim().length === 0) {
        throw new Error("PDF parsing yielded empty text");
      }
      return parseRawText(pdfData.text);
    } catch (error) {
      throw new Error(`Failed to parse PDF: ${error instanceof Error ? error.message : 'Unknown PDF error'}`);
    }
  }

  // Two-tier Image OCR
  try {
    // Tier 1: 1000px fast scan
    const tier1Buf = await preprocessImage(fileBuffer, 1000);
    const text1 = await runOcrJob(tier1Buf);
    let parsed = parseRawText(text1);

    // Tier 2: 1500px detailed scan only if no txnReference found
    if (!parsed.txnReference) {
      const tier2Buf = await preprocessImage(fileBuffer, 1500);
      const text2 = await runOcrJob(tier2Buf);
      if (text2 && text2.trim().length > 0) {
        const parsed2 = parseRawText(text2);
        if (parsed2.txnReference || !parsed.provider || parsed.provider === 'UNKNOWN') {
          parsed = parsed2;
        }
      }
    }

    if (!parsed.rawText || parsed.rawText.trim().length === 0) {
      throw new Error("OCR yielded empty text");
    }

    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse image: ${error instanceof Error ? error.message : 'Unknown OCR error'}`);
  }
};

export const scrapeURLSession = async (url: string): Promise<ExtractedReceiptData> => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch URL, status: ${response.status}`);
    }
    const htmlText = await response.text();
    // Simple HTML strip -> extract raw text
    const cleanText = htmlText.replace(/<[^>]*>?/gm, ' ');
    return parseRawText(cleanText);
  } catch (error) {
    throw new Error(`Failed to scrape URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};
