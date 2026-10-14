-- Local drill only. One line per user table: schema.table|rows|md5 of all rows.
-- Run with: psql -X -At -f db-fingerprint.sql
SELECT schemaname || '.' || tablename || '|'
  || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', schemaname, tablename), false, true, '')))[1]::text
  || '|'
  || (xpath('/row/h/text()', query_to_xml(format('select coalesce(md5(string_agg(x::text, E''|'' order by x::text)), ''-'') as h from %I.%I x', schemaname, tablename), false, true, '')))[1]::text
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY schemaname, tablename;
