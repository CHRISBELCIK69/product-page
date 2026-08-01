# ============================================================
# server.py
# Serves the marketing site (this used to be a pure static
# Railway deploy) plus the Stripe checkout/webhook routes.
# Same-origin now, so no CORS is needed for the checkout call.
# ============================================================

import os

from flask import Flask, jsonify, request, send_from_directory
import stripe

import billing

app = Flask(__name__, static_folder=None)

stripe.api_key = os.environ.get('STRIPE_SECRET_KEY', '')

STRIPE_PRICES = {
    'desk': os.environ.get('STRIPE_PRICE_DESK', ''),
}
STRIPE_WEBHOOK_SECRET = os.environ.get('STRIPE_WEBHOOK_SECRET', '')
STRIPE_SUCCESS_URL = os.environ.get('STRIPE_SUCCESS_URL', 'http://localhost:8000/?checkout=success')
STRIPE_CANCEL_URL  = os.environ.get('STRIPE_CANCEL_URL',  'http://localhost:8000/?checkout=cancel')


@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory('.', filename)


@app.route('/api/create-checkout-session', methods=['POST'])
def create_checkout_session():
    body     = request.get_json(force=True) or {}
    plan     = body.get('plan', 'desk')
    price_id = STRIPE_PRICES.get(plan)
    if not price_id:
        return jsonify({'error': f'unknown plan "{plan}"'}), 400

    try:
        session = stripe.checkout.Session.create(
            mode='subscription',
            line_items=[{'price': price_id, 'quantity': 1}],
            success_url=STRIPE_SUCCESS_URL,
            cancel_url=STRIPE_CANCEL_URL,
            allow_promotion_codes=True,
            metadata={'plan': plan},
        )
    except stripe.error.StripeError as e:
        return jsonify({'error': str(e)}), 400

    return jsonify({'url': session.url})


@app.route('/api/stripe/webhook', methods=['POST'])
def stripe_webhook():
    payload    = request.get_data()
    sig_header = request.headers.get('Stripe-Signature', '')

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError):
        return jsonify({'error': 'invalid signature'}), 400

    obj = event['data']['object']

    if event['type'] == 'checkout.session.completed':
        billing.upsert_subscriber(
            stripe_customer_id=obj['customer'],
            email=(obj.get('customer_details') or {}).get('email'),
            stripe_subscription_id=obj.get('subscription'),
            plan=(obj.get('metadata') or {}).get('plan'),
            status='active',
        )

    elif event['type'] in ('customer.subscription.updated', 'customer.subscription.deleted'):
        status = 'canceled' if event['type'] == 'customer.subscription.deleted' else obj['status']
        billing.upsert_subscriber(
            stripe_customer_id=obj['customer'],
            stripe_subscription_id=obj['id'],
            status=status,
        )

    return jsonify({'received': True})


if __name__ == '__main__':
    app.run(port=int(os.environ.get('PORT', 8000)), debug=True)
