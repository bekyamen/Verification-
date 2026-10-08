import axios from 'axios';
import logger from '../utils/logger';

export interface TelebirrReceipt {
    payerName: string;
    payerTelebirrNo: string;
    creditedPartyName: string;
    creditedPartyAccountNo: string;
    transactionStatus: string;
    receiptNo: string;
    paymentDate: string;
    settledAmount: string;
    serviceFee: string;
    serviceFeeVAT: string;
    totalPaidAmount: string;
    bankName: string;
    customerNote: string;
}

export async function verifyTelebirr(reference: string): Promise<TelebirrReceipt | null> {
    const apiKey = process.env.CHECK_API_KEY;
    if (!apiKey) {
        logger.error('Missing CHECK_API_KEY environment variable');
        return null;
    }

    try {
        const payload: any = {};

        // Handle receipt URL scenario
        if (reference.startsWith('http://') || reference.startsWith('https://')) {
            payload.receipt_url = reference.trim();
        } else {
            payload.bank = 'telebirr';
            payload.transaction_number = reference.trim();
        }

        let response: any;
        let attempts = 0;
        const maxRetries = 2;

        while (attempts < maxRetries) {
            try {
                attempts++;
                logger.info(`🔎 Forwarding Telebirr verification to api.check.et (Attempt ${attempts}): ${reference}`);
                
                response = await axios.post('https://api.check.et/api/v1/verify', payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    timeout: 45000 // Increased timeout to 45 seconds
                });
                break; // Break the loop on success
            } catch (error: any) {
                const isTimeoutOrNetworkError = error.code === 'ECONNABORTED' || !error.response;
                if (attempts >= maxRetries || !isTimeoutOrNetworkError) {
                    throw error; // If it's a hard error like 404 or max retries reached, fail
                }
                logger.warn(`⚠️ api.check.et timed out. Retrying attempt ${attempts} for ${reference}...`);
            }
        }

        const data = response.data;
        const resData = data.data || data;

        // Ensure we properly map the standard API response back to TelebirrReceipt format
        // so that the VerificationEngine continues to work without massive rewrites.
        
        const mappedAmount = (resData.amount !== undefined) 
            ? String(resData.amount) 
            : String(resData.settledAmount || '0');

        return {
            payerName: resData.payerName || resData.payer_name || resData.payer || "",
            payerTelebirrNo: resData.payerTelebirrNo || resData.payer_account || "",
            creditedPartyName: resData.receiverName || resData.receiver_name || resData.receiver || "",
            creditedPartyAccountNo: resData.receiverAccount || resData.receiver_account || resData.account_number || "",
            transactionStatus: resData.transactionStatus || resData.status || "Completed",
            receiptNo: resData.transaction_number || resData.reference || resData.receiptNo || payload.transaction_number || "",
            paymentDate: resData.date || resData.paymentDate || new Date().toISOString(),
            settledAmount: mappedAmount,
            serviceFee: resData.serviceFee || "",
            serviceFeeVAT: resData.serviceFeeVAT || "",
            totalPaidAmount: resData.totalPaidAmount || resData.totalAmount || "",
            bankName: resData.bankName || "Telebirr",
            customerNote: resData.reason || resData.customerNote || ""
        };
    } catch (error: any) {
        const errMsg = error.response?.data?.error || error.response?.data?.message || error.message;
        const statusCode = error.response?.status;
        logger.warn(`⚠️ api.check.et Telebirr verification failed: ${errMsg}`);
        
        const customError = new Error(errMsg);
        customError.name = 'TelebirrVerificationError';
        (customError as any).statusCode = statusCode;
        (customError as any).details = error.response?.data;
        throw customError;
    }
}

export async function probeTelebirrProxyPool(reference: string, env: NodeJS.ProcessEnv) {
    return {
        activeRouteId: 'api.check.et',
        preferredRouteAvailable: true,
        routes: [{
            id: 'api.check.et',
            label: 'api.check.et',
            role: 'preferred' as const,
            status: 'operational' as const,
            latencyMs: null
        }]
    };
}
