-- jsonb hygiene (harden-runtime, task 4.2).
--
-- Bun's SQL client encodes a JavaScript string bound to a `jsonb` parameter as a JSON
-- *string* value, so `${JSON.stringify(obj)}::jsonb` stored `"{\"a\":1}"` instead of
-- `{"a":1}` (jsonb_typeof = 'string'). The repositories now bind the object itself (one
-- encode at the boundary); this migration rewrites rows written by the old path.
--
-- Only JSON objects/arrays are unwrapped: a plain string value (e.g. a label) is left
-- alone, and an unparsable string is left alone rather than aborting the migration.

create or replace function public.factory_jsonb_unwrap(value jsonb) returns jsonb
language plpgsql immutable as $$
declare
  text_value text;
  parsed jsonb;
begin
  if value is null or jsonb_typeof(value) <> 'string' then
    return value;
  end if;
  text_value := btrim(value #>> '{}');
  if text_value is null or text_value = '' then
    return value;
  end if;
  if left(text_value, 1) not in ('{', '[') then
    return value;
  end if;
  begin
    parsed := text_value::jsonb;
  exception when others then
    return value;
  end;
  if jsonb_typeof(parsed) not in ('object', 'array') then
    return value;
  end if;
  return parsed;
end;
$$;

do $$
declare
  col record;
begin
  for col in
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public' and data_type = 'jsonb'
  loop
    execute format(
      'update public.%I set %I = public.factory_jsonb_unwrap(%I) where jsonb_typeof(%I) = ''string''',
      col.table_name, col.column_name, col.column_name, col.column_name
    );
  end loop;
end;
$$;

drop function if exists public.factory_jsonb_unwrap(jsonb);
