---
title: 'Testing a Next.js app with backend microservices'
description: 'How to set up Dokkimi to test a Next.js frontend alongside your API services — including UI interactions, API route testing, and full-stack assertions.'
date: '2026-04-27'
slug: 'testing-nextjs-apps'
---

## The app we're testing

You're building a blog platform. The architecture is straightforward:

- **web-app** — a Next.js frontend that renders pages and has API routes under `/api/`
- **api-gateway** — a Node service that handles auth and routes requests to backend services
- **post-service** — manages blog posts (CRUD operations)
- **user-service** — manages user profiles and follows
- **postgres-db** — a PostgreSQL database shared by the backend services

The data model is simple. You have a `users` table and a `posts` table:

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  bio TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  author_id INTEGER REFERENCES users(id),
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  published BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
```

When a reader visits `/posts/42`, the Next.js app calls the API gateway, which calls the post service, which queries the database. When an author publishes a new post, the flow goes in reverse — form submission in the browser → Next.js API route → API gateway → post service → database insert.

The question is: how do you test all of these layers together?

## Why the usual approaches fall short

You could unit test each service in isolation, but that won't catch the bugs that happen at the boundaries. The post service might return `authorId` while the API gateway expects `author_id`. The Next.js page might assume `post.body` is HTML when the API returns Markdown. These are integration bugs, and they're the most common class of production incidents in microservice architectures.

You could run Cypress or Playwright against a deployed staging environment, but then you're sharing the database with other developers, you can't control the data, and your tests are flaky because someone else's test run just deleted the post you were about to assert on.

Dokkimi gives you an isolated environment with real services, a real database you control, and the ability to assert on traffic at every layer.

## Seeding the database

The first thing you need is test data. Create an init file that seeds the database with known users and posts:

```sql
-- .dokkimi/blog-platform/init/seed.sql

INSERT INTO users (id, username, display_name, bio) VALUES
  (1, 'alice', 'Alice Chen', 'Staff engineer. Writes about distributed systems.'),
  (2, 'bob', 'Bob Martinez', 'Frontend dev and occasional blogger.');

INSERT INTO posts (id, author_id, title, body, published) VALUES
  (1, 1, 'Understanding consensus algorithms', 'Raft and Paxos are the two most common...', true),
  (2, 1, 'Why I switched to Postgres', 'After years of MongoDB, I finally...', true),
  (3, 2, 'CSS Grid is underrated', 'Everyone reaches for flexbox, but grid...', true),
  (4, 2, 'Draft: React Server Components', 'Still figuring this out...', false);

SELECT setval('users_id_seq', 10);
SELECT setval('posts_id_seq', 10);
```

The `setval` calls bump the sequences so new inserts don't collide with the seeded IDs. This file runs when Dokkimi creates the database pod, before any tests execute.

## Defining the services

Each service gets a shared definition file so you can reuse it across tests:

```yaml
# .dokkimi/shared/web-app.yaml
type: SERVICE
name: web-app
image: my-registry/web-app:latest
port: 3000
healthCheck: /api/health
env:
  - name: API_GATEWAY_URL
    value: http://api-gateway:3000
```

```yaml
# .dokkimi/shared/api-gateway.yaml
type: SERVICE
name: api-gateway
image: my-registry/api-gateway:latest
port: 3000
healthCheck: /health
env:
  - name: POST_SERVICE_URL
    value: http://post-service:3000
  - name: USER_SERVICE_URL
    value: http://user-service:3000
```

```yaml
# .dokkimi/shared/post-service.yaml
type: SERVICE
name: post-service
image: my-registry/post-service:latest
port: 3000
healthCheck: /health
env:
  - name: DATABASE_URL
    value: postgresql://dokkimi:dokkimi@postgres-db:5432/dokkimi
```

```yaml
# .dokkimi/shared/postgres-db.yaml
type: DATABASE
name: postgres-db
database: postgres
initFilePath: ../init/seed.sql
```

The environment variables use Kubernetes service names (`http://api-gateway:3000`, `postgresql://...@postgres-db:5432/...`) because inside the Dokkimi namespace, each service is reachable by its `name`. This matches how you'd configure services in a real Kubernetes deployment.

## Testing API routes directly

Not every test needs a browser. Your Next.js API routes are HTTP endpoints, so start by testing the data layer.

Here's a test that verifies the "list published posts" flow — from API route to database and back:

```yaml
name: list-published-posts
items:
  - $ref: ../shared/web-app.yaml
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/post-service.yaml
  - $ref: ../shared/postgres-db.yaml

tests:
  - name: List published posts
    steps:
      - action:
          type: httpRequest
          method: GET
          url: web-app/api/posts
        assertions:
          # The API route returned the right data
          - assertions:
              - path: response.status
                operator: eq
                value: 200
              - path: response.body.posts.length
                operator: eq
                value: 3
              - path: response.body.posts[0].title
                operator: eq
                value: 'CSS Grid is underrated'

          # The post service queried the database correctly
          - match:
              origin: web-app
              method: GET
              url: api-gateway/v1/posts
            assertions:
              - path: response.status
                operator: eq
                value: 200
```

Notice the assertion on `$.posts.length` — the database has 4 posts but only 3 are published. This verifies that the `published` filter works correctly all the way through the stack, not just in the post service's unit tests.

You can also use database steps to verify writes. Here's a test for creating a new post:

```yaml
name: create-post
items:
  - $ref: ../shared/web-app.yaml
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/post-service.yaml
  - $ref: ../shared/user-service.yaml
  - $ref: ../shared/postgres-db.yaml

tests:
  - name: Create and verify a post
    steps:
      - action:
          type: httpRequest
          method: POST
          url: web-app/api/posts
          body:
            authorId: 1
            title: 'New post from test'
            body: 'This post was created during an integration test.'
            published: true
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 201
              - path: response.body.post.id
                operator: exists
        extract:
          newPostId: response.body.post.id

      # Verify the post exists in the database
      - action:
          type: dbQuery
          database: postgres-db
          query: 'SELECT title, published FROM posts WHERE id = {{newPostId}}'
        assertions:
          - assertions:
              - path: data[0].title
                operator: eq
                value: 'New post from test'
              - path: data[0].published
                operator: eq
                value: true

      # Verify it shows up in the listing
      - action:
          type: httpRequest
          method: GET
          url: web-app/api/posts
        assertions:
          - assertions:
              - path: response.body.posts.length
                operator: eq
                value: 4
```

The `extract` on the first step captures the new post's ID, and the database step uses `{{newPostId}}` to query for it directly. This is a round-trip test: HTTP create → database verify → HTTP list verify.

## Adding UI tests

Once your API layer is solid, add UI tests for the critical user flows. Dokkimi drives a real Chromium browser inside the same Kubernetes namespace as your services, so the browser has the same network access as a real user.

Here's a test that loads a post page and verifies it rendered correctly:

```yaml
name: view-post-page
items:
  - $ref: ../shared/web-app.yaml
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/post-service.yaml
  - $ref: ../shared/user-service.yaml
  - $ref: ../shared/postgres-db.yaml

tests:
  - name: View a post page
    steps:
      - action:
          type: ui
          url: http://web-app:3000/posts/1
          subSteps:
            - action: waitForSelector
              selector: '[data-testid="post-title"]'
            - action: screenshot
              name: post-detail-page
        assertions:
          # The page triggered a fetch to the API gateway
          - match:
              origin: web-app
              method: GET
              url: api-gateway/v1/posts/1
            assertions:
              - path: response.status
                operator: eq
                value: 200
              - path: response.body.title
                operator: eq
                value: 'Understanding consensus algorithms'

          # The author profile was also fetched
          - match:
              origin: web-app
              method: GET
              url: api-gateway/v1/users/1
            assertions:
              - path: response.body.displayName
                operator: eq
                value: 'Alice Chen'
```

The browser loads the post page, which triggers server-side data fetching. Dokkimi captures the HTTP calls that the Next.js server makes to the API gateway, so you can assert on exactly what data was fetched and what was returned — even though the user only sees the rendered HTML.

## Testing a full user flow

Here's a more involved test that walks through browsing posts, creating a new one, and verifying it appears in the listing:

```yaml
name: author-publish-flow
items:
  - $ref: ../shared/web-app.yaml
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/post-service.yaml
  - $ref: ../shared/user-service.yaml
  - $ref: ../shared/postgres-db.yaml

tests:
  - name: Author publish flow
    steps:
      # Browse the post listing
      - action:
          type: ui
          url: http://web-app:3000/posts
          subSteps:
            - action: waitForSelector
              selector: '[data-testid="post-list"]'
            - action: screenshot
              name: post-listing-before

      # Navigate to the new post form
      - action:
          type: ui
          url: http://web-app:3000/posts/new
          subSteps:
            - action: waitForSelector
              selector: '[data-testid="post-form"]'
            - action: fill
              selector: '#title'
              value: 'Integration testing with Dokkimi'
            - action: fill
              selector: '#body'
              value: 'This is a post created by an automated test. It exercises the full stack from browser to database.'
            - action: click
              selector: '[data-testid="publish-button"]'
            - action: waitForSelector
              selector: '[data-testid="post-published-toast"]'
            - action: screenshot
              name: post-published
        assertions:
          # The form submission went through the full stack
          - match:
              origin: web-app
              method: POST
              url: api-gateway/v1/posts
            assertions:
              - path: request.body.title
                operator: eq
                value: 'Integration testing with Dokkimi'
              - path: response.status
                operator: eq
                value: 201

      # Verify the post was written to the database
      - action:
          type: dbQuery
          database: postgres-db
          query: "SELECT title, published FROM posts WHERE title = 'Integration testing with Dokkimi'"
        assertions:
          - assertions:
              - path: data[0].published
                operator: eq
                value: true

      # Verify it appears in the listing
      - action:
          type: ui
          url: http://web-app:3000/posts
          subSteps:
            - action: waitForSelector
              selector: '[data-testid="post-list"]'
            - action: screenshot
              name: post-listing-after
        assertions:
          - match:
              origin: web-app
              method: GET
              url: api-gateway/v1/posts
            assertions:
              - path: response.body.posts.length
                operator: eq
                value: 4
```

This test hits every layer: browser interactions, Next.js API routes, the API gateway, the post service, and the database. And because the database was seeded with known data, every assertion is deterministic — there's no guessing about how many posts should be in the listing.

## Testing server-side rendering

If your Next.js pages use `getServerSideProps` or server components that fetch data at render time, those fetches happen before the browser receives any HTML. You can verify them by combining a UI step (which triggers the page load) with HTTP call assertions:

```yaml
tests:
  - name: SSR data fetching
    steps:
      - action:
          type: ui
          url: http://web-app:3000/users/alice
          subSteps:
            - action: waitForSelector
              selector: '[data-testid="user-profile"]'
            - action: screenshot
              name: alice-profile
        assertions:
          # SSR fetched the user profile
          - match:
              origin: web-app
              method: GET
              url: api-gateway/v1/users/alice
            assertions:
              - path: response.body.displayName
                operator: eq
                value: 'Alice Chen'
              - path: response.body.bio
                operator: eq
                value: 'Staff engineer. Writes about distributed systems.'

          # SSR also fetched the user's posts
          - match:
              origin: web-app
              method: GET
              url: api-gateway/v1/users/alice/posts
            assertions:
              - path: response.body.posts.length
                operator: eq
                value: 2
```

This catches a common class of bugs: the server-side fetch returns the right data, but the page doesn't render it correctly. The screenshot baseline lets you verify visually, and the HTTP assertions verify the data flowing through the system.

## Tips for Next.js testing

- **Use `data-testid` attributes.** CSS selectors break when you restyle. Test IDs are stable and make your intent clear.
- **Seed your database with realistic data.** The closer your test data is to production, the more useful your tests are. Include edge cases in the seed — posts with long titles, users with empty bios, unpublished drafts.
- **Set environment variables to Kubernetes service names.** `http://api-gateway:3000`, not `http://localhost:3000`. This is the most common setup mistake when moving from local development to Dokkimi.
- **Start with API route tests.** They're faster, easier to debug, and catch most integration bugs. Once your API layer is solid, add UI tests for the flows that matter most to users.
- **Use database steps to verify writes.** Don't just check the HTTP response — query the database directly to confirm the data was actually persisted correctly. The response might look right while the data is wrong.
- **Use screenshots as baselines.** Dokkimi's artifact pipeline can diff screenshots across runs, catching visual regressions alongside functional ones.
