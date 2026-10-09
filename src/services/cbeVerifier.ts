import { ProviderVerifier, VerificationRequest, ProviderVerificationResult } from './verificationEngine';
import { verifyCBE } from './verifyCBE';
import { routeCbe } from './cbeRoute';

export class CbeVerifier implements ProviderVerifier {
    async verify(payload: VerificationRequest): Promise<ProviderVerificationResult> {
        const routeResult = routeCbe(payload);

        if (routeResult.route === 'NEEDS_INPUT' || routeResult.route === 'NEEDS_ACCOUNT') {
            return {
                status: 'INVALID_RECEIPT',
                amountExtracted: payload.amount || 0,
                message: routeResult.message || 'Invalid CBE reference format.',
            };
        }

        const registeredAccounts = payload.registeredAccounts || [];
        if (registeredAccounts.length === 0) {
            return {
                status: 'INVALID_RECEIPT',
                amountExtracted: 0,
                message: 'No registered CBE accounts found for this organization. Cannot verify.'
            };
        }

        let fallbackRef = payload.txnReference;
        if (payload.rawText && routeResult.route === 'RECEIPT_TOKEN') {
            const ftMatch = payload.rawText.match(/\b(FT[A-Z0-9]{8,14})\b/i);
            if (ftMatch) {
                fallbackRef = ftMatch[1].toUpperCase();
            }
        }

        let lastError = 'Failed to verify CBE receipt against registered accounts.';
        let lastStatusCode = 400;

        // Try the original reference first (RECEIPT_TOKEN or FT). If RECEIPT_TOKEN fails requiring account,
        // we'll loop through registered accounts using the fallback FT reference.
        // Actually, let's just attempt verification for each registered account on the original reference, 
        // and if it asks for an account, switch to fallbackRef and try all registered accounts again.

        for (const account of registeredAccounts) {
            const accountDigits = account.accountNumber.replace(/[^0-9]/g, '');
            try {
                let res = await verifyCBE(payload.txnReference, accountDigits);
                
                // If upstream requires 13-digit receiver and we used a URL token, retry with FT fallback
                if (!res.success && res.statusCode === 400 && 
                    (res.error?.includes('13-digit') || res.error?.includes('8-digit') || res.error?.includes('receiving account')) && 
                    routeResult.route === 'RECEIPT_TOKEN' && fallbackRef !== payload.txnReference) {
                    res = await verifyCBE(fallbackRef, accountDigits);
                }

                if (res.success) {
                    const receiverAccount = res.receiverAccount || '';
                    const escapedReceiver = receiverAccount.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
                    const maskRegex = new RegExp(`^${escapedReceiver.replace(/\*/g, '.*')}$`, 'i');

                    if (!receiverAccount.includes(accountDigits) && !accountDigits.includes(receiverAccount) && !maskRegex.test(accountDigits)) {
                        return {
                            status: 'INVALID_RECEIPT',
                            amountExtracted: 0,
                            message: `Receiver account mismatch. Expected ${account.accountNumber} but got ${res.receiverAccount}`
                        };
                    }

                    // Name check warning
                    let warningMessage: string | undefined;
                    const rName = res.receiver?.toUpperCase() || '';
                    const aName = account.accountHolderName.toUpperCase();
                    // Fuzzy check: if splitting by space, do they share a prominent word?
                    const rWords = rName.split(/\s+/).filter(w => w.length > 2);
                    const aWords = aName.split(/\s+/).filter(w => w.length > 2);
                    const sharesName = rWords.some(w => aWords.includes(w)) || aWords.some(w => rWords.includes(w));
                    
                    if (!sharesName && rName && aName) {
                        warningMessage = `Warning: Receiver name on receipt (${res.receiver}) does not closely match registered account holder (${account.accountHolderName}).`;
                    }

                    return {
                        status: 'VERIFIED',
                        amountExtracted: res.amount || payload.amount || 0,
                        payerName: res.payer || undefined,
                        receiverAccount: res.receiverAccount || undefined,
                        date: res.date || undefined,
                        reference: res.reference || (fallbackRef !== payload.txnReference && res.reference === undefined ? fallbackRef : payload.txnReference),
                        message: warningMessage
                    };
                }
                
                lastError = res.error || lastError;
                lastStatusCode = res.statusCode || 400;

                if (res.statusCode === 404) {
                    // Quick fail for "not found" instead of spamming CBE api for all accounts if the reference itself is fake.
                    return { status: 'INVALID_RECEIPT', amountExtracted: 0, message: res.error };
                }

            } catch (e: any) {
                lastError = e.message;
            }
        }

        if (lastStatusCode === 400 || lastStatusCode === 404) {
             return { status: 'INVALID_RECEIPT', amountExtracted: 0, message: lastError };
        }
        return { status: 'FAILED_UPSTREAM', amountExtracted: 0, message: lastError };
    }
}
