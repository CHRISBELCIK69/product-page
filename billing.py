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
                plan                    TEXT,
                status                  TEXT NOT NULL,
                created_at              TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)


def upsert_subscriber(*, stripe_customer_id, email=None, stripe_subscription_id=None, plan=None, status):
    """Create or update the row for this Stripe customer.

    Called from the webhook handler on checkout completion and on every
    subscription status change (active, past_due, canceled, ...). `email`
    and `plan` are optional on updates since subscription.* events don't
    always carry them — COALESCE keeps whatever was recorded at checkout.
    """
    with _connect() as conn:
        conn.execute("""
            INSERT INTO subscribers (email, stripe_customer_id, stripe_subscription_id, plan, status, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(stripe_customer_id) DO UPDATE SET
                email                  = COALESCE(excluded.email, subscribers.email),
                stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, subscribers.stripe_subscription_id),
                plan                   = COALESCE(excluded.plan, subscribers.plan),
                status                 = excluded.status,
                updated_at             = datetime('now')
        """, (email, stripe_customer_id, stripe_subscription_id, plan, status))


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


init_db()
