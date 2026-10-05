import { createWorker } from 'tesseract.js';
const pdfParse = require('pdf-parse');
import { ExtractedReceiptData } from '../types';
import jsQR from 'jsqr';
const Jimp = require('jimp');

export const parseRawText = (rawText: string): ExtractedReceiptData => {
  const normalizedText = rawText.toUpperCase().replace(/\s+/g, ' ');

  let provider: ExtractedReceiptData['provider'] = 'UNKNOWN';
  let txnReference: string | null = null;
  let amount: number | null = null;

  // Amount extraction helper 
  // Looks for numbers with optional commas and decimals usually clustered near 'ETB' or 'BIRR' or 'AMOUNT'
  const extractAmount = (text: string): number | null => {
    const amountMatch = text.match(/(?:ETB|BIRR|AMOUNT|PAID)[:\s]*([\d,]+(?:\.\d{1,2})?)/i) || text.match(/([\d,]+(?:\.\d{1,2})?)[\s]*(?:ETB|BIRR)/i);
    if (amountMatch && amountMatch[1]) {
      const cleanNumString = amountMatch[1].replace(/,/g, '');
      const parsedAmount = parseFloat(cleanNumString);
      if (!isNaN(parsedAmount)) return parsedAmount;
    }
    // Fallback heuristic for any stray decimal figure that looks like a large total
    const fallbackMatch = text.match(/\b(\d{1,3}(?:,\d{3})*(?:\.\d{2}))\b/);
    if(fallbackMatch && fallbackMatch[1]) {
      return parseFloat(fallbackMatch[1].replace(/,/g, ''));
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
  else if (normalizedText.includes('TELEBIRR') || normalizedText.includes('ETHIO TELECOM')) {
    provider = 'TELEBIRR';
    // Telebirr transaction IDs are strictly 10 alphanumeric characters usually starting with something distinct
    // e.g. "72AB3K9M21"
    const telebirrMatch = normalizedText.match(/\b([A-Z0-9]{10})\b/);
    if (telebirrMatch) {
      txnReference = telebirrMatch[1];
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

  // Fallback to Image OCR + QR Scan
  let worker = null;
  try {
    let qrUrl = '';
    try {
      // Decode with Jimp and extract QR (Multi-pass approach for large/messy screenshots)
      const image = await Jimp.read(fileBuffer);
      
      const tryDecode = (img: any): string | null => {
        const imageData = {
          data: new Uint8ClampedArray(img.bitmap.data),
          width: img.bitmap.width,
          height: img.bitmap.height
        };
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: "attemptBoth"
        });
        return code ? code.data : null;
      };

      // Pass 1: Original
      qrUrl = tryDecode(image) || '';
      
      // Pass 2: Grayscale and Increased Contrast
      if (!qrUrl) {
         qrUrl = tryDecode(image.clone().greyscale().contrast(0.5)) || '';
      }

      // Pass 3: Scaled down (helps jsQR if screenshot is massively taller/wider)
      if (!qrUrl && image.bitmap.width > 800) {
         qrUrl = tryDecode(image.clone().resize(800, Jimp.AUTO)) || '';
      }
      
      if (!qrUrl && image.bitmap.height > 800) {
          qrUrl = tryDecode(image.clone().resize(Jimp.AUTO, 800)) || '';
      }

    } catch (qrErr) {
       // Silently ignore QR errors and continue to OCR
    }

    worker = await createWorker('eng');
    const { data: { text } } = await worker.recognize(fileBuffer);
    await worker.terminate();
    
    // Combine QR data (if any) with OCR text
    const combinedText = qrUrl ? `${qrUrl}\n${text}` : text;
    if (!combinedText || combinedText.trim().length === 0) {
      throw new Error("OCR yielded empty text");
    }

    return parseRawText(combinedText);
  } catch (error) {
    if (worker) {
      try {
        await worker.terminate();
      } catch(e) {}
    }
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
