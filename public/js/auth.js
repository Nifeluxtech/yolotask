async function checkAuthAndRedirect(requiredRole = null) {
  const token = localStorage.getItem('yolotask_token');
  const user = JSON.parse(localStorage.getItem('yolotask_user'));

  if (!token || !user) {
    window.location.href = '/login.html';
    return null;
  }

  try {
    const res = await apiClient.request('auth.js', { action: 'get-session' });
    const profile = res.data.profile;
    
    // Save fresh profile
    localStorage.setItem('yolotask_user', JSON.stringify(profile));

    // Role Check
    if (requiredRole && profile.role !== requiredRole && profile.role !== 'admin') {
      // Redirect to correct dashboard if they are on the wrong page
      if (profile.role === 'earner') window.location.href = '/earner/dashboard.html';
      else if (profile.role === 'advertiser') window.location.href = '/advertiser/dashboard.html';
      else if (profile.role === 'reviewer') window.location.href = '/reviewer/dashboard.html';
      else if (profile.role === 'admin') window.location.href = '/admin/dashboard.html';
      return null;
    }

    return profile;
  } catch (err) {
    localStorage.clear();
    window.location.href = '/login.html';
    return null;
  }
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
