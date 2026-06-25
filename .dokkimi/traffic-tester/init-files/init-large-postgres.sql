CREATE TABLE IF NOT EXISTS large_records (
  id SERIAL PRIMARY KEY,
  record_key VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(50) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

DO $$
DECLARE
  i INT;
  cats TEXT[] := ARRAY['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  lorem TEXT := 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. ';
BEGIN
  FOR i IN 1..20000 LOOP
    INSERT INTO large_records (record_key, title, description, category, metadata, tags)
    VALUES (
      'REC-' || lpad(i::text, 5, '0'),
      'Record number ' || i || ' — ' || cats[1 + (i % 5)],
      repeat(lorem, 2),
      cats[1 + (i % 5)],
      jsonb_build_object(
        'index', i,
        'priority', CASE WHEN i % 10 = 0 THEN 'high' WHEN i % 3 = 0 THEN 'medium' ELSE 'low' END,
        'score', round((random() * 100)::numeric, 2),
        'dimensions', jsonb_build_object('width', i % 200, 'height', (i * 7) % 300, 'depth', (i * 13) % 100),
        'history', jsonb_build_array(
          jsonb_build_object('event', 'created', 'ts', NOW() - (i || ' hours')::interval),
          jsonb_build_object('event', 'updated', 'ts', NOW() - ((i / 2) || ' hours')::interval)
        )
      ),
      ARRAY[cats[1 + (i % 5)], cats[1 + ((i + 1) % 5)], 'batch-' || (i / 100)]
    );
  END LOOP;
END $$;
