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

#---------Dependencies-----------
def current_user(authorization: Optional[str] = Header(default=None)) -> dict:
    """Use as `user: dict = Depends(current_user)` to require a signed-in user."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Not signed in", headers={"WWW-Authenticate": "Bearer"})
    token_hash = _hash_token(authorization[7:].strip())
    with db() as con:
        row = con.execute(
            """SELECT u.id, u.username, u.role, u.disabled
               FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token_hash = ? AND s.expires_at > ?""",
            (token_hash, time.time()),
        ).fetchone()
    if not row or row["disabled"]:
        raise HTTPException(401, "Session expired", headers={"WWW-Authenticate": "Bearer"})
    return {"id": row["id"], "username": row["username"], "role": row["role"], "token_hash": token_hash}


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, "Administrator access required")
    return user


#--------------Request Bodies------------

class Credentials(BaseModel):
    username: str
    password: str
    remember: bool =False


class NewUser(BaseModel):
    username: str
    password: str
    role: str="viewer"


class UserPatch(BaseModel):
    role: Optional[str]=None
    disabled: Optional[bool]=None
    password: Optional[str]=None


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _session_payload(con, row, remember: bool, request: Request)->dict:
    token, expires= _create_session(con,row["id"], remember,_client_ip(request))
    return {"token": token, "expires_at":expires, "user": _public(row)}


#-------Sign in/out logic--------

@router.get("/auth/status")
def auth_status():
    """Logic for deciding whether to display la login page or admin account create"""
    with db() as con:
        count =con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    return {"setup_required": count==0}


@router.post("/auth/setup")
def auth_setup(body: Credentials, request: Request):
    """New first admin user creatore page. Dies alone never to be tuched again after first user created"""
    username=_clean_username(body.username)
    _check_password(body.password)
    with db() as con:
        con.execute("BEGIN IMMEDIATE")
        if con.execute("SELECT COUNT(*) FROM users").fetchone()[0]>0:
            raise HTTPException(409, "Setup already completed. Please sign in.")
        con.execute(
            "INSERT INTO users (username, pw_hash,role,created_at,last_login) VALUES (?,?,?,?,?)",
            (username,hash_password(body.password),"admin",time.time(),time.time()),
        )
        row= con.execute("SELECT * FROM users WHERE username = ?",(username,)).fetchone()
        payload=_session_payload(con,row,body.remember,request)
    log.info("first admin'%s' created",username)
    return payload


@router.post("/auth/login")
def auth_login(body:Credentials,request:Request):
    username=(body.username or "").strip().lower()
    key=(username,_client_ip(request))
    _check_lock(key)
    with db() as con:
        row=con.execute("SELECT * FROM users WHERE username = ?",(username,)).fetchone()
        good=verify_password(body.password or "", row["pw_hash"] if row else _DUMMY_HASH)
        if not (row and good and not row["disabled"]):
            _record_fail(key)
            log.warning("failed sign-in for '%s' from %s", username,key[1])
            raise HTTPException(401, "Invalid username or password.")
        _clear_fails(key)
        con.execute("UPDATE users SET last_login=? WHERE id= ?", (time.time(),row["id"]))
        payload=_session_payload(con,row,body.remember,request)
    log.info(" '%s' signed into existence",username)
    return payload


@router.post("/auth/logout")
def auth_logout(user: dict=Depends(current_user)):
    with db() as con:
        con.execute("DELETE FROM sessions WHERE token_hash = ?", (user["token_hash"],))
    return{"ok": True}


@router.get("/auth/me")
def auth_me(user: dict=Depends(current_user)):
    return{"id": user["id"], "username": user["username"], "role": user["role"]}


@router.post("/auth/change-password")
def auth_change_password(body: PasswordChange, user: dict=Depends(current_user)):
    _check_password(body.new_password)
    with db() as con:
        row=con.execute("SELECT pw_hash FROM users WHERE id = ?",(user["id"],)).fetchone()
        if not row or not verify_password(body.current_password or "", row["ps_hash"]):
            raise HTTPException(400, "Current password is incorrect.")
        con.execute("UPDATE users SET pw_hash = ? WHERE id = ?",(hash_password(body.new_password),user["id"]))
        con.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user["id"],user["token_hash"]))
    return{"ok": True}


#-----------User Management for da boss(da boss=admin only)--------------

@router.get("/users")
def users_list(_admin: dict=Depends(require_admin)):
    with db() as con:
        rows= con.execute("SELECT * FROM users ORDER BY username").fetchall()
    return [_public(r) for r in rows]


@router.post("/users", status_code=201)
def users_create(body: NewUser, _admin: dict=Depends(require_admin)):
    username=_clean_username(body.username)
    _check_password(body.password)
    _check_role(body.role)
    with db() as con:
        try:
            con.execute(
                "INSERT INTO users (username, pw_hash,role,created_at) VALUES (?,?,?,?)",
                (username, hash_password(body.password), body.role,time.time()),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "That Username is already taken.")
        row=con.execute("SELECT * FROM users  WHERE username = ?",(username,)).fetchone()
    return _public(row)


@router.patch("/users/{user_id}")
def users_update(user_id: int,body: UserPatch,admin: dict= Depends(require_admin)):
    with db() as con:
        target=con.execute("SELECT * FROM users WHERE id = ?",(user_id,)).fetchone()
        if not target:
            raise HTTPException(404, "User not found")

        if body.role is not None:
            _check_role(body.role)
        if body.password is not None:
            _check_password(body.password)
        if body.disabled and user_id==admin["id"]:
            raise HTTPException(400, "You cannot disable your own account")

        losing_admin= target["role"]=="admin" and not target["disabled"] and (
            (body.role is not None and body.role != "admin") or body.disabled is True
        )
        if losing_admin and _active_admins(con,exclude_id=user_id)==0:
            raise HTTPException(400, "Atleast one active admin is required.")

        if body.role is not None:
            con.execute("UPDATE users SET role = ? WHERE id = ?", (body.role, user_id))
        if body.disabled is not None:
            con.execute("UPDATE users SET disabled =? WHERE id=?",(int(body.disabled),user_id))
        if body.password is not None:
            con.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (hash_password(body.password), user_id))
        if body.password is not None or body.disabled:
            con.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))  # force sign-out(YEEET)
        row = con.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _public(row)


@router.delete("/users/{user_id}")
def users_delete(user_id: int, admin: dict=Depends(require_admin)):
    if user_id==admin["id"]:
        raise HTTPException(400, "You cannot delete your own account.")
    with db() as con:
        target=con.execute("SELECT * FROM users WHERE id = ?",(user_id,)).fetchone()
        if not target:
            raise HTTPException(404, "User not found.")
        if target["role"]=="admin" and not target["disabled"] and _active_admins(con, exclude_id=user_id)==0:
            raise HTTPException(400, "At least one active administrator is required.")
        con.execute("DELETE FROM users WHERE id= ?",(user_id))
    return{"ok": True}


init_db()