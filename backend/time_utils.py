from __future__ import annotations

from datetime import datetime, timedelta, timezone


UTC_PLUS_8 = timezone(timedelta(hours=8))


def china_now() -> datetime:
    return datetime.now(UTC_PLUS_8)


def now_iso() -> str:
    return china_now().isoformat(timespec="seconds")


def today_iso_date() -> str:
    return china_now().date().isoformat()


def parse_iso_datetime(value: str | None) -> datetime:
    if not value:
        return datetime.min.replace(tzinfo=UTC_PLUS_8)

    normalized = value.strip()
    if not normalized:
        return datetime.min.replace(tzinfo=UTC_PLUS_8)

    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=UTC_PLUS_8)

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC_PLUS_8)
    return parsed.astimezone(UTC_PLUS_8)
