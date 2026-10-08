import axios from 'axios';
import logger from '../utils/logger';

export interface VerifyResult {
    success: boolean;
    payer?: string;
    payerAccount?: string;
    receiver?: string;
    receiverAccount?: string;
    amount?: number;
    date?: Date;
    reference?: string;
    reason?: string | null;
    error?: string;
    statusCode?: number;
}

export async function verifyCBE(reference: string, accountSuffix?: string): Promise<VerifyResult> {
    const apiKey = process.env.CHECK_API_KEY;
    if (!apiKey) {
        logger.error('Missing CHECK_API_KEY environment variable');
        return { success: false, error: 'Internal Server Error: Missing Check.et API Key' };
    }

    try {
        const payload: any = { bank: 'cbe' };
        
        // Handle receipt URL scenario
        if (reference.startsWith('http://') || reference.startsWith('https://')) {
            payload.receipt_url = reference.trim();
        } else {
            payload.transaction_number = reference.trim();
            if (accountSuffix) {
                payload.account_number = accountSuffix.trim();
            }
        }

        logger.info(`🔎 Forwarding CBE verification to api.check.et: ${reference}`);

        const response = await axios.post('https://api.check.et/api/v1/verify', payload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            timeout: 30000
        });
        
        const data = response.data;
        const resData = data.data || data; // Handle cases where data is wrapped

        let finalAmount;
        if (typeof resData.amount === 'number') {
            finalAmount = resData.amount;
        } else if (typeof resData.settledAmount === 'string') {
            finalAmount = parseFloat(resData.settledAmount.replace(/,/g, ''));
        } else if (typeof resData.amount === 'string') {
            finalAmount = parseFloat(resData.amount.replace(/,/g, ''));
        }
        
        return {
            success: true,
            payer: resData.payerName || resData.payer_name || resData.payer,
            payerAccount: resData.payerAccount || resData.payer_account || resData.sender_account,
            receiver: resData.receiverName || resData.receiver_name || resData.receiver,
            receiverAccount: resData.receiverAccount || resData.receiver_account || resData.account_number,
            amount: finalAmount,
            date: resData.date ? new Date(resData.date) : (resData.paymentDate ? new Date(resData.paymentDate) : new Date()),
            reference: resData.transaction_number || resData.reference || resData.receiptNo || payload.transaction_number,
            reason: resData.reason || resData.customerNote || null
        };
    } catch (error: any) {
        const statusCode = error.response?.status;
        const errMsg = error.response?.data?.error || error.response?.data?.message || error.message;
        
        logger.warn(`⚠️ api.check.et CBE verification failed: ${errMsg}`);
        
        return {
            success: false,
            error: errMsg,
            statusCode: statusCode
        };
    }
}
