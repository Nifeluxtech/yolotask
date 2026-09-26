async function checkAuthAndRedirect(requiredRole = null) {
  const token = localStorage.getItem('yolotask_token');
  if (!token) {
    window.location.href = '/login.html';
    return null;
  }

  try {
    const res = await apiClient.request('auth.js', { action: 'get-session' });
    const profile = res.data.profile;

    if (requiredRole && profile.role !== requiredRole) {
      // Redirect to correct dashboard if role mismatches
      window.location.href = profile.role === 'advertiser' ? '/advertiser/dashboard.html' : '/earner/dashboard.html';
      return null;
    }
    return profile;
  } catch (err) {
    localStorage.removeItem('yolotask_token');
    window.location.href = '/login.html';
    return null;
  }
}

function formatCurrency(amount) {
  return '₦' + Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
