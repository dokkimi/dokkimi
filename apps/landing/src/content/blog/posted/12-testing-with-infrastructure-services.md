---
title: 'Beyond databases: testing with Elasticsearch, MinIO, and other infrastructure'
description: "Dokkimi services aren't limited to your application code. Any Docker container with an HTTP health check can be part of your test environment — including search engines, object stores, and message brokers."
date: '2026-06-24'
slug: 'testing-with-infrastructure-services'
---

## The assumption worth challenging

When people evaluate Dokkimi, they often think of it in terms of its native database support: Postgres, MySQL, MongoDB, Redis. Those four cover most use cases, and each gets a dedicated DB proxy sidecar that intercepts and logs every query for debugging.

But many real-world systems depend on more than a relational database and a cache. Search engines, object stores, message brokers, and specialty datastores are everywhere. If your architecture includes Elasticsearch for full-text search, MinIO or S3 for file storage, or Meilisearch for product search — you need those in your test environment too, or you're mocking away the interesting parts.

The good news: Dokkimi's SERVICE item type accepts any Docker image. If the container exposes an HTTP health check endpoint, it works as a first-class item in your test environment — with DNS routing, traffic interception on HTTP calls to and from it, and full lifecycle management.

## Elasticsearch example

Elasticsearch is the most natural fit. Its REST API serves double duty: port 9200 is both the application endpoint and the health check endpoint.

```yaml
items:
  - type: SERVICE
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

Your application services connect to `elasticsearch:9200` — the same hostname they'd use in a real deployment. Dokkimi resolves DNS within the Docker network, so no configuration changes needed in your application.

### Seeding data and asserting on search results

Since Elasticsearch speaks HTTP, you can seed indexes and query search results directly from your test steps:

```yaml
tests:
  - name: Product search returns indexed items
    steps:
      # Seed an Elasticsearch index
      - action:
          type: httpRequest
          method: PUT
          url: elasticsearch/products/_doc/1
          headers:
            Content-Type: application/json
          body:
            name: Wireless Headphones
            category: electronics
            price: 79.99
        assertions:
          - assertions:
              - path: $.response.status
                operator: in
                value: [200, 201]

      # Force a refresh so the document is searchable
      - action:
          type: httpRequest
          method: POST
          url: elasticsearch/products/_refresh

      # Search via your API service and verify it finds the product
      - action:
          type: httpRequest
          method: GET
          url: api-gateway/api/search?q=headphones
        assertions:
          - assertions:
              - path: $.response.status
                operator: eq
                value: 200
              - path: $.response.body.results[0].name
                operator: eq
                value: Wireless Headphones
          # Verify your API service actually queried Elasticsearch
          - match:
              path: $.traffic
              where:
                - path: $$.origin
                  operator: eq
                  value: api-gateway
                - path: $$.request.url
                  operator: contains
                  value: elasticsearch/products/_search
              count: 1
```

The traffic interception is what makes this powerful. You're not just checking "did the API return the right data" — you're verifying that your service actually queried Elasticsearch with the right parameters. If someone accidentally hardcoded a fallback that bypasses search, the traffic assertion catches it.

## MinIO (S3-compatible object storage)

MinIO runs an S3-compatible API with a built-in health endpoint:

```yaml
items:
  - type: SERVICE
    name: minio
    image: minio/minio:latest
    port: 9000
    healthCheck: /minio/health/live
    command: ['server', '/data']
    env:
      - name: MINIO_ROOT_USER
        value: minioadmin
      - name: MINIO_ROOT_PASSWORD
        value: minioadmin
```

The `command` field overrides the image's default CMD. MinIO's image ships with `minio` as the default command, but it needs `server /data` to actually start the object storage server. Other images that need a subcommand to start — like `vault server -dev` or `consul agent -dev` — work the same way.

Your services connect using any S3 SDK with endpoint `http://minio:9000`. You can create buckets and upload files in test steps using MinIO's HTTP API, then verify your service handles the uploaded content correctly.

## Message brokers: the BROKER item type

For message brokers like RabbitMQ, Dokkimi has a dedicated BROKER item type. Like DATABASE items get a DB proxy sidecar for query interception, BROKER items get a **broker-proxy sidecar** that transparently intercepts all published and delivered messages — without modifying wire traffic.

```yaml
items:
  - type: BROKER
    name: rabbitmq
    broker: amqp
```

Your services connect to `rabbitmq:5672` using any AMQP client library, and every message published or delivered flows through the proxy. Captured messages are available as `$.messageLogs` in your test assertions — you can verify the exchange, routing key, and message body.

You _could_ run RabbitMQ as a SERVICE item instead, but you'd lose message interception. Use BROKER when you want to assert on what your services are publishing and consuming, not just that they connected.

See the [Brokers documentation](/docs/brokers) for the full field reference and assertion examples.

## DATABASE vs SERVICE vs BROKER: when to use which

Use DATABASE when you want:

- **Query interception and logging** — every SQL query, MongoDB operation, or Redis command is captured by the DB proxy sidecar and visible in `dokkimi inspect`
- **Init script support** — automatic execution of `.sql` or `.js` seed files before tests run
- **Native connection semantics** — Dokkimi configures the correct ports, users, and passwords automatically

Use BROKER when you want:

- **Message interception and logging** — every published and delivered message is captured by the broker-proxy sidecar
- **Protocol-aware assertions** — assert on exchange, routing key, message body, and operation type via `$.messageLogs`
- **Native broker semantics** — Dokkimi configures the correct ports and proxy automatically

Use SERVICE when you want:

- **Any Docker image** — Elasticsearch, MinIO, Meilisearch, or any custom container
- **HTTP traffic interception** — all HTTP calls to and from the service are captured (same as application services)
- **Full control** — you configure the image, ports, environment, and health check yourself

All three types get full DNS routing, network isolation, and automatic teardown. DATABASE items get a DB proxy sidecar for wire-protocol query logging, BROKER items get a broker-proxy sidecar for message interception, and SERVICE items get the interceptor sidecar for HTTP traffic logging.

## The broader point

When people ask "does Dokkimi support Elasticsearch?" or "does Dokkimi support RabbitMQ?" the answer is yes. Databases get query interception, brokers get message interception, and the SERVICE item handles everything else with HTTP traffic logging. If your architecture includes infrastructure beyond Postgres and Redis, it belongs in your test environment, not behind a mock.
