import { NormalizedPayload } from './linkDissector';

export type CbeRouteAction = 'RECEIPT_TOKEN' | 'REFERENCE_AND_ACCOUNT' | 'NEEDS_ACCOUNT' | 'NEEDS_INPUT';

export function routeCbe(payload: NormalizedPayload): { route: CbeRouteAction, message?: string } {
    const { txnReference, receivingAccount } = payload;

    if (!txnReference) {
        return { route: 'NEEDS_INPUT', message: 'Could not detect a valid CBE QR code or transaction reference. Please provide a clearer image or enter manually.' };
    }

    const isUrl = txnReference.startsWith('http://') || txnReference.startsWith('https://');
    const isTokenPattern = txnReference.length > 20 && !txnReference.toUpperCase().startsWith('FT');
    
    if (isUrl || isTokenPattern) {
        return { route: 'RECEIPT_TOKEN' };
    }

    const upperRef = txnReference.toUpperCase();
    if (upperRef.startsWith('FT')) {
        return { route: 'REFERENCE_AND_ACCOUNT' };
    }

    // Invalid format, frontend won't supply manual info anymore.
    return { route: 'NEEDS_INPUT', message: 'Could not detect a valid CBE QR code or transaction reference.' };
}
