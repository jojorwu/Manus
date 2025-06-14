// utils/localization.js
const fs = require('fs').promises;
const path = require('path');

let translations = {};
let currentLocale = 'en'; // Default locale

// Store os-locale functions if dynamically imported
let osLocaleSyncFunction = null;

async function initializeLocalization() {
    console.log("Localization: Initializing with os-locale..."); // Non-localized initial log

    try {
        // Dynamically import os-locale
        // os-locale uses a default export for its CommonJS version when imported like this.
        const osLocaleModule = await import('os-locale');
        osLocaleSyncFunction = osLocaleModule.osLocaleSync || (osLocaleModule.default ? osLocaleModule.default.osLocaleSync : null);

        if (osLocaleSyncFunction) {
            currentLocale = osLocaleSyncFunction() || 'en';
        } else {
            // Fallback if osLocaleSync is not found on the imported module
            console.warn("Localization: osLocaleSync not found on dynamically imported module. Falling back to LANG or default 'en'.");
            currentLocale = process.env.LANG ? process.env.LANG.split('.')[0] : 'en';
        }
    } catch (error) {
        // Log a non-localized warning if dynamic import fails
        console.warn(`Localization: Could not dynamically import os-locale. Falling back to LANG or default "en". Error: ${error.message}`);
        currentLocale = process.env.LANG ? process.env.LANG.split('.')[0] : 'en';
    }

    currentLocale = currentLocale.split('_')[0]; // Use base language (e.g., 'en' from 'en_US')
    console.log(`Localization: Using locale '${currentLocale}'.`); // Non-localized

    await loadTranslations(currentLocale);

    if (!translations[currentLocale] && currentLocale !== 'en') {
        console.warn(`Localization: No translations found for detected locale '${currentLocale}'. Falling back to 'en'.`); // Non-localized
        currentLocale = 'en'; // Fallback to English
        await loadTranslations(currentLocale);
    }

    if (!translations[currentLocale]) { // Specifically check if 'en' (or fallback) failed
         console.error("Localization: Default 'en' translations could not be loaded. Logging will be non-localized."); // Non-localized
         translations[currentLocale] = {}; // Ensure it's an object to prevent errors in t()
    }
}

async function loadTranslations(locale) {
    try {
        const filePath = path.join(__dirname, '..', 'locales', `${locale}.json`);
        const data = await fs.readFile(filePath, 'utf8');
        translations[locale] = JSON.parse(data);
    } catch (error) {
        // This log might appear if a locale file is missing (e.g. fr.json)
        // It will be followed by a fallback message if currentLocale's translations aren't loaded.
        // If it's 'en.json' that fails, a more severe non-localized error is logged by initializeLocalization.
        console.warn(`Localization: Failed to load translations for locale ${locale}: ${error}`); // Non-localized
        translations[locale] = null; // Mark as failed to load
    }
}

function t(key, args) {
    const langSpecificTranslations = translations[currentLocale] || translations['en'] || {};
    let message = langSpecificTranslations[key] || key; // Fallback to key if not found

    if (typeof args === 'string') { // Simple case: t('KEY', 'ComponentName')
        message = message.replace(/{componentName}/g, args);
    } else if (typeof args === 'object' && args !== null) {
        for (const argKey in args) {
            const placeholder = new RegExp(`{${argKey}}`, 'g');
            message = message.replace(placeholder, String(args[argKey]));
        }
        // If componentName is a common replacement and not explicitly in args, try to replace it
        if (!args.componentName && message.includes('{componentName}')) {
             message = message.replace(/{componentName}/g, ''); // Or some default like 'System'
        }
    }
     // Ensure all placeholders are removed, even if no arg provided for them
    message = message.replace(/{[a-zA-Z0-9_]+}/g, '');


    return message;
}

module.exports = {
    initializeLocalization,
    t,
    // For testing or specific needs, though not used by t() directly after init
    getCurrentLocale: () => currentLocale
};
