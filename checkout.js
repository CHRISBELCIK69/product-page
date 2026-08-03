function startCheckout(plan, btn) {
  const original = btn.textContent;
  btn.textContent = 'Redirecting…';

  fetch('/api/create-checkout-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan })
  })
    .then(r => r.json())
    .then(data => {
      if (data.url) { window.location.href = data.url; return; }
      throw new Error(data.error || 'checkout failed');
    })
    .catch(err => {
      btn.textContent = original;
      alert('Could not start checkout: ' + err.message);
    });
}

// ── Post-checkout success banner ─────────────────────────────────────────
// Stripe redirects here with ?checkout=success&session_id=... . The
// webhook that generates the license key usually lands before this page
// finishes loading, but isn't guaranteed to — poll a few times rather
// than showing "failed" on a slow webhook delivery.

function showLicenseKeyBanner(key) {
  const el = document.getElementById('checkoutSuccessBanner');
  if (!el) return;
  el.innerHTML =
    '<div style="background:var(--panel);border-bottom:1px solid var(--line);padding:18px 32px;text-align:center;">' +
      '<div style="font-family:var(--font-mono);color:var(--text-dim);font-size:13px;margin-bottom:8px;">' +
        "You're subscribed. Take this key to Discord:" +
      '</div>' +
      '<div style="font-family:var(--font-mono);font-size:20px;font-weight:600;color:var(--amber);letter-spacing:0.04em;">' +
        key +
      '</div>' +
      '<div style="font-family:var(--font-mono);color:var(--text-faint);font-size:12.5px;margin-top:8px;">' +
        'Run <code style="color:var(--text-dim)">/redeem ' + key + '</code> in the Discord server to link your account and get tool access.' +
      '</div>' +
    '</div>';
}

function showLicenseKeyPending() {
  const el = document.getElementById('checkoutSuccessBanner');
  if (!el) return;
  el.innerHTML =
    '<div style="background:var(--panel);border-bottom:1px solid var(--line);padding:18px 32px;text-align:center;">' +
      '<div style="font-family:var(--font-mono);color:var(--text-dim);font-size:13px;">' +
        "You're subscribed — finishing setup, one moment…" +
      '</div>' +
    '</div>';
}

function pollLicenseKey(sessionId, attemptsLeft) {
  fetch('/api/license-key?session_id=' + encodeURIComponent(sessionId))
    .then(r => r.json())
    .then(data => {
      if (data.ready) { showLicenseKeyBanner(data.license_key); return; }
      if (attemptsLeft > 0) {
        setTimeout(() => pollLicenseKey(sessionId, attemptsLeft - 1), 1500);
      }
    })
    .catch(() => {});
}

(function checkForCheckoutSuccess() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') !== 'success') return;
  const sessionId = params.get('session_id');
  if (!sessionId) return;
  showLicenseKeyPending();
  pollLicenseKey(sessionId, 6);
})();
