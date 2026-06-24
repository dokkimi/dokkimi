---
title: 'Testing services that use Elasticsearch'
description: 'Run a real Elasticsearch instance in your Dokkimi test environment. Seed indexes, query search results, and verify your service talks to Elasticsearch correctly — all without mocking.'
date: '2026-06-24'
slug: 'testing-with-elasticsearch'
---

## What we're building

A product search API backed by Elasticsearch. The API service indexes products into Elasticsearch and exposes a search endpoint. We'll test the full flow: seed products, search for them through the API, and verify the API actually queries Elasticsearch (not a hardcoded fallback).

The architecture:

```
Browser/Client → API Service → Elasticsearch
                      ↓
                  Postgres (product catalog)
```

The API service reads products from Postgres and indexes them into Elasticsearch. When a user searches, the API queries Elasticsearch and returns results.

## Setting up the infrastructure

### Elasticsearch as a SERVICE item

Create a shared fragment for Elasticsearch:

```yaml
# .dokkimi/shared/elasticsearch.yaml
type: SERVICE
name: elasticsearch
image: elasticsearch:8.17.0
port: 9200
healthCheck: /_cluster/health
env:
  - name: discovery.type
    value: single-node
  - name: xpack.security.enabled
    value: 'false'
  - name: ES_JAVA_OPTS
    value: '-Xms256m -Xmx256m'
```

A few things to note:

- **`discovery.type: single-node`** skips cluster formation — we just need one node for testing.
- **`xpack.security.enabled: false`** disables authentication. No need for security in an isolated test environment.
- **`ES_JAVA_OPTS`** limits memory. Elasticsearch is memory-hungry by default; 256MB is plenty for test workloads.
- **`/_cluster/health`** is the health check. Dokkimi waits for this to return 200 before running tests.

### Postgres for the product catalog

```yaml
# .dokkimi/shared/products-db.yaml
type: DATABASE
name: products-db
database: postgres
initFilePath: ../init-files/products-schema.sql
```

```sql
-- .dokkimi/init-files/products-schema.sql
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  price_cents INTEGER NOT NULL,
  in_stock BOOLEAN DEFAULT true
);

INSERT INTO products (sku, name, description, category, price_cents) VALUES
  ('WH-1000', 'Wireless Headphones', 'Noise-canceling over-ear headphones', 'electronics', 7999),
  ('KB-2000', 'Mechanical Keyboard', 'Cherry MX Blue switches, RGB backlight', 'electronics', 12999),
  ('BP-3000', 'Canvas Backpack', 'Water-resistant 30L daypack', 'accessories', 4999);
```

### The API service

```yaml
# .dokkimi/shared/product-api.yaml
type: SERVICE
name: product-api
image: my-company/product-api:latest
port: 3000
healthCheck: /health
env:
  - name: DATABASE_URL
    value: postgresql://dokkimi:dokkimi@products-db:5432/dokkimi
  - name: ELASTICSEARCH_URL
    value: http://elasticsearch:9200
  - name: ELASTICSEARCH_INDEX
    value: products
```

The service connects to `products-db` for the catalog and `elasticsearch` for search. Both hostnames resolve via Dokkimi's DNS routing.

## Writing the test definition

```yaml
# .dokkimi/definitions/product-search.yaml
name: product-search-flow
config:
  timeoutSeconds: 120

items:
  - $ref: ../shared/elasticsearch.yaml
  - $ref: ../shared/products-db.yaml
  - $ref: ../shared/product-api.yaml

tests:
  - name: Index products and verify search
    steps:
      # Step 1: Trigger the API to index products into Elasticsearch
      - name: Trigger product indexing
        action:
          type: httpRequest
          method: POST
          url: product-api/api/products/reindex
        assertions:
          - assertions:
              - path: $.response.status
                operator: eq
                value: 200
              - path: $.response.body.indexed
                operator: eq
                value: 3

      # Step 2: Search for headphones through the API
      - name: Search for headphones
        action:
          type: httpRequest
          method: GET
          url: product-api/api/search?q=headphones
        assertions:
          # Verify the API response
          - assertions:
              - path: $.response.status
                operator: eq
                value: 200
              - path: $.response.body.results
                operator: count
                value: 1
              - path: $.response.body.results[0].name
                operator: eq
                value: Wireless Headphones
              - path: $.response.body.results[0].price_cents
                operator: eq
                value: 7999

          # Verify the API actually queried Elasticsearch
          - match:
              path: $.traffic
              where:
                - path: $$.origin
                  operator: eq
                  value: product-api
                - path: $$.request.url
                  operator: contains
                  value: elasticsearch/products/_search
              count: 1
            assertions:
              - path: $.match.request.body.query
                operator: exists

      # Step 3: Search for a category
      - name: Search for electronics
        action:
          type: httpRequest
          method: GET
          url: product-api/api/search?category=electronics
        assertions:
          - assertions:
              - path: $.response.status
                operator: eq
                value: 200
              - path: $.response.body.results
                operator: count
                value: 2

  - name: Search returns empty for non-existent products
    steps:
      - name: Search for something that does not exist
        action:
          type: httpRequest
          method: GET
          url: product-api/api/search?q=unicorn
        assertions:
          - assertions:
              - path: $.response.status
                operator: eq
                value: 200
              - path: $.response.body.results
                operator: count
                value: 0
```

## What the traffic interception gives you

When you run `dokkimi inspect` after this test, you'll see:

1. **HTTP traffic between product-api and Elasticsearch** — every `_search`, `_bulk`, and `_refresh` call, with full request/response bodies. You can see exactly what queries your service built and what Elasticsearch returned.
2. **HTTP traffic between the test runner and product-api** — the requests your test steps made and the responses they got.
3. **Database queries to Postgres** — every SQL query the product-api ran against products-db (via the DB proxy sidecar).
4. **Console logs** — stdout/stderr from all containers.

This visibility is what distinguishes running Elasticsearch in Dokkimi from running it in Docker Compose. With Docker Compose, you can only see the edges — what you sent in and what came back out. With Dokkimi, you see the full chain: your API received a search request, queried Elasticsearch with a specific query body, got back specific results, and transformed them into the API response.

## Seeding Elasticsearch directly

If your API doesn't have a reindex endpoint, you can seed Elasticsearch directly in test steps using individual `PUT _doc` requests:

```yaml
steps:
  - name: Index first product
    action:
      type: httpRequest
      method: PUT
      url: elasticsearch/products/_doc/1
      headers:
        Content-Type: application/json
      body:
        name: Wireless Headphones
        category: electronics
        price_cents: 7999

  - name: Index second product
    action:
      type: httpRequest
      method: PUT
      url: elasticsearch/products/_doc/2
      headers:
        Content-Type: application/json
      body:
        name: Mechanical Keyboard
        category: electronics
        price_cents: 12999

  - name: Refresh index
    action:
      type: httpRequest
      method: POST
      url: elasticsearch/products/_refresh
```

Each `PUT _doc` indexes a single document by ID. The `_refresh` call ensures they're searchable immediately — Elasticsearch has a near-real-time delay by default.

## Tips

- **Set `ES_JAVA_OPTS` to limit memory.** Without it, Elasticsearch tries to grab 1GB+ of heap. `-Xms256m -Xmx256m` is plenty for test data.
- **Use `_refresh` after indexing.** Elasticsearch doesn't make documents searchable instantly. Explicitly refreshing the index eliminates timing-related flakiness.
- **Pin the Elasticsearch version.** Match your production version. Query syntax and API behavior can differ between major versions.
- **Elasticsearch takes 10-15 seconds to start.** This is normal — JVM startup plus cluster initialization. Dokkimi waits for the health check to pass before running tests, so you don't need manual waits.
