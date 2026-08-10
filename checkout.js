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

function showLicenseKeyBanner(key, sessionId) {
  const el = document.getElementById('checkoutSuccessBanner');
  if (!el) return;
  el.innerHTML =
    '<div style="background:var(--panel);border-bottom:1px solid var(--line);padding:18px 32px;text-align:center;">' +
      '<div style="font-family:var(--font-mono);color:var(--text-dim);font-size:13px;margin-bottom:8px;">' +
        "You're subscribed." +
      '</div>' +
      '<div style="font-family:var(--font-mono);font-size:20px;font-weight:600;color:var(--amber);letter-spacing:0.04em;">' +
        key +
      '</div>' +
      '<a href="/auth/discord/start?session_id=' + encodeURIComponent(sessionId) + '" ' +
        'style="display:inline-block;margin-top:12px;padding:8px 18px;background:#5865F2;color:#fff;border-radius:6px;font-family:var(--font-mono);font-size:13px;text-decoration:none;">' +
        'Join the Discord server' +
      '</a>' +
      '<div style="font-family:var(--font-mono);color:var(--text-faint);font-size:12.5px;margin-top:8px;">' +
        "That link adds you and grants tool access automatically. If it doesn't work, run " +
        '<code style="color:var(--text-dim)">/redeem ' + key + '</code> in the server instead.' +
      '</div>' +
    '</div>';
}

function showDiscordLinkedBanner() {
  const el = document.getElementById('checkoutSuccessBanner');
  if (!el) return;
  el.innerHTML =
    '<div style="background:var(--panel);border-bottom:1px solid var(--line);padding:18px 32px;text-align:center;">' +
      '<div style="font-family:var(--font-mono);color:var(--text-dim);font-size:13px;">' +
        "You're in — Discord is linked and you have tool access. Run " +
        '<code style="color:var(--text-dim)">/tool</code> in the server any time.' +
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
      if (data.ready) { showLicenseKeyBanner(data.license_key, sessionId); return; }
      if (attemptsLeft > 0) {
        setTimeout(() => pollLicenseKey(sessionId, attemptsLeft - 1), 1500);
      }
    })
    .catch(() => {});
}

(function checkForCheckoutSuccess() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('discord') === 'linked') {
    showDiscordLinkedBanner();
    return;
  }

  if (params.get('checkout') !== 'success') return;
  const sessionId = params.get('session_id');
  if (!sessionId) return;
  showLicenseKeyPending();
  pollLicenseKey(sessionId, 6);
})();
