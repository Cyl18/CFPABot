/**
 * crypto.js — Simple API key obfuscation using Base64 + XOR with fixed salt.
 * NOT cryptographically secure — intended only to avoid plain-text key storage in cookies.
 * Keys are stored as a JSON dict in cookie "cfpa_keys" (SameSite=Strict, max-age=1yr).
 */
(function () {
    const SALT = 'cfpa-key-v1';
    const COOKIE_NAME = 'cfpa_keys';

    function xorEncode(str, salt) {
        let result = '';
        for (let i = 0; i < str.length; i++) {
            result += String.fromCharCode(str.charCodeAt(i) ^ salt.charCodeAt(i % salt.length));
        }
        return result;
    }

    function encode(plaintext) {
        return btoa(xorEncode(plaintext, SALT));
    }

    function decode(encoded) {
        return xorEncode(atob(encoded), SALT);
    }

    function loadAllKeys() {
        const cookies = document.cookie.split(';');
        for (const c of cookies) {
            const [name, ...rest] = c.trim().split('=');
            if (name === COOKIE_NAME) {
                try { return JSON.parse(decodeURIComponent(rest.join('='))); } catch { return {}; }
            }
        }
        return {};
    }

    function saveAllKeys(keys) {
        const value = encodeURIComponent(JSON.stringify(keys));
        document.cookie = `${COOKIE_NAME}=${value}; SameSite=Strict; Secure; max-age=31536000; path=/`;
    }

    /**
     * Save an API key for a given provider/modelUniqueId.
     * modelUniqueId format: "provider:modelId" — same as ModelSpec.UniqueId.
     */
    window.saveApiKey = function (modelUniqueId, plaintext) {
        const keys = loadAllKeys();
        keys[modelUniqueId] = encode(plaintext);
        saveAllKeys(keys);
    };

    /**
     * Load and decode an API key. Returns null if not found.
     */
    window.loadApiKey = function (modelUniqueId) {
        const keys = loadAllKeys();
        const encoded = keys[modelUniqueId];
        if (!encoded) return null;
        try { return decode(encoded); } catch { return null; }
    };

    /**
     * Remove an API key.
     */
    window.clearApiKey = function (modelUniqueId) {
        const keys = loadAllKeys();
        delete keys[modelUniqueId];
        saveAllKeys(keys);
    };

    /**
     * Build perModelOverrides dict for WS first frame.
     * Returns { "provider:modelId": { apiKey, baseUrl? } } for each model that has a stored key.
     * baseUrlMap: optional dict { "provider:modelId": "http://..." } for custom models.
     */
    window.buildPerModelOverrides = function (modelUniqueIds, baseUrlMap) {
        const overrides = {};
        for (const id of modelUniqueIds) {
            const key = loadApiKey(id);
            if (key) {
                overrides[id] = { apiKey: key };
                const baseUrl = baseUrlMap && baseUrlMap[id];
                if (baseUrl) overrides[id].baseUrl = baseUrl;
            }
        }
        return overrides;
    };

    /**
     * Read the raw encrypted "oauth-token-enc" cookie value (for WS ?token= param).
     */
    window.getAuthCookieRaw = function () {
        const cookies = document.cookie.split(';');
        for (const c of cookies) {
            const [name, ...rest] = c.trim().split('=');
            if (name === 'oauth-token-enc') return rest.join('=');
        }
        return null;
    };
})();
