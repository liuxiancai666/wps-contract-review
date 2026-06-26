const USER_ID_KEY = 'user_id';

let currentUserId = localStorage.getItem(USER_ID_KEY);

export const identifyUser = async () => {
    if (currentUserId) {
        console.log(`[User] Found existing User ID: ${currentUserId}`);
        return parseInt(currentUserId, 10);
    }

    console.log('[User] No User ID found. Generating local ID...');
    try {
        // Local fingerprint: browser prefix + random + timestamp
        const visitorId = 'browser-' + Math.random().toString(36).substring(2, 10) + Date.now();
        console.log(`[User] Local ID generated: ${visitorId}`);

        const response = await fetch('/api/users/identify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fingerprintId: visitorId }),
        });
        const data = await response.json();

        currentUserId = data.userId;
        localStorage.setItem(USER_ID_KEY, currentUserId);

        console.log(`[User] Successfully identified. User ID: ${currentUserId}`);
        return currentUserId;
    } catch (error) {
        console.error('[User] API identification failed:', error);
        // Non-blocking: assign a temp ID in localStorage
        currentUserId = currentUserId || parseInt('100' + String(Math.floor(Math.random() * 90000)));
        localStorage.setItem(USER_ID_KEY, String(currentUserId));
        console.log(`[User] Fallback temp User ID: ${currentUserId}`);
        return currentUserId;
    }
};

export const getUserId = () => {
    return currentUserId ? parseInt(currentUserId, 10) : null;
};
