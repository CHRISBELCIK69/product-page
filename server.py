# ============================================================
# server.py
# Serves the marketing site (this used to be a pure static
# Railway deploy) plus the Stripe checkout/webhook routes.
# Same-origin now, so no CORS is needed for the checkout call.
# ============================================================

import os
from urllib.parse import urlencode

from flask import Flask, jsonify, redirect, request, send_from_directory
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
import requests
import stripe

import access_token
import billing

app = Flask(__name__, static_folder=None)

stripe.api_key = os.environ.get('STRIPE_SECRET_KEY', '')

STRIPE_PRICES = {
    'desk': os.environ.get('STRIPE_PRICE_DESK', ''),
}
STRIPE_WEBHOOK_SECRET = os.environ.get('STRIPE_WEBHOOK_SECRET', '')
# Stripe replaces the literal {CHECKOUT_SESSION_ID} in success_url with the
# real session id — that's how the success page knows which row to poll for
# its license key.
STRIPE_SUCCESS_URL = os.environ.get('STRIPE_SUCCESS_URL', 'http://localhost:8000/?checkout=success&session_id={CHECKOUT_SESSION_ID}')
STRIPE_CANCEL_URL  = os.environ.get('STRIPE_CANCEL_URL',  'http://localhost:8000/?checkout=cancel')

# Shared secret the Discord bot presents to call the /internal/* routes
# below. Not the same secret as ACCESS_TOKEN_SECRET — a leaked bot token
# should not let someone mint tool-access tokens directly.
INTERNAL_API_SECRET = os.environ.get('INTERNAL_API_SECRET', '')

# Discord OAuth (auto-join flow off the success page) — separate from
# DISCORD_BOT_TOKEN's use in bot.py's gateway connection. Here the bot
# token authenticates plain REST calls (add member / grant role) that
# don't require the bot process to be running.
DISCORD_CLIENT_ID          = os.environ.get('DISCORD_CLIENT_ID', '')
DISCORD_CLIENT_SECRET      = os.environ.get('DISCORD_CLIENT_SECRET', '')
DISCORD_OAUTH_REDIRECT_URI = os.environ.get('DISCORD_OAUTH_REDIRECT_URI', '')
DISCORD_BOT_TOKEN          = os.environ.get('DISCORD_BOT_TOKEN', '')
DISCORD_GUILD_ID           = os.environ.get('DISCORD_GUILD_ID', '')
DISCORD_PAID_ROLE_ID       = os.environ.get('DISCORD_PAID_ROLE_ID', '')

# Signs the OAuth `state` param (carries the checkout session id across the
# Discord redirect) — reuses ACCESS_TOKEN_SECRET with a distinct salt so a
# forged tool-access token can't double as OAuth state or vice versa.
_oauth_state_signer = URLSafeTimedSerializer(
    os.environ.get('ACCESS_TOKEN_SECRET', ''), salt='discord-oauth-state')


def _internal_auth_ok():
    return bool(INTERNAL_API_SECRET) and request.headers.get('X-Internal-Secret') == INTERNAL_API_SECRET


def _stripe_get(obj, key, default=None):
    """obj[key] with a default — StripeObject doesn't support .get() like a dict does."""
    try:
        return obj[key]
    except (KeyError, TypeError):
        return default


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
        customer_details = _stripe_get(obj, 'customer_details') or {}
        metadata = _stripe_get(obj, 'metadata') or {}
        billing.upsert_subscriber(
            stripe_customer_id=obj['customer'],
            email=_stripe_get(customer_details, 'email'),
            stripe_subscription_id=_stripe_get(obj, 'subscription'),
            checkout_session_id=obj['id'],
            license_key=billing.generate_license_key(),
            plan=_stripe_get(metadata, 'plan'),
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


# ── Success page ──────────────────────────────────────────────────────────
# Polled by the success banner's JS — the webhook above usually lands
# before this is called, but isn't guaranteed to, hence "ready: false"
# rather than a 404 while the customer's browser is faster than Stripe's
# webhook delivery.

@app.route('/api/license-key')
def api_license_key():
    session_id = request.args.get('session_id', '')
    sub = billing.get_subscriber_by_checkout_session(session_id)
    if not sub:
        return jsonify({'ready': False})
    return jsonify({'ready': True, 'license_key': sub['license_key']})


# ── Discord auto-join (OAuth) ─────────────────────────────────────────────
# Triggered by a button on the success page — no /redeem needed. Uses the
# `guilds.join` scope so Discord's Add Guild Member API can add the customer
# directly, in the same call as granting the paid role.

@app.route('/auth/discord/start')
def discord_oauth_start():
    session_id = request.args.get('session_id', '')
    if not session_id:
        return jsonify({'error': 'missing session_id'}), 400

    state = _oauth_state_signer.dumps(session_id)
    params = {
        'client_id': DISCORD_CLIENT_ID,
        'redirect_uri': DISCORD_OAUTH_REDIRECT_URI,
        'response_type': 'code',
        'scope': 'identify guilds.join',
        'state': state,
    }
    return redirect('https://discord.com/oauth2/authorize?' + urlencode(params))


@app.route('/auth/discord/callback')
def discord_oauth_callback():
    code  = request.args.get('code', '')
    state = request.args.get('state', '')
    if not code or not state:
        return jsonify({'error': 'missing code or state'}), 400

    try:
        session_id = _oauth_state_signer.loads(state, max_age=600)
    except (BadSignature, SignatureExpired):
        return jsonify({'error': 'this link expired — go back to the success page and try again'}), 400

    sub = billing.get_subscriber_by_checkout_session(session_id)
    if not sub or sub['status'] not in ('active', 'trialing'):
        return jsonify({'error': 'no active subscription found for this checkout'}), 403

    token_r = requests.post('https://discord.com/api/oauth2/token', data={
        'client_id': DISCORD_CLIENT_ID,
        'client_secret': DISCORD_CLIENT_SECRET,
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': DISCORD_OAUTH_REDIRECT_URI,
    })
    if token_r.status_code != 200:
        return jsonify({'error': 'discord authorization failed'}), 400
    user_access_token = token_r.json()['access_token']

    identity_r = requests.get('https://discord.com/api/users/@me',
                               headers={'Authorization': f'Bearer {user_access_token}'})
    if identity_r.status_code != 200:
        return jsonify({'error': 'could not read discord identity'}), 400
    discord_user_id = identity_r.json()['id']

    existing = billing.get_subscriber_by_discord_id(discord_user_id)
    if existing and existing['stripe_customer_id'] != sub['stripe_customer_id']:
        return jsonify({'error': 'this Discord account is already linked to a different subscription'}), 409

    join_r = requests.put(
        f'https://discord.com/api/guilds/{DISCORD_GUILD_ID}/members/{discord_user_id}',
        json={'access_token': user_access_token, 'roles': [DISCORD_PAID_ROLE_ID]},
        headers={'Authorization': f'Bot {DISCORD_BOT_TOKEN}'},
    )
    if join_r.status_code == 204:
        # 204 means they were already a member — Add Guild Member doesn't
        # touch roles on that path, so grant it explicitly as a fallback.
        requests.put(
            f'https://discord.com/api/guilds/{DISCORD_GUILD_ID}/members/{discord_user_id}/roles/{DISCORD_PAID_ROLE_ID}',
            headers={'Authorization': f'Bot {DISCORD_BOT_TOKEN}'},
        )
    elif join_r.status_code != 201:
        return jsonify({'error': 'could not add you to the discord server'}), 502

    billing.link_discord_user(sub['stripe_customer_id'], discord_user_id)
    return redirect('/?discord=linked')


# ── Internal API — called only by the Discord bot ────────────────────────
# Every route here requires INTERNAL_API_SECRET. This is the only place
# the bot's world (Discord user ids) touches billing data — the bot never
# sees Stripe keys or the database directly.

@app.route('/internal/redeem-license', methods=['POST'])
def internal_redeem_license():
    if not _internal_auth_ok():
        return jsonify({'error': 'forbidden'}), 403

    body       = request.get_json(force=True) or {}
    key        = (body.get('license_key') or '').strip()
    discord_id = body.get('discord_user_id')
    if not key or not discord_id:
        return jsonify({'error': 'license_key and discord_user_id are required'}), 400

    sub = billing.get_subscriber_by_license_key(key)
    if not sub or sub['status'] not in ('active', 'trialing'):
        return jsonify({'error': 'invalid or inactive license key'}), 404

    existing = billing.get_subscriber_by_discord_id(discord_id)
    if existing and existing['stripe_customer_id'] != sub['stripe_customer_id']:
        return jsonify({'error': 'this Discord account is already linked to a different subscription'}), 409

    billing.link_discord_user(sub['stripe_customer_id'], discord_id)
    return jsonify({'ok': True, 'plan': sub['plan']})


@app.route('/internal/subscriber-status', methods=['POST'])
def internal_subscriber_status():
    if not _internal_auth_ok():
        return jsonify({'error': 'forbidden'}), 403

    body = request.get_json(force=True) or {}
    sub  = billing.get_subscriber_by_discord_id(body.get('discord_user_id'))
    active = bool(sub and sub['status'] in ('active', 'trialing'))
    return jsonify({'active': active, 'plan': sub['plan'] if sub else None})


@app.route('/internal/mint-access-token', methods=['POST'])
def internal_mint_access_token():
    if not _internal_auth_ok():
        return jsonify({'error': 'forbidden'}), 403

    body = request.get_json(force=True) or {}
    sub  = billing.get_subscriber_by_discord_id(body.get('discord_user_id'))
    if not sub or sub['status'] not in ('active', 'trialing'):
        return jsonify({'error': 'no active subscription linked to this Discord account'}), 403

    token = access_token.mint(sub['stripe_customer_id'])
    return jsonify({'token': token})


if __name__ == '__main__':
    app.run(port=int(os.environ.get('PORT', 8000)), debug=True)
