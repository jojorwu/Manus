// utils/localization.js
const fs = require('fs').promises;
const path = require('path');
const osLocale = require('os-locale');

let translations = {};
let currentLocale = 'en'; // Default locale

async function initializeLocalization() {
    console.log("Localization: Initializing with os-locale..."); // Non-localized initial log

    try {
        // Use the imported os-locale
        currentLocale = await osLocale(); // os-locale@4 returns a Promise
        if (!currentLocale) { // Handle cases where osLocale might return null/undefined
            console.warn("Localization: os-locale did not return a locale. Falling back to LANG or default 'en'.");
            currentLocale = process.env.LANG ? process.env.LANG.split('.')[0] : 'en';
        }
    } catch (error) {
        // Log a non-localized warning if os-locale fails
        console.warn(`Localization: Could not get system locale with os-locale. Falling back to LANG or default "en". Error: ${error.message}`);
        currentLocale = process.env.LANG ? process.env.LANG.split('.')[0] : 'en';
    }

    // Sanitize locale to prevent path traversal or unexpected characters
    currentLocale = (currentLocale.split('_')[0] || 'en').replace(/[^a-zA-Z-]/g, '').substring(0, 5);
    if (!currentLocale) currentLocale = 'en'; // Fallback if sanitization results in empty string

    console.log(`Localization: Using locale '${currentLocale}'.`); // Non-localized

    await loadTranslations(currentLocale);

    // eslint-disable-next-line security/detect-object-injection -- currentLocale is sanitized.
    if (!translations[currentLocale] && currentLocale !== 'en') {
        console.warn(`Localization: No translations found for detected locale '${currentLocale}'. Falling back to 'en'.`); // Non-localized
        currentLocale = 'en'; // Fallback to English
        await loadTranslations(currentLocale);
    }

    // eslint-disable-next-line security/detect-object-injection -- currentLocale is sanitized.
    if (!translations[currentLocale]) { // Specifically check if 'en' (or fallback) failed
         console.error("Localization: Default 'en' translations could not be loaded. Logging will be non-localized."); // Non-localized
         // eslint-disable-next-line security/detect-object-injection -- currentLocale is sanitized.
         translations[currentLocale] = {}; // Ensure it's an object to prevent errors in t()
    }
}

async function loadTranslations(locale) {
    try {
        const filePath = path.join(__dirname, '..', 'locales', `${locale}.json`);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- locale component is sanitized in initializeLocalization.
        const data = await fs.readFile(filePath, 'utf8');
        // eslint-disable-next-line security/detect-object-injection -- locale is a sanitized string.
        translations[locale] = JSON.parse(data);
    } catch (error) {
        // This log might appear if a locale file is missing (e.g. fr.json)
        // It will be followed by a fallback message if currentLocale's translations aren't loaded.
        // If it's 'en.json' that fails, a more severe non-localized error is logged by initializeLocalization.
        console.warn(`Localization: Failed to load translations for locale ${locale}: ${error}`); // Non-localized
        // eslint-disable-next-line security/detect-object-injection -- locale is a sanitized string.
        translations[locale] = null; // Mark as failed to load
    }
}

function t(key, args) {
    // eslint-disable-next-line security/detect-object-injection -- currentLocale is sanitized; 'en' is a string literal.
    const langSpecificTranslations = translations[currentLocale] || translations['en'] || {};
    let message = key; // Default to key
    if (Object.prototype.hasOwnProperty.call(langSpecificTranslations, key)) {
        // eslint-disable-next-line security/detect-object-injection -- key is a developer-provided string literal. langSpecificTranslations is from a controlled source.
        message = langSpecificTranslations[key];
    } else {
        // Optional: Log if key is not found in either current locale or fallback 'en'
        // if (!translations['en'] || !Object.prototype.hasOwnProperty.call(translations['en'], key)) {
        //     console.warn(`Localization: Translation key "${key}" not found.`);
        // }
    }

    if (typeof args === 'string') { // Simple case: t('KEY', 'ComponentName')
        message = message.replace(/{componentName}/g, args);
    } else if (typeof args === 'object' && args !== null) {
        for (const argKey in args) {
            // Security: Ensure only own properties of args are used for replacement.
            if (Object.prototype.hasOwnProperty.call(args, argKey)) {
                // Security: Sanitize argKey for use in RegExp if it could contain special characters.
                // However, typically argKey is a known, safe placeholder name from the code.
                // If argKey could come from untrusted input, it would need sanitization.
                const sanitizedArgKey = escapeRegExp(argKey); // Use the new escape function
                const placeholder = new RegExp(`{${sanitizedArgKey}}`, 'g'); // eslint-disable-line security/detect-non-literal-regexp
                // eslint-disable-next-line security/detect-object-injection -- 'argKey' is from 'args' object, existence checked by hasOwnProperty. Value used for string replacement.
                message = message.replace(placeholder, String(args[argKey]));
            }
        }
        // If componentName is a common replacement and not explicitly in args, try to replace it
        if (!Object.prototype.hasOwnProperty.call(args, 'componentName') && message.includes('{componentName}')) {
             message = message.replace(/{componentName}/g, ''); // Or some default like 'System'
        }
    }
     // Ensure all placeholders are removed, even if no arg provided for them
    message = message.replace(/{[a-zA-Z0-9_]+}/g, '');


    return message;
}

// Security: Function to escape characters for use in regular expressions.
function escapeRegExp(string) {
    if (typeof string !== 'string') return '';
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

module.exports = {
    initializeLocalization,
    t,
    // For testing or specific needs, though not used by t() directly after init
    getCurrentLocale: () => currentLocale,
    escapeRegExp
};
