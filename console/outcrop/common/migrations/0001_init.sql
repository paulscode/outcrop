-- Outcrop schema v1.  Times are Unix seconds (REAL).  JSON columns hold JSON text.

CREATE TABLE tokens (
    id            TEXT PRIMARY KEY,               -- the public ID (8 base62 characters), shown in the UI and logs
    name          TEXT NOT NULL,
    notes         TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT 'user',   -- user | local-tools
    scopes        TEXT NOT NULL DEFAULT 'inference',      -- comma-separated: inference, telemetry, admin
    listeners     TEXT NOT NULL DEFAULT 'openai,ollama',  -- comma-separated: openai (8080), ollama (11434)
    cidrs         TEXT NOT NULL DEFAULT '[]',     -- JSON list of networks; empty: any address
    expires_at    REAL,                           -- NULL: never
    rpm           INTEGER,                        -- requests per minute, NULL: no limit
    concurrency   INTEGER,                        -- requests at once, NULL: no limit
    imported      INTEGER NOT NULL DEFAULT 0,
    hint          TEXT NOT NULL DEFAULT '',       -- first characters of the token, to recognize it
    created_at    REAL NOT NULL,
    created_by    TEXT NOT NULL DEFAULT '',
    rotated_at    REAL,
    rotated_by    TEXT,
    revoked_at    REAL,
    revoked_by    TEXT,
    revoke_reason TEXT,
    last_used_at  REAL,
    last_ip       TEXT,
    last_app      TEXT
);
CREATE UNIQUE INDEX tokens_active_name ON tokens(name) WHERE revoked_at IS NULL;

CREATE TABLE token_secrets (
    hmac       TEXT PRIMARY KEY,                  -- HMAC-SHA256(pepper, token), hex
    token_id   TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    expires_at REAL                               -- set on the old secret during a rotation grace
);
CREATE INDEX token_secrets_token ON token_secrets(token_id);

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,                     -- JSON
    updated_at REAL NOT NULL,
    updated_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE users (
    id             INTEGER PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE,
    pw_hash        TEXT NOT NULL,
    created_at     REAL NOT NULL,
    pw_changed_at  REAL NOT NULL
);

CREATE TABLE sessions (
    id_hash      TEXT PRIMARY KEY,                -- SHA-256 of the session ID; the ID itself is only in the cookie
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   REAL NOT NULL,
    last_seen_at REAL NOT NULL,
    expires_at   REAL NOT NULL,                   -- absolute limit
    remember     INTEGER NOT NULL DEFAULT 0,
    ip           TEXT,
    user_agent   TEXT,
    reauth_at    REAL                             -- the last time the password was entered in this session
);

CREATE TABLE login_attempts (
    id       INTEGER PRIMARY KEY,
    at       REAL NOT NULL,
    ip       TEXT NOT NULL,
    username TEXT,
    ok       INTEGER NOT NULL
);
CREATE INDEX login_attempts_ip ON login_attempts(ip, at);

CREATE TABLE requests (
    id             INTEGER PRIMARY KEY,
    rid            TEXT NOT NULL,                 -- the gateway's request ID (X-Request-Id)
    started_at     REAL NOT NULL,
    first_byte_at  REAL,
    ended_at       REAL,
    listener       TEXT NOT NULL,                 -- openai | ollama
    client_ip      TEXT,
    user_agent     TEXT,
    app            TEXT,
    token_id       TEXT,
    auth           TEXT NOT NULL,                 -- token | open | tokenless | public | denied
    auth_reason    TEXT,
    method         TEXT NOT NULL,
    path           TEXT NOT NULL,
    route_class    TEXT NOT NULL,
    model          TEXT,
    stream         INTEGER,
    status         INTEGER,
    outcome        TEXT,                          -- ok | error | client_gone | cancelled | denied | held_timeout | upstream_down
    held_ms        REAL,
    bytes_in       INTEGER,
    bytes_out      INTEGER,
    prompt_tokens  INTEGER,
    output_tokens  INTEGER,
    reused_tokens  INTEGER,
    ttft_ms        REAL,
    think_ms       REAL,
    prefill_tok_s  REAL,
    decode_tok_s   REAL,
    hit_rate       REAL,
    pcie_share     REAL,
    drafts_offered INTEGER,
    drafts_accepted INTEGER,
    finish         TEXT,
    preset         TEXT,
    strata_id      TEXT,
    error          TEXT
);
CREATE INDEX requests_started ON requests(started_at);
CREATE INDEX requests_token ON requests(token_id, started_at);
CREATE INDEX requests_ip ON requests(client_ip, started_at);
CREATE INDEX requests_rid ON requests(rid);

CREATE TABLE request_bodies (
    request_rid TEXT PRIMARY KEY,
    created_at  REAL NOT NULL,
    request     BLOB,                             -- zstd
    response    BLOB                              -- zstd
);

CREATE TABLE usage_daily (
    day           TEXT NOT NULL,                  -- YYYY-MM-DD, local time
    token_id      TEXT NOT NULL,                  -- '' for anonymous
    requests      INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    errors        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, token_id)
);

CREATE TABLE events (
    id      INTEGER PRIMARY KEY,
    at      REAL NOT NULL,
    kind    TEXT NOT NULL,                        -- e.g. token.create, auth.open, preset.switch, signin.fail
    level   TEXT NOT NULL DEFAULT 'info',         -- info | warn | error
    actor   TEXT NOT NULL DEFAULT '',             -- the user's name (console), cli, gateway, console, system
    source  TEXT NOT NULL DEFAULT '',             -- an address, or "ssh"
    summary TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}'            -- JSON
);
CREATE INDEX events_at ON events(at);
CREATE INDEX events_kind ON events(kind, at);

CREATE TABLE switches (
    id          INTEGER PRIMARY KEY,
    started_at  REAL NOT NULL,
    ended_at    REAL,
    from_preset TEXT,
    to_preset   TEXT NOT NULL,
    by          TEXT NOT NULL DEFAULT '',
    phases      TEXT NOT NULL DEFAULT '[]',       -- JSON: [{name, start, end}]
    ok          INTEGER,
    error       TEXT,
    warm        REAL                              -- share of the pack in the page cache at the start
);

CREATE TABLE metrics_10s (ts INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE metrics_1m  (ts INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE metrics_1h  (ts INTEGER PRIMARY KEY, data TEXT NOT NULL);

CREATE TABLE bench_runs (
    id          INTEGER PRIMARY KEY,
    started_at  REAL NOT NULL,
    ended_at    REAL,
    kind        TEXT NOT NULL,                    -- quickbench | validate | qualgate | apitest | import
    preset      TEXT,
    args        TEXT NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'running',  -- running | ok | failed | cancelled
    result      TEXT NOT NULL DEFAULT '{}',       -- JSON
    log         TEXT NOT NULL DEFAULT '',
    contention  INTEGER NOT NULL DEFAULT 0,
    source      TEXT                              -- the imported file, if any
);

CREATE TABLE jobs (
    id         INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL,
    created_at REAL NOT NULL,
    started_at REAL,
    ended_at   REAL,
    status     TEXT NOT NULL DEFAULT 'queued',
    params     TEXT NOT NULL DEFAULT '{}',
    result     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE alerts (
    id          INTEGER PRIMARY KEY,
    rule        TEXT NOT NULL,
    key         TEXT NOT NULL,                    -- rule + subject, for de-duplication
    level       TEXT NOT NULL,
    opened_at   REAL NOT NULL,
    closed_at   REAL,
    last_seen   REAL NOT NULL,
    summary     TEXT NOT NULL,
    details     TEXT NOT NULL DEFAULT '{}',
    acked_at    REAL,
    sent        TEXT NOT NULL DEFAULT '{}'        -- JSON: where it was delivered (telegram: ok / error)
);
CREATE INDEX alerts_open ON alerts(closed_at, key);
