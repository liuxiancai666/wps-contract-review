import api from './api';

const USER_ID_KEY = 'user_id';
const VISITOR_ID_KEY = 'visitor_id';

/**
 * Generate or retrieve a persistent visitor ID using crypto.randomUUID.
 * Stored in localStorage so it persists across sessions.
 */
const getVisitorId = () => {
    let visitorId = localStorage.getItem(VISITOR_ID_KEY);
    if (!visitorId) {
        try {
            visitorId = crypto.randomUUID();
        } catch {
            visitorId = 'v-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
        }
        localStorage.setItem(VISITOR_ID_KEY, visitorId);
        console.log(`[User] Generated new visitor ID: ${visitorId}`);
    }
    return visitorId;
};

let currentUserId = localStorage.getItem(USER_ID_KEY) ? parseInt(localStorage.getItem(USER_ID_KEY), 10) : null;

/**
 * Identifies the current user using a browser fingerprint.
 * If a user ID is already in localStorage, it's considered valid.
 * Otherwise, it generates a fingerprint, sends it to the backend to get a user ID,
 * and then stores that ID in localStorage.
 */
export const identifyUser = async () => {
    if (currentUserId) {
        console.log(`[User] Found existing User ID: ${currentUserId}`);
        return currentUserId;
    }

    console.log('[User] No User ID found. Identifying browser...');
    try {
        const visitorId = getVisitorId();
        console.log(`[User] Browser fingerprint generated: ${visitorId}`);

        const response = await api.identifyUser({ fingerprintId: visitorId });

        currentUserId = response.data.userId;
        localStorage.setItem(USER_ID_KEY, currentUserId);

        console.log(`[User] Successfully identified. User ID: ${currentUserId}`);

        return currentUserId;
    } catch (error) {
        console.error('[User] Fingerprinting or API identification failed:', error);
        // Don't alert here — let the login page handle unauthenticated users
        return null;
    }
};

/**
 * Gets the current user's ID.
 * @returns {number|null} The current user's ID, or null if not identified.
 */
export const getUserId = () => {
    return currentUserId ? parseInt(currentUserId, 10) : null;
};

/**
 * Sets the user ID after successful login (used by auth system).
 * This overrides any fingerprint-based ID.
 */
export const setUserId = (userId) => {
    currentUserId = userId;
    localStorage.setItem(USER_ID_KEY, userId);
};
