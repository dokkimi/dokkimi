---
title: 'Testing services that call LLMs'
description: 'How to test AI agent architectures, prompt routing, tool calls, and error handling — using body-aware mocks to return different responses from the same LLM endpoint.'
date: '2026-05-10'
slug: 'testing-llm-integrations'
---

## The app we're testing

You're building a customer support agent. When a user submits a ticket, an orchestrator service makes several LLM calls to classify the issue, extract relevant entities, and draft a response. The architecture:

- **api-gateway** — receives tickets from the frontend, routes to backend services
- **agent-service** — the orchestrator: calls the LLM multiple times per ticket, each with a different prompt
- **ticket-service** — persists tickets and their metadata (classification, entities, draft responses)
- **postgres-db** — stores tickets, classifications, and audit logs

The data model:

```sql
CREATE TABLE tickets (
  id SERIAL PRIMARY KEY,
  customer_email VARCHAR(200) NOT NULL,
  subject VARCHAR(300) NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'open',
  classification VARCHAR(50),
  entities JSONB,
  draft_response TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER REFERENCES tickets(id),
  action VARCHAR(50) NOT NULL,
  details JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

When a ticket arrives, the agent service runs a pipeline: classify the ticket (billing? technical? account?), extract entities (customer name, order number, product), and draft a response using the classification and entities as context. Each step is a separate LLM call — all to the same `POST /v1/chat/completions` endpoint, but with different prompts.

The challenge: every LLM call hits the same URL. Without body matching, one mock returns one response for all calls, and your agent gets the same answer regardless of the prompt.

## Why LLMs are hard to test

LLM integrations have a unique testing problem that other external APIs don't:

1. **Single endpoint, many behaviors.** Stripe has `/v1/charges` for charges and `/v1/customers` for customers — different URLs, easy to mock separately. OpenAI has one URL for everything. The prompt in the request body determines what you get back.
2. **Non-deterministic responses.** Even with temperature=0, LLM responses can vary slightly between calls. Mocking removes this variability entirely, giving you deterministic tests.
3. **Expensive and slow.** Each LLM call costs money and adds latency. A test suite that makes real LLM calls is slow, expensive, and breaks when the provider has an outage.
4. **Multi-step chains.** Agent architectures make several sequential LLM calls where each step depends on the previous one's output. If any mock returns the wrong response, the whole chain breaks in confusing ways.

## Seeding the database

Start with a ticket that's ready for the agent pipeline:

```sql
-- .dokkimi/support-agent/init/seed.sql

INSERT INTO tickets (id, customer_email, subject, body, status) VALUES
  (1, 'jane@example.com', 'Overcharged on last invoice',
   'Hi, I was charged $149 instead of $99 for my Pro plan. My account number is ACC-7890. Please fix this.',
   'open');

SELECT setval('tickets_id_seq', 10);
SELECT setval('audit_log_id_seq', 10);
```

The ticket body mentions billing, includes an account number, and has a clear ask — all things the agent pipeline should detect and act on.

## Building the mock LLM

This is where body matching comes in. You need three mocks, all on the same endpoint, each matching a different prompt pattern:

```yaml
# .dokkimi/shared/mock-llm-classify.yaml
type: MOCK
name: mock-llm-classify
mockMethod: POST
mockTarget: api.openai.com
mockPath: /v1/chat/completions
mockRequestBodyContains: 'classify this ticket'
mockResponseStatus: 200
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  id: chatcmpl-classify-001
  object: chat.completion
  model: gpt-4o
  choices:
    - index: 0
      message:
        role: assistant
        content: 'billing'
      finish_reason: stop
  usage:
    prompt_tokens: 0
    completion_tokens: 0
    total_tokens: 0
```

```yaml
# .dokkimi/shared/mock-llm-extract.yaml
type: MOCK
name: mock-llm-extract
mockMethod: POST
mockTarget: api.openai.com
mockPath: /v1/chat/completions
mockRequestBodyContains: 'extract entities'
mockResponseStatus: 200
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  id: chatcmpl-extract-002
  object: chat.completion
  model: gpt-4o
  choices:
    - index: 0
      message:
        role: assistant
        content: '{"customer_name": "Jane", "account_number": "ACC-7890", "product": "Pro plan", "amount_charged": 149, "expected_amount": 99}'
      finish_reason: stop
  usage:
    prompt_tokens: 0
    completion_tokens: 0
    total_tokens: 0
```

```yaml
# .dokkimi/shared/mock-llm-draft.yaml
type: MOCK
name: mock-llm-draft
mockMethod: POST
mockTarget: api.openai.com
mockPath: /v1/chat/completions
mockRequestBodyContains: 'draft a response'
mockResponseStatus: 200
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  id: chatcmpl-draft-003
  object: chat.completion
  model: gpt-4o
  choices:
    - index: 0
      message:
        role: assistant
        content: "Hi Jane, I've reviewed your account ACC-7890 and confirmed the overcharge. I'm issuing a refund of $50 to bring your invoice back to the correct $99 Pro plan rate. You should see the credit within 3-5 business days."
      finish_reason: stop
  usage:
    prompt_tokens: 0
    completion_tokens: 0
    total_tokens: 0
```

Each mock matches a substring in the request body: the classify prompt contains "classify this ticket", the extraction prompt contains "extract entities", and the drafting prompt contains "draft a response". Dokkimi's specificity scoring means a mock with a body match always outranks one without — so you can add a fallback mock with no body match to catch unexpected prompts.

`mockRequestBodyContains` is case-insensitive, so it matches regardless of how your prompt templates capitalize things.

## Testing the agent pipeline

Now test the full flow — a ticket arrives, the agent classifies it, extracts entities, drafts a response, and persists everything:

```yaml
name: agent-pipeline-billing-ticket
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/agent-service.yaml
  - $ref: ../shared/ticket-service.yaml
  - $ref: ../shared/postgres-db.yaml
  - $ref: ../shared/mock-llm-classify.yaml
  - $ref: ../shared/mock-llm-extract.yaml
  - $ref: ../shared/mock-llm-draft.yaml

tests:
  - name: Billing ticket triggers full agent pipeline
    steps:
      # Trigger the agent pipeline for ticket 1
      - action:
          type: httpRequest
          method: POST
          url: api-gateway/v1/tickets/1/process
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 200
              - path: response.body.classification
                operator: eq
                value: billing
              - path: response.body.draftResponse
                operator: contains
                value: refund

          # Verify the classify call was made with the right prompt
          - match:
              origin: agent-service
              method: POST
              url: api.openai.com/v1/chat/completions
            assertionScope: first
            assertions:
              - path: request.body.model
                operator: eq
                value: gpt-4o
              - path: request.body.messages[0].content
                operator: contains
                value: classify this ticket

          # Verify all three LLM calls happened
          - match:
              origin: agent-service
              method: POST
              url: api.openai.com/v1/chat/completions
            count:
              operator: eq
              value: 3

      # Verify the ticket was updated in the database
      - action:
          type: dbQuery
          database: postgres-db
          query: 'SELECT classification, entities, draft_response, status FROM tickets WHERE id = 1'
        assertions:
          - assertions:
              - path: data[0].classification
                operator: eq
                value: billing
              - path: data[0].draft_response
                operator: contains
                value: refund
              - path: data[0].status
                operator: eq
                value: processed

      # Verify the audit log captured each step
      - action:
          type: dbQuery
          database: postgres-db
          query: 'SELECT action FROM audit_log WHERE ticket_id = 1 ORDER BY created_at'
        assertions:
          - assertions:
              - path: data.length
                operator: gte
                value: 3
              - path: data[0].action
                operator: eq
                value: classified
              - path: data[1].action
                operator: eq
                value: entities_extracted
              - path: data[2].action
                operator: eq
                value: response_drafted
```

The `assertionScope: first` on the classify assertion is important — there are three LLM calls to the same URL, and you only want to assert on the first one's prompt. The `count` assertion on the third block verifies all three calls happened.

## Testing tool calls

If your agent uses OpenAI's function calling, you can use regex matching to route mocks based on the tool name. Say the agent calls a `search_knowledge_base` tool to find relevant help articles:

```yaml
# .dokkimi/shared/mock-llm-tool-call.yaml
type: MOCK
name: mock-llm-tool-call
mockMethod: POST
mockTarget: api.openai.com
mockPath: /v1/chat/completions
mockRequestBodyMatches: '"name":\s*"search_knowledge_base"'
mockResponseStatus: 200
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  id: chatcmpl-tool-004
  object: chat.completion
  model: gpt-4o
  choices:
    - index: 0
      message:
        role: assistant
        content: null
        tool_calls:
          - id: call_mock_1
            type: function
            function:
              name: search_knowledge_base
              arguments: '{"query": "billing overcharge refund process", "max_results": 3}'
      finish_reason: tool_calls
  usage:
    prompt_tokens: 0
    completion_tokens: 0
    total_tokens: 0
```

`mockRequestBodyMatches` uses a regex, so `"name":\s*"search_knowledge_base"` matches regardless of whitespace formatting in the serialized JSON. This is more precise than substring matching when you need to distinguish between tool names that share common words.

Test that the agent correctly handles the tool call response:

```yaml
name: agent-uses-knowledge-base
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/agent-service.yaml
  - $ref: ../shared/ticket-service.yaml
  - $ref: ../shared/postgres-db.yaml
  - $ref: ../shared/mock-llm-classify.yaml
  - $ref: ../shared/mock-llm-tool-call.yaml
  - $ref: ../shared/mock-llm-draft.yaml

tests:
  - name: Agent invokes knowledge base tool
    steps:
      - action:
          type: httpRequest
          method: POST
          url: api-gateway/v1/tickets/1/process
        assertions:
          # The tool call was made
          - match:
              origin: agent-service
              method: POST
              url: api.openai.com/v1/chat/completions
            assertionScope: any
            assertions:
              - path: response.body.choices[0].finish_reason
                operator: eq
                value: tool_calls
              - path: response.body.choices[0].message.tool_calls[0].function.name
                operator: eq
                value: search_knowledge_base
```

## Testing error handling

LLM APIs fail in ways that other APIs don't. Rate limits are common, context windows overflow, and content filters reject prompts unexpectedly. Each of these needs a test.

### Rate limiting

```yaml
# .dokkimi/shared/mock-llm-rate-limited.yaml
type: MOCK
name: mock-llm-rate-limited
mockMethod: POST
mockTarget: api.openai.com
mockPath: /v1/chat/completions
mockResponseStatus: 429
mockResponseHeaders:
  content-type: application/json
  retry-after: '2'
mockResponseBody:
  error:
    message: Rate limit reached for gpt-4o
    type: rate_limit_error
    code: rate_limit_exceeded
```

```yaml
name: agent-handles-rate-limit
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/agent-service.yaml
  - $ref: ../shared/ticket-service.yaml
  - $ref: ../shared/postgres-db.yaml
  - $ref: ../shared/mock-llm-rate-limited.yaml

tests:
  - name: Rate limit returns graceful error
    steps:
      - action:
          type: httpRequest
          method: POST
          url: api-gateway/v1/tickets/1/process
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 503
              - path: response.body.error
                operator: contains
                value: temporarily unavailable

      # Ticket status should not have changed
      - action:
          type: dbQuery
          database: postgres-db
          query: 'SELECT status FROM tickets WHERE id = 1'
        assertions:
          - assertions:
              - path: data[0].status
                operator: eq
                value: open
```

### Content filter rejection

```yaml
# .dokkimi/shared/mock-llm-content-filter.yaml
type: MOCK
name: mock-llm-content-filter
mockMethod: POST
mockTarget: api.openai.com
mockPath: /v1/chat/completions
mockResponseStatus: 400
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  error:
    message: Your request was rejected as a result of our safety system.
    type: invalid_request_error
    code: content_policy_violation
```

Test that your service flags the ticket for human review instead of crashing:

```yaml
name: agent-handles-content-filter
items:
  - $ref: ../shared/api-gateway.yaml
  - $ref: ../shared/agent-service.yaml
  - $ref: ../shared/ticket-service.yaml
  - $ref: ../shared/postgres-db.yaml
  - $ref: ../shared/mock-llm-content-filter.yaml

tests:
  - name: Content filter flags ticket for review
    steps:
      - action:
          type: httpRequest
          method: POST
          url: api-gateway/v1/tickets/1/process
        assertions:
          - assertions:
              - path: response.status
                operator: eq
                value: 200
              - path: response.body.status
                operator: eq
                value: needs_review

      - action:
          type: dbQuery
          database: postgres-db
          query: 'SELECT status FROM tickets WHERE id = 1'
        assertions:
          - assertions:
              - path: data[0].status
                operator: eq
                value: needs_review

      - action:
          type: dbQuery
          database: postgres-db
          query: "SELECT action, details FROM audit_log WHERE ticket_id = 1 AND action = 'content_filter'"
        assertions:
          - assertions:
              - path: data.length
                operator: eq
                value: 1
```

### Slow responses

```yaml
# .dokkimi/shared/mock-llm-slow.yaml
type: MOCK
name: mock-llm-slow
mockMethod: POST
mockTarget: api.openai.com
mockPath: /v1/chat/completions
mockDelayMs: 15000
mockResponseStatus: 200
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  id: chatcmpl-slow
  object: chat.completion
  model: gpt-4o
  choices:
    - index: 0
      message:
        role: assistant
        content: 'billing'
      finish_reason: stop
  usage:
    prompt_tokens: 0
    completion_tokens: 0
    total_tokens: 0
```

If your agent service has a 10-second timeout on LLM calls, this mock triggers it. Assert that the service returns a timeout error and doesn't leave the ticket in a half-processed state.

## Using a fallback mock

When you have body-matching mocks for known prompts, add a fallback to catch anything unexpected:

```yaml
# .dokkimi/shared/mock-llm-fallback.yaml
type: MOCK
name: mock-llm-fallback
mockMethod: POST
mockTarget: api.openai.com
mockPath: /v1/chat/completions
mockResponseStatus: 200
mockResponseHeaders:
  content-type: application/json
mockResponseBody:
  id: chatcmpl-fallback
  object: chat.completion
  model: gpt-4o
  choices:
    - index: 0
      message:
        role: assistant
        content: 'I am unable to process this request.'
      finish_reason: stop
  usage:
    prompt_tokens: 0
    completion_tokens: 0
    total_tokens: 0
```

This mock has no `mockRequestBodyContains`, so it has lower specificity than any body-matching mock. It only fires when no other mock matches. This is useful in two ways: it prevents your test from hanging when the agent sends an unexpected prompt, and you can assert that the fallback was never hit (meaning every LLM call matched an expected prompt):

```yaml
# Inside a step's assertions
- match:
    origin: agent-service
    method: POST
    url: api.openai.com/v1/chat/completions
  assertionScope: any
  assertions:
    - path: response.body.id
      operator: ne
      value: chatcmpl-fallback
```

## Testing multiple LLM providers

If your agent calls different providers — say OpenAI for classification and Anthropic for drafting — each gets its own set of mocks:

```yaml
items:
  # OpenAI for classification
  - type: MOCK
    name: mock-openai-classify
    mockTarget: api.openai.com
    mockPath: /v1/chat/completions
    mockRequestBodyContains: 'classify'
    mockResponseStatus: 200
    mockResponseBody:
      choices:
        - message:
            content: billing

  # Anthropic for drafting
  - type: MOCK
    name: mock-anthropic-draft
    mockTarget: api.anthropic.com
    mockPath: /v1/messages
    mockRequestBodyContains: 'draft a response'
    mockResponseStatus: 200
    mockResponseBody:
      content:
        - type: text
          text: "Hi Jane, I've confirmed the overcharge and initiated a refund."
```

Each mock targets a different hostname, so there's no conflict. Body matching works independently per target.

## Tips for LLM testing

- **Match on the unique part of your prompt template.** If your classify prompt starts with "You are a ticket classifier. classify this ticket:", match on "classify this ticket" — it's the stable, distinctive substring. Don't match on boilerplate like "You are a helpful assistant."
- **Use `mockRequestBodyContains` for most cases.** Substring matching is simpler and handles JSON formatting variations. Reserve `mockRequestBodyMatches` (regex) for cases where you need to match structural patterns like tool call names.
- **Mock realistic response shapes.** Copy a real response from the LLM provider's docs. Include `usage`, `finish_reason`, and `id` fields — your code might check any of them.
- **Test the pipeline in order.** Use `assertionScope: first`, `last`, or `any` to target specific LLM calls when multiple calls hit the same endpoint.
- **Always add a fallback mock.** A body-matching mock with no match only fires when nothing else matches. Use it to catch regressions where a prompt template changes and stops matching its mock.
- **Test error scenarios individually.** Rate limits, content filters, timeouts, and malformed responses each deserve their own test definition with a dedicated error mock.
- **Verify side effects in the database.** Don't just check the HTTP response — confirm that classifications, entities, and draft responses were persisted correctly, and that failed pipelines don't leave tickets in a bad state.
