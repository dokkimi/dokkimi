-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_id VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Posts table
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  published BOOLEAN DEFAULT false,
  author_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Seed data: a user with some published posts
INSERT INTO users (id, oauth_id, email, name) VALUES
  ('a1b2c3d4-0000-0000-0000-000000000001', 'oauth_user_alice', 'alice@example.com', 'Alice Johnson');

INSERT INTO posts (id, title, content, published, author_id) VALUES
  ('b1b2c3d4-0000-0000-0000-000000000001', 'Getting Started with Microservices', 'Microservices let you break your app into independently deployable units...', true, 'a1b2c3d4-0000-0000-0000-000000000001'),
  ('b1b2c3d4-0000-0000-0000-000000000002', 'Why Testing Matters', 'Integration testing catches bugs that unit tests miss...', true, 'a1b2c3d4-0000-0000-0000-000000000001'),
  ('b1b2c3d4-0000-0000-0000-000000000003', 'Draft: Advanced Patterns', 'This is still a work in progress...', false, 'a1b2c3d4-0000-0000-0000-000000000001');
