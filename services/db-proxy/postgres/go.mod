module dokkimi.com/db-proxy-postgres

go 1.25

require (
	dokkimi.com/db-proxy-shared v0.0.0
	github.com/lib/pq v1.12.3
)

replace dokkimi.com/db-proxy-shared => ../shared
