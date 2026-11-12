"""Local, thread-safe usage accounting; Python standard library only.

Each method serializes a short-lived SQLite WAL connection and closes it before
returning, including error paths. Transactions contain only local writes; no
request bodies, images, or plaintext API keys are stored. Filesystem paths only.
close() safely disarms the store and clears in-memory active requests.

Request timestamps are begin times. Ranges are [since, until). Retained details
are filtered exactly. Purged history uses overlapping UTC epoch-hour buckets;
only that purged portion has hour granularity. Unfiltered snapshots always use
lifetime hourly aggregates, which prune() never deletes. Token sums are None
when no corresponding counter was supplied, never inferred from other counters.
Partial usage counts as known if at least one valid counter was supplied.

Key group names are string IDs ('' for unauthenticated requests). Successful
requests have outcome='ok' and HTTP status 200..399. Revoking an existing key
returns True even when already revoked; an unknown ID returns False.
"""

import hashlib
import math
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from collections import Counter
from contextlib import contextmanager


RETENTION_DAYS = 30
_RETENTION_SECONDS = RETENTION_DAYS * 86400
_MAX_KEYS = 1000
_MAX_ACTIVE = 10000
_MAX_COUNT = 2 ** 53 - 1
_KEY_RE = re.compile(r"lbp_[A-Za-z0-9_-]{43}")
_SECRET_RE = re.compile(r"lbp_[A-Za-z0-9_-]{43,}")
_TOKENS = ("input_tokens", "output_tokens", "total_tokens")
_SUM_FIELDS = (
    "requests", "success", "failed", "in_bytes", "out_bytes", "duration_ms",
    "input_tokens", "output_tokens", "total_tokens", "usage_known",
    "usage_unknown", "input_known", "output_known", "total_known",
)
_FIELDS_SQL = ", ".join(_SUM_FIELDS)
_SUM_SQL = ", ".join("SUM({0}) AS {0}".format(f) for f in _SUM_FIELDS)


def _text(value, limit):
    if not isinstance(value, str):
        return ""
    value = "".join(c for c in value[:4096] if c.isprintable()).strip()
    return _SECRET_RE.sub("[redacted]", value)[:limit]


def _count(value, maximum=_MAX_COUNT):
    try:
        if isinstance(value, bool):
            return 0
        return min(maximum, max(0, int(value)))
    except (TypeError, ValueError, OverflowError):
        return 0


def _epoch(value):
    if isinstance(value, bool):
        raise ValueError("timestamp must be finite")
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("timestamp must be finite")
    return value


def _usage(value):
    """Accept normalized or OpenAI JSON/SSE usage counters, not payload bodies."""
    if not isinstance(value, dict):
        return None
    aliases = ("prompt_tokens", "completion_tokens", "total_tokens")
    result = {}
    for field, alias in zip(_TOKENS, aliases):
        number = value.get(field, value.get(alias))
        result[field] = (min(number, _MAX_COUNT)
                         if isinstance(number, int) and not isinstance(number, bool)
                         and number >= 0 else None)
    return result if any(n is not None for n in result.values()) else None


def _empty_metrics():
    return dict.fromkeys(_SUM_FIELDS, 0)


def _public_metrics(metrics):
    result = {f: metrics[f] for f in _SUM_FIELDS if not f.endswith("_known")}
    result["usage_known"] = metrics["usage_known"]
    for field, count in zip(_TOKENS, ("input_known", "output_known", "total_known")):
        result[field] = metrics[field] if metrics[count] else None
    result["avg_ms"] = (metrics["duration_ms"] / metrics["requests"]
                        if metrics["requests"] else 0.0)
    return result


class UsageStore:
    """Persistent API keys, heartbeats, and exactly-once local request metrics.

    Active requests exist only in memory and reset on restart. At most 10,000
    requests may be active, 1,000 keys may be live, and list_keys() returns at
    most the newest 1,000 keys. Exceeding either admission cap raises ValueError.
    """

    def __init__(self, path, clock=time.time):
        self._lock = threading.RLock()
        self._clock = clock
        self._active = {}
        self._active_ips = Counter()
        if str(path) == ":memory:":
            raise ValueError("UsageStore requires a filesystem database path")
        self._path = os.path.abspath(str(path))
        self._closed = False
        self._db = self._connect()
        try:
            columns = ", ".join(
                f + (" REAL" if f == "duration_ms" else " INTEGER") + " NOT NULL"
                for f in _SUM_FIELDS)
            self._db.executescript("""
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=NORMAL;
                CREATE TABLE IF NOT EXISTS api_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    key_hash TEXT NOT NULL UNIQUE,
                    label TEXT NOT NULL, prefix TEXT NOT NULL,
                    created REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS devices (
                    ip TEXT PRIMARY KEY, last_seen REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS metadata (
                    name TEXT PRIMARY KEY, value REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS details (
                    request_id TEXT PRIMARY KEY, ts REAL NOT NULL,
                    ip TEXT NOT NULL, model TEXT NOT NULL,
                    key_id INTEGER NOT NULL, path TEXT NOT NULL,
                    method TEXT NOT NULL, status INTEGER NOT NULL,
                    outcome TEXT NOT NULL, %s
                );
                CREATE INDEX IF NOT EXISTS details_ts ON details(ts);
                CREATE TABLE IF NOT EXISTS hourly (
                    hour INTEGER NOT NULL, ip TEXT NOT NULL,
                    model TEXT NOT NULL, key_id INTEGER NOT NULL, %s,
                    PRIMARY KEY (hour, ip, model, key_id)
                ) WITHOUT ROWID;
            """ % (columns, columns))
            self._pruned_at = _epoch(self._clock())
            with self._db:
                self._db.execute("BEGIN IMMEDIATE")
                self._prune_locked(self._pruned_at)
        finally:
            self._db.close()
            self._db = None

    def _connect(self):
        db = sqlite3.connect(self._path, timeout=10)
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA synchronous=NORMAL")
            return db
        except BaseException:
            db.close()
            raise

    @contextmanager
    def _connection(self):
        with self._lock:
            if self._closed:
                raise RuntimeError("UsageStore is closed")
            self._db = self._connect()
            try:
                yield self._db
            finally:
                self._db.close()
                self._db = None

    def _heartbeat(self, ip, now):
        self._db.execute("""
            INSERT INTO devices(ip, last_seen) VALUES (?, ?)
            ON CONFLICT(ip) DO UPDATE SET last_seen=MAX(last_seen, excluded.last_seen)
        """, (ip, now))

    def issue_key(self, label="", ip=""):
        label, ip = _text(label, 128), _text(ip, 64)
        with self._connection() as db:
            now = _epoch(self._clock())
            with db:
                db.execute("BEGIN IMMEDIATE")
                if db.execute("SELECT COUNT(*) FROM api_keys WHERE revoked=0").fetchone()[0] >= _MAX_KEYS:
                    raise ValueError("live API key limit reached")
                raw = "lbp_" + secrets.token_urlsafe(32)
                prefix = raw[:12]
                row = db.execute("""
                    INSERT INTO api_keys(key_hash, label, prefix, created)
                    VALUES (?, ?, ?, ?)
                """, (hashlib.sha256(raw.encode("ascii")).hexdigest(), label, prefix, now))
                key_id = row.lastrowid
                if ip:
                    self._heartbeat(ip, now)
            return dict(id=key_id, key=raw, label=label, prefix=prefix,
                        created=now, revoked=False)

    def list_keys(self):
        with self._connection() as db:
            rows = db.execute("""
                SELECT id, label, prefix, created, revoked FROM api_keys
                ORDER BY id DESC LIMIT 1000
            """).fetchall()
            return [dict(row, revoked=bool(row["revoked"])) for row in rows]

    def revoke_key(self, id):
        with self._connection() as db:
            if not isinstance(id, int) or isinstance(id, bool) or not 0 < id <= _MAX_COUNT:
                return False
            with db:
                row = db.execute("UPDATE api_keys SET revoked=1 WHERE id=?", (id,))
            return row.rowcount > 0

    def resolve_key(self, raw):
        with self._connection() as db:
            if not isinstance(raw, str) or _KEY_RE.fullmatch(raw) is None:
                return None
            digest = hashlib.sha256(raw.encode("ascii")).hexdigest()
            row = db.execute("""
                SELECT id, label FROM api_keys WHERE key_hash=? AND revoked=0
            """, (digest,)).fetchone()
            return dict(row) if row is not None else None

    def touch(self, ip):
        ip = _text(ip, 64)
        with self._connection() as db:
            with db:
                self._heartbeat(ip, _epoch(self._clock()))

    def begin(self, ip, key_id, model, path, method):
        ip, model = _text(ip, 64), _text(model, 128)
        # Query strings/fragments can contain credentials, so retain only routes.
        path = _text(path, 512).split("?", 1)[0].split("#", 1)[0]
        method = _text(method, 16).upper()
        key_id = (key_id if isinstance(key_id, int) and not isinstance(key_id, bool)
                  and 0 < key_id <= _MAX_COUNT else 0)
        with self._connection() as db:
            if len(self._active) >= _MAX_ACTIVE:
                raise ValueError("active request limit reached")
            now = _epoch(self._clock())
            request_id = uuid.uuid4().hex
            with db:
                self._heartbeat(ip, now)
            self._active[request_id] = (now, ip, key_id, model, path, method)
            self._active_ips[ip] += 1
            return request_id

    def finish(self, request_id, status, in_bytes, out_bytes, duration_ms,
               usage=None, outcome="ok"):
        with self._connection() as db:
            if not isinstance(request_id, str) or request_id not in self._active:
                return False
            ts, ip, key_id, model, path, method = self._active[request_id]
            status = _count(status, 599)
            status = status if status >= 100 else 0
            outcome = _text(outcome, 32)
            normalized = _usage(usage)
            try:
                duration = float(duration_ms)
            except (TypeError, ValueError, OverflowError):
                duration = 0.0
            duration = min(_MAX_COUNT, max(0.0, duration)) if math.isfinite(duration) else 0.0
            success = int(outcome == "ok" and 200 <= status < 400)
            metrics = _empty_metrics()
            metrics.update(requests=1, success=success, failed=1-success,
                           in_bytes=_count(in_bytes), out_bytes=_count(out_bytes),
                           duration_ms=duration, usage_known=int(normalized is not None),
                           usage_unknown=int(normalized is None))
            for field, count in zip(_TOKENS, ("input_known", "output_known", "total_known")):
                number = normalized[field] if normalized is not None else None
                metrics[field] = number if number is not None else 0
                metrics[count] = int(number is not None)
            values = tuple(metrics[f] for f in _SUM_FIELDS)
            now = _epoch(self._clock())
            should_prune = now - self._pruned_at >= 3600
            with db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("""
                    INSERT INTO details(request_id, ts, ip, model, key_id, path,
                                        method, status, outcome, %s)
                    VALUES (%s)
                """ % (_FIELDS_SQL, ",".join("?" for _ in range(9 + len(values)))),
                           (request_id, ts, ip, model, key_id, path, method, status, outcome) + values)
                updates = ", ".join("{0}={0}+excluded.{0}".format(f) for f in _SUM_FIELDS)
                db.execute("""
                    INSERT INTO hourly(hour, ip, model, key_id, %s) VALUES (%s)
                    ON CONFLICT(hour, ip, model, key_id) DO UPDATE SET %s
                """ % (_FIELDS_SQL, ",".join("?" for _ in range(4 + len(values))), updates),
                           (int(ts // 3600) * 3600, ip, model, key_id) + values)
                self._heartbeat(ip, now)
                if should_prune:
                    self._prune_locked(now)
            if should_prune:
                self._pruned_at = now
            del self._active[request_id]
            self._active_ips[ip] -= 1
            if not self._active_ips[ip]:
                del self._active_ips[ip]
            return True

    def devices(self):
        with self._connection() as db:
            now = _epoch(self._clock())
            rows = db.execute("""
                SELECT d.ip, d.last_seen, COALESCE(h.requests, 0) AS requests,
                       COALESCE(h.in_bytes, 0) AS in_bytes,
                       COALESCE(h.out_bytes, 0) AS out_bytes
                FROM devices d LEFT JOIN (
                    SELECT ip, SUM(requests) AS requests, SUM(in_bytes) AS in_bytes,
                           SUM(out_bytes) AS out_bytes FROM hourly GROUP BY ip
                ) h ON h.ip=d.ip ORDER BY d.last_seen DESC, d.ip
            """).fetchall()
            result = []
            for row in rows:
                item = dict(row)
                active = self._active_ips.get(item["ip"], 0)
                item.update(active=active, online=bool(active or now-item["last_seen"] < 300))
                result.append(item)
            return result

    def _filtered_metrics(self, since, until):
        """Combine exact details with purged aggregate residuals, without overlap."""
        db = self._db
        where, params = [], []
        if since is not None:
            where.append("ts>=?")
            params.append(since)
        if until is not None:
            where.append("ts<?")
            params.append(until)
        detailed = "SELECT ip, model, key_id, " + _FIELDS_SQL + " FROM details"
        detailed += " WHERE " + " AND ".join(where)
        floor = db.execute("SELECT value FROM metadata WHERE name='detail_floor'").fetchone()[0]
        old_end = min(until, floor) if until is not None else floor
        if since is not None and since >= old_end:
            return db.execute("SELECT ip, model, key_id, " + _SUM_SQL + " FROM (" +
                              detailed + ") GROUP BY ip, model, key_id", params).fetchall()
        # Subtract ALL retained details in an old bucket before including its
        # purged remainder. Even the partly-purged boundary hour is counted once.
        # Avoid SQLite's optional mathematical functions (not in all builds).
        hour_expr = "(CAST(ts / 3600.0 AS INTEGER) - (ts < CAST(ts / 3600.0 AS INTEGER) * 3600)) * 3600"
        remaining = ", ".join("a.{0}-COALESCE(d.{0},0) AS {0}".format(f) for f in _SUM_FIELDS)
        old_where = ["a.hour<?"]
        old_params = [old_end]
        retained_where = ["ts<?"]
        retained_params = [math.ceil(old_end / 3600) * 3600]
        if since is not None:
            old_where.append("a.hour+3600>?")
            old_params.append(since)
            retained_where.append("ts>=?")
            retained_params.append(math.floor(since / 3600) * 3600)
        old = """
            SELECT a.ip, a.model, a.key_id, %s FROM hourly a
            LEFT JOIN (
                SELECT %s AS hour, ip, model, key_id, %s FROM details
                WHERE %s GROUP BY hour, ip, model, key_id
            ) d ON a.hour=d.hour AND a.ip=d.ip AND a.model=d.model AND a.key_id=d.key_id
            WHERE %s
        """ % (remaining, hour_expr, _SUM_SQL, " AND ".join(retained_where),
               " AND ".join(old_where))
        return db.execute("SELECT ip, model, key_id, " + _SUM_SQL + " FROM (" +
                          detailed + " UNION ALL " + old +
                          ") GROUP BY ip, model, key_id HAVING SUM(requests)>0",
                          params + retained_params + old_params).fetchall()

    def snapshot(self, since=None, until=None, limit=100):
        since = _epoch(since) if since is not None else None
        until = _epoch(until) if until is not None else None
        if since is not None and until is not None and since > until:
            raise ValueError("since must not exceed until")
        limit = _count(limit, 200)
        with self._connection() as db:
            # One read transaction also keeps independent store instances from
            # changing the aggregate/detail pair midway through a snapshot.
            with db:
                db.execute("BEGIN")
                if since is None and until is None:
                    rows = db.execute("SELECT ip, model, key_id, " + _SUM_SQL +
                                      " FROM hourly GROUP BY ip, model, key_id").fetchall()
                else:
                    rows = self._filtered_metrics(since, until)
                summary = _empty_metrics()
                grouped = {"models": {}, "ips": {}, "keys": {}}
                for row in rows:
                    for field in _SUM_FIELDS:
                        summary[field] += row[field]
                    names = (row["model"], row["ip"], str(row["key_id"]) if row["key_id"] else "")
                    for kind, name in zip(("models", "ips", "keys"), names):
                        metrics = grouped[kind].setdefault(name, _empty_metrics())
                        for field in _SUM_FIELDS:
                            metrics[field] += row[field]
                where, params = [], []
                if since is not None:
                    where.append("ts>=?")
                    params.append(since)
                if until is not None:
                    where.append("ts<?")
                    params.append(until)
                query = "SELECT * FROM details"
                if where:
                    query += " WHERE " + " AND ".join(where)
                query += " ORDER BY ts DESC, rowid DESC LIMIT ?"
                detail_rows = db.execute(query, params + [limit]).fetchall()
            details = []
            for row in detail_rows:
                item = {f: row[f] for f in ("ts", "ip", "model", "key_id", "path", "method",
                                            "status", "outcome", "in_bytes", "out_bytes", "duration_ms")}
                item["key_id"] = item["key_id"] or None
                for field, count in zip(_TOKENS, ("input_known", "output_known", "total_known")):
                    item[field] = row[field] if row[count] else None
                details.append(item)
            result = dict(summary=_public_metrics(summary), details=details,
                          retention_days=RETENTION_DAYS, active=len(self._active))
            for kind, groups in grouped.items():
                result[kind] = [dict(name=name, **_public_metrics(metrics))
                                for name, metrics in sorted(groups.items(),
                                    key=lambda pair: (-pair[1]["requests"], pair[0]))]
            return result

    def _prune_locked(self, now):
        cutoff = now - _RETENTION_SECONDS
        row = self._db.execute("DELETE FROM details WHERE ts<?", (cutoff,))
        self._db.execute("""
            INSERT INTO metadata(name, value) VALUES ('detail_floor', ?)
            ON CONFLICT(name) DO UPDATE SET value=MAX(value, excluded.value)
        """, (cutoff,))
        return row.rowcount

    def prune(self, now=None):
        with self._connection() as db:
            now = _epoch(self._clock() if now is None else now)
            with db:
                db.execute("BEGIN IMMEDIATE")
                deleted = self._prune_locked(now)
            self._pruned_at = now
            return deleted

    def close(self):
        with self._lock:
            self._closed = True
            self._active.clear()
            self._active_ips.clear()
