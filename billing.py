# ============================================================
# billing.py
# Minimal subscriber store backed by SQLite. Tracks the mapping from
# a paying customer to their current Stripe subscription status so
# the rest of the app can answer "does this email have an active
# subscription?" without calling the Stripe API on every request.
#
# Rows are keyed by stripe_customer_id (stable for the customer's
# lifetime) rather than email, since Stripe lets a customer's email
# change without changing their customer id.
# ============================================================

import os
import secrets
import sqlite3
from contextlib import contextmanager

DB_PATH = os.environ.get('BILLING_DB_PATH', os.path.join(os.path.dirname(__file__), 'billing.db'))


@contextmanager
def _connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS subscribers (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                email                   TEXT,
                stripe_customer_id      TEXT NOT NULL UNIQUE,
                stripe_subscription_id  TEXT,
                checkout_session_id     TEXT,
                license_key             TEXT UNIQUE,
                discord_user_id         TEXT UNIQUE,
                plan                    TEXT,
                status                  TEXT NOT NULL,
                created_at              TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)


def generate_license_key():
    return 'VTX-' + secrets.token_hex(4).upper()


def upsert_subscriber(*, stripe_customer_id, email=None, stripe_subscription_id=None,
                       checkout_session_id=None, license_key=None, plan=None, status):
    """Create or update the row for this Stripe customer.

    Called from the webhook handler on checkout completion and on every
    subscription status change (active, past_due, canceled, ...). `email`
    and `plan` are optional on updates since subscription.* events don't
    always carry them — COALESCE keeps whatever was recorded at checkout.

    `license_key` and `checkout_session_id` are first-write-wins (the
    opposite direction from the other COALESCEs): Stripe can redeliver the
    same webhook, and re-running this must never hand out a *second*
    license key for one checkout — the customer's already-shown key would
    silently stop working.
    """
    with _connect() as conn:
        conn.execute("""
            INSERT INTO subscribers
                (email, stripe_customer_id, stripe_subscription_id, checkout_session_id, license_key, plan, status, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(stripe_customer_id) DO UPDATE SET
                email                  = COALESCE(excluded.email, subscribers.email),
                stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, subscribers.stripe_subscription_id),
                checkout_session_id    = COALESCE(subscribers.checkout_session_id, excluded.checkout_session_id),
                license_key            = COALESCE(subscribers.license_key, excluded.license_key),
                plan                   = COALESCE(excluded.plan, subscribers.plan),
                status                 = excluded.status,
                updated_at             = datetime('now')
        """, (email, stripe_customer_id, stripe_subscription_id, checkout_session_id, license_key, plan, status))


def get_subscriber_by_email(email):
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM subscribers WHERE email = ? ORDER BY updated_at DESC LIMIT 1",
            (email,),
        ).fetchone()
        return dict(row) if row else None


def get_subscriber_by_customer_id(stripe_customer_id):
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM subscribers WHERE stripe_customer_id = ?",
            (stripe_customer_id,),
        ).fetchone()
        return dict(row) if row else None


def has_active_subscription(email):
    sub = get_subscriber_by_email(email)
    return bool(sub and sub['status'] in ('active', 'trialing'))


def get_subscriber_by_checkout_session(checkout_session_id):
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM subscribers WHERE checkout_session_id = ?",
            (checkout_session_id,),
        ).fetchone()
        return dict(row) if row else None


def get_subscriber_by_license_key(license_key):
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM subscribers WHERE license_key = ?",
            (license_key,),
        ).fetchone()
        return dict(row) if row else None


def get_subscriber_by_discord_id(discord_user_id):
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM subscribers WHERE discord_user_id = ?",
            (discord_user_id,),
        ).fetchone()
        return dict(row) if row else None


def link_discord_user(stripe_customer_id, discord_user_id):
    """Point a Discord account at a subscriber row (via /redeem in the bot).

    Re-linking a different Discord account to the same subscriber just
    overwrites the old mapping — a customer switching Discord accounts is
    a normal case, not an attack, since redeeming still requires their
    license key.
    """
    with _connect() as conn:
        conn.execute(
            "UPDATE subscribers SET discord_user_id = ?, updated_at = datetime('now') WHERE stripe_customer_id = ?",
            (discord_user_id, stripe_customer_id),
        )


init_db()
