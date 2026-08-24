import { apiRequest } from './api.js';

const interests = ['Affiliate Marketing','Content Creator','Influencer','Social Media Marketing','Digital Marketing','Online Seller','Fashion','Freelancing','Graphic Design','Web Development','Video Editing','Blogging','YouTube','TikTok','Instagram','Technology','AI','Online Courses','Education','Job Updates','Business Opportunities','Side Hustle Updates','Dropshipping','E-commerce','Digital Products','Agriculture','Food Business','Beauty','Travel','Events','Music Promotion','Affiliate Offers','Referral Marketing','Community Management','Startup','Entrepreneur','Small Business Owner'];
const page = document.body.dataset.authPage || 'login';
const form = document.querySelector('#auth-form');
const error = document.querySelector('#auth-error');
const notice = document.querySelector('#auth-notice');
const roleSelect = document.querySelector('#account-type');
const earnerFields = document.querySelector('#earner-fields');
const interestOptions = document.querySelector('#interest-options');

const show = (node, message, kind='error') => { if (!node) return; node.textContent = message; node.className = `alert ${kind}`; node.hidden = false; };
const hide = node => { if (node) node.hidden = true; };
const esc = value => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

if (interestOptions) interestOptions.innerHTML = interests.map(name => `<label class="interest"><input type="checkbox" name="interests" value="${esc(name)}"><span>${esc(name)}</span></label>`).join('');

function syncRoleFields() {
  if (!roleSelect || !earnerFields) return;
  const isEarner = roleSelect.value === 'earner';
  earnerFields.hidden = !isEarner;
  earnerFields.setAttribute('aria-hidden', String(!isEarner));
  earnerFields.querySelectorAll('input,select').forEach(field => { field.disabled = !isEarner; field.required = isEarner && field.name === 'gender'; });
}
roleSelect?.addEventListener('change', syncRoleFields);
syncRoleFields();

form?.addEventListener('submit', async event => {
  event.preventDefault();
  hide(error); hide(notice);
  const data = new FormData(form);
  const role = data.get('role') || 'earner';
  const selected = data.getAll('interests');
  if (page === 'register' && role === 'earner' && selected.length < 3) return show(error, 'Select at least 3 interests to continue.');
  const submit = form.querySelector('button[type=submit]');
  if (submit) { submit.disabled = true; submit.textContent = page === 'login' ? 'Signing in…' : 'Creating account…'; }
  try {
    const payload = page === 'login'
      ? { email: data.get('email'), password: data.get('password') }
      : { email: data.get('email'), password: data.get('password'), full_name: data.get('full_name'), role, gender: role === 'earner' ? data.get('gender') : 'prefer_not_to_say', interests: role === 'earner' ? selected : [] };
    const result = await apiRequest(`auth?action=${page}`, { method:'POST', body:payload });
    if (result.session) localStorage.setItem('yolotask_session', JSON.stringify(result.session));
    if (page === 'login') {
      window.location.href = result.dashboard_path || '/earner/index.html';
    } else {
      show(notice, 'Account created. You can now log in immediately.', 'success');
      setTimeout(() => { window.location.href = '/auth/login.html'; }, 800);
    }
  } catch (err) { show(error, err.message || 'Unable to complete this request.'); if (submit) { submit.disabled = false; submit.textContent = page === 'login' ? 'Continue ↗' : 'Create account ↗'; } }
});
