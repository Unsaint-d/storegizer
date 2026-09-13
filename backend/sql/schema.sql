-- Предварительная схема, отражающая только концептуальную модель данных
-- из README.md. Грамматика сканирования и правила переноса между ячейками
-- ещё не спроектированы, поэтому таблицы сессий/буфера сюда пока не входят.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS items (
    id       INTEGER PRIMARY KEY,
    barcode  TEXT UNIQUE NOT NULL,
    name     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bins (
    id            INTEGER PRIMARY KEY,
    barcode       TEXT UNIQUE NOT NULL,
    label         TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('mono', 'poly')),
    mono_item_id  INTEGER REFERENCES items(id)
);

CREATE TABLE IF NOT EXISTS bin_stock (
    bin_id    INTEGER NOT NULL REFERENCES bins(id),
    item_id   INTEGER NOT NULL REFERENCES items(id),
    quantity  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bin_id, item_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY,
    ts           INTEGER NOT NULL,
    operation    TEXT NOT NULL,
    item_id      INTEGER REFERENCES items(id),
    quantity     INTEGER,
    from_bin_id  INTEGER REFERENCES bins(id),
    to_bin_id    INTEGER REFERENCES bins(id)
);
