from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import pymysql
from fastapi import HTTPException, Request, Response


SESSION_COOKIE_NAME = "jc_session"
SESSION_TTL_DAYS = 30
REGISTER_GRANT_POINTS = 1000
SECURITY_QUESTION_COUNT = 3
PASSWORD_RESET_CHALLENGE_TTL_SECONDS = 10 * 60

SECURITY_QUESTIONS = [
    {"key": "first_school", "text": "你的第一所学校叫什么？"},
    {"key": "childhood_friend", "text": "你童年最好的朋友叫什么？"},
    {"key": "favorite_teacher", "text": "你印象最深的老师叫什么？"},
    {"key": "birth_city", "text": "你出生的城市是哪里？"},
    {"key": "first_pet", "text": "你的第一只宠物叫什么？"},
    {"key": "favorite_book", "text": "你最喜欢的一本书叫什么？"},
    {"key": "mother_hometown", "text": "你母亲的家乡在哪里？"},
    {"key": "first_job", "text": "你的第一份工作或实习单位叫什么？"},
]
SECURITY_QUESTION_KEYS = {item["key"] for item in SECURITY_QUESTIONS}


@dataclass
class AuthUser:
    id: int
    external_id: str
    username: str
    display_name: str

    def public(self, credits: int | None = None) -> dict[str, Any]:
        return {
            "id": self.external_id,
            "username": self.username,
            "displayName": self.display_name or self.username,
            "credits": credits,
        }


def db_config() -> dict[str, Any]:
    return {
        "host": os.getenv("AUTH_DB_HOST") or os.getenv("DB_HOST") or "127.0.0.1",
        "port": int(os.getenv("AUTH_DB_PORT") or os.getenv("DB_PORT") or os.getenv("MYSQL_HOST_PORT") or "3306"),
        "user": os.getenv("AUTH_DB_USER") or os.getenv("DB_USER") or "root",
        "password": os.getenv("AUTH_DB_PASSWORD") or os.getenv("DB_PASSWORD") or os.getenv("MYSQL_ROOT_PASSWORD") or "",
        "database": os.getenv("AUTH_DB_NAME") or os.getenv("DB_NAME") or "jingchuang_ai",
        "charset": "utf8mb4",
        "cursorclass": pymysql.cursors.DictCursor,
        "autocommit": False,
    }


def get_connection():
    try:
        return pymysql.connect(**db_config())
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"账号数据库连接失败：{exc}") from exc


def normalize_username(username: Any) -> str:
    return str(username or "").strip()


def normalize_security_answer(answer: Any) -> str:
    return " ".join(str(answer or "").strip().lower().split())


def assert_credentials(payload: dict[str, Any]) -> tuple[str, str]:
    username = normalize_username(payload.get("username"))
    password = str(payload.get("password") or "")
    if len(username) < 3 or len(username) > 64:
        raise HTTPException(status_code=400, detail="用户名长度需为 3-64 个字符")
    if len(password) < 6 or len(password) > 128:
        raise HTTPException(status_code=400, detail="密码长度需为 6-128 个字符")
    return username, password


def assert_new_password(password_value: Any) -> str:
    password = str(password_value or "")
    if len(password) < 6 or len(password) > 128:
        raise HTTPException(status_code=400, detail="密码长度需为 6-128 个字符")
    return password


def assert_security_questions(items: Any) -> list[dict[str, str]]:
    if not isinstance(items, list) or len(items) != SECURITY_QUESTION_COUNT:
        raise HTTPException(status_code=400, detail="请设置 3 个安全问题")
    seen: set[str] = set()
    normalized: list[dict[str, str]] = []
    for item in items:
        question_key = str((item or {}).get("questionKey") or "").strip()
        answer = normalize_security_answer((item or {}).get("answer"))
        if question_key not in SECURITY_QUESTION_KEYS:
            raise HTTPException(status_code=400, detail="安全问题无效")
        if question_key in seen:
            raise HTTPException(status_code=400, detail="安全问题不能重复")
        if len(answer) < 2 or len(answer) > 80:
            raise HTTPException(status_code=400, detail="安全问题答案需为 2-80 个字符")
        seen.add(question_key)
        normalized.append({"questionKey": question_key, "answer": answer})
    return normalized


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt.encode("utf-8"), n=16384, r=8, p=1, dklen=64)
    return f"scrypt:{salt}:{derived.hex()}"


def verify_password(password: str, password_hash: str | None) -> bool:
    parts = str(password_hash or "").split(":")
    if len(parts) != 3 or parts[0] != "scrypt":
        return False
    _, salt, stored_key = parts
    try:
        derived = hashlib.scrypt(password.encode("utf-8"), salt=salt.encode("utf-8"), n=16384, r=8, p=1, dklen=64)
        expected = bytes.fromhex(stored_key)
    except Exception:
        return False
    return hmac.compare_digest(derived, expected)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def cookie_options(request: Request, expires_at: datetime) -> dict[str, Any]:
    forwarded_proto = str(request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    secure = request.url.scheme == "https" or forwarded_proto == "https"
    return {
        "httponly": True,
        "samesite": "lax",
        "secure": secure,
        "path": "/",
        "expires": expires_at,
    }


def get_session_token(request: Request) -> str:
    return request.cookies.get(SESSION_COOKIE_NAME, "")


def find_user_by_username(connection, username: str) -> dict[str, Any] | None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, external_id AS externalId, username, password_hash AS passwordHash, display_name AS displayName
            FROM users
            WHERE username = %s
            LIMIT 1
            """,
            (username,),
        )
        return cursor.fetchone()


def find_user_by_id(connection, user_id: int) -> dict[str, Any] | None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, external_id AS externalId, username, display_name AS displayName
            FROM users
            WHERE id = %s
            LIMIT 1
            """,
            (user_id,),
        )
        return cursor.fetchone()


def get_user_credits(connection, user_id: int) -> int:
    with connection.cursor() as cursor:
        cursor.execute("SELECT balance FROM credit_accounts WHERE user_id = %s LIMIT 1", (user_id,))
        row = cursor.fetchone()
    return int(row["balance"]) if row else 0


def create_session(connection, user_id: int) -> tuple[str, datetime]:
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_TTL_DAYS)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO auth_sessions (user_id, token_hash, expires_at)
            VALUES (%s, %s, %s)
            """,
            (user_id, token_hash(token), expires_at.replace(tzinfo=None)),
        )
    return token, expires_at


def public_user_from_row(connection, row: dict[str, Any]) -> dict[str, Any]:
    user = AuthUser(
        id=int(row["id"]),
        external_id=row["externalId"],
        username=row.get("username") or row.get("displayName") or "",
        display_name=row.get("displayName") or row.get("username") or "",
    )
    return user.public(get_user_credits(connection, user.id))


def current_user(request: Request) -> AuthUser:
    token = get_session_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="请先登录")
    connection = get_connection()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT u.id, u.external_id AS externalId, u.username, u.display_name AS displayName, s.id AS sessionId
                FROM auth_sessions s
                INNER JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = %s AND s.expires_at > CURRENT_TIMESTAMP
                LIMIT 1
                """,
                (token_hash(token),),
            )
            row = cursor.fetchone()
            if not row:
                raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
            cursor.execute("UPDATE auth_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = %s", (row["sessionId"],))
        connection.commit()
        return AuthUser(
            id=int(row["id"]),
            external_id=row["externalId"],
            username=row.get("username") or row.get("displayName") or "",
            display_name=row.get("displayName") or row.get("username") or "",
        )
    finally:
        connection.close()


def auth_state(request: Request) -> dict[str, Any]:
    user = current_user(request)
    connection = get_connection()
    try:
        return {"user": user.public(get_user_credits(connection, user.id))}
    finally:
        connection.close()


def register(payload: dict[str, Any], request: Request, response: Response) -> dict[str, Any]:
    username, password = assert_credentials(payload)
    security_questions = assert_security_questions(payload.get("securityQuestions"))
    connection = get_connection()
    try:
        existing = find_user_by_username(connection, username)
        if existing:
            raise HTTPException(status_code=409, detail="用户名已存在")
        password_hash = hash_password(password)
        external_id = f"user-{uuid4()}"
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO users (external_id, username, password_hash, display_name)
                VALUES (%s, %s, %s, %s)
                """,
                (external_id, username, password_hash, username),
            )
            user_id = int(cursor.lastrowid)
            cursor.execute(
                "INSERT INTO credit_accounts (user_id, balance) VALUES (%s, %s)",
                (user_id, REGISTER_GRANT_POINTS),
            )
            cursor.execute(
                """
                INSERT INTO credit_transactions (user_id, type, amount, balance_after, memo)
                VALUES (%s, 'grant', %s, %s, 'register initial credits')
                """,
                (user_id, REGISTER_GRANT_POINTS, REGISTER_GRANT_POINTS),
            )
            for item in security_questions:
                cursor.execute(
                    """
                    INSERT INTO user_security_questions (user_id, question_key, answer_hash)
                    VALUES (%s, %s, %s)
                    """,
                    (user_id, item["questionKey"], hash_password(item["answer"])),
                )
            session_token, expires_at = create_session(connection, user_id)
        connection.commit()
        response.set_cookie(SESSION_COOKIE_NAME, session_token, **cookie_options(request, expires_at))
        return {
            "user": {
                "id": external_id,
                "username": username,
                "displayName": username,
                "credits": REGISTER_GRANT_POINTS,
            }
        }
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def login(payload: dict[str, Any], request: Request, response: Response) -> dict[str, Any]:
    username, password = assert_credentials(payload)
    connection = get_connection()
    try:
        user = find_user_by_username(connection, username)
        if not user or not verify_password(password, user.get("passwordHash")):
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        session_token, expires_at = create_session(connection, int(user["id"]))
        connection.commit()
        response.set_cookie(SESSION_COOKIE_NAME, session_token, **cookie_options(request, expires_at))
        return {"user": public_user_from_row(connection, user)}
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def logout(request: Request, response: Response) -> dict[str, bool]:
    token = get_session_token(request)
    if token:
        connection = get_connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM auth_sessions WHERE token_hash = %s", (token_hash(token),))
            connection.commit()
        finally:
            connection.close()
    response.delete_cookie(SESSION_COOKIE_NAME, path="/", httponly=True, samesite="lax")
    return {"ok": True}


def reset_secret() -> str:
    return (
        os.getenv("AUTH_RESET_SECRET")
        or os.getenv("SESSION_SECRET")
        or db_config()["password"]
        or "jingchuang-ai-password-reset-dev-secret"
    )


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def sign_reset_challenge(payload: dict[str, Any]) -> str:
    body = b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(reset_secret().encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest()
    return f"{body}.{b64url_encode(signature)}"


def read_reset_challenge(challenge_id: str) -> dict[str, Any]:
    try:
        body, signature = str(challenge_id or "").split(".", 1)
        expected = b64url_encode(hmac.new(reset_secret().encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError("bad signature")
        payload = json.loads(b64url_decode(body).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="找回密码验证已失效，请重新获取问题") from exc
    if not payload.get("userId") or int(payload.get("expiresAt", 0)) < int(datetime.now(timezone.utc).timestamp()):
        raise HTTPException(status_code=400, detail="找回密码验证已失效，请重新获取问题")
    return payload


def password_reset_challenge(payload: dict[str, Any]) -> dict[str, Any]:
    username = normalize_username(payload.get("username"))
    if not username:
        raise HTTPException(status_code=400, detail="请输入用户名")
    connection = get_connection()
    try:
        user = find_user_by_username(connection, username)
        if not user:
            raise HTTPException(status_code=404, detail="账号未设置安全问题，无法通过此方式找回密码")
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT question_key AS questionKey FROM user_security_questions WHERE user_id = %s",
                (user["id"],),
            )
            rows = cursor.fetchall()
        candidates = [row for row in rows if row["questionKey"] in SECURITY_QUESTION_KEYS]
        if not candidates:
            raise HTTPException(status_code=404, detail="账号未设置安全问题，无法通过此方式找回密码")
        chosen = secrets.choice(candidates)
        challenge = sign_reset_challenge(
            {
                "userId": int(user["id"]),
                "username": username,
                "questionKey": chosen["questionKey"],
                "expiresAt": int((datetime.now(timezone.utc) + timedelta(seconds=PASSWORD_RESET_CHALLENGE_TTL_SECONDS)).timestamp()),
            }
        )
        question_text = next(item["text"] for item in SECURITY_QUESTIONS if item["key"] == chosen["questionKey"])
        return {"challengeId": challenge, "question": {"key": chosen["questionKey"], "text": question_text}}
    finally:
        connection.close()


def password_reset(payload: dict[str, Any]) -> dict[str, bool]:
    challenge = read_reset_challenge(str(payload.get("challengeId") or ""))
    answer = normalize_security_answer(payload.get("answer"))
    new_password = assert_new_password(payload.get("newPassword"))
    connection = get_connection()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT answer_hash AS answerHash
                FROM user_security_questions
                WHERE user_id = %s AND question_key = %s
                LIMIT 1
                """,
                (challenge["userId"], challenge["questionKey"]),
            )
            row = cursor.fetchone()
            if not row or not verify_password(answer, row.get("answerHash")):
                raise HTTPException(status_code=401, detail="安全问题答案错误")
            cursor.execute(
                "UPDATE users SET password_hash = %s WHERE id = %s",
                (hash_password(new_password), challenge["userId"]),
            )
            cursor.execute("DELETE FROM auth_sessions WHERE user_id = %s", (challenge["userId"],))
        connection.commit()
        return {"ok": True}
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

