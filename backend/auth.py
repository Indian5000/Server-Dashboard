"""Your Standard Authentication thingy
Next part of this desciption shall be ai generated bcs WHO WRITES SO MUCH LITERATURE

Standard library + FastAPI only (sqlite3, hashlib.scrypt, secrets), so there is
nothing extra to pip install.

How it works
  * Passwords are stored as salted scrypt hashes (never in plain text).
  * Signing in returns a random session token. Only a SHA-256 of the token is
    stored in the database, so a leaked database cannot be used to sign in.
  * The browser sends the token as "Authorization: Bearer <token>".
  * Two roles: "admin" (everything, including user management) and "viewer"
    (read-only dashboard).
  * The very first user is created through POST /auth/setup, which only works
    while the users table is empty.

There End of Ai.
"""
import hashlib
import hmac
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Optional


from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel

log=logging.getLogger("syspulse.auth")

DB_PATH=os.environ.get(
    "SYSPULSE_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "users.db"),
)
SESSION_TTL=12*3600 #12 Hours of sign-in time. Enough time even for the average snail
REMEMBER_TTL= 30*24*3600 #30 day timer for keep me signed in thingy for yall demntia people
MAX_FAILS=5 #Locks any idiots out trying to log in using et Brute Force
LOCKOUT_SECONDS=60
MIN_PASSWORD=8
MAX_PASSWORD=128
USERNAME_RE = re.compile(r"^[a-z0-9_.-]{3,32}$")
ROLES = ("admin", "viewer")

router = APIRouter()

#---------DataBase-------

#Start of AI USE

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE,
    pw_hash    TEXT    NOT NULL,
    role       TEXT    NOT NULL CHECK (role IN ('admin', 'viewer')),
    disabled   INTEGER NOT NULL DEFAULT 0,
    created_at REAL    NOT NULL,
    last_login REAL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    ip         TEXT
);
"""

# END OF AI

@contextmanager
def db():
    con=sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory=sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()

def init_db():
    with db() as con:
        con.executescript(SCHEMA)
    try:
        os.chmod(DB_PATH, 0o600)  
    except OSError:
        pass


#------Password and Tokens------

#START OF AI USE(I have no idea how encryption works so Ai it is)

_N, _R, _P = 2 ** 14, 8, 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = bytes.fromhex(digest)
        calc = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt),n=int(n), r=int(r), p=int(p), dklen=len(expected))
        return hmac.compare_digest(calc, expected)
    except (ValueError, TypeError):
        return False


# Verified against when the username does not exist, so a wrong username takes
# as long as a wrong password (no way to tell which usernames exist).(There you get the default AI comment)
_DUMMY_HASH = hash_password("not-a-real-password")


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _create_session(con, user_id: int, remember: bool, ip: str):
    token = secrets.token_urlsafe(32)
    now = time.time()
    expires = now + (REMEMBER_TTL if remember else SESSION_TTL)
    con.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
    con.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip) VALUES (?,?,?,?,?)",
        (_hash_token(token), user_id, now, expires, ip),
    )
    return token, expires

#END OF AI USE

#------------Login throttling----------

_fail_lock=threading.Lock()
_fails:dict={}

def _check_lock(key):
    with _fail_lock:
        entry=_fails.get(key)
        if entry and entry[1]>time.time():
            wait=int(entry[1]-time.time())+1
            raise HTTPException(429,f"Too many failed attempts. Try again in {wait}s.")


def _record_fail(key):
    with _fail_lock:
        count, until = _fails.get(key, [0, 0.0])
        count += 1
        if count >= MAX_FAILS:
            count, until = 0, time.time() + LOCKOUT_SECONDS
        _fails[key] = [count, until]
        if len(_fails) > 5000:
            now = time.time()
            for k in [k for k, v in _fails.items() if v[1] < now and v[0] == 0]:
                _fails.pop(k, None)

def _clear_fails(key):
    with _fail_lock:
        _fails.pop(key, None)

#------Validation Helpers--------

def _clean_username(raw: str) -> str:
    name = (raw or "").strip().lower()
    if not USERNAME_RE.match(name):
        raise HTTPException(400, "Username must be 3-32 characters: letters, numbers, . _ -")
    return name


def _check_password(pw: str):
    if len(pw or "") < MIN_PASSWORD:
        raise HTTPException(400, f"Password must be at least {MIN_PASSWORD} characters.")
    if len(pw) > MAX_PASSWORD:
        raise HTTPException(400, f"Password must be at most {MAX_PASSWORD} characters.")


def _check_role(role: str):
    if role not in ROLES:
        raise HTTPException(400, "Role must be 'admin' or 'viewer'.")


def _public(row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "role": row["role"],
        "disabled": bool(row["disabled"]),
        "created_at": row["created_at"],
        "last_login": row["last_login"],
    }


def _active_admins(con, exclude_id: Optional[int] = None) -> int:
    sql, args = "SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0", []
    if exclude_id is not None:
        sql += " AND id != ?"
        args.append(exclude_id)
    return con.execute(sql, args).fetchone()[0]

