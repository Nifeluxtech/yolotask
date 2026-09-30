// /public/js/auth.js

/**
 * Checks if the user is authenticated and has the correct role.
 * If not, it redirects them to the appropriate page or login.
 * @param {string} requiredRole - The role required to view the page ('earner', 'advertiser', 'reviewer', 'admin').
 * @returns {Promise<Object|null>} - Returns the user profile if authorized, null if redirecting.
 */
async function checkAuthAndRedirect(requiredRole = null) {
  const token = localStorage.getItem('yolotask_token');
  
  // 1. Basic local check
  if (!token) {
    window.location.href = '/login.html';
    return null;
  }

  try {
    // 2. Verify with backend API
    const res = await apiClient.request('auth.js', { action: 'get-session' });
    const profile = res.data.profile;
    
    // 3. Save fresh profile to local storage for offline/UI use
    localStorage.setItem('yolotask_user', JSON.stringify(profile));

    // 4. Role Validation & Redirection
    const allowedRoles = ['earner', 'advertiser', 'reviewer', 'admin'];
    
    // If a specific role is required for this page
    if (requiredRole) {
      // Admins can access all dashboards (optional, remove if you want strict separation)
      const isAuthorized = profile.role === requiredRole || profile.role === 'admin'; 
      
      if (!isAuthorized) {
        // Dynamically redirect to their actual dashboard
        if (allowedRoles.includes(profile.role)) {
          window.location.href = `/${profile.role}/dashboard.html`;
        } else {
          window.location.href = '/login.html';
        }
        return null;
      }
    } else {
      // If no specific role is required, just ensure they have a valid role
      if (allowedRoles.includes(profile.role)) {
         // If they are on the root index.html, redirect them to their home
         if (window.location.pathname === '/' || window.location.pathname === '/index.html') {
           window.location.href = `/${profile.role}/dashboard.html`;
           return null;
         }
      }
    }

    return profile;

  } catch (err) {
    // Token is invalid, expired, or network error
    console.error('Auth check failed:', err);
    localStorage.removeItem('yolotask_token');
    localStorage.removeItem('yolotask_user');
    window.location.href = '/login.html';
    return null;
  }
}

/**
 * Helper to get the current user from local storage without a network request.
 * Use this for quick UI rendering (like showing the user's name in the header).
 */
function getCachedUser() {
  const userStr = localStorage.getItem('yolotask_user');
  return userStr ? JSON.parse(userStr) : null;
}
