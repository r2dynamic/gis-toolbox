/**
 * Data Prep module — all transformations
 * Each function operates on features[] or rows[] and returns a new copy
 */
import logger from '../core/logger.js';

// ========== 1. Split Column ==========
export function splitColumn(features, fieldName, options = {}) {
    const {
        delimiter = ',',
        trim = true,
        maxParts = 0,  // 0 = unlimited
        outputNames = []
    } = options;

    logger.info('DataPrep', 'Split column', { field: fieldName, delimiter, maxParts });

    return features.map(f => {
        const props = { ...f.properties };
        const val = String(props[fieldName] ?? '');
        let parts = maxParts > 0
            ? val.split(delimiter).slice(0, maxParts)
            : val.split(delimiter);
        if (trim) parts = parts.map(p => p.trim());

        parts.forEach((part, i) => {
            const name = outputNames[i] || `${fieldName}_${i + 1}`;
            props[name] = part;
        });

        return { ...f, properties: props };
    });
}

// ========== 2. Combine Columns ==========
export function combineColumns(features, fieldNames, options = {}) {
    const {
        delimiter = ' ',
        outputField = 'combined',
        skipBlanks = true,
        overwrite = false
    } = options;

    logger.info('DataPrep', 'Combine columns', { fields: fieldNames, delimiter, output: outputField });

    return features.map(f => {
        const props = overwrite ? { ...f.properties } : { ...f.properties };
        let values = fieldNames.map(fn => props[fn]);
        if (skipBlanks) values = values.filter(v => v != null && v !== '');
        props[outputField] = values.join(delimiter);
        return { ...f, properties: props };
    });
}

// ========== 3. Replace / Clean Text ==========
export function replaceText(features, fieldName, options = {}) {
    const {
        find = '',
        replace = '',
        trimWhitespace = false,
        collapseSpaces = false,
        caseTransform = null // 'upper' | 'lower' | 'title'
    } = options;

    logger.info('DataPrep', 'Replace/clean text', { field: fieldName, find, replace });

    return features.map(f => {
        const props = { ...f.properties };
        let val = String(props[fieldName] ?? '');

        if (find) val = val.split(find).join(replace);
        if (trimWhitespace) val = val.trim();
        if (collapseSpaces) val = val.replace(/\s{2,}/g, ' ');
        if (caseTransform === 'upper') val = val.toUpperCase();
        if (caseTransform === 'lower') val = val.toLowerCase();
        if (caseTransform === 'title') val = val.replace(/\b\w/g, c => c.toUpperCase());

        props[fieldName] = val;
        return { ...f, properties: props };
    });
}

// ========== 4. Type Convert ==========
export function typeConvert(features, fieldName, targetType) {
    let failures = 0;

    logger.info('DataPrep', 'Type convert', { field: fieldName, targetType });

    const result = features.map(f => {
        const props = { ...f.properties };
        const val = props[fieldName];

        try {
            switch (targetType) {
                case 'number': {
                    const n = Number(val);
                    if (isNaN(n) && val != null && val !== '') { failures++; break; }
                    props[fieldName] = (val == null || val === '') ? null : n;
                    break;
                }
                case 'string':
                    props[fieldName] = val == null ? null : String(val);
                    break;
                case 'boolean': {
                    const s = String(val).toLowerCase().trim();
                    if (['true', '1', 'yes', 'y'].includes(s)) props[fieldName] = true;
                    else if (['false', '0', 'no', 'n', ''].includes(s) || val == null) props[fieldName] = false;
                    else { failures++; }
                    break;
                }
                case 'date': {
                    if (val == null || val === '') { props[fieldName] = null; break; }
                    const d = new Date(val);
                    if (isNaN(d.getTime())) { failures++; break; }
                    props[fieldName] = d.toISOString();
                    break;
                }
            }
        } catch {
            failures++;
        }

        return { ...f, properties: props };
    });

    logger.info('DataPrep', 'Type convert complete', { failures, total: features.length });
    return { features: result, failures };
}

// ========== 5. Filter Builder ==========
export function applyFilters(features, rules, logic = 'AND') {
    logger.info('DataPrep', 'Apply filters', { rules: rules.length, logic });

    return features.filter(f => {
        const props = f.properties || {};
        const results = rules.map(rule => evaluateRule(props, rule));
        return logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
    });
}

function evaluateRule(props, rule) {
    const val = props[rule.field];
    const target = rule.value;

    switch (rule.operator) {
        case 'equals': return String(val) === String(target);
        case 'not_equals': return String(val) !== String(target);
        case 'contains': return String(val ?? '').toLowerCase().includes(String(target).toLowerCase());
        case 'not_contains': return !String(val ?? '').toLowerCase().includes(String(target).toLowerCase());
        case 'starts_with': return String(val ?? '').toLowerCase().startsWith(String(target).toLowerCase());
        case 'ends_with': return String(val ?? '').toLowerCase().endsWith(String(target).toLowerCase());
        case 'greater_than': return Number(val) > Number(target);
        case 'less_than': return Number(val) < Number(target);
        case 'gte': return Number(val) >= Number(target);
        case 'lte': return Number(val) <= Number(target);
        case 'is_null': return val == null || val === '';
        case 'is_not_null': return val != null && val !== '';
        case 'in': return String(target).split(',').map(s => s.trim()).includes(String(val));
        default: return true;
    }
}

// ========== 6. Deduplicate ==========
export function deduplicate(features, keyFields, keepStrategy = 'first') {
    logger.info('DataPrep', 'Deduplicate', { keyFields, keepStrategy });

    const seen = new Map();
    const result = [];
    const dupeCount = { total: 0 };

    for (const f of features) {
        const key = keyFields.map(k => String(f.properties?.[k] ?? '')).join('||');
        if (seen.has(key)) {
            dupeCount.total++;
            if (keepStrategy === 'last') {
                // Replace
                const idx = seen.get(key);
                result[idx] = f;
            }
            // keep first: skip
        } else {
            seen.set(key, result.length);
            result.push(f);
        }
    }

    logger.info('DataPrep', 'Deduplicate complete', { removed: dupeCount.total, kept: result.length });
    return { features: result, removed: dupeCount.total };
}

// ========== 7. Join ==========
export function joinData(features, tableRows, leftKey, rightKey, fieldsToJoin) {
    logger.info('DataPrep', 'Join', { leftKey, rightKey, fields: fieldsToJoin.length });

    const lookup = new Map();
    for (const row of tableRows) {
        const key = String(row[rightKey] ?? '');
        if (!lookup.has(key)) lookup.set(key, row);
    }

    let matched = 0, unmatched = 0;

    const result = features.map(f => {
        const key = String(f.properties?.[leftKey] ?? '');
        const row = lookup.get(key);
        const props = { ...f.properties };

        if (row) {
            matched++;
            for (const field of fieldsToJoin) {
                props[field] = row[field] ?? null;
            }
        } else {
            unmatched++;
            for (const field of fieldsToJoin) {
                props[field] = null;
            }
        }

        return { ...f, properties: props };
    });

    logger.info('DataPrep', 'Join complete', { matched, unmatched });
    return { features: result, matched, unmatched };
}

// ========== 8. Validation ==========
export function validate(features, rules) {
    logger.info('DataPrep', 'Validate', { rules: rules.length });

    const errors = [];

    features.forEach((f, idx) => {
        const props = f.properties || {};
        for (const rule of rules) {
            const val = props[rule.field];
            let isError = false;
            let message = '';

            switch (rule.type) {
                case 'required':
                    if (val == null || val === '') {
                        isError = true;
                        message = `${rule.field} is required`;
                    }
                    break;
                case 'numeric_range':
                    if (val != null && val !== '') {
                        const n = Number(val);
                        if (isNaN(n) || (rule.min != null && n < rule.min) || (rule.max != null && n > rule.max)) {
                            isError = true;
                            message = `${rule.field}: ${val} outside range [${rule.min ?? '-∞'}, ${rule.max ?? '∞'}]`;
                        }
                    }
                    break;
                case 'allowed_values':
                    if (val != null && val !== '' && !rule.values.includes(String(val))) {
                        isError = true;
                        message = `${rule.field}: "${val}" not in allowed values`;
                    }
                    break;
            }

            if (isError) {
                errors.push({ featureIndex: idx, field: rule.field, rule: rule.type, value: val, message });
            }
        }
    });

    logger.info('DataPrep', 'Validation complete', { errors: errors.length, features: features.length });
    return errors;
}

// ========== 9. Unique ID Generator ==========
export function addUniqueId(features, fieldName = 'uid', method = 'uuid') {
    logger.info('DataPrep', 'Add unique ID', { field: fieldName, method });

    const existingIds = new Set();
    return features.map((f, i) => {
        const props = { ...f.properties };
        let id;
        if (method === 'uuid') {
            id = crypto.randomUUID ? crypto.randomUUID() : generateUUID();
        } else {
            id = `${Date.now()}_${i}`;
        }
        // Ensure uniqueness
        while (existingIds.has(id)) {
            id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        }
        existingIds.add(id);
        props[fieldName] = id;
        return { ...f, properties: props };
    });
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

export const FILTER_OPERATORS = [
    { value: 'equals', label: 'Equals' },
    { value: 'not_equals', label: 'Not equals' },
    { value: 'contains', label: 'Contains' },
    { value: 'not_contains', label: 'Does not contain' },
    { value: 'starts_with', label: 'Starts with' },
    { value: 'ends_with', label: 'Ends with' },
    { value: 'greater_than', label: 'Greater than' },
    { value: 'less_than', label: 'Less than' },
    { value: 'gte', label: '>=' },
    { value: 'lte', label: '<=' },
    { value: 'is_null', label: 'Is empty' },
    { value: 'is_not_null', label: 'Is not empty' },
    { value: 'in', label: 'In list (comma-sep)' }
];

export default {
    splitColumn, combineColumns, replaceText, typeConvert,
    applyFilters, deduplicate, joinData, validate, addUniqueId,
    FILTER_OPERATORS
};
