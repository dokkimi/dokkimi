module github.com/dokkimi/dokkimi/services/db-proxy/redis

go 1.25

require (
	github.com/dokkimi/dokkimi/services/db-proxy/shared v0.0.0
	github.com/redis/go-redis/v9 v9.19.0
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	go.uber.org/atomic v1.11.0 // indirect
)

replace github.com/dokkimi/dokkimi/services/db-proxy/shared => ../shared
