// src/listener/retry.js
// Reusable Fibonacci backoff retry utility

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function fibAt(n) {
    // 1-indexed Fibonacci: 1, 1, 2, 3, 5, 8, ...
    if (n <= 2) return 1;
    let a = 1, b = 1;
    for (let i = 3; i <= n; i++) {
        const c = a + b;
        a = b;
        b = c;
    }
    return b;
}

/**
 * Execute an async function with Fibonacci backoff retry.
 *
 * @param {function(number): Promise<any>} fn - Function that will be executed. Receives current attempt (1..N).
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=5] - Maximum attempts including the first one.
 * @param {number} [opts.baseDelayMs=200] - Base delay multiplier for Fibonacci value.
 * @param {number} [opts.maxDelayMs=5000] - Max cap for delay per attempt.
 * @param {number} [opts.jitterMs=100] - Random jitter added up to this many ms.
 * @param {function({attempt:number, delay:number, error:Error}):void} [opts.onAttempt] - Observer hook.
 */
async function withFibonacciRetry(fn, opts = {}) {
    const {
        maxAttempts = parseInt(process.env.RETRY_MAX_ATTEMPTS || '5', 10),
        baseDelayMs = parseInt(process.env.RETRY_BASE_DELAY_MS || '200', 10),
        maxDelayMs = parseInt(process.env.RETRY_MAX_DELAY_MS || '5000', 10),
        jitterMs = parseInt(process.env.RETRY_JITTER_MS || '100', 10),
        onAttempt,
    } = opts;

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastError = err;
            if (attempt >= maxAttempts) break;
            const fib = fibAt(attempt);
            let delay = Math.min(baseDelayMs * fib, maxDelayMs);
            if (jitterMs > 0) {
                delay += Math.floor(Math.random() * jitterMs);
            }
            if (typeof onAttempt === 'function') {
                try {
                    onAttempt({ attempt, delay, error: err });
                } catch (hookErr) {
                    console.warn('withFibonacciRetry onAttempt handler threw:', hookErr);
                }
            }
            await sleep(delay);
        }
    }
    throw lastError;
}

module.exports = {
    withFibonacciRetry,
};
