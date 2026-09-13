-- Схема отражает docs/scanning-grammar.md. Один нюанс, где реализация
-- слегка упростила исходное обсуждение: там на самом раннем этапе
-- звучало "переместить предмет между ячейками" (отвязать от старой),
-- но итоговая (одобренная) ER-диаграмма и вся логика batching/timeout
-- строятся на BIN_STOCK как независимом остатке (bin_id, item_id) ->
-- quantity. Поэтому add/remove здесь -- две независимые операции над
-- конкретной парой (ячейка, предмет), без автоматического "отвязывания"
-- от других ячеек. Если нужна была именно строгая одна-ячейка-на-тип --
-- это отдельное решение, не то, что закладывает эта схема.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Категории предметов: произвольная глубина ("Крепёж" -> "Винт" -> "М2" ->
-- "Потайной"), adjacency list. У предмета -- одна категория (её самый
-- глубокий узел; путь целиком получается подъёмом по parent_id).
CREATE TABLE IF NOT EXISTS categories (
    id                        INTEGER PRIMARY KEY,
    parent_id                 INTEGER REFERENCES categories(id), -- NULL = верхний уровень
    name                      TEXT NOT NULL,
    created_in_work_session_id INTEGER REFERENCES work_sessions(id)
);

-- Не более одного узла с одним именем у одного родителя (и отдельно -- на
-- верхнем уровне, где parent_id IS NULL и обычный UNIQUE(parent_id, name)
-- не сработал бы, так как NULL <> NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_unique_under_parent
    ON categories (parent_id, name) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_unique_top_level
    ON categories (name) WHERE parent_id IS NULL;

CREATE TABLE IF NOT EXISTS items (
    id                        INTEGER PRIMARY KEY,
    barcode                   TEXT UNIQUE, -- NULL пока не отсканирован/не задан вручную
    name                      TEXT NOT NULL DEFAULT '',
    category_id               INTEGER REFERENCES categories(id), -- NULL = без категории
    icon_emoji                TEXT,
    icon_image_path           TEXT,
    created_in_work_session_id INTEGER REFERENCES work_sessions(id) -- см. buffered_operations: создание откатывается вместе с сессией
);

CREATE TABLE IF NOT EXISTS bins (
    id                        INTEGER PRIMARY KEY,
    barcode                   TEXT UNIQUE NOT NULL, -- STG-BIN-<id>, назначается при создании
    label                     TEXT NOT NULL,
    kind                      TEXT NOT NULL CHECK (kind IN ('mono', 'poly')),
    mono_item_id              INTEGER REFERENCES items(id), -- только для kind='mono'
    icon_emoji                TEXT,
    icon_image_path           TEXT,
    created_in_work_session_id INTEGER REFERENCES work_sessions(id)
);

CREATE TABLE IF NOT EXISTS bin_stock (
    bin_id    INTEGER NOT NULL REFERENCES bins(id),
    item_id   INTEGER NOT NULL REFERENCES items(id),
    quantity  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bin_id, item_id)
);

-- Упаковки/вложенные предметы (docs/scanning-grammar.md §2). Многие-ко-многим,
-- хотя на практике почти всегда один pack_item_id -> один child_item_id.
CREATE TABLE IF NOT EXISTS item_pack_contents (
    pack_item_id   INTEGER NOT NULL REFERENCES items(id),
    child_item_id  INTEGER NOT NULL REFERENCES items(id),
    quantity       INTEGER NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (pack_item_id, child_item_id)
);

CREATE TABLE IF NOT EXISTS work_sessions (
    id          INTEGER PRIMARY KEY,
    status      TEXT NOT NULL CHECK (status IN ('open', 'frozen', 'committed', 'rolled_back')),
    opened_at   INTEGER NOT NULL,
    frozen_at   INTEGER,
    closed_at   INTEGER
);

-- Singleton на уровне схемы: не более одной строки со status IN ('open',
-- 'frozen') одновременно -- partial unique index на константном выражении,
-- проще и надёжнее, чем полагаться только на проверку в коде движка.
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_sessions_singleton_open
    ON work_sessions ((1))
    WHERE status IN ('open', 'frozen');

CREATE TABLE IF NOT EXISTS buffered_operations (
    id                 INTEGER PRIMARY KEY,
    work_session_id    INTEGER NOT NULL REFERENCES work_sessions(id),
    op_type            TEXT NOT NULL CHECK (op_type IN ('add', 'remove')),
    item_id            INTEGER NOT NULL REFERENCES items(id),
    bin_id             INTEGER NOT NULL REFERENCES bins(id),
    quantity           INTEGER NOT NULL CHECK (quantity > 0),
    source             TEXT NOT NULL CHECK (source IN ('scan', 'manual')),
    via_pack_item_id   INTEGER REFERENCES items(id), -- NULL если не результат разворачивания упаковки
    created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id                 INTEGER PRIMARY KEY,
    ts                 INTEGER NOT NULL,
    op_type            TEXT NOT NULL CHECK (op_type IN ('add', 'remove')),
    item_id            INTEGER NOT NULL REFERENCES items(id),
    bin_id             INTEGER NOT NULL REFERENCES bins(id),
    quantity           INTEGER NOT NULL,
    via_pack_item_id   INTEGER REFERENCES items(id)
);

-- Admin-editable server settings (scan_op_timeout_seconds and future
-- additions) live in a JSON config file (STOREGIZER_CONFIG_PATH), not
-- here -- see backend/src/config/config.h. That's server configuration,
-- not warehouse data.
