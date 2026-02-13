/**
 * Centralized error classification and handler
 */
import logger from './logger.js';

export const ErrorCategory = {
    CORS_BLOCKED: 'CORS_BLOCKED',
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    HTTP_4XX: 'HTTP_4XX',
    HTTP_5XX: 'HTTP_5XX',
    RATE_LIMIT: 'RATE_LIMIT',
    TIMEOUT: 'TIMEOUT',
    PARSE_FAILED: 'PARSE_FAILED',
    UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
    OUT_OF_MEMORY: 'OUT_OF_MEMORY',
    CANCELLED: 'CANCELLED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    UNKNOWN: 'UNKNOWN'
};

const friendlyMessages = {
    [ErrorCategory.CORS_BLOCKED]: {
        title: 'Cross-Origin Request Blocked',
        message: 'The server does not allow requests from web browsers. This is a server-side restriction, not an issue with this app.',
        guidance: 'Try using a different (CORS-enabled) endpoint, or download the data manually and import it as a file.'
    },
    [ErrorCategory.AUTH_REQUIRED]: {
        title: 'Authentication Required',
        message: 'This resource requires login credentials. This app only supports publicly accessible data.',
        guidance: 'Ensure the layer/service is publicly shared, or download the data using an authorized tool and import it here.'
    },
    [ErrorCategory.HTTP_4XX]: {
        title: 'Request Error',
        message: 'The server rejected the request. The URL may be incorrect or the resource may no longer exist.',
        guidance: 'Double-check the URL and try again.'
    },
    [ErrorCategory.HTTP_5XX]: {
        title: 'Server Error',
        message: 'The remote server encountered an internal error. This is not an issue with this app.',
        guidance: 'Wait a moment and try again, or check if the server is online.'
    },
    [ErrorCategory.RATE_LIMIT]: {
        title: 'Rate Limited',
        message: 'Too many requests were sent. The server is temporarily blocking further requests.',
        guidance: 'Wait a minute and try again with smaller requests.'
    },
    [ErrorCategory.TIMEOUT]: {
        title: 'Request Timed Out',
        message: 'The operation took too long to complete.',
        guidance: 'Try again with a smaller dataset or check your network connection.'
    },
    [ErrorCategory.PARSE_FAILED]: {
        title: 'Data Parsing Error',
        message: 'The file or data could not be parsed. It may be corrupted or in an unexpected format.',
        guidance: 'Verify the file is valid and in one of the supported formats.'
    },
    [ErrorCategory.UNSUPPORTED_FORMAT]: {
        title: 'Unsupported Format',
        message: 'This file type or data format is not supported.',
        guidance: 'Convert the data to a supported format (GeoJSON, CSV, Excel, KML, KMZ, Shapefile ZIP).'
    },
    [ErrorCategory.OUT_OF_MEMORY]: {
        title: 'Out of Memory',
        message: 'The dataset is too large for browser processing.',
        guidance: 'Try a smaller dataset or close other browser tabs to free memory.'
    },
    [ErrorCategory.CANCELLED]: {
        title: 'Operation Cancelled',
        message: 'The operation was cancelled by the user.',
        guidance: ''
    },
    [ErrorCategory.NETWORK_ERROR]: {
        title: 'Network Error',
        message: 'Could not connect to the server. Check your internet connection.',
        guidance: 'Verify your connection and try again.'
    },
    [ErrorCategory.VALIDATION_ERROR]: {
        title: 'Validation Error',
        message: 'The data did not pass validation checks.',
        guidance: 'Review the validation errors and fix the data.'
    },
    [ErrorCategory.UNKNOWN]: {
        title: 'Unexpected Error',
        message: 'An unexpected error occurred.',
        guidance: 'Check the Logs panel for details. You can download logs for troubleshooting.'
    }
};

export function classifyError(error, context = {}) {
    if (error?.name === 'AbortError' || error?.message?.includes('abort') || error?.cancelled) {
        return ErrorCategory.CANCELLED;
    }
    if (error instanceof TypeError && error.message?.includes('Failed to fetch')) {
        return context.url ? ErrorCategory.CORS_BLOCKED : ErrorCategory.NETWORK_ERROR;
    }
    if (error?.status === 401 || error?.status === 403) return ErrorCategory.AUTH_REQUIRED;
    if (error?.status === 429) return ErrorCategory.RATE_LIMIT;
    if (error?.status >= 400 && error?.status < 500) return ErrorCategory.HTTP_4XX;
    if (error?.status >= 500) return ErrorCategory.HTTP_5XX;
    if (error?.message?.includes('timeout') || error?.name === 'TimeoutError') return ErrorCategory.TIMEOUT;
    if (error?.message?.includes('out of memory') || error?.name === 'RangeError') return ErrorCategory.OUT_OF_MEMORY;
    if (error?.category) return error.category;
    return ErrorCategory.UNKNOWN;
}

export function getFriendlyError(category) {
    return friendlyMessages[category] || friendlyMessages[ErrorCategory.UNKNOWN];
}

export class AppError extends Error {
    constructor(message, category, details = {}) {
        super(message);
        this.name = 'AppError';
        this.category = category;
        this.details = details;
    }
}

export function handleError(error, module, action, context = {}) {
    const category = classifyError(error, context);
    const friendly = getFriendlyError(category);
    logger.error(module, action, {
        category,
        message: error?.message,
        status: error?.status,
        ...context
    });
    return { category, ...friendly, technical: error?.message, stack: error?.stack };
}

export default { classifyError, getFriendlyError, AppError, handleError, ErrorCategory };
