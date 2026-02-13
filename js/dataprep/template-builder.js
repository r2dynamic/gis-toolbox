/**
 * Template Builder — advanced concat with placeholders, cleanup, live preview
 */
import logger from '../core/logger.js';

/**
 * Apply a template with {FieldName} placeholders to all features
 */
export function applyTemplate(features, template, outputField, options = {}) {
    const {
        trimWhitespace = true,
        collapseSpaces = true,
        skipEmptyFields = false,
        removeEmptyWrappers = true,
        removeDanglingSeparators = true,
        collapseSeparators = true
    } = options;

    logger.info('TemplateBuilder', 'Apply template', { template, outputField, featureCount: features.length });

    // Extract referenced field names
    const fieldRefs = extractFieldRefs(template);

    return features.map(f => {
        const props = { ...f.properties };
        let result = template;

        for (const fieldName of fieldRefs) {
            const val = props[fieldName];
            const replacement = (val == null || val === '') ? '' : String(val);
            result = result.split(`{${fieldName}}`).join(replacement);
        }

        // Cleanup
        result = cleanupResult(result, {
            trimWhitespace,
            collapseSpaces,
            removeEmptyWrappers,
            removeDanglingSeparators,
            collapseSeparators
        });

        props[outputField] = result;
        return { ...f, properties: props };
    });
}

/**
 * Preview template for a few sample rows
 */
export function previewTemplate(features, template, options = {}) {
    const sample = features.slice(0, 5);
    return sample.map(f => {
        let result = template;
        const fieldRefs = extractFieldRefs(template);
        for (const fieldName of fieldRefs) {
            const val = f.properties?.[fieldName];
            result = result.split(`{${fieldName}}`).join(val == null ? '' : String(val));
        }
        return cleanupResult(result, options);
    });
}

/**
 * Conditional wrapper — wraps field value with prefix/suffix only if non-empty
 */
export function conditionalWrap(value, prefix = '', suffix = '') {
    if (value == null || value === '') return '';
    return prefix + value + suffix;
}

function extractFieldRefs(template) {
    const regex = /\{([^}]+)\}/g;
    const fields = new Set();
    let match;
    while ((match = regex.exec(template)) !== null) {
        fields.add(match[1]);
    }
    return [...fields];
}

function cleanupResult(text, options = {}) {
    let result = text;

    // Remove empty wrappers like () [] {}
    if (options.removeEmptyWrappers) {
        result = result.replace(/\(\s*\)/g, '');
        result = result.replace(/\[\s*\]/g, '');
        result = result.replace(/\{\s*\}/g, '');
    }

    // Collapse repeated separators
    if (options.collapseSeparators) {
        result = result.replace(/([\s,\-\/|@;:])\1+/g, '$1');
    }

    // Remove dangling separators at start/end
    if (options.removeDanglingSeparators) {
        result = result.replace(/^[\s,\-\/|@;:]+/, '');
        result = result.replace(/[\s,\-\/|@;:]+$/, '');
    }

    // Collapse spaces
    if (options.collapseSpaces) {
        result = result.replace(/\s{2,}/g, ' ');
    }

    // Trim
    if (options.trimWhitespace) {
        result = result.trim();
    }

    return result;
}

export function getTemplateFields(template) {
    return extractFieldRefs(template);
}

export default { applyTemplate, previewTemplate, conditionalWrap, getTemplateFields };
