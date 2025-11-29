const https = require('https');

const UF_API_URL = 'https://mindicador.cl/api/uf';
const RETRY_WINDOW_MS = 12 * 60 * 60 * 1000;

const cache = {
    monthValues: new Map(),
    inflight: null,
    lastFailedAttempt: new Map()
};

const formatMonthKey = dateInput => {
    const date = new Date(dateInput);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid date supplied to UF service: ${dateInput}`);
    }
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${date.getUTCFullYear()}-${month}`;
};

const safeFormatMonthKey = dateInput => {
    try {
        return formatMonthKey(dateInput);
    } catch {
        return formatMonthKey(new Date().toISOString());
    }
};

const requestUfIndicator = () => new Promise((resolve, reject) => {
    const req = https.get(UF_API_URL, res => {
        const { statusCode } = res;
        if (statusCode && statusCode >= 400) {
            res.resume();
            reject(new Error(`UF API responded with status ${statusCode}`));
            return;
        }

        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
            raw += chunk;
        });
        res.on('end', () => {
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(new Error(`UF API returned invalid JSON: ${err.message}`));
            }
        });
    });

    req.on('error', reject);
    req.setTimeout(5000, () => {
        req.destroy(new Error('UF API request timed out'));
    });
});

const refreshCache = async () => {
    if (cache.inflight) {
        return cache.inflight;
    }

    cache.inflight = requestUfIndicator()
        .then(payload => {
            if (!payload || !Array.isArray(payload.serie)) {
                throw new Error('UF API payload missing `serie` array');
            }

            const nextValues = new Map();
            for (const entry of payload.serie) {
                if (!entry || typeof entry.valor !== 'number' || !entry.fecha) {
                    continue;
                }
                const monthKey = formatMonthKey(entry.fecha);
                if (!nextValues.has(monthKey)) {
                    nextValues.set(monthKey, Number(entry.valor));
                }
            }

            if (nextValues.size === 0) {
                throw new Error('UF API payload did not contain numeric entries');
            }

            cache.monthValues = nextValues;
            cache.lastFailedAttempt.clear();
        })
        .finally(() => {
            cache.inflight = null;
        });

    return cache.inflight;
};

const fallbackValue = () => {
    const iterator = cache.monthValues.values().next();
    if (iterator.done) {
        throw new Error('UF value unavailable in cache');
    }
    return iterator.value;
};

const getUfValue = async dateInput => {
    const monthKey = safeFormatMonthKey(dateInput);

    if (cache.monthValues.has(monthKey)) {
        return cache.monthValues.get(monthKey);
    }

    const now = Date.now();
    const lastAttempt = cache.lastFailedAttempt.get(monthKey);
    if (lastAttempt && now - lastAttempt < RETRY_WINDOW_MS) {
        return fallbackValue();
    }

    try {
        await refreshCache();
    } catch (err) {
        cache.lastFailedAttempt.set(monthKey, now);
        throw err;
    }

    if (cache.monthValues.has(monthKey)) {
        return cache.monthValues.get(monthKey);
    }

    cache.lastFailedAttempt.set(monthKey, now);
    return fallbackValue();
};

module.exports = { getUfValue };
