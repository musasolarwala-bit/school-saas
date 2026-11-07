'use strict';
// Shared frontend helpers: API calls with the stored JWT, session
// storage, and role-based redirects. Server-side checks are the real
// enforcement; this only hides UI that would 403 anyway.

async function api(path, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('sm_token');
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(path, {
    method: method || 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}

function saveSession(r) {
  if (r.token) localStorage.setItem('sm_token', r.token);
  if (r.user) localStorage.setItem('sm_user', JSON.stringify(r.user));
  if (r.school) localStorage.setItem('sm_school', JSON.stringify(r.school));
}

function goDashboard(user) {
  if (user && user.role === 'super_admin') location.href = '/admin.html';
  else location.href = '/dashboard.html';
}

function logout() {
  localStorage.removeItem('sm_token');
  localStorage.removeItem('sm_user');
  localStorage.removeItem('sm_school');
  location.href = '/';
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Download a CSV endpoint (needs the JWT header, so no plain link).
async function downloadCsv(path, filename) {
  const token = localStorage.getItem('sm_token');
  const res = await fetch(path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  if (!res.ok) throw new Error('Download failed (' + res.status + ')');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
