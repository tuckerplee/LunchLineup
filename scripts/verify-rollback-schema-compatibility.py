#!/usr/bin/env python3
"""Classify a Prisma rollback diff and allow only backward-compatible additive DDL."""

from __future__ import annotations

import argparse
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


IDENTIFIER = r'(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)'
QUALIFIED_IDENTIFIER = rf'{IDENTIFIER}(?:\s*\.\s*{IDENTIFIER})?'
ENCLOSED_CREATE_TABLE = re.compile(
    rf'^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<table>{QUALIFIED_IDENTIFIER})\s*\((?P<body>.*)\)$',
    re.IGNORECASE | re.DOTALL,
)
CREATE_INDEX = re.compile(
    rf'^CREATE\s+(?P<unique>UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?'
    rf'(?:IF\s+NOT\s+EXISTS\s+)?{IDENTIFIER}\s+ON\s+(?:ONLY\s+)?'
    rf'(?P<table>{QUALIFIED_IDENTIFIER})\s*(?P<body>\(.+)$',
    re.IGNORECASE | re.DOTALL,
)
ALTER_TABLE = re.compile(
    rf'^ALTER\s+TABLE\s+(?:ONLY\s+)?(?P<table>{QUALIFIED_IDENTIFIER})\s+(?P<actions>.+)$',
    re.IGNORECASE | re.DOTALL,
)
ADD_COLUMN = re.compile(
    rf'^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?{IDENTIFIER}\s+(?P<definition>.+)$',
    re.IGNORECASE | re.DOTALL,
)
CREATE_ENUM = re.compile(
    rf'^CREATE\s+TYPE\s+{QUALIFIED_IDENTIFIER}\s+AS\s+ENUM\s*\(.+\)$',
    re.IGNORECASE | re.DOTALL,
)


class CompatibilityError(ValueError):
    pass


@dataclass(frozen=True)
class Classification:
    category: str
    detail: str


def _dollar_tag_at(sql: str, index: int) -> str | None:
    match = re.match(r'\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$', sql[index:])
    return match.group(0) if match else None


def split_sql_statements(sql: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    index = 0
    quote: str | None = None
    dollar_tag: str | None = None
    block_comment_depth = 0
    line_comment = False

    while index < len(sql):
        char = sql[index]
        next_char = sql[index + 1] if index + 1 < len(sql) else ''

        if line_comment:
            if char in '\r\n':
                line_comment = False
                current.append(' ')
            index += 1
            continue

        if block_comment_depth:
            if char == '/' and next_char == '*':
                block_comment_depth += 1
                index += 2
                continue
            if char == '*' and next_char == '/':
                block_comment_depth -= 1
                index += 2
                if block_comment_depth == 0:
                    current.append(' ')
                continue
            index += 1
            continue

        if dollar_tag:
            if sql.startswith(dollar_tag, index):
                current.append(dollar_tag)
                index += len(dollar_tag)
                dollar_tag = None
                continue
            current.append(char)
            index += 1
            continue

        if quote:
            current.append(char)
            if char == quote:
                if next_char == quote:
                    current.append(next_char)
                    index += 2
                    continue
                quote = None
            index += 1
            continue

        if char == '-' and next_char == '-':
            line_comment = True
            index += 2
            continue
        if char == '/' and next_char == '*':
            block_comment_depth = 1
            index += 2
            continue
        if char in ('\'', '"'):
            quote = char
            current.append(char)
            index += 1
            continue
        if char == '$':
            tag = _dollar_tag_at(sql, index)
            if tag:
                dollar_tag = tag
                current.append(tag)
                index += len(tag)
                continue
        if char == ';':
            statement = ''.join(current).strip()
            if statement:
                statements.append(statement)
            current = []
            index += 1
            continue

        current.append(char)
        index += 1

    if quote or dollar_tag or block_comment_depth:
        raise CompatibilityError('unterminated SQL quote or comment')

    trailing = ''.join(current).strip()
    if trailing:
        statements.append(trailing)
    return statements


def split_top_level(value: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    depth = 0
    quote: str | None = None
    index = 0

    while index < len(value):
        char = value[index]
        next_char = value[index + 1] if index + 1 < len(value) else ''
        current.append(char)
        if quote:
            if char == quote:
                if next_char == quote:
                    current.append(next_char)
                    index += 2
                    continue
                quote = None
        elif char in ('\'', '"'):
            quote = char
        elif char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
            if depth < 0:
                raise CompatibilityError('unbalanced SQL parentheses')
        elif char == ',' and depth == 0:
            current.pop()
            part = ''.join(current).strip()
            if not part:
                raise CompatibilityError('empty ALTER TABLE action')
            parts.append(part)
            current = []
        index += 1

    if quote or depth != 0:
        raise CompatibilityError('unterminated quote or unbalanced SQL parentheses')
    part = ''.join(current).strip()
    if part:
        parts.append(part)
    return parts


def identifier_key(value: str) -> str:
    return re.sub(r'\s+', '', value).lower()


def scrub_literals(value: str) -> str:
    output: list[str] = []
    quote: str | None = None
    index = 0
    while index < len(value):
        char = value[index]
        next_char = value[index + 1] if index + 1 < len(value) else ''
        if quote:
            output.append(' ')
            if char == quote:
                if next_char == quote:
                    output.append(' ')
                    index += 2
                    continue
                quote = None
        elif char in ('\'', '"'):
            quote = char
            output.append(' LITERAL ')
        else:
            output.append(char)
        index += 1
    return ''.join(output)


def classify_existing_table_column(definition: str) -> Classification:
    structural = scrub_literals(definition)
    if re.search(r'\b(PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|GENERATED|IDENTITY)\b', structural, re.IGNORECASE):
        raise CompatibilityError('new columns on existing tables cannot add constraints or generated/identity behavior')

    required = bool(re.search(r'\bNOT\s+NULL\b', structural, re.IGNORECASE))
    has_default = bool(re.search(r'\bDEFAULT\s+\S', structural, re.IGNORECASE))
    if required and not has_default:
        raise CompatibilityError('new NOT NULL columns on existing tables require a database default')
    return Classification('add_column_defaulted' if has_default else 'add_column_nullable', definition)


def classify_statement(statement: str, created_tables: set[str]) -> list[Classification]:
    create_table = ENCLOSED_CREATE_TABLE.fullmatch(statement)
    if create_table:
        table = identifier_key(create_table.group('table'))
        created_tables.add(table)
        return [Classification('create_table', table)]

    if CREATE_ENUM.fullmatch(statement):
        return [Classification('create_enum', statement)]

    create_index = CREATE_INDEX.fullmatch(statement)
    if create_index:
        table = identifier_key(create_index.group('table'))
        if '(' not in create_index.group('body'):
            raise CompatibilityError('CREATE INDEX must include an indexed expression')
        if create_index.group('unique') and table not in created_tables:
            raise CompatibilityError('unique indexes on existing tables can reject writes from rollback code')
        category = 'create_new_table_index' if table in created_tables else 'create_index'
        return [Classification(category, table)]

    alter_table = ALTER_TABLE.fullmatch(statement)
    if alter_table:
        table = identifier_key(alter_table.group('table'))
        classifications: list[Classification] = []
        for action in split_top_level(alter_table.group('actions')):
            if table in created_tables:
                if not re.match(r'^ADD\s+', action, re.IGNORECASE):
                    raise CompatibilityError('only additive ALTER TABLE actions are allowed for new tables')
                classifications.append(Classification('alter_new_table_additive', action))
                continue

            add_column = ADD_COLUMN.fullmatch(action)
            if not add_column:
                raise CompatibilityError('existing tables may only receive ADD COLUMN actions')
            classifications.append(classify_existing_table_column(add_column.group('definition')))
        return classifications

    preview = ' '.join(statement.split())[:300]
    raise CompatibilityError(f'unknown or destructive SQL statement: {preview}')


def classify_diff(sql: str) -> list[Classification]:
    statements = split_sql_statements(sql)
    created_tables: set[str] = set()
    classifications: list[Classification] = []
    for index, statement in enumerate(statements, start=1):
        try:
            classifications.extend(classify_statement(statement, created_tables))
        except CompatibilityError as error:
            raise CompatibilityError(f'statement {index}: {error}') from error
    return classifications


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('diff_path', type=Path)
    args = parser.parse_args()

    try:
        diff = args.diff_path.read_text(encoding='utf-8')
    except OSError as error:
        parser.error(f'cannot read schema diff: {error}')

    try:
        classifications = classify_diff(diff)
    except CompatibilityError as error:
        raise SystemExit(f'rollback schema compatibility failed closed: {error}') from error

    counts = Counter(item.category for item in classifications)
    summary = ' '.join(f'{category}={counts[category]}' for category in sorted(counts))
    print(
        'rollback_schema_diff_ok policy=backward-compatible-additive '
        f'statements={len(split_sql_statements(diff))} {summary}'.rstrip()
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
