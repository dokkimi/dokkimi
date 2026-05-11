-- Seed database for the namespace-routing-test UI fixture.
-- Tables mirror what the DbQueryHarness scenario queries from the UI.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_email VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO users (email, name) VALUES
  ('alice@example.com', 'Alice'),
  ('bob@example.com', 'Bob'),
  ('carol@example.com', 'Carol');

INSERT INTO posts (title, body, author_email) VALUES
  ('Welcome to Dokkimi', 'First post in the fixture.', 'alice@example.com'),
  ('Second one', 'Some content for list scrolling.', 'bob@example.com');
