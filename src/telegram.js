'use strict';
function telegramClient(token) {
    return async (method, body) => {
        const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(method === 'answerPreCheckoutQuery' ? 4000 : 20000)
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
            const error = new Error('Telegram request failed');
            error.code = data.error_code;
            error.retryAfter = data.parameters?.retry_after;
            throw error;
        }
        return data.result;
    };
}
module.exports = { telegramClient };
