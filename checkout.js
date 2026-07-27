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
