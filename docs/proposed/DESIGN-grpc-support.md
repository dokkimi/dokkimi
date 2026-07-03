# Design: gRPC Support

## Problem

The interceptor only supports HTTP/1.1 traffic. Services that communicate over gRPC (which runs on HTTP/2 with binary protobuf payloads) cannot be intercepted, logged, or mocked. gRPC is widely used for internal service-to-service communication, especially in larger microservice architectures.

## Proposal

Extend the interceptor to support gRPC traffic by adding HTTP/2 proxying. Body deserialization is handled on a best-effort basis: if the user provides `.proto` files, bodies are logged as readable JSON; if not, they are logged as raw binary blobs. Either way, method names, status codes, headers, and timing are captured.

---

## How gRPC Works

gRPC is an RPC framework where services call functions on other services using generated client code. A `.proto` file defines the contract (service name, method name, request/response types), and a code generator (`protoc`) produces typed client and server stubs in the target language.

Under the hood, gRPC calls are HTTP/2 requests:

- Method is always `POST`
- Path encodes the service and method: `/package.ServiceName/MethodName`
- Request and response bodies are binary-encoded Protocol Buffers
- Metadata is carried in HTTP/2 headers

The key difference from HTTP/JSON: without the `.proto` schema, protobuf payloads cannot be meaningfully deserialized. Fields are identified by number, not name, so raw decoding produces `field 1: 123, field 2: 0x48656C6C6F` instead of `userId: 123, name: "Hello"`.

---

## Design

### Interceptor Changes

The interceptor currently uses Go's `net/http` server and transport, which default to HTTP/1.1. To support gRPC:

1. **Enable h2c on the listener.** Since all traffic runs on a Docker bridge network, plaintext HTTP/2 (h2c) is the primary case. Wrap the listener with `golang.org/x/net/http2/h2c` so gRPC clients connecting through dnsmasq treat the interceptor as a valid HTTP/2 endpoint. TLS (h2) is only relevant if a user explicitly configures TLS between containers — not a priority.

2. **Enable HTTP/2 on the outbound transport.** Configure the `http.Transport` with `ForceAttemptHTTP2: true` so forwarded connections to the real target use HTTP/2.

3. **Use `httputil.ReverseProxy` with the h2c-capable transport.** Go's standard `ReverseProxy` with an HTTP/2 transport handles stream multiplexing, flow control, and backpressure transparently for both unary and streaming RPCs. No hand-rolled HTTP/2 frame parsing is needed.

4. **Detect gRPC traffic.** Requests with `content-type: application/grpc` (or `application/grpc+proto`) are routed to the gRPC logging/deserialization path. All other HTTP/2 traffic is handled as normal HTTP.

Since the interceptor only captures outbound traffic (via dnsmasq DNS redirect), it must be a fully compliant HTTP/2 endpoint that the service's gRPC client is willing to connect to, then forward calls upstream.

### gRPC Message Framing

gRPC uses a length-prefixed wire format on top of HTTP/2 bodies. Each message in the stream is preceded by a 5-byte header:

```
[1 byte: compressed flag (0 or 1)] [4 bytes: big-endian message length]
```

The interceptor must parse this framing to extract protobuf payloads for logging, even in Phase 1 (opaque logging). Without parsing the 5-byte prefix, the raw body includes framing bytes mixed with payload bytes. The framing parser is also required for:

- Decompressing messages (the compressed flag indicates whether `grpc-encoding` applies to this message)
- Extracting individual messages from streaming RPCs (Phase 3)
- Serving mock responses (must emit properly framed protobuf)

### Trailer Handling

gRPC reports call status via HTTP/2 trailers, not response headers. Key trailers:

- `grpc-status` — the numeric status code (0=OK, 1=CANCELLED, etc.)
- `grpc-message` — human-readable error description
- `grpc-status-details-bin` — binary-encoded error details (base64 in HTTP/2 trailers)

Go's `httputil.ReverseProxy` propagates trailers correctly, but the logging layer must read `grpc-status` from the **response trailers** (via `http.Response.Trailer`), not from response headers. This is where `grpcStatus` for the log entry comes from.

In error-only responses (no body, just trailers), the interceptor still logs a complete entry with the status and any error message — there's simply no body to deserialize.

### Streaming RPCs in Phase 1

Phase 1 only targets unary RPCs for full logging, but streaming RPCs must still proxy correctly. Since `httputil.ReverseProxy` handles HTTP/2 streaming transparently, streaming calls will pass through without interruption — they just won't have per-message logging. The interceptor logs a single entry for the stream with the method, headers, and final gRPC status, but body content is omitted until Phase 3 adds per-message capture.

### Proto File Loading (Optional)

If the user provides `.proto` files, the interceptor loads them at startup and builds a schema registry to deserialize request/response bodies into readable JSON for logging.

Most gRPC client libraries ship `.proto` files alongside the package (NuGet content files, Maven jars, Python packages), so users typically have access to them in their dependency tree.

When proto files are not provided, the interceptor has two fallback options:

1. **gRPC server reflection** — if the target service has reflection enabled (common in dev/staging environments), the interceptor can query the target at runtime to discover message schemas dynamically. No user configuration needed.
2. **Opaque logging** — if neither proto files nor reflection are available (e.g., calling a third-party gRPC service), the interceptor logs binary blobs. The method name, status, headers, and timing are still captured — only body content is opaque.

#### Getting proto files into the sidecar container

The interceptor runs as a Go sidecar image (`ghcr.io/dokkimi/interceptor`). Proto files from the host must be volume-mounted into the container at namespace creation time. Control Tower already mounts host paths for service containers — the same mechanism extends to the interceptor sidecar, mounting the resolved `grpc.protos` path to a known directory (e.g., `/protos/`) inside the container.

#### Message compression

gRPC supports message compression via the `grpc-encoding` header (typically gzip). The interceptor must check this header and decompress message frames before attempting protobuf deserialization. The existing gzip handling for HTTP responses can be reused here.

### Logging

gRPC traffic is logged to the same `POST /logs/http` endpoint. The log entry captures:

| Field                                | Source                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `method`                             | Always `POST`                                                                                        |
| `url`                                | `/package.Service/Method` — the gRPC service and method name                                         |
| `grpcStatus`                         | Native gRPC status code (0=OK, 5=NOT_FOUND, 13=INTERNAL, etc.) — stored directly, not mapped to HTTP |
| `requestHeaders` / `responseHeaders` | HTTP/2 headers including gRPC metadata                                                               |
| `requestBody` / `responseBody`       | Deserialized JSON (if proto files provided) or raw binary                                            |
| `protocol`                           | New field: `grpc` (to distinguish from `http` in the UI)                                             |

gRPC status codes (0–16) are stored natively in `grpcStatus` rather than mapped to HTTP status codes. The mapping is lossy and non-standard — e.g., `FAILED_PRECONDITION` and `UNAVAILABLE` both map to ~500 but mean very different things. The `statusCode` field retains the HTTP/2 status (typically 200 for all gRPC calls, even failures — gRPC reports errors via the `grpc-status` trailer).

### Mock Matching

The existing mock matching system works on method, path, and body contents. For gRPC:

- **Path matching** works as-is — `/package.Service/Method` is a normal URL path
- **Method matching** is trivially `POST` for all gRPC calls
- **Body matching** requires proto files. If provided, the interceptor deserializes the request and matches against field values. If not, body matching is unavailable — mocks can only match on service/method name.

Mock responses for gRPC must be valid protobuf. If proto files are provided, the user defines mock responses as JSON (which the interceptor serializes to protobuf before returning). Without proto files, gRPC mocks are unavailable (consistent with body matching being unavailable without protos).

When serving a gRPC mock response, the interceptor must:

1. Serialize the JSON response to protobuf using the loaded proto schema
2. Wrap the protobuf bytes in the 5-byte gRPC length-prefixed frame (compressed=0 + 4-byte length)
3. Set `content-type: application/grpc` and appropriate gRPC response headers
4. Emit `grpc-status: 0` and `grpc-message` in HTTP/2 **trailers** (not headers) — gRPC clients expect status in trailers and will fail if it's missing

### Definition File Changes

Add an optional `grpc` block to service definitions. The `protos` field describes the proto files for **this service's own API** — i.e., the gRPC interface it exposes to callers:

```yaml
services:
  - name: user-service
    image: user-service:latest
    grpc:
      protos: ./protos/user/ # proto files for user-service's API

  - name: order-service
    image: order-service:latest
    grpc:
      protos:
        - ./protos/order.proto
```

The `protos` field is optional — omitting it gives opaque binary logging for calls targeting that service.

**Proto resolution at proxy time:** Since interceptors are outbound-only (they sit on the calling service), when service A calls service B over gRPC, service A's interceptor needs service B's proto files to deserialize the traffic. The interceptor resolves this by looking up the target service's `grpc.protos` config at proxy time. This way the user declares proto files once on the service that owns the API, and every caller's interceptor can use them automatically.

Today, the interceptor only receives its own service's config (mocks + URL map) via a JSON config file at startup — it has no visibility into other services' definitions. Phase 2 would need to extend this: Control Tower would include a proto-file map (keyed by target service name) in the config file it writes for each interceptor, and volume-mount all referenced proto directories into the sidecar container.

When `grpc` is present on any service in the namespace, all interceptors in the namespace enable HTTP/2 proxying.

### Streaming RPCs

gRPC supports four RPC types: unary, server streaming, client streaming, and bidirectional streaming. The interceptor should handle all four, but logging differs:

- **Unary** — one request, one response. Logged as a single entry (same as HTTP today).
- **Server streaming** — one request, multiple response messages. Log the request once and each response message as it arrives.
- **Client streaming** — multiple request messages, one response. Log each request message and the final response.
- **Bidirectional streaming** — multiple messages in both directions. Log each message individually with a shared stream/correlation ID.

Streaming support can be deferred to a follow-up. Unary RPCs cover the majority of use cases.

---

## Implementation Phases

### Phase 1: HTTP/2 Proxy + Opaque Logging

- Enable h2c in the interceptor's listener and outbound transport
- Forward gRPC calls (unary only) through the existing proxy path via `httputil.ReverseProxy`
- Log method name, path, headers, gRPC status, timing with binary blob bodies
- Add `protocol: grpc` and `grpcStatus` fields to log entries

This gives basic gRPC visibility with no user configuration required.

### Phase 2: Proto File Deserialization

- Add `grpc` block to service definitions with `protos` field
- Volume-mount proto files into interceptor sidecars at namespace creation
- Resolve target service's proto config at proxy time for deserialization
- Deserialize request/response bodies to JSON for logging
- Handle `grpc-encoding: gzip` decompression before deserialization
- Try gRPC server reflection as fallback when proto files aren't available
- Enable body-based mock matching for gRPC

This gives full traffic visibility when proto files are available or when the target supports reflection.

### Phase 3: Streaming RPCs

- Handle server streaming, client streaming, and bidirectional streaming
- Correlation IDs to group messages within a stream
- UI support for viewing streamed message sequences

---

## Resolved Questions

1. **gRPC-Web** — gRPC-Web uses HTTP/1.1 with `content-type: application/grpc-web`, so the existing HTTP interceptor already proxies it. The only addition needed is content-type detection to trigger protobuf deserialization when proto files are available.
2. **Proto file paths** — require explicit paths, no auto-discovery. Scanning `node_modules/`, `vendor/`, etc. is fragile across languages and package managers. Users already know where their protos are.
3. **Mock response format** — JSON. The interceptor serializes to protobuf using the loaded proto schema. Nobody wants to hand-craft base64 protobuf. Without proto files, gRPC mocks are unavailable (consistent with body matching being unavailable).
