-- Web tools for apps (POST /tools/mcp on the gateway): each token's calls in the last day (the 600-a-day limit) and the
-- links its searches returned (the provenance rule, 24 hours), so neither starts over when the gateway restarts.

CREATE TABLE web_calls (
    token_id  TEXT NOT NULL,
    at        REAL NOT NULL
);
CREATE INDEX web_calls_token_at ON web_calls(token_id, at);

CREATE TABLE web_links (
    token_id    TEXT NOT NULL,
    url         TEXT NOT NULL,                  -- normalized (console/chatrun.py normalize_url)
    expires_at  REAL NOT NULL,
    PRIMARY KEY (token_id, url)
);
