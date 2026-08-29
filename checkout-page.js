// ============================================================
// checkout-page.js
// Drives the custom checkout page (checkout.html): mounts Stripe's
// Payment Element in "deferred" mode (no SetupIntent exists yet — one is
// only created once the customer submits, so an abandoned form never
// leaves an intent behind), then confirms it. Stripe redirects back to
// the main site's ?checkout=success banner on success, same as the old
// hosted-checkout flow, so no separate success page is needed here.
// ============================================================

(async function () {
  const params = new URLSearchParams(window.location.search);
  const plan = params.get('plan') || 'desk';

  const form         = document.getElementById('checkout-form');
  const submitBtn     = document.getElementById('submit-btn');
  const submitBtnText = document.getElementById('submit-btn-text');
  const errorEl       = document.getElementById('checkout-error');
  const emailInput    = document.getElementById('email');
  const promoInput    = document.getElementById('promo-code');

  function showError(msg) {
    errorEl.textContent = msg || '';
  }

  function setBusy(busy, label) {
    submitBtn.disabled = busy;
    submitBtnText.textContent = label;
  }

  setBusy(true, 'Loading…');

  let stripe, elements;
  try {
    const configRes = await fetch('/api/stripe-config');
    const { publishableKey } = await configRes.json();
    if (!publishableKey) throw new Error('Checkout is not configured yet — missing Stripe publishable key.');

    stripe = Stripe(publishableKey);
    elements = stripe.elements({
      mode: 'setup',
      currency: 'usd',
      appearance: {
        theme: 'night',
        variables: {
          colorPrimary: '#FFB020',
          colorBackground: '#171C22',
          colorText: '#E8EAED',
          colorTextSecondary: '#8B94A0',
          colorDanger: '#E5484D',
          fontFamily: 'Inter, sans-serif',
          borderRadius: '5px',
          fontSizeBase: '14px',
        },
        rules: {
          '.Input': { border: '1px solid #232A32' },
          '.Label': { display: 'none' },
        },
      },
    });
    elements.create('payment').mount('#payment-element');
    setBusy(false, 'Start 7-day free trial');
  } catch (err) {
    showError(err.message);
    setBusy(true, 'Start 7-day free trial');
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');

    const email = emailInput.value.trim();
    if (!email) { showError('Enter your email.'); return; }

    setBusy(true, 'Processing…');

    const { error: submitError } = await elements.submit();
    if (submitError) {
      showError(submitError.message);
      setBusy(false, 'Start 7-day free trial');
      return;
    }

    const intentRes = await fetch('/api/create-setup-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, email, promo_code: promoInput.value.trim() }),
    });
    const intentData = await intentRes.json();
    if (!intentData.clientSecret) {
      showError(intentData.error || 'Could not start checkout.');
      setBusy(false, 'Start 7-day free trial');
      return;
    }

    const setupIntentId = intentData.clientSecret.split('_secret_')[0];
    const returnUrl = window.location.origin + '/?checkout=success&session_id=' + encodeURIComponent(setupIntentId);

    const { error } = await stripe.confirmSetup({
      elements,
      clientSecret: intentData.clientSecret,
      confirmParams: {
        return_url: returnUrl,
        payment_method_data: { billing_details: { email } },
      },
    });

    // Only reached if confirmation failed outright — success navigates away.
    if (error) {
      showError(error.message);
      setBusy(false, 'Start 7-day free trial');
    }
  });
})();
