module github.com/dokkimi/dokkimi/services/db-proxy/postgres

go 1.25

require (
	github.com/dokkimi/dokkimi/services/db-proxy/shared v0.0.0
	github.com/lib/pq v1.12.3
)

replace github.com/dokkimi/dokkimi/services/db-proxy/shared => ../shared
