import { createWorker } from 'tesseract.js';
const pdfParse = require('pdf-parse');
import { ExtractedReceiptData } from '../types';

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
    provider = normalizedText.includes('MOBILE') ? 'CBE' : 'CBE'; // Kept ternary just in case to avoid messing up logic, or just simplify to 'CBE'
    // CBE transaction refs usually start with FT followed by 8-12 alphanumeric characters
    // Or sometimes just digits in USSD
    const cbeRefMatch = normalizedText.match(/\b(FT[A-Z0-9]{8,12})\b/);
    if (cbeRefMatch) {
      txnReference = cbeRefMatch[1];
    } else {
      // Fallback for missing FT due to OCR glitch
      const cbeAltMatch = normalizedText.match(/\b(F[T|7][A-Z0-9]{8,12})\b/);
      if (cbeAltMatch) txnReference = cbeAltMatch[1].replace('F7', 'FT');
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
    // Telebirr transaction IDs are 10-12 alphanumeric characters (MUST contain both letters and digits)
    // Prefer the one near a label like 'Transaction Numb' or 'Transaction Number'
    const telebirrLabelMatch = normalizedText.match(/TRANSACTION\s+(?:NUMB(?:ER)?|NO|ID)\s*:?\s*([A-Z0-9]{8,15})/);
    if (telebirrLabelMatch) {
      txnReference = telebirrLabelMatch[1];
    } else {
      const telebirrMatch = normalizedText.match(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{10,12}\b/);
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

let workerPool: any[] = [];
let workerIndex = 0;
let poolInitPromise: Promise<void> | null = null;

const POOL_SIZE = 2;

/**
 * Pre-warm the Tesseract worker pool on first call.
 * Uses a single promise so concurrent early callers don't create extra workers.
 */
async function ensureWorkerPool(): Promise<void> {
  if (workerPool.length === POOL_SIZE) return;
  if (!poolInitPromise) {
    poolInitPromise = (async () => {
      for (let i = workerPool.length; i < POOL_SIZE; i++) {
        const w = await createWorker('eng');
        workerPool.push(w);
      }
    })();
  }
  return poolInitPromise;
}

/**
 * Call once at server startup to boot Tesseract workers in the background.
 * This ensures the first image request doesn't wait for worker initialisation.
 */
export function warmOcrWorkers(): void {
  ensureWorkerPool().catch((err) => {
    console.warn('[OCR] Worker pre-warm failed:', err?.message ?? err);
  });
}

export const warmOcr = () => ensureWorkerPool().catch(() => undefined);

/** Round-robin worker selection. Both workers are always kept alive. */
async function getWorker(): Promise<any> {
  await ensureWorkerPool();
  const w = workerPool[workerIndex % POOL_SIZE];
  workerIndex++;
  return w;
}

/**
 * Pre-process an image buffer with sharp before handing it to Tesseract:
 *  - Resize to ≤ 1000 px wide (preserves aspect ratio)
 *  - Convert to grayscale
 * This typically halves OCR time compared to a full-size colour image.
 * Falls back to the original buffer if sharp fails.
 */
async function preprocessImage(buf: Buffer): Promise<Buffer> {
  try {
    // sharp's CJS interop: the callable is at module.default or the module itself
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharpMod = require('sharp');
    const sharpFn: (input: Buffer) => any = sharpMod.default ?? sharpMod;
    return await sharpFn(buf)
      .resize({ width: 1000, withoutEnlargement: true })
      .grayscale()
      .png()
      .toBuffer() as Buffer;
  } catch {
    return buf; // sharp failed — use original
  }
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

  // Fallback to Image OCR
  try {
    // Pre-process: resize + grayscale to speed up Tesseract
    const processedBuf = await preprocessImage(fileBuffer);
    const worker = await getWorker();
    const { data: { text } } = await worker.recognize(processedBuf);
    
    const combinedText = text;
    if (!combinedText || combinedText.trim().length === 0) {
      throw new Error("OCR yielded empty text");
    }

    return parseRawText(combinedText);
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
