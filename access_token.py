# ============================================================
# access_token.py
# Signed, expiring tokens that hand a Discord-verified subscriber
# off to the tool service — verification needs only the shared
# secret below, never a database or network call back here.
#
# This exact file is duplicated byte-for-byte in the tool's repo.
# That's deliberate: the tool verifies access without depending on
# this service being reachable, at the cost of the two copies
# needing to be kept in sync if the scheme ever changes.
# ============================================================

import base64
import hashlib
import hmac
import json
import os
import time

SECRET = os.environ.get('ACCESS_TOKEN_SECRET', '')

DEFAULT_TTL_SECONDS = 15 * 60  # link is meant to be clicked within minutes


def _b64encode(raw: bytes) -> bytes:
    return base64.urlsafe_b64encode(raw).rstrip(b'=')


def _b64decode(data: bytes) -> bytes:
    padding = b'=' * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def mint(customer_id, ttl_seconds=DEFAULT_TTL_SECONDS):
    if not SECRET:
        raise RuntimeError('ACCESS_TOKEN_SECRET is not set')
    payload = {'cid': customer_id, 'exp': int(time.time()) + ttl_seconds}
    body = _b64encode(json.dumps(payload, separators=(',', ':')).encode())
    sig = hmac.new(SECRET.encode(), body, hashlib.sha256).digest()
    return (body + b'.' + _b64encode(sig)).decode()


def verify(token):
    """Returns the payload dict if the token is authentic and unexpired, else None."""
    if not SECRET or not token:
        return None
    try:
        body, sig = token.encode().split(b'.')
    except ValueError:
        return None

    expected_sig = _b64encode(hmac.new(SECRET.encode(), body, hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected_sig):
        return None

    try:
        payload = json.loads(_b64decode(body))
    except Exception:
        return None

    if payload.get('exp', 0) < time.time():
        return None

    return payload
