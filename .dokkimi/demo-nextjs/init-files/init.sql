CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  oauth_sub VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title VARCHAR(255) NOT NULL,
  url VARCHAR(2048) NOT NULL,
  country VARCHAR(8) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Seed user used both as an existing-user lookup target and as the FK owner
-- for the seeded bookmarks. The OAuth callback upserts on `oauth_sub`, so a
-- mock-issued `sub` of `google-oauth-12345` will hit this row, not insert.
INSERT INTO users (oauth_sub, email, name) VALUES
  ('google-oauth-12345', 'alice@example.com', 'Alice Anderson');

-- 25 seeded bookmarks so infinite-scroll has 3 pages of 10 to traverse
-- (plus the initial render). Country distribution is intentionally biased
-- toward US so a country filter on US returns multiple rows; ZW is included
-- once near the end of the alphabetical dropdown so the dropdown-scroll
-- test has a meaningful target.
INSERT INTO bookmarks (user_id, title, url, country) VALUES
  (1, 'Hacker News', 'https://news.ycombinator.com', 'US'),
  (1, 'Lobsters', 'https://lobste.rs', 'US'),
  (1, 'BBC News', 'https://bbc.co.uk', 'GB'),
  (1, 'Le Monde', 'https://lemonde.fr', 'FR'),
  (1, 'Asahi Shimbun', 'https://asahi.com', 'JP'),
  (1, 'Globe and Mail', 'https://theglobeandmail.com', 'CA'),
  (1, 'Sydney Morning Herald', 'https://smh.com.au', 'AU'),
  (1, 'Frankfurter Allgemeine', 'https://faz.net', 'DE'),
  (1, 'El Pais', 'https://elpais.com', 'ES'),
  (1, 'O Globo', 'https://oglobo.globo.com', 'BR'),
  (1, 'NYT', 'https://nytimes.com', 'US'),
  (1, 'WaPo', 'https://washingtonpost.com', 'US'),
  (1, 'The Guardian', 'https://theguardian.com', 'GB'),
  (1, 'NRC', 'https://nrc.nl', 'NL'),
  (1, 'Times of India', 'https://timesofindia.com', 'IN'),
  (1, 'Folha de S. Paulo', 'https://folha.uol.com.br', 'BR'),
  (1, 'Süddeutsche Zeitung', 'https://sueddeutsche.de', 'DE'),
  (1, 'The Standard', 'https://standardmedia.co.ke', 'KE'),
  (1, 'Stuff NZ', 'https://stuff.co.nz', 'NZ'),
  (1, 'Rappler', 'https://rappler.com', 'PH'),
  (1, 'Ars Technica', 'https://arstechnica.com', 'US'),
  (1, 'The Verge', 'https://theverge.com', 'US'),
  (1, 'TechCrunch', 'https://techcrunch.com', 'US'),
  (1, 'Wired UK', 'https://wired.co.uk', 'GB'),
  (1, 'Zimbabwe Daily', 'https://zimbabwe-news.example.com', 'ZW');
