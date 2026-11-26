module github.com/dokkimi/dokkimi/services/db-proxy/postgres

go 1.25.0

require (
	github.com/dokkimi/dokkimi/services/db-proxy/shared v0.0.0
	github.com/jackc/pgx/v5 v5.13.0
	github.com/lib/pq v1.12.3
)

replace github.com/dokkimi/dokkimi/services/db-proxy/shared => ../shared
